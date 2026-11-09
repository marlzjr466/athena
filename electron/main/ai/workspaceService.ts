import { createHash, randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { constants, type Stats } from 'node:fs'
import { access, lstat, open, readdir, realpath } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, posix, relative, resolve, sep } from 'node:path'
import { homedir } from 'node:os'
import type { FilesystemAccessMode } from '../../../shared/permissions'
import ignore, { type Ignore } from 'ignore'
import type { ProjectFile, SourceReference, WorkspaceReference } from '../../../shared/conversations'
import { ChatError } from './AIProvider'
import { FilesystemAccessError } from './filesystemErrors'
import { globMatcher, matchingLines, type SearchMode } from './projectSearch'
import type { WorkspaceGrant, WorkspaceGrants } from './workspaceGrants'

export const SOURCE_EXTENSIONS = new Set('.txt .md .mdx .js .jsx .ts .tsx .json .html .css .scss .sass .less .py .java .c .cpp .h .hpp .cs .go .rs .rb .php .swift .kt .kts .vue .svelte .xml .yaml .yml .toml .ini .csv .tsv .sql .sh .bash .zsh .r .dart .ex .exs .graphql .gql .mjs .cjs .prisma .proto .ipynb .tf .tex .log .rst'.split(' '))
const excludedDirectories = new Set(['.git', 'node_modules', 'dist', 'out', 'release', 'build', 'coverage', '.next', '.cache', '.venv', 'venv', '__pycache__', '.ssh', '.aws', '.config', '.gnupg', '.azure', '.kube', '.docker', '.idea', 'vendor', 'target', 'keychains'])
const protectedDirectories = new Set(['.git', '.ssh', '.aws', '.config', '.gnupg', '.azure', '.kube', '.docker', 'keychains'])
// Dependency trees stay out of automatic context/indexing, but explicit file
// tools may inspect ordinary installed packages. A directory called "cookies"
// is not itself a browser credential database.
const dependencyPath = (path: string) => path.split(/[\\/]/).includes('node_modules')
const credentialFile = (name: string) => /^cookies?(?:\.binarycookies)?$|^login data$/i.test(name)
// A credential-named *file* can be read only when the user approves that exact
// read. Key material, environment files and protected parent trees are never
// covered by this exception.
export const credentialNamedFile = (path: string): boolean => /credential/i.test(basename(path)) &&
  !/(^\.env(?:\.|$)|secret|private.?key|^id_(rsa|ed25519|ecdsa)|\.(pem|key|p12|pfx|keystore)$)/i.test(basename(path))
const explicitProtectedPath = (path: string) => path.split(/[\\/]/).some((part) =>
  (dependencyPath(path) ? protectedDirectories : excludedDirectories).has(part.toLowerCase()) ||
  /(^\.env(?:\.|$)|credential|secret|private.?key|^id_(rsa|ed25519|ecdsa)|\.(pem|key|p12|pfx|keystore)$|^\.(npmrc|netrc|yarnrc)|^auth\.json$)/i.test(part))
export function sensitivePath(path: string): boolean {
  return path.split(/[\\/]/).some((part) => excludedDirectories.has(part.toLowerCase()) || /(^\.env(?:\.|$)|credential|secret|private.?key|^id_(rsa|ed25519|ecdsa)|\.(pem|key|p12|pfx|keystore)$|^\.(npmrc|netrc|yarnrc)|^auth\.json$|^cookies?(?:\.binarycookies)?$|^login data$)/i.test(part))
}
const protectedMacDirectories = new Set(['.git', '.ssh', '.aws', '.gnupg', '.azure', '.kube', '.docker', 'keychains'])
/** Explicit Full Mac access may include Claude/Codex configuration trees.
 * Match whole directory names only; a similarly named directory is not an exception. */
export function developerConfigurationPath(path: string): boolean {
  if (!isAbsolute(path)) return false
  return resolve(path).split(sep).some((part) => part === '.claude' || part === '.codex')
}
export function protectedMacPath(path: string): boolean {
  if (developerConfigurationPath(path)) return false
  return path.split(/[\\/]/).some((part) => protectedMacDirectories.has(part.toLowerCase()) || /(^\.env(?:\.|$)|credential|secret|private.?key|^id_(rsa|ed25519|ecdsa)|\.(pem|key|p12|pfx|keystore)$|^\.(npmrc|netrc|yarnrc)|^auth\.json$)/i.test(part))
}
function protectedMacRule(path: string): string {
  const parts = path.split(/[\\/]/)
  if (parts.some((part) => /credential|secret|private.?key|^id_(rsa|ed25519|ecdsa)|^auth\.json$/i.test(part))) return 'credential_filename'
  if (parts.some((part) => /^\.env(?:\.|$)/i.test(part))) return 'environment_file'
  return 'protected_mac_path'
}
export function sensitiveContent(text: string): boolean { return /-----BEGIN [A-Z ]*PRIVATE KEY-----|\bsk-[A-Za-z0-9_-]{20,}|\bAKIA[0-9A-Z]{16}\b|(?:api[_-]?key|password|secret|access[_-]?token|refresh[_-]?token|authorization|cookie)\s*["']?\s*[:=]\s*["'][^"'\s]{12,}["']|https?:\/\/[^\s/@:]+:[^\s/@]+@/i.test(text) }
/** Only recognized instruction locations bypass hidden/ignore filtering. No credential exceptions. */
export function projectInstructionPath(path: string): boolean {
  return /(?:^|\/)(?:AGENTS(?:\.override)?\.md|CLAUDE\.md)$/.test(path) ||
    /^(?:\.claude(?:\/(?:commands|skills|agents|rules)(?:\/.*)?)?|\.agents(?:\/skills(?:\/.*)?)?|\.codex(?:\/(?:config\.toml|(?:skills|prompts|agents)(?:\/.*)?))?)$/.test(path)
}
export function supportedSource(path: string): boolean { return SOURCE_EXTENSIONS.has(extname(path).toLowerCase()) || /^(Dockerfile|Makefile|LICENSE|README|\.gitconfig)$/i.test(basename(path)) }
export const FULL_MAC_WORKSPACE_ID = '00000000-0000-4000-8000-000000000001'
interface IndexedFile { path: string; text: string; mtime: number; size: number }
interface Workspace { reference: WorkspaceReference; root: string; device: number; inode: number; birthtimeMs?: number; files: IndexedFile[]; truncated: boolean }
function sameFolder(grant: Pick<WorkspaceGrant, 'device' | 'inode' | 'birthtimeMs'>, info: Stats): boolean {
  return info.isDirectory() && !info.isSymbolicLink() && info.ino === grant.inode &&
    (grant.birthtimeMs === undefined ? info.dev === grant.device : info.birthtimeMs === grant.birthtimeMs)
}
export interface ProjectEntry { path: string; type: 'directory' | 'file'; size: number; modifiedAt: string; extension: string; cursor?: number }
const MAX_FILES = 2000, MAX_FILE_BYTES = 256 * 1024, MAX_INDEX_BYTES = 16 * 1024 * 1024
const MAX_TOOL_FILE_BYTES = 2 * 1024 * 1024
const generatedPath = (path: string) => /lock\.(json|yaml)$|\.lock$|\.min\.(js|css)$|\.map$/.test(path)
// Project-local workflow drafts are ordinary source, not credentials. Permit
// explicit access even when Git ignores them; broad indexing still skips them.
const workflowDraftPath = (path: string) => path === '.tmp' || path.startsWith('.tmp/')
// macOS exposes these OS-owned aliases. Canonicalize only a verified exact
// mapping, not arbitrary user-created symlinks or a similarly named directory.
const systemAlias = (path: string, target: string) => process.platform === 'darwin' &&
  ['/var', '/tmp', '/etc'].includes(path) && target === `/private${path}`
export class WorkspaceService {
  private workspaces = new Map<string, Workspace>()
  private approvedCredentialRead = new AsyncLocalStorage<{ workspaceId: string; absolute: string; mode: FilesystemAccessMode }>()
  constructor(private allowed: () => boolean, private grants?: WorkspaceGrants, private accessMode: () => FilesystemAccessMode = () => 'project-only') {}
  developerConfigurationPath(path: string): boolean { return developerConfigurationPath(path) }
  filesystemMode(): FilesystemAccessMode { return this.allowed() ? this.accessMode() : 'project-only' }
  private approvedCredential(workspace: Workspace, absolute: string): boolean {
    const grant = this.approvedCredentialRead.getStore()
    if (!grant || grant.workspaceId !== workspace.reference.id || grant.absolute !== absolute || grant.mode !== this.filesystemMode() || !credentialNamedFile(absolute)) return false
    if (protectedMacPath(dirname(absolute))) return false
    const parent = relative(workspace.root, dirname(absolute))
    return this.filesystemMode() !== 'project-only' || parent !== '..' && !parent.startsWith(`..${sep}`) && !isAbsolute(parent) && !explicitProtectedPath(parent)
  }
  /** The caller must obtain a fresh, user-visible approval before each call.
   * The exception stays in this async operation, never in global session state. */
  async credentialApprovalTarget(id: string, path: string): Promise<string> {
    const workspace = await this.workspace(id)
    const expanded = path === '~' ? homedir() : path.startsWith('~/') ? resolve(homedir(), path.slice(2)) : path
    if (!credentialNamedFile(expanded) || expanded.includes('\\') || expanded.includes('\0') || expanded.split('/').includes('..')) throw new FilesystemAccessError('Only an explicitly named credential file can use this approval.', 'filesystem_policy_denied', 'credential_approval_scope', path)
    const absolute = isAbsolute(expanded) ? resolve(expanded) : resolve(workspace.root, expanded)
    if (protectedMacPath(dirname(absolute)) || this.filesystemMode() === 'project-only' && (isAbsolute(expanded) || explicitProtectedPath(relative(workspace.root, dirname(absolute))))) throw new FilesystemAccessError('A credential-file approval cannot open protected directories or leave the authorized project.', 'filesystem_policy_denied', 'credential_approval_scope', absolute)
    return absolute
  }
  async withApprovedCredentialRead<T>(id: string, path: string, action: () => Promise<T>): Promise<T> {
    const absolute = await this.credentialApprovalTarget(id, path)
    return this.approvedCredentialRead.run({ workspaceId: id, absolute, mode: this.filesystemMode() }, action)
  }
  private gate(): void { if (!this.allowed()) { this.workspaces.clear(); throw new ChatError('Enable Personal File Access in Settings → Privacy, then select the project again.') } }
  authorized(id: string): boolean { return this.allowed() && (id === FULL_MAC_WORKSPACE_ID ? this.filesystemMode() !== 'project-only' : this.workspaces.has(id)) }
  async authorizedRoot(id: string): Promise<string> { return (await this.workspace(id)).root }
  async restore(references: WorkspaceReference[]): Promise<void> {
    if (!this.allowed()) return
    for (const grant of this.grants?.list() ?? []) {
      const reference = references.find((entry) => entry.id === grant.reference.id && entry.fingerprint === grant.reference.fingerprint)
      if (!reference || reference.fingerprint !== createHash('sha256').update(grant.root).digest('hex')) continue
      try {
        const info = await lstat(grant.root)
        if (!sameFolder(grant, info) || await realpath(grant.root) !== grant.root) continue
        await access(grant.root, constants.R_OK | constants.X_OK)
        if (!this.allowed()) return
        this.workspaces.set(reference.id, { ...grant, reference, files: [], truncated: false })
      } catch { /* Missing, moved or OS-denied folders need explicit reauthorization. */ }
    }
  }
  async connect(path: string, references: WorkspaceReference[] = []): Promise<WorkspaceReference> {
    this.gate()
    const root = await realpath(path)
    const info = await lstat(root)
    if (!info.isDirectory() || root === sep) throw new ChatError('Choose a project folder, not the filesystem root.')
    const connected = [...this.workspaces.values()].find((workspace) => workspace.root === root && sameFolder(workspace, info))
    if (connected) return connected.reference
    const fingerprint = createHash('sha256').update(root).digest('hex')
    const named = references.filter((entry) => entry.name === basename(root) && !entry.fingerprint)
    // Legacy references predate fingerprints. The explicit folder selection is
    // the authority used to migrate matching legacy entries into one project.
    const reference = references.find((entry) => entry.fingerprint === fingerprint) ?? named[0]
    const ref = { id: reference?.id ?? randomUUID(), name: reference?.name ?? basename(root), fingerprint }
    const workspace: Workspace = { reference: ref, root, device: info.dev, inode: info.ino, birthtimeMs: info.birthtimeMs > 0 ? info.birthtimeMs : undefined, files: [], truncated: false }
    this.gate()
    this.grants?.remember({ reference: ref, root, device: info.dev, inode: info.ino, birthtimeMs: workspace.birthtimeMs })
    this.workspaces.set(ref.id, workspace)
    // Authorization does not eagerly read every source file. Tools retrieve on demand.
    return ref
  }
  disconnect(id: string): void { this.workspaces.delete(id); this.grants?.forget(id) }
  rename(id: string, name: string): void { const workspace = this.workspaces.get(id); if (workspace) workspace.reference.name = name }
  revoke(): void { this.workspaces.clear(); this.grants?.clear() }
  private async workspace(id: string): Promise<Workspace> {
    this.gate()
    if (id === FULL_MAC_WORKSPACE_ID) {
      if (this.filesystemMode() === 'project-only') throw new ChatError('Full Mac Access is not authorized in Settings → Permissions.')
      const root = await realpath(homedir()), info = await lstat(root)
      if (!info.isDirectory() || info.isSymbolicLink()) throw new ChatError('The Mac home folder is unavailable.')
      return { reference: { id, name: 'Mac files', fingerprint: '' }, root, device: info.dev, inode: info.ino, files: [], truncated: false }
    }
    const workspace = this.workspaces.get(id)
    if (!workspace) throw new ChatError('Project access is unavailable. Select the same folder once to reauthorize existing sessions and remember access for future launches. Do not delete your sessions.')
    // A transient TCC/ACL or I/O error does not revoke the user's saved grant.
    // Preserve errno so the tool can distinguish denied, missing and I/O errors.
    const info = await lstat(workspace.root)
    if (!sameFolder(workspace, info) || await realpath(workspace.root) !== workspace.root) { this.disconnect(id); throw new ChatError('Project folder changed. Select it again to authorize access.') }
    return workspace
  }
  private async read(workspace: Workspace, path: string, limit = MAX_FILE_BYTES): Promise<string> {
    this.gate()
    const global = this.filesystemMode() !== 'project-only'
    let current: string
    if (this.filesystemMode() === 'project-only' && path.endsWith('.gitignore')) {
      if (isAbsolute(path) || path.includes('\\') || path.split('/').some((part) => !part || part === '.' || part === '..')) throw new ChatError('Invalid project path.')
      current = workspace.root
      for (const part of path.split('/')) { current = resolve(current, part); if ((await lstat(current)).isSymbolicLink()) throw new ChatError('Symbolic links are not read.') }
      const rel = relative(workspace.root, await realpath(current))
      if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new ChatError('File is outside the authorized project.')
    } else current = await this.safePath(workspace, path)
    const file = await open(current, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const info = await file.stat()
      if (!info.isFile() || info.size > limit) throw new ChatError(`Source file exceeds the ${Math.floor(limit / 1024)} KiB read limit or is not a regular file.`)
      const bytes = Buffer.alloc(limit + 1)
      let bytesRead = 0
      while (bytesRead < bytes.length) {
        const part = await file.read(bytes, bytesRead, bytes.length - bytesRead, bytesRead)
        if (!part.bytesRead) break
        bytesRead += part.bytesRead
        this.gate()
        if (global && this.filesystemMode() === 'project-only') throw new ChatError('Full Mac Access was revoked during this read.')
      }
      if (bytesRead > limit || bytes.subarray(0, bytesRead).includes(0)) throw new ChatError('Unsupported source file.')
      const after = await lstat(current)
      if (after.ino !== info.ino || after.dev !== info.dev || after.size !== info.size || after.mtimeMs !== info.mtimeMs || await realpath(current) !== current || !(this.filesystemMode() === 'project-only' && path.endsWith('.gitignore')) && await this.safePath(workspace, path) !== current) throw new ChatError('File changed during access. Retry.')
      this.gate()
      if (global && this.filesystemMode() === 'project-only') throw new ChatError('Full Mac Access was revoked during this read.')
      try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, bytesRead)) }
      catch { throw new ChatError('Source is not valid UTF-8 text.') }
    } finally { await file.close() }
  }
  private check(signal?: AbortSignal): void {
    this.gate()
    if (signal?.aborted) throw new ChatError('Project request cancelled or timed out.')
  }
  private async safePath(workspace: Workspace, path: string, signal?: AbortSignal, allowMissingLeaf = false): Promise<string> {
    this.check(signal)
    if (path === '' || path === '.') return workspace.root
    if (this.filesystemMode() !== 'project-only') {
      const expanded = path === '~' ? homedir() : path.startsWith('~/') ? resolve(homedir(), path.slice(2)) : path
      if (expanded.length > 1000 || expanded.includes('\\') || expanded.includes('\0') || expanded.split('/').includes('..')) throw new FilesystemAccessError('Invalid Mac file path.', 'invalid_path', 'path_syntax', expanded)
      const absolute = isAbsolute(expanded) ? resolve(expanded) : resolve(workspace.root, expanded)
      if (protectedMacPath(absolute) && !this.approvedCredential(workspace, absolute)) throw new FilesystemAccessError('Athena blocks this credential or protected path without explicit access approval. No macOS file access was attempted.', 'filesystem_policy_denied', protectedMacRule(absolute), absolute)
      let current: string = sep
      const parts = absolute.split(sep).filter(Boolean)
      for (let index = 0; index < parts.length; index++) {
        current = resolve(current, parts[index])
        const info = await lstat(current).catch((error) => {
          if (allowMissingLeaf && index === parts.length - 1 && (error as NodeJS.ErrnoException).code === 'ENOENT') return null
          throw error
        })
        if (!info) {
          if (credentialFile(parts[index])) throw new FilesystemAccessError('Athena blocks this credential file; no content was read.', 'filesystem_policy_denied', 'credential_filename', absolute)
          return current
        }
        const resolved = await realpath(current)
        if ((info.isSymbolicLink() || resolved !== current) && !systemAlias(current, resolved)) {
          const rel = relative(workspace.root, resolved)
          if (this.approvedCredential(workspace, absolute) || !dependencyPath(absolute) || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) || explicitProtectedPath(rel) || protectedMacPath(resolved)) throw new FilesystemAccessError('Symbolic links outside the authorized project or into protected paths are not accessible.', 'symlink_escape_denied', 'symlink_boundary', absolute, true)
        }
        const target = info.isSymbolicLink() ? await lstat(resolved) : info
        if ((credentialFile(parts[index]) || credentialFile(basename(resolved))) && target.isFile() && !developerConfigurationPath(absolute)) throw new FilesystemAccessError('Athena blocks this credential file; no content was read.', 'filesystem_policy_denied', 'credential_filename', absolute, true)
        if (index < parts.length - 1 && !target.isDirectory()) throw new FilesystemAccessError('Invalid Mac directory path.', 'invalid_path', 'path_component', current, true)
        current = resolved
        this.check(signal)
      }
      return realpath(absolute)
    }
    if (path.length > 1000 || isAbsolute(path) || path.includes('\\') || path.includes('\0') || path.split('/').some((part) => !part || part === '.' || part === '..')) throw new FilesystemAccessError('Invalid project-relative path.', 'invalid_path', 'path_syntax', path)
    if (explicitProtectedPath(path) && !this.approvedCredential(workspace, resolve(workspace.root, path)) || path.split('/').some((part, index) => part.startsWith('.') && !(index === 0 && part === '.tmp') && !dependencyPath(path) && !projectInstructionPath(path)) || generatedPath(path) && !dependencyPath(path)) throw new FilesystemAccessError('Filesystem policy excluded this protected or generated project path.', 'filesystem_policy_denied', 'project_protected_or_generated_path', resolve(workspace.root, path))
    const parts = path.split('/')
    let directory = '', current = workspace.root
    const rules: Array<{ base: string; matcher: Ignore }> = []
    for (let index = 0; index < parts.length; index++) {
      const ignorePath = resolve(current, '.gitignore')
      try {
        const info = await lstat(ignorePath)
        if (!info.isFile() || info.isSymbolicLink()) throw new ChatError('Cannot safely read project ignore rules.')
        rules.push({ base: directory, matcher: ignore().add(await this.read(workspace, `${directory}.gitignore`, 64_000)) })
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      const candidate = `${directory}${parts[index]}`
      current = resolve(workspace.root, candidate)
      const info = await lstat(current).catch((error) => { if (allowMissingLeaf && index === parts.length - 1 && error.code === 'ENOENT') return null; throw error })
      if (!info) {
        if (credentialFile(parts[index])) throw new FilesystemAccessError('Athena blocks this credential file; no content was read.', 'filesystem_policy_denied', 'credential_filename', current, true)
        if (!workflowDraftPath(path) && !projectInstructionPath(path) && !dependencyPath(path) && rules.some(({ base, matcher }) => matcher.ignores(candidate.slice(base.length)) || matcher.ignores(candidate.slice(base.length) + '/'))) throw new FilesystemAccessError('This path is excluded by project ignore rules.', 'filesystem_policy_denied', 'project_ignore_rule', current, true)
        return current
      }
      const resolved = await realpath(current)
      if (info.isSymbolicLink() || resolved !== current) {
        const rel = relative(workspace.root, resolved)
        if (this.approvedCredential(workspace, resolve(workspace.root, path)) || !dependencyPath(path) || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) || explicitProtectedPath(rel)) throw new FilesystemAccessError('Symbolic links outside the authorized project or into protected paths are not accessible.', 'symlink_escape_denied', 'symlink_boundary', current, true)
      }
      const target = info.isSymbolicLink() ? await lstat(resolved) : info
      if ((credentialFile(parts[index]) || credentialFile(basename(resolved))) && target.isFile()) throw new FilesystemAccessError('Athena blocks this credential file; no content was read.', 'filesystem_policy_denied', 'credential_filename', current, true)
      if (index < parts.length - 1 && !target.isDirectory()) throw new FilesystemAccessError('Invalid project directory.', 'invalid_path', 'path_component', current, true)
      if (!workflowDraftPath(path) && !projectInstructionPath(path) && !dependencyPath(path) && rules.some(({ base, matcher }) => matcher.ignores(candidate.slice(base.length) + (target.isDirectory() ? '/' : '')))) throw new FilesystemAccessError('This path is excluded by project ignore rules.', 'filesystem_policy_denied', 'project_ignore_rule', current, true)
      directory = `${candidate}/`
      this.check(signal)
    }
    return realpath(current)
  }
  async metadata(id: string, path: string, signal?: AbortSignal): Promise<ProjectEntry> {
    const workspace = await this.workspace(id), absolute = await this.safePath(workspace, path, signal)
    const info = await lstat(absolute)
    if (!info.isDirectory() && (!info.isFile() || (this.filesystemMode() === 'project-only' && !dependencyPath(path) && !supportedSource(path)))) throw new ChatError('This file type is excluded from project access.')
    await this.workspace(id); await this.safePath(workspace, path, signal)
    return { path: path === '.' ? '' : path, type: info.isDirectory() ? 'directory' : 'file', size: info.size, modifiedAt: info.mtime.toISOString(), extension: extname(path) }
  }
  async directory(id: string, path: string, offset = 0, signal?: AbortSignal): Promise<{ entries: ProjectEntry[]; nextOffset: number | null }> {
    const workspace = await this.workspace(id), normalized = path === '.' ? '' : path
    const absolute = await this.safePath(workspace, normalized, signal)
    if (!(await lstat(absolute)).isDirectory()) throw new ChatError('Choose a directory within the project.')
    const items = (await readdir(absolute, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))
    const entries: ProjectEntry[] = []
    let cursor = offset
    // Cursor addresses raw directory entries so excluded files cannot make pagination loop.
    for (; cursor < items.length && entries.length < 100 && cursor < offset + 2000; cursor++) {
      this.check(signal)
      const item = items[cursor], child = isAbsolute(normalized) ? resolve(normalized, item.name) : normalized ? `${normalized}/${item.name}` : item.name
      const global = this.filesystemMode() !== 'project-only'
      if ((item.isSymbolicLink() && !dependencyPath(child)) || (global ? protectedMacPath(resolve(absolute, item.name)) : explicitProtectedPath(child)) || (!global && (item.name.startsWith('.') && !dependencyPath(child) && !projectInstructionPath(child) || generatedPath(child) && !dependencyPath(child) || (!dependencyPath(child) && !item.isDirectory() && !item.isSymbolicLink() && !supportedSource(child))))) continue
      try { entries.push({ ...await this.metadata(id, child, signal), cursor }) } catch { this.check(signal) }
    }
    await this.workspace(id); this.check(signal)
    return { entries, nextOffset: cursor < items.length ? cursor : null }
  }
  async structure(id: string, path: string, depth: number, signal?: AbortSignal): Promise<{ entries: ProjectEntry[]; truncated: boolean; configurationFiles: string[] }> {
    const entries: ProjectEntry[] = []
    let truncated = false
    const visit = async (directory: string, level: number) => {
      let offset: number | null = 0
      do {
        this.check(signal)
        const page = await this.directory(id, directory, offset, signal)
        for (const entry of page.entries) {
          if (entries.length >= 1000) { truncated = true; return }
          entries.push(entry)
          if (entry.type === 'directory' && level < depth && (!excludedDirectories.has(basename(entry.path)) || dependencyPath(path))) await visit(entry.path, level + 1)
          else if (entry.type === 'directory') truncated = true
        }
        offset = page.nextOffset
      } while (offset !== null && entries.length < 1000)
      truncated ||= offset !== null
    }
    await visit(path, 1)
    return { entries, truncated, configurationFiles: entries.filter((entry) => /(?:^|\/)(?:package.json|tsconfig[^/]*\.json|pyproject.toml|Cargo.toml|go.mod|pom.xml|build.gradle|Dockerfile|Makefile|README[^/]*|[^/]*\.config\.[^/]+)$/.test(entry.path)).map((entry) => entry.path) }
  }
  async editTarget(id: string, path: string, directory = false): Promise<{ root: string; absolute: string }> {
    if (!path || path === '.' || (this.filesystemMode() === 'project-only' && !directory && !supportedSource(path))) throw new ChatError('Choose an ordinary source file or directory inside the authorized scope.')
    if (dependencyPath(path)) throw new FilesystemAccessError('Installed dependencies are read-only in file editing tools. Use an approved package-manager install command to change them.', 'filesystem_policy_denied', 'dependency_write_protection', path)
    const workspace = await this.workspace(id)
    if (this.filesystemMode() === 'full-read-only') throw new FilesystemAccessError('Full Mac — Read Only blocks file changes. Choose Full Mac — Read & Write in Settings → Permissions.', 'filesystem_policy_denied', 'full_mac_read_only', path)
    return { root: this.filesystemMode() === 'project-only' ? workspace.root : sep, absolute: await this.safePath(workspace, path, undefined, true) }
  }
  async commandRoot(id: string): Promise<string> { return (await this.workspace(id)).root }
  async commandDirectory(id: string, path: string): Promise<string> {
    const workspace = await this.workspace(id)
    const absolute = await this.safePath(workspace, path)
    if (this.filesystemMode() !== 'project-only' && (absolute === sep || absolute === await realpath(homedir()))) throw new ChatError('Choose a specific development folder, not the entire Mac or home folder, for command execution.')
    if (!(await lstat(absolute)).isDirectory()) throw new ChatError('Choose an accessible working directory.')
    return absolute
  }
  async readRange(id: string, path: string, start: number, end: number, signal?: AbortSignal, maxChars = 20_000): Promise<{ path: string; content: string; version: string; start: number; end: number; totalLines: number; truncated: boolean }> {
    const workspace = await this.workspace(id)
    const absolute = await this.safePath(workspace, path, signal)
    if (this.filesystemMode() === 'project-only' && !dependencyPath(path) && !supportedSource(path)) throw new ChatError('This file type is excluded from project context.')
    const text = await this.read(workspace, path, MAX_TOOL_FILE_BYTES)
    if (sensitiveContent(text) && !(this.filesystemMode() !== 'project-only' && this.developerConfigurationPath(absolute)) && !this.approvedCredential(workspace, absolute)) throw new FilesystemAccessError('File contains possible credentials and is excluded. Use a redacted copy; do not change ownership or ACLs.', 'filesystem_policy_denied', 'credential_content', absolute, true)
    const lines = text.split('\n'), selected: string[] = []
    let length = 0
    for (let index = start - 1; index < Math.min(end, start + 399, lines.length); index++) {
      const line = `${index + 1}: ${lines[index]}`
      if (length + line.length > Math.min(20_000, Math.max(1000, maxChars))) break
      selected.push(line); length += line.length + 1
    }
    await this.workspace(id); await this.safePath(workspace, path, signal)
    return { path, content: selected.join('\n'), version: createHash('sha256').update(text).digest('hex'), start, end: start + selected.length - 1, totalLines: lines.length, truncated: start + selected.length - 1 < Math.min(end, lines.length) }
  }
  async search(id: string, options: { path: string; query: string; glob: string; mode: SearchMode | 'path'; caseSensitive: boolean; offset: number; limit?: number }, signal?: AbortSignal): Promise<{ matches: ProjectFile[]; nextOffset: number | null; truncated: boolean; scannedFiles: number }> {
    const matches: ProjectFile[] = [], matchPath = globMatcher(options.glob || '**/*')
    const sensitiveScope = this.filesystemMode() !== 'project-only' && this.developerConfigurationPath(await this.safePath(await this.workspace(id), options.path, signal))
    const target = await this.metadata(id, options.path, signal)
    let visited = 0, scannedFiles = 0, bytes = 0, hits = 0, truncated = false, hasMore = false
    const visit = async (path: string, depth: number): Promise<void> => {
      if (depth > 30 || visited >= 10_000 || bytes >= MAX_INDEX_BYTES || hasMore) { truncated = true; return }
      let offset: number | null = 0
      do {
        const page: { entries: ProjectEntry[]; nextOffset: number | null } = depth === 0 && target.type === 'file'
          ? { entries: [target], nextOffset: null }
          : await this.directory(id, path, offset, signal)
        for (const entry of page.entries) {
          this.check(signal)
          if (++visited >= 10_000 || bytes >= MAX_INDEX_BYTES || hasMore) { truncated = true; return }
          if (entry.type === 'directory') {
            // A broad Mac search must not trawl private hidden configuration.
            // The user can explicitly target an approved hidden subtree.
            if (!dependencyPath(options.path) && excludedDirectories.has(basename(entry.path))) continue
            if (this.filesystemMode() !== 'project-only' && !sensitiveScope && basename(entry.path).startsWith('.')) continue
            await visit(entry.path, depth + 1); continue
          }
          if (this.filesystemMode() !== 'project-only' && !sensitiveScope && basename(entry.path).startsWith('.') && entry.path !== options.path) continue
          if (!matchPath(entry.path)) continue
          scannedFiles++
          let found: ProjectFile[] = []
          if (options.mode === 'path') {
            const path = options.caseSensitive ? entry.path : entry.path.toLowerCase(), query = options.caseSensitive ? options.query : options.query.toLowerCase()
            if (path.includes(query)) found = [{ path: entry.path, line: 1, excerpt: '' }]
          } else {
            if (entry.size > MAX_TOOL_FILE_BYTES || bytes + entry.size > MAX_INDEX_BYTES) { truncated = true; continue }
            let text: string
            try {
              const workspace = await this.workspace(id)
              const absolute = await this.safePath(workspace, entry.path, signal)
              text = await this.read(workspace, entry.path, MAX_TOOL_FILE_BYTES)
              await this.safePath(workspace, entry.path, signal)
              if (sensitiveContent(text) && !(sensitiveScope && this.developerConfigurationPath(absolute))) continue
            } catch { this.check(signal); truncated = true; continue }
            bytes += Buffer.byteLength(text)
            const lines = text.split('\n')
            found = matchingLines(text, options.query, options.mode, options.caseSensitive, options.offset + 101).map((index) => ({ path: entry.path, line: index + 1, excerpt: lines[index].slice(0, 500) }))
          }
          for (const result of found) {
            if (hits++ < options.offset) continue
            if (matches.length >= Math.min(100, Math.max(5, options.limit ?? 100))) { hasMore = true; break }
            matches.push(result)
          }
        }
        offset = page.nextOffset
      } while (offset !== null && !hasMore)
    }
    await visit(options.path, 0)
    await this.workspace(id); this.check(signal)
    return { matches, nextOffset: hasMore ? options.offset + matches.length : null, truncated, scannedFiles }
  }
  async refresh(id: string): Promise<Workspace> {
    const workspace = await this.workspace(id)
    const files: IndexedFile[] = []
    let bytes = 0, visited = 0
    workspace.truncated = false
    const walk = async (directory: string, rules: Array<{ base: string; matcher: Ignore }>, depth: number): Promise<void> => {
      if (depth > 20 || files.length >= MAX_FILES || bytes >= MAX_INDEX_BYTES || visited > 10_000) { workspace.truncated = true; return }
      this.gate()
      const safeDirectory = await this.safePath(workspace, directory.replace(/\/$/, ''))
      const entries = await readdir(safeDirectory, { withFileTypes: true })
      const gitignore = entries.find((entry) => entry.name === '.gitignore' && entry.isFile())
      if (gitignore) { try { rules = [...rules, { base: directory, matcher: ignore().add(await this.read(workspace, `${directory}${gitignore.name}`, 64_000)) }] } catch { /* An unreadable ignore file must fail closed for this subtree. */ return } }
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (++visited > 10_000 || files.length >= MAX_FILES || bytes >= MAX_INDEX_BYTES) { workspace.truncated = true; break }
        const path = `${directory}${entry.name}`
        if (entry.isSymbolicLink() || sensitivePath(path) || entry.name.startsWith('.') && entry.name !== '.gitignore' || rules.some(({ base, matcher }) => matcher.ignores(path.slice(base.length) + (entry.isDirectory() ? '/' : '')))) continue
        if (entry.isDirectory()) await walk(`${path}/`, rules, depth + 1)
        else if (entry.isFile() && supportedSource(path) && !/lock\.(json|yaml)$|\.lock$|\.min\.(js|css)$|\.map$/.test(path)) {
          try {
            const info = await lstat(resolve(workspace.root, path))
            if (info.size > MAX_FILE_BYTES || bytes + info.size > MAX_INDEX_BYTES) continue
            const text = await this.read(workspace, path)
            if (sensitiveContent(text)) continue
            files.push({ path, text, size: info.size, mtime: info.mtimeMs }); bytes += info.size
          } catch { /* Deleted, replaced, unreadable and binary files are skipped. */ }
        }
      }
    }
    await walk('', [], 0)
    await this.workspace(id)
    workspace.files = files
    return workspace
  }
  async browse(id: string, query: string, offset: number): Promise<{ files: ProjectFile[]; total: number; truncated: boolean }> {
    const workspace = await this.refresh(id)
    const term = query.toLowerCase()
    const files: ProjectFile[] = []
    for (const file of workspace.files) {
      if (!term || file.path.toLowerCase().includes(term)) files.push({ path: file.path, line: 1, excerpt: file.text.split('\n')[0].slice(0, 180) })
      else file.text.split('\n').forEach((line, index) => { if (line.toLowerCase().includes(term)) files.push({ path: file.path, line: index + 1, excerpt: line.slice(0, 180) }) })
    }
    return { files: files.slice(offset, offset + 100), total: files.length, truncated: workspace.truncated }
  }
  async source(id: string, path: string): Promise<string> {
    if (sensitivePath(path) || !supportedSource(path)) throw new ChatError('This file is excluded from project context.')
    const workspace = await this.refresh(id)
    const file = workspace.files.find((entry) => entry.path === path)
    if (!file) throw new ChatError('File is excluded, too large, or no longer available.')
    return file.text
  }
  async retrieve(ids: string[], question: string, signal?: AbortSignal, budget = 16_000): Promise<{ text: string; sources: SourceReference[]; truncated: boolean }> {
    const terms = [...new Set(question.toLowerCase().match(/[a-z_$][\w$./-]{2,}/g) ?? [])].filter((term) => !['the', 'this', 'that', 'how', 'what', 'explain', 'and', 'for', 'with', 'project', 'please'].includes(term))
    if (/auth|login|sign.?in/.test(question.toLowerCase())) terms.push('auth', 'login', 'session', 'jwt')
    if (/architect|dependenc|structure/.test(question.toLowerCase())) terms.push('package.json', 'import ', 'export ', 'readme', 'app.', 'main.')
    const candidates: Array<{ file: IndexedFile; workspace: string; score: number; line: number }> = []
    let truncated = false
    for (const id of ids) {
      if (signal?.aborted) throw new ChatError('Cancelled.')
      const workspace = await this.refresh(id); truncated ||= workspace.truncated
      for (const file of workspace.files) {
        const lines = file.text.split('\n')
        let score = /(^|\/)(package.json|README.md|src\/App.tsx)$/.test(file.path) ? 1 : 0, bestLine = 0, bestScore = 0
        for (const term of terms) if (file.path.toLowerCase().includes(term)) score += 8
        lines.forEach((line, index) => { const hits = terms.filter((term) => line.toLowerCase().includes(term)).length; score += Math.min(hits, 2); if (hits > bestScore) { bestLine = index; bestScore = hits } })
        if (score > 0) candidates.push({ file, workspace: workspace.reference.name, score, line: bestLine })
      }
      // Bring directly imported source neighbors alongside the best lexical hits.
      const seeds = candidates.filter((candidate) => candidate.workspace === workspace.reference.name).sort((a, b) => b.score - a.score).slice(0, 3)
      for (const seed of seeds) for (const match of seed.file.text.matchAll(/(?:from\s*|import\s*\(|require\s*\()?["'](\.{1,2}\/[^"']+)["']/g)) {
        const path = posix.normalize(posix.join(posix.dirname(seed.file.path), match[1])).replace(/\.(js|jsx|mjs)$/, '')
        const related = workspace.files.find((file) => file.path === path || file.path.replace(/\.[^/.]+$/, '') === path || file.path.replace(/\/index\.[^/.]+$/, '') === path)
        if (related && !candidates.some((candidate) => candidate.file === related)) candidates.push({ file: related, workspace: workspace.reference.name, score: Math.max(2, seed.score / 2), line: 0 })
      }
    }
    candidates.sort((a, b) => b.score - a.score)
    const sources: SourceReference[] = [], blocks: string[] = []
    let remaining = Math.min(16_000, budget)
    for (const candidate of candidates.slice(0, 8)) {
      const lines = candidate.file.text.split('\n'), start = Math.max(0, candidate.line - 12), end = Math.min(lines.length, start + 70)
      const block = `SOURCE ${candidate.workspace}/${candidate.file.path}\n${lines.slice(start, end).map((line, index) => `${start + index + 1}: ${line}`).join('\n')}`
      if (Buffer.byteLength(block) > remaining) { truncated = true; continue }
      blocks.push(block); remaining -= Buffer.byteLength(block); sources.push({ workspace: candidate.workspace, path: candidate.file.path, start: start + 1, end })
    }
    this.gate()
    return { text: blocks.join('\n\n'), sources, truncated }
  }
}
