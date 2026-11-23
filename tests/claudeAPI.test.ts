import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AICredential, CredentialStore } from '../electron/main/ai/credentialStore'
import { ClaudeAPIConfiguration, ClaudeAPIProvider } from '../electron/main/ai/claudeAPI'
import type { ChatMessage } from '../shared/chat'

vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => '/tmp/athena-test' } }))

function sse(...events: unknown[]) {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
}
const message: ChatMessage = { id: 'message-1', role: 'user', content: 'Hello', status: 'complete', createdAt: 1 }
function vault(seed: AICredential | null = null): CredentialStore & { value: AICredential | null } {
  return { value: seed, async read() { return this.value }, async write(value) { this.value = value }, async remove() { this.value = null } }
}

describe('Claude API provider (not Claude plan login)', () => {
  it('does not apply a second provider task deadline when the controller owns cancellation', async () => {
    const request = vi.fn<typeof fetch>(async (_url, init) => {
      await new Promise(resolve => setTimeout(resolve, 15))
      init!.signal!.throwIfAborted()
      return sse({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }, { type: 'message_stop' })
    })
    const chunks = []
    for await (const chunk of new ClaudeAPIProvider('fixture', 'fixture', request).streamMessage([message], {
      signal: new AbortController().signal,
      context: { attachments: [], repositoryText: '', sources: [], projectTools: { timeoutMs: 1, definitions: [], assertAccess() {}, execute: async () => '{}' } },
    })) chunks.push(chunk)
    expect(chunks.at(-1)).toEqual({ type: 'done' })
    expect(request).toHaveBeenCalledOnce()
  })
  it('rejects malformed streaming events without executing the accompanying tool request', async () => {
    const execute = vi.fn(), request = vi.fn<typeof fetch>(async () => new Response('data: {incomplete\n\ndata: {"type":"message_stop"}\n\n'))
    await expect(async () => {
      for await (const _ of new ClaudeAPIProvider('fixture', 'fixture', request).streamMessage([message], { context: { attachments: [], repositoryText: '', sources: [], projectTools: { definitions: [], execute, assertAccess() {} } } })) { /* consume */ }
    }).rejects.toThrow('malformed stream event')
    expect(execute).not.toHaveBeenCalled()
  })
  it.each(['max_tokens', 'pause_turn'])('continues %s without marking a partial response complete', async reason => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'First part' } }, { type: 'message_delta', delta: { stop_reason: reason } }, { type: 'message_stop' }))
      .mockResolvedValueOnce(sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Finished' } }, { type: 'message_delta', delta: { stop_reason: 'end_turn' } }, { type: 'message_stop' }))
    const chunks = []
    for await (const chunk of new ClaudeAPIProvider('fixture', 'model', request).streamMessage([message])) chunks.push(chunk)
    expect(request).toHaveBeenCalledTimes(2)
    expect(chunks.filter(chunk => chunk.type === 'done')).toHaveLength(1)
    expect(JSON.parse(request.mock.calls[1][1]!.body as string).messages).toContainEqual({ role: 'assistant', content: [{ type: 'text', text: 'First part' }] })
  })
  it('does not execute a truncated tool argument or accept stream EOF as completion', async () => {
    const execute = vi.fn(), request = vi.fn<typeof fetch>().mockResolvedValue(sse({ type: 'message_delta', delta: { stop_reason: 'tool_use' } }))
    await expect(async () => { for await (const _ of new ClaudeAPIProvider('fixture', 'model', request).streamMessage([message], { context: { attachments: [], repositoryText: '', sources: [], projectTools: { definitions: [], execute, assertAccess() {} } } })) { /* consume */ } }).rejects.toThrow('before message_stop')
    expect(execute).not.toHaveBeenCalled()
  })
  beforeEach(() => vi.restoreAllMocks())
  it('discovers API-account models and keeps verification separate from activation', async () => {
    const request = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({ data: [{ id: 'claude-sonnet-test', display_name: 'Sonnet', max_input_tokens: 256000, max_tokens: 32000 }] })))
    const store = vault()
    const config = new ClaudeAPIConfiguration(store, request)
    const tested = await config.test({ apiKey: 'sk-ant-test-not-a-real-credential' })
    expect(tested.ok).toBe(true)
    expect(store.value).toBeNull()
    const activated = await config.activate({ apiKey: 'sk-ant-test-not-a-real-credential' })
    expect(activated.status.provider).toBe('Claude API')
    expect(activated.status.models).toEqual(['claude-sonnet-test'])
    expect((await config.getActiveConfiguration('claude-sonnet-test')).capacity).toEqual({ contextWindow: 256000, maxOutputTokens: 32000 })
    expect(activated.message).toContain('billed separately')
    expect(request.mock.calls.every(([url]) => String(url).includes('/v1/models'))).toBe(true)
  })

  it('streams official Messages API text with cancellation support and no cloud fallback', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(sse(
      { type: 'message_start', message: { id: 'msg_1' } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
      { type: 'message_stop' },
    ))
    const chunks = []
    for await (const chunk of new ClaudeAPIProvider('sk-ant-test-not-a-real-credential', 'claude-sonnet-test', request).streamMessage([message])) chunks.push(chunk)
    expect(chunks).toEqual([{ type: 'text', text: 'Hello' }, { type: 'done' }])
    expect(String(request.mock.calls[0][0])).toBe('https://api.anthropic.com/v1/messages')
    const options = request.mock.calls[0][1]!
    expect(options.headers).toMatchObject({ 'x-api-key': 'sk-ant-test-not-a-real-credential', 'anthropic-version': '2023-06-01' })
    expect(JSON.parse(options.body as string)).toMatchObject({ model: 'claude-sonnet-test', stream: true, max_tokens: 8192 })
  })

  it('sends the selected Claude reasoning effort through the documented output_config field', async () => {
    const response = () => sse(
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Done' } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
      { type: 'message_stop' },
    )
    const highRequest = vi.fn<typeof fetch>().mockResolvedValue(response())
    for await (const _ of new ClaudeAPIProvider('fixture', 'claude-opus-4-6', highRequest, { reasoning: { output_config: { effort: 'high' } } }).streamMessage([message])) { /* consume */ }
    expect(JSON.parse(highRequest.mock.calls[0][1]!.body as string).output_config).toEqual({ effort: 'high' })

    const autoRequest = vi.fn<typeof fetch>().mockResolvedValue(response())
    for await (const _ of new ClaudeAPIProvider('fixture', 'claude-opus-4-6', autoRequest).streamMessage([message])) { /* consume */ }
    expect(JSON.parse(autoRequest.mock.calls[0][1]!.body as string)).not.toHaveProperty('output_config')
  })

  it('records the official Messages API usage receipt, including cached and cache creation tokens', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(sse(
      { type: 'message_start', message: { id: 'msg_usage', usage: { input_tokens: 11, cache_read_input_tokens: 3, cache_creation_input_tokens: 5 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Done' } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } },
      { type: 'message_stop' },
    ))
    const onModelResponse = vi.fn()
    const onModelRequestUnresolved = vi.fn()
    for await (const _ of new ClaudeAPIProvider('sk-ant-test-not-a-real-credential', 'claude-sonnet-test', request).streamMessage([message], { onModelResponse, onModelRequestUnresolved })) { /* consume stream */ }
    expect(onModelResponse).toHaveBeenCalledWith({ inputTokens: 19, cachedInputTokens: 3, cacheCreationInputTokens: 5, outputTokens: 7, estimated: false })
    expect(onModelRequestUnresolved).not.toHaveBeenCalled()
  })

  it('uses the selected registered project tools with sequential tool results', async () => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(sse(
        { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Plan the read.' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'signature-1' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tool-1', name: 'read_file', input: {} } },
        { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":"src/a.ts"}' } },
        { type: 'content_block_stop', index: 1 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
        { type: 'message_stop' },
      ))
      .mockResolvedValueOnce(sse(
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'The file exports a value.' } },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
        { type: 'message_stop' },
      ))
    const execute = vi.fn(async () => '{"ok":true,"content":"export const value = 1"}')
    const projectTools = { definitions: [{ name: 'read_file', description: 'Read authorized source.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }], assertAccess: vi.fn(), execute }
    const chunks = []
    for await (const chunk of new ClaudeAPIProvider('sk-ant-test-not-a-real-credential', 'claude-sonnet-test', request).streamMessage([message], { context: { attachments: [], repositoryText: '', sources: [], projectTools } })) chunks.push(chunk)
    expect(execute).toHaveBeenCalledWith('read_file', { path: 'src/a.ts' }, expect.any(AbortSignal))
    const nextBody = JSON.parse(request.mock.calls[1][1]!.body as string)
    expect(nextBody.messages.at(-2).content[0]).toEqual({ type: 'thinking', thinking: 'Plan the read.', signature: 'signature-1' })
    expect(nextBody.messages.at(-1).content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'tool-1' })
    expect(chunks.at(-1)).toEqual({ type: 'done' })
  })

  it('surfaces usage limits without switching to OpenAI or pretending to be a plan connection', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ error: { type: 'rate_limit_error', message: 'private detail' } }), { status: 429 }))
    const chunks = []
    await expect(async () => { for await (const chunk of new ClaudeAPIProvider('sk-ant-test-not-a-real-credential', 'claude-sonnet-test', request).streamMessage([message])) chunks.push(chunk) }).rejects.toThrow('Anthropic API rate or usage limit')
    expect(request).toHaveBeenCalledOnce()
  })
})
