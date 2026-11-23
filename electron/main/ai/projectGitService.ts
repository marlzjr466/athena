import { execFile } from 'node:child_process'
import { existsSync, readFileSync, watch, type FSWatcher } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { delimiter, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { AgentCommands, redactOutput } from './agentCommands'
import { projectCommandLease } from './projectCommandLease'
import { ChatError } from './AIProvider'
import type { WorkspaceService } from './workspaceService'
import type { ChatController } from './chatController'
import type { Settings } from '../../../shared/settings'
import { projectGitCommandSchema, type ProjectGitState, type ProjectGitResult, type ProjectGitEvent } from '../../../shared/projectGit'
import { log } from '../logger'
import { protectedMacPath } from './workspaceService'

const empty = (): ProjectGitState => ({ repository: false, head: '', branches: [] })
const inside = (root: string, path: string) => { const rel = relative(root, path); return rel === '' || !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`) }
const branchChanged = 'The project branch changed. Athena stopped this task to protect the working tree. Completed work is preserved; review the selected branch before resuming.'
// Shared by conversation, local and voice contexts without merging their grants.
const mutations = new Set<string>()
const executions = new Map<string, Set<string>>()
type GitResult = { code: number; stdout: string; stderr: string }
type Listener = { validate(): Promise<void>; notify(result: ProjectGitResult): void }
interface RepositoryWatch { root: string; state?: ProjectGitState; watchers: FSWatcher[]; paths: string; listeners: Map<string, Listener>; timer?: ReturnType<typeof setTimeout>; pending?: Promise<ProjectGitState>; dirty?: boolean; closed?: boolean }

/** Porcelain v1 -z: a rename has a second pathname, but represents one changed file. */
export function countGitChanges(output: string): number {
  const records = output.split('\0'); let count = 0
  for (let i = 0; i < records.length; i++) {
    if (!records[i]) continue
    if (!/^[ MADRCU?!]{2} /.test(records[i])) throw new ChatError('Git returned an incomplete working-tree status.')
    count++
    if (/R|C/.test(records[i].slice(0, 2))) i++
  }
  return count
}

/** Fixed local Git operations for explicit UI actions, following GitIdentityService's
 * shell-free backend pattern. This is never exposed as a model command executor. */
export class ProjectGitService {
  private repositories = new Map<string, RepositoryWatch>()
  private subscriptions = new Map<string, () => void>()
  private lifetime = new AbortController()
  constructor(private chat: ChatController, private workspaces: WorkspaceService, private settings?: () => Settings) {}

  private executable(): string {
    if (process.platform !== 'win32') return new AgentCommands().executable('git')
    const paths = [...(process.env.PATH ?? '').split(delimiter), join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'cmd')]
    const found = paths.filter(isAbsolute).map(path => join(path, 'git.exe')).find(existsSync)
    if (!found) throw new ChatError('Install Git for Windows and restart Athena to use project branches.')
    return found
  }
  private git(root: string, args: string[]): Promise<GitResult> {
    this.lifetime.signal.throwIfAborted()
    const nullPath = process.platform === 'win32' ? 'NUL' : '/dev/null'
    // No inherited GIT_DIR, index overrides, SSH commands, credential helpers,
    // shell aliases, hooks, fsmonitor executables, network or recursive submodules.
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, TEMP: process.env.TEMP, TMP: process.env.TMP, LANG: 'C', LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: nullPath, GIT_ATTR_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: '' }
    const options = ['--no-pager', '-c', `core.hooksPath=${nullPath}`, '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-c', 'credential.helper=', '-c', 'submodule.recurse=false', '-c', 'core.attributesFile=', '-c', 'diff.external=']
    return new Promise((resolveResult, reject) => {
      execFile(this.executable(), [...options, ...args], { cwd: root, env, encoding: 'utf8', windowsHide: true, timeout: 20_000, maxBuffer: 8 * 1024 * 1024, signal: this.lifetime.signal }, (error, stdout, stderr) => {
        if (error && (typeof error.code !== 'number' || error.killed)) return reject(new ChatError(error.killed ? 'Git inspection timed out. Refresh to retry; no clean status was assumed.' : 'Git could not run. Check Git installation and project access.'))
        resolveResult({ code: error ? Number(error.code) : 0, stdout, stderr })
      })
    })
  }
  private checked(result: GitResult): string {
    if (result.code !== 0) throw new ChatError(redactOutput(result.stderr.trim()).slice(0, 3000) || 'Git operation failed. Review the repository in your Git client.')
    return result.stdout.trim()
  }
  private async metadata(root: string): Promise<{ root: string; gitDir: string; commonDir: string } | undefined> {
    const result = await this.git(root, ['rev-parse', '--show-toplevel'])
    if (result.code !== 0 && /not a git repository/i.test(result.stderr)) return undefined
    const repository = await realpath(this.checked(result))
    const gitDir = await realpath(resolve(root, this.checked(await this.git(root, ['rev-parse', '--absolute-git-dir']))))
    const commonDir = await realpath(resolve(root, this.checked(await this.git(root, ['rev-parse', '--git-common-dir']))))
    return { root: repository, gitDir, commonDir }
  }
  private async snapshot(root: string, entry?: RepositoryWatch): Promise<ProjectGitState> {
    const meta = await this.metadata(root)
    if (entry) this.watchPaths(entry, meta ? [root, meta.gitDir, ...(meta.commonDir === meta.gitDir ? [] : [meta.commonDir])] : [root])
    if (!meta) return empty()
    const branch = await this.git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
    if (branch.code !== 0 && branch.code !== 1) this.checked(branch)
    const revision = await this.git(root, ['rev-parse', '--verify', 'HEAD'])
    const oid = revision.code === 0 ? revision.stdout.trim() : ''
    const branches = this.checked(await this.git(root, ['for-each-ref', '--format=%(refname:strip=2)', '--sort=refname', 'refs/heads/'])).split('\n').filter(Boolean)
    const state: ProjectGitState = { repository: true, root: meta.root, head: `${branch.stdout.trim()}\n${oid}`, branches, ...(branch.code === 0 ? { branch: branch.stdout.trim() } : { detached: oid.slice(0, 10) || 'unknown' }) }
    if (!inside(root, meta.root)) state.mutationBlocked = 'Select the repository root as your project before switching branches; this folder authorizes only part of the working tree.'
    // Local filters can execute arbitrary programs even during status. Refuse to
    // invoke them, rather than silently disabling a required checkout conversion.
    const filters = await this.git(root, ['config', '--name-only', '--get-regexp', '^filter\..*\.(clean|smudge|process)$'])
    if (filters.code === 0) state.error = state.mutationBlocked = 'This repository configures Git content filters. Use your Git client to inspect or switch it safely.'
    else {
      if (filters.code !== 1) this.checked(filters)
      const status = await this.git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none'])
      if (status.code !== 0 || /permission denied|operation not permitted/i.test(status.stderr)) state.error = `Working-tree status is incomplete. ${redactOutput(status.stderr).slice(0, 2000)}`
      else state.changedFiles = countGitChanges(status.stdout)
    }
    return state
  }
  private watchPaths(entry: RepositoryWatch, paths: string[]): void {
    const candidates = [...new Set(paths)]
    const unique = candidates.filter(path => !candidates.some(other => other !== path && inside(other, path))), key = unique.join('\0')
    if (entry.closed || key === entry.paths) return
    entry.watchers.forEach(watcher => watcher.close()); entry.watchers = []; entry.paths = key
    for (const path of unique) {
      try {
        const watcher = watch(path, { recursive: true, persistent: false }, (_event, file) => {
          const name = String(file ?? '').replaceAll('\\', '/')
          if (/(^|\/)(node_modules|\.git\/objects)(\/|$)/.test(name) || /\.lock$/.test(name)) return
          // Cancellation guards read HEAD synchronously, before debounce/status.
          for (const [key, listener] of entry.listeners) if (key.startsWith('execution:')) listener.notify({ ok: true })
          this.schedule(entry)
        })
        watcher.on('error', () => { entry.paths = ''; this.schedule(entry) })
        entry.watchers.push(watcher)
      } catch { entry.paths = ''; /* Focus/open refresh remains available on unsupported filesystems. */ }
    }
  }
  private schedule(entry: RepositoryWatch): void {
    if (entry.closed || entry.timer) return
    entry.timer = setTimeout(() => { entry.timer = undefined; void this.refresh(entry).catch(() => {}) }, 250)
    entry.timer.unref?.()
  }
  private refresh(entry: RepositoryWatch): Promise<ProjectGitState> {
    if (entry.pending) { entry.dirty = true; return entry.pending }
    entry.pending = (async () => {
      for (const [key, listener] of entry.listeners) {
        try { await listener.validate() } catch { listener.notify({ ok: false, message: 'Project access changed. Select the project again.' }); this.release(entry, key) }
      }
      if (entry.closed) return empty()
      try {
        const state = await this.snapshot(entry.root, entry)
        if (!entry.closed) {
          const changed = JSON.stringify(entry.state) !== JSON.stringify(state)
          entry.state = state
          if (changed) for (const listener of entry.listeners.values()) listener.notify({ ok: true, state })
        }
        return state
      } catch (error) {
        entry.state = undefined // Publish the next recovery even if its values match the last good UI snapshot.
        const message = error instanceof ChatError ? error.userMessage : 'Could not refresh Git status. Check project access.'
        for (const listener of entry.listeners.values()) listener.notify({ ok: false, message })
        throw error
      }
    })().finally(() => { entry.pending = undefined; if (entry.dirty) { entry.dirty = false; this.schedule(entry) } })
    return entry.pending
  }
  private release(entry: RepositoryWatch, key: string): void {
    if (entry.closed) return
    entry.listeners.delete(key)
    if (!entry.listeners.size) { entry.closed = true; clearTimeout(entry.timer); entry.watchers.forEach(watcher => watcher.close()); this.repositories.delete(entry.root) }
  }
  private observe(root: string, key: string, listener: Listener): { entry: RepositoryWatch; release(): void } {
    let entry = this.repositories.get(root)
    if (!entry) { entry = { root, watchers: [], paths: '', listeners: new Map() }; this.repositories.set(root, entry) }
    entry.listeners.set(key, listener)
    return { entry, release: () => this.release(entry!, key) }
  }
  private async authorize(sessionId: string, workspaceId: string, write = false): Promise<string> {
    const session = this.chat.getSession(sessionId)
    if (!session || session.workspaces[0]?.id !== workspaceId) throw new ChatError('Select this project conversation again before using its branches.')
    const root = await this.workspaces.authorizedRoot(workspaceId)
    if (write) {
      if (session.config.agentMode === 'read-only' || this.workspaces.filesystemMode() === 'full-read-only') throw new ChatError('Read Only mode prevents switching or creating branches.')
      if (!(session.config.contextSettings?.allowProjectCommands ?? this.settings?.().aiContext.allowProjectCommands ?? true)) throw new ChatError('Project commands are disabled for this conversation.')
      // Automation-category grants apply to model actions. This explicit UI
      // action follows the same project policy as the existing Revert control.
      const busy = this.chat.workspaceReferences().filter(reference => reference.fingerprint === session.workspaces[0].fingerprint || reference.id === workspaceId)
      if (busy.some(reference => this.chat.workspaceExecuting(reference.id))) throw new ChatError('Stop active tasks and sub-agents in this project before switching branches.')
      if (executions.get(root)?.size) throw new ChatError('Stop active tasks in this project before switching branches.')
    }
    return root
  }
  releaseOwner(owner: string): void { for (const [key, release] of this.subscriptions) if (key.startsWith(`${owner}:`)) { release(); this.subscriptions.delete(key) } }
  async run(input: unknown, owner: string, notify: (event: ProjectGitEvent) => void): Promise<ProjectGitResult> {
    const parsed = projectGitCommandSchema.safeParse(input)
    if (!parsed.success) return { ok: false, message: 'Invalid branch request.' }
    const command = parsed.data
    const key = 'subscriptionId' in command ? `${owner}:${command.subscriptionId}` : ''
    if (command.action === 'unwatch') { this.subscriptions.get(key)?.(); this.subscriptions.delete(key); return { ok: true } }
    let watchCancelled = false, releaseWatch: (() => void) | undefined
    const cancelWatch = () => { watchCancelled = true; releaseWatch?.() }
    if (command.action === 'watch') {
      this.subscriptions.get(key)?.()
      // Register cancellation before authorization yields. Rapid project changes
      // can unsubscribe while the initial filesystem check is still in flight.
      this.subscriptions.set(key, cancelWatch)
    }
    try {
      const write = command.action === 'create' || command.action === 'switch'
      const root = await this.authorize(command.sessionId, command.workspaceId, write)
      if (command.action === 'watch') {
        if (watchCancelled) return { ok: true }
        let previousBranch: string | undefined
        const subscription = this.observe(root, key, { validate: async () => { await this.authorize(command.sessionId, command.workspaceId) }, notify: result => {
          const branch = result.state && (result.state.branch ?? result.state.detached ?? '')
          if (branch !== undefined) {
            if (previousBranch !== undefined && previousBranch !== branch) this.chat.invalidateWorkspaceContext(command.workspaceId)
            previousBranch = branch
          }
          notify({ ...result, subscriptionId: command.subscriptionId })
        } })
        releaseWatch = subscription.release
        return { ok: true, state: await this.refresh(subscription.entry) }
      }
      if (!write) {
        const entry = this.repositories.get(root)
        return { ok: true, state: entry ? await this.refresh(entry) : await this.snapshot(root) }
      }
      if (mutations.has(root)) throw new ChatError('A branch change is already in progress.')
      mutations.add(root)
      let release: (() => void) | undefined
      try {
        release = await projectCommandLease.acquire(root, this.lifetime.signal)
        await this.authorize(command.sessionId, command.workspaceId, true)
        const before = await this.snapshot(root)
        if (!before.repository) throw new ChatError('This project is not a Git repository.')
        if (before.mutationBlocked || before.error) throw new ChatError(before.mutationBlocked ?? before.error!)
        if (before.head !== command.expectedHead) throw new ChatError('HEAD changed since the menu opened. Refresh and select the branch again.')
        if (command.branch.startsWith('-') || command.branch.includes('@{') || /[\0\r\n]/.test(command.branch)) throw new ChatError('Enter a literal, valid local branch name.')
        this.checked(await this.git(root, ['check-ref-format', '--branch', command.branch]))
        if (command.action === 'create' && before.branches.includes(command.branch)) throw new ChatError('A local branch with this name already exists.')
        if (command.action === 'switch' && !before.branches.includes(command.branch)) throw new ChatError('This local branch no longer exists. Refresh the branch list.')
        if (command.action === 'switch' && before.head.split('\n')[1]) {
          const difference = await this.git(root, ['diff', '--no-ext-diff', '--no-textconv', '--name-only', '-z', 'HEAD', `refs/heads/${command.branch}`, '--'])
          this.checked(difference)
          if (difference.stdout.split('\0').filter(Boolean).some(protectedMacPath)) throw new ChatError('This branch would change protected files. Switch it in your Git client after reviewing those changes.')
          const allowDeletion = this.chat.getSession(command.sessionId)?.config.contextSettings?.allowProjectDeletion ?? this.settings?.().aiContext.allowProjectDeletion ?? true
          if (!allowDeletion) {
            const deleted = await this.git(root, ['diff', '--no-ext-diff', '--no-textconv', '--name-only', '--diff-filter=D', '-z', 'HEAD', `refs/heads/${command.branch}`, '--'])
            this.checked(deleted)
            if (deleted.stdout) throw new ChatError('This branch removes tracked files, but project deletion permission is disabled.')
          }
        }
        // Explicit user action is authorization for this one change in Ask mode.
        // No force, merge, stash, reset, remote guessing or submodule checkout.
        await this.authorize(command.sessionId, command.workspaceId, true)
        const result = await this.git(root, ['switch', '--no-guess', '--no-recurse-submodules', '--no-overwrite-ignore', ...(command.action === 'create' ? ['-c', command.branch] : ['--', command.branch])])
        log('project.branch_change', { action: command.action, sessionId: command.sessionId, workspaceId: command.workspaceId, exitCode: result.code })
        this.checked(result)
        this.chat.invalidateWorkspaceContext(command.workspaceId)
        const entry = this.repositories.get(root)
        return { ok: true, state: entry ? await this.refresh(entry) : await this.snapshot(root) }
      } finally { release?.(); mutations.delete(root) }
    } catch (error) {
      if (command.action === 'watch') { cancelWatch(); if (this.subscriptions.get(key) === cancelWatch) this.subscriptions.delete(key) }
      return { ok: false, message: error instanceof ChatError ? error.userMessage : 'Could not change or inspect this branch. Check project access and refresh.' }
    }
  }

  /** Monitor native runtimes as well as API agents; check HEAD again before each
   * shared tool dispatch. Branch changes interrupt with a resumable checkpoint. */
  async guard(sessionId: string, workspaceId: string, signal: AbortSignal): Promise<(() => void) & { description?: string }> {
    const root = await this.authorize(sessionId, workspaceId)
    if (mutations.has(root)) throw new ChatError('A branch change is in progress. Retry the task after it finishes.')
    // Non-Git projects continue to work on machines without Git installed.
    let ancestor = root
    while (!existsSync(join(ancestor, '.git'))) {
      const parent = resolve(ancestor, '..')
      if (parent === ancestor) return () => {}
      ancestor = parent
    }
    const meta = await this.metadata(root)
    if (!meta) return () => {}
    const headFile = join(meta.gitDir, 'HEAD'), original = readFileSync(headFile, 'utf8')
    let changed = false
    const assert = () => {
      signal.throwIfAborted()
      let current: string
      try { current = readFileSync(headFile, 'utf8') } catch { current = '' }
      if (current !== original || changed) {
        changed = true; this.chat.interruptWorkspace(workspaceId, branchChanged)
        throw new ChatError(branchChanged)
      }
    }
    const key = `execution:${randomUUID()}`
    const running = executions.get(root) ?? new Set<string>(); running.add(key); executions.set(root, running)
    const subscription = this.observe(root, key, { validate: async () => { await this.authorize(sessionId, workspaceId) }, notify: () => { try { assert() } catch { /* The controller owns cancellation and checkpoint persistence. */ } } })
    this.watchPaths(subscription.entry, [root, meta.gitDir, meta.commonDir])
    const release = () => { subscription.release(); running.delete(key); if (!running.size) executions.delete(root) }
    signal.addEventListener('abort', release, { once: true })
    if (signal.aborted) release()
    return Object.assign(assert, { description: original.startsWith('ref: refs/heads/') ? `branch ${JSON.stringify(original.trim().slice('ref: refs/heads/'.length))}` : `detached HEAD ${original.trim().slice(0, 10)}` })
  }
  dispose(): void { this.lifetime.abort(); for (const entry of this.repositories.values()) { entry.closed = true; clearTimeout(entry.timer); entry.watchers.forEach(watcher => watcher.close()) }; this.repositories.clear(); this.subscriptions.clear() }
}
