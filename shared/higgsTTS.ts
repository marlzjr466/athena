import { z } from 'zod'
import tokenCatalog from '../voice-service/higgs_tokens.json'

export const HIGGS_REPO = 'bosonai/higgs-tts-3-4b'
export const HIGGS_ENGINE = 'higgs-tts-3-4b' as const
export const HIGGS_PROFILE_NAME = 'Athena — Higgs Expressive'
export const HIGGS_LICENSE_NOTE = 'Official bosonai/higgs-tts-3-4b is released for research and non-commercial use. Athena keeps the checkpoint local, does not host it as an API, and does not bundle weights in a public installer.'
export const HIGGS_WAKE_ACKNOWLEDGEMENTS = ["I'm listening.", "Hey, I'm here.", 'Yep, go ahead.'] as const
export function chooseHiggsWakeAcknowledgement(previous: string | undefined, random = Math.random): string {
  const options = HIGGS_WAKE_ACKNOWLEDGEMENTS.filter((phrase) => phrase !== previous)
  const pool = options.length ? options : [...HIGGS_WAKE_ACKNOWLEDGEMENTS]
  return pool[Math.min(pool.length - 1, Math.floor(Math.max(0, random()) * pool.length))]
}

/** Official PROMPTING.md catalog, checked 2026-10-22. Tokenizer entries cannot extend it. */
export const HIGGS_SUPPORTED_TOKENS = tokenCatalog
export const HIGGS_EXAMPLE_EMOTIONS = ['amusement', 'enthusiasm', 'contemplation'] as const

export const higgsEmotionSchema = z.enum(HIGGS_EXAMPLE_EMOTIONS)
export const higgsLaughterSchema = z.enum(['off', 'rare', 'contextual'])
export const higgsLanguageSchema = z.enum(['en', 'tl', 'auto'])
export const higgsDeviceSchema = z.enum(['cpu', 'mps', 'cuda'])

export const higgsSettingsSchema = z.object({
  device: higgsDeviceSchema.default('mps'),
  language: higgsLanguageSchema.default('en'),
  // Migrate the previously emitted, unsupported style without resetting other preferences.
  style: z.preprocess(value => value === 'conversational' ? 'auto' : value,
    z.enum(['auto', 'singing', 'shouting', 'whispering']).default('auto')),
  emotionPreference: z.enum(['auto', ...HIGGS_EXAMPLE_EMOTIONS]).default('auto'),
  laughterFrequency: higgsLaughterSchema.default('contextual'),
  referenceId: z.string().uuid().optional(),
  profileName: z.string().trim().min(1).max(80).default(HIGGS_PROFILE_NAME),
}).strict()
export type HiggsSettings = z.infer<typeof higgsSettingsSchema>
export const defaultHiggsSettings = higgsSettingsSchema.parse({})

export const higgsCommandSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('status') }).strict(),
  z.object({ action: z.literal('setup') }).strict(),
  z.object({ action: z.literal('download') }).strict(),
  z.object({ action: z.literal('verify') }).strict(),
  z.object({ action: z.literal('cancel') }).strict(),
  z.object({ action: z.literal('unload') }).strict(),
  z.object({ action: z.literal('remove') }).strict(),
  z.object({ action: z.literal('import-reference'), transcript: z.string().trim().min(1).max(1200), authorized: z.literal(true) }).strict(),
  z.object({ action: z.literal('remove-reference'), id: z.string().uuid() }).strict(),
])
export type HiggsCommand = z.infer<typeof higgsCommandSchema>

export interface HiggsReference { id: string; name: string; transcript: string; seconds: number }
export interface HiggsSupportedTokens {
  emotion: string[]
  style: string[]
  prosody: string[]
  sfx: string[]
}
export interface HiggsStatus {
  runtime: boolean
  compatible?: boolean
  compatibilityMessage?: string
  downloaded: boolean
  verified: boolean
  loaded: boolean
  busy: boolean
  stage: string
  error?: string
  device?: string
  progress?: number
  diskEstimateBytes?: number
  memoryWarning?: string
  architecture?: string
  streaming?: boolean
  license?: string
  supportedTokens?: HiggsSupportedTokens
  references: HiggsReference[]
  metrics?: { loadMs: number; generationMs: number; totalMs: number; firstAudioMs: number; audioSeconds: number; peakProcessBytes: number; device: string; streaming: boolean }
}
export interface HiggsResult { ok: boolean; message?: string; status?: HiggsStatus; referenceId?: string }

