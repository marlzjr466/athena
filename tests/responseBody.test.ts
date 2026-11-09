// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { readResponseBytes } from '../electron/main/ai/responseBody'

describe('bounded response downloads', () => {
  it('reads bounded chunks exactly and releases the reader', async () => {
    const response = new Response(new Uint8Array([1, 2, 3]))
    expect(await readResponseBytes(response, 3, new AbortController().signal)).toEqual(new Uint8Array([1, 2, 3]))
    expect(response.body!.locked).toBe(false)
  })
  it('cancels an oversized download and releases the reader', async () => {
    const cancel = vi.fn()
    const response = new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(20)) }, cancel }))
    await expect(readResponseBytes(response, 10, new AbortController().signal)).rejects.toThrow('exceeds limit')
    expect(cancel).toHaveBeenCalledOnce(); expect(response.body!.locked).toBe(false)
  })
  it('interrupts a stalled body after response headers arrive', async () => {
    const abort = new AbortController(), cancel = vi.fn()
    const response = new Response(new ReadableStream({ cancel }))
    const pending = readResponseBytes(response, 10, abort.signal)
    const check = expect(pending).rejects.toThrow()
    abort.abort(); await check
    expect(cancel).toHaveBeenCalledOnce(); expect(response.body!.locked).toBe(false)
  })
})
