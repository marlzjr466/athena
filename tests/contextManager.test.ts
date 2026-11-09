// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { OpenAIProvider, providerError } from '../electron/main/ai/OpenAIProvider'
import OpenAI from 'openai'
import { contextDefaults, contextSettingsSchema, type ContextUsage } from '../shared/context'
import { modelLimits, tokenCost } from '../electron/main/ai/modelLimits'
import { limitToolOutput, summarizeLog } from '../electron/main/ai/toolOutput'
import type { StreamOptions } from '../electron/main/ai/AIProvider'
import type { ChatMessage } from '../shared/chat'

const usage = (input = 100, output = 20) => ({ input_tokens: input, output_tokens: output, total_tokens: input + output, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } })
const sse = (...events: unknown[]) => new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const done = (output: unknown[] = []) => ({ type: 'response.completed', response: { output, usage: usage() } })
const answer = () => sse({ type: 'response.output_text.delta', delta: 'Finished' }, done())
const input: ChatMessage[] = [{ id: 'user', role: 'user', content: 'Keep existing style. Fix the project and verify it.', status: 'complete', createdAt: 1 }]
const compacted = [{ role: 'user', content: input[0].content }, { type: 'compaction', id: 'cmp_1', encrypted_content: 'opaque-checkpoint' }]
const compaction = () => json({ id: 'cmp_1', object: 'response.compaction', output: compacted, usage: usage(800, 100) })
const contextError = () => json({ error: { code: 'context_length_exceeded', message: 'private raw diagnostic' } }, 400)
async function collect(request: typeof fetch, options: StreamOptions = {}, messages = input, model = 'gpt-5.6-sol') {
  const chunks = []
  for await (const chunk of new OpenAIProvider('sk-fake-test', model, request).streamMessage(messages, options)) chunks.push(chunk)
  return chunks
}
describe('model-aware bounded context management', () => {
  it('emits one settled response event without charging cumulative context notifications again', async () => {
    const onUsage = vi.fn(), onModelResponse = vi.fn(), beforeModelRequest = vi.fn()
    const request = vi.fn<typeof fetch>().mockResolvedValue(sse({ type: 'response.output_text.delta', delta: 'Verified' }, { type: 'response.completed', response: { output: [], usage: { ...usage(1000, 600), output_tokens_details: { reasoning_tokens: 500 } } } }))
    await collect(request, { onUsage, onModelResponse, beforeModelRequest })
    expect(onUsage.mock.calls.length).toBeGreaterThan(1)
    expect(onModelResponse).toHaveBeenCalledExactlyOnceWith({ inputTokens: 1000, outputTokens: 600, reasoningTokens: 500, estimated: false })
    expect(beforeModelRequest.mock.calls[0][2]).toMatchObject({ contextWindow: 1050000, maxOutputTokens: 128000, limitsVerified: true, outputLimitEnforced: true })
  })

  it('does not apply the former 100KB application cap to the selected million-token model', async () => {
    const request = vi.fn<typeof fetch>(async () => answer())
    await collect(request, {}, [...input, { ...input[0], id: 'next', content: 'code '.repeat(24000) }])
    expect(request).toHaveBeenCalledTimes(1)
  })
  it('labels malformed provider usage as estimated rather than refunding unknown tokens', async () => {
    const onModelResponse = vi.fn(), onUsage = vi.fn()
    const request = vi.fn<typeof fetch>().mockResolvedValue(sse({ type: 'response.output_text.delta', delta: 'Finished' }, { type: 'response.completed', response: { output: [], usage: { input_tokens: null, output_tokens: -1, total_tokens: 0 } } }))
    await collect(request, { onUsage, onModelResponse })
    expect(onModelResponse).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ estimated: true, inputTokens: expect.any(Number), outputTokens: expect.any(Number) }))
    expect(onUsage.mock.lastCall?.[0]).toMatchObject({ estimated: true })
    expect(onModelResponse.mock.lastCall?.[0].inputTokens).toBeGreaterThan(0)
  })
  it('compacts before the configured threshold and reuses the entire native canonical output', async () => {
    const request = vi.fn<typeof fetch>(async (url, init) => {
      const body = JSON.parse(init!.body as string)
      if (String(url).endsWith('/compact')) return compaction()
      expect(body.input).toEqual(compacted)
      expect(body.model).toBe('gpt-5.6-sol'); expect(body.reasoning.effort).toBe('medium')
      return answer()
    }), onCheckpoint = vi.fn(), readings: ContextUsage[] = []
    const history = [{ ...input[0], content: 'Historical constraints. '.repeat(45000) }, input[0]]
    const original = structuredClone(history)
    await collect(request, { effort: 'medium', contextSettings: { ...contextDefaults(), utilizationThreshold: 0.3 }, onCheckpoint, onUsage: (value) => readings.push(value) }, history)
    expect(history).toEqual(original)
    expect(request).toHaveBeenCalledTimes(2); expect(onCheckpoint).toHaveBeenCalledWith(compacted)
    expect(readings.some((value) => value.status === 'optimizing')).toBe(true)
    expect(readings.at(-1)).toMatchObject({ inputTokens: 900, outputTokens: 120, totalTokens: 1020, estimated: false, compactions: 1 })
  })
  it('recovers an API context error between tool batches without replaying a completed mutation', async () => {
    let round = 0
    const execute = vi.fn(async () => JSON.stringify({ ok: true, changes: [{ path: 'Button.tsx', id: 'change-1', status: 'applied' }] })), invalidate = vi.fn()
    const request = vi.fn<typeof fetch>(async (url, init) => {
      const body = JSON.parse(init!.body as string)
      if (String(url).endsWith('/compact')) {
        const calls = body.input.filter((item: any) => item.type === 'function_call'), results = body.input.filter((item: any) => item.type === 'function_call_output')
        expect(calls).toHaveLength(1); expect(results).toHaveLength(1); expect(results[0].call_id).toBe(calls[0].call_id)
        expect(results[0].output).toContain('change-1'); return compaction()
      }
      round++
      if (round === 1) return sse(done([{ type: 'function_call', name: 'create_file', arguments: '{}', call_id: 'write-1', id: 'fc_1', status: 'completed' }]))
      if (round === 2) return contextError()
      expect(body.input).toEqual(compacted); return answer()
    })
    await collect(request, { context: { attachments: [], repositoryText: '', sources: [], projectTools: { definitions: [{ name: 'create_file', description: 'test', parameters: { type: 'object', properties: {}, additionalProperties: false } }], assertAccess: () => {}, execute, invalidate } } })
    expect(execute).toHaveBeenCalledTimes(1); expect(invalidate).toHaveBeenCalledTimes(1); expect(round).toBe(3)
  })
  it('uses real application-level summarization for unsupported native compaction, preserving latest request', async () => {
    let round = 0
    const request = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(init!.body as string)
      if (!body.stream) {
        expect(body.tools).toBeUndefined(); expect(body.instructions).toContain('pending work')
        return json({ status: 'completed', output: [{ type: 'message', id: 'summary', role: 'assistant', content: [{ type: 'output_text', text: 'Objective: fix project. Preserve conventions. Pending: verify changes.', annotations: [] }], status: 'completed' }], usage: usage() })
      }
      if (++round === 1) return contextError()
      expect(body.input[0].content).toContain('Pending: verify changes')
      expect(body.input.at(-1).content).toBe(input[0].content)
      expect(body.input.some((item: any) => item.type === 'function_call')).toBe(false)
      return answer()
    })
    await collect(request, {}, input, 'gpt-4.1')
    expect(request).toHaveBeenCalledTimes(3)
  })
  it('recovers a transient subscription compaction stream without dropping the original request', async () => {
    let mainCalls = 0, summaryCalls = 0
    const diagnostics: Array<{ stage: string; kind: string; willRetry: boolean }> = []
    const request = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(init!.body as string)
      if (body.instructions.includes('continuation checkpoint')) {
        summaryCalls++
        if (summaryCalls === 1) return sse({ type: 'response.failed', response: { error: null, output: [] } })
        return sse({ type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', id: 'summary', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Objective: finish verification. Existing edits are preserved.', annotations: [] }] }], usage: usage() } })
      }
      if (++mainCalls === 1) return contextError()
      expect(body.input[0].content).toContain('Existing edits are preserved')
      expect(body.input.at(-1).content).toBe(input[0].content)
      return answer()
    })
    const chunks = []
    for await (const chunk of new OpenAIProvider('oauth-token', 'gpt-5.6-sol', request, undefined, true).streamMessage(input, {
      contextSettings: { ...contextDefaults(), maxStreamRecoveries: 1 }, onStreamDiagnostic: item => diagnostics.push(item),
    })) chunks.push(chunk)
    expect(chunks.at(-1)).toEqual({ type: 'done' })
    expect(summaryCalls).toBe(2)
    expect(diagnostics.find(item => item.stage === 'context_compaction')).toMatchObject({ kind: 'provider_failed', willRetry: true })
  })
  it('retries an output-limited checkpoint at low effort without losing the original request', async () => {
    let streams = 0, summaries = 0
    const request = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(init!.body as string)
      if (!body.stream) {
        summaries++
        expect(body.reasoning.effort).toBe('low')
        expect(body.instructions).toContain('under 700 words')
        if (summaries === 1) return json({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [{ type: 'reasoning', id: 'reason-1', summary: [] }], usage: usage(100, 4000) })
        return json({ status: 'completed', output: [{ type: 'message', id: 'summary-2', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Objective: preserve project changes. Pending: verify.', annotations: [] }] }], usage: usage() })
      }
      if (++streams === 1) return contextError()
      expect(body.input[0].content).toContain('Pending: verify')
      expect(body.input.at(-1).content).toBe(input[0].content)
      return answer()
    })
    await collect(request, { effort: 'high' }, input, 'gpt-6.1-sol')
    expect(summaries).toBe(2)
    expect(request).toHaveBeenCalledTimes(4)
  })
  it('never silently drops history when compaction is disabled or continuation attempts are exhausted', async () => {
    const request = vi.fn<typeof fetch>(async (url) => String(url).endsWith('/compact') ? compaction() : contextError())
    await expect(collect(request, { contextSettings: { ...contextDefaults(), automaticCompaction: false } })).rejects.toThrow('compaction disabled')
    expect(request).toHaveBeenCalledTimes(1); request.mockClear()
    await expect(collect(request, { contextSettings: { ...contextDefaults(), maxContinuations: 1 } })).rejects.toThrow('continuation limit')
    expect(request).toHaveBeenCalledTimes(3)
  })
  it('cancels compaction without publishing a late checkpoint or continuing the model/tool loop', async () => {
    const abort = new AbortController(), checkpoint = vi.fn()
    const request = vi.fn<typeof fetch>(async (url) => {
      if (String(url).endsWith('/compact')) { abort.abort(); return compaction() }
      return contextError()
    })
    expect(await collect(request, { signal: abort.signal, onCheckpoint: checkpoint })).toEqual([])
    expect(checkpoint).not.toHaveBeenCalled(); expect(request).toHaveBeenCalledTimes(2)
  })
  it('preflights optional spending caps using counted input and never starts a call over the allowance', async () => {
    const request = vi.fn<typeof fetch>(async (url) => { expect(String(url)).toContain('/input_tokens'); return json({ object: 'response.input_tokens', input_tokens: 1000 }) })
    await expect(collect(request, { contextSettings: { ...contextDefaults(), taskSpendLimitUsd: 0.01 } })).rejects.toThrow('spending limit reached')
    expect(request).toHaveBeenCalledTimes(1)
    request.mockClear()
    await expect(collect(request, { contextSettings: { ...contextDefaults(), taskSpendLimitUsd: 1 } }, input, 'unknown')).rejects.toThrow('pricing')
    expect(request).not.toHaveBeenCalled()
  })
  it('distinguishes context, credits, rate limits and output exhaustion without leaking server data', async () => {
    for (const [code, match] of [['context_length_exceeded', 'context window'], ['credit_balance_exhausted', 'credit balance'], ['rate_limit_exceeded', 'rate limit']] as const) {
      const error = providerError(new OpenAI.APIError(400, { code, message: 'private diagnostic' }, undefined, new Headers()))
      expect(error.message).toContain(match); expect(error.message).not.toContain('private diagnostic')
    }
    const request = vi.fn<typeof fetch>(async () => sse({ type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' }, usage: usage(), output: [] } }))
    await expect(collect(request, { generationSettings: { outputTokens: null, maxOutputContinuations: 0 } })).rejects.toThrow('output allowance')
    expect(request).toHaveBeenCalledTimes(1)
  })
  it('models have independent verified capacities/prices; unknown limits are explicitly conservative', () => {
    expect(modelLimits('gpt-5.6-sol')).toMatchObject({ context: 1050000, verified: true })
    expect(modelLimits('gpt-5.2-2025-12-11').context).toBe(400000)
    expect(modelLimits('gpt-5.2-chat-latest').context).toBe(128000)
    expect(modelLimits('unknown')).toMatchObject({ verified: false, nativeCompaction: false })
    expect(tokenCost(modelLimits('gpt-5.6-sol'), 300000, 1000)).toBeCloseTo(2.43)
    expect(contextSettingsSchema.safeParse({ maxContinuations: 100 }).success).toBe(false)
  })
  it('bounds escaped JSON tool results and preserves errors and final test summaries from large logs', () => {
    const log = `START\n${'ordinary output\n'.repeat(10000)}error TS2307 src/app.ts:12\nFAIL test suite\nSUMMARY: 1 failed`
    const summary = summarizeLog(log, 2000)
    expect(summary.length).toBeLessThanOrEqual(2000); expect(summary).toContain('TS2307'); expect(summary).toContain('SUMMARY: 1 failed')
    const result = limitToolOutput('\u0000'.repeat(100000), 2000)
    expect(result.length).toBeLessThanOrEqual(2000); expect(JSON.parse(result).truncated).toBe(true)
  })
})
