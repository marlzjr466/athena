import type { LocalModel } from './localAI'

export const llamaLongModelId = 'llama.cpp:qwen2.5-coder-3b'
export const llamaLongGguf = '/Users/mariojrlangomez/.ollama/models/blobs/sha256-4a188102020e9c9530b687fd6400f775c45e90a0d7baafe65bd0a36963fbb7ba'

export interface LlamaLevelResult {
  id: string
  requestedTokens: number
  yarnFactor: number | null
  loaded: boolean
  passed: boolean
  allocatedTokens?: number | null
  promptTokens?: number | null
  generatedTokens?: number | null
  promptPerSecond?: number | null
  generationPerSecond?: number | null
  processRssBytes?: number | null
  kvCacheBytes?: number | null
  retrieval?: { start: boolean; middle: boolean; end: boolean }
  multiTurnMiddle?: boolean | null
  error?: string
  answer?: string
}

export interface LlamaValidation {
  runtime: { executable: string; version: string; fingerprint?: string; commit?: string; build?: string }
  model: { id: string; gguf: string; family: string; quantization: string; parameterCount?: number; trainedContext: number; ollamaModelPreserved: string }
  server?: { flashAttention: string; kvCache: string; gpuLayers: string; metalDevice: string }
  checkedAt: string
  levels: LlamaLevelResult[]
  validatedMaximum: number
  limitations: string[]
}

export function llamaLongMetadata(): LocalModel {
  return { provider: 'llama.cpp', name: llamaLongModelId, label: 'Qwen2.5-Coder-3B long context', size: 1_929_903_072, capabilities: ['completion'], contextLength: 32_768, family: 'qwen2', quantization: 'Q4_K_M', architecture: { blocks: 36, kvHeads: 2, headDim: 128 } }
}

export function isLlamaValidation(value: unknown): value is LlamaValidation {
  if (!value || typeof value !== 'object') return false
  const record = value as LlamaValidation
  return record.model?.id === llamaLongModelId && Array.isArray(record.levels) && typeof record.validatedMaximum === 'number'
}

/** Smallest retrieval-validated window that can hold the request. Larger profiles stay unavailable. */
export function resolveLlamaWindow(requested: number, validation: LlamaValidation | null): { allocated: number; factor: number | null; validatedMaximum: number; available: boolean } {
  const validatedMaximum = validation?.validatedMaximum ?? 0
  const passed = (validation?.levels ?? []).filter((level) => level.passed && level.requestedTokens > 0).sort((a, b) => a.requestedTokens - b.requestedTokens)
  const fit = passed.find((level) => requested <= level.requestedTokens)
  if (!fit) {
    const highest = passed.at(-1)
    return { allocated: highest?.requestedTokens ?? 0, factor: highest && highest.requestedTokens > 32_768 ? highest.yarnFactor : null, validatedMaximum, available: false }
  }
  return { allocated: fit.requestedTokens, factor: fit.requestedTokens > 32_768 ? fit.yarnFactor ?? null : null, validatedMaximum, available: true }
}
