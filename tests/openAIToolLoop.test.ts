// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { OpenAIProvider } from '../electron/main/ai/OpenAIProvider'
import type { ProjectTools } from '../electron/main/ai/AIProvider'
import type { AIChunk } from '../shared/chat'

vi.mock('../electron/main/logger', () => ({ log: vi.fn() }))
const sse = (...events: unknown[]) => new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
const call = (name: string, id: string, args = '{}') => ({ type: 'function_call', name, arguments: args, call_id: id, id: `fc_${id}`, status: 'completed' })
const complete = (output: unknown[]) => ({ type: 'response.completed', response: { output } })
const final = () => sse({ type: 'response.output_text.delta', delta: 'Verified result.' }, complete([]))
function setup() {
  const request = vi.fn<typeof fetch>()
  const tools: ProjectTools = { definitions: ['get_running_apps', 'open_application', 'focus_application'].map((name) => ({ name, description: name, parameters: { type: 'object', properties: {}, additionalProperties: false, required: [] } })),
    assertAccess: vi.fn(), parallelSafe: (name) => name === 'get_running_apps',
    execute: vi.fn(async () => '{"ok":true,"message":"OS confirmed"}') }
  const run = async (signal?: AbortSignal) => {
    const chunks: AIChunk[] = []
    for await (const chunk of new OpenAIProvider('sk-test-fake', 'gpt-4.1', request).streamMessage(
      [{ id: 'user', role: 'user', content: 'Open and switch to my app.', createdAt: 1, status: 'complete' }],
      { signal, context: { attachments: [], repositoryText: '', sources: [], projectTools: tools } },
    )) chunks.push(chunk)
    return chunks
  }
  const body = (index: number) => JSON.parse(request.mock.calls[index][1]!.body as string)
  return { request, tools, run, body }
}

describe('Phase 8 OpenAI tool lifecycle', () => {
  it('continues sequential steps with matching call results and reasoning items', async () => {
    const f = setup()
    const reasoning = { type: 'reasoning', id: 'rs_one', summary: [], encrypted_content: 'opaque-test' }
    f.request.mockResolvedValueOnce(sse(complete([reasoning, call('open_application', 'open')]))).mockResolvedValueOnce(sse(complete([call('focus_application', 'focus')]))).mockResolvedValueOnce(final())
    expect((await f.run()).at(-1)).toEqual({ type: 'done' })
    expect(f.body(0)).toMatchObject({ model: 'gpt-4.1', store: false, tool_choice: 'auto', parallel_tool_calls: true })
    expect(f.body(0).tools.every((entry: { strict: boolean }) => entry.strict)).toBe(true)
    expect(f.body(1).input).toContainEqual(expect.objectContaining({ type: 'reasoning', encrypted_content: 'opaque-test' }))
    expect(f.body(1).input).toContainEqual({ type: 'function_call_output', call_id: 'open', output: '{"ok":true,"message":"OS confirmed"}' })
    expect(f.body(2).input).toContainEqual({ type: 'function_call_output', call_id: 'focus', output: '{"ok":true,"message":"OS confirmed"}' })
    expect(vi.mocked(f.tools.execute).mock.calls.map(([name]) => name)).toEqual(['open_application', 'focus_application'])
  })
  it('returns malformed, unknown, and failed results to the model without fabricating success', async () => {
    const f = setup()
    f.request.mockResolvedValueOnce(sse(complete([call('open_application', 'bad', '{'), call('shell', 'unknown'), call('focus_application', 'failure')]))).mockResolvedValueOnce(final())
    vi.mocked(f.tools.execute).mockRejectedValue(new Error('private credential'))
    await f.run()
    expect(f.tools.execute).toHaveBeenCalledTimes(1)
    const outputs = f.body(1).input.filter((item: { type: string }) => item.type === 'function_call_output')
    expect(outputs.map((item: { output: string }) => JSON.parse(item.output).error.code)).toEqual(['invalid_arguments', 'unknown_tool', 'execution_failed'])
    expect(JSON.stringify(outputs)).not.toContain('private credential')
  })
  it('accepts a mixed batch in one model round but executes its actions sequentially', async () => {
    const f = setup(), order: string[] = []
    f.request.mockResolvedValueOnce(sse(complete([call('get_running_apps', 'read'), call('open_application', 'open')]))).mockResolvedValueOnce(final())
    vi.mocked(f.tools.execute).mockImplementation(async (name) => { order.push(name); return '{"ok":true}' })
    await f.run()
    expect(f.request).toHaveBeenCalledTimes(2)
    expect(order).toEqual(['get_running_apps', 'open_application'])
    expect(f.body(1).input.filter((item: { type: string }) => item.type === 'function_call_output')).toHaveLength(2)
  })
  it('bounds independent read concurrency to four and preserves result order', async () => {
    const f = setup(); let active = 0, peak = 0
    f.request.mockResolvedValueOnce(sse(complete(Array.from({ length: 5 }, (_, index) => call('get_running_apps', String(index + 1)))))).mockResolvedValueOnce(final())
    vi.mocked(f.tools.execute).mockImplementation(async (_name, args) => {
      active++; peak = Math.max(peak, active)
      await new Promise(resolve => setTimeout(resolve, 2))
      active--
      return JSON.stringify({ args })
    })
    await f.run()
    expect(peak).toBe(4)
    expect(f.body(1).input.filter((item: { type: string }) => item.type === 'function_call_output').map((item: { call_id: string }) => item.call_id)).toEqual(['1', '2', '3', '4', '5'])
  })
  it('rejects an oversized batch before any tool side effect', async () => {
    const f = setup(); f.tools.maxCalls = 1
    f.request.mockResolvedValueOnce(sse(complete([call('open_application', 'one'), call('focus_application', 'two')])))
    await expect(f.run()).rejects.toThrow('No tool from this batch was executed')
    expect(f.tools.execute).not.toHaveBeenCalled()
  })
  it('stops repeated identical exploration instead of exhausting the iteration limit', async () => {
    const f = setup(); f.tools.maxRounds = 32
    f.tools.definitions.push({ name: 'edit_file', description: 'Guarded project edit', parameters: { type: 'object', properties: {}, additionalProperties: false, required: [] } })
    let next = 0
    f.request.mockImplementation(async () => sse(complete([call('get_running_apps', String(next++))])))
    await expect(f.run()).rejects.toThrow('no new evidence')
    expect(f.request.mock.calls.length).toBeLessThan(32)
  })
  it('returns denied results unchanged instead of treating them as completion', async () => {
    const f = setup(), denied = '{"ok":false,"status":"denied","message":"Permission disabled"}'
    f.request.mockResolvedValueOnce(sse(complete([call('open_application', 'denied')]))).mockResolvedValueOnce(final())
    vi.mocked(f.tools.execute).mockResolvedValue(denied)
    await f.run()
    expect(f.body(1).input).toContainEqual({ type: 'function_call_output', call_id: 'denied', output: denied })
  })
  it('does not execute tools when the stream ends before response completion', async () => {
    const f = setup()
    f.request.mockResolvedValue(sse({ type: 'response.output_item.done', item: call('open_application', 'partial') }))
    await expect(f.run()).rejects.toThrow('before a completion event')
    expect(f.tools.execute).not.toHaveBeenCalled()
  })
  it('rejects repeated call IDs across rounds without repeating an action', async () => {
    const f = setup()
    f.request.mockImplementation(async () => sse(complete([call('open_application', 'same') ])))
    await expect(f.run()).rejects.toThrow('repeated a tool call identifier')
    expect(f.tools.execute).toHaveBeenCalledTimes(1)
  })
  it('stops without a tool-disabled summary request that can misreport missing permissions', async () => {
    const f = setup(); f.tools.maxRounds = 1
    f.request.mockResolvedValueOnce(sse(complete([call('open_application', 'last')]))).mockResolvedValueOnce(final())
    await expect(f.run()).rejects.toThrow('Agent execution budget reached')
    expect(f.request).toHaveBeenCalledTimes(1)
    expect(f.tools.execute).toHaveBeenCalledTimes(1)
  })
  it('stops the remaining batch and follow-up API request on cancellation', async () => {
    const f = setup(), abort = new AbortController()
    f.request.mockResolvedValueOnce(sse(complete([call('open_application', 'one'), call('focus_application', 'two')])))
    vi.mocked(f.tools.execute).mockImplementation(async () => { abort.abort(); return '{}'; })
    expect(await f.run(abort.signal)).toEqual([])
    expect(f.tools.execute).toHaveBeenCalledTimes(1); expect(f.request).toHaveBeenCalledTimes(1)
  })
})
