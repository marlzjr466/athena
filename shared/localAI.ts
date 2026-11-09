import { z } from 'zod'

export const localEndpointSchema = z.string().url().refine((value) => {
  const url = new URL(value)
  return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    && !url.username && !url.password && !url.search && !url.hash && (url.pathname === '/' || url.pathname === '')
}, 'Ollama must use a loopback HTTP endpoint.')
export const localModelIdSchema = z.string().trim().min(1).max(150).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/)
export const localAIPresetSchema = z.enum(['fast', 'balanced', 'coding', 'deep-reasoning', 'custom']).catch('balanced')
export type LocalAIPreset = z.infer<typeof localAIPresetSchema>
/** Slider ceiling. The context engine's Maximum profile is 250,000 tokens. */
export const localContextCeiling = 262144
export const localOutputCeiling = 131072
export const localInferenceSettingsSchema = z.object({
  reasoning: z.enum(['auto', 'low', 'medium', 'high', 'xhigh']).default('medium'),
  contextLength: z.number().int().min(2048).max(localContextCeiling).default(16384),
  maxOutputTokens: z.number().int().min(256).max(localOutputCeiling).default(4096),
  temperature: z.number().min(0).max(2).default(0.5),
  keepAliveMinutes: z.number().int().min(0).max(120).default(10),
  autoUnload: z.boolean().default(true),
}).strict()
export type LocalInferenceSettings = z.infer<typeof localInferenceSettingsSchema>
export const localInferenceDefaults = (): LocalInferenceSettings => localInferenceSettingsSchema.parse({})

export const localAIPresets: Record<Exclude<LocalAIPreset, 'custom'>, LocalInferenceSettings> = {
  fast: { reasoning: 'low', contextLength: 8192, maxOutputTokens: 2048, temperature: 0.5, keepAliveMinutes: 5, autoUnload: true },
  balanced: { reasoning: 'medium', contextLength: 16384, maxOutputTokens: 4096, temperature: 0.5, keepAliveMinutes: 10, autoUnload: true },
  coding: { reasoning: 'high', contextLength: 32768, maxOutputTokens: 8192, temperature: 0.3, keepAliveMinutes: 15, autoUnload: true },
  'deep-reasoning': { reasoning: 'xhigh', contextLength: 32768, maxOutputTokens: 16384, temperature: 0.2, keepAliveMinutes: 15, autoUnload: true },
}

export const localAISettingsSchema = z.object({
  endpoint: localEndpointSchema.default('http://127.0.0.1:11434'),
  model: localModelIdSchema.nullable().default(null),
  visionModel: localModelIdSchema.nullable().default(null),
  ...localInferenceSettingsSchema.shape,
  preset: localAIPresetSchema.default('balanced'),
  customInference: localInferenceSettingsSchema.default(localInferenceDefaults),
  speechEngine: z.enum(['whisper-cli', 'unavailable']).default('whisper-cli'),
  speechModelPath: z.string().max(1000).default(''),
  speechVoice: z.string().max(100).default('Karen'),
}).strict()
export type LocalAISettings = z.infer<typeof localAISettingsSchema>
export const localAIDefaults = (): LocalAISettings => localAISettingsSchema.parse({})

export interface LocalModel {
  /** Runtime identifier. New local adapters can register their provider
   * without changing project-awareness policy or filesystem tooling. */
  provider?: string
  label?: string
  name: string
  size: number
  modifiedAt?: string
  digest?: string
  capabilities: string[]
  contextLength?: number
  family?: string
  quantization?: string
  architecture?: { blocks: number; kvHeads: number; headDim: number }
  ropeScaling?: { type: string; factor?: number; originalContext?: number }
  /** Present only when the model card reports a generation length. */
  generationLimit?: number
}
/** Empty capability lists can mean an older Ollama server or a failed /api/show. */
export function localChatCompatibility(model: Pick<LocalModel, 'capabilities'>): 'supported' | 'unsupported' | 'unknown' {
  if (model.capabilities.includes('completion')) return 'supported'
  return model.capabilities.length ? 'unsupported' : 'unknown'
}
export interface LocalStatus {
  connected: boolean
  message: string
  models: LocalModel[]
  arch: string
  totalMemoryBytes: number
  freeMemoryBytes: number
  mlxDiagnostics?: import('./mlxInference').MLXDiagnostic[]
  whisperInstalled: boolean
  /** Whether the configured local Whisper model currently exists as a readable file. */
  whisperModelAvailable?: boolean
  macSpeechAvailable: boolean
  macVoices: Array<{ name: string; locale: string }>
  contextAllocations?: Array<{ model: string; tokens: number; confirmedAt: string; promptTokens: number; durationMs: number }>
  /** Last reply measured by the inference engine. System and history counts come from the GGUF tokenizer when it is available. */
  lastPromptUsage?: { model: string; promptTokens: number; outputTokens: number; contextWindow: number; reservedOutputTokens: number; systemTokens: number | null; historyTokens: number | null; at: string }
  engineFindings?: import('./engineSupport').EngineFinding[]
  longContextNote?: string
  llamaValidation?: import('./llamaLongContext').LlamaValidation | null
}
export interface LocalPullProgress { model: string; status: string; completed?: number; total?: number; done?: boolean; error?: string }
