// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { OpenAITranscriptionService, TRANSCRIPTION_MODEL } from '../electron/main/voice/transcriptionService'
const clip = () => ({ id: crypto.randomUUID(), sessionId: crypto.randomUUID(), mimeType: 'audio/webm' as const, bytes: new Uint8Array([1, 2, 3]) })
function mockRequest(response: Response) {
  // The SDK probes a data URL once to discover its fetch implementation's FormData support.
  return vi.fn<typeof fetch>().mockImplementation(async (url) => String(url) === 'data:,' ? new Response('') : response.clone())
}
describe('OpenAI transcription adapter', () => {
  it('identifies a project spending limit without exposing the provider response', async () => {
    const request = mockRequest(new Response(JSON.stringify({ error: { code: 'project_spend_limit_exceeded', message: 'private recording' } }), { status: 429, headers: { 'content-type': 'application/json' } }))
    await expect(new OpenAITranscriptionService(async () => 'sk-fixture', request).transcribe(clip(), new AbortController().signal)).rejects.toThrow('spending limit')
  })
  it('uploads bounded audio with a filename, no chat history, no retries and a main-only credential', async () => {
    const request = mockRequest(new Response(JSON.stringify({ text: '  Hi Athena.  ' }), { headers: { 'content-type': 'application/json' } }))
    const provider = new OpenAITranscriptionService(async () => 'sk-test-not-real', request)
    expect(await provider.transcribe(clip(), new AbortController().signal)).toBe('Hi Athena.')
    const uploads = request.mock.calls.filter(([url]) => String(url).startsWith('https:'))
    expect(uploads).toHaveLength(1)
    const [url, options] = uploads[0]
    expect(String(url)).toBe('https://api.openai.com/v1/audio/transcriptions')
    expect(options?.redirect).toBe('error')
    const body = options!.body as FormData
    expect(body.get('model')).toBe(TRANSCRIPTION_MODEL)
    expect(body.get('response_format')).toBe('json')
    expect((body.get('file') as File).name).toBe('speech.webm')
    expect([...body.keys()].sort()).toEqual(['file', 'model', 'response_format'])
  })
  it.each([[401, 'invalid_api_key', 'key is invalid'], [429, 'insufficient_quota', 'credits or quota'], [429, 'rate_limit_exceeded', 'rate limit'], [404, 'model_not_found', 'cannot access'], [400, 'invalid_audio', 'decode'], [500, 'unknown', 'failed or timed out']])('sanitizes %s/%s without retrying a paid upload', async (status, code, message) => {
    const request = mockRequest(new Response(JSON.stringify({ error: { message: 'private audio and secret', code } }), { status: status as number, headers: { 'content-type': 'application/json' } }))
    const result = new OpenAITranscriptionService(async () => 'sk-test-not-real', request).transcribe(clip(), new AbortController().signal)
    await expect(result).rejects.toThrow(message as string)
    await expect(result).rejects.not.toThrow('private')
    expect(request.mock.calls.filter(([url]) => String(url).startsWith('https:'))).toHaveLength(1)
  })
  it('does not upload after cancellation during credential retrieval', async () => {
    const request = vi.fn<typeof fetch>(), abort = new AbortController()
    const provider = new OpenAITranscriptionService(async () => { abort.abort(); return 'sk-test-not-real' }, request)
    await expect(provider.transcribe(clip(), abort.signal)).rejects.toThrow()
    expect(request).not.toHaveBeenCalled()
  })
})
