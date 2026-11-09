import { sandboxCommandScope } from '../permissions/sandboxCommandPermission'
import type { RememberedScope } from '../../../shared/permissions'
import { randomUUID } from 'node:crypto'
import { lstat, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { ChangePreview } from '../../../shared/agent'
import { AgentCommands, type CommandRequest, type CommandResult } from './agentCommands'
import { ChatError } from './AIProvider'
import { assertStagedCommitUnchanged, inspectStagedCommit } from './gitCommitReview'
import { GitIdentityService } from './gitIdentity'
import { sensitiveContent, sensitivePath } from './workspaceService'

type Terminal = { controller: AbortController; output: string; truncated: boolean; result?: { exitCode: number | null; signal: string | null }; finished: Promise<void> }
export type TerminalApproval = (title: string, description: string, signal: AbortSignal, changes?: ChangePreview[], rememberScope?: RememberedScope) => Promise<boolean>

/** Cursor's ACP client terminal: never grant the agent a native, unsandboxed shell. */
export class CursorTerminalBridge {
  private terminals = new Map<string, Terminal>()
  private stagedPaths = new Set<string>()
  private readonly shutdown = new AbortController()
  constructor(
    private readonly root: string,
    private readonly parentSignal: AbortSignal,
    private readonly approve: TerminalApproval | undefined,
    private readonly assertAccess: () => Promise<void>,
    private readonly commands = new AgentCommands(),
    private readonly identity = new GitIdentityService(),
    private readonly leaseHeld = false,
  ) {}

  private execute(request: CommandRequest, signal: AbortSignal, onOutput?: (output: string) => void): Promise<CommandResult> {
    return this.commands.execute(this.root, { ...request, projectLeaseHeld: this.leaseHeld }, signal, onOutput)
  }
  private readonly gitRunner = { execute: (root: string, request: CommandRequest, signal: AbortSignal) => this.commands.execute(root, { ...request, projectLeaseHeld: this.leaseHeld }, signal) }

  async supported(): Promise<boolean> { return this.commands.supported() }
  dispose(): void { this.shutdown.abort(); for (const terminal of this.terminals.values()) terminal.controller.abort(); this.terminals.clear() }

  private async permission(title: string, description: string, signal: AbortSignal, changes?: ChangePreview[], rememberScope?: RememberedScope): Promise<void> {
    await this.assertAccess()
    if (!this.approve || !await this.approve(title, description, signal, changes, rememberScope)) throw new ChatError('Command permission was declined or unavailable. No command was run; ask the user before retrying.')
    signal.throwIfAborted()
    await this.assertAccess()
  }

  private async safePath(path: string): Promise<string> {
    if (!path || path.startsWith('-') || path.includes('\0') || /[*?\[\]{}]/.test(path) || path.split('/').some((part) => part === '..' || part === '.') || isAbsolute(path)) throw new ChatError('Git staging requires explicit project-relative file paths; globs, flags, and parent traversal are not accepted.')
    const absolute = resolve(this.root, path)
    const stat = await lstat(absolute).catch(() => null)
    if (stat?.isDirectory() || stat?.isSymbolicLink()) throw new ChatError('Git staging accepts only explicit ordinary files, not directories or symlinks.')
    const canonical = await realpath(stat ? absolute : dirname(absolute)).catch(() => null)
    if (!canonical) throw new ChatError('Git staging target or its parent is unavailable.')
    const relativePath = relative(this.root, stat ? canonical : absolute)
    const ancestor = relative(this.root, canonical)
    if (ancestor === '..' || ancestor.startsWith(`..${sep}`) || isAbsolute(ancestor) || relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath) || !relativePath || sensitivePath(relativePath)) throw new ChatError('Git staging target is outside the authorized project or is protected.')
    return relativePath
  }

  private normalizeCommand(params: Record<string, unknown>): { executable: string; args: string[] } {
    const raw = params.command
    if (typeof raw !== 'string' || !raw || raw.length > 200 || /[\s\0]/.test(raw)) throw new ChatError('Invalid terminal executable. Provide a direct executable and separate argument array; shell strings are blocked.')
    const executable = basename(raw)
    if (raw.includes('/') && this.commands.executable(executable) !== raw) throw new ChatError('Executable path is not an authorized development tool.')
    if (!['echo', 'npm', 'pnpm', 'yarn', 'node', 'git', 'python3', 'go', 'cargo', 'curl'].includes(executable)) throw new ChatError(`${executable} is not an authorized development executable. Shell interpreters are blocked.`)
    const args = params.args === undefined ? [] : params.args
    if (!Array.isArray(args) || args.length > 40 || args.some((arg) => typeof arg !== 'string' || arg.length > 1000 || arg.includes('\0'))) throw new ChatError('Terminal arguments must be a bounded string array.')
    if (Array.isArray(params.env) && params.env.length || params.env !== undefined && !Array.isArray(params.env)) throw new ChatError('Agent-supplied environment variables are blocked; Athena creates an isolated command environment.')
    if (sensitiveContent(JSON.stringify(args))) throw new ChatError('Possible credentials in command arguments are blocked.')
    return { executable, args: args as string[] }
  }

  private async validateCwd(params: Record<string, unknown>): Promise<void> {
    if (typeof params.cwd !== 'string' || !isAbsolute(params.cwd)) throw new ChatError('A project working directory is required for terminal commands.')
    const cwd = await realpath(params.cwd).catch(() => null)
    if (cwd !== this.root) throw new ChatError(`Terminal working directory must be the authorized project root: ${this.root}`)
    await this.assertAccess()
  }

  async create(params: Record<string, unknown>, sessionId: string): Promise<{ terminalId: string }> {
    this.shutdown.signal.throwIfAborted()
    if (!sessionId || params.sessionId !== sessionId) throw new ChatError('Terminal request belongs to a different or inactive Cursor session.')
    if (this.terminals.size >= 4) throw new ChatError('Too many active project terminals. Release an earlier terminal first.')
    if (!await this.supported()) throw new ChatError('Secure macOS command isolation is unavailable; Athena will not run an unsandboxed terminal command.')
    await this.validateCwd(params)
    const { executable, args } = this.normalizeCommand(params)
    const controller = new AbortController()
    const signal = AbortSignal.any([this.parentSignal, this.shutdown.signal, controller.signal])
    if (params.local_network !== undefined && typeof params.local_network !== 'boolean') throw new ChatError('local_network must be a boolean.')
    const request: CommandRequest = { executable, args, network: false, loopback: params.local_network === true, install: false, gitWrite: false, filesystemMode: 'project-only' }
    let run: (onOutput: (output: string) => void) => Promise<CommandResult>
    if (executable === 'git') run = await this.prepareGit(args, request, signal)
    else {
      if (['npm', 'pnpm', 'yarn'].includes(executable) && (args[0] === 'install' || args[0] === 'add' || args[0] === 'update' || args[0] === 'ci')) request.install = true
      await this.permission('Run isolated project command', `${executable} ${args.join(' ')}\nWorking directory: ${this.root}\nNetwork: ${request.loopback ? 'outbound loopback only; external internet and listening sockets blocked' : 'blocked'}. Source writes: blocked. ${request.install ? 'Dependency writes: allowed only for this approved command.' : 'Dependency writes: blocked.'}`, signal, undefined, sandboxCommandScope(this.root, request, this.commands.executable(executable), 'cursor-terminal'))
      run = (onOutput) => this.execute(request, signal, onOutput)
    }
    signal.throwIfAborted()
    const terminalId = randomUUID()
    const terminal: Terminal = { controller, output: '', truncated: false, finished: Promise.resolve() }
    this.terminals.set(terminalId, terminal)
    terminal.finished = run((output) => { terminal.output = output }).then((result) => {
      terminal.output = result.output
      terminal.truncated = result.truncated
      terminal.result = { exitCode: result.exitCode, signal: result.timedOut || signal.aborted ? 'SIGTERM' : null }
    }, (error: unknown) => {
      terminal.output = error instanceof ChatError ? error.userMessage : 'Isolated command failed unexpectedly.'
      terminal.result = { exitCode: 1, signal: signal.aborted ? 'SIGTERM' : null }
    })
    return { terminalId }
  }

  private async prepareGit(args: string[], request: CommandRequest, signal: AbortSignal): Promise<(onOutput: (output: string) => void) => Promise<CommandResult>> {
    const action = args[0]
    const readOnly = new Set(['status', 'diff', 'log', 'branch', 'rev-parse', 'show', 'ls-files'])
    const base = ['--no-pager', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'diff.external=', '-c', 'credential.helper=']
    if (readOnly.has(action) && !(action === 'branch' && args.slice(1).some((arg) => !['--list', '-a', '-r', '--show-current', '-v', '-vv'].includes(arg)))) {
      if (args.some((arg) => /^(?:-c|-C|--exec-path|--git-dir|--work-tree|--config-env|--output|--ext-diff|--no-index)(?:=|$)/.test(arg))) throw new ChatError('Git configuration, repository override, and output-file flags are blocked.')
      request.args = [...base, ...args]
      await this.permission('Run isolated Git inspection', `git ${args.join(' ')}\nRepository: ${this.root}\nRead-only; no network access.`, signal)
      return (onOutput) => this.execute(request, signal, onOutput)
    }
    if (action === 'add') {
      const pathArgs = args[1] === '--' ? args.slice(2) : args.slice(1)
      if (!pathArgs.length || pathArgs.length > 30) throw new ChatError('Git add requires explicit files: git add -- path1 [path2]. Git add -A, -u, and . are blocked.')
      const paths = await Promise.all(pathArgs.map((path) => this.safePath(path)))
      if (!this.stagedPaths.size) {
        const prior = await this.execute({ executable: 'git', args: [...base, 'diff', '--cached', '--name-only', '-z'], network: false, install: false, gitWrite: false }, signal)
        if (prior.exitCode !== 0 || prior.timedOut || prior.truncated) throw new ChatError('Git index could not be checked before staging. No files were staged.')
        if (prior.stdout) throw new ChatError('Git index already contains staged files from another task. Commit or unstage them separately before automatic per-slice staging.')
      }
      await this.permission('Stage specific project files', `Repository: ${this.root}\nFiles:\n${paths.join('\n')}\nNo other files will be staged.`, signal)
      request.args = [...base, 'add', '--', ...paths]
      request.gitWrite = true
      return async (onOutput) => {
        const result = await this.execute(request, signal, onOutput)
        if (result.exitCode === 0) for (const path of paths) this.stagedPaths.add(path)
        return result
      }
    }
    if (action === 'commit') {
      if (args.length !== 3 || (args[1] !== '-m' && args[1] !== '--message') || !args[2].trim()) throw new ChatError('Git commit requires one explicit message: git commit -m "message". Other commit modes are blocked.')
      const review = await inspectStagedCommit(this.gitRunner, this.root, signal)
      const reviewedPaths = review.changes.map((change) => change.path)
      if (!reviewedPaths.length || reviewedPaths.some((path) => !this.stagedPaths.has(path))) throw new ChatError('Commit blocked: the index contains files not staged by this authorized Cursor task. No unrelated files will be committed.')
      const author = await this.identity.read(this.root, signal)
      if (author.name.status !== 'found' || author.email.status !== 'found') throw new ChatError('Commit blocked: configured Git username or email is missing or inaccessible. No commit was created.')
      await this.permission('Create reviewed Git commit', `Repository: ${review.root}\nBranch: ${review.branch}\nStaged: ${review.summary}\nAuthor: ${author.name.value} <${author.email.value}>\nMessage: ${args[2]}\nOnly the reviewed staged files will be committed; no push will occur.`, signal, review.changes)
      await assertStagedCommitUnchanged(this.gitRunner, review, signal)
      request.args = [...base, '-c', `user.name=${author.name.value}`, '-c', `user.email=${author.email.value}`, 'commit', '--no-gpg-sign', '-m', args[2]]
      request.gitWrite = true
      return async (onOutput) => {
        const result = await this.execute(request, signal, onOutput)
        if (result.exitCode === 0) this.stagedPaths.clear()
        return result
      }
    }
    throw new ChatError(`Git ${action ?? 'operation'} is not permitted through this terminal. Use read-only Git inspection or reviewed git add/commit; destructive and network Git actions remain blocked.`)
  }

  private get(params: Record<string, unknown>, sessionId: string): Terminal {
    if (params.sessionId !== sessionId || typeof params.terminalId !== 'string') throw new ChatError('Terminal request belongs to a different Cursor session.')
    const terminal = this.terminals.get(params.terminalId)
    if (!terminal) throw new ChatError('Terminal was released or never belonged to this session.')
    return terminal
  }
  output(params: Record<string, unknown>, sessionId: string): Record<string, unknown> {
    const terminal = this.get(params, sessionId)
    return { output: terminal.output, truncated: terminal.truncated, ...(terminal.result ? { exitStatus: terminal.result } : {}) }
  }
  async waitForExit(params: Record<string, unknown>, sessionId: string): Promise<Record<string, unknown>> {
    const terminal = this.get(params, sessionId)
    await terminal.finished
    return terminal.result ?? { exitCode: 1, signal: null }
  }
  kill(params: Record<string, unknown>, sessionId: string): Record<string, unknown> { this.get(params, sessionId).controller.abort(); return {} }
  release(params: Record<string, unknown>, sessionId: string): Record<string, unknown> {
    const terminal = this.get(params, sessionId)
    terminal.controller.abort()
    this.terminals.delete(params.terminalId as string)
    return {}
  }
}
