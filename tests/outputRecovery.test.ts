// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import OpenAI from 'openai'
import type { ResponseOutputItem } from 'openai/resources/responses/responses'
import { OpenAIProvider, providerError } from '../electron/main/ai/OpenAIProvider'
import { recoverableOutput } from '../electron/main/ai/outputRecovery'
import { isContextError } from '../electron/main/ai/contextManager'
import type { ProjectTools, StreamOptions } from '../electron/main/ai/AIProvider'
import { generationDefaults, generationSettingsSchema } from '../shared/generation'
import { effectiveEffort, outputBudget } from '../shared/outputPolicy'
import { contextDefaults } from '../shared/context'
import { defaultSettings, settingsSchema } from '../shared/settings'

vi.mock('../electron/main/logger', () => ({ log: vi.fn() }))
const sse = (...events: unknown[]) => new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
const usage = { input_tokens: 100, output_tokens: 32000, total_tokens: 32100, output_tokens_details: { reasoning_tokens: 31000 }, input_tokens_details: { cached_tokens: 0 } }
const incomplete = (output: unknown[] = [], reason = 'max_output_tokens') => sse({ type: 'response.incomplete', response: { incomplete_details: { reason }, usage, output } })
const call = (id: string, status = 'completed') => ({ type: 'function_call', name: 'create_file', arguments: '{"path":"Button.tsx","content":"safe"}', call_id: id, id: `fc_${id}`, status })
const done = (output: unknown[] = []) => ({ type: 'response.completed', response: { output, usage: { ...usage, output_tokens: 50, total_tokens: 150, output_tokens_details: { reasoning_tokens: 10 } } } })
const answer = () => sse({ type: 'response.output_text.delta', delta: 'Verified result.' }, done())
const message = { id: 'user', role: 'user' as const, content: 'Create a component and verify it.', status: 'complete' as const, createdAt: 1 }
async function collect(request: typeof fetch, options: StreamOptions = {}, model = 'gpt-5.6-luna') {
  const chunks = []
  for await (const chunk of new OpenAIProvider('sk-fake', model, request).streamMessage([message], options)) chunks.push(chunk)
  return chunks
}
function project() {
  const execute = vi.fn(async () => '{"ok":true,"changeId":"saved-change"}')
  const tools: ProjectTools = { execute, assertAccess: vi.fn(), continuation: vi.fn(), invalidate: vi.fn(), definitions: [{ name: 'create_file', description: 'Create file', parameters: { type: 'object', properties: {}, additionalProperties: false } }] }
  return { tools, execute, context: { attachments: [], repositoryText: '', sources: [], projectTools: tools } }
}

describe('output budgets and safe automatic continuation', () => {
  it('uses model capabilities, preserves explicit caps and validates persisted configuration', () => {
    expect(generationDefaults()).toEqual({ outputTokens: null, maxOutputContinuations: 3 })
    expect(settingsSchema.parse({}).aiGeneration).toEqual(generationDefaults())
    expect(settingsSchema.parse({ ...defaultSettings, aiGeneration: { outputTokens: 50000, maxOutputContinuations: 2 } }).aiGeneration.outputTokens).toBe(50000)
    for (const value of [0, -1, NaN, Infinity, 128001]) expect(generationSettingsSchema.safeParse({ outputTokens: value }).success).toBe(false)
    expect(generationSettingsSchema.safeParse({ maxOutputContinuations: 9 }).success).toBe(false)
    expect([0, 1, 2, 3].map((attempt) => outputBudget('gpt-5.6-luna', null, attempt))).toEqual([32768, 65536, 128000, 128000])
    expect(outputBudget('gpt-4.1', 100000)).toBe(32768)
    expect(outputBudget('unknown-model', 100000)).toBe(4096)
    expect(outputBudget('gpt-5.6-luna', 5000, 3)).toBe(5000)
    expect(effectiveEffort('gpt-4.1', 'auto')).toBe('auto')
    expect(effectiveEffort('gpt-5.6-luna', 'auto')).toBe('medium')
    expect(effectiveEffort('gpt-5.6-luna', 'auto', 1)).toBe('low')
    expect(effectiveEffort('gpt-5.6-luna', 'xhigh', 3)).toBe('xhigh')
  })
  it('continues reasoning-heavy incomplete responses, records actual usage, and lowers only Auto effort', async () => {
    const onUsage = vi.fn(), onRecovery = vi.fn(), onCheckpoint = vi.fn()
    const bodies: any[] = []
    const request = vi.fn<typeof fetch>(async (_url, init) => { bodies.push(JSON.parse(init!.body as string)); return bodies.length === 1 ? incomplete() : answer() })
    const chunks = await collect(request, { onUsage, onRecovery, onCheckpoint })
    expect(bodies.map((body) => body.max_output_tokens)).toEqual([32768, 65536])
    expect(bodies.map((body) => body.reasoning.effort)).toEqual(['medium', 'low'])
    expect(bodies[1].instructions).toContain('Do not repeat completed or denied operations')
    expect(bodies[1].input[0].content).toBe(message.content)
    expect(bodies[1].store).toBe(false); expect(bodies[1].max_tokens).toBeUndefined(); expect(bodies[1].max_completion_tokens).toBeUndefined()
    expect(onUsage.mock.calls.some(([usage]) => usage.lastResponse?.reasoningTokens === 31000 && usage.lastResponse?.incompleteReason === 'max_output_tokens')).toBe(true)
    expect(onUsage.mock.lastCall![0]).toMatchObject({ reasoningTokens: 31010, inputTokens: 200, outputTokens: 32050 })
    expect(onRecovery.mock.calls[0][0]).toMatchObject({ attempts: 1, continuing: true, effort: 'low' })
    expect(onRecovery.mock.lastCall![0].continuing).toBe(false)
    expect(onCheckpoint).toHaveBeenCalled(); expect(chunks.at(-1)).toEqual({ type: 'done' })
  })
  it.each(['medium', 'high', 'xhigh'] as const)('retains explicit %s reasoning and an explicit output cap during recovery', async (effort) => {
    const request = vi.fn<typeof fetch>(async (_url, init): Promise<Response> => {
      const body = JSON.parse(init!.body as string)
      expect(body.reasoning.effort).toBe(effort); expect(body.max_output_tokens).toBe(6000)
      return request.mock.calls.length === 1 ? incomplete() : answer()
    })
    await collect(request, { effort, generationSettings: { outputTokens: 6000, maxOutputContinuations: 1 } })
    expect(request).toHaveBeenCalledTimes(2)
  })
  it('omits unsupported reasoning on nonreasoning models and rejects unsupported explicit choices', async () => {
    const request = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(init!.body as string)
      expect(body.max_output_tokens).toBe(8192); expect(body.reasoning).toBeUndefined()
      return answer()
    })
    await collect(request, {}, 'gpt-4.1')
    await expect(collect(request, { effort: 'high' }, 'gpt-4.1')).rejects.toThrow('does not support')
    expect(request).toHaveBeenCalledTimes(1)
  })
  it('preserves completed calls/results, discards every interrupted call, and checkpoints subsequent results', async () => {
    const f = project(), checkpoint = vi.fn(), bodies: any[] = []
    const request = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(init!.body as string); bodies.push(body)
      if (bodies.length === 1) return sse(done([call('executed')]))
      if (bodies.length === 2) return incomplete([call('discarded'), { ...call('truncated', 'incomplete'), arguments: '{"path":' }])
      expect(body.input.some((item: any) => item.call_id === 'discarded' || item.call_id === 'truncated')).toBe(false)
      expect(body.input.find((item: any) => item.type === 'function_call_output' && item.call_id === 'executed').output).toContain('saved-change')
      if (bodies.length === 3) return sse(done([{ ...call('new-operation'), arguments: '{"path":"Other.tsx","content":"safe"}' }]))
      return answer()
    })
    await collect(request, { context: f.context, onCheckpoint: checkpoint })
    expect(f.execute).toHaveBeenCalledTimes(2); expect(f.tools.continuation).toHaveBeenCalledTimes(1)
    expect(checkpoint.mock.lastCall![0].filter((item: any) => item.type === 'function_call_output')).toHaveLength(2)
    expect(bodies).toHaveLength(4)
  })
  it('never executes unfinished tool arguments even if a provider labels the response completed', async () => {
    const f = project(), request = vi.fn<typeof fetch>(async () => sse(done([call('bad', 'incomplete')])))
    await expect(collect(request, { context: f.context })).rejects.toThrow('unfinished tool arguments')
    expect(f.execute).not.toHaveBeenCalled()
  })
  it('retains only completed encrypted reasoning and labels unfinished text as a draft', () => {
    const reasoning = { type: 'reasoning', id: 'r1', summary: [], encrypted_content: 'opaque' } as ResponseOutputItem
    expect(recoverableOutput([reasoning], new Set(), '')).toEqual([])
    expect(recoverableOutput([reasoning], new Set(['r1']), '')).toEqual([reasoning])
    const recovered = recoverableOutput([reasoning, call('partial') as ResponseOutputItem], new Set(['r1']), 'Partial text')
    expect(recovered).toEqual([{ role: 'assistant', content: '[Unfinished response draft; not a completed task]\nPartial text' }])
  })
  it('bounds continuations without treating incomplete work as done', async () => {
    const onRecovery = vi.fn(), request = vi.fn<typeof fetch>(async () => incomplete())
    await expect(collect(request, { onRecovery, generationSettings: { outputTokens: null, maxOutputContinuations: 2 } })).rejects.toThrow('task remains unfinished')
    expect(request).toHaveBeenCalledTimes(3)
    expect(onRecovery.mock.lastCall![0]).toMatchObject({ attempts: 2, continuing: false })
  })
  it('does not retry content filtering or network-truncated streams as output exhaustion', async () => {
    const request = vi.fn<typeof fetch>(async () => incomplete([], 'content_filter'))
    await expect(collect(request)).rejects.toThrow('other than output length')
    expect(request).toHaveBeenCalledTimes(1)
    await expect(collect(async () => sse({ type: 'response.output_text.delta', delta: 'broken' }))).rejects.toThrow('before a completion event')
  })
  it('honors cancellation between recovery and the next request', async () => {
    const abort = new AbortController(), f = project()
    const request = vi.fn<typeof fetch>(async () => incomplete([call('not-executed')]))
    await collect(request, { context: f.context, signal: abort.signal, onRecovery: () => abort.abort() })
    expect(request).toHaveBeenCalledTimes(1); expect(f.execute).not.toHaveBeenCalled()
  })
  it('checks the same task spending cap again before a recovery request', async () => {
    const request = vi.fn<typeof fetch>(async (url) => String(url).endsWith('/input_tokens')
      ? new Response(JSON.stringify({ input_tokens: 100 }), { headers: { 'content-type': 'application/json' } })
      : incomplete())
    await expect(collect(request, { contextSettings: { ...contextDefaults(), taskSpendLimitUsd: 0.06 } })).rejects.toThrow('spending limit reached')
    expect(request.mock.calls.filter(([url]) => !String(url).endsWith('/input_tokens'))).toHaveLength(1)
  })
  it('keeps output parameter errors, context, credits, rate limiting and network errors distinct', () => {
    const apiError = (code: string, message = 'private diagnostic') => new OpenAI.APIError(400, { code, message }, undefined, new Headers())
    expect(isContextError(apiError('invalid_value', 'maximum output tokens exceeded'))).toBe(false)
    for (const [code, label] of [['invalid_value', 'generation setting'], ['context_length_exceeded', 'context window'], ['credit_balance_exhausted', 'credit balance'], ['rate_limit_exceeded', 'rate limit']] as const) {
      expect(providerError(apiError(code)).message).toContain(label)
      expect(providerError(apiError(code)).message).not.toContain('private diagnostic')
    }
    expect(providerError(new OpenAI.APIConnectionError({})).message).toContain('internet connection')
  })
})
