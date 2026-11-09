import { afterEach, describe, expect, it, vi } from 'vitest'
import { OpenAIConnection } from '../electron/main/ai/openAIConnection'

const key = 'sk-test-only-not-a-real-api-key'
afterEach(() => vi.useRealTimers())
describe('OpenAI connection-only service', () => {
  it('distinguishes a provider spending cap from temporary throttling', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ error: { code: 'project_spend_limit_exceeded', message: key } }), { status: 429 }))
    const result = await new OpenAIConnection(request).test(key)
    expect(result).toMatchObject({ ok: false, message: expect.stringContaining('spending limit') })
    expect(JSON.stringify(result)).not.toContain(key)
  })
  it('uses only the fixed authenticated models endpoint and deduplicates IDs', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ object: 'list', data: [{ id: 'model-b' }, { id: 'model-a' }, { id: 'model-a' }] })))
    expect(await new OpenAIConnection(request).test(key)).toEqual({ ok: true, models: ['model-a', 'model-b'] })
    expect(request).toHaveBeenCalledWith('https://api.openai.com/v1/models', expect.objectContaining({ method: 'GET', headers: { Authorization: `Bearer ${key}` }, redirect: 'error', credentials: 'omit' }))
  })
  it.each([401, 403, 429, 500])('sanitizes HTTP %s without returning response bodies', async (status) => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(`error with ${key}`, { status }))
    const result = await new OpenAIConnection(request).test(key)
    expect(result).toMatchObject({ ok: false, kind: status === 401 ? 'invalid-key' : 'failed' })
    expect(JSON.stringify(result)).not.toContain(key)
  })
  it('sanitizes network failures and malformed responses', async () => {
    const request = vi.fn<typeof fetch>().mockRejectedValueOnce(new Error(key)).mockResolvedValueOnce(new Response(JSON.stringify({ unexpected: key })))
    const service = new OpenAIConnection(request)
    expect(JSON.stringify(await service.test(key))).not.toContain(key)
    expect(await service.test(key)).toMatchObject({ ok: false, kind: 'failed' })
  })
  it('aborts a stalled connection and cleans its timeout', async () => {
    vi.useFakeTimers()
    const request = vi.fn<typeof fetch>().mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    }))
    const result = new OpenAIConnection(request).test(key)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(await result).toMatchObject({ ok: false, message: expect.stringContaining('timed out') })
    expect(vi.getTimerCount()).toBe(0)
  })
})
