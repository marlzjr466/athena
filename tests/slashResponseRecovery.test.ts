// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { OpenAIProvider } from '../electron/main/ai/OpenAIProvider'
import type { StreamOptions } from '../electron/main/ai/AIProvider'
import { modelLimits } from '../shared/modelLimits'
import { modelCapabilities } from '../shared/conversations'
import { ResponseAccumulator } from '../electron/main/ai/responseAccumulator'
import type { ResponseStreamEvent } from 'openai/resources/responses/responses'
vi.mock('../electron/main/logger', () => ({ log: vi.fn() }))

const sse = (...events: unknown[]) => new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
const finished = (output: unknown[] = []) => ({ type: 'response.completed', response: { status: 'completed', output } })
const item = (value: unknown, index = 0) => ({ type: 'response.output_item.done', output_index: index, item: value })
const text = (value: string) => ({ type: 'message', id: 'msg', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: value, annotations: [] }] })
const reasoning = { type: 'reasoning', id: 'reason', summary: [], encrypted_content: 'opaque-not-visible' }
const call = { type: 'function_call', id: 'fc', call_id: 'read-1', namespace: 'athena', name: 'read_file', arguments: '{"path":"skills/platform-init/prompt.md"}', status: 'completed' }
const message = { id: 'u', role: 'user' as const, content: 'Complete platform-init. Preserve all requirements.', status: 'complete' as const, createdAt: 1 }
const contextError = () => new Response(JSON.stringify({ error: { code: 'context_length_exceeded' } }), { status: 400 })
async function collect(request: typeof fetch, options: StreamOptions = {}) {
  const chunks = []
  for await (const chunk of new OpenAIProvider('test-only', 'gpt-6-sol', request, undefined, true).streamMessage([message], { effort: 'high', ...options })) chunks.push(chunk)
  return chunks
}
describe('live-shape slash response regressions', () => {
  it('uses verified Sol limits and supports the selected effort rather than prematurely compacting', async () => {
    expect(modelLimits('gpt-6-sol')).toMatchObject({ context: 1050000, output: 128000, verified: true })
    expect(modelCapabilities('gpt-6-sol').efforts).toContain('high')
    const request = vi.fn<typeof fetch>(async (_url, init) => {
      expect(JSON.parse(init!.body as string)).toMatchObject({ reasoning: { effort: 'high' }, stream: true, store: false })
      return sse(item(text('Ready')), finished())
    })
    expect(await collect(request)).toEqual([{ type: 'text', text: 'Ready' }, { type: 'done' }])
    expect(request).toHaveBeenCalledOnce()
  })
  it('executes completed SSE tools once even when the terminal snapshot is empty, retaining receipts and reasoning', async () => {
    const execute = vi.fn(async () => '{"path":"skills/platform-init/prompt.md","content":"Ask for authorized setup choices."}')
    const checkpoint = vi.fn(), bodies: any[] = []
    const request = vi.fn<typeof fetch>(async (_url, init) => {
      bodies.push(JSON.parse(init!.body as string))
      return bodies.length === 1 ? sse(item({ ...reasoning, encrypted_content: 'opaque-not-visible'.repeat(12000) }), item(call, 1), finished()) : sse(item(text('Which setup options would you like?')), finished())
    })
    const chunks = await collect(request, { onCheckpoint: checkpoint, context: { attachments: [], repositoryText: '', sources: [], projectTools: {
      definitions: [{ name: 'read_file', description: 'Read authorized file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } }], assertAccess: vi.fn(), execute,
    } } })
    expect(execute).toHaveBeenCalledExactlyOnceWith('read_file', { path: 'skills/platform-init/prompt.md' }, expect.any(AbortSignal))
    expect(bodies[1].input).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'reasoning', encrypted_content: 'opaque-not-visible'.repeat(12000) }), expect.objectContaining({ type: 'function_call_output', call_id: 'read-1' })]))
    expect(checkpoint.mock.lastCall![0]).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'function_call_output', call_id: 'read-1' })]))
    expect(chunks).toEqual([{ type: 'text', text: 'Which setup options would you like?' }, { type: 'done' }])
    expect(bodies.every(body => body.reasoning.effort === 'high' && body.max_output_tokens === undefined)).toBe(true)
  })
  it('deduplicates deltas, text.done, item.done and terminal output', () => {
    const accumulator = new ResponseAccumulator()
    const events = [{ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'He' }, { type: 'response.output_text.done', output_index: 0, content_index: 0, text: 'Hello' }, item(text('Hello')), finished([text('Hello')])]
    expect(events.map(event => accumulator.accept(event as ResponseStreamEvent)).join('') + accumulator.remainingText()).toBe('Hello')
    expect(accumulator.output).toHaveLength(1)
  })
  it('does not execute tools from an interrupted stream even when item.done arrived', async () => {
    const execute = vi.fn()
    await expect(collect(async () => sse(item(call)), { context: { attachments: [], repositoryText: '', sources: [], projectTools: { definitions: [], assertAccess: vi.fn(), execute } } })).rejects.toThrow('before a completion event')
    expect(execute).not.toHaveBeenCalled()
  })
  it('accepts a streamed summary with empty terminal output and pins the command instead of retrieved repository data', async () => {
    let round = 0
    const checkpoint = vi.fn()
    const request = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(init!.body as string)
      if (++round === 1) return contextError()
      if (round === 2) {
        expect(body.reasoning.effort).toBe('low'); expect(body.tools).toBeUndefined()
        return sse(item(reasoning), item(text('Objective: initialize. Pending: request setup choices.'), 1), finished())
      }
      expect(body.input.at(-1).content).toBe(message.content)
      expect(body.reasoning.effort).toBe('high')
      return sse(item(text('Please choose your setup options.')), finished())
    })
    await collect(request, { onCheckpoint: checkpoint, context: { attachments: [], repositoryText: 'Large untrusted source excerpt', sources: [] } })
    expect(request).toHaveBeenCalledTimes(3)
    expect(checkpoint.mock.lastCall![0].at(-1).content).toBe(message.content)
  })
  it.each(['empty', 'incomplete', 'failure'] as const)('keeps history and avoids duplicate summary attempts on %s', async (outcome) => {
    const checkpoint = vi.fn(), original = structuredClone(message)
    let requests = 0
    const request = vi.fn<typeof fetch>(async () => ++requests === 1 ? contextError() : outcome === 'empty' ? sse(item(reasoning), finished()) : outcome === 'incomplete' ? sse(item(text('Unfinished')), { type: 'response.incomplete', response: { status: 'incomplete', output: [], incomplete_details: { reason: 'max_output_tokens' } } }) : sse({ type: 'response.failed', response: { error: { code: 'server_error', message: 'private content' } } }))
    await expect(collect(request, { onCheckpoint: checkpoint })).rejects.toThrow(outcome === 'empty' ? 'without a visible checkpoint' : outcome === 'incomplete' ? 'provider output limit' : /service|temporar|server/i)
    expect(request).toHaveBeenCalledTimes(2)
    expect(checkpoint).not.toHaveBeenCalled()
    expect(message).toEqual(original)
  })
})
