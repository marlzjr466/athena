import { CopilotCLIAuth } from './copilotCLIAuth'
import { app, shell } from 'electron'
import { CopilotClient, RuntimeConnection } from '@github/copilot-sdk'
import { credentialEntry } from './secureCredentialEntry'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { CopilotCommand, CopilotStatus, CopilotUsageQuota, CopilotUsageSnapshot } from '../../../shared/copilot'
import type { AIResult } from '../../../shared/ai'
import { ChatError } from './AIProvider'

const accountSchema = z.object({ id: z.string(), login: z.string(), enabled: z.boolean(), kind: z.enum(['oauth','cli']), token: z.string().optional() }).refine(a => a.kind !== 'oauth' || Boolean(a.token?.match(/^(gho_|ghu_)/)), 'OAuth token required')
const stateSchema = z.object({ accounts: z.array(accountSchema).max(20), activeId: z.string().nullable() })
type StoredQuota = { accountId: string; snapshot: CopilotUsageSnapshot | null; error: string | null }
export function parseCopilotUsage(accountId: string, input: unknown, fetchedAt = Date.now()): CopilotUsageSnapshot {
  const snapshots = input && typeof input === 'object' && 'quotaSnapshots' in input ? (input as { quotaSnapshots?: unknown }).quotaSnapshots : null
  if (!snapshots || typeof snapshots !== 'object' || Array.isArray(snapshots)) throw new ChatError('GitHub Copilot did not return structured account quota data.')
  const quotas = Object.entries(snapshots as Record<string, unknown>).flatMap(([id, raw]) => {
    if (!raw || typeof raw !== 'object') return []
    const value = raw as Record<string, unknown>
    const finite = (key: string) => typeof value[key] === 'number' && Number.isFinite(value[key]) ? value[key] as number : null
    const remainingRaw = finite('remainingPercentage')
    const resetRaw = value.resetDate
    const resetDate = typeof resetRaw === 'string' && Number.isFinite(Date.parse(resetRaw)) ? resetRaw : null
    const label = id.split('_').map(part => part ? part[0].toUpperCase() + part.slice(1) : part).join(' ')
    return [{ id, name: label, isUnlimitedEntitlement: typeof value.isUnlimitedEntitlement === 'boolean' ? value.isUnlimitedEntitlement : null,
      entitlementRequests: finite('entitlementRequests'), usedRequests: finite('usedRequests'), remainingPercentage: remainingRaw !== null && remainingRaw >= 0 && remainingRaw <= 100 ? remainingRaw : null,
      resetDate, usageAllowedWithExhaustedQuota: typeof value.usageAllowedWithExhaustedQuota === 'boolean' ? value.usageAllowedWithExhaustedQuota : null,
      overage: finite('overage'), overageAllowedWithExhaustedQuota: typeof value.overageAllowedWithExhaustedQuota === 'boolean' ? value.overageAllowedWithExhaustedQuota : null } satisfies CopilotUsageQuota]
  })
  return { accountId, fetchedAt, quotas }
}
/** Explicitly exclude alternate billing and injected runtime configuration. */
export function copilotEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = /^(PATH|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|SystemRoot|WINDIR|TEMP|TMP|TMPDIR|LANG|LC_ALL|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|SSL_CERT_FILE|SSL_CERT_DIR|NODE_EXTRA_CA_CERTS)$/i
  return Object.fromEntries(Object.entries(source).filter(([key]) => allowed.test(key) || ['COPILOT_GITHUB_TOKEN','GH_TOKEN','GITHUB_TOKEN'].includes(key)))
}
export class CopilotService {
  private state: z.infer<typeof stateSchema> = { accounts: [], activeId: null }
  private clients = new Map<string, Promise<CopilotClient>>()
  private aiStatusCache = new Map<string, AIResult>()
  private aiStatusReads = new Map<string, Promise<AIResult | null>>()
  private usageCache = new Map<string, StoredQuota>()
  private usageReads = new Map<string, Promise<StoredQuota | null>>()
  private usageRefreshes = new Map<string, Promise<StoredQuota>>()
  private loading?: Promise<void>
  private commandQueue: Promise<unknown> = Promise.resolve()
  private pending?: { clientId: string; deviceCode: string; code: string; url: string; expiresAt: number; interval: number; nextPoll: number }
  private requests = 0
  private authenticationChanges = 0
  private managing = false
  private readonly cli = new CopilotCLIAuth(() => this.cliEnvironment(), async () => {
    await this.commandQueue
    if (this.cli.status.phase !== 'verifying') return
    await this.connectCLI(() => this.cli.status.phase === 'verifying')
  })
  private cliEnvironment() {
    const env = copilotEnvironment(process.env)
    // Interactive CLI connection means the signed-in user, never an ambient token.
    for (const key of ['COPILOT_GITHUB_TOKEN','GH_TOKEN','GITHUB_TOKEN']) delete env[key]
    return env
  }
  beginRequest() {
    if (this.cli.running || this.managing || this.authenticationChanges) throw new ChatError('Finish or cancel GitHub sign-in before sending a Copilot request.')
    this.requests++
    let released = false
    return () => { if (!released) { released = true; this.requests-- } }
  }
  async shutdown() { await this.cli.cancel(); await this.dispose() }
  private entry: ReturnType<typeof credentialEntry>
  constructor(private root: string) { this.entry = credentialEntry('com.athena.companion.copilot', createHash('sha256').update(root).digest('hex')) }
  private cachePath(kind: 'status' | 'usage', accountId: string): string {
    const accountHash = createHash('sha256').update(accountId).digest('hex').slice(0, 24)
    return join(this.root, `${kind}-${accountHash}.json`)
  }
  private async cachedAIStatus(accountId: string): Promise<AIResult | null> {
    const memory = this.aiStatusCache.get(accountId)
    if (memory) return memory
    let pending = this.aiStatusReads.get(accountId)
    if (!pending) {
      pending = (async () => {
        try {
          const raw = JSON.parse(await readFile(this.cachePath('status', accountId), 'utf8')) as { accountId?: unknown; result?: AIResult }
          if (raw.accountId !== accountId || raw.result?.status?.provider !== 'GitHub Copilot Subscription' || !Array.isArray(raw.result.status.models)) return null
          this.aiStatusCache.set(accountId, raw.result)
          return raw.result
        } catch { return null }
      })().finally(() => this.aiStatusReads.delete(accountId))
      this.aiStatusReads.set(accountId, pending)
    }
    return pending
  }
  private async persistAIStatus(accountId: string, result: AIResult): Promise<void> {
    this.aiStatusCache.set(accountId, result)
    try { await mkdir(this.root, { recursive: true, mode: 0o700 }); await writeFile(this.cachePath('status', accountId), JSON.stringify({ accountId, result }), { mode: 0o600 }) } catch { /* In-memory last-known status remains available. */ }
  }
  private async cachedUsage(accountId: string): Promise<StoredQuota | null> {
    const memory = this.usageCache.get(accountId)
    if (memory) return memory
    let pending = this.usageReads.get(accountId)
    if (!pending) {
      pending = (async () => {
        try {
          const raw = JSON.parse(await readFile(this.cachePath('usage', accountId), 'utf8')) as StoredQuota
          if (raw.accountId !== accountId || (raw.snapshot && raw.snapshot.accountId !== accountId)) return null
          this.usageCache.set(accountId, raw)
          return raw
        } catch { return null }
      })().finally(() => this.usageReads.delete(accountId))
      this.usageReads.set(accountId, pending)
    }
    return pending
  }
  private async persistUsage(value: StoredQuota): Promise<void> {
    this.usageCache.set(value.accountId, value)
    try { await mkdir(this.root, { recursive: true, mode: 0o700 }); await writeFile(this.cachePath('usage', value.accountId), JSON.stringify(value), { mode: 0o600 }) } catch { /* Keep successful in-memory snapshots if disk persistence is unavailable. */ }
  }
  private async load() {
    if (!this.loading) this.loading = (async () => {
      const raw = await this.entry.getPassword()
      if (raw) this.state = stateSchema.parse(JSON.parse(raw))
    })().catch(error => { this.loading = undefined; throw error })
    await this.loading
  }
  private async save() { await this.entry.setPassword(JSON.stringify(stateSchema.parse(this.state))) }
  async dispose(id?: string) {
    const entries = [...this.clients].filter(([key]) => !id || key === id)
    for (const [key] of entries) this.clients.delete(key)
    await Promise.allSettled(entries.map(async ([, pending]) => (await pending).stop()))
  }
  private async create(token?: string, id = 'cli-probe') {
    await mkdir(this.root, { recursive: true })
    const env = this.cliEnvironment()
    if (token) for (const key of ['COPILOT_GITHUB_TOKEN','GH_TOKEN','GITHUB_TOKEN']) delete env[key]
    const connection = app.isPackaged ? RuntimeConnection.forStdio({ path: join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', `@github/copilot-sdk-${process.platform}-${process.arch}`, 'prebuilds', `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'copilot-runtime.exe' : 'copilot-runtime') }) : undefined
    // Empty mode sets COPILOT_DISABLE_KEYTAR. Official `copilot login` stores the signed-in user in the OS keychain, so that mode reports the user as signed out. CLI bindings use copilot-cli mode so the runtime can read that keychain entry. OAuth accounts stay isolated: explicit token, empty mode, and a private directory.
    const loggedInUser = !token
    let client: CopilotClient | undefined
    try {
      client = new CopilotClient({ connection, mode: loggedInUser ? 'copilot-cli' : 'empty', baseDirectory: token ? join(this.root, createHash('sha256').update(id).digest('hex')) : join(process.env.HOME ?? process.env.USERPROFILE ?? this.root, '.copilot'), workingDirectory: this.root, env, gitHubToken: token, useLoggedInUser: loggedInUser, logLevel: 'error' })
      await client.start()
      return client
    } catch (error) {
      await client?.stop().catch(() => {})
      if (error instanceof ChatError) throw error
      throw new ChatError('Copilot runtime could not start. Check installation and network access. No other provider was used.')
    }
  }
  async active() {
    await this.load()
    const account = this.state.accounts.find(a => a.id === this.state.activeId && a.enabled)
    if (!account) throw new ChatError('Connect and select a GitHub Copilot account in Settings → AI.')
    let pending = this.clients.get(account.id)
    if (!pending) {
      pending = this.create(account.token, account.id).catch(error => { this.clients.delete(account.id); throw error })
      this.clients.set(account.id, pending)
    }
    const client = await pending
    if (!this.state.accounts.some(a => a.id === account.id && a.enabled)) throw new ChatError('Copilot account was disconnected.')
    const auth = await client.getAuthStatus()
    if (!auth.isAuthenticated || auth.login !== account.login || (account.kind === 'cli' ? auth.authType !== 'user' : auth.authType === 'api-key')) throw new ChatError('Copilot authentication expired or the CLI account changed. Reconnect the selected GitHub account. No fallback was used.')
    const models = (await client.listModels()).filter(m => m.policy?.state !== 'disabled' && m.policy?.state !== 'unconfigured')
    return { client, account, models }
  }
  async identity() { await this.load(); return this.state.activeId ? `copilot:${this.state.activeId}` : null }
  async aiStatus(forceRefresh = false): Promise<AIResult> {
    try { await this.load() }
    catch (error) {
      return { ok: false, message: error instanceof ChatError ? error.message : 'Saved Copilot account data is invalid. Reconnect the selected account; Athena did not use CLI credentials as a fallback.', status: { provider: 'GitHub Copilot Subscription', active: false, hasKey: false, model: null, models: [], lastVerifiedAt: null, connection: 'failed' } }
    }
    const account = this.state.accounts.find(a => a.id === this.state.activeId && a.enabled)
    if (!account) return { ok: false, message: 'Connect and select a GitHub Copilot account in Settings → AI.', status: { provider: 'GitHub Copilot Subscription', active: false, hasKey: false, model: null, models: [], lastVerifiedAt: null, connection: 'not-tested' } }
    if (!forceRefresh) {
      const cached = await this.cachedAIStatus(account.id)
      if (cached) return cached
    }
    try {
      const { models } = await this.active()
      const reasoningEfforts = Object.fromEntries(models.flatMap(model => {
        const advertised = model.supportedReasoningEfforts?.filter((effort): effort is 'low'|'medium'|'high'|'xhigh' => ['low','medium','high','xhigh'].includes(effort))
        return advertised?.length ? [[model.id, ['auto', ...advertised] as import('../../../shared/conversations').ReasoningEffort[]]] : []
      }))
      const result: AIResult = { ok: true, message: 'GitHub Copilot subscription. Plan limits and model multipliers apply; usage data is retrieved from the official SDK on request.', status: { provider: 'GitHub Copilot Subscription', active: true, hasKey: false, model: models[0]?.id ?? null, models: models.map(m=>m.id), modelLabels: Object.fromEntries(models.map(m=>[m.id,m.name])), ...(Object.keys(reasoningEfforts).length ? { modelEfforts: reasoningEfforts } : {}), modelCatalogAvailable: true, lastVerifiedAt: Date.now(), connection: 'successful' } }
      await this.persistAIStatus(account.id, result)
      return result
    } catch (error) {
      const cached = await this.cachedAIStatus(account.id)
      if (cached && !forceRefresh) return cached
      return { ok: false, message: error instanceof ChatError ? error.message : 'Copilot account verification failed. Reconnect in Settings → AI.', status: { provider: 'GitHub Copilot Subscription', active: false, hasKey: false, model: null, models: [], lastVerifiedAt: null, connection: 'failed' } }
    }
  }
  command(command: CopilotCommand): Promise<CopilotStatus> {
    const changes = !['status', 'verify', 'usage'].includes(command.action)
    if (changes) this.authenticationChanges++
    const result = this.commandQueue.then(() => this.runCommand(command)).finally(() => { if (changes) this.authenticationChanges-- })
    this.commandQueue = result.catch(() => {})
    return result
  }
  private async runCommand(command: CopilotCommand): Promise<CopilotStatus> {
    await this.load()
    let message = 'Use browser sign-in, device-code sign-in, or connect your existing Copilot CLI. No Client ID is needed.'
    if (!['status', 'cancel', 'verify', 'usage'].includes(command.action) && this.requests) throw new ChatError('Wait for active Copilot requests to finish or cancel them before changing authentication.')
    if (this.cli.running && !['status','cancel'].includes(command.action)) throw new ChatError('Finish or cancel the current GitHub sign-in first.')
    if (command.action === 'verify') {
      const result = await this.aiStatus(true)
      message = result.ok ? `Copilot connection verified. ${result.status.models.length} eligible models available.` : result.message
    }
    if (command.action === 'usage') {
      const account = this.state.accounts.find(a => a.id === this.state.activeId && a.enabled)
      if (!account) message = 'Connect and select a Copilot account before refreshing usage.'
      else {
        const result = await this.refreshUsage(account.id)
        message = result.error ?? (result.snapshot ? 'Copilot usage refreshed from the official SDK.' : 'The official SDK returned no quota data for this account.')
      }
    }
    if (command.action === 'cli-manage') {
      const executable = await this.cli.discover()
      if (process.platform !== 'darwin') throw new ChatError('Open Copilot in your terminal, use /user list or /user switch, then Connect Existing Copilot CLI. In-app terminal launch is currently macOS only.')
      const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'"
      await mkdir(this.root, { recursive: true })
      const path = join(this.root, 'manage-copilot-accounts.command')
      const env = ['PATH','HOME','HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY','SSL_CERT_FILE','SSL_CERT_DIR'].map(key => `${key}=\"$${key}\"`).join(' ')
      await writeFile(path, `#!/bin/sh\ncd ${quote(this.root)}\nprintf '%s\n' 'Use /user list, /user switch, or /logout. Exit Copilot, then reconnect in Athena.'\nexec /usr/bin/env -i ${env} ${quote(executable)}\n`, {mode:0o700})
      await this.dispose(); this.managing = true
      const error = await shell.openPath(path)
      if (error) { this.managing = false; throw new ChatError('Could not open Terminal. Run Copilot in your terminal and reconnect here.') }
      message = 'Account management opened in Terminal. Copilot requests are paused. Exit that CLI, then Connect Existing Copilot CLI to verify the selected account.'
    }
    if (command.action === 'cli-check') { await this.cli.discover(); message = 'Copilot CLI installation verified.' }
    if (command.action === 'cli-login') { await this.dispose(); await this.cli.start(command.flow) }
    if (command.action === 'cancel') { this.managing = false; this.pending = undefined; await this.cli.cancel() }
    if (command.action === 'select' || command.action === 'remove' || command.action === 'enable') {
      const account = this.state.accounts.find(a=>a.id===command.id)
      if (!account) throw new ChatError('GitHub account no longer exists.')
      if (command.action === 'select') { if (!account.enabled) throw new ChatError('Enable this account first.'); this.state.activeId = account.id }
      if (command.action === 'enable') account.enabled = command.enabled
      if (command.action === 'remove') { this.state.accounts = this.state.accounts.filter(a=>a.id!==account.id); if (this.state.activeId === account.id) this.state.activeId = null }
      if (command.action !== 'select') await this.dispose(account.id); await this.save()
    }
    if (command.action === 'connect-cli') { await this.cli.discover(); await this.connectCLI(); this.managing = false }
    if (command.action === 'login') {
      const data = await this.github('https://github.com/login/device/code', { client_id: command.clientId, scope: 'read:user' })
      if (!Number.isFinite(data.expires_in) || Number(data.expires_in) <= 0 || typeof data.device_code !== 'string' || typeof data.user_code !== 'string' || data.verification_uri !== 'https://github.com/login/device') throw new ChatError('GitHub device login is unavailable. Check the OAuth App Client ID and enable device flow.')
      this.pending = { clientId: command.clientId, deviceCode: data.device_code, code: data.user_code, url: data.verification_uri, expiresAt: Date.now()+Number(data.expires_in)*1000, interval: Math.max(5,Number(data.interval)||5), nextPoll: 0 }
    }
    if (command.action === 'poll') {
      const pending = this.pending
      if (!pending || Date.now() > pending.expiresAt) { this.pending = undefined; throw new ChatError('Device login expired. Start sign-in again.') }
      if (Date.now() >= pending.nextPoll) {
        pending.nextPoll = Date.now()+pending.interval*1000
        const data = await this.github('https://github.com/login/oauth/access_token', { client_id: pending.clientId, device_code: pending.deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' })
        if (typeof data.access_token === 'string') {
          const response = await fetch('https://api.github.com/user', { headers: { Authorization: `Bearer ${data.access_token}`, Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(20000) })
          const user = await response.json() as { login?: string }
          if (!response.ok || !user.login || this.pending !== pending) throw new ChatError('GitHub identity could not be verified.')
          await this.add(user.login, 'oauth', data.access_token); this.pending = undefined; message = 'GitHub account connected. Refresh models to verify Copilot eligibility.'
        } else if (data.error === 'slow_down') pending.interval += 5
        else if (data.error !== 'authorization_pending') { this.pending = undefined; throw new ChatError('GitHub denied or expired the sign-in. Try again.') }
      }
    }
    const accountId = this.state.activeId
    const [verified, usage] = accountId ? await Promise.all([this.cachedAIStatus(accountId), this.cachedUsage(accountId)]) : [null, null]
    return { accounts: this.state.accounts.map(({ token: _token, ...account })=>account), activeId: accountId, message, cli: this.cli.status, requestsActive: this.requests > 0, managing: this.managing, device: this.pending ? { code: this.pending.code, url: this.pending.url, expiresAt: this.pending.expiresAt, interval: this.pending.interval } : undefined,
      lastVerifiedAt: verified?.status.lastVerifiedAt ?? null, modelCount: verified?.status.models.length ?? 0,
      models: verified?.status.models.map(id => ({ id, name: verified.status.modelLabels?.[id] ?? id })) ?? [],
      usage: usage?.snapshot ?? null, usageError: usage?.error ?? null }
  }
  private async refreshUsage(accountId: string): Promise<StoredQuota> {
    const ongoing = this.usageRefreshes.get(accountId)
    if (ongoing) return ongoing
    const task = (async () => {
      const previous = await this.cachedUsage(accountId)
      try {
        const { client, account } = await this.active()
        if (account.id !== accountId || this.state.activeId !== accountId) throw new ChatError('The selected Copilot account changed. Choose it again before refreshing usage.')
        const data = await client.rpc.account.getQuota({})
        const snapshot = parseCopilotUsage(accountId, data)
        const saved: StoredQuota = { accountId, snapshot, error: snapshot.quotas.length ? null : 'GitHub returned no quota categories for this account.' }
        await this.persistUsage(saved)
        return saved
      } catch (error) {
        const saved: StoredQuota = { accountId, snapshot: previous?.snapshot ?? null, error: error instanceof Error ? error.message : 'Copilot usage could not be refreshed.' }
        await this.persistUsage(saved)
        return saved
      }
    })().finally(() => this.usageRefreshes.delete(accountId))
    this.usageRefreshes.set(accountId, task)
    return task
  }
  private async connectCLI(canCommit = () => true) {
    await this.dispose()
    const client = await this.create()
    try {
      const auth = await client.getAuthStatus()
      if (!auth.isAuthenticated || !auth.login || auth.authType !== 'user') throw new ChatError('Copilot CLI sign-in finished, but the SDK did not see a signed-in GitHub user. Reconnect the active CLI account.')
      if (!canCommit()) throw new ChatError('GitHub sign-in was cancelled before identity verification completed.')
      await this.add(auth.login, 'cli')
    } finally { await client.stop() }
  }
  private async add(login: string, kind: 'oauth'|'cli', token?: string) {
    const id = `${kind}:${login.toLowerCase()}`
    if (this.state.accounts.some(account => account.id !== id)) throw new ChatError('A GitHub Copilot account is already connected. Disconnect it before connecting another account.')
    this.state.accounts = [...this.state.accounts.filter(a=>a.id!==id), { id,login,kind,token,enabled:true }]
    this.state.activeId = id; await this.dispose(id); await this.save()
  }
  private async github(url: string, body: Record<string,string>): Promise<Record<string,unknown>> {
    const response = await fetch(url, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) })
    if (!response.ok) throw new ChatError('GitHub authentication request failed. Check your connection and OAuth registration.')
    return response.json() as Promise<Record<string,unknown>>
  }
}
