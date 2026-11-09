// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { allocationNotice, allocationStatusLabel, buildContextNeedle, contextProfiles, estimateKvCacheBytes, recallNeedles, resolveLocalContext, type ContextRequest } from '../shared/contextEngine'
import { OllamaService } from '../electron/main/ai/ollamaService'
import { probeLocalContext } from '../electron/main/ai/contextEngineRuntime'

const qwen3b: ContextRequest = {
  requestedTokens: 32_768,
  reportedContextTokens: 32_768,
  engine: 'ollama',
  architecture: { blocks: 36, kvHeads: 2, headDim: 128 },
  weightBytes: 2_000_000_000,
  totalMemoryBytes: 24 * 1024 ** 3,
  freeMemoryBytes: 8 * 1024 ** 3,
}

describe('local context engine', () => {
  it('defines the five profiles and the documented 128K factor', () => {
    expect(contextProfiles.map((profile) => profile.tokens)).toEqual([32_768, 65_536, 131_072, 196_608, 250_000])
    expect(contextProfiles.find((profile) => profile.id === 'long')?.yarnFactor).toBe(4)
    expect(contextProfiles.find((profile) => profile.id === 'maximum')?.yarnFactor).toBeCloseTo(7.63, 2)
  })

  it('estimates the Qwen2.5-3B fp16 KV cache', () => {
    expect(estimateKvCacheBytes(qwen3b.architecture!, 250_000)).toBe(9_216_000_000)
    expect(estimateKvCacheBytes(qwen3b.architecture!, 32_768)).toBe(1_207_959_552)
  })

  it('allocates the trained window and does not apply YaRN', () => {
    const decision = resolveLocalContext(qwen3b)
    expect(decision).toMatchObject({ profile: 'standard', allocatedTokens: 32_768, allocationState: 'trained-window', experimental: false, yarnRequired: false, yarnFactor: null, eligible: true })
    expect(decision.explanation).toContain('YaRN is not applied')
  })

  it.each([65_536, 131_072, 196_608, 250_000])('rejects %i tokens when the model card has no YaRN metadata', (requestedTokens) => {
    const decision = resolveLocalContext({ ...qwen3b, requestedTokens })
    expect(decision.allocatedTokens).toBe(32_768)
    expect(decision.allocationState).toBe('fallback')
    expect(decision.eligible).toBe(false)
    expect(decision.explanation).toContain('no YaRN')
    expect(decision.explanation).toContain('was not modified')
    expect(allocationStatusLabel(decision)).toBe('Falling back to Standard')
  })

  it('marks 128K as documented YaRN and 250K as experimental', () => {
    const long = resolveLocalContext({ ...qwen3b, requestedTokens: 131_072, rope: { type: 'yarn', factor: 4, originalContext: 32_768 } })
    expect(long).toMatchObject({ documentedYarn: true, experimental: false, eligible: true, allocationState: 'unmeasured', allocatedTokens: 32_768, yarnFactor: 4 })
    const maximum = resolveLocalContext({ ...qwen3b, requestedTokens: 250_000, rope: { type: 'yarn', factor: 4, originalContext: 32_768 } })
    expect(maximum.experimental).toBe(true)
    expect(maximum.eligible).toBe(false)
    expect(maximum.allocatedTokens).toBe(32_768)
    const loaded = resolveLocalContext({ ...qwen3b, requestedTokens: 250_000, rope: { type: 'yarn', factor: 8, originalContext: 32_768 }, confirmedTokens: 250_000 })
    expect(loaded).toMatchObject({ eligible: true, allocationState: 'unmeasured', allocatedTokens: 32_768 })
    expect(loaded.explanation).toContain('retrieval test')
    const notice = allocationNotice(resolveLocalContext({ ...qwen3b, requestedTokens: 250_000 }))
    expect(notice).toMatchObject({ prominent: true, status: 'Falling back to Standard', engine: 'Ollama', measureAllowed: false })
    expect(notice.why).toContain('num_ctx')
    expect(notice.missingCapability).toContain('YaRN')
    expect(notice.activeProfile).toContain('Standard')
    expect(notice.measureReason).toContain('will not load')
  })

  it('refuses a measured 250K window when memory does not fit', () => {
    const decision = resolveLocalContext({ ...qwen3b, requestedTokens: 250_000, rope: { type: 'yarn', factor: 8, originalContext: 32_768 }, confirmedTokens: 250_000, freeMemoryBytes: 1024 ** 3, totalMemoryBytes: 8 * 1024 ** 3 })
    expect(decision.eligible).toBe(false)
    expect(decision.allocatedTokens).toBe(32_768)
    expect(decision.allocationState).toBe('fallback')
  })

  it('keeps MLX requests inside the checkpoint context', () => {
    const decision = resolveLocalContext({ ...qwen3b, requestedTokens: 131_072, engine: 'mlx', mlxAppliesYarn: false, rope: { type: 'yarn', factor: 4, originalContext: 32_768 } })
    expect(decision.engine).toBe('mlx')
    expect(decision.allocatedTokens).toBe(32_768)
    expect(decision.explanation).toContain('MLX')
  })

  it('places recall needles at the start, middle, and end of every profile', () => {
    for (const profile of contextProfiles) {
      const fixture = buildContextNeedle(profile.tokens)
      expect(fixture.tokenCount).toBe(profile.tokens)
      const words = fixture.prompt.split(' ')
      expect(words).toHaveLength(profile.tokens)
      expect(words[0]).toBe('needle-start-alpha')
      expect(words[Math.floor((profile.tokens - 1) / 2)]).toBe('needle-middle-bravo')
      expect(words.at(-1)).toBe('needle-end-charlie')
      const recalled = recallNeedles(`start ${words[0]} end ${words.at(-1)}`, fixture.needles)
      expect(recalled.map((needle) => needle.recalled)).toEqual([true, false, true])
    }
  })

  it('measures the installed 32K model and records longer profiles as unallocated', async () => {
    let card: { model_info?: Record<string, unknown>; size?: number; capabilities?: string[] }
    try {
      const response = await fetch('http://127.0.0.1:11434/api/show', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'qwen2.5-coder:3b' }) })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      card = await response.json() as typeof card
    } catch {
      expect.fail('Ollama is not serving qwen2.5-coder:3b, so the installed-model benchmark could not run.')
    }
    const info = card.model_info ?? {}
    const number = (suffix: string) => { const value = Object.entries(info).find(([key]) => key.endsWith(suffix))?.[1]; return typeof value === 'number' ? value : undefined }
    expect(number('.context_length')).toBe(32_768)
    expect(Object.keys(info).some((key) => key.endsWith('.rope.scaling.type'))).toBe(false)
    const hardware = { totalMemoryBytes: 24 * 1024 ** 3, freeMemoryBytes: 8 * 1024 ** 3 }
    const architecture = { blocks: number('.block_count')!, kvHeads: number('.attention.head_count_kv')!, headDim: number('.embedding_length')! / number('.attention.head_count')! }
    const started = Date.now()
    const chat = await fetch('http://127.0.0.1:11434/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'qwen2.5-coder:3b', stream: false, messages: [{ role: 'user', content: 'Reply with the single word ready.' }], options: { num_ctx: 32_768, num_predict: 8, temperature: 0 } }) })
    const body = await chat.json() as { prompt_eval_count?: number; message?: { content?: string }; error?: string }
    expect(chat.ok, body.error).toBe(true)
    expect(body.prompt_eval_count).toBeGreaterThan(0)
    const results = contextProfiles.map((profile) => {
      const decision = resolveLocalContext({ requestedTokens: profile.tokens, reportedContextTokens: 32_768, engine: 'ollama', architecture, weightBytes: card.size, ...hardware })
      return { profile: profile.id, allocated: decision.allocatedTokens, state: decision.allocationState, eligible: decision.eligible }
    })
    expect(results[0]).toMatchObject({ profile: 'standard', allocated: 32_768, eligible: true })
    expect(results.slice(1).every((result) => result.allocated === 32_768 && result.eligible === false)).toBe(true)
    expect(Date.now() - started).toBeLessThan(180_000)
  }, 180_000)

  it('does not load the model for an unsupported 250K measurement', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      capabilities: ['completion', 'tools'], size: qwen3b.weightBytes,
      model_info: { 'qwen2.context_length': 32768, 'qwen2.block_count': 36, 'qwen2.attention.head_count': 16, 'qwen2.attention.head_count_kv': 2, 'qwen2.embedding_length': 2048, 'qwen2.rope.freq_base': 1000000 },
    })))
    const result = await probeLocalContext(new OllamaService(() => 'http://127.0.0.1:11434', request), 'qwen2.5-coder:3b', 250_000)
    expect(result.ok).toBe(false)
    expect(result.decision.allocatedTokens).toBe(32_768)
    expect(request).toHaveBeenCalledTimes(1)
    expect(String(request.mock.calls[0][0])).toContain('/api/show')
  })

  it('does not load a 128K window just because the card contains YaRN metadata', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      capabilities: ['completion'], size: qwen3b.weightBytes,
      model_info: { 'qwen2.context_length': 32768, 'qwen2.block_count': 36, 'qwen2.attention.head_count': 16, 'qwen2.attention.head_count_kv': 2, 'qwen2.embedding_length': 2048, 'qwen2.rope.scaling.type': 'yarn', 'qwen2.rope.scaling.factor': 4, 'qwen2.rope.scaling.original_context_length': 32768 },
    })))
    const result = await probeLocalContext(new OllamaService(() => 'http://127.0.0.1:11434', request), 'qwen2.5-coder:3b', 131_072)
    expect(result.ok).toBe(false)
    expect(result.decision.allocatedTokens).toBe(32_768)
    expect(result.message).toContain('will not load')
    expect(request.mock.calls.some(([url]) => String(url).includes('/api/chat'))).toBe(false)
  })
})
