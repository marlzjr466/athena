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
  beforeEach(() => vi.restoreAllMocks())
  it('discovers API-account models and keeps verification separate from activation', async () => {
    const request = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({ data: [{ id: 'claude-sonnet-test', display_name: 'Sonnet' }] })))
    const store = vault()
    const config = new ClaudeAPIConfiguration(store, request)
    const tested = await config.test({ apiKey: 'sk-ant-test-not-a-real-credential' })
    expect(tested.ok).toBe(true)
    expect(store.value).toBeNull()
    const activated = await config.activate({ apiKey: 'sk-ant-test-not-a-real-credential' })
    expect(activated.status.provider).toBe('Claude API')
    expect(activated.status.models).toEqual(['claude-sonnet-test'])
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

  it('uses the selected registered project tools with sequential tool results', async () => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(sse(
        { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tool-1', name: 'read_file', input: {} } },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":"src/a.ts"}' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
      ))
      .mockResolvedValueOnce(sse(
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'The file exports a value.' } },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
      ))
    const execute = vi.fn(async () => '{"ok":true,"content":"export const value = 1"}')
    const projectTools = { definitions: [{ name: 'read_file', description: 'Read authorized source.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }], assertAccess: vi.fn(), execute }
    const chunks = []
    for await (const chunk of new ClaudeAPIProvider('sk-ant-test-not-a-real-credential', 'claude-sonnet-test', request).streamMessage([message], { context: { attachments: [], repositoryText: '', sources: [], projectTools } })) chunks.push(chunk)
    expect(execute).toHaveBeenCalledWith('read_file', { path: 'src/a.ts' }, expect.any(AbortSignal))
    const nextBody = JSON.parse(request.mock.calls[1][1]!.body as string)
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
