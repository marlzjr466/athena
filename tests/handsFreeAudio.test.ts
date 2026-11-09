import { afterEach, describe, expect, it, vi } from 'vitest'
import { handsFreeAudio } from '../src/services/speech/handsFreeAudio'
import type { AIOwnership } from '../shared/aiOwnership'
const owner: AIOwnership = { origin: 'athena-local', sessionId: crypto.randomUUID(), correlationId: crypto.randomUUID() }
afterEach(() => vi.useRealTimers())
describe('incremental floating local audio ownership', () => {
  it('routes all chunks through the existing speech API, never invokes another provider', async () => {
    const id = crypto.randomUUID(), request = { id, text: 'Hello.', ownership: owner }
    const api = { speakHandsFree: vi.fn(async () => ({ ok: true, id, streaming: true, index: 0, bytes: new Uint8Array([1]) })), nextHandsFreeSpeech: vi.fn().mockResolvedValueOnce({ ok: true, id, streaming: true, index: 1, bytes: new Uint8Array([2]) }).mockResolvedValueOnce({ ok: true, id, done: true }) }
    const chunks = []
    for await (const result of handsFreeAudio(api, request, () => true)) chunks.push(result.bytes?.[0])
    expect(chunks).toEqual([1, 2]); expect(api.speakHandsFree).toHaveBeenCalledOnce()
    expect(api.nextHandsFreeSpeech.mock.calls[0][0]).toEqual({ id, index: 1, ownership: owner })
  })
  it('rejects stale/foreign audio before it can be played', async () => {
    const api = { speakHandsFree: vi.fn(async () => ({ ok: true, id: 'wrong', bytes: new Uint8Array([1]) })), nextHandsFreeSpeech: vi.fn() }
    const iterator = handsFreeAudio(api, { id: 'expected', text: 'Hello', ownership: owner }, () => true)
    await expect(iterator.next()).rejects.toThrow('Mismatched')
    expect(api.nextHandsFreeSpeech).not.toHaveBeenCalled()
  })
  it('retains the legacy full-segment response for other local engines', async () => {
    const api = { speakHandsFree: vi.fn(async () => ({ ok: true, bytes: new Uint8Array([3]) })), nextHandsFreeSpeech: vi.fn() }
    const iterator = handsFreeAudio(api, { id: 'test', text: 'Hello', ownership: owner }, () => true)
    expect((await iterator.next()).value?.bytes).toEqual(new Uint8Array([3]))
    expect((await iterator.next()).done).toBe(true); expect(api.nextHandsFreeSpeech).not.toHaveBeenCalled()
  })
})
