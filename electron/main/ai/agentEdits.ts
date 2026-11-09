import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { homedir } from 'node:os'
import { z } from 'zod'
import { fileDiff, type ChangePreview } from '../../../shared/agent'
import { ChatError } from './AIProvider'
import { sensitiveContent, type WorkspaceService } from './workspaceService'
import { log } from '../logger'

export const versionOf = (text: string | null) => text === null ? null : createHash('sha256').update(text).digest('hex')
export interface EditProposal { path: string; expected: string | null; content: string | null }
const recordSchema = z.object({ id: z.string().uuid(), session: z.string().uuid(), workspace: z.string().uuid(), path: z.string(), kind: z.enum(['file', 'directory', 'tree']).default('file'), before: z.string().nullable(), after: z.string().nullable(), mode: z.number(), destination: z.string().optional(), status: z.enum(['proposed', 'applied', 'reverted', 'conflict']) })
type Record = z.infer<typeof recordSchema>
export interface PreparedEdit { record: Record; target: { root: string; absolute: string }; preview: ChangePreview }

export class AgentEdits {
  private directory: string
  constructor(private workspaces: WorkspaceService, storage: string) { this.directory = join(storage, 'agent-recovery') }
  private verify(target: { root: string; absolute: string }): void {
    if (realpathSync(target.root) !== target.root) throw new ChatError('Project root changed.')
    let current = target.root
    for (const part of relative(target.root, target.absolute).split('/')) {
      if (!part || part === '..' || part === '.') throw new ChatError('Invalid project path.')
      current = resolve(current, part)
      if (!existsSync(current)) { if (current !== target.absolute) throw new ChatError('Parent directory changed.'); continue }
      const stat = lstatSync(current)
      if (stat.isSymbolicLink() || realpathSync(current) !== current) throw new ChatError('Symbolic links are not writable.')
    }
  }
  private snapshot(target: { root: string; absolute: string }): { text: string | null; mode: number } {
    this.verify(target)
    let fd: number
    try { fd = openSync(target.absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { text: null, mode: 0o644 }; throw error }
    try {
      const info = fstatSync(fd)
      if (!info.isFile() || info.nlink !== 1 || info.size > 2 * 1024 * 1024) throw new ChatError('Edits support regular, non-hardlinked UTF-8 files up to 2 MiB. Directories must be handled explicitly.')
      const bytes = readFileSync(fd)
      if (bytes.length > 2 * 1024 * 1024 || bytes.includes(0)) throw new ChatError('Binary or oversized files cannot be edited.')
      const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
      if (sensitiveContent(text) && !(this.workspaces.filesystemMode() !== 'project-only' && this.workspaces.developerConfigurationPath(target.absolute))) throw new ChatError('Possible credentials detected. This file is protected.')
      this.verify(target)
      if (lstatSync(target.absolute).ino !== info.ino) throw new ChatError('File changed during inspection.')
      return { text, mode: info.mode & 0o777 }
    } finally { closeSync(fd) }
  }
  private save(record: Record): void {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    const path = join(this.directory, `${record.id}.json`), temporary = `${path}.tmp`
    writeFileSync(temporary, JSON.stringify(record), { mode: 0o600 }); renameSync(temporary, path)
  }
  async prepare(session: string, workspace: string, edits: EditProposal[]): Promise<PreparedEdit[]> {
    if (!edits.length || edits.length > 20 || new Set(edits.map((edit) => edit.path)).size !== edits.length) throw new ChatError('Provide 1–20 unique file changes.')
    const prepared: PreparedEdit[] = []
    for (const edit of edits) {
      const target = await this.workspaces.editTarget(workspace, edit.path)
      if (edit.content !== null && (Buffer.byteLength(edit.content) > 2 * 1024 * 1024 || (sensitiveContent(edit.content) && !(this.workspaces.filesystemMode() !== 'project-only' && this.workspaces.developerConfigurationPath(target.absolute))) || edit.content.includes('\0'))) throw new ChatError('Proposed contents exceed the file limit or contain possible credentials.')
      const current = this.snapshot(target)
      if (versionOf(current.text) !== edit.expected) throw new ChatError(`File version changed: ${edit.path}. Read it again before editing.`)
      if (current.text === edit.content) continue
      const record: Record = { id: randomUUID(), session, workspace, path: edit.path, kind: 'file', before: current.text, after: edit.content, mode: current.mode, status: 'proposed' }
      prepared.push({ record, target, preview: { id: record.id, path: edit.path, diff: fileDiff(edit.path, current.text, edit.content), status: 'proposed' } })
    }
    return prepared
  }
  async contents(workspace: string, path: string, expected: string): Promise<string> {
    const current = this.snapshot(await this.workspaces.editTarget(workspace, path))
    if (current.text === null || versionOf(current.text) !== expected) throw new ChatError('File changed; read_file again and use its version.')
    return current.text
  }
  private directoryContents(target: PreparedEdit['target']): string | null {
    this.verify(target)
    if (!existsSync(target.absolute)) return null
    if (!lstatSync(target.absolute).isDirectory() || readdirSync(target.absolute).length) throw new ChatError('Only empty directory operations are allowed. Existing contents are protected.')
    return '[empty directory]'
  }
  async prepareDirectory(session: string, workspace: string, path: string, remove: boolean): Promise<PreparedEdit[]> {
    const target = await this.workspaces.editTarget(workspace, path, true), before = this.directoryContents(target)
    if (remove ? before === null : before !== null) throw new ChatError('Directory is missing or already exists; refresh project structure.')
    const record: Record = { id: randomUUID(), session, workspace, path, kind: 'directory', before, after: remove ? null : '[empty directory]', mode: 0o755, status: 'proposed' }
    return [{ record, target, preview: { id: record.id, path, diff: fileDiff(path, record.before, record.after), status: 'proposed' } }]
  }
  private treeSnapshot(target: PreparedEdit['target'], expectedPaths?: Set<string>): string {
    this.verify(target)
    const entries: Array<{ path: string; directory: boolean; version: string | null; mode: number }> = []
    let bytes = 0
    const visit = (absolute: string, path: string) => {
      if (expectedPaths && !expectedPaths.has(path)) throw new ChatError('Directory entries changed since preview. Refresh before retrying.')
      const item = { root: target.root, absolute }; this.verify(item)
      const stat = lstatSync(absolute)
      if (entries.length >= 2000) throw new ChatError('Directory operation exceeds 2,000 entries. Split it into smaller reviewed operations.')
      if (stat.isDirectory()) {
        entries.push({ path, directory: true, version: null, mode: stat.mode & 0o777 })
        for (const name of readdirSync(absolute).sort()) visit(join(absolute, name), path ? `${path}/${name}` : name)
      } else {
        bytes += stat.size
        if (bytes > 8 * 1024 * 1024) throw new ChatError('Directory operation exceeds 8 MiB. Split it into smaller reviewed operations.')
        const snapshot = this.snapshot(item)
        entries.push({ path, directory: false, version: versionOf(snapshot.text), mode: snapshot.mode })
      }
    }
    if (!lstatSync(target.absolute).isDirectory()) throw new ChatError('Choose an ordinary directory.')
    visit(target.absolute, '')
    return JSON.stringify(entries)
  }
  private async authorizeTree(workspace: string, path: string, snapshot: string): Promise<void> {
    for (const entry of JSON.parse(snapshot) as Array<{ path: string; directory: boolean }>) {
      await this.workspaces.editTarget(workspace, entry.path ? `${path}/${entry.path}` : path, entry.directory)
    }
  }
  async prepareTree(session: string, workspace: string, path: string, destination?: string): Promise<PreparedEdit[]> {
    const target = await this.workspaces.editTarget(workspace, path, true)
    const paths = new Set<string>()
    const authorize = async (absolute: string, subpath: string): Promise<void> => {
      this.verify({ root: target.root, absolute })
      const stat = lstatSync(absolute)
      if (paths.size >= 2000) throw new ChatError('Directory operation exceeds 2,000 entries.')
      await this.workspaces.editTarget(workspace, subpath ? `${path}/${subpath}` : path, stat.isDirectory())
      paths.add(subpath)
      if (stat.isDirectory()) for (const name of readdirSync(absolute).sort()) await authorize(join(absolute, name), subpath ? `${subpath}/${name}` : name)
    }
    await authorize(target.absolute, '')
    const before = this.treeSnapshot(target, paths)
    if (destination) {
      const next = await this.workspaces.editTarget(workspace, destination, true)
      this.verify(next)
      if (existsSync(next.absolute) || next.absolute.startsWith(target.absolute + '/')) throw new ChatError('Destination must be absent and outside the source directory.')
    }
    const record: Record = { id: randomUUID(), session, workspace, path, kind: 'tree', before, after: destination ? before : null, destination, mode: 0o755, status: 'proposed' }
    const listing = (JSON.parse(before) as Array<{ path: string }>).map(e => `${path}${e.path ? '/' + e.path : ''}`).join('\n')
    return [{ record, target, preview: { id: record.id, path, diff: `${destination ? `Move directory ${path} → ${destination}` : `Delete directory ${path} (recoverable)`}\nEvery listed entry is included; changed trees are rejected.\n${listing}`, status: 'proposed' } }]
  }
  private replaceTree(item: PreparedEdit, reverse: boolean): void {
    const { record, target } = item
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    const archive = { root: realpathSync(this.directory), absolute: join(realpathSync(this.directory), `${record.id}.tree`) }
    const moved = record.destination ? { root: target.root, absolute: resolve(dirname(target.absolute), relative(dirname(record.path), record.destination)) } : archive
    const from = reverse ? moved : target, to = reverse ? target : moved
    const paths = new Set<string>((JSON.parse(record.before!) as Array<{ path: string }>).map(e => e.path))
    this.verify(from); this.verify(to)
    if (existsSync(to.absolute)) throw new ChatError('Directory destination exists. No files were overwritten.')
    if (this.treeSnapshot(from, paths) !== record.before) throw new ChatError('Directory contents changed since preview. Nothing was moved or deleted.')
    // Atomic rename preserves bytes, encodings and modes. A cross-volume move
    // fails without deleting anything; no unsafe recursive-copy fallback.
    renameSync(from.absolute, to.absolute)
    try {
      if (existsSync(from.absolute) || this.treeSnapshot(to, paths) !== record.before) throw new ChatError('Directory result verification failed.')
    } catch (error) { if (!existsSync(from.absolute)) renameSync(to.absolute, from.absolute); throw error }
  }
  private replaceItem(item: PreparedEdit, reverse = false): void {
    const { record, target } = item, before = reverse ? record.after : record.before, after = reverse ? record.before : record.after
    if (record.kind === 'tree') { this.replaceTree(item, reverse); return }
    if (record.kind === 'directory') {
      if (this.directoryContents(target) !== before) throw new ChatError('Directory changed; it was not overwritten.')
      if (after === null) rmdirSync(target.absolute); else mkdirSync(target.absolute, { mode: record.mode })
    } else this.replace(target, versionOf(before), after, record.mode)
  }
  private replace(target: PreparedEdit['target'], expected: string | null, next: string | null, mode: number): void {
    if (versionOf(this.snapshot(target).text) !== expected) throw new ChatError('External modification detected. Nothing was overwritten.')
    if (next === null) { this.verify(target); unlinkSync(target.absolute); return }
    const temporary = join(dirname(target.absolute), `.athena-${randomUUID()}.tmp`)
    const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode)
    try { writeFileSync(fd, next); fsyncSync(fd) } finally { closeSync(fd) }
    try {
      this.verify(target)
      if (versionOf(this.snapshot(target).text) !== expected) throw new ChatError('File changed before applying the edit.')
      renameSync(temporary, target.absolute)
    } finally { if (existsSync(temporary)) unlinkSync(temporary) }
  }
  async apply(prepared: PreparedEdit[], signal: AbortSignal): Promise<ChangePreview[]> {
    // Reauthorize and preflight the complete batch after the approval wait.
    for (const item of prepared) {
      item.target = await this.workspaces.editTarget(item.record.workspace, item.record.path, item.record.kind !== 'file')
      if (item.record.kind === 'tree') {
        await this.authorizeTree(item.record.workspace, item.record.path, item.record.before!)
        if (item.record.destination) await this.workspaces.editTarget(item.record.workspace, item.record.destination, true)
      }
      const current = item.record.kind === 'tree' ? this.treeSnapshot(item.target, new Set((JSON.parse(item.record.before!) as Array<{ path: string }>).map(e => e.path))) : item.record.kind === 'directory' ? this.directoryContents(item.target) : this.snapshot(item.target).text
      if (versionOf(current) !== versionOf(item.record.before)) throw new ChatError(`File changed while awaiting approval: ${item.record.path}.`)
    }
    signal.throwIfAborted()
    // No awaits in the commit section: cancellation cannot split ordinary batches.
    for (const item of prepared) this.save(item.record)
    const applied: PreparedEdit[] = []
    let active: PreparedEdit | undefined
    try {
      for (const item of prepared) {
        active = item
        this.replaceItem(item)
        applied.push(item)
        if (item.record.kind === 'file' && versionOf(this.snapshot(item.target).text) !== versionOf(item.record.after)) throw new ChatError('File result did not match the approved content.')
        if (item.record.kind === 'directory' && this.directoryContents(item.target) !== item.record.after) throw new ChatError('Directory result verification failed.')
        item.record.status = 'applied'; this.save(item.record)
      }
    } catch (error) {
      for (const item of applied.reverse()) {
        try { this.replaceItem(item, true); item.record.status = 'reverted' }
        catch { item.record.status = 'conflict' }
        this.save(item.record)
      }
      const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : undefined
      const target = active?.record.path.replace(homedir(), '~') ?? 'unknown target'
      const detail = error instanceof ChatError ? error.userMessage : error instanceof Error ? error.message.replace(homedir(), '~').slice(0, 240) : 'Unknown filesystem error.'
      log('agent.file_change_failed', { operation: active?.record.after === null ? 'delete' : active?.record.before === null ? 'create' : 'modify', code: code ?? 'unknown' })
      throw new ChatError(`Batch failed while applying ${target}${code ? ` (${code})` : ''}: ${detail}. Recovery records were preserved; inspect current files before retrying.`)
    }
    return prepared.map((item) => ({ ...item.preview, status: 'applied' }))
  }
  history(session: string, workspace: string): Array<Pick<ChangePreview, 'id' | 'path' | 'status'>> {
    if (!this.workspaces.authorized(workspace)) throw new ChatError('Authorize this project before inspecting change history.')
    if (!existsSync(this.directory)) return []
    return readdirSync(this.directory).filter((name) => /^[a-f0-9-]{36}\.json$/.test(name)).slice(-1000).flatMap((name) => {
      try { const record = recordSchema.parse(JSON.parse(readFileSync(join(this.directory, name), 'utf8'))); return record.session === session && record.workspace === workspace ? [{ id: record.id, path: record.path, status: record.status }] : [] } catch { return [] }
    })
  }
  async review(session: string, workspace: string, id: string): Promise<ChangePreview> {
    if (!z.string().uuid().safeParse(id).success) throw new ChatError('Invalid change identifier.')
    const record = recordSchema.parse(JSON.parse(readFileSync(join(this.directory, `${id}.json`), 'utf8')))
    if (record.session !== session || record.workspace !== workspace) throw new ChatError('This change belongs to a different conversation.')
    await this.workspaces.editTarget(workspace, record.path, record.kind !== 'file')
    return { id, path: record.path, diff: fileDiff(record.path, record.before, record.after), status: record.status }
  }
  async revert(session: string, workspace: string, id: string, signal?: AbortSignal): Promise<ChangePreview> {
    if (!z.string().uuid().safeParse(id).success) throw new ChatError('Invalid change identifier.')
    const record = recordSchema.parse(JSON.parse(readFileSync(join(this.directory, `${id}.json`), 'utf8')))
    if (record.session !== session || record.workspace !== workspace || record.status === 'reverted') throw new ChatError('Change does not belong to this conversation or was already reverted.')
    const target = await this.workspaces.editTarget(workspace, record.path, record.kind !== 'file')
    if (record.kind === 'tree' && record.destination) await this.authorizeTree(workspace, record.destination, record.before!)
    signal?.throwIfAborted()
    this.replaceItem({ record, target, preview: { id, path: record.path, diff: '', status: record.status } }, true)
    record.status = 'reverted'; this.save(record)
    return { id, path: record.path, diff: fileDiff(record.path, record.before, record.after), status: 'reverted' }
  }
  async modifyDirectory(workspace: string, path: string, remove: boolean): Promise<void> {
    const target = await this.workspaces.editTarget(workspace, path, true)
    this.verify(target)
    if (remove) rmdirSync(target.absolute) // Only empty directories; never recursive deletion.
    else mkdirSync(target.absolute, { mode: 0o755 })
  }
}
