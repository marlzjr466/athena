import { z } from 'zod'
import { officialCSMSettingsSchema } from './officialCSM'
import { higgsSettingsSchema } from './higgsTTS'

export const voiceEngineSchema = z.enum(['chatterbox-turbo', 'sesame-csm', 'sesame-csm-official', 'higgs-tts-3-4b'])
export type VoiceEngine = z.infer<typeof voiceEngineSchema>
export function isSesameEngine(engine: VoiceEngine): boolean {
  return engine === 'sesame-csm' || engine === 'sesame-csm-official'
}
export function isHiggsEngine(engine: VoiceEngine): boolean {
  return engine === 'higgs-tts-3-4b'
}
export const voiceStyleSchema = z.enum(['conversational', 'neutral', 'warm', 'happy', 'calm', 'concerned', 'excited'])
export type VoiceStyle = z.infer<typeof voiceStyleSchema>
export const localVoiceSettingsSchema = z.object({
  engine: voiceEngineSchema.default('chatterbox-turbo'),
  profileId: z.string().min(1).max(100).default('athena-youthful'),
  style: voiceStyleSchema.default('conversational'),
  expressiveness: z.number().finite().min(0).max(1).default(0.65),
  autoSpeak: z.boolean().default(true),
  naturalAcknowledgments: z.boolean().default(true),
  speakBeforeActions: z.boolean().default(true),
  spokenProgress: z.boolean().default(true),
  progressIntervalSeconds: z.number().int().min(30).max(300).default(60),
  completionAnnouncements: z.boolean().default(true),
  allowSpeechInterruption: z.boolean().default(true),
  officialCSM: officialCSMSettingsSchema.default({ device: 'cpu', speaker: 0, context: true }),
  higgs: higgsSettingsSchema.default({ device: 'mps', language: 'en', style: 'auto', emotionPreference: 'auto', laughterFrequency: 'contextual', profileName: 'Athena — Higgs Expressive' }),
  sesame: z.object({
    conversationContext: z.boolean().default(true),
    naturalLaughter: z.boolean().default(false),
    keepWarmSeconds: z.number().int().min(30).max(600).default(120),
    personality: z.string().trim().max(1000).default('Warm, youthful adult feminine delivery; clear American English; gentle pauses and understated playfulness.'),
    pacing: z.enum(['natural', 'gentle']).default('natural'),
  }).default({ conversationContext: true, naturalLaughter: false, keepWarmSeconds: 120, personality: 'Warm, youthful adult feminine delivery; clear American English; gentle pauses and understated playfulness.', pacing: 'natural' }),
}).strict()
export type LocalVoiceSettings = z.infer<typeof localVoiceSettingsSchema>
export const defaultLocalVoiceSettings = localVoiceSettingsSchema.parse({})

export const voiceProfileSchema = z.object({
  id: z.string().min(1).max(100),
  name: z.string().trim().min(1).max(80),
  builtIn: z.boolean(),
  referenceText: z.string().trim().max(500).optional(),
  accent: z.literal('en-US').optional(),
  referenceSource: z.string().optional(),
}).strict()
export type VoiceProfile = z.infer<typeof voiceProfileSchema>
export const voiceProfileCommandSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('add'), referenceText: z.string().trim().max(500).optional() }).strict(),
  z.object({ action: z.literal('rename'), id: z.string(), name: z.string().trim().min(1).max(80) }).strict(),
  z.object({ action: z.literal('delete'), id: z.string() }).strict(),
])
export type VoiceProfileCommand = z.infer<typeof voiceProfileCommandSchema>
export const localVoiceEngineStatusSchema = z.enum(['not-installed', 'downloading', 'installed', 'loading', 'ready', 'failed', 'unavailable'])
export type LocalVoiceEngineStatus = z.infer<typeof localVoiceEngineStatusSchema>
export interface LocalVoiceStatus {
  runtime: 'ready' | 'missing' | 'unavailable'
  engines: Record<VoiceEngine, { status: LocalVoiceEngineStatus; detail?: string }>
  profiles: VoiceProfile[]
  activeDownload?: { engine: VoiceEngine; progress: number; detail: string }
  metrics?: Partial<Record<VoiceEngine, VoiceMetrics>>
  integrity?: Partial<Record<VoiceEngine, string>>
}
export const voiceMetricsSchema = z.object({ loadMs: z.number(), firstAudioMs: z.number(), generationMs: z.number(), audioSeconds: z.number(), realtimeFactor: z.number(), peakMetalBytes: z.number(), peakProcessBytes: z.number(), chunks: z.number(), measuredAt: z.string(), playbackStartupMs: z.number().optional() })
export type VoiceMetrics = z.infer<typeof voiceMetricsSchema>
export const voiceExampleSchema = z.object({ id: z.string().uuid(), profileId: z.string().min(1).max(100), name: z.string().trim().min(1).max(80), text: z.string().trim().min(1).max(500), kind: z.enum(['conversation', 'laughter']), authorized: z.literal(true), enabled: z.boolean(), createdAt: z.string() }).strict()
export const voiceSampleSchema = z.object({ id: z.string().uuid(), text: z.string(), profileId: z.string(), conditioningExampleId: z.string().uuid().optional(), createdAt: z.string(), metrics: voiceMetricsSchema, expressiveness: z.number(), personality: z.string(), rating: z.number().int().min(1).max(5).optional(), feedback: z.string().max(1000).optional(), laughterHeard: z.boolean().optional() })
export type VoiceSample = z.infer<typeof voiceSampleSchema>
export const voiceStudioSchema = z.object({ examples: z.array(voiceExampleSchema).max(30).default([]), samples: z.array(voiceSampleSchema).max(30).default([]) })
export type VoiceStudio = z.infer<typeof voiceStudioSchema>
export const localVoiceCommandSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('studio') }).strict(),
  z.object({ action: z.literal('unload') }).strict(),
  z.object({ action: z.literal('verify'), engine: voiceEngineSchema }).strict(),
  z.object({ action: z.literal('remove'), engine: voiceEngineSchema }).strict(),
  z.object({ action: z.literal('add-example'), profileId: z.string().min(1).max(100), name: z.string().trim().min(1).max(80), text: z.string().trim().min(1).max(500), kind: z.enum(['conversation', 'laughter']), authorized: z.literal(true) }).strict(),
  z.object({ action: z.literal('toggle-example'), id: z.string().uuid(), enabled: z.boolean() }).strict(),
  z.object({ action: z.literal('remove-example'), id: z.string().uuid() }).strict(),
  z.object({ action: z.literal('rate'), id: z.string().uuid(), rating: z.number().int().min(1).max(5), feedback: z.string().max(1000), laughterHeard: z.boolean() }).strict(),
  z.object({ action: z.literal('sample'), id: z.string().uuid() }).strict(),
  z.object({ action: z.literal('remove-sample'), id: z.string().uuid() }).strict(),
  z.object({ action: z.literal('playback'), id: z.string().uuid(), milliseconds: z.number().finite().min(0).max(120000) }).strict(),
])
export type LocalVoiceCommand = z.infer<typeof localVoiceCommandSchema>
export interface LocalVoiceCommandResult { ok: boolean; message?: string; studio?: VoiceStudio; bytes?: Uint8Array }
export const localVoicePreviewSchema = z.object({ text: z.string().trim().min(1).max(400).optional(), saveSample: z.boolean().optional() }).strict()
export interface VoiceInstallProgress { engine: VoiceEngine; progress: number; detail: string; done: boolean; error?: string }
export const VOICE_PREVIEW_TEXT = "Hey, I'm Athena. I'm ready when you are. What would you like to do today?"
export function emptyVoiceEngines(status: LocalVoiceEngineStatus): LocalVoiceStatus['engines'] {
  return { 'chatterbox-turbo': { status }, 'sesame-csm': { status }, 'sesame-csm-official': { status }, 'higgs-tts-3-4b': { status } }
}

export function deliveryStyle(text: string, configured: VoiceStyle): VoiceStyle {
  if (configured !== 'conversational') return configured
  if (/^(sorry|i couldn't|i can't|unfortunately|hmm[, .])/i.test(text)) return 'concerned'
  if (/^(great|done|all set|success|good news)[!,. ]/i.test(text)) return 'happy'
  if (/^(hi|hello|hey|good morning|good evening)[!,. ]/i.test(text)) return 'warm'
  return 'conversational'
}

export function prepareLocalSpeech(text: string, engine: VoiceEngine): string {
  const conversational = text.replace(/\s+/g, ' ').trim()
  if (engine === 'higgs-tts-3-4b') return conversational.replace(/\[(?:(?:soft|light|gentle|natural)\s+)?(?:chuckl\w*|laugh\w*|giggl\w*|sigh\w*|gasp\w*)(?:\s+[^\]\r\n]{0,60})?\]/gi, '').replace(/\s+/g, ' ').trim()
  if (engine !== 'chatterbox-turbo') return conversational.replace(/\[(?:(?:soft|light|gentle|natural)\s+)?(?:chuckl\w*|laugh\w*|giggl\w*|sigh\w*|gasp\w*)(?:\s+[^\]\r\n]{0,60})?\]/gi, '').replace(/\s+/g, ' ').trim()
  // Turbo supports paralinguistic tokens. Use one only when the reply itself
  // expresses amusement; never add laughter to a factual or sensitive answer.
  if (/\[(?:chuckle|laugh|sigh|gasp)\]/i.test(conversational)) return conversational
  if (/^(?:ha(?:ha)+|heh|that's (?:funny|hilarious)|oh,? (?:that's|that is) funny)[!,. ]/i.test(conversational)) {
    return `[chuckle] ${conversational.replace(/^(?:ha(?:ha)+|heh)[!,. ]*/i, '')}`
  }
  return conversational
}

export function mayUseLaughterContext(text: string): boolean {
  return /\b(funny|hilarious|haha|jok(?:e|ing)|embarrassing)\b/i.test(text)
    && !/\b(sorry|death|died|grief|suicid\w*|hurt|pain|trauma|hospital|cancer|emergency|abuse|assault|funeral|depress\w*)\b/i.test(text)
}

export function selectVoiceExample(studio: VoiceStudio, profileId: string, text: string, laughterEnabled: boolean, preview: boolean) {
  const playful = laughterEnabled && mayUseLaughterContext(text)
  return studio.examples.filter((example) => example.enabled && example.profileId === profileId && (example.kind === 'conversation' || (playful && (preview || studio.samples.some((sample) => sample.profileId === profileId && sample.conditioningExampleId === example.id && sample.laughterHeard && (sample.rating ?? 0) >= 4)))))
    .sort((a, b) => playful ? Number(b.kind === 'laughter') - Number(a.kind === 'laughter') : 0)[0]
}
