// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LlamaCppProvider } from '../electron/main/ai/LlamaCppProvider'
import { continuationFor } from '../electron/main/ai/continuationController'
import { localAIDefaults } from '../shared/localAI'
import { contextDefaults } from '../shared/context'
import type { LlamaValidation } from '../shared/llamaLongContext'
import type { StreamOptions } from '../electron/main/ai/AIProvider'

vi.mock('../electron/main/ai/llamaServer', () => ({ ensureLlamaServer: vi.fn(), llamaRequestFinished: vi.fn(), llamaServerEndpoint: () => 'http://127.0.0.1:9999' }))
vi.mock('../electron/main/ai/contextEngineRuntime', () => ({ rememberPromptUsage: vi.fn() }))
vi.mock('../electron/main/logger', () => ({ log: vi.fn() }))
const validation: LlamaValidation = { runtime: { executable: '/fixture/llama', version: 'fixture' }, model: { id: 'local-fixture', gguf: '/fixture/model', family: 'fixture', quantization: 'fixture', trainedContext: 32768, ollamaModelPreserved: 'fixture' }, checkedAt: '', validatedMaximum: 32768, levels: [{ id: 'standard', requestedTokens: 32768, yarnFactor: null, loaded: true, passed: true }], limitations: [] }
const response = (finish: string | null, text = 'Observed text') => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: finish }], usage: { prompt_tokens: 100, completion_tokens: 10 } })}\n\ndata: [DONE]\n\n`)
async function collect(options: StreamOptions = {}) {
  const chunks = []
  const provider = new LlamaCppProvider('local-fixture', { ...localAIDefaults(), contextLength: 32768, maxOutputTokens: 4096 }, validation)
  for await (const chunk of provider.streamMessage([{ id: 'request', role: 'user', content: 'Explain the unfinished step.', createdAt: 1, status: 'complete' }], options)) chunks.push(chunk)
  return chunks
}
afterEach(() => vi.unstubAllGlobals())
describe('text-only llama.cpp uses shared continuation', () => {
  it('continues explicit truncation and preserves previous text with the validated model window', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(response('length', 'First part.')).mockResolvedValueOnce(response('stop', 'Final part.'))
    vi.stubGlobal('fetch', request)
    const options: StreamOptions = {}, control = continuationFor(options)
    expect((await collect(options)).at(-1)).toEqual({ type: 'done' })
    expect(request).toHaveBeenCalledTimes(2)
    const body = JSON.parse(request.mock.calls[1][1]!.body as string)
    expect(body.messages.some((message: { content: string }) => message.content === 'First part.')).toBe(true)
    expect(control.state).toMatchObject({ continuations: 1, contextWindow: 32768, toolCalls: 0 })
  })
  it('does not restart a complete local response', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(response('stop'))
    vi.stubGlobal('fetch', request)
    await collect()
    expect(request).toHaveBeenCalledTimes(1)
  })
  it('preserves the configured continuation opt-out', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(response('length'))
    vi.stubGlobal('fetch', request)
    await expect(collect({ contextSettings: { ...contextDefaults(), automaticContinuation: false } })).rejects.toThrow('allowance')
    expect(request).toHaveBeenCalledTimes(1)
  })
  it('does not report an interrupted stream as complete or retry it', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(response(null))
    vi.stubGlobal('fetch', request)
    await expect(collect()).rejects.toThrow('final completion event')
    expect(request).toHaveBeenCalledTimes(1)
  })
})
