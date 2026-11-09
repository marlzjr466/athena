import { describe, expect, it, vi } from 'vitest'
import { AIConfiguration } from '../electron/main/ai/aiConfiguration'
import type { AICredential, CredentialStore } from '../electron/main/ai/credentialStore'
import type { ConnectionTester } from '../electron/main/ai/openAIConnection'

const key = 'sk-test-only-not-a-real-api-key'
const replacement = 'sk-replacement-not-a-real-api-key'
function fixture() {
  let saved: AICredential | null = null
  const vault: CredentialStore = {
    read: vi.fn(async () => saved && structuredClone(saved)),
    write: vi.fn(async (value) => { saved = structuredClone(value) }),
    remove: vi.fn(async () => { saved = null }),
  }
  const tester: ConnectionTester = { test: vi.fn<ConnectionTester['test']>(async () => ({ ok: true, models: ['model-a', 'model-b'] })) }
  const service = new AIConfiguration(vault, tester)
  return { service, vault, tester, saved: () => saved }
}
describe('Phase 1 AI activation', () => {
  it('starts disabled and testing alone never saves or activates', async () => {
    const f = fixture()
    expect((await f.service.getStatus()).status.active).toBe(false)
    const tested = await f.service.test({ apiKey: key })
    expect(tested.ok).toBe(true)
    expect(tested.status.active).toBe(false)
    expect(f.vault.write).not.toHaveBeenCalled()
  })
  it('verifies before secure save and never exposes the saved key', async () => {
    const f = fixture()
    const result = await f.service.activate({ apiKey: key })
    expect(result.status.active).toBe(true)
    expect(f.saved()?.apiKey).toBe(key)
    expect(vi.mocked(f.tester.test).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(f.vault.write).mock.invocationCallOrder[0])
    expect(JSON.stringify(result)).not.toContain(key)
    expect(JSON.stringify(await f.service.getStatus())).not.toContain(key)
  })
  it('can use an explicitly selected API search model before a conversation model is chosen', async () => {
    const f = fixture()
    const result = await f.service.activate({ apiKey: key })
    expect(result.status.model).toBeNull()
    expect(await f.service.getActiveConfiguration('model-b')).toEqual({ apiKey: key, model: 'model-b' })
    expect((await f.service.getStatus()).status.model).toBeNull()
  })
  it('persists the key and selected model across service restarts', async () => {
    const f = fixture()
    await f.service.activate({ apiKey: key })
    await f.service.selectModel({ model: 'model-b' })
    const restarted = new AIConfiguration(f.vault, f.tester)
    expect((await restarted.getStatus()).status).toMatchObject({ active: true, hasKey: true, model: 'model-b' })
    await restarted.test()
    expect(f.tester.test).toHaveBeenLastCalledWith(key)
  })
  it('rejects invalid keys and preserves a working key on failed replacement', async () => {
    const f = fixture()
    vi.mocked(f.tester.test).mockResolvedValueOnce({ ok: false, kind: 'invalid-key', message: 'Invalid API key.' })
    expect((await f.service.activate({ apiKey: key })).status.active).toBe(false)
    expect(f.saved()).toBeNull()
    await f.service.activate({ apiKey: key })
    vi.mocked(f.tester.test).mockResolvedValueOnce({ ok: false, kind: 'invalid-key', message: 'Invalid API key.' })
    expect((await f.service.activate({ apiKey: replacement })).ok).toBe(false)
    expect(f.saved()?.apiKey).toBe(key)
    expect((await f.service.getStatus()).status.active).toBe(true)
  })
  it('does not trust a previous test when saving a different key', async () => {
    const f = fixture()
    await f.service.test({ apiKey: key })
    vi.mocked(f.tester.test).mockResolvedValueOnce({ ok: false, kind: 'invalid-key', message: 'Invalid API key.' })
    expect((await f.service.activate({ apiKey: replacement })).ok).toBe(false)
    expect(f.tester.test).toHaveBeenLastCalledWith(replacement)
    expect(f.saved()).toBeNull()
  })
  it('replaces and removes atomically without retaining activation after restart', async () => {
    const f = fixture()
    await f.service.activate({ apiKey: key })
    expect((await f.service.activate({ apiKey: replacement })).ok).toBe(true)
    expect(f.saved()?.apiKey).toBe(replacement)
    expect((await f.service.remove()).status).toMatchObject({ active: false, hasKey: false, model: null, models: [] })
    expect(f.saved()).toBeNull()
    expect((await new AIConfiguration(f.vault, f.tester).getStatus()).status.active).toBe(false)
  })
  it('never claims activation if Keychain save fails, nor removal if deletion fails', async () => {
    const f = fixture()
    vi.mocked(f.vault.write).mockRejectedValueOnce(new Error(`sensitive ${key}`))
    const failed = await f.service.activate({ apiKey: key })
    expect(failed.ok).toBe(false); expect(failed.status.active).toBe(false)
    expect(JSON.stringify(failed)).not.toContain(key)
    await f.service.activate({ apiKey: key })
    vi.mocked(f.vault.remove).mockRejectedValueOnce(new Error(`sensitive ${key}`))
    const removal = await f.service.remove()
    expect(removal.ok).toBe(false); expect(removal.status.hasKey).toBe(true)
    expect(JSON.stringify(removal)).not.toContain(key)
  })
  it('removes even malformed stored credentials without needing to read them', async () => {
    const f = fixture()
    vi.mocked(f.vault.read).mockRejectedValue(new Error('unreadable'))
    expect((await f.service.getStatus()).ok).toBe(false)
    expect((await f.service.remove()).ok).toBe(true)
  })
  it('deactivates a revoked saved key and persists that state', async () => {
    const f = fixture()
    await f.service.activate({ apiKey: key })
    vi.mocked(f.tester.test).mockResolvedValueOnce({ ok: false, kind: 'invalid-key', message: 'Invalid API key.' })
    expect((await f.service.test()).status.active).toBe(false)
    expect((await new AIConfiguration(f.vault, f.tester).getStatus()).status.active).toBe(false)
  })
  it('validates keys and model choices at the main-process boundary', async () => {
    const f = fixture()
    for (const value of [null, {}, { apiKey: 3 }, { apiKey: 'short' }, { apiKey: `${key}\nInjected: bad` }, { apiKey: key, url: 'https://evil.example' }]) {
      expect((await f.service.activate(value)).ok).toBe(false)
    }
    expect(f.tester.test).not.toHaveBeenCalled()
    expect((await f.service.selectModel({ model: 'model-a' })).ok).toBe(false)
    await f.service.activate({ apiKey: key })
    expect((await f.service.selectModel({ model: 'unlisted' })).ok).toBe(false)
    expect((await f.service.selectModel({ model: 'model-a' })).ok).toBe(true)
  })
  it('serializes removal behind in-flight activation so no key reappears afterward', async () => {
    const f = fixture()
    let finish!: (value: { ok: true; models: string[] }) => void
    vi.mocked(f.tester.test).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    const activation = f.service.activate({ apiKey: key })
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    const removal = f.service.remove()
    finish({ ok: true, models: ['model-a'] })
    await activation
    expect((await removal).status.active).toBe(false)
    expect(f.saved()).toBeNull()
  })
})
