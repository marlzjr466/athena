import { createHash, createPublicKey, randomBytes, randomUUID, verify } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { app, shell } from 'electron'
import { z } from 'zod'
import { chatGPTModelSchema, emptyChatGPTStatus, type ChatGPTAccountStatus, type ChatGPTPendingAccount, type ChatGPTStatus, type ChatGPTModel } from '../../../shared/chatgpt'
import { modelIdSchema } from '../../../shared/ai'
import { ChatError } from './AIProvider'
import { credentialServiceName } from './credentialStore'
import { chatGPTResponseError } from './chatGPTErrors'
import type { SubscriptionRequestIdentity } from './OpenAIProvider'

const ISSUER = 'https://auth.openai.com'
const RESOURCE = 'https://api.openai.com/v1'
const SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct'
const hasPlanGrant = (scopes: string[]) => scopes.includes('chatgpt.tokens.use.direct') && scopes.includes('resource.invoke')
const CALLBACK_PATH = '/auth/callback'
const sessionSchema = z.object({
  clientId: z.string().min(8).max(256).regex(/^[a-zA-Z0-9_-]+$/).refine((value) => value !== 'dynamic_agent_client'), subject: z.string().min(1), email: z.string().email().nullable(), name: z.string().max(200).nullable().default(null),
  accessToken: z.string().min(1), refreshToken: z.string().min(1), idToken: z.string().min(1),
  scopes: z.array(z.string()), expiresAt: z.number().finite(), model: modelIdSchema.nullable(),
  models: z.array(chatGPTModelSchema).max(500),
})
type Session = z.infer<typeof sessionSchema>
const registrationSchema = z.object({ hostId: z.string().uuid(), clientId: z.string().nullable(), subject: z.string().nullable(), email: z.string().email().nullable() })
type Registration = z.infer<typeof registrationSchema>
const accountSchema = z.object({
  id: z.string().uuid(), label: z.string().min(1).max(80), enabled: z.boolean(),
  reconnectRequired: z.boolean().optional(),
  registration: registrationSchema, session: sessionSchema,
})
type StoredAccount = z.infer<typeof accountSchema>
const accountIndexSchema = z.object({ hostId: z.string().uuid(), ids: z.array(z.string().uuid()).max(50), activeId: z.string().uuid().nullable() })
type AccountIndex = z.infer<typeof accountIndexSchema>
export interface ChatGPTOAuthCallbackListener { redirectUri: string; callback: Promise<URLSearchParams>; close(): void }
export type ChatGPTOAuthCallbackFactory = () => Promise<ChatGPTOAuthCallbackListener>

async function createLoopbackCallbackListener(): Promise<ChatGPTOAuthCallbackListener> {
  let resolveCallback!: (params: URLSearchParams) => void
  let rejectCallback!: (error: Error) => void
  const callback = new Promise<URLSearchParams>((resolve, reject) => { resolveCallback = resolve; rejectCallback = reject })
  void callback.catch(() => {})
  let server: Server | undefined
  server = createServer((req, res) => {
    let url: URL
    try { url = new URL(req.url ?? '', 'http://127.0.0.1') } catch { res.writeHead(404).end(); return }
    const port = (server!.address() as { port: number }).port
    if (req.method !== 'GET' || url.pathname !== CALLBACK_PATH || req.headers.host !== `127.0.0.1:${port}`) { res.writeHead(404).end(); return }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'", 'Cache-Control': 'no-store' })
    res.end('<!doctype html><title>Athena</title><p>You can return to Athena.</p>')
    resolveCallback(url.searchParams)
  })
  server.on('error', rejectCallback)
  await new Promise<void>((resolve, reject) => { server!.once('listening', resolve); server!.once('error', reject); server!.listen(0, '127.0.0.1') })
  const redirectUri = `http://127.0.0.1:${(server.address() as { port: number }).port}${CALLBACK_PATH}`
  return { redirectUri, callback, close: () => server?.close() }
}

/** Credentials for each account are stored in a distinct Keychain item. The index contains identifiers only. */
export interface ChatGPTVault {
  readIndex(): Promise<AccountIndex | null>
  writeIndex(value: AccountIndex): Promise<void>
  readAccount(id: string): Promise<StoredAccount | null>
  writeAccount(value: StoredAccount): Promise<void>
  removeAccount(id: string): Promise<void>
  /** One-time migration source for Athena versions that stored a single ChatGPT account. */
  readLegacySession(): Promise<Session | null>
  readLegacyRegistration(): Promise<Registration | null>
  removeLegacy(): Promise<void>
}

export class ChatGPTKeychainVault implements ChatGPTVault {
  private async entry(name: string) {
    if (process.platform !== 'darwin') throw new Error('ChatGPT credential storage requires macOS Keychain.')
    const { AsyncEntry } = await import('@napi-rs/keyring')
    return new AsyncEntry(credentialServiceName().replace(/\.openai(\.|$)/, '.chatgpt$1'), name)
  }
  private async read<T>(name: string, schema: z.ZodType<T>): Promise<T | null> {
    const raw = await (await this.entry(name)).getPassword()
    if (raw == null) return null
    try { return schema.parse(JSON.parse(raw)) } catch { throw new Error('Saved ChatGPT credentials could not be read.') }
  }
  private async write<T>(name: string, schema: z.ZodType<T>, value: T) {
    await (await this.entry(name)).setPassword(JSON.stringify(schema.parse(value)))
  }
  readIndex() { return this.read('chatgpt-accounts-index', accountIndexSchema) }
  writeIndex(value: AccountIndex) { return this.write('chatgpt-accounts-index', accountIndexSchema, value) }
  readAccount(id: string) { return this.read(`chatgpt-account-${id}`, accountSchema) }
  writeAccount(value: StoredAccount) { return this.write(`chatgpt-account-${value.id}`, accountSchema, value) }
  async removeAccount(id: string) { await (await this.entry(`chatgpt-account-${id}`)).deleteCredential() }
  readLegacySession() { return this.read('chatgpt-session', sessionSchema) }
  readLegacyRegistration() { return this.read('chatgpt-registration', registrationSchema) }
  async removeLegacy() {
    await Promise.all([this.entry('chatgpt-session').then((entry) => entry.deleteCredential().catch(() => {})), this.entry('chatgpt-registration').then((entry) => entry.deleteCredential().catch(() => {}))])
  }
}

const base64url = (bytes: Buffer) => bytes.toString('base64url')
const nonce = () => base64url(randomBytes(32))
const tokenSchema = z.object({ access_token: z.string().min(1), refresh_token: z.string().min(1), id_token: z.string().min(1), scope: z.string(), expires_in: z.number().finite().positive(), token_type: z.string() })
const refreshSchema = tokenSchema.partial({ id_token: true, scope: true, refresh_token: true })
const accountLabel = (email: string | null, name?: string | null) => name?.trim().slice(0, 80) || email?.split('@')[0]?.slice(0, 80) || 'ChatGPT account'

export class ChatGPTAuth {
  private accounts = new Map<string, StoredAccount>()
  private hostId: string | null = null
  private activeId: string | null = null
  selectedAccountId(): string | null { return this.loaded ? this.activeId : null }
  private pending: { id: string; account: StoredAccount } | null = null
  private loaded = false
  private loadTask?: Promise<void>
  private verifiedAccess = new Map<string, string>()
  private refreshTasks = new Map<string, Promise<void>>()
  private signInTask?: Promise<void>
  constructor(private vault: ChatGPTVault = new ChatGPTKeychainVault(), private request: typeof fetch = (...args) => fetch(...args), private openBrowser: (url: string) => Promise<void> = (url) => shell.openExternal(url).then(() => {}), private changed: () => void = () => {}, private createCallbackListener: ChatGPTOAuthCallbackFactory = createLoopbackCallbackListener) {}

  private async load() {
    if (this.loaded) return
    if (!this.loadTask) this.loadTask = this.loadAccounts().finally(() => { this.loadTask = undefined })
    await this.loadTask
  }
  private async loadAccounts() {
    const index = await this.vault.readIndex()
    if (index) {
      this.hostId = index.hostId
      for (const id of index.ids) {
        const account = await this.vault.readAccount(id)
        if (account) {
          if (account.id !== id) throw new ChatError('Saved ChatGPT account mapping is inconsistent. No credentials were used.')
          this.accounts.set(id, account)
        }
      }
      this.activeId = index.activeId && this.accounts.get(index.activeId)?.enabled ? index.activeId : null
      // Repair stale index entries but never choose a different account implicitly.
      if (this.accounts.size !== index.ids.length || this.activeId !== index.activeId) await this.persistIndex()
    } else {
      const [legacySession, legacyRegistration] = await Promise.all([this.vault.readLegacySession(), this.vault.readLegacyRegistration()])
      if (legacySession && legacyRegistration) {
        const id = randomUUID()
        this.hostId = legacyRegistration.hostId
        const migrated: StoredAccount = { id, label: accountLabel(legacySession.email, legacySession.name), enabled: true, registration: legacyRegistration, session: legacySession }
        await this.vault.writeAccount(migrated)
        this.accounts.set(id, migrated)
        this.activeId = id
        await this.persistIndex()
        await this.vault.removeLegacy()
      } else {
        this.hostId = randomUUID()
        await this.vault.writeIndex({ hostId: this.hostId, ids: [], activeId: null })
      }
    }
    this.loaded = true
  }
  private async persistIndex() {
    if (!this.hostId) throw new ChatError('ChatGPT host identity is unavailable. Restart sign-in from Settings.')
    await this.vault.writeIndex({ hostId: this.hostId, ids: [...this.accounts.keys()], activeId: this.activeId })
  }
  private async persistAccount(account: StoredAccount) {
    await this.vault.writeAccount(account)
    this.accounts.set(account.id, account)
  }
  private uniqueLabel(label: string, exceptId?: string) {
    const base = label.trim().slice(0, 68) || 'ChatGPT account'
    const existing = new Set([...this.accounts.values()].filter((account) => account.id !== exceptId).map((account) => account.label.toLocaleLowerCase()))
    if (!existing.has(base.toLocaleLowerCase())) return base
    for (let number = 2; number < 100; number++) {
      const candidate = `${base} (${number})`
      if (!existing.has(candidate.toLocaleLowerCase())) return candidate
    }
    return `${base} (${randomUUID().slice(0, 6)})`
  }
  private summary(account: StoredAccount, active = account.id === this.activeId): ChatGPTAccountStatus {
    const planEnabled = hasPlanGrant(account.session.scopes)
    return {
      id: account.id, label: account.label, email: account.session.email, connected: account.reconnectRequired !== true, planEnabled,
      enabled: account.enabled, active, model: account.session.model, models: [...account.session.models],
      message: account.reconnectRequired ? 'Authorization expired. Reconnect this account before continuing its unfinished tasks.' : planEnabled ? account.session.models.length ? 'Connected to ChatGPT plan usage.' : 'Connected, but the model catalog is unavailable. Try Refresh models.' : 'Signed in, but ChatGPT plan usage was not authorized.',
    }
  }
  async status(): Promise<ChatGPTStatus> {
    await this.load()
    const accounts = [...this.accounts.values()].map((account) => this.summary(account))
    const active = this.activeId ? this.accounts.get(this.activeId) : undefined
    const selected = active ? this.summary(active) : undefined
    const pendingAccount: ChatGPTPendingAccount | null = this.pending ? {
      id: this.pending.id, label: this.pending.account.label, email: this.pending.account.session.email,
      planEnabled: hasPlanGrant(this.pending.account.session.scopes), model: this.pending.account.session.model,
      models: [...this.pending.account.session.models],
      sameIdentityAlreadyConnected: [...this.accounts.values()].some((account) => account.session.subject === this.pending!.account.session.subject),
    } : null
    return {
      ...emptyChatGPTStatus(), connected: selected?.connected ?? false, planEnabled: selected?.planEnabled ?? false,
      email: selected?.email ?? null, model: selected?.model ?? null, models: selected?.models ?? [],
      message: selected?.message ?? (accounts.length ? 'Choose an enabled ChatGPT account to use with Athena.' : 'No ChatGPT accounts connected.'),
      accounts, activeAccountId: this.activeId, pendingAccount,
    }
  }

  /** Opens OpenAI's documented authorization UI and holds verified credentials in memory pending explicit confirmation. */
  async beginAddAccount(): Promise<ChatGPTStatus> {
    if (this.signInTask) { await this.signInTask; return this.status() }
    if (this.pending) throw new ChatError('Confirm, cancel, or retry the pending ChatGPT account before starting another sign-in.')
    this.signInTask = this.authorize().then((account) => { this.pending = { id: randomUUID(), account } }).finally(() => { this.signInTask = undefined })
    await this.signInTask
    this.changed()
    return this.status()
  }
  async retryAddAccount(): Promise<ChatGPTStatus> {
    await this.load()
    const previous = this.pending
    this.pending = null
    try { return await this.beginAddAccount() }
    catch (error) { this.pending = previous; throw error }
  }
  async cancelPendingAccount(pendingId: string): Promise<ChatGPTStatus> {
    await this.load()
    if (this.pending?.id === pendingId) this.pending = null
    this.changed()
    return this.status()
  }
  async confirmPendingAccount(pendingId: string, label?: string): Promise<ChatGPTStatus> {
    await this.load()
    if (!this.pending || this.pending.id !== pendingId) throw new ChatError('This ChatGPT sign-in confirmation expired. Add the account again.')
    const account = { ...this.pending.account, label: this.uniqueLabel(label?.trim().slice(0, 80) || this.pending.account.label) }
    if ([...this.accounts.values()].some((existing) => existing.session.clientId === account.session.clientId)) {
      this.pending = null
      throw new ChatError('This ChatGPT registration is already saved. Select it or reconnect it instead of adding a duplicate registration.')
    }
    const previousActiveId = this.activeId
    await this.vault.writeAccount(account)
    this.accounts.set(account.id, account)
    if (!this.activeId) this.activeId = account.id
    try { await this.persistIndex() } catch (error) { this.accounts.delete(account.id); this.activeId = previousActiveId; await this.vault.removeAccount(account.id).catch(() => {}); throw error }
    this.pending = null
    this.changed()
    return this.status()
  }
  async reconnectAccount(id: string): Promise<ChatGPTStatus> {
    await this.load()
    const existing = this.accounts.get(id)
    if (!existing) throw new ChatError('That saved ChatGPT account no longer exists.')
    const refreshed = await this.authorize(existing)
    await this.persistAccount({ ...existing, reconnectRequired: false, session: refreshed.session, registration: refreshed.registration })
    this.changed()
    return this.status()
  }

  private async authorize(existing?: StoredAccount): Promise<StoredAccount> {
    await this.load()
    const registration: Registration = existing?.registration ?? { hostId: this.hostId ?? randomUUID(), clientId: null, subject: null, email: null }
    const state = nonce(), oidcNonce = nonce(), verifier = nonce()
    const challenge = base64url(createHash('sha256').update(verifier).digest())
    let listener: ChatGPTOAuthCallbackListener | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      listener = await this.createCallbackListener()
      const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ChatError('ChatGPT sign-in timed out. Try again.')), 5 * 60_000) })
      const redirect = listener.redirectUri
      const url = new URL(`${ISSUER}/api/accounts/authorize`)
      const values: Record<string, string> = {
        client_id: registration.clientId ?? 'dynamic_agent_client', ext_agent_host_id: `urn:uuid:${registration.hostId}`,
        response_type: 'code', redirect_uri: redirect, scope: SCOPES, resource: RESOURCE,
        state, nonce: oidcNonce, code_challenge_method: 'S256', code_challenge: challenge,
      }
      if (!existing) values.agent_name_hint = app.getName() || 'Athena'
      else {
        values.id_token_hint = existing.session.idToken
        if (existing.session.email) values.login_hint = existing.session.email
      }
      for (const [key, value] of Object.entries(values)) url.searchParams.set(key, value)
      await this.openBrowser(url.toString())
      const params = await Promise.race([listener.callback, timeout])
      if (params.get('state') !== state) throw new ChatError('ChatGPT sign-in state did not match. Nothing was saved.')
      if (params.get('error')) throw new ChatError('ChatGPT sign-in or plan usage was not approved. No provider switch occurred.')
      const issued = params.get('client_id') ?? registration.clientId
      if (!issued || !sessionSchema.shape.clientId.safeParse(issued).success || (registration.clientId && issued !== registration.clientId)) throw new ChatError('ChatGPT registration was incomplete or changed unexpectedly.')
      const code = params.get('code')
      if (!code) throw new ChatError('ChatGPT did not return an authorization code.')
      const response = await this.request(`${ISSUER}/api/accounts/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', client_id: issued, code, code_verifier: verifier, redirect_uri: redirect, resource: RESOURCE }), signal: AbortSignal.timeout(30_000), redirect: 'error' })
      if (!response.ok) throw await chatGPTResponseError(response, 'oauth_token_exchange')
      const tokens = tokenSchema.parse(await response.json())
      if (tokens.token_type.toLowerCase() !== 'bearer') throw new ChatError('ChatGPT returned an unsupported token type.')
      const identity = await this.verifyIDToken(tokens.id_token, issued, oidcNonce)
      if (existing && existing.session.subject !== identity.sub) throw new ChatError('ChatGPT returned a different account. The saved account was not changed; retry and choose the expected identity.')
      if (!existing && [...this.accounts.values()].some((account) => account.session.clientId === issued)) throw new ChatError('This ChatGPT registration is already saved. Select it or reconnect it instead of adding a duplicate registration.')
      const scopes = tokens.scope.split(/\s+/).filter(Boolean)
      const priorModel = existing?.session.model ?? null
      const candidateSession: Session = {
        clientId: issued, subject: identity.sub, email: identity.email ?? null, name: identity.name ?? null,
        accessToken: tokens.access_token, refreshToken: tokens.refresh_token, idToken: tokens.id_token,
        scopes, expiresAt: Date.now() + tokens.expires_in * 1000, model: priorModel, models: [],
      }
      if (hasPlanGrant(scopes)) {
        try { candidateSession.models = await this.fetchModels(candidateSession.accessToken) } catch { candidateSession.models = [] }
        if (!candidateSession.models.some((model) => model.slug === candidateSession.model)) candidateSession.model = candidateSession.models[0]?.slug ?? null
      }
      const nextRegistration: Registration = { hostId: registration.hostId, clientId: issued, subject: identity.sub, email: identity.email ?? null }
      return {
        id: existing?.id ?? randomUUID(), label: existing?.label ?? this.uniqueLabel(accountLabel(identity.email ?? null, identity.name)),
        enabled: existing?.enabled ?? true, registration: nextRegistration, session: candidateSession,
      }
    } finally { if (timer) clearTimeout(timer); listener?.close() }
  }

  private async verifyIDToken(jwt: string, clientId: string, expectedNonce?: string): Promise<{ sub: string; email?: string; name?: string }> {
    return this.verifyTokenClaims(jwt, clientId, expectedNonce)
  }
  private async verifyTokenClaims(jwt: string, audience: string, expectedNonce?: string) {
    const segments = jwt.split('.')
    if (segments.length !== 3) throw new ChatError('ChatGPT identity token was malformed.')
    const header = JSON.parse(Buffer.from(segments[0], 'base64url').toString('utf8')) as { alg?: string; kid?: string }
    if (header.alg !== 'RS256' || !header.kid) throw new ChatError('ChatGPT identity token uses an unsupported signature.')
    const discovery = await this.request(`${ISSUER}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(15_000), redirect: 'error' })
    if (!discovery.ok) throw new ChatError('Could not verify ChatGPT identity.')
    const metadata = await discovery.json() as { issuer?: string; jwks_uri?: string }
    if (metadata.issuer !== ISSUER || !metadata.jwks_uri?.startsWith(`${ISSUER}/`)) throw new ChatError('ChatGPT identity metadata was invalid.')
    const response = await this.request(metadata.jwks_uri, { signal: AbortSignal.timeout(15_000), redirect: 'error' })
    if (!response.ok) throw new ChatError('Could not retrieve ChatGPT signing keys.')
    const keys = await response.json() as { keys?: Array<JsonWebKey & { kid?: string }> }
    const key = keys.keys?.find((entry) => entry.kid === header.kid && entry.kty === 'RSA')
    if (!key || !verify('RSA-SHA256', Buffer.from(`${segments[0]}.${segments[1]}`), createPublicKey({ key: key as unknown as import('node:crypto').JsonWebKey, format: 'jwk' }), Buffer.from(segments[2], 'base64url'))) throw new ChatError('ChatGPT identity signature did not verify.')
    const claims = JSON.parse(Buffer.from(segments[1], 'base64url').toString('utf8')) as { iss?: string; aud?: string | string[]; exp?: number; iat?: number; nbf?: number; nonce?: string; sub?: string; email?: string; name?: string; client_id?: string; scope?: string }
    if (claims.iss !== ISSUER || !(Array.isArray(claims.aud) ? claims.aud.includes(audience) : claims.aud === audience) || !claims.exp || claims.exp <= Date.now() / 1000 || claims.iat && claims.iat > Date.now() / 1000 + 60 || claims.nbf && claims.nbf > Date.now() / 1000 + 60 || expectedNonce !== undefined && claims.nonce !== expectedNonce || !claims.sub) throw new ChatError('ChatGPT identity claims did not verify.')
    return { ...claims, sub: claims.sub }
  }
  private async verifyAccessBinding(account: StoredAccount): Promise<void> {
    const { session } = account
    if (this.verifiedAccess.get(account.id) === session.accessToken) return
    // JWT claims are not evidence until their signature, audience and issuer
    // have been checked. Opaque OAuth tokens remain bound to their token response.
    if (session.accessToken.includes('.')) {
      try {
        const claims = await this.verifyTokenClaims(session.accessToken, RESOURCE)
        if (claims.sub !== session.subject || claims.client_id !== session.clientId || !hasPlanGrant((claims.scope ?? '').split(/\s+/))) throw new Error('binding mismatch')
      } catch {
        throw new ChatError('ChatGPT access-token identity or registration could not be verified for the selected account. No inference request was sent. Check the connection in Settings → AI.', 'auth-reconnect')
      }
    }
    this.verifiedAccess.set(account.id, session.accessToken)
  }
  private async fetchModels(accessToken: string): Promise<ChatGPTModel[]> {
    const response = await this.request(`${RESOURCE}/models`, { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(30_000), redirect: 'error' })
    if (!response.ok) throw await chatGPTResponseError(response, 'model_catalog')
    const body = await response.json() as { models?: Array<{ visibility?: string; slug?: string; display_name?: string }> }
    if (!Array.isArray(body.models)) throw new ChatError('ChatGPT returned an unreadable model catalog.')
    return body.models.filter((model) => model.visibility === 'list').map((model) => chatGPTModelSchema.safeParse({ slug: model.slug, displayName: model.display_name ?? model.slug })).filter((value) => value.success).map((value) => value.data)
  }
  private requireAccount(id = this.activeId): StoredAccount {
    const account = id ? this.accounts.get(id) : undefined
    if (!account) throw new ChatError('Select a ChatGPT account in Settings → AI before chatting.')
    if (account.registration.clientId !== account.session.clientId || account.registration.subject !== account.session.subject || account.registration.hostId !== this.hostId
      || [...this.accounts.values()].some(other => other.id !== account.id && other.session.clientId === account.session.clientId)) {
      throw new ChatError('ChatGPT account and OAuth registration do not match. No credentials were used; reconnect the intended account in Settings → AI.', 'auth-reconnect')
    }
    if (!account.enabled) throw new ChatError('This ChatGPT account is disabled. Enable it or select another account in Settings → AI.')
    if (!hasPlanGrant(account.session.scopes)) throw new ChatError('Authorize ChatGPT plan usage for this account in Settings → AI before chatting.')
    return account
  }
  async refreshModels(accountId?: string | null): Promise<ChatGPTStatus> {
    await this.load()
    const account = this.requireAccount(accountId === undefined ? this.activeId : accountId)
    const accessToken = await this.accessToken(account.id)
    const models = await this.fetchModels(accessToken)
    account.session = { ...account.session, models, model: models.some((model) => model.slug === account.session.model) ? account.session.model : models[0]?.slug ?? null }
    await this.persistAccount(account)
    this.changed()
    return this.status()
  }
  async selectModel(model: string, accountId?: string | null): Promise<ChatGPTStatus> {
    await this.load()
    const account = this.requireAccount(accountId === undefined ? this.activeId : accountId)
    if (!account.session.models.some((entry) => entry.slug === model)) throw new ChatError('Choose a model available to this connected ChatGPT account.')
    account.session = { ...account.session, model }
    await this.persistAccount(account)
    this.changed()
    return this.status()
  }
  async selectAccount(id: string): Promise<ChatGPTStatus> {
    await this.load()
    const account = this.accounts.get(id)
    if (!account || !account.enabled) throw new ChatError('Choose an enabled, connected ChatGPT account.')
    if (!hasPlanGrant(account.session.scopes)) throw new ChatError('Reconnect this account and authorize ChatGPT plan usage before selecting it.')
    this.activeId = id
    await this.persistIndex()
    this.changed()
    return this.status()
  }
  async setAccountEnabled(id: string, enabled: boolean): Promise<ChatGPTStatus> {
    await this.load()
    const account = this.accounts.get(id)
    if (!account) throw new ChatError('That saved ChatGPT account no longer exists.')
    if (!enabled && this.activeId === id) throw new ChatError('Select another ChatGPT account before disabling the active account.')
    await this.persistAccount({ ...account, enabled })
    this.changed()
    return this.status()
  }
  async renameAccount(id: string, label: string): Promise<ChatGPTStatus> {
    await this.load()
    const account = this.accounts.get(id)
    if (!account) throw new ChatError('That saved ChatGPT account no longer exists.')
    const normalized = label.trim()
    if (!normalized || normalized.length > 80) throw new ChatError('Account labels must contain 1–80 characters.')
    await this.persistAccount({ ...account, label: normalized })
    this.changed()
    return this.status()
  }
  async removeAccount(id: string): Promise<ChatGPTStatus> {
    await this.load()
    const account = this.accounts.get(id)
    if (!account) throw new ChatError('That saved ChatGPT account no longer exists.')
    let revoked = false
    try {
      const discovery = await this.request(`${ISSUER}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(10_000) })
      const metadata = await discovery.json() as { revocation_endpoint?: string }
      if (metadata.revocation_endpoint?.startsWith(`${ISSUER}/`)) revoked = (await this.request(metadata.revocation_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: account.session.refreshToken, token_type_hint: 'refresh_token', client_id: account.session.clientId }), signal: AbortSignal.timeout(10_000) })).ok
    } catch { /* Local removal remains available when OpenAI is offline. */ }
    await this.vault.removeAccount(id)
    this.accounts.delete(id)
    this.verifiedAccess.delete(id)
    if (this.activeId === id) this.activeId = null
    await this.persistIndex()
    this.changed()
    if (!revoked) return { ...await this.status(), message: 'Account removed from Athena locally. OpenAI could not confirm token revocation; disconnect it in ChatGPT Settings if needed.' }
    return { ...await this.status(), message: 'ChatGPT account removed and its refresh token was revoked.' }
  }
  async accessToken(accountId?: string | null): Promise<string> {
    await this.load()
    const account = this.requireAccount(accountId === undefined ? this.activeId : accountId)
    if (account.reconnectRequired) throw new ChatError('ChatGPT authorization expired. Reconnect the same account in Settings → AI, then continue the unfinished task.', 'auth-reconnect')
    if (account.session.expiresAt <= Date.now() + 60_000) {
      let task = this.refreshTasks.get(account.id)
      if (!task) { task = this.refresh(account.id).finally(() => this.refreshTasks.delete(account.id)); this.refreshTasks.set(account.id, task) }
      await task
    }
    const current = this.requireAccount(account.id)
    await this.verifyAccessBinding(current)
    return current.session.accessToken
  }
  /** Refresh the request's pinned account, never whichever account is selected later. */
  async accessTokenForRound(accountId: string, rejectedToken?: string): Promise<string> {
    if (!rejectedToken) return this.accessToken(accountId)
    await this.load()
    const account = this.requireAccount(accountId)
    if (account.reconnectRequired) throw new ChatError('ChatGPT authorization expired. Reconnect the same account in Settings → AI.', 'auth-reconnect')
    if (account.session.accessToken !== rejectedToken) return this.accessToken(accountId)
    let task = this.refreshTasks.get(accountId)
    if (!task) { task = this.refresh(accountId).finally(() => this.refreshTasks.delete(accountId)); this.refreshTasks.set(accountId, task) }
    await task
    return this.accessToken(accountId)
  }
  private async refresh(accountId: string): Promise<void> {
    const account = this.accounts.get(accountId)
    if (!account) throw new ChatError('That ChatGPT account is no longer connected.')
    const old = account.session
    const response = await this.request(`${ISSUER}/api/accounts/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', client_id: old.clientId, refresh_token: old.refreshToken, resource: RESOURCE }), signal: AbortSignal.timeout(30_000), redirect: 'error' })
    if (!response.ok) {
      const failure = await chatGPTResponseError(response, 'oauth_refresh')
      if (failure.code === 'auth-reconnect') { await this.persistAccount({ ...account, reconnectRequired: true }); this.changed() }
      throw failure
    }
    const tokens = refreshSchema.parse(await response.json())
    if (tokens.token_type.toLowerCase() !== 'bearer') throw new ChatError('ChatGPT returned an unsupported token type.')
    if (tokens.id_token) {
      const identity = await this.verifyIDToken(tokens.id_token, old.clientId)
      if (identity.sub !== old.subject) throw new ChatError('ChatGPT refresh returned a different account. Reconnect in Settings → AI.')
    }
    const next: Session = { ...old, accessToken: tokens.access_token, refreshToken: tokens.refresh_token ?? old.refreshToken, idToken: tokens.id_token ?? old.idToken, scopes: tokens.scope?.split(/\s+/).filter(Boolean) ?? old.scopes, expiresAt: Date.now() + tokens.expires_in * 1000 }
    if (!hasPlanGrant(next.scopes)) throw new ChatError('ChatGPT plan usage permission was revoked. Reauthorize in Settings → AI.')
    await this.verifyAccessBinding({ ...account, session: next })
    if (this.accounts.get(accountId) !== account) throw new ChatError('ChatGPT account changed during refresh. Start a new request with the selected account.')
    await this.persistAccount({ ...account, reconnectRequired: false, session: next })
  }
  async activeModel(selected: string | null): Promise<{ accessToken: string; model: string; accountId: string; requestIdentity: SubscriptionRequestIdentity }> {
    await this.load()
    const accountId = this.activeId
    const accessToken = await this.accessToken(accountId)
    const account = this.requireAccount(accountId)
    if (selected && !account.session.models.some((entry) => entry.slug === selected)) throw new ChatError('The conversation model is not in the selected ChatGPT account catalog. Choose an available model; Athena did not silently substitute the account default.')
    const model = selected || account.session.model
    if (!model) throw new ChatError('No ChatGPT subscription model is available for the active account. Refresh its models in Settings → AI.')
    return { accessToken, model, accountId: account.id, requestIdentity: { accountId: account.id,
      registrationRef: createHash('sha256').update(account.session.clientId).digest('hex').slice(0, 12),
      modelSource: selected ? 'conversation' : 'account-default', workspace: 'registration-bound-not-disclosed' } }
  }
  async signOut(): Promise<ChatGPTStatus> {
    await this.load()
    if (!this.activeId) return this.status()
    return this.removeAccount(this.activeId)
  }
}
