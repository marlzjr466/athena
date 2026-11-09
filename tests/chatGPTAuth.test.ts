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
  let refreshFailure: { status: number; code: string } | null = null
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
      if (form.get('grant_type') === 'refresh_token') { refreshed = true; if (refreshFailure) return json({ error: { code: refreshFailure.code, message: 'sensitive diagnostic' } }, refreshFailure.status); const subject = String(form.get('refresh_token')).replace(/^refresh-/, '').replace(/-new$/, ''); return json({ access_token: `refreshed-${subject}`, refresh_token: `refresh-${subject}-new`, token_type: 'Bearer', scope, expires_in: 3600 }) }
      const clientId = String(form.get('client_id'))
      expect(form.get('code_verifier')).toBeTruthy()
      const who = accountIdentity.shift() ?? identity
      return json({ access_token: `token-${who.sub}`, refresh_token: `refresh-${who.sub}`, id_token: idToken(lastNonce, clientId, who), token_type: 'Bearer', scope, expires_in: 3600 })
    }
    if (url.endsWith('/v1/models')) return json({ models: [{ slug: 'gpt-6.1-sol', display_name: 'GPT-6.1 Sol', visibility: 'list' }, { slug: 'hidden', display_name: 'Hidden', visibility: 'hide' }] })
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
    failRefresh: (status: number, code: string) => { refreshFailure = { status, code } },
    clearRefreshFailure: () => { refreshFailure = null },
    expire: (id: string) => { const account = accounts.get(id); if (account) account.session.expiresAt = Date.now() - 1 },
    addIdentity: async (value: Identity) => { accountIdentity.push(value); identity = value; return auth.beginAddAccount() },
    reconnectAs: (value: Identity) => { accountIdentity.push(value); identity = value },
  }
}

describe('ChatGPT OAuth account profiles', () => {
  it('loads and pins the saved account on the first request without requiring Settings to open first', async () => {
    const f = harness()
    const pending = await f.auth.beginAddAccount()
    const status = await f.auth.confirmPendingAccount(pending.pendingAccount!.id)
    const restored = new ChatGPTAuth(f.vault, f.request, f.openBrowser)
    const result = await restored.activeModel(null)
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
  it('refreshes the pinned account after selection changes without borrowing the newly selected token', async () => {
    const f = harness()
    let status = await f.auth.beginAddAccount()
    status = await f.auth.confirmPendingAccount(status.pendingAccount!.id)
    const pinned = await f.auth.activeModel(null)
    status = await f.addIdentity({ sub: 'user-2', email: 'two@example.com', name: 'Account Two' })
    status = await f.auth.confirmPendingAccount(status.pendingAccount!.id)
    await f.auth.selectAccount(status.accounts.find(a => a.id !== pinned.accountId)!.id)
    const results = await Promise.all([f.auth.accessTokenForRound(pinned.accountId, pinned.accessToken), f.auth.accessTokenForRound(pinned.accountId, pinned.accessToken)])
    expect(results).toEqual(['refreshed-user-1', 'refreshed-user-1'])
    expect((await f.auth.activeModel(null)).accessToken).toBe('token-user-2')
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

  it('isolates two accounts, keeps the original active, and selects only the explicitly chosen profile', async () => {
    const fixture = harness()
    let status = await fixture.auth.beginAddAccount()
    const firstId = status.pendingAccount!.id
    status = await fixture.auth.confirmPendingAccount(firstId)
    const activeBefore = status.activeAccountId
    status = await fixture.addIdentity({ sub: 'user-2', email: 'two@example.com', name: 'Account Two' })
    const secondId = status.pendingAccount!.id
    status = await fixture.auth.confirmPendingAccount(secondId)
    expect(status.accounts).toHaveLength(2)
    expect(status.activeAccountId).toBe(activeBefore)
    expect(fixture.registrations[0].searchParams.get('ext_agent_host_id')).toBe(fixture.registrations[1].searchParams.get('ext_agent_host_id'))
    const second = status.accounts.find((account) => account.email === 'two@example.com')!
    expect((await fixture.auth.selectAccount(second.id)).activeAccountId).toBe(second.id)
    expect((await fixture.auth.activeModel(null)).accessToken).toBe('token-user-2')
    expect(fixture.getIndex()?.ids).toHaveLength(2)
  })

  it('persists the selected account across auth service restoration and refreshes only that account token', async () => {
    const fixture = harness()
    let status = await fixture.auth.beginAddAccount()
    status = await fixture.auth.confirmPendingAccount(status.pendingAccount!.id)
    status = await fixture.addIdentity({ sub: 'user-2', email: 'two@example.com', name: 'Account Two' })
    status = await fixture.auth.confirmPendingAccount(status.pendingAccount!.id)
    const second = status.accounts.find((account) => account.email === 'two@example.com')!
    await fixture.auth.selectAccount(second.id)
    fixture.expire(second.id)
    const restored = new ChatGPTAuth(fixture.vault, fixture.request, fixture.openBrowser)
    expect((await restored.status()).activeAccountId).toBe(second.id)
    expect(await restored.accessToken()).toBe('refreshed-user-2')
    expect(fixture.wasRefreshed()).toBe(true)
    expect((await restored.activeModel(null)).accountId).toBe(second.id)
  })

  it('requires the active account to be changed before disabling it and never rotates automatically', async () => {
    const fixture = harness()
    let status = await fixture.auth.beginAddAccount()
    const first = await fixture.auth.confirmPendingAccount(status.pendingAccount!.id)
    const firstId = first.activeAccountId!
    status = await fixture.addIdentity({ sub: 'user-2', email: 'two@example.com', name: 'Account Two' })
    status = await fixture.auth.confirmPendingAccount(status.pendingAccount!.id)
    const secondId = status.accounts.find((account) => account.email === 'two@example.com')!.id
    await expect(fixture.auth.setAccountEnabled(firstId, false)).rejects.toThrow('Select another ChatGPT account')
    await fixture.auth.selectAccount(secondId)
    status = await fixture.auth.setAccountEnabled(firstId, false)
    expect(status.activeAccountId).toBe(secondId)
    expect(status.accounts.find((account) => account.id === firstId)?.enabled).toBe(false)
  })

  it('keeps separate registrations even when verified identity and email match, and labels them distinctly', async () => {
    const fixture = harness()
    let status = await fixture.auth.beginAddAccount()
    await fixture.auth.confirmPendingAccount(status.pendingAccount!.id)
    status = await fixture.auth.beginAddAccount()
    status = await fixture.auth.confirmPendingAccount(status.pendingAccount!.id)
    expect(status.accounts).toHaveLength(2)
    expect(status.accounts.map((account) => account.email)).toEqual(['one@example.com', 'one@example.com'])
    expect(status.accounts[0].label).not.toBe(status.accounts[1].label)
    expect(new Set(status.accounts.map((account) => fixture.accounts.get(account.id)?.session.clientId)).size).toBe(2)
  })

  it('rejects an exact duplicate issued client registration', async () => {
    const fixture = harness()
    let status = await fixture.auth.beginAddAccount()
    await fixture.auth.confirmPendingAccount(status.pendingAccount!.id)
    fixture.forceNextIssuedClientId(fixture.issuedClientIds[0])
    await expect(fixture.auth.beginAddAccount()).rejects.toThrow('registration is already saved')
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
