// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { defaultSettings, mergeSettings, restoreSettings } from '../shared/settings'
import { localAIPresets, localChatCompatibility, localEndpointSchema, localInferenceSettingsSchema } from '../shared/localAI'
import { OllamaService } from '../electron/main/ai/ollamaService'
import { OllamaProvider, validateIsolatedLocalEffort } from '../electron/main/ai/OllamaProvider'
import { rememberContextConfirmation } from '../electron/main/ai/contextEngineRuntime'
import { localCompanionProvider, localCompanionSettings } from '../electron/main/ai/localCompanion'
import { LocalMacSpeech, RoutedTranscription } from '../electron/main/voice/localVoiceServices'
import type { ChatMessage } from '../shared/chat'
import { defaultConversationConfig } from '../shared/conversations'

const events = (...items: unknown[]) => new Response(items.map((item) => JSON.stringify(item)).join('\n') + '\n')
const user: ChatMessage[] = [{ id: 'u', role: 'user', content: 'Hello', status: 'complete', createdAt: 1 }]
const model = { name: 'qwen2.5-coder:14b', size: 9_000_000_000, capabilities: ['completion', 'tools'], contextLength: 32768 }
const collect = async (provider: OllamaProvider, options = {}) => { const chunks = []; for await (const chunk of provider.streamMessage(user, options)) chunks.push(chunk); return chunks }

describe('local settings and Ollama', () => {
  it('keeps UI choice instructions out of spoken replies without changing text chat', async () => {
    const request = vi.fn<typeof fetch>().mockImplementation(async () => events({ message: { content: 'Hello.' }, done: true }))
    const provider = new OllamaProvider(new OllamaService(() => defaultSettings.localAI.endpoint, request), model.name, defaultSettings.localAI, model)
    await collect(provider, { voiceOnly: true })
    const spoken = JSON.parse(request.mock.calls[0][1]?.body as string).messages[0].content
    expect(spoken).not.toContain('Say “Choose one”')
    expect(spoken).not.toContain('accessible selection controls')
    expect(spoken).toContain('Answer the latest spoken request directly')
    await collect(provider)
    expect(JSON.parse(request.mock.calls[1][1]?.body as string).messages[0].content).toContain('Say “Choose one”')
  })
  it('distinguishes chat, embedding-only, and unverified discovered models', async () => {
    expect(localChatCompatibility({ capabilities: ['completion', 'tools'] })).toBe('supported')
    expect(localChatCompatibility({ capabilities: ['embedding'] })).toBe('unsupported')
    expect(localChatCompatibility({ capabilities: [] })).toBe('unknown')
    const embedding = 'nomic-embed-text:latest'
    const settings = mergeSettings(defaultSettings, { localAI: { ...defaultSettings.localAI, model: embedding } })
    const service = { modelDetails: vi.fn(async () => ({ name: embedding, size: 0, capabilities: ['embedding'] })) } as unknown as OllamaService
    await expect(localCompanionProvider(service, settings, { ...defaultConversationConfig(), model: embedding })).rejects.toThrow('does not advertise chat completion')
  })
  it('does not silently downgrade a delegated reasoning-effort override', () => {
    expect(() => validateIsolatedLocalEffort(model, 'auto')).not.toThrow()
    expect(() => validateIsolatedLocalEffort(model, 'high')).toThrow('Select Auto')
    const thinking = { ...model, name: 'gpt-oss:20b', capabilities: ['tools', 'thinking'] }
    expect(() => validateIsolatedLocalEffort(thinking, 'high')).not.toThrow()
    expect(() => validateIsolatedLocalEffort(thinking, 'xhigh')).toThrow('did not silently lower')
  })
  it('keeps old profiles in cloud mode and persists local mode without a cloud key', () => {
    expect(restoreSettings({}).aiMode).toBe('cloud')
    expect(defaultSettings.localAI.speechVoice).toBe('Karen')
    const saved = mergeSettings(defaultSettings, { aiMode: 'local', strictOffline: true, localAI: { ...defaultSettings.localAI, model: model.name } })
    expect(restoreSettings(JSON.parse(JSON.stringify(saved)))).toEqual(saved)
  })
  it('rejects non-loopback endpoints and invalid local model names', () => {
    for (const address of ['https://127.0.0.1:11434', 'http://example.com:11434', 'http://127.0.0.1:11434/path', 'http://user:pass@127.0.0.1:11434']) expect(localEndpointSchema.safeParse(address).success).toBe(false)
    expect(() => mergeSettings(defaultSettings, { localAI: { ...defaultSettings.localAI, endpoint: 'http://example.com:11434' } })).toThrow()
  })
  it('discovers installed models and their reported capabilities', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify({ models: [{ name: model.name, size: model.size }] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ capabilities: model.capabilities, model_info: { 'qwen2.context_length': 32768 }, details: { family: 'qwen2' } })))
    const service = new OllamaService(() => defaultSettings.localAI.endpoint, request)
    const status = await service.status()
    expect(status.models[0]).toMatchObject({ name: model.name, capabilities: ['completion', 'tools'], contextLength: 32768 })
    expect(String(request.mock.calls[0][0])).toBe('http://127.0.0.1:11434/api/tags')
  })
  it('streams text without any cloud request or API key', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(events({ message: { content: 'Hel' } }, { message: { content: 'lo' }, done: true, prompt_eval_count: 8, eval_count: 2 }))
    const provider = new OllamaProvider(new OllamaService(() => defaultSettings.localAI.endpoint, request), model.name, { ...defaultSettings.localAI, model: model.name }, model)
    const onModelResponse = vi.fn(), beforeModelRequest = vi.fn()
    expect(await collect(provider, { onModelResponse, beforeModelRequest })).toEqual([{ type: 'text', text: 'Hel' }, { type: 'text', text: 'lo' }, { type: 'done' }])
    expect(onModelResponse).toHaveBeenCalledExactlyOnceWith({ inputTokens: 8, outputTokens: 2, estimated: false })
    expect(beforeModelRequest.mock.calls[0][2]).toMatchObject({ contextWindow: 16384, limitsVerified: true, outputLimitEnforced: true })
    expect(String(request.mock.calls[0][0])).toBe('http://127.0.0.1:11434/api/chat')
    const payload = JSON.parse(request.mock.calls[0][1]?.body as string)
    expect(payload.model).toBe(model.name)
    expect(payload.options.num_ctx).toBe(16384)
  })
  it('keeps an unconfirmed long window at the trained context', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(events({ message: { content: 'ok' }, done: true }))
    const settings = { ...defaultSettings.localAI, contextLength: 250000, maxOutputTokens: 65536 }
    const provider = new OllamaProvider(new OllamaService(() => settings.endpoint, request), model.name, settings, model)
    await collect(provider)
    const body = JSON.parse(request.mock.calls[0][1]?.body as string)
    expect(body.options.num_ctx).toBe(32768)
    expect(body.options.num_predict).toBe(8192)
    expect(body.think).toBeUndefined()
    expect(body.options.rope_frequency_scale).toBeUndefined()
    expect(localInferenceSettingsSchema.safeParse({ contextLength: 250000, maxOutputTokens: 131072 }).success).toBe(true)
  })
  it('keeps YaRN metadata and a short load confirmation at the trained window', async () => {
    rememberContextConfirmation({ model: 'yarn-qwen', tokens: 131072, confirmedAt: '2026-11-07T00:00:00.000Z', promptTokens: 4, durationMs: 20 })
    const request = vi.fn<typeof fetch>().mockResolvedValue(events({ message: { content: 'ok' }, done: true }))
    const yarn = { ...model, name: 'yarn-qwen', size: 2_000_000_000, contextLength: 32768, architecture: { blocks: 36, kvHeads: 2, headDim: 128 }, ropeScaling: { type: 'yarn', factor: 4, originalContext: 32768 } }
    const provider = new OllamaProvider(new OllamaService(() => defaultSettings.localAI.endpoint, request), yarn.name, { ...defaultSettings.localAI, contextLength: 131072, maxOutputTokens: 1024 }, yarn)
    await collect(provider)
    expect(JSON.parse(request.mock.calls[0][1]?.body as string).options.num_ctx).toBe(32768)
  })
  it('traces Ollama request settings and makes direct voice diagnostics omit prepared context and tools', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(events({ message: { content: 'Four.' } }, { done: true }))
    const settings = { ...defaultSettings.localAI, contextLength: 8192, maxOutputTokens: 1024, temperature: 0.3, keepAliveMinutes: 15, autoUnload: true }
    const provider = new OllamaProvider(new OllamaService(() => settings.endpoint, request), model.name, settings, model, 'PRIVATE ACADEMY SKILL')
    const onLocalInferenceTrace = vi.fn()
    await collect(provider, { voiceOnly: true, diagnosticDirect: true, traceId: 'diagnostic-run', onLocalInferenceTrace,
      context: { attachments: [], repositoryText: 'Retrieved knowledge that direct mode must omit.', sources: [], realtimeInstructions: 'Optional realtime routing.', projectTools: { definitions: [{ name: 'read_file', description: 'Read files', parameters: { type: 'object' } }], assertAccess: vi.fn(), execute: vi.fn() } } })
    const body = JSON.parse(request.mock.calls[0][1]?.body as string)
    expect(body.model).toBe(model.name)
    expect(body.stream).toBe(true)
    expect(body.tools).toBeUndefined()
    expect(body.options).toEqual({ num_ctx: 8192, num_predict: 1024, temperature: 0.3 })
    expect(body.keep_alive).toBe('15m')
    expect(body.messages).toHaveLength(2)
    expect(body.messages[0].content).toContain('Answer the latest spoken request directly')
    expect(JSON.stringify(body.messages)).not.toContain('PRIVATE ACADEMY SKILL')
    expect(JSON.stringify(body.messages)).not.toContain('Retrieved knowledge')
    expect(JSON.stringify(body.messages)).not.toContain('Optional realtime routing')
    expect(onLocalInferenceTrace.mock.calls.map(([event]) => event.stage)).toEqual(['request-start', 'first-token', 'complete'])
    expect(onLocalInferenceTrace.mock.calls[0][0]).toMatchObject({ model: model.name, endpoint: 'http://127.0.0.1:11434/api/chat', numCtx: 8192, numPredict: 1024, temperature: 0.3, keepAlive: '15m', stream: true, toolCount: 0, messageCount: 2, toolBytes: 2 })
    expect(onLocalInferenceTrace.mock.calls[1][0].durationMs).toEqual(expect.any(Number))
  })
  it('defines the Balanced default and the requested inference presets', () => {
    expect(defaultSettings.localAI.preset).toBe('balanced')
    expect(defaultSettings.localAI.contextLength).toBe(16384)
    expect(localAIPresets.coding).toMatchObject({ reasoning: 'high', contextLength: 32768, maxOutputTokens: 8192, temperature: 0.3 })
    expect(localAIPresets['deep-reasoning']).toMatchObject({ reasoning: 'xhigh', maxOutputTokens: 16384, temperature: 0.2 })
  })
  it('migrates legacy local inference controls to Custom without changing their values', () => {
    const { preset: _legacyPreset, ...legacyLocal } = defaultSettings.localAI
    const restored = restoreSettings({ localAI: { ...legacyLocal, contextLength: 46080, maxOutputTokens: 32768, temperature: 0.7, keepAliveMinutes: 5 } })
    expect(restored.localAI.preset).toBe('custom')
    expect(restored.localAI.customInference).toMatchObject({ contextLength: 46080, maxOutputTokens: 32768, temperature: 0.7, keepAliveMinutes: 5 })
  })
  it('repairs a legacy profile that persisted Balanced beside old non-Balanced values', () => {
    const restored = restoreSettings({ localAI: { ...defaultSettings.localAI, contextLength: 46080, maxOutputTokens: 32768, temperature: 0.7, keepAliveMinutes: 5 } })
    expect(restored.localAI.preset).toBe('custom')
    expect(restored.localAI.customInference.temperature).toBe(0.7)
  })
  it('uses the existing validated tool executor for local function calls', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(events({ message: { tool_calls: [{ function: { name: 'read_file', arguments: { path: 'src/a.ts' } } }] }, done: true }))
      .mockResolvedValueOnce(events({ message: { content: 'The file is present.' }, done: true }))
    const execute = vi.fn(async () => JSON.stringify({ ok: true, content: 'export const a = 1' }))
    const provider = new OllamaProvider(new OllamaService(() => defaultSettings.localAI.endpoint, request), model.name, defaultSettings.localAI, model)
    const onModelResponse = vi.fn(), onUsage = vi.fn()
    expect(await collect(provider, { onModelResponse, onUsage, context: { attachments: [], repositoryText: '', sources: [], projectTools: { definitions: [{ name: 'read_file', description: 'Read', parameters: { type: 'object', properties: { path: { type: 'string' } } } }], assertAccess: vi.fn(), execute } } })).toEqual([{ type: 'text', text: 'The file is present.' }, { type: 'done' }])
    expect(onModelResponse).toHaveBeenCalledTimes(2)
    expect(onModelResponse.mock.calls.every(([usage]) => usage.estimated)).toBe(true)
    expect(onUsage.mock.lastCall?.[0].estimated).toBe(true)
    expect(execute).toHaveBeenCalledWith('read_file', { path: 'src/a.ts' }, expect.any(AbortSignal))
    const second = JSON.parse(request.mock.calls[1][1]?.body as string)
    expect(second.messages).toContainEqual(expect.objectContaining({ role: 'tool', tool_name: 'read_file' }))
  })
  it('maps xhigh to the highest advertised Ollama thinking level when xhigh is unavailable', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(events({ message: { content: 'done' }, done: true }))
    const provider = new OllamaProvider(new OllamaService(() => defaultSettings.localAI.endpoint, request), 'gpt-oss:20b', { ...defaultSettings.localAI, reasoning: 'xhigh' }, { ...model, name: 'gpt-oss:20b', capabilities: ['completion', 'thinking'] })
    await collect(provider)
    expect(JSON.parse(request.mock.calls[0][1]?.body as string).think).toBe('high')
  })
  it('does not expose tools to a model without tool capability', async () => {
    const request = vi.fn<typeof fetch>()
    const provider = new OllamaProvider(new OllamaService(() => defaultSettings.localAI.endpoint, request), 'plain', defaultSettings.localAI, { ...model, capabilities: ['completion'] })
    await expect(collect(provider, { context: { attachments: [], repositoryText: '', sources: [], projectTools: { definitions: [{ name: 'read_file', description: 'Read', parameters: {} }], assertAccess: vi.fn(), execute: vi.fn() } } })).rejects.toThrow('does not support tool calling')
    expect(request).not.toHaveBeenCalled()
  })
  it('executes one fenced JSON tool call and leaves a prose mention alone', async () => {
    const tools = (execute: ReturnType<typeof vi.fn>) => ({ attachments: [], repositoryText: '', sources: [], projectTools: { definitions: [{ name: 'read_file', description: 'Read', parameters: { type: 'object', properties: { path: { type: 'string' } } } }], assertAccess: vi.fn(), execute } })
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(events({ message: { content: '```json\n{"name":"read_file","arguments":{"path":"src/a.ts"}}\n```' }, done: true }))
      .mockResolvedValueOnce(events({ message: { content: 'The file is present.' }, done: true }))
    const execute = vi.fn(async () => JSON.stringify({ ok: true, content: 'export const a = 1' }))
    const provider = new OllamaProvider(new OllamaService(() => defaultSettings.localAI.endpoint, request), model.name, defaultSettings.localAI, model)
    expect(await collect(provider, { context: tools(execute) })).toEqual([{ type: 'text', text: 'The file is present.' }, { type: 'done' }])
    expect(execute).toHaveBeenCalledWith('read_file', { path: 'src/a.ts' }, expect.any(AbortSignal))
    const mention = vi.fn<typeof fetch>().mockResolvedValue(events({ message: { content: 'A read_file call could look at src/a.ts, but this answer does not request one.' }, done: true }))
    const mentionExecute = vi.fn()
    const mentionProvider = new OllamaProvider(new OllamaService(() => defaultSettings.localAI.endpoint, mention), model.name, defaultSettings.localAI, model)
    expect(await collect(mentionProvider, { context: tools(mentionExecute) })).toEqual([{ type: 'text', text: 'A read_file call could look at src/a.ts, but this answer does not request one.' }, { type: 'done' }])
    expect(mentionExecute).not.toHaveBeenCalled()
  })
  it('routes local voice without calling cloud services', async () => {
    const settings = localCompanionSettings(mergeSettings(defaultSettings, { strictOffline: true }))
    const cloud = { transcribe: vi.fn(async () => 'cloud') }, local = { transcribe: vi.fn(async () => 'local') }
    const clip = { id: '00000000-0000-4000-a000-000000000001', sessionId: '00000000-0000-4000-a000-000000000002', mimeType: 'audio/wav' as const, bytes: new Uint8Array([1]) }
    expect(await new RoutedTranscription(() => settings, cloud, local).transcribe(clip, new AbortController().signal)).toBe('local')
    expect(cloud.transcribe).not.toHaveBeenCalled()
    expect(new LocalMacSpeech(() => settings).mimeType).toBe('audio/wav')
  })
  it.skipIf(process.platform !== 'darwin')('synthesizes playable audio with the macOS offline voice', async () => {
    const speech = new LocalMacSpeech(() => defaultSettings)
    const bytes = await speech.generate('Hello from Athena.', 'coral', 1, new AbortController().signal)
    expect(bytes.length).toBeGreaterThan(100)
    expect(Buffer.from(bytes).toString('ascii', 0, 4)).toBe('RIFF')
  })
})
