// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { generateKeyPairSync, sign } from 'node:crypto'
import { ChatGPTAuth, type ChatGPTVault } from '../electron/main/ai/chatGPTAuth'

vi.mock('electron', () => ({ app: { getName: () => 'Athena' }, shell: { openExternal: vi.fn() } }))

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-key' }
const scope = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct'
type Identity = { sub: string; email: string; name: string }
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
function idToken(nonce: string, clientId: string, identity: Identity) {
  return signedToken({ iss: 'https://auth.openai.com', aud: clientId, sub: identity.sub, email: identity.email, name: identity.name, nonce, exp: Math.floor(Date.now() / 1000) + 3600 })
}
function signedToken(claims: Record<string, unknown>) {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'test-key' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
  return `${header}.${payload}.${sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), privateKey).toString('base64url')}`
}
function harness() {
  let index: { hostId: string; ids: string[]; activeId: string | null } | null = null
  const accounts = new Map<string, Awaited<ReturnType<ChatGPTVault['readAccount']>>>()
  let identity: Identity = { sub: 'user-1', email: 'one@example.com', name: 'Account One' }
  const accountIdentity: Identity[] = []
  const registrations: URL[] = []
  const issuedClientIds: string[] = []
  let issuedRegistration = 0
  let forcedIssuedClientId: string | null = null
  let refreshed = false
  let refreshFailure: { status: number; code: string; oauth?: boolean } | null = null
  const legacy = { session: null as Awaited<ReturnType<ChatGPTVault['readLegacySession']>>, registration: null as Awaited<ReturnType<ChatGPTVault['readLegacyRegistration']>> }
  const vault: ChatGPTVault = {
    readIndex: async () => index, writeIndex: async (value) => { index = value },
    readAccount: async (id) => accounts.get(id) ?? null, writeAccount: async (value) => { accounts.set(value.id, value) },
    removeAccount: async (id) => { accounts.delete(id) },
    readLegacySession: async () => legacy.session, readLegacyRegistration: async () => legacy.registration,
    removeLegacy: async () => { legacy.session = null; legacy.registration = null },
  }
  const request = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
    const url = String(input)
    if (url.endsWith('/.well-known/openid-configuration')) return json({ issuer: 'https://auth.openai.com', jwks_uri: 'https://auth.openai.com/jwks', revocation_endpoint: 'https://auth.openai.com/revoke' })
    if (url.endsWith('/jwks')) return json({ keys: [jwk] })
    if (url.endsWith('/oauth/token')) {
      const form = init?.body as URLSearchParams
      if (form.get('grant_type') === 'refresh_token') { refreshed = true; if (refreshFailure) return json(refreshFailure.oauth ? { error: refreshFailure.code, error_description: 'sensitive diagnostic' } : { error: { code: refreshFailure.code, message: 'sensitive diagnostic' } }, refreshFailure.status); const subject = String(form.get('refresh_token')).replace(/^refresh-/, '').replace(/-new$/, ''); return json({ access_token: `refreshed-${subject}`, refresh_token: `refresh-${subject}-new`, token_type: 'Bearer', scope, expires_in: 3600 }) }
      const clientId = String(form.get('client_id'))
      expect(form.get('code_verifier')).toBeTruthy()
      const who = accountIdentity.shift() ?? identity
      return json({ access_token: `token-${who.sub}`, refresh_token: `refresh-${who.sub}`, id_token: idToken(lastNonce, clientId, who), token_type: 'Bearer', scope, expires_in: 3600 })
    }
    if (url.endsWith('/v1/models')) return json({ models: [{ slug: 'gpt-6.1-sol', display_name: 'GPT-6.1 Sol', visibility: 'list', context_window: 272000 }, { slug: 'hidden', display_name: 'Hidden', visibility: 'hide' }] })
    if (url.endsWith('/revoke')) return new Response(null, { status: 200 })
    throw new Error(`Unexpected request to ${url}`)
  })
  let lastNonce = ''
  let deliverCallback: ((params: URLSearchParams) => void) | undefined
  const createCallbackListener = async () => {
    let resolve!: (params: URLSearchParams) => void
    const callback = new Promise<URLSearchParams>((accept) => { resolve = accept })
    deliverCallback = resolve
    return { redirectUri: 'http://127.0.0.1:43210/auth/callback', callback, close: () => {} }
  }
  const openBrowser = vi.fn(async (address: string) => {
    const url = new URL(address)
    expect(url.origin).toBe('https://auth.openai.com')
    expect(url.searchParams.get('scope')).toContain('chatgpt.tokens.use.direct')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.has('prompt')).toBe(false)
    lastNonce = url.searchParams.get('nonce')!
    registrations.push(url)
    const callback = new URLSearchParams()
    callback.set('code', 'authorization-code')
    callback.set('state', url.searchParams.get('state')!)
    const returnedClientId = url.searchParams.get('client_id') === 'dynamic_agent_client' ? (forcedIssuedClientId ?? `oaiapp_registration_${++issuedRegistration}`) : url.searchParams.get('client_id')!
    forcedIssuedClientId = null
    if (url.searchParams.get('client_id') === 'dynamic_agent_client') issuedClientIds.push(returnedClientId)
    callback.set('client_id', returnedClientId)
    deliverCallback?.(callback)
  })
  const auth = new ChatGPTAuth(vault, request, openBrowser, () => {}, createCallbackListener)
  return {
    auth, request, openBrowser, registrations, issuedClientIds, accounts, vault, getIndex: () => index, wasRefreshed: () => refreshed,
    deliver: (params: URLSearchParams) => deliverCallback?.(params),
    forceNextIssuedClientId: (value: string) => { forcedIssuedClientId = value },
    failRefresh: (status: number, code: string, oauth = false) => { refreshFailure = { status, code, oauth } },
    clearRefreshFailure: () => { refreshFailure = null },
    expire: (id: string) => { const account = accounts.get(id); if (account) account.session.expiresAt = Date.now() - 1 },
    addIdentity: async (value: Identity) => { accountIdentity.push(value); identity = value; return auth.beginAddAccount() },
    reconnectAs: (value: Identity) => { accountIdentity.push(value); identity = value },
  }
}

describe('ChatGPT OAuth account profiles', () => {
  it('does not create an empty Keychain index just because Athena starts without an account', async () => {
    const fixture = harness()
    const writeIndex = vi.spyOn(fixture.vault, 'writeIndex')
    await fixture.auth.status()
    await fixture.auth.status()
    expect(writeIndex).not.toHaveBeenCalled()
  })

  it('does not repeat a failed Keychain read on every status request in one app process', async () => {
    const fixture = harness()
    const readIndex = vi.spyOn(fixture.vault, 'readIndex').mockRejectedValue(new Error('Keychain access denied'))
    const restored = new ChatGPTAuth(fixture.vault, fixture.request, fixture.openBrowser)
    await expect(restored.status()).rejects.toThrow('Keychain access denied')
    await expect(restored.status()).rejects.toThrow('Keychain access denied')
    expect(readIndex).toHaveBeenCalledTimes(1)
  })

  it('reads existing Keychain records once per app start without rewriting them', async () => {
    const fixture = harness()
    let status = await fixture.auth.beginAddAccount()
    status = await fixture.auth.confirmPendingAccount(status.pendingAccount!.id)
    const writeIndex = vi.spyOn(fixture.vault, 'writeIndex')
    const writeAccount = vi.spyOn(fixture.vault, 'writeAccount')
    const readIndex = vi.spyOn(fixture.vault, 'readIndex')
    const readAccount = vi.spyOn(fixture.vault, 'readAccount')

    // Each new ChatGPTAuth instance models a fresh app process. Repeated
    // status calls within one process must share the same initial Keychain read.
    for (let restart = 0; restart < 3; restart++) {
      const restored = new ChatGPTAuth(fixture.vault, fixture.request, fixture.openBrowser)
      const [first, second] = await Promise.all([restored.status(), restored.status()])
      expect(first.activeAccountId).toBe(status.activeAccountId)
      expect(second.accounts).toHaveLength(1)
    }

    expect(readIndex).toHaveBeenCalledTimes(3)
    expect(readAccount).toHaveBeenCalledTimes(3)
    expect(writeIndex).not.toHaveBeenCalled()
    expect(writeAccount).not.toHaveBeenCalled()
  })

  it('loads and pins the saved account on the first request without requiring Settings to open first', async () => {
    const f = harness()
    const pending = await f.auth.beginAddAccount()
    const status = await f.auth.confirmPendingAccount(pending.pendingAccount!.id)
    const restored = new ChatGPTAuth(f.vault, f.request, f.openBrowser)
    const result = await restored.activeModel(null)
    expect(result.contextWindow).toBe(272000)
    expect(result).toMatchObject({ accessToken: 'token-user-1', accountId: status.activeAccountId, requestIdentity: { accountId: status.activeAccountId, modelSource: 'account-default', workspace: 'registration-bound-not-disclosed' } })
    expect(result.requestIdentity.registrationRef).toMatch(/^[a-f0-9]{12}$/)
    expect(JSON.stringify(result.requestIdentity)).not.toMatch(/example.com|token-user|user-1|oaiapp/)
    await expect(restored.activeModel('not-in-catalog')).rejects.toThrow('did not silently substitute')
    expect((await restored.activeModel('gpt-6.1-sol')).requestIdentity.modelSource).toBe('conversation')
  })
  it('rejects mixed registration records before using a credential', async () => {
    const f = harness()
    const pending = await f.auth.beginAddAccount()
    const status = await f.auth.confirmPendingAccount(pending.pendingAccount!.id)
    f.accounts.get(status.activeAccountId!)!.registration.clientId = 'wrong-registration'
    const calls = f.request.mock.calls.length
    await expect(f.auth.activeModel(null)).rejects.toThrow('account and OAuth registration do not match')
    expect(f.request.mock.calls.length).toBe(calls)
  })
  it('verifies signed access tokens against the selected identity, client, audience and grant', async () => {
    const f = harness()
    const pending = await f.auth.beginAddAccount()
    const status = await f.auth.confirmPendingAccount(pending.pendingAccount!.id)
    const account = f.accounts.get(status.activeAccountId!)!
    const claims = { iss: 'https://auth.openai.com', aud: 'https://api.openai.com/v1', sub: account.session.subject, client_id: account.session.clientId, scope, exp: Math.floor(Date.now() / 1000) + 3600 }
    account.session.accessToken = signedToken(claims)
    expect((await f.auth.activeModel(null)).accessToken).toBe(account.session.accessToken)
    for (const override of [{ sub: 'another-user' }, { client_id: 'another-client' }, { aud: 'https://other.example' }, { scope: 'openid profile' }]) {
      account.session.accessToken = signedToken({ ...claims, ...override })
      await expect(f.auth.activeModel(null)).rejects.toThrow('access-token identity or registration could not be verified')
    }
    account.session.accessToken = signedToken(claims).slice(0, -12) + 'invalid-signature'
    await expect(f.auth.activeModel(null)).rejects.toThrow('could not be verified')
  })
  it('pins forced refresh to one account and blocks unusable credentials until reconnect', async () => {
    const fixture = harness()
    let status = await fixture.auth.beginAddAccount()
    status = await fixture.auth.confirmPendingAccount(status.pendingAccount!.id)
    const accountId = status.activeAccountId!
    expect(await fixture.auth.accessTokenForRound(accountId, 'token-user-1')).toBe('refreshed-user-1')
    expect(await fixture.auth.accessTokenForRound(accountId, 'token-user-1')).toBe('refreshed-user-1')
    fixture.failRefresh(400, 'invalid_grant')
    await expect(fixture.auth.accessTokenForRound(accountId, 'refreshed-user-1')).rejects.toMatchObject({ code: 'auth-reconnect' })
    expect((await fixture.auth.status()).accounts[0]).toMatchObject({ connected: false })
    await expect(fixture.auth.accessToken(accountId)).rejects.toMatchObject({ code: 'auth-reconnect' })
    fixture.clearRefreshFailure()
    await fixture.auth.reconnectAccount(accountId)
    expect((await fixture.auth.status()).accounts[0]).toMatchObject({ connected: true })
  })
  it('persists a standard OAuth rejection and does not resend the unusable token after restart or model changes', async () => {
    const f = harness()
    const pending = await f.auth.beginAddAccount()
    const status = await f.auth.confirmPendingAccount(pending.pendingAccount!.id)
    const id = status.activeAccountId!
    f.expire(id); f.failRefresh(400, 'invalid_grant', true)
    const before = f.request.mock.calls.length
    await expect(f.auth.activeModel('gpt-6.1-sol')).rejects.toMatchObject({ code: 'auth-reconnect' })
    expect(f.request.mock.calls.length).toBe(before + 1)
    expect((await f.auth.status()).accounts[0].connected).toBe(false)
    const restored = new ChatGPTAuth(f.vault, f.request, f.openBrowser)
    await expect(restored.activeModel(null)).rejects.toMatchObject({ code: 'auth-reconnect' })
    await expect(restored.refreshModels(id)).rejects.toMatchObject({ code: 'auth-reconnect' })
    expect(f.request.mock.calls.length).toBe(before + 1)
    expect(f.getIndex()?.activeId).toBe(id)
    f.clearRefreshFailure(); await f.auth.reconnectAccount(id)
    expect((await f.auth.activeModel('gpt-6.1-sol')).accountId).toBe(id)
  })

  it('preserves credentials and permits recovery after a temporary OAuth server error', async () => {
    const f = harness(), pending = await f.auth.beginAddAccount()
    const status = await f.auth.confirmPendingAccount(pending.pendingAccount!.id)
    f.expire(status.activeAccountId!); f.failRefresh(503, 'temporarily_unavailable', true)
    await expect(f.auth.accessToken()).rejects.toThrow()
    expect((await f.auth.status()).accounts[0].connected).toBe(true)
    f.clearRefreshFailure()
    expect(await f.auth.accessToken()).toBe('refreshed-user-1')
  })

  it('refreshes the pinned account and rejects another account reference', async () => {
    const f = harness()
    let status = await f.auth.beginAddAccount()
    status = await f.auth.confirmPendingAccount(status.pendingAccount!.id)
    const pinned = await f.auth.activeModel(null)
    await expect(f.auth.activeModel(null, 'another-account')).rejects.toThrow('selected ChatGPT account changed')
    const results = await Promise.all([f.auth.accessTokenForRound(pinned.accountId, pinned.accessToken), f.auth.accessTokenForRound(pinned.accountId, pinned.accessToken)])
    expect(results).toEqual(['refreshed-user-1', 'refreshed-user-1'])
    expect((await f.auth.activeModel(null, pinned.accountId)).accessToken).toBe('refreshed-user-1')
    const refreshes = f.request.mock.calls.filter(([, init]) => init?.body instanceof URLSearchParams && init.body.get('grant_type') === 'refresh_token')
    expect(refreshes).toHaveLength(1)
    expect((refreshes[0][1]!.body as URLSearchParams).get('client_id')).toBe(f.issuedClientIds[0])
  })
  it('holds new credentials pending confirmation and adds the first account only after explicit confirmation', async () => {
    const fixture = harness()
    const pending = await fixture.auth.beginAddAccount()
    expect(pending.accounts).toHaveLength(0)
    expect(pending.activeAccountId).toBeNull()
    expect(pending.pendingAccount).toMatchObject({ email: 'one@example.com', label: 'Account One', planEnabled: true })
    const storedBeforeConfirm = await fixture.auth.status()
    expect(storedBeforeConfirm.accounts).toHaveLength(0)
    const status = await fixture.auth.confirmPendingAccount(pending.pendingAccount!.id, 'Personal')
    expect(status.accounts).toHaveLength(1)
    expect(status).toMatchObject({ connected: true, planEnabled: true, email: 'one@example.com', activeAccountId: status.accounts[0].id })
    expect(status.accounts[0].label).toBe('Personal')
    expect((await fixture.auth.activeModel(null)).accessToken).toBe('token-user-1')
  })

  it('requires disconnecting the existing account before adding another', async () => {
    const fixture = harness()
    let status = await fixture.auth.beginAddAccount()
    status = await fixture.auth.confirmPendingAccount(status.pendingAccount!.id)
    const firstId = status.activeAccountId!
    await expect(fixture.addIdentity({ sub: 'user-2', email: 'two@example.com', name: 'Account Two' })).rejects.toThrow('already connected')
    expect((await fixture.auth.status()).accounts).toHaveLength(1)
    await fixture.auth.removeAccount(firstId)
    status = await fixture.addIdentity({ sub: 'user-2', email: 'two@example.com', name: 'Account Two' })
    status = await fixture.auth.confirmPendingAccount(status.pendingAccount!.id)
    expect(status.accounts).toHaveLength(1)
    expect(status.accounts[0].email).toBe('two@example.com')
    expect((await fixture.auth.activeModel(null)).accessToken).toBe('token-user-2')
    expect(fixture.getIndex()?.ids).toHaveLength(1)
  })

  it('persists the sole account across auth service restoration', async () => {
    const fixture = harness()
    let status = await fixture.auth.beginAddAccount()
    status = await fixture.auth.confirmPendingAccount(status.pendingAccount!.id)
    const accountId = status.activeAccountId!
    fixture.expire(accountId)
    const restored = new ChatGPTAuth(fixture.vault, fixture.request, fixture.openBrowser)
    expect((await restored.status()).activeAccountId).toBe(accountId)
    expect(await restored.accessToken()).toBe('refreshed-user-1')
    expect(fixture.wasRefreshed()).toBe(true)
    expect((await restored.activeModel(null)).accountId).toBe(accountId)
  })

  it('does not disable the sole active account implicitly', async () => {
    const fixture = harness()
    let status = await fixture.auth.beginAddAccount()
    status = await fixture.auth.confirmPendingAccount(status.pendingAccount!.id)
    await expect(fixture.auth.setAccountEnabled(status.activeAccountId!, false)).rejects.toThrow('Select another ChatGPT account')
    expect((await fixture.auth.status()).activeAccountId).toBe(status.activeAccountId)
  })

  it('rejects another registration even when the same identity could sign in again', async () => {
    const fixture = harness()
    let status = await fixture.auth.beginAddAccount()
    await fixture.auth.confirmPendingAccount(status.pendingAccount!.id)
    await expect(fixture.auth.beginAddAccount()).rejects.toThrow('already connected')
    expect((await fixture.auth.status()).accounts).toHaveLength(1)
  })

  it('does not start a second browser authorization flow for a connected account', async () => {
    const fixture = harness()
    let status = await fixture.auth.beginAddAccount()
    await fixture.auth.confirmPendingAccount(status.pendingAccount!.id)
    const attempts = fixture.registrations.length
    await expect(fixture.auth.beginAddAccount()).rejects.toThrow('already connected')
    expect(fixture.registrations).toHaveLength(attempts)
    expect((await fixture.auth.status()).accounts).toHaveLength(1)
  })

  it('reconnects with the same registration, stable host, identity hints, and rejects a different returned subject', async () => {
    const fixture = harness()
    let status = await fixture.auth.beginAddAccount()
    status = await fixture.auth.confirmPendingAccount(status.pendingAccount!.id)
    const account = status.accounts[0]
    const firstAuthorization = fixture.registrations[0]
    fixture.reconnectAs({ sub: 'wrong-user', email: 'other@example.com', name: 'Wrong Account' })
    await expect(fixture.auth.reconnectAccount(account.id)).rejects.toThrow('different account')
    // A failed reauthorization leaves the connected identity and active selection untouched.
    expect((await fixture.auth.status()).activeAccountId).toBe(account.id)
    expect(fixture.registrations[1].searchParams.get('client_id')).toBe(fixture.issuedClientIds[0])
    expect(fixture.registrations[1].searchParams.get('ext_agent_host_id')).toBe(firstAuthorization.searchParams.get('ext_agent_host_id'))
    expect(fixture.registrations[1].searchParams.get('id_token_hint')).toBeTruthy()
    expect(fixture.registrations[1].searchParams.get('login_hint')).toBe('one@example.com')
  })

  it('validates state before token exchange and never persists an unconfirmed identity', async () => {
    const fixture = harness()
    fixture.openBrowser.mockImplementationOnce(async (address) => {
      expect(new URL(address).origin).toBe('https://auth.openai.com')
      const callback = new URLSearchParams({ code: 'authorization-code', state: 'wrong-state', client_id: 'oaiapp_user-1' })
      fixture.deliver(callback)
    })
    await expect(fixture.auth.beginAddAccount()).rejects.toThrow('state did not match')
    expect(fixture.request).not.toHaveBeenCalled()
    expect((await fixture.auth.status()).accounts).toHaveLength(0)
  })
})
