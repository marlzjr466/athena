// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { defaultSettings } from '../shared/settings'
import { applyResponsePreset, generationLimitFor, reservedOutputTokens } from '../shared/localResponse'
import { OllamaService } from '../electron/main/ai/ollamaService'
import { OllamaProvider } from '../electron/main/ai/OllamaProvider'
import { latestPromptUsage } from '../electron/main/ai/contextEngineRuntime'
import type { ChatMessage } from '../shared/chat'

const events = (...items: unknown[]) => new Response(items.map((item) => JSON.stringify(item)).join('\n') + '\n')
const current = { ...defaultSettings.localAI, contextLength: 250_000, maxOutputTokens: 65_536, temperature: 0.7 }

describe('model-specific local response settings', () => {
  it('uses the documented Qwen2.5-Coder generation length when the model card omits one', () => {
    expect(generationLimitFor({ name: 'qwen2.5-coder:3b' })).toEqual({ tokens: 8192, source: 'qwen2.5-coder-documentation' })
    expect(generationLimitFor({ name: 'qwen2.5-coder:3b', generationLimit: 4096 })).toEqual({ tokens: 4096, source: 'model-card' })
    expect(generationLimitFor({ name: 'llama3:8b' })).toEqual({ tokens: null, source: 'unreported' })
  })

  it('keeps response presets from changing context capacity', () => {
    const fast = applyResponsePreset({ preset: 'fast', current, supportsThinking: false, supportsExtraHigh: false, generationTokens: 8192, allocatedTokens: 32_768 })
    expect(fast.ok).toBe(true)
    if (!fast.ok) return
    expect(fast.next.contextLength).toBe(250_000)
    expect(fast.next.temperature).toBe(0.5)
    expect(fast.next.maxOutputTokens).toBe(2048)
    const coding = applyResponsePreset({ preset: 'coding', current, supportsThinking: false, supportsExtraHigh: false, generationTokens: 8192, allocatedTokens: 32_768 })
    expect(coding.ok && coding.next).toMatchObject({ contextLength: 250_000, reasoning: 'auto', temperature: 0.3, maxOutputTokens: 8192 })
  })

  it('does not invent a reasoning-effort control for a model that does not advertise one', () => {
    const deep = applyResponsePreset({ preset: 'deep-reasoning', current, supportsThinking: false, supportsExtraHigh: false, generationTokens: 8192, allocatedTokens: 32_768 })
    expect(deep.ok).toBe(false)
    if (deep.ok) return
    expect(deep.reason).toContain('does not advertise')
  })

  it('uses the highest advertised effort and the generation cap for Deep Reasoning', () => {
    const deep = applyResponsePreset({ preset: 'deep-reasoning', current, supportsThinking: true, supportsExtraHigh: false, generationTokens: 8192, allocatedTokens: 32_768 })
    expect(deep.ok && deep.next).toMatchObject({ contextLength: 250_000, reasoning: 'high', maxOutputTokens: 8192, temperature: 0.2 })
    expect(deep.ok && deep.note).toContain('High')
  })

  it('keeps reserved output inside the allocated context and the generation cap', () => {
    expect(reservedOutputTokens(65_536, 8192, 32_768, 1_000)).toBe(8192)
    expect(reservedOutputTokens(65_536, 8192, 32_768, 30_000)).toBe(32_768 - 30_000 - 256)
    expect(reservedOutputTokens(65_536, 8192, 32_768, 1_000)).toBeLessThanOrEqual(32_768 - 1_000 - 256)
  })

  it('sends the trained window and records measured prompt usage when 250K cannot be allocated', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(events({ message: { content: 'ok' }, done: true, prompt_eval_count: 1200, eval_count: 40 }))
    const model = { name: 'qwen2.5-coder:3b', size: 2_000_000_000, capabilities: ['completion', 'tools'], contextLength: 32_768 }
    const provider = new OllamaProvider(new OllamaService(() => defaultSettings.localAI.endpoint, request), model.name, current, model)
    const messages: ChatMessage[] = [{ id: 'u', role: 'user', content: 'Hello', status: 'complete', createdAt: 1 }]
    for await (const _ of provider.streamMessage(messages, {})) { /* drain */ }
    const body = JSON.parse(request.mock.calls[0][1]?.body as string)
    expect(body.options).toMatchObject({ num_ctx: 32_768, num_predict: 8192 })
    expect(body.think).toBeUndefined()
    expect(latestPromptUsage()).toMatchObject({ model: model.name, promptTokens: 1200, outputTokens: 40, contextWindow: 32_768 })
  })
})
