// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import OpenAI from 'openai'
import { OpenAIProvider, providerError } from '../electron/main/ai/OpenAIProvider'
import type { PreparedContext } from '../electron/main/ai/AIProvider'
import type { AIChunk, ChatMessage } from '../shared/chat'
import { contextDefaults } from '../shared/context'
import type { StreamDiagnostic } from '../shared/streamDiagnostics'
const input: ChatMessage[] = [{ id: 'one', role: 'user', content: 'Hello', status: 'complete', createdAt: 1 }]
const event = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`
const sse = (...values: unknown[]) => new Response(values.map(event).join(''), { headers: { 'content-type': 'text/event-stream' } })
async function collect(provider: OpenAIProvider, signal?: AbortSignal, context?: PreparedContext) { const chunks: AIChunk[] = []; for await (const chunk of provider.streamMessage(input, { signal, context })) chunks.push(chunk); return chunks }
describe('OpenAI Responses streaming provider', () => {
  it.each(['response.failed', 'sdk-error'] as const)('retains account and HTTP evidence for %s usage limits without retrying', async (format) => {
    const failure = { code: 'subscription_sharing_usage_limit_exceeded', param: 'model', message: 'secret-user@example.com Bearer private-token' }
    const metadata = { id: 'resp_usage', model: 'gpt-5.6-luna', status: 'failed', metadata: { private: 'never-export-me' } }
    const terminal = format === 'response.failed'
      ? event({ type: 'response.failed', response: { ...metadata, error: failure } })
      : `event: error\ndata: ${JSON.stringify({ error: { ...failure, response_id: 'resp_usage' } })}\n\n`
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(event({ type: 'response.created', response: { ...metadata, status: 'in_progress' } }) + event({ type: 'response.metadata' }) + terminal,
      { headers: { 'content-type': 'text/event-stream', 'x-request-id': 'req_usage', authorization: 'never-export-me' } }))
    const diagnostics: StreamDiagnostic[] = []
    const execute = vi.fn(async () => '{}')
    const provider = new OpenAIProvider('oauth-token', 'gpt-5.6-luna', request, undefined, true, undefined,
      { accountId: '11111111-1111-4111-8111-111111111111', registrationRef: 'abc123abc123', modelSource: 'conversation', workspace: 'registration-bound-not-disclosed' })
    await expect(async () => {
      for await (const _ of provider.streamMessage(input, { onStreamDiagnostic: item => diagnostics.push(item), context: { attachments: [], sources: [], repositoryText: '', projectTools: { definitions: [], assertAccess: () => {}, execute } } })) { /* consume */ }
    }).rejects.toThrow('ChatGPT account 11111111 · model gpt-5.6-luna')
    expect(request).toHaveBeenCalledTimes(1)
    expect(execute).not.toHaveBeenCalled()
    expect(diagnostics).toMatchObject([{ httpStatus: 200, requestId: 'req_usage', responseId: 'resp_usage', providerParam: 'model',
      responseModel: 'gpt-5.6-luna', providerCode: failure.code, kind: 'rate_limited', willRetry: false, recoveryAttempt: 0, quota: 'unknown',
      accountId: '11111111-1111-4111-8111-111111111111', registrationRef: 'abc123abc123', modelSource: 'conversation',
      failureEventType: format === 'response.failed' ? 'response.failed' : 'sdk_stream_error' }])
    expect(diagnostics[0].lastEventType).toBe(format === 'response.failed' ? 'response.failed' : 'response.metadata')
    expect(JSON.stringify(diagnostics)).not.toMatch(/never-export-me|secret-user|private-token|oauth-token/)
  })
  it('uses subscription-compatible request fields and namespaces without API output limits', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(sse({ type: 'response.output_text.delta', delta: 'Ready' }, { type: 'response.completed', response: { output: [] } }))
    const provider = new OpenAIProvider('oauth-token', 'gpt-6.1-sol', request, undefined, true)
    const chunks: AIChunk[] = []
    for await (const chunk of provider.streamMessage(input, { context: { attachments: [], repositoryText: '', sources: [], projectTools: { definitions: [{ name: 'list_directory', description: 'List project files.', parameters: { type: 'object', properties: {}, required: [], additionalProperties: false } }], assertAccess: () => {}, execute: async () => '{}' } } })) chunks.push(chunk)
    const body = JSON.parse(request.mock.calls[0][1]!.body as string)
    expect(body).toMatchObject({ model: 'gpt-6.1-sol', store: false, stream: true, tools: [{ type: 'namespace', name: 'athena', tools: [{ type: 'function', name: 'list_directory', strict: false }] }] })
    expect(body.max_output_tokens).toBeUndefined()
    expect(body.temperature).toBeUndefined()
    expect(chunks).toEqual([{ type: 'text', text: 'Ready' }, { type: 'done' }])
  })
  it('refreshes a pinned subscription token before a later round and once on pre-stream token_expired', async () => {
    const expired = new Response(JSON.stringify({ error: { code: 'token_expired', message: 'expired' } }), { status: 401, headers: { 'content-type': 'application/json' } })
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(expired).mockResolvedValueOnce(sse({ type: 'response.output_text.delta', delta: 'Ready' }, { type: 'response.completed', response: { output: [] } }))
    const tokenForRound = vi.fn(async (rejected?: string) => rejected ? 'renewed-token' : 'initial-token')
    const provider = new OpenAIProvider('initial-token', 'gpt-6.1-sol', request, undefined, true, tokenForRound)
    expect(await collect(provider)).toEqual([{ type: 'text', text: 'Ready' }, { type: 'done' }])
    expect(tokenForRound).toHaveBeenCalledWith('initial-token')
    expect(request).toHaveBeenCalledTimes(2)
    expect(new Headers(request.mock.calls[0][1]?.headers).get('authorization')).toBe('Bearer initial-token')
    expect(new Headers(request.mock.calls[1][1]?.headers).get('authorization')).toBe('Bearer renewed-token')
  })
  it('executes a subscription namespace function through the existing guarded tool loop', async () => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(sse({ type: 'response.output_item.done', item: { id: 'item-1' } }, { type: 'response.completed', response: { output: [{ id: 'item-1', type: 'function_call', namespace: 'athena', name: 'list_directory', call_id: 'call-1', arguments: '{}', status: 'completed' }] } }))
      .mockResolvedValueOnce(sse({ type: 'response.output_text.delta', delta: 'Found files.' }, { type: 'response.completed', response: { output: [] } }))
    const execute = vi.fn(async () => '{"files":["src/main.ts"]}')
    const provider = new OpenAIProvider('oauth-token', 'gpt-6.1-sol', request, undefined, true)
    const chunks: AIChunk[] = []
    for await (const chunk of provider.streamMessage(input, { context: { attachments: [], repositoryText: '', sources: [], projectTools: { definitions: [{ name: 'list_directory', description: 'List project files.', parameters: { type: 'object', properties: {}, required: [], additionalProperties: false } }], assertAccess: () => {}, execute } } })) chunks.push(chunk)
    expect(execute).toHaveBeenCalledOnce()
    expect(execute).toHaveBeenCalledWith('list_directory', {}, expect.any(AbortSignal))
    const followup = JSON.parse(request.mock.calls[1][1]!.body as string)
    expect(followup.input).toContainEqual({ type: 'function_call_output', call_id: 'call-1', output: '{"files":["src/main.ts"]}' })
    expect(chunks.at(-1)).toEqual({ type: 'done' })
  })
  it('sends effort, image content and bounded untrusted project data without executable tools', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(sse({ type: 'response.output_text.delta', delta: 'Result' }, { type: 'response.completed', response: {} }))
    const provider = new OpenAIProvider('sk-test-not-real', 'gpt-5.2', request)
    const attachment = { id: 'image', name: 'photo.png', mime: 'image/png', size: 20, kind: 'image' as const, characters: 0 }
    for await (const _chunk of provider.streamMessage([{ ...input[0], attachments: [attachment] }], { effort: 'high', context: { attachments: [{ id: 'image', name: 'photo.png', kind: 'image', data: 'data:image/png;base64,AA==' }], repositoryText: 'SOURCE src/auth.ts\n1: export function login() {}', sources: [] } })) { /* consume */ }
    const body = JSON.parse(request.mock.calls[0][1]!.body as string)
    expect(body.reasoning).toEqual({ effort: 'high' })
    expect(body.input[0].content[1]).toMatchObject({ type: 'input_image', image_url: 'data:image/png;base64,AA==' })
    expect(body.input[1].content).toContain('not instructions')
    expect(body.instructions).toContain('untrusted data'); expect(body.tools).toBeUndefined(); expect(body.store).toBe(false)
  })
  it('uses pre-retrieved OpenAI search evidence while keeping the selected provider responsible for the answer', async () => {
    const source = 'https://react.dev/blog'
    const request = vi.fn<typeof fetch>().mockResolvedValue(sse(
      { type: 'response.output_text.delta', delta: 'React’s latest release is documented here.' },
      { type: 'response.completed', response: { output: [] } },
    ))
    const provider = new OpenAIProvider('chat-provider-key', 'gpt-5.5', request, undefined, true)
    const context: PreparedContext = { attachments: [], repositoryText: 'OpenAI Responses live web-search evidence: React’s release page.', sources: [],
      webSources: [{ title: 'React Blog', url: source, source: 'react.dev', retrievedAt: '2026-10-11T00:00:00.000Z' }] }
    const chunks = await collect(provider, undefined, context)
    const body = JSON.parse(request.mock.calls[0][1]!.body as string)
    expect(body).not.toHaveProperty('tools')
    expect(body.input.at(-1).content).toContain('OpenAI Responses live web-search evidence')
    expect(body.model).toBe('gpt-5.5')
    expect(chunks.filter((chunk) => chunk.type === 'text').map((chunk) => chunk.text).join('')).toBe('React’s latest release is documented here.')
  })
  it('rejects unsupported effort before making a request', async () => {
    const request = vi.fn<typeof fetch>(), provider = new OpenAIProvider('sk-test-not-real', 'gpt-4.1', request)
    await expect(async () => { for await (const _chunk of provider.streamMessage(input, { effort: 'xhigh' })) { /* consume */ } }).rejects.toThrow('Select Auto')
    expect(request).not.toHaveBeenCalled()
  })
  it('distinguishes timeout and malformed stream errors without exposing their contents', () => {
    expect(providerError(new OpenAI.APIConnectionTimeoutError()).message).toContain('too long')
    expect(providerError(new SyntaxError('private content')).message).toContain('unreadable streaming response')
  })
  it('streams text with personality, selected model, full input, no tools and store:false', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(sse({ type: 'response.output_text.delta', delta: 'Hel' }, { type: 'response.output_text.delta', delta: 'lo' }, { type: 'response.completed', response: {} }))
    expect(await collect(new OpenAIProvider('sk-test-not-real', 'selected-model', request))).toEqual([{ type: 'text', text: 'Hel' }, { type: 'text', text: 'lo' }, { type: 'done' }])
    const [url, options] = request.mock.calls[0]
    expect(String(url)).toBe('https://api.openai.com/v1/responses')
    const body = JSON.parse(options!.body as string)
    expect(body).toMatchObject({ model: 'selected-model', stream: true, store: false, input: [{ role: 'user', content: 'Hello' }] })
    expect(body.instructions).toContain('Never bypass Athena’s permission system'.replace('’', "'"))
    expect(body.tools).toBeUndefined()
    expect(options?.redirect).toBe('error')
  })
  it('supports streamed refusal text', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(sse({ type: 'response.refusal.delta', delta: 'I cannot help with that.' }, { type: 'response.completed', response: {} }))
    expect((await collect(new OpenAIProvider('sk-test-not-real', 'test', request)))[0]).toEqual({ type: 'text', text: 'I cannot help with that.' })
  })
  it('uses completed output text when the stream contains no text deltas', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(sse({ type: 'response.completed', response: { output: [{ id: 'msg-1', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'The command is ready.', annotations: [] }] }] } }))
    expect(await collect(new OpenAIProvider('sk-test-not-real', 'gpt-5.2', request))).toEqual([{ type: 'text', text: 'The command is ready.' }, { type: 'done' }])
    expect(request).toHaveBeenCalledTimes(1)
  })
  it('continues one completed but textless response without repeating tool execution', async () => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(sse({ type: 'response.completed', response: { output: [{ id: 'reason-1', type: 'reasoning', summary: [], encrypted_content: 'opaque', status: 'completed' }] } }))
      .mockResolvedValueOnce(sse({ type: 'response.output_text.delta', delta: 'Here is the result.' }, { type: 'response.completed', response: { output: [] } }))
    expect(await collect(new OpenAIProvider('sk-test-not-real', 'gpt-5.2', request))).toEqual([{ type: 'text', text: 'Here is the result.' }, { type: 'done' }])
    expect(request).toHaveBeenCalledTimes(2)
    const followup = JSON.parse(request.mock.calls[1][1]!.body as string)
    expect(followup.input.at(-1).content).toContain('no visible text')
  })
  it('bounds genuinely textless responses and gives an accurate error', async () => {
    const request = vi.fn<typeof fetch>().mockImplementation(async () => sse({ type: 'response.completed', response: { output: [] } }))
    await expect(collect(new OpenAIProvider('sk-test-not-real', 'gpt-5.2', request))).rejects.toThrow('not reported as output-token exhaustion')
    expect(request).toHaveBeenCalledTimes(2)
  })
  it.each([
    ['credit_balance_exhausted', 'credit balance is exhausted'],
    ['insufficient_quota', 'billing'],
    ['organization_spend_limit_exceeded', 'spending limit'],
    ['project_spend_limit_exceeded', 'spending limit'],
    ['rate_limit_exceeded', 'rate limit'],
    ['slow_down', 'rate limit'],
    ['server_is_overloaded', 'overloaded'],
    ['model_not_found', 'selected model'],
    ['unsupported_parameter', 'generation setting'],
    ['unknown', 'streaming API error'],
  ])('classifies named SSE error %s without an HTTP status', async (code, message) => {
    const body = `event: error\ndata: ${JSON.stringify({ type: 'error', code, message: 'private-key' })}\n\n`
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(body, { headers: { 'content-type': 'text/event-stream' } }))
    await expect(collect(new OpenAIProvider('sk-test-not-real', 'test', request))).rejects.toThrow(message)
    expect(request).toHaveBeenCalledTimes(1)
  })
  it('never exposes raw server text or credential-shaped diagnostic identifiers', () => {
    const error = new OpenAI.APIError(undefined, { code: 'sk-private-secret', param: 'private-path', message: 'private-key' }, undefined, new Headers())
    expect(providerError(error).message).toContain('(unspecified)')
    expect(providerError(error).message).not.toContain('private')
  })
  it.each(['response.failed', 'response.incomplete', 'error'])('fails safely for %s events', async (type) => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(sse({ type, error: { message: 'private-key' } }))
    await expect(collect(new OpenAIProvider('sk-test-not-real', 'test', request))).rejects.not.toThrow('private-key')
  })
  it('keeps the subscription failure code instead of collapsing it into a generic usage error', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(sse({ type: 'response.failed', response: { error: { code: 'subscription_sharing_unsupported_capability', param: 'temperature', message: 'private-key' } } }))
    await expect(collect(new OpenAIProvider('oauth-token', 'gpt-6.1-sol', request, undefined, true))).rejects.toThrow('parameter: temperature')
    await expect(collect(new OpenAIProvider('oauth-token', 'gpt-6.1-sol', vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ error: { code: 'rate_limit_exceeded' } }), { status: 429 })), undefined, true))).rejects.toThrow('temporarily rate-limited')
  })
  it('retries one code-less subscription stream failure after a tool result without repeating the tool', async () => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(sse({ type: 'response.completed', response: { output: [{ id: 'item-1', type: 'function_call', namespace: 'athena', name: 'list_directory', call_id: 'call-1', arguments: '{}', status: 'completed' }] } }))
      .mockResolvedValueOnce(sse({ type: 'response.failed', response: { error: null, output: [] } }))
      .mockResolvedValueOnce(sse({ type: 'response.output_text.delta', delta: 'Recovered.' }, { type: 'response.completed', response: { output: [] } }))
    const execute = vi.fn(async () => '{"files":["src/main.ts"]}')
    const provider = new OpenAIProvider('oauth-token', 'gpt-6.1-sol', request, undefined, true)
    const context: PreparedContext = { attachments: [], repositoryText: '', sources: [], projectTools: { definitions: [{ name: 'list_directory', description: 'List project files.', parameters: { type: 'object', properties: {}, required: [], additionalProperties: false } }], assertAccess: () => {}, execute } }
    const chunks = await collect(provider, undefined, context)
    expect(chunks).toEqual([{ type: 'text', text: 'Recovered.' }, { type: 'done' }])
    expect(execute).toHaveBeenCalledOnce()
    expect(request).toHaveBeenCalledTimes(3)
    const retried = JSON.parse(request.mock.calls[2][1]!.body as string)
    expect(retried.input).toContainEqual({ type: 'function_call_output', call_id: 'call-1', output: '{"files":["src/main.ts"]}' })
  })
  it('recovers an interrupted response after a completed edit and records sanitized late-task diagnostics', async () => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(sse({ type: 'response.completed', response: { output: [{ id: 'edit-1', type: 'function_call', namespace: 'athena', name: 'edit_file', call_id: 'edit-call', arguments: '{"path":"src/a.ts"}', status: 'completed' }] } }))
      .mockResolvedValueOnce(sse({ type: 'response.failed', response: { error: null, output: [] } }))
      .mockResolvedValueOnce(sse({ type: 'response.output_text.delta', delta: 'Verified remaining work.' }, { type: 'response.completed', response: { output: [] } }))
    const execute = vi.fn(async () => '{"ok":true,"changed":"src/a.ts"}')
    const diagnostics: StreamDiagnostic[] = []
    const phases: string[] = []
    const provider = new OpenAIProvider('oauth-token', 'gpt-6.1-sol', request, undefined, true)
    const chunks: AIChunk[] = []
    for await (const chunk of provider.streamMessage(input, { executionId: 'execution-1', diagnosticCounts: () => ({ completedTools: 105, fileChanges: 20 }),
      onStreamDiagnostic: (diagnostic) => diagnostics.push(diagnostic), onStreamPhase: (phase) => phases.push(phase),
      context: { attachments: [], repositoryText: '', sources: [], projectTools: { definitions: [{ name: 'edit_file', description: 'Edit file.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } }], assertAccess: () => {}, execute } },
    })) chunks.push(chunk)
    expect(chunks.at(-1)).toEqual({ type: 'done' })
    expect(execute).toHaveBeenCalledOnce()
    expect(diagnostics).toMatchObject([{ kind: 'provider_failed', stage: 'response_stream', completedTools: 105, fileChanges: 20, willRetry: true, executionId: 'execution-1' }])
    expect(phases).toContain('recovering')
    const retry = JSON.parse(request.mock.calls[2][1]!.body as string)
    expect(retry.input).toContainEqual({ type: 'function_call_output', call_id: 'edit-call', output: '{"ok":true,"changed":"src/a.ts"}' })
  })
  it('does not apply a provider-wide timer to a healthy multi-round task', async () => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(sse({ type: 'response.completed', response: { output: [{ id: 'read-1', type: 'function_call', name: 'read_file', call_id: 'call-1', arguments: '{}', status: 'completed' }] } }))
      .mockResolvedValueOnce(sse({ type: 'response.output_text.delta', delta: 'Done.' }, { type: 'response.completed', response: { output: [] } }))
    const provider = new OpenAIProvider('test-key', 'gpt-4.1', request)
    const chunks: AIChunk[] = []
    const controller = new AbortController()
    for await (const chunk of provider.streamMessage(input, { signal: controller.signal,
      context: { attachments: [], repositoryText: '', sources: [], projectTools: { timeoutMs: 1, definitions: [{ name: 'read_file', description: 'Read file.', parameters: { type: 'object', properties: {}, required: [], additionalProperties: false } }], assertAccess: () => {}, execute: async () => { await new Promise(resolve => setTimeout(resolve, 15)); return 'file' } } },
    })) chunks.push(chunk)
    expect(chunks.at(-1)).toEqual({ type: 'done' })
    expect(request).toHaveBeenCalledTimes(2)
  })
  it('never dispatches partial tool-call arguments from a truncated stream during recovery', async () => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(sse({ type: 'response.function_call_arguments.delta', item_id: 'partial', output_index: 0, delta: '{"path":' }))
      .mockResolvedValueOnce(sse({ type: 'response.output_text.delta', delta: 'Recovered without a tool action.' }, { type: 'response.completed', response: { output: [] } }))
    const execute = vi.fn(async () => 'unexpected')
    const diagnostics: StreamDiagnostic[] = []
    const provider = new OpenAIProvider('oauth-token', 'gpt-6.1-sol', request, undefined, true)
    const chunks: AIChunk[] = []
    for await (const chunk of provider.streamMessage(input, { contextSettings: { ...contextDefaults(), maxStreamRecoveries: 1 }, onStreamDiagnostic: item => diagnostics.push(item),
      context: { attachments: [], repositoryText: '', sources: [], projectTools: { definitions: [{ name: 'edit_file', description: 'Edit file.', parameters: { type: 'object', properties: {}, required: [], additionalProperties: false } }], assertAccess: () => {}, execute } },
    })) chunks.push(chunk)
    expect(chunks.at(-1)).toEqual({ type: 'done' })
    expect(execute).not.toHaveBeenCalled()
    expect(diagnostics).toMatchObject([{ kind: 'unexpected_eof', lastEventType: 'response.function_call_arguments.delta', willRetry: true }])
  })
  it('stops after its configured recovery bound and preserves the actual EOF reason', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(sse({ type: 'response.output_text.delta', delta: 'Unfinished' }))
    const diagnostics: StreamDiagnostic[] = []
    const provider = new OpenAIProvider('oauth-token', 'gpt-6.1-sol', request, undefined, true)
    await expect(async () => {
      for await (const _ of provider.streamMessage(input, { contextSettings: { ...contextDefaults(), maxStreamRecoveries: 1 }, onStreamDiagnostic: item => diagnostics.push(item) })) { /* collect */ }
    }).rejects.toThrow('before a completion event')
    expect(request).toHaveBeenCalledTimes(2)
    expect(diagnostics.map(item => item.willRetry)).toEqual([true, false])
  })
  it('retries temporary provider unavailability but not an account usage limit', async () => {
    const unavailable = new Response(JSON.stringify({ error: { code: 'subscription_sharing_usage_unavailable' } }), { status: 503, headers: { 'content-type': 'application/json' } })
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(unavailable).mockResolvedValueOnce(sse({ type: 'response.output_text.delta', delta: 'Ready.' }, { type: 'response.completed', response: { output: [] } }))
    const diagnostics: StreamDiagnostic[] = []
    const provider = new OpenAIProvider('oauth-token', 'gpt-6.1-sol', request, undefined, true)
    const chunks: AIChunk[] = []
    for await (const chunk of provider.streamMessage(input, { onStreamDiagnostic: item => diagnostics.push(item), contextSettings: { ...contextDefaults(), maxStreamRecoveries: 1 } })) chunks.push(chunk)
    expect(chunks.at(-1)).toEqual({ type: 'done' })
    expect(diagnostics[0]).toMatchObject({ kind: 'provider_unavailable', stage: 'request', willRetry: true })
    expect(request).toHaveBeenCalledTimes(2)
    const limited = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ error: { code: 'subscription_sharing_usage_limit_exceeded' } }), { status: 429, headers: { 'content-type': 'application/json' } }))
    await expect(collect(new OpenAIProvider('oauth-token', 'gpt-6.1-sol', limited, undefined, true))).rejects.toThrow('plan usage limit')
    expect(limited).toHaveBeenCalledOnce()
  })
  it('continues after visible partial text but never retries a named usage error', async () => {
    const partial = vi.fn<typeof fetch>().mockResolvedValueOnce(sse(
      { type: 'response.output_text.delta', delta: 'Partial' },
      { type: 'response.failed', response: { error: null, output: [] } },
    )).mockResolvedValueOnce(sse({ type: 'response.output_text.delta', delta: 'Completed.' }, { type: 'response.completed', response: { output: [] } }))
    const chunks = await collect(new OpenAIProvider('oauth-token', 'gpt-6.1-sol', partial, undefined, true))
    expect(chunks.at(-1)).toEqual({ type: 'done' })
    expect(chunks.map(chunk => chunk.type === 'text' ? chunk.text : '').join('')).toContain('Completed.')
    expect(partial).toHaveBeenCalledTimes(2)
    expect(JSON.parse(partial.mock.calls[1][1]!.body as string).input.at(-1).content).toContain('unfinished response and tool requests were NOT executed')
    const usage = vi.fn<typeof fetch>().mockResolvedValue(sse({ type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_limit_exceeded' }, output: [] } }))
    await expect(collect(new OpenAIProvider('oauth-token', 'gpt-6.1-sol', usage, undefined, true))).rejects.toThrow('plan usage limit reached')
    expect(usage).toHaveBeenCalledOnce()
  })
  it('does not treat a truncated SSE stream as success', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(sse({ type: 'response.output_text.delta', delta: 'partial' }))
    await expect(collect(new OpenAIProvider('sk-test-not-real', 'test', request))).rejects.toThrow('before a completion event')
  })
  it.each([400, 401, 402, 403, 404, 422, 429, 500])('sanitizes HTTP %s and does not retry automatically', async (status) => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ error: { message: 'private-key', type: 'test', code: 'test' } }), { status }))
    await expect(collect(new OpenAIProvider('sk-test-not-real', 'test', request))).rejects.not.toThrow('private-key')
    expect(request).toHaveBeenCalledTimes(1)
  })
  it('aborts cleanly without yielding stale text', async () => {
    const abort = new AbortController()
    const request = vi.fn<typeof fetch>().mockImplementation(async () => { abort.abort(); return sse({ type: 'response.output_text.delta', delta: 'late' }) })
    expect(await collect(new OpenAIProvider('sk-test-not-real', 'test', request), abort.signal)).toEqual([])
  })
})
