import { createHash } from 'node:crypto'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileDiff, type ChangePreview } from '../../../shared/agent'
import { sensitivePath } from './workspaceService'

export type ACPFileOperation = 'create' | 'edit' | 'patch' | 'delete' | 'rename' | 'move'

export function acpFileOperation(value: unknown): ACPFileOperation | null {
  const kind = typeof value === 'string' ? value.toLowerCase().replaceAll('-', '_') : ''
  if (/^(?:create|create_file|write|write_file)$/.test(kind)) return 'create'
  if (/^(?:edit|edit_file|modify|update)$/.test(kind)) return 'edit'
  if (/^(?:patch|apply_patch)$/.test(kind)) return 'patch'
  if (/^(?:delete|delete_file|remove)$/.test(kind)) return 'delete'
  if (/^(?:move|move_file)$/.test(kind)) return 'move'
  if (/^(?:rename|rename_file)$/.test(kind)) return 'rename'
  return null
}

type FileState = { exists: boolean; content: string }
type ReportedDiff = { path: string; oldText: string | null; newText: string }
type Capture = { operation: ACPFileOperation; snapshots: Promise<Map<string, FileState | undefined>>; diffs: Map<string, ReportedDiff> }

/** ACP v1 diff content can arrive with permission requests or completion updates. */
function reportedDiffs(payload: unknown): ReportedDiff[] {
  if (!payload || typeof payload !== 'object') return []
  const content = (payload as Record<string, unknown>).content
  if (!Array.isArray(content)) return []
  return content.filter((entry): entry is ReportedDiff => entry?.type === 'diff'
    && typeof entry.path === 'string' && entry.path.length <= 2000
    && (entry.oldText === null || typeof entry.oldText === 'string') && typeof entry.newText === 'string'
    && (entry.oldText?.length ?? 0) <= 2 * 1024 * 1024 && entry.newText.length <= 2 * 1024 * 1024).slice(0, 24)
}

function explicitPaths(value: unknown): string[] {
  const paths = new Set<string>()
  const visit = (entry: unknown, key = '', depth = 0): void => {
    if (depth > 10 || paths.size >= 24) return
    if (Array.isArray(entry)) { for (const item of entry) visit(item, key, depth + 1); return }
    if (!entry || typeof entry !== 'object') {
      if (typeof entry === 'string') {
        if (/^(?:path|file_path|uri|target|destination|source|old_path|new_path)$/i.test(key) && entry.length <= 2000) paths.add(entry.trim())
        // Cursor ACP can report a file edit with only a title such as
        // "Edit `/workspace/src/app.ts`". Treat only a quoted path in a native
        // file-operation title as a candidate; capture() still checks that it
        // resolves to a safe regular file inside the authorized workspace.
        if (key === 'title' && entry.length <= 2400) {
          const match = /^(?:Edit|Create|Write|Patch|Delete|Move|Rename)\s+`([^`\r\n]{1,2000})`(?:\s+(?:to|→)\s+`([^`\r\n]{1,2000})`)?(?:\s|$)/i.exec(entry.trim())
          if (match) { paths.add(match[1]); if (match[2]) paths.add(match[2]) }
        }
      }
      return
    }
    for (const [childKey, child] of Object.entries(entry as Record<string, unknown>)) visit(child, childKey, depth + 1)
  }
  visit(value)
  return [...paths].filter(Boolean)
}

/** Captures only ACP-declared targets around one completed native file operation. */
export class ACPFileChangeTracker {
  private readonly captures = new Map<string, Capture>()
  private readonly completed = new Set<string>()
  private readonly initial = new Map<string, FileState>()
  private readonly netChanged = new Set<string>()
  private finishQueue: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly workspaceRoot: string,
    private readonly conversationId: string,
    private readonly executionId: string,
    private readonly providerId: string,
  ) {}

  async begin(operationId: string, operation: ACPFileOperation, payload: unknown): Promise<void> {
    if (!operationId || operationId.length > 500 || this.completed.has(operationId)) return
    const paths = explicitPaths(payload)
    const previous = this.captures.get(operationId)
    // Pending events may have no paths yet. Merge later metadata without taking
    // a second baseline for a path already observed before authorization.
    const snapshots = previous ? previous.snapshots.then(async before => {
      const root = await realpath(this.workspaceRoot).catch(() => null)
      if (!root) return before
      const added = await this.capture(paths.filter(path => !before.has(this.relativeTarget(path, root) ?? '')))
      return new Map([...before, ...added])
    }) : this.capture(paths)
    const diffs = new Map(previous?.diffs)
    for (const diff of reportedDiffs(payload)) diffs.set(diff.path, diff)
    this.captures.set(operationId, { operation, snapshots, diffs })
    await snapshots
  }

  finish(operationId: string, operation: ACPFileOperation | null, payload: unknown): Promise<ChangePreview[]> {
    const result = this.finishQueue.then(() => this.finishOperation(operationId, operation, payload))
    this.finishQueue = result.catch(() => {})
    return result
  }

  private async finishOperation(operationId: string, operation: ACPFileOperation | null, payload: unknown): Promise<ChangePreview[]> {
    if (!operationId || this.completed.has(operationId)) return []
    const capture = this.captures.get(operationId)
    this.captures.delete(operationId)
    const kind = operation ?? capture?.operation
    if (!kind) return []
    this.completed.add(operationId)
    const before = await capture?.snapshots ?? new Map<string, FileState | undefined>()
    const root = await realpath(this.workspaceRoot).catch(() => null)
    if (!root) return []
    const diffs = new Map<string, ReportedDiff[]>()
    for (const diff of [...(capture?.diffs.values() ?? []), ...reportedDiffs(payload)]) {
      const path = this.relativeTarget(diff.path, root)
      if (path) diffs.set(path, [...(diffs.get(path) ?? []), diff])
    }
    const after = await this.capture([...new Set([...before.keys(), ...diffs.keys()])])
    const changes: ChangePreview[] = []
    for (const [path, current] of after) {
      if (!current) continue
      let operationStart = before.get(path)
      const candidates = diffs.get(path)
      if (candidates?.length) {
        // Some agents send tool events after the write, so both filesystem
        // reads see the new state. Use their explicit before image only when
        // the complete after image matches disk. Snippets and stale diffs
        // must never be treated as whole-file replacements.
        const diff = [...candidates].reverse().find(diff => current.exists ? current.content === diff.newText : kind === 'delete' && diff.newText === '')
        if (diff) operationStart = { exists: diff.oldText !== null, content: diff.oldText ?? '' }
        // A truncated/snippet diff cannot establish a before image. A file
        // snapshot captured when the target was announced still can.
      }
      if (!operationStart) continue
      const previous = this.initial.get(path) ?? operationStart
      this.initial.set(path, previous)
      const changed = previous.exists !== current.exists || previous.content !== current.content
      if (!changed && !this.netChanged.has(path)) continue
      if (changed) this.netChanged.add(path)
      else this.netChanged.delete(path)
      const resolvedOperation: ACPFileOperation = changed
        ? !previous.exists && current.exists ? 'create' : previous.exists && !current.exists ? 'delete' : kind
        : kind
      const identity = createHash('sha256').update(`${resolve(this.workspaceRoot)}\0${path}`).digest('hex')
      const stateHash = (state: FileState) => createHash('sha256').update(state.exists ? state.content : '<missing>').digest('hex')
      changes.push({
        id: `acp-${createHash('sha256').update(`${this.executionId}\0${identity}`).digest('hex').slice(0, 32)}`,
        path, diff: fileDiff(path, previous.exists ? previous.content : null, current.exists ? current.content : null), status: changed ? 'applied' : 'reverted',
        operation: resolvedOperation, operationId, beforeHash: stateHash(previous), afterHash: stateHash(current),
        conversationId: this.conversationId, executionId: this.executionId, providerId: this.providerId,
        fileIdentity: identity, completedAt: Date.now(), verified: true, revertible: false,
      })
    }
    return changes
  }

  private async capture(paths: string[]): Promise<Map<string, FileState | undefined>> {
    const root = await realpath(this.workspaceRoot).catch(() => null)
    const output = new Map<string, FileState | undefined>()
    if (!root) return output
    for (const value of paths.slice(0, 24)) {
      const path = this.relativeTarget(value, root)
      if (!path || output.has(path)) continue
      output.set(path, await this.readTarget(path, root))
    }
    return output
  }

  private relativeTarget(value: string, root: string): string | null {
    let pathname = value.replaceAll('\\', '/')
    if (pathname.startsWith('file:')) {
      try { pathname = decodeURIComponent(new URL(pathname).pathname) } catch { return null }
    }
    const absolute = isAbsolute(pathname) ? resolve(pathname) : resolve(root, pathname)
    let relativePath = relative(root, absolute).replaceAll('\\', '/')
    // macOS commonly exposes the same workspace through /var and /private/var.
    // Accept the configured lexical root alias, then still resolve and verify
    // every existing ancestor in readTarget before reading any file.
    if (relativePath === '..' || relativePath.startsWith('../') || isAbsolute(relativePath)) {
      const lexical = relative(resolve(this.workspaceRoot), absolute).replaceAll('\\', '/')
      if (lexical !== '..' && !lexical.startsWith('../') && !isAbsolute(lexical)) relativePath = lexical
    }
    if (!relativePath || relativePath === '..' || relativePath.startsWith('../') || isAbsolute(relativePath) || sensitivePath(relativePath)) return null
    return relativePath
  }

  private async readTarget(path: string, root: string): Promise<FileState | undefined> {
    const target = resolve(root, path)
    let ancestor = dirname(target), parent: string | null = null
    while (!parent) {
      parent = await realpath(ancestor).catch(() => null)
      if (parent || ancestor === root) break
      const next = dirname(ancestor)
      if (next === ancestor) return undefined
      ancestor = next
    }
    if (!parent) return undefined
    const parentRelative = relative(root, parent)
    if (parentRelative === '..' || parentRelative.startsWith(`..${sep}`) || isAbsolute(parentRelative) || sensitivePath(parentRelative)) return undefined
    let stat
    try { stat = await lstat(target) }
    catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { exists: false, content: '' } : undefined }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) return undefined
    try {
      const bytes = await readFile(target)
      if (bytes.includes(0)) return undefined
      const content = bytes.toString('utf8')
      if (!Buffer.from(content, 'utf8').equals(bytes)) return undefined
      return { exists: true, content }
    } catch { return undefined }
  }
}
