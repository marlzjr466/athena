import { localAIPresets, localOutputCeiling, type LocalAIPreset, type LocalInferenceSettings, type LocalModel } from './localAI'

/** Qwen2.5-Coder documents 8,192 generated tokens. The installed GGUF card does not replace that figure. */
export const qwenCoderDocumentedOutputTokens = 8192

export interface GenerationLimit {
  tokens: number | null
  source: 'model-card' | 'qwen2.5-coder-documentation' | 'mlx-runtime' | 'unreported'
}

export function generationLimitFor(model: Pick<LocalModel, 'name' | 'provider' | 'generationLimit'>): GenerationLimit {
  if (typeof model.generationLimit === 'number' && model.generationLimit >= 256) return { tokens: Math.floor(model.generationLimit), source: 'model-card' }
  if (model.provider === 'mlx') return { tokens: 8192, source: 'mlx-runtime' }
  if (/qwen2\.5-coder/i.test(model.name)) return { tokens: qwenCoderDocumentedOutputTokens, source: 'qwen2.5-coder-documentation' }
  return { tokens: null, source: 'unreported' }
}

export function generationLimitLabel(limit: GenerationLimit): string {
  if (limit.source === 'model-card' && limit.tokens) return `${limit.tokens.toLocaleString('en-US')} reported by the model card`
  if (limit.source === 'qwen2.5-coder-documentation' && limit.tokens) return `${limit.tokens.toLocaleString('en-US')} from Qwen2.5-Coder documentation. This model card did not report a generation limit.`
  if (limit.source === 'mlx-runtime' && limit.tokens) return `${limit.tokens.toLocaleString('en-US')} Athena MLX runtime cap`
  return 'Not reported'
}

/** Room left in the allocated window after the prompt, with 256 tokens held back for the request itself. */
export function reservedOutputTokens(requested: number, generationCap: number | null, allocated: number, used: number): number {
  const room = Math.max(1, allocated - used - 256)
  const cap = generationCap ?? Number.POSITIVE_INFINITY
  return Math.max(1, Math.min(cap, Math.max(1, requested), room))
}

export function applyResponsePreset(input: {
  preset: LocalAIPreset
  current: LocalInferenceSettings
  supportsThinking: boolean
  supportsExtraHigh: boolean
  generationTokens: number | null
  allocatedTokens: number
}): { ok: true; next: LocalInferenceSettings; note?: string } | { ok: false; reason: string } {
  if (input.preset === 'deep-reasoning' && !input.supportsThinking) {
    return { ok: false, reason: 'Deep Reasoning is unavailable. This model does not advertise a reasoning-effort control, so Athena will not send one.' }
  }
  const source = input.preset === 'custom' ? input.current : localAIPresets[input.preset]
  const outputCap = Math.min(input.generationTokens ?? localOutputCeiling, Math.max(256, input.allocatedTokens))
  const note = input.preset === 'deep-reasoning' && !input.supportsExtraHigh ? 'Deep Reasoning uses High, the highest reasoning effort this model advertises.' : undefined
  return {
    ok: true,
    note,
    next: {
      ...source,
      contextLength: input.current.contextLength,
      reasoning: !input.supportsThinking ? 'auto' : input.preset === 'deep-reasoning' ? (input.supportsExtraHigh ? 'xhigh' : 'high') : input.supportsThinking ? source.reasoning : 'auto',
      maxOutputTokens: Math.max(256, Math.min(outputCap, source.maxOutputTokens)),
    },
  }
}
