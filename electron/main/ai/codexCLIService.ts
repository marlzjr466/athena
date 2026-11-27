import { execFile as nodeExecFile, spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { access, chmod, mkdtemp, realpath, rm } from 'node:fs/promises'
import { constants } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { modelIdSchema } from '../../../shared/ai'
import type { CodexCLIModel, CodexCLIStatus } from '../../../shared/codex'
import type { ReasoningEffort } from '../../../shared/conversations'
import { log } from '../logger'

const execFile = promisify(nodeExecFile)
type RpcId = number | string
export type RpcReply = { id?: RpcId; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { code?: number | string; message?: string } }
type Pending = { method: string; resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }

function safeRpcDetail(value: unknown): string {
  return String(value ?? '')
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(/\b(?:token|secret|authorization)(\s*[:=]\s*)[^\s,;]+/gi, '$1[redacted]')
    .replace(/\b[A-Za-z0-9_-]{48,}\b/g, '[redacted]')
    .replace(/\/(?:Users|private\/tmp|tmp)\/[^\s"'`]+/g, '[local path]')
    .replace(/[\r\n\t]+/g, ' ')
    .slice(0, 240)
}

type ThreadContext = {cwd?:string; threadSource?:string|null}

async function canonicalDirectory(path:string):Promise<string> {
  const absolute=resolve(path)
  try { return await realpath(absolute) }
  catch(error) {
    // Historical workspaces may no longer exist. Resolve their existing parent
    // so aliases such as /var and /private/var still refer to the same workspace.
    if ((error as NodeJS.ErrnoException).code==='ENOENT' && dirname(absolute)!==absolute)
      return join(await canonicalDirectory(dirname(absolute)),basename(absolute))
    return absolute
  }
}

function withinDirectory(root:string,path:string):boolean {
  const rest=relative(root,path)
  return rest==='' || (rest!=='..' && !rest.startsWith('..'+sep) && !isAbsolute(rest))
}

export class CodexAppServerError extends Error {
  constructor(message: string, readonly code?: string) { super(message); this.name = 'CodexAppServerError' }
}

/** User-input callbacks require the documented experimental opt-in. Tools remain Codex-owned. */
export const codexAppServerCapabilities = { experimentalApi: true, requestAttestation: false } as const

/** Small JSON-RPC transport for the official Codex app-server stdio protocol. */
export class CodexAppServerProcess {
  private readonly pending = new Map<RpcId, Pending>()
  private readonly notificationListeners = new Set<(message: RpcReply) => void>()
  private readonly requestListeners = new Set<(message: RpcReply) => void>()
  private sequence = 0
  private buffer = ''
  private closed = false

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => this.consume(chunk))
    child.stderr.on('data', () => { /* Provider diagnostics may include user paths; never forward raw stderr. */ })
    child.on('error', () => this.failAll(new CodexAppServerError('Codex app-server could not be started. Verify the CLI installation in Settings → AI.')))
    child.on('exit', (code, signal) => {
      this.closed = true
      this.failAll(new CodexAppServerError(`Codex app-server exited before completing the request${code !== null ? ` (exit ${code})` : signal ? ` (${signal})` : ''}.`))
      for (const listener of this.notificationListeners) listener({ method: 'server/closed', params: { code, signal } })
    })
  }

  get isClosed(): boolean { return this.closed }

  onNotification(listener: (message: RpcReply) => void): () => void { this.notificationListeners.add(listener); return () => this.notificationListeners.delete(listener) }
  onServerRequest(listener: (message: RpcReply) => void): () => void { this.requestListeners.add(listener); return () => this.requestListeners.delete(listener) }

  request(method: string, params: unknown, timeoutMs = 20_000): Promise<unknown> {
    if (this.closed || !this.child.stdin.writable) return Promise.reject(new CodexAppServerError('Codex app-server is no longer available.'))
    const id = ++this.sequence
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new CodexAppServerError(`Codex app-server timed out during ${method}.`)) }, timeoutMs)
      this.pending.set(id, { method, resolve, reject, timer })
      this.write({ jsonrpc: '2.0', id, method, params })
    })
  }

  notify(method: string, params: unknown = {}): void { this.write({ jsonrpc: '2.0', method, params }) }

  respond(id: RpcId, result: unknown): void { this.write({ jsonrpc: '2.0', id, result }) }
  rejectRequest(id: RpcId, message: string): void { this.write({ jsonrpc: '2.0', id, error: { code: -32000, message } }) }

  async close(): Promise<void> {
    if (this.closed) return
    this.child.stdin.end()
    await Promise.race([new Promise<void>((resolve) => this.child.once('exit', () => resolve())), new Promise<void>((resolve) => setTimeout(resolve, 900))])
    if (!this.closed) this.child.kill('SIGTERM')
    await Promise.race([new Promise<void>((resolve) => this.child.once('exit', () => resolve())), new Promise<void>((resolve) => setTimeout(resolve, 900))])
    if (!this.closed) this.child.kill('SIGKILL')
    this.closed = true
    this.failAll(new CodexAppServerError('Codex app-server session closed.'))
  }

  private write(message: unknown): void {
    try { this.child.stdin.write(`${JSON.stringify(message)}\n`) }
    catch { this.failAll(new CodexAppServerError('Could not communicate with Codex app-server.')) }
  }

  private consume(chunk: string): void {
    this.buffer += chunk
    if (this.buffer.length > 8_000_000) { this.buffer = ''; this.failAll(new CodexAppServerError('Codex app-server emitted an oversized protocol message.')); this.child.kill('SIGTERM'); return }
    for (;;) {
      const newline = this.buffer.indexOf('\n')
      if (newline < 0) return
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      if (!line) continue
      let message: RpcReply
      try { message = JSON.parse(line) as RpcReply }
      catch { this.failAll(new CodexAppServerError('Codex app-server returned an unreadable protocol message.')); this.child.kill('SIGTERM'); return }
      if (message.id !== undefined && !message.method && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id)!
        this.pending.delete(message.id); clearTimeout(pending.timer)
        if (message.error) {
          const detail = safeRpcDetail(message.error.message)
          pending.reject(new CodexAppServerError(`Codex app-server rejected ${pending.method} (provider code ${String(message.error.code ?? 'unknown')})${detail ? `: ${detail}` : '.'}`, String(message.error.code ?? 'rpc_error')))
        }
        else pending.resolve(message.result)
      } else if (message.id !== undefined && message.method) {
        for (const listener of this.requestListeners) listener(message)
      } else if (message.method) {
        for (const listener of this.notificationListeners) listener(message)
      }
    }
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error) }
    this.pending.clear()
  }
}

export interface CodexAppServerSession {
  rpc: CodexAppServerProcess
  sandboxRoot: string
  accountEmail: string | null
  accountId?: string | null
  plan?: string | null
  models: CodexCLIModel[]
  version: string
  executable?: string
  close(): Promise<void>
}

function mapEffort(value: unknown): ReasoningEffort | null {
  const normalized = String(value ?? '').toLowerCase().replaceAll('-', '_')
  if (['auto', 'none', 'minimal', 'low', 'medium', 'high', 'max'].includes(normalized)) return normalized as ReasoningEffort
  if (['xhigh', 'extra_high', 'extra high'].includes(normalized)) return 'xhigh'
  return null
}

export function normalizeCodexModel(value: unknown): CodexCLIModel | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const id = typeof raw.id === 'string' ? raw.id : ''
  if (!modelIdSchema.safeParse(id).success || raw.hidden === true) return null
  const options = Array.isArray(raw.supportedReasoningEfforts) ? raw.supportedReasoningEfforts : []
  const efforts = [...new Set(options.map((entry) => mapEffort(entry && typeof entry === 'object' ? (entry as Record<string, unknown>).reasoningEffort : entry)).filter((entry): entry is ReasoningEffort => Boolean(entry)))]
  const defaultEffort = mapEffort(raw.defaultReasoningEffort)
  return {
    id,
    displayName: typeof raw.displayName === 'string' && raw.displayName.trim() ? raw.displayName.slice(0, 200) : id,
    efforts,
    defaultEffort,
    isDefault: raw.isDefault === true,
  }
}

function environmentForCodex(): NodeJS.ProcessEnv {
  const environment = { ...process.env }
  // The Codex CLI must use its own saved ChatGPT sign-in. Prevent an inherited
  // OpenAI API key/base URL from silently turning this into API billing.
  for (const key of ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_ORG_ID', 'OPENAI_PROJECT_ID']) delete environment[key]
  return environment
}

/** `codex login status` writes its successful status line to stderr in current CLI builds. */
export function codexLoginUsesChatGPT(stdout: unknown, stderr: unknown): boolean {
  return /logged in using chatgpt/i.test(`${String(stdout ?? '')}\n${String(stderr ?? '')}`)
}

function candidatePaths(): string[] {
  const pathDirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
  return [...new Set([
    '/opt/homebrew/bin/codex', '/usr/local/bin/codex', '/usr/bin/codex',
    ...pathDirs.flatMap(directory => process.platform === 'win32' ? [join(directory, 'codex.exe'), join(directory, 'codex')] : [join(directory, 'codex')]),
  ])]
}

export class CodexCLIService {
  private cached?: { expiresAt: number; status: CodexCLIStatus }
  private executable?: string
  private shared?: Promise<CodexAppServerSession>
  private readonly activeThreads = new Set<string>()
  private readonly listedThreads = new Map<string, string>()
  claimThread(id: string): () => void {
    if (this.activeThreads.has(id)) throw new CodexAppServerError('This Codex thread already has an active Athena turn. Use its conversation or stop that turn first.')
    this.activeThreads.add(id)
    return () => this.activeThreads.delete(id)
  }
  async connection(): Promise<CodexAppServerSession> {
    if (!this.shared) {
      const pending = this.openSession(true)
      this.shared = pending
      pending.then(session => session.rpc.onNotification(event => {
        if (event.method === 'server/closed' && this.shared === pending) { this.shared = undefined; this.cached = undefined; void session.close() }
        if (event.method === 'account/updated' || event.method === 'account/login/completed') this.cached = undefined
      }), () => { if (this.shared === pending) this.shared = undefined })
    }
    return this.shared
  }
  async shutdown(): Promise<void> {
    const pending = this.shared; this.shared = undefined
    await pending?.then(session => session.close(), () => {})
  }
  async login(): Promise<{ url: string }> {
    if (this.activeThreads.size) throw new CodexAppServerError('Finish or stop active Codex turns before changing accounts.')
    const session = await this.connection()
    const result = await session.rpc.request('account/login/start', { type: 'chatgpt' }) as { type: string; authUrl?: string }
    if (result.type !== 'chatgpt' || !result.authUrl) throw new CodexAppServerError('Codex did not return a ChatGPT sign-in URL.')
    const url = new URL(result.authUrl)
    if (url.protocol !== 'https:' || !['auth.openai.com', 'chatgpt.com'].includes(url.hostname)) throw new CodexAppServerError('Codex returned an unexpected sign-in host.')
    return { url: url.href }
  }
  async account(session: CodexAppServerSession) {
    const result = await session.rpc.request('account/read', { refreshToken: true }) as import('./codexProtocol/v2/GetAccountResponse').GetAccountResponse
    if (result.account?.type !== 'chatgpt' || !result.account.email) throw new CodexAppServerError('Sign in to Codex with ChatGPT in Settings → AI. API-key billing is not used for subscription conversations.')
    session.accountEmail = result.account.email
    session.accountId = result.userId
    session.plan = result.account.planType
    return result.account
  }
  async listThreads(cursor?: string) {
    const session = await this.connection(); await this.account(session)
    const result = await session.rpc.request('thread/list', { currentAccountOnly: true, limit: 50, sortKey: 'updated_at', ...(cursor ? { cursor } : {}) }) as import('./codexProtocol/v2/ThreadListResponse').ThreadListResponse
    if (!cursor) this.listedThreads.clear()
    // The local server can omit threadSource in its persisted index.
    const reserved=this.voiceWorkspace && await canonicalDirectory(this.voiceWorkspace)
    const keep=await Promise.all(result.data.map(async thread=>{
      const visible=!await this.isVoiceThread(thread,reserved)
      if (!visible) {
        this.listedThreads.delete(thread.id)
        if (result.readStates) delete result.readStates[thread.id]
      }
      return visible
    }))
    result.data=result.data.filter((_thread,index)=>keep[index])
    for (const thread of result.data) this.listedThreads.set(thread.id, `${session.accountId ?? session.accountEmail}:${session.accountEmail}`)
    return result
  }
  async readThread(threadId: string) {
    const session = await this.connection(); await this.account(session)
    if (this.listedThreads.get(threadId) !== `${session.accountId ?? session.accountEmail}:${session.accountEmail}`) throw new CodexAppServerError('Refresh native history and choose a thread belonging to the active Codex account.')
    return this.assertChatThread(threadId,session)
  }
  private async isVoiceThread(thread:ThreadContext, canonicalRoot?:string):Promise<boolean> {
    if (thread.threadSource === 'athena_voice_automation') return true
    if (!this.voiceWorkspace) return false
    if (!thread.cwd || !isAbsolute(thread.cwd)) return true
    if (withinDirectory(this.voiceWorkspace,thread.cwd)) return true
    return withinDirectory(canonicalRoot ?? await canonicalDirectory(this.voiceWorkspace),await canonicalDirectory(thread.cwd))
  }
  async assertChatScope(thread:ThreadContext):Promise<void> {
    if (await this.isVoiceThread(thread)) throw new CodexAppServerError('This thread is outside the normal Codex chat workspace. Its voice automation history stays separate.')
  }
  async assertChatThread(threadId:string,session?:CodexAppServerSession) {
    const {rpc}=session ?? await this.connection()
    const response=await rpc.request('thread/read',{threadId}) as import('./codexProtocol/v2/ThreadReadResponse').ThreadReadResponse
    if (response.thread.id!==threadId) throw new CodexAppServerError('Codex returned a different thread.')
    await this.assertChatScope(response.thread)
    return response
  }
  async turns(threadId: string) {
    const session = await this.connection()
    return session.rpc.request('thread/turns/list', { threadId, limit: 100, sortDirection: 'desc' }) as Promise<import('./codexProtocol/v2/ThreadTurnsListResponse').ThreadTurnsListResponse>
  }
  async items(threadId: string, turnId: string) {
    const session = await this.connection()
    const items: import('./codexProtocol/v2/ThreadItemEntry').ThreadItemEntry[] = []
    let cursor: string | null = null
    do {
      const page: import('./codexProtocol/v2/ThreadItemsListResponse').ThreadItemsListResponse = await session.rpc.request('thread/items/list', { threadId, turnId, limit: 100, ...(cursor ? {cursor} : {}) }) as import('./codexProtocol/v2/ThreadItemsListResponse').ThreadItemsListResponse
      items.push(...page.data); cursor = page.nextCursor
    } while (cursor)
    return items
  }
  constructor(private readonly appVersion = '0.1.0', private readonly voiceWorkspace?:string, private readonly spawn = nodeSpawn, private readonly command = execFile) {}

  invalidate(): void { this.cached = undefined; this.executable = undefined }

  async status(refresh = false): Promise<CodexCLIStatus> {
    if (!refresh && this.cached && this.cached.expiresAt > Date.now()) return structuredClone(this.cached.status)
    const checkedAt = Date.now()
    const executable = await this.findExecutable()
    if (!executable) return this.cache({ installed: false, authenticated: false, version: null, identity: null, models: [], defaultModel: null, checkedAt, message: 'Codex CLI was not found in the standard Homebrew, local, or PATH locations.' })
    let version: string
    try {
      const result = await this.command(executable, ['--version'], { timeout: 10_000, encoding: 'utf8', env: environmentForCodex() })
      version = (/codex-cli\s+([^\s]+)/i.exec(String(result.stdout))?.[1] ?? '').slice(0, 40)
      if (!version) throw new Error('version unavailable')
    } catch {
      return this.cache({ installed: true, authenticated: false, version: null, identity: null, models: [], defaultModel: null, checkedAt, message: 'Codex CLI is present but its version could not be verified.' })
    }
    let session: CodexAppServerSession | undefined
    try {
      session = await this.connection()
      await this.account(session)
      if (!session.accountEmail) return this.cache({ installed: true, authenticated: false, version, identity: null, models: [], defaultModel: null, checkedAt, message: 'Codex CLI is signed in, but app-server did not provide a verifiable account identity. No request was routed.' })
      const catalog = await session.rpc.request('model/list', {limit:200,includeHidden:false}) as {data?:unknown[];nextCursor?:string|null}
      const models = (catalog.data ?? []).map(normalizeCodexModel).filter((m):m is CodexCLIModel=>Boolean(m))
      let cursor=catalog.nextCursor
      while(cursor){const page=await session.rpc.request('model/list',{limit:200,includeHidden:false,cursor}) as {data?:unknown[];nextCursor?:string|null};models.push(...(page.data??[]).map(normalizeCodexModel).filter((m):m is CodexCLIModel=>Boolean(m)));cursor=page.nextCursor}
      session.models=models
      const defaultModel = models.find((model) => model.isDefault)?.id ?? null
      if (!models.length) return this.cache({ installed: true, authenticated: true, version, identity: session.accountEmail, models, defaultModel: null, checkedAt, message: 'Codex CLI is signed in, but app-server returned no selectable models.' })
      return this.cache({ installed: true, authenticated: true, version, identity: session.accountEmail, plan: session.plan, models, defaultModel, checkedAt,
        message: `Codex CLI ${version} is signed in as ${session.accountEmail}. The model catalog is available; model listing does not guarantee usage entitlement.` })
    } catch (error) {
      const reason = error instanceof CodexAppServerError ? error.message : 'Codex app-server could not be queried.'
      return this.cache({ installed: true, authenticated: false, version, identity: null, models: [], defaultModel: null, checkedAt, message: reason })
    }
  }

  async openSession(allowSignedOut = false): Promise<CodexAppServerSession> {
    const executable = await this.findExecutable()
    if (!executable) throw new CodexAppServerError('Codex CLI was not found. Install or select the official Codex CLI in Settings → AI.')
    const versionResult = await this.command(executable, ['--version'], { timeout: 10_000, encoding: 'utf8', env: environmentForCodex() })
    const version = (/codex-cli\s+([^\s]+)/i.exec(String(versionResult.stdout))?.[1] ?? '').slice(0, 40)
    if (!version) throw new CodexAppServerError('Codex CLI version could not be verified.')
    const login = await this.command(executable, ['login', 'status'], { timeout: 12_000, encoding: 'utf8', env: environmentForCodex() }).catch(() => null)
    if (!allowSignedOut && (!login || !codexLoginUsesChatGPT(login.stdout, login.stderr))) throw new CodexAppServerError('Codex CLI is not signed in with ChatGPT. Athena did not use API-key authentication.')
    return this.launchSession(executable, version)
  }

  async supportsEffort(model: string, effort: ReasoningEffort): Promise<boolean> {
    const status = await this.status()
    return status.models.find((entry) => entry.id === model)?.efforts.includes(effort) ?? effort === 'auto'
  }

  supportsEffortCached(model: string, effort: ReasoningEffort): boolean {
    if (effort === 'auto') return true
    return this.cached?.status.models.find((entry) => entry.id === model)?.efforts.includes(effort) ?? false
  }

  private async launchSession(executable: string, version: string): Promise<CodexAppServerSession> {
    const sandboxRoot = await mkdtemp(join(tmpdir(), 'athena-codex-appserver-'))
    await chmod(sandboxRoot, 0o700)
    const child = this.spawn(executable, [
      'app-server', '--listen', 'stdio://',
    ], { cwd: sandboxRoot, env: environmentForCodex(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    const rpc = new CodexAppServerProcess(child)
    let closed = false
    const close = async () => {
      if (closed) return
      closed = true
      await rpc.close()
      await rm(sandboxRoot, { recursive: true, force: true }).catch(() => {})
    }
    try {
      await rpc.request('initialize', { clientInfo: { name: 'athena', title: 'Athena', version: this.appVersion }, capabilities: codexAppServerCapabilities })
      rpc.notify('initialized', {})
      const account = await rpc.request('account/read', {}) as import('./codexProtocol/v2/GetAccountResponse').GetAccountResponse
      const models: CodexCLIModel[] = []
      let cursor: string | null | undefined
      for (let page = 0; page < 10; page++) {
        const response = await rpc.request('model/list', { limit: 200, includeHidden: false, ...(cursor ? { cursor } : {}) }) as { data?: unknown[]; nextCursor?: string | null }
        for (const candidate of response.data ?? []) {
          const model = normalizeCodexModel(candidate)
          if (model && !models.some((entry) => entry.id === model.id)) models.push(model)
        }
        cursor = response.nextCursor
        if (!cursor) break
      }
      return { rpc, executable, sandboxRoot, accountEmail: account.account?.type === 'chatgpt' ? account.account.email : null, accountId: account.userId, plan: account.account?.type === 'chatgpt' ? account.account.planType : null, models, version, close }
    } catch (error) {
      await close()
      if (error instanceof CodexAppServerError) throw error
      throw new CodexAppServerError('Codex app-server could not verify the signed-in account and model catalog.')
    }
  }

  private async findExecutable(): Promise<string | null> {
    if (this.executable) return this.executable
    for (const candidate of candidatePaths()) {
      try { await access(candidate, constants.X_OK); this.executable = candidate; return candidate } catch { /* Check the next documented local install location. */ }
    }
    return null
  }

  private cache(status: CodexCLIStatus): CodexCLIStatus {
    this.cached = { expiresAt: Date.now() + 30_000, status: structuredClone(status) }
    log('codex.cli_status', { installed: status.installed, authenticated: status.authenticated, modelCount: status.models.length, version: status.version ?? 'unknown' })
    return status
  }
}
