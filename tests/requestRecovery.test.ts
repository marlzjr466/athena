// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { recoverProviderRequest } from '../electron/main/ai/requestRecovery'
import { ContinuationController } from '../electron/main/ai/continuationController'
import { StreamFault } from '../electron/main/ai/streamRecovery'

afterEach(() => vi.useRealTimers())
describe('shared API transport recovery', () => {
  it('bounds nested socket failures and preserves sanitized recovery diagnostics', async () => {
    vi.useFakeTimers()
    const cause = Object.assign(new Error('private hostname'), { code: 'UND_ERR_CONNECT_TIMEOUT' })
    const request = vi.fn(async () => { throw new TypeError('private data', { cause: new Error('wrapper', { cause }) }) })
    const onStreamDiagnostic = vi.fn(), continuation = new ContinuationController({ maxStreamRecoveries: 1 })
    const pending = recoverProviderRequest({ continuation, onStreamDiagnostic, reliabilityIdentity: { provider: 'third-party', model: 'fixture' } }, new AbortController().signal, request)
    const failed = expect(pending).rejects.toThrow()
    await vi.runAllTimersAsync(); await failed
    expect(request).toHaveBeenCalledTimes(2)
    expect(onStreamDiagnostic.mock.calls.map(([entry]) => [entry.kind, entry.willRetry])).toEqual([['connection_timeout', true], ['connection_timeout', false]])
    expect(JSON.stringify(onStreamDiagnostic.mock.calls)).not.toMatch(/private|hostname/)
    expect(continuation.state.toolCalls).toBe(0)
  })
  it('preserves ambiguous outcomes instead of automatically resubmitting', async () => {
    const request = vi.fn(async () => { throw new StreamFault('provider_failed', 'No structured failure code') })
    await expect(recoverProviderRequest({}, new AbortController().signal, request)).rejects.toThrow('No structured failure code')
    expect(request).toHaveBeenCalledOnce()
  })
  it('recovers a temporary server failure without consuming model continuation or tool rounds', async () => {
    vi.useFakeTimers()
    const request = vi.fn<() => Promise<Response>>().mockResolvedValueOnce(new Response('', { status: 503 })).mockResolvedValueOnce(new Response('ok'))
    const continuation = new ContinuationController(), onModelRequestUnresolved = vi.fn()
    const pending = recoverProviderRequest({ continuation, onModelRequestUnresolved }, new AbortController().signal, request)
    await vi.runAllTimersAsync()
    expect(await (await pending).text()).toBe('ok')
    expect(continuation.state).toMatchObject({ transportRecoveries: 1, continuations: 0, toolCalls: 0 })
    expect(onModelRequestUnresolved).toHaveBeenCalledOnce()
  })
  it.each([400, 401, 402, 403, 429])('does not retry HTTP %i', async status => {
    const request = vi.fn(async () => new Response('', { status }))
    expect((await recoverProviderRequest({}, new AbortController().signal, request)).status).toBe(status)
    expect(request).toHaveBeenCalledOnce()
  })
  it('respects a provider-requested delay instead of retrying sooner', async () => {
    const request = vi.fn(async () => new Response('', { status: 503, headers: { 'Retry-After': '120' } }))
    expect((await recoverProviderRequest({}, new AbortController().signal, request)).status).toBe(503)
    expect(request).toHaveBeenCalledOnce()
  })
  it('honors disabled recovery and cancellation during backoff', async () => {
    const request = vi.fn(async () => new Response('', { status: 503 }))
    await recoverProviderRequest({ continuation: new ContinuationController({ safeTaskRecovery: false }) }, new AbortController().signal, request)
    expect(request).toHaveBeenCalledOnce()
    const abort = new AbortController()
    const pending = recoverProviderRequest({}, abort.signal, request)
    const failure = expect(pending).rejects.toThrow()
    abort.abort(new Error('User cancelled'))
    await failure
    expect(request).toHaveBeenCalledTimes(2)
  })
})
