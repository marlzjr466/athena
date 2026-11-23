import { spawn, execFile } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { access, chmod, constants, lstat, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { delimiter, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { promisify } from 'node:util'
import { createInterface } from 'node:readline'
import { createHash } from 'node:crypto'
import { app, shell } from 'electron'
import type { AntigravityCommand, AntigravityModel, AntigravityStatus, AntigravityUsageGroup, AntigravityUsageSnapshot } from '../../../shared/antigravity'
import type { ReasoningEffort } from '../../../shared/conversations'
import { emptyAIStatus, type AIResult } from '../../../shared/ai'
import { ChatError } from './AIProvider'
import { ProgressDeadline } from './progressDeadline'
import { log } from '../logger'

const run = promisify(execFile)
type RpcId = string | number
type RpcMessage = { jsonrpc?: string; id?: RpcId; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown>; error?: { message?: string; code?: number } }
type RpcPending = { resolve(value: Record<string, unknown>): void; reject(error: Error): void; deadline: ProgressDeadline; refresh?: () => void }
function safeACPMessage(value: string): string {
  const text = value.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '').replace(/[\r\n\t]+/g, ' ').slice(0, 600)
    .replace(/\b(?:Bearer\s+\S+|sk-[A-Za-z0-9_-]{12,})/gi, '[redacted]')
    .replace(/\/(?:Users|home|private|tmp|var)\/[^\s'"`]+/g, '[project path]')
  const flag = /(?:unknown|unrecognized|invalid)\s+(?:flag|option):?\s*(--?[A-Za-z][\w-]*)/i.exec(text)
  if (flag) return `Unsupported Antigravity ACP flag ${flag[1]}`
  if (/authentication required|not authenticated|not signed in/i.test(text)) return 'Authentication required'
  if (/permission denied|access denied/i.test(text)) return 'Permission denied by Antigravity runtime'
  if (/quota|rate.?limit|resource exhausted/i.test(text)) return 'Antigravity account limit reached'
  if (/invalid params|invalid request|method not found/i.test(text)) return text.slice(0, 180)
  return 'Antigravity ACP reported an unclassified error (details withheld from logs)'
}

export function antigravityMeaningfulACPUpdate(message: RpcMessage): boolean {
  if (message.method === 'session/request_permission') return true
  if (message.method !== 'session/update') return false
  const update = message.params?.update as Record<string, unknown> | undefined
  if (update?.sessionUpdate === 'agent_message_chunk') return typeof (update.content as Record<string, unknown> | undefined)?.text === 'string' && Boolean((update.content as Record<string, unknown>).text)
  return (update?.sessionUpdate === 'tool_call' || update?.sessionUpdate === 'tool_call_update') && typeof update.toolCallId === 'string' && update.toolCallId.length > 0
}

export function antigravityToolProgressKey(update: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify([update.status ?? null, update.content ?? null, update.rawOutput ?? null])).digest('hex')
}

/** Only inheritable runtime settings; no Google/API credentials are copied to Athena. */
export function antigravityEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const names = new Set(['PATH', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'SSL_CERT_FILE', 'SSL_CERT_DIR'])
  return Object.fromEntries(Object.entries(source).filter(([key]) => names.has(key.toUpperCase())))
}

export function parseAntigravityModels(configOptions: unknown): AntigravityModel[] {
  if (!Array.isArray(configOptions)) return []
  const modelOption = configOptions.find((entry) => entry && typeof entry === 'object' && (entry as Record<string, unknown>).id === 'model') as Record<string, unknown> | undefined
  if (!Array.isArray(modelOption?.options)) return []
  const models = new Map<string, AntigravityModel>()
  for (const item of modelOption.options) {
    if (!item || typeof item !== 'object') continue
    const option = item as Record<string, unknown>
    if (typeof option.value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}$/.test(option.value)) continue
    const name = typeof option.name === 'string' && option.name.trim() ? option.name.trim().slice(0, 160) : option.value
    if (!models.has(option.value)) models.set(option.value, { id: option.value, name })
  }
  return [...models.values()]
}

type StructuredCommand = { status?: unknown; command?: { name?: unknown; data?: unknown } }
const safeLabel = (value: unknown, fallback: string): string => typeof value === 'string' && value.trim() ? value.trim().slice(0, 180) : fallback

/** Validates the documented `agy -p "/usage" --output-format json` payload without inferring missing quota data. */
export function parseAntigravityUsageData(data: unknown, fetchedAt = Date.now()): AntigravityUsageSnapshot {
  if (!data || typeof data !== 'object' || !Array.isArray((data as Record<string, unknown>).groups)) throw new Error('Antigravity returned no structured quota groups.')
  const sourceGroups = (data as { groups: unknown[] }).groups
  if (sourceGroups.length > 100) throw new Error('Antigravity returned an invalid quota catalog.')
  const groups: AntigravityUsageGroup[] = sourceGroups.flatMap((rawGroup, groupIndex) => {
    if (!rawGroup || typeof rawGroup !== 'object') return []
    const group = rawGroup as Record<string, unknown>
    if (!Array.isArray(group.buckets)) return []
    const name = safeLabel(group.name, '')
    if (!name) return []
    const id = safeLabel(group.id, name).slice(0, 180)
    const buckets = group.buckets.slice(0, 100).flatMap((rawBucket, bucketIndex) => {
      if (!rawBucket || typeof rawBucket !== 'object') return []
      const bucket = rawBucket as Record<string, unknown>
      const bucketName = safeLabel(bucket.name, '')
      if (!bucketName) return []
      const rawRemaining = bucket.remaining_fraction
      const remainingFraction = typeof rawRemaining === 'number' && Number.isFinite(rawRemaining) && rawRemaining >= 0 && rawRemaining <= 1 ? rawRemaining : null
      const rawReset = bucket.reset_time
      const resetAt = typeof rawReset === 'string' && Number.isFinite(Date.parse(rawReset)) ? rawReset : null
      const window = safeLabel(bucket.window, 'unspecified')
      const description = typeof bucket.description === 'string' && bucket.description.trim() ? bucket.description.trim().slice(0, 240) : undefined
      return [{ id: safeLabel(bucket.id, `${groupIndex}-${bucketIndex}`).slice(0, 180), name: bucketName, window, remainingFraction, resetAt, ...(description ? { description } : {}) }]
    })
    const description = typeof group.description === 'string' && group.description.trim() ? group.description.trim().slice(0, 240) : undefined
    return [{ id, name, ...(description ? { description } : {}), buckets }]
  })
  if (!groups.length || !groups.some(group => group.buckets.length)) throw new Error('Antigravity returned no structured quota buckets.')
  return { fetchedAt, groups, creditsRemaining: null, useG1Credits: null }
}

function parseAntigravityCommandOutput(output: unknown, expectedName: string): Record<string, unknown> {
  if (!output || typeof output !== 'object') throw new Error('Antigravity returned an invalid structured response.')
  const envelope = output as StructuredCommand
  if (envelope.status !== 'SUCCESS' || !envelope.command || envelope.command.name !== expectedName || !envelope.command.data || typeof envelope.command.data !== 'object') {
    throw new Error('Antigravity did not return the expected structured command result.')
  }
  return envelope.command.data as Record<string, unknown>
}

function parseCreditBalance(data: Record<string, unknown>): number | null {
  const value = data.remaining_credits
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function parseOverageSetting(data: Record<string, unknown>): boolean | null {
  const config = data.config
  if (!config || typeof config !== 'object') return null
  const value = (config as Record<string, unknown>).useG1Credits
  return typeof value === 'boolean' ? value : null
}

const effortValues = new Set<ReasoningEffort>(['low', 'medium', 'high', 'xhigh', 'max'])
function effortTier(value: unknown): ReasoningEffort | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim().toLowerCase().replace(/[ _-]+/g, '')
  if (normalized === 'low') return 'low'
  if (normalized === 'medium') return 'medium'
  if (normalized === 'high') return 'high'
  if (normalized === 'xhigh' || normalized === 'extra' || normalized === 'extrahigh') return 'xhigh'
  if (normalized === 'max' || normalized === 'maximum') return 'max'
}
function optionValues(option: Record<string, unknown>): Array<{ value: string; name?: string }> {
  if (!Array.isArray(option.options)) return []
  return option.options.flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const entry = item as Record<string, unknown>
    if (typeof entry.value === 'string') return [{ value: entry.value, ...(typeof entry.name === 'string' ? { name: entry.name } : {}) }]
    return optionValues(entry)
  })
}
type AntigravityEffortSetting = { id: string; values: Partial<Record<ReasoningEffort, string>>; defaultEffort?: ReasoningEffort }
function effortOption(configOptions: unknown[], modelId?: string): AntigravityEffortSetting | undefined {
  if (!Array.isArray(configOptions)) return undefined
  const setting = configOptions.find((entry) => {
    if (!entry || typeof entry !== 'object') return false
    const option = entry as Record<string, unknown>
    const descriptor = `${option.id ?? ''} ${option.category ?? ''} ${option.name ?? ''}`
    if (!/(?:effort|thinking|reasoning)/i.test(descriptor)) return false
    const scopedModel = option.modelId ?? option.model
    return typeof scopedModel !== 'string' || !modelId || scopedModel === modelId
  }) as Record<string, unknown> | undefined
  const values: Partial<Record<ReasoningEffort, string>> = {}
  const collect = (raw: unknown) => {
    const entries = Array.isArray(raw) ? raw : []
    for (const item of entries) {
      const entry = typeof item === 'string' ? { value: item, name: item } : item && typeof item === 'object' ? item as Record<string, unknown> : undefined
      if (!entry) continue
      const exact = typeof entry.value === 'string' ? entry.value : typeof entry.id === 'string' ? entry.id : undefined
      const tier = effortTier(exact) ?? effortTier(entry.name)
      if (exact && tier && effortValues.has(tier)) values[tier] = exact
    }
  }
  if (setting) collect(optionValues(setting))
  // Only expose effort controls backed by an actual ACP config option. Model
  // metadata alone is not enough to invent a set_config_option identifier.
  if (!setting || typeof setting.id !== 'string' || !Object.keys(values).length) return undefined
  const defaultEntry = Object.entries(values).find(([, exact]) => exact === setting.currentValue)
  return { id: setting.id, values, ...(defaultEntry ? { defaultEffort: defaultEntry[0] as ReasoningEffort } : {}) }
}
export function parseAntigravityModelEfforts(configOptions: unknown[], modelId?: string): Record<string, ReasoningEffort[]> {
  const models = parseAntigravityModels(configOptions)
  const result: Record<string, ReasoningEffort[]> = {}
  const modelOption = configOptions.find((entry) => entry && typeof entry === 'object' && (entry as Record<string, unknown>).id === 'model') as Record<string, unknown> | undefined
  const selectedModel = modelId ?? modelOption?.currentValue
  if (typeof selectedModel !== 'string' || !models.some(model => model.id === selectedModel)) return result
  const setting = effortOption(configOptions, selectedModel)
  if (setting) result[selectedModel] = ['auto', ...(['low', 'medium', 'high', 'xhigh', 'max'] as const).filter(effort => !!setting.values[effort])]
  return result
}
export function parseAntigravityModelEffortDefaults(configOptions: unknown[], modelId?: string): Record<string, ReasoningEffort> {
  const modelOption = configOptions.find((entry) => entry && typeof entry === 'object' && (entry as Record<string, unknown>).id === 'model') as Record<string, unknown> | undefined
  const selectedModel = modelId ?? modelOption?.currentValue
  if (typeof selectedModel !== 'string' || !parseAntigravityModels(configOptions).some(model => model.id === selectedModel)) return {}
  const defaultEffort = effortOption(configOptions, selectedModel)?.defaultEffort
  return defaultEffort ? { [selectedModel]: defaultEffort } : {}
}
export function antigravityEffortSetting(configOptions: unknown[], modelId: string): AntigravityEffortSetting | undefined {
  return effortOption(configOptions, modelId)
}

export class AntigravityACPClient {
  private child: ChildProcessWithoutNullStreams
  private lines
  private nextId = 1
  private pending = new Map<number, RpcPending>()
  private pendingPermissions = new Set<RpcId>()
  private toolProgress = new Map<string, string>()
  private closed = false
  private stderr = ''
  onMessage?: (message: RpcMessage) => void

  constructor(command: string, cwd: string, private readonly signal?: AbortSignal) {
    // These are documented Google CLI flags. Keep its native runtime and
    // credential handling intact, with terminal commands sandboxed.
    this.child = spawn(command, ['acp', '--disable-telemetry', '--sandbox'], { cwd, env: antigravityEnvironment(process.env), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false })
    this.lines = createInterface({ input: this.child.stdout })
    this.lines.on('line', line => this.receive(line))
    this.child.stderr.on('data', (chunk: Buffer) => { this.stderr = (this.stderr + chunk.toString()).slice(-2048) })
    this.child.once('error', error => { log('ai.antigravity_process', { stage: 'start-failed', errorCode: (error as NodeJS.ErrnoException).code ?? 'unknown' }); this.fail(new Error(`Antigravity ACP could not start (${(error as NodeJS.ErrnoException).code ?? 'unknown'}).`)) })
    this.child.once('exit', (code, signal) => {
      const diagnostic = this.stderr ? safeACPMessage(this.stderr) : ''
      log('ai.antigravity_process', { stage: 'exited', exitCode: code ?? -1, signal: signal ?? 'none', ...(diagnostic ? { diagnostic } : {}) })
      this.fail(new Error(diagnostic || (code === 0 ? 'Antigravity ACP exited.' : `Antigravity ACP exited with code ${code ?? 'unknown'}.`)))
    })
    this.signal?.addEventListener('abort', this.abort, { once: true })
    if (this.signal?.aborted) this.abort()
  }
  private abort = () => { void this.close() }
  private receive(line: string) {
    let message: RpcMessage
    try { message = JSON.parse(line) as RpcMessage } catch { return }
    if (typeof message.id === 'number' && !message.method) {
      const entry = this.pending.get(message.id)
      if (!entry) return
      this.pending.delete(message.id); entry.deadline.clear()
      if (message.error) {
        const diagnostic = safeACPMessage(message.error.message ?? '')
        log('ai.antigravity_rpc_error', { requestId: message.id, errorCode: message.error.code ?? 0, diagnostic })
        entry.reject(new Error(`Antigravity ACP error ${message.error.code ?? 'unknown'}: ${diagnostic}`))
      }
      else entry.resolve(message.result ?? {})
      return
    }
    if (message.method === 'session/request_permission' && (typeof message.id === 'number' || typeof message.id === 'string')) {
      this.pendingPermissions.add(message.id)
      for (const entry of this.pending.values()) entry.deadline.pause()
    } else if (antigravityMeaningfulACPUpdate(message)) {
      const update = message.params?.update as Record<string, unknown> | undefined
      const id = typeof update?.toolCallId === 'string' ? update.toolCallId : undefined
      const progress = update ? antigravityToolProgressKey(update) : ''
      if (!id || this.toolProgress.get(id) !== progress) {
        if (id) this.toolProgress.set(id, progress)
        for (const entry of this.pending.values()) entry.refresh?.()
      }
    }
    this.onMessage?.(message)
  }
  private fail(error: Error) {
    if (this.closed) return
    for (const entry of this.pending.values()) { entry.deadline.clear(); entry.reject(error) }
    this.pending.clear(); this.close()
  }
  request(method: string, params: Record<string, unknown>, timeoutMs = 60_000, progressAware = false): Promise<Record<string, unknown>> {
    if (this.closed) return Promise.reject(new Error('Antigravity ACP session is no longer active.'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const deadline = new ProgressDeadline(timeoutMs, () => { this.pending.delete(id); reject(new Error(`Antigravity ACP ${method} was inactive for ${Math.round(timeoutMs / 1000)} seconds.`)); void this.close() })
      this.pending.set(id, { resolve, reject, deadline, ...(progressAware ? { refresh: () => deadline.touch() } : {}) })
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`, error => {
        if (error) { deadline.clear(); this.pending.delete(id); reject(new Error('Antigravity ACP connection closed.')) }
      })
    })
  }
  respond(id: RpcId, result: Record<string, unknown>) {
    if (!this.closed) this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`)
    if (this.pendingPermissions.delete(id) && !this.pendingPermissions.size) for (const entry of this.pending.values()) entry.deadline.resume()
  }
  notify(method: string, params: Record<string, unknown> = {}) {
    if (!this.closed) this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
  }
  async close() {
    if (this.closed) return
    this.closed = true
    this.signal?.removeEventListener('abort', this.abort)
    this.lines.close()
    for (const entry of this.pending.values()) { entry.deadline.clear(); entry.reject(new Error('Antigravity ACP session closed.')) }
    this.pending.clear(); this.child.stdin.end()
    if (!this.child.killed) this.child.kill('SIGTERM')
  }
}

const blank = (message: string, installed = false, version: string | null = null): AntigravityStatus => ({ installed, version, authState: 'unknown', identity: null, models: [], modelEfforts: {}, modelEffortDefaults: {}, modelCatalogAvailable: false, usage: null, usageError: null, message })

export class AntigravityACPService {
  private command: string | null | undefined
  private version: string | null = null
  private authState: AntigravityStatus['authState'] = 'unknown'
  private authMethod: AntigravityStatus['authMethod'] = null
  private models: AntigravityModel[] = []
  private modelEfforts: Record<string, ReasoningEffort[]> = {}
  private modelEffortDefaults: Record<string, ReasoningEffort> = {}
  private modelEffortSettings: Record<string, AntigravityEffortSetting> = {}
  private configOptions: unknown[] = []
  private busy = 0
  private catalogPromise: Promise<{ status: AntigravityStatus; configOptions: unknown[] }> | null = null
  private cacheLoading: Promise<void> | null = null
  private cacheLoaded = false
  private discoveryChecked = false
  private lastCheckedAt: number | null = null
  private usage: AntigravityUsageSnapshot | null = null
  private usageError: string | null = null
  private usagePromise: Promise<void> | null = null
  private authGeneration = 0
  constructor(private readonly userData: string) {}

  private async findCommand(): Promise<string | null> {
    const env = antigravityEnvironment(process.env)
    const directories = [...(env.PATH ?? '').split(delimiter), join(homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin']
    for (const directory of [...new Set(directories.filter(Boolean))]) {
      const candidate = join(directory, process.platform === 'win32' ? 'agy.exe' : 'agy')
      try { await access(candidate, constants.X_OK); if ((await stat(await realpath(candidate))).isFile()) return await realpath(candidate) } catch { /* keep searching documented CLI locations */ }
    }
    return null
  }
  private async discover(): Promise<string | null> {
    this.command = await this.findCommand()
    this.discoveryChecked = true
    if (!this.command) { this.version = null; this.authState = 'unknown'; this.authMethod = null; this.models = []; this.modelEfforts = {}; this.modelEffortDefaults = {}; this.modelEffortSettings = {}; this.lastCheckedAt = Date.now(); await this.persistCache(); return null }
    try {
      const { stdout, stderr } = await run(this.command, ['--version'], { cwd: homedir(), env: antigravityEnvironment(process.env), timeout: 10_000, maxBuffer: 8192, windowsHide: true })
      this.version = `${stdout}\n${stderr}`.match(/\b\d+\.\d+\.\d+(?:[-+][\w.-]+)?\b/)?.[0] ?? 'Installed; version unavailable'
    } catch { this.version = 'Installed; version unavailable' }
    this.lastCheckedAt = Date.now()
    await this.persistCache()
    return this.command
  }
  private get cachePath(): string { return join(this.userData, 'antigravity-status.json') }
  private async loadCache(): Promise<void> {
    if (this.cacheLoaded) return
    if (!this.cacheLoading) this.cacheLoading = (async () => {
      try {
        const raw = JSON.parse(await readFile(this.cachePath, 'utf8')) as Record<string, unknown>
        if (raw.version !== 1) return
        if (typeof raw.command === 'string') this.command = raw.command
        else if (raw.command === null) { this.command = null; this.discoveryChecked = true }
        if (typeof raw.cliVersion === 'string' || raw.cliVersion === null) this.version = raw.cliVersion as string | null
        if (['authenticated', 'unauthenticated', 'unknown'].includes(String(raw.authState))) this.authState = raw.authState as AntigravityStatus['authState']
        if (raw.authMethod === 'oauth-personal') this.authMethod = 'oauth-personal'
        if (Array.isArray(raw.models)) this.models = raw.models.filter((entry): entry is AntigravityModel => Boolean(entry && typeof entry === 'object' && typeof (entry as AntigravityModel).id === 'string' && typeof (entry as AntigravityModel).name === 'string'))
        if (raw.modelEfforts && typeof raw.modelEfforts === 'object') this.modelEfforts = raw.modelEfforts as Record<string, ReasoningEffort[]>
        if (raw.modelEffortDefaults && typeof raw.modelEffortDefaults === 'object') this.modelEffortDefaults = raw.modelEffortDefaults as Record<string, ReasoningEffort>
        if (typeof raw.lastCheckedAt === 'number') this.lastCheckedAt = raw.lastCheckedAt
        if (raw.usage && typeof raw.usage === 'object' && Array.isArray((raw.usage as AntigravityUsageSnapshot).groups)) this.usage = raw.usage as AntigravityUsageSnapshot
        if (typeof raw.usageError === 'string' || raw.usageError === null) this.usageError = raw.usageError as string | null
        this.discoveryChecked = this.discoveryChecked || typeof raw.lastCheckedAt === 'number'
      } catch { /* First launch or an absent cache. */ }
      this.cacheLoaded = true
    })().finally(() => { this.cacheLoading = null })
    await this.cacheLoading
  }
  private async persistCache(): Promise<void> {
    try {
      await mkdir(this.userData, { recursive: true, mode: 0o700 })
      await writeFile(this.cachePath, JSON.stringify({ version: 1, command: this.command ?? null, cliVersion: this.version, authState: this.authState, authMethod: this.authMethod,
        models: this.models, modelEfforts: this.modelEfforts, modelEffortDefaults: this.modelEffortDefaults, usage: this.usage, usageError: this.usageError,
        lastCheckedAt: this.lastCheckedAt }), { mode: 0o600 })
    } catch { /* Cached state is best-effort; live authentication remains authoritative for requests. */ }
  }
  async status(): Promise<AntigravityStatus> {
    await this.loadCache()
    if (this.busy) return { ...blank('Antigravity ACP is handling a request.', Boolean(this.command), this.version), authState: this.authState, authMethod: this.authMethod, models: [...this.models], modelEfforts: structuredClone(this.modelEfforts), modelEffortDefaults: { ...this.modelEffortDefaults }, modelCatalogAvailable: this.models.length > 0, usage: this.usage, usageError: this.usageError, lastCheckedAt: this.lastCheckedAt }
    if (!this.discoveryChecked) await this.discover()
    const message = !this.command ? 'Official Antigravity CLI (agy) was not found. Install it from Google’s official CLI documentation, then check again.'
      : this.authState === 'authenticated' ? 'Antigravity ACP is connected. The Google account and subscription remain managed by Antigravity.'
        : 'Official Antigravity ACP is installed. Connect through its native Google sign-in to verify the account.'
    return { ...blank(message, Boolean(this.command), this.version), authState: this.authState, authMethod: this.authMethod, models: [...this.models], modelEfforts: structuredClone(this.modelEfforts), modelEffortDefaults: { ...this.modelEffortDefaults }, modelCatalogAvailable: this.models.length > 0, usage: this.usage, usageError: this.usageError, lastCheckedAt: this.lastCheckedAt }
  }

  /** Runs only Google's documented, read-only structured CLI commands. Output is never logged or persisted. */
  private async structuredCommand(name: 'usage' | 'credits' | 'config'): Promise<Record<string, unknown>> {
    const command = this.command ?? await this.discover()
    if (!command) throw new Error('Antigravity CLI is not installed.')
    try {
      const { stdout } = await run(command, ['-p', `/${name}`, '--output-format', 'json'], {
        cwd: homedir(), env: antigravityEnvironment(process.env), timeout: 30_000, maxBuffer: 512 * 1024, windowsHide: true,
      })
      let parsed: unknown
      try { parsed = JSON.parse(stdout) } catch { throw new Error('Antigravity did not return structured JSON.') }
      return parseAntigravityCommandOutput(parsed, name)
    } catch (error) {
      if (error instanceof Error && /Antigravity (?:did not return|returned|CLI is)/i.test(error.message)) throw error
      const stderr = error && typeof error === 'object' && 'stderr' in error ? String((error as { stderr?: unknown }).stderr ?? '') : ''
      const message = `${error instanceof Error ? error.message : ''} ${stderr}`
      if (/auth|credential|sign.?in|login|unauthorized/i.test(message)) throw new Error('Antigravity sign-in is required.')
      throw new Error('Antigravity structured usage command failed.')
    }
  }

  async refreshUsage(): Promise<AntigravityStatus> {
    if (this.usagePromise) { await this.usagePromise; return this.status() }
    if (this.authState !== 'authenticated') {
      this.usageError = 'Verify native Google sign-in before loading Antigravity usage.'
      await this.persistCache()
      return this.status()
    }
    const authGeneration = this.authGeneration
    this.usageError = null
    this.usagePromise = (async () => {
      const fetchedAt = Date.now()
      const usageData = await this.structuredCommand('usage')
      const snapshot = parseAntigravityUsageData(usageData, fetchedAt)
      const [creditsResult, configResult] = await Promise.allSettled([this.structuredCommand('credits'), this.structuredCommand('config')])
      snapshot.creditsRemaining = creditsResult.status === 'fulfilled' ? parseCreditBalance(creditsResult.value) : null
      snapshot.useG1Credits = configResult.status === 'fulfilled' ? parseOverageSetting(configResult.value) : null
      if (authGeneration !== this.authGeneration) return
      this.usage = snapshot
      this.usageError = null
      await this.persistCache()
    })().catch(error => {
      if (authGeneration !== this.authGeneration) return
      const authFailure = error instanceof Error && /sign-in is required|authentication required|not authenticated|not signed in/i.test(error.message)
      if (authFailure) {
        this.authState = 'unauthenticated'
        this.authMethod = null
        this.models = []; this.modelEfforts = {}; this.modelEffortDefaults = {}; this.modelEffortSettings = {}; this.configOptions = []
        this.usageError = 'Antigravity sign-in has expired or is unavailable. Reconnect through the official Antigravity sign-in flow.'
      } else {
        this.usageError = error instanceof Error && error.message.startsWith('Antigravity ') ? error.message : 'Antigravity usage could not be refreshed.'
      }
      return this.persistCache()
    }).finally(() => { this.usagePromise = null })
    await this.usagePromise
    return this.status()
  }

  async aiStatus(workspaceRoot?: string): Promise<AIResult> {
    if (workspaceRoot && this.authState === 'unknown' && !this.busy) {
      try { await this.refreshCatalog(workspaceRoot) }
      catch (error) {
        const value = await this.status()
        return { ok: false, message: error instanceof ChatError ? error.userMessage : 'Antigravity ACP status could not be verified.', status: { ...emptyAIStatus(), provider: 'Google Antigravity Subscription', active: false, hasKey: false, model: null, models: value.models.map(entry => entry.id), modelLabels: Object.fromEntries(value.models.map(entry => [entry.id, entry.name])), modelEfforts: value.modelEfforts, modelEffortDefaults: value.modelEffortDefaults, modelCatalogAvailable: value.modelCatalogAvailable, connection: 'failed', lastVerifiedAt: Date.now() } }
      }
    }
    const value = await this.status()
    const active = value.authState === 'authenticated'
    return { ok: active, message: value.message, status: { ...emptyAIStatus(), provider: 'Google Antigravity Subscription', active, hasKey: false,
      model: value.models[0]?.id ?? null, models: value.models.map(model => model.id), modelLabels: Object.fromEntries(value.models.map(model => [model.id, model.name])), modelEfforts: value.modelEfforts, modelEffortDefaults: value.modelEffortDefaults,
      modelCatalogAvailable: value.modelCatalogAvailable, connection: active ? 'successful' : value.authState === 'unauthenticated' ? 'failed' : 'not-tested',
      lastVerifiedAt: active ? Date.now() : null } }
  }
  private async start(cwd: string, signal?: AbortSignal, executionId?: string): Promise<{ client: AntigravityACPClient; initialize: Record<string, unknown> }> {
    const command = this.command ?? await this.discover()
    if (!command) throw new ChatError('Official Antigravity CLI (agy) is not installed. Install it using Google’s official documentation. Athena did not use another provider.')
    const started = performance.now()
    if (executionId) log('ai.antigravity_execution', { executionId, stage: 'acp-starting', acpArgs: 'acp --disable-telemetry --sandbox', workspace: cwd.split('/').at(-1) ?? 'project' })
    const client = new AntigravityACPClient(command, cwd, signal)
    try {
      const initialize = await client.request('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: 'Athena AI', version: appVersion() } }, 20_000)
      if (executionId) log('ai.antigravity_execution', { executionId, stage: 'acp-initialized', durationMs: Math.round(performance.now() - started) })
      client.notify('initialized')
      return { client, initialize }
    } catch (error) { await client.close(); throw this.mapError(error) }
  }
  async login(): Promise<AntigravityStatus> {
    if (this.busy) throw new ChatError('Wait for the active Antigravity request to finish before changing sign-in.')
    this.authGeneration++
    this.usage = null; this.usageError = null
    this.authMethod = null
    this.authState = 'unknown'; this.models = []; this.modelEfforts = {}; this.modelEffortDefaults = {}; this.modelEffortSettings = {}; this.configOptions = []
    const { client, initialize } = await this.start(homedir())
    try {
      const methods = Array.isArray(initialize.authMethods) ? initialize.authMethods as Array<Record<string, unknown>> : []
      if (!methods.some(method => method.id === 'oauth-personal')) throw new ChatError('This Antigravity ACP version does not advertise native personal Google sign-in. No credentials were read or sent.')
      await client.request('authenticate', { methodId: 'oauth-personal' }, 300_000)
      this.authState = 'authenticated'
      this.authMethod = 'oauth-personal'
      this.models = []
      this.modelEfforts = {}
      this.modelEffortDefaults = {}
      this.modelEffortSettings = {}
      this.lastCheckedAt = Date.now()
      await this.persistCache()
      return await this.status()
    } catch (error) { this.authState = 'unknown'; this.authMethod = null; this.models = []; this.modelEfforts = {}; this.modelEffortDefaults = {}; this.modelEffortSettings = {}; this.configOptions = []; await this.persistCache(); throw this.mapError(error) }
    finally { await client.close() }
  }
  async logout(): Promise<AntigravityStatus> {
    if (this.busy) throw new ChatError('Wait for the active Antigravity request to finish before signing out.')
    this.authGeneration++
    const command = this.command ?? await this.discover()
    if (!command) return await this.status()
    if (process.platform !== 'darwin') return { ...(await this.status()), message: 'Open Antigravity CLI, enter /logout, then refresh this connection. Athena does not handle Google credentials.' }
    await mkdir(this.userData, { recursive: true, mode: 0o700 })
    const path = join(this.userData, 'manage-antigravity-account.command')
    const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`
    await writeFile(path, `#!/bin/sh\nexec ${quote(command)}\n`, { mode: 0o700 })
    const result = await shell.openPath(path)
    if (result) throw new ChatError('Could not open the official Antigravity CLI in Terminal. Run `agy` and enter `/logout`, then refresh Athena.')
    this.authState = 'unknown'; this.authMethod = null; this.models = []; this.modelEfforts = {}; this.modelEffortDefaults = {}; this.modelEffortSettings = {}; this.usage = null; this.usageError = null
    this.lastCheckedAt = Date.now(); await this.persistCache()
    return { ...(await this.status()), message: 'Antigravity CLI opened in Terminal. Enter /logout there, then refresh Athena. No token was accessed by Athena.' }
  }
  async commandAction(input: AntigravityCommand, workspaceRoot?: string): Promise<AntigravityStatus> {
    if (input.action === 'login') {
      const current = await this.status()
      if (!current.installed) return current
      this.usage = null; this.usageError = null; await this.persistCache()
      await this.login()
      if (workspaceRoot) return this.refreshCatalog(workspaceRoot)
      return this.status()
    }
    if (input.action === 'logout') return this.logout()
    if (input.action === 'refresh') {
      await this.discover()
      const current = await this.status()
      if (!current.installed || !workspaceRoot) return current
      return this.refreshCatalog(workspaceRoot)
    }
    if (input.action === 'usage') return this.refreshUsage()
    return this.status()
  }
  private async refreshCatalog(workspaceRoot: string): Promise<AntigravityStatus> {
    try {
      const result = await this.catalog(workspaceRoot)
      this.lastCheckedAt = Date.now()
      await this.persistCache()
      return result.status
    }
    catch (error) {
      if (/authentication required|not authenticated|not signed in|oauth/i.test(error instanceof Error ? error.message : '')) {
        this.authState = 'unauthenticated'; this.authMethod = null; this.models = []; this.modelEfforts = {}; this.modelEffortDefaults = {}; this.modelEffortSettings = {}; this.usageError = 'Antigravity sign-in is required to read quota data.'
        await this.persistCache()
        return { ...(await this.status()), message: 'Antigravity ACP is installed but requires Google sign-in. No credentials were read or sent by Athena.' }
      }
      throw error
    }
  }
  async catalog(cwd: string): Promise<{ status: AntigravityStatus; configOptions: unknown[] }> {
    if (this.catalogPromise) return this.catalogPromise
    if (this.busy) return { status: await this.status(), configOptions: [...this.configOptions] }
    this.catalogPromise = this.loadCatalog(cwd)
    try { return await this.catalogPromise }
    finally { this.catalogPromise = null }
  }
  private async loadCatalog(cwd: string): Promise<{ status: AntigravityStatus; configOptions: unknown[] }> {
    const root = resolve(cwd)
    const canonical = await realpath(root).catch(() => null)
    if (!canonical || canonical !== root) throw new ChatError('The authorized Antigravity workspace is missing or is not a canonical directory.')
    const { client } = await this.start(root)
    let sessionId: string | undefined
    try {
      const session = await client.request('session/new', { cwd: root, mcpServers: [] }, 90_000)
      if (typeof session.sessionId !== 'string') throw new ChatError('Antigravity ACP did not return a valid session. No prompt was sent.')
      sessionId = session.sessionId
      const configOptions = Array.isArray(session.configOptions) ? session.configOptions : []
      const models = parseAntigravityModels(configOptions)
      const modelOption = configOptions.find((entry) => entry && typeof entry === 'object' && (entry as Record<string, unknown>).id === 'model') as Record<string, unknown> | undefined
      const efforts: Record<string, ReasoningEffort[]> = {}
      const effortSettings: AntigravityACPService['modelEffortSettings'] = {}
      const effortDefaults: Record<string, ReasoningEffort> = {}
      for (const model of models) {
        let optionsForModel = configOptions
        let selectedValue = modelOption?.currentValue
        if (modelOption && selectedValue !== model.id) {
          try {
            const result = await client.request('session/set_config_option', { sessionId, configId: 'model', value: model.id }, 20_000)
            const returned = Array.isArray(result.configOptions) ? result.configOptions : []
            if (!returned.length) continue
            optionsForModel = returned
            const current = returned.find((entry) => entry && typeof entry === 'object' && (entry as Record<string, unknown>).id === 'model') as Record<string, unknown> | undefined
            selectedValue = current?.currentValue
          } catch {
            // A model advertised by the runtime remains available even when
            // its optional reasoning configuration cannot be queried.
            continue
          }
        }
        if (selectedValue === model.id) {
          Object.assign(efforts, parseAntigravityModelEfforts(optionsForModel, model.id))
          const setting = antigravityEffortSetting(optionsForModel, model.id)
          if (setting) {
            effortSettings[model.id] = setting
            if (setting.defaultEffort) effortDefaults[model.id] = setting.defaultEffort
          }
        }
      }
      this.authState = 'authenticated'; this.authMethod = 'oauth-personal'; this.models = models; this.modelEfforts = efforts; this.modelEffortDefaults = effortDefaults; this.modelEffortSettings = effortSettings; this.configOptions = configOptions
      this.lastCheckedAt = Date.now()
      await this.persistCache()
      return { status: await this.status(), configOptions }
    } catch (error) {
      this.authState = /auth|credential|sign.?in|login/i.test(error instanceof Error ? error.message : '') ? 'unauthenticated' : this.authState
      if (this.authState === 'unauthenticated') { this.authMethod = null; this.models = []; this.modelEfforts = {}; this.modelEffortDefaults = {}; this.modelEffortSettings = {}; this.configOptions = []; await this.persistCache() }
      throw this.mapError(error)
    } finally {
      if (sessionId) await client.request('session/close', { sessionId }, 10_000).catch(() => {})
      await client.close()
    }
  }
  async connect(cwd: string, signal?: AbortSignal, executionId?: string): Promise<{ client: AntigravityACPClient; sessionId: string; models: AntigravityModel[]; configOptions: unknown[] }> {
    const { client } = await this.start(cwd, signal, executionId)
    try {
      const sessionStarted = performance.now()
      const session = await client.request('session/new', { cwd, mcpServers: [] }, 90_000)
      if (executionId) log('ai.antigravity_execution', { executionId, stage: 'acp-session-created', sessionId: typeof session.sessionId === 'string' ? session.sessionId : 'invalid', durationMs: Math.round(performance.now() - sessionStarted) })
      if (typeof session.sessionId !== 'string') throw new ChatError('Antigravity ACP did not return a valid session. No prompt was sent.')
      const configOptions = Array.isArray(session.configOptions) ? session.configOptions : []
      const models = parseAntigravityModels(configOptions)
      this.authState = 'authenticated'; this.authMethod = 'oauth-personal'; this.models = models; this.configOptions = configOptions
      this.lastCheckedAt = Date.now()
      await this.persistCache()
      const initialEfforts = parseAntigravityModelEfforts(configOptions)
      if (Object.keys(initialEfforts).length) this.modelEfforts = { ...this.modelEfforts, ...initialEfforts }
      const modelOption = configOptions.find((entry) => entry && typeof entry === 'object' && (entry as Record<string, unknown>).id === 'model') as Record<string, unknown> | undefined
      if (typeof modelOption?.currentValue === 'string') {
        const setting = antigravityEffortSetting(configOptions, modelOption.currentValue)
        if (setting) {
          this.modelEffortSettings = { ...this.modelEffortSettings, [modelOption.currentValue]: setting }
          if (setting.defaultEffort) this.modelEffortDefaults = { ...this.modelEffortDefaults, [modelOption.currentValue]: setting.defaultEffort }
        }
      }
      return { client, sessionId: session.sessionId, models, configOptions }
    } catch (error) {
      this.authState = /auth|credential|sign.?in|login/i.test(error instanceof Error ? error.message : '') ? 'unauthenticated' : this.authState
      if (this.authState === 'unauthenticated') { this.authMethod = null; this.models = []; this.modelEfforts = {}; this.modelEffortDefaults = {}; this.modelEffortSettings = {}; this.configOptions = []; await this.persistCache() }
      await client.close(); throw this.mapError(error)
    }
  }
  acquireRequest(): () => void {
    this.busy++
    let released = false
    return () => {
      if (released) return
      released = true
      this.busy = Math.max(0, this.busy - 1)
    }
  }
  supportsEffortCached(modelId: string, effort: ReasoningEffort): boolean {
    if (effort === 'auto') return true
    return this.modelEfforts[modelId]?.includes(effort) ?? false
  }
  effortSettingCached(modelId: string): AntigravityEffortSetting | undefined {
    const setting = this.modelEffortSettings[modelId]
    return setting ? { id: setting.id, values: { ...setting.values } } : undefined
  }
  observeModelConfiguration(modelId: string, configOptions: unknown[], captureRuntimeDefault = true): void {
    const discovered = parseAntigravityModelEfforts(configOptions, modelId)[modelId]
    const setting = antigravityEffortSetting(configOptions, modelId)
    if (discovered) this.modelEfforts = { ...this.modelEfforts, [modelId]: discovered }
    else {
      const { [modelId]: _stale, ...rest } = this.modelEfforts
      this.modelEfforts = rest
    }
    if (setting) {
      this.modelEffortSettings = { ...this.modelEffortSettings, [modelId]: setting }
      if (captureRuntimeDefault && setting.defaultEffort) this.modelEffortDefaults = { ...this.modelEffortDefaults, [modelId]: setting.defaultEffort }
      else if (captureRuntimeDefault) {
        const { [modelId]: _staleDefault, ...defaults } = this.modelEffortDefaults
        this.modelEffortDefaults = defaults
      }
    }
    else {
      const { [modelId]: _stale, ...rest } = this.modelEffortSettings
      this.modelEffortSettings = rest
      const { [modelId]: _staleDefault, ...defaults } = this.modelEffortDefaults
      this.modelEffortDefaults = defaults
    }
    this.configOptions = configOptions
  }
  observeRuntimeConfiguration(configOptions: unknown[]): void {
    const models = parseAntigravityModels(configOptions)
    if (models.length) {
      const validIds = new Set(models.map(model => model.id))
      this.models = models
      this.modelEfforts = Object.fromEntries(Object.entries(this.modelEfforts).filter(([id]) => validIds.has(id)))
      this.modelEffortDefaults = Object.fromEntries(Object.entries(this.modelEffortDefaults).filter(([id]) => validIds.has(id)))
      this.modelEffortSettings = Object.fromEntries(Object.entries(this.modelEffortSettings).filter(([id]) => validIds.has(id)))
    }
    const selected = configOptions.find((entry) => entry && typeof entry === 'object' && (entry as Record<string, unknown>).id === 'model') as Record<string, unknown> | undefined
    if (typeof selected?.currentValue === 'string') this.observeModelConfiguration(selected.currentValue, configOptions)
  }
  private mapError(error: unknown): ChatError {
    const message = error instanceof Error ? error.message : ''
    if (/unsupported Antigravity ACP flag/i.test(message)) return new ChatError(`${message}. Update the Antigravity ACP configuration; no prompt was sent.`)
    if (/Antigravity ACP error -32000: Authentication required/i.test(message)) return new ChatError('Antigravity requires a native Google sign-in. Open Settings → AI → Google Antigravity and choose Sign in with Google. No prompt was sent.')
    if (/Antigravity ACP error -?\d+:/.test(message)) return new ChatError(`${message} No prompt was sent; inspect the Antigravity connection and retry.`)
    if (/authentication required|not authenticated|not signed in|oauth/i.test(message)) return new ChatError('Antigravity requires a native Google sign-in. Open Settings → AI → Google Antigravity and choose Sign in with Google. No prompt was sent.')
    if (/quota|rate.?limit|usage|subscription|entitlement/i.test(message)) return new ChatError('Antigravity reported an account limit or unavailable subscription entitlement. Check the limits shown by Antigravity; Athena did not switch providers.')
    if (/timed out/i.test(message)) return new ChatError('Antigravity ACP timed out. Check that the official CLI is available and retry.')
    return error instanceof ChatError ? error : new ChatError('The official Antigravity ACP could not complete this operation. Check its installation, native sign-in, workspace trust, and plan access. Athena did not use another provider.')
  }
}

/** Isolated empty workspace for ordinary Antigravity chat when no project is attached. */
export class AntigravityGeneralWorkspace {
  private readonly root: string
  constructor(userData: string) { this.root = resolve(userData, 'antigravity-general-chat') }
  async authorize(): Promise<{ root: string; assertAccess(): Promise<void> }> {
    try {
      await mkdir(this.root, { recursive: true, mode: 0o700 })
      await chmod(this.root, 0o700)
      const info = await lstat(this.root)
      if (!info.isDirectory() || info.isSymbolicLink() || await realpath(this.root) !== this.root) throw new Error('Workspace changed')
      const assertAccess = async () => {
        const current = await lstat(this.root)
        if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== info.dev || current.ino !== info.ino || await realpath(this.root) !== this.root) throw new ChatError('Athena’s private Antigravity workspace changed or is unavailable. No external project was accessed.')
      }
      return { root: this.root, assertAccess }
    } catch (error) { throw error instanceof ChatError ? error : new ChatError('Athena could not prepare its private Antigravity chat workspace.') }
  }
}

function appVersion(): string { return app.getVersion() }
