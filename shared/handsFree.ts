import { z } from 'zod'
import { MAX_AUDIO_BYTES } from './voice'
import { aiOwnershipSchema, type AIOwnership } from './aiOwnership'

export const WAKE_PHRASES = ['Athena', 'Hey Athena', 'Hi Athena', 'Hey there Athena', 'Hello Athena', 'Okay Athena'] as const
export const WAKE_ACKNOWLEDGEMENTS = [
  'Hey! I’m here. What’s on your mind?',
  'Hi there! What can I help you with?',
  'Yep, I’m listening. Tell me what you need.',
  'Hey! What would you like to talk about?',
  'I’m here. What can I do for you?',
] as const
// One brief, profile-keyed Sesame clip can be cached and reused. Generating a
// different CSM sentence for each wake was an avoidable multi-second delay.
export const SESAME_WAKE_ACKNOWLEDGEMENT = "I'm listening."

export type HandsFreeTranscriptRoute =
  | { kind: 'ignore' }
  | { kind: 'wake-only' }
  | { kind: 'command'; text: string; includedWakePhrase: boolean }

/** Route only wake-prefixed speech in standby; accept ordinary speech during an active follow-up. */
export function classifyHandsFreeTranscript(
  transcript: string,
  configuredWakePhrases: readonly string[],
  followUpActive: boolean,
  followUpEnabled: boolean,
): HandsFreeTranscriptRoute {
  const cleaned = transcript.trim()
  if (!cleaned) return { kind: 'ignore' }
  const wake = extractWakePhrase(cleaned, configuredWakePhrases)
  if (wake.activated) return wake.command ? { kind: 'command', text: wake.command, includedWakePhrase: true } : { kind: 'wake-only' }
  return followUpActive && followUpEnabled
    ? { kind: 'command', text: cleaned, includedWakePhrase: false }
    : { kind: 'ignore' }
}

export function chooseWakeAcknowledgement(previous: string | undefined, random = Math.random): string {
  const options = WAKE_ACKNOWLEDGEMENTS.filter((phrase) => phrase !== previous)
  const pool = options.length ? options : WAKE_ACKNOWLEDGEMENTS
  const index = Math.min(pool.length - 1, Math.floor(Math.max(0, random()) * pool.length))
  return pool[index]
}

export const voiceInteractionSettingsSchema = z.object({
  handsFreeEnabled: z.boolean().default(false),
  noiseSuppression: z.boolean().default(true),
  noiseSuppressionLevel: z.enum(['low', 'balanced', 'high']).default('balanced'),
  automaticNoiseCalibration: z.boolean().default(true),
  wakeSensitivity: z.enum(['low', 'balanced', 'high']).default('balanced'),
  wakePhrases: z.array(z.string().trim().min(2).max(48)).max(12).refine((values) => new Set(values.map((value) => value.toLowerCase())).size === values.length).default([...WAKE_PHRASES]),
  followUpEnabled: z.boolean().default(true),
  followUpTimeoutSeconds: z.number().int().min(5).max(60).default(15),
  vadSensitivity: z.number().min(0.005).max(0.1).default(0.018),
  endOfSpeechDelayMs: z.number().int().min(300).max(1500).default(450),
  adaptiveVoiceReasoning: z.boolean().default(true),
  aiResponseTimeoutSeconds: z.number().int().min(30).max(600).default(120),
  allowSpeechInterruption: z.boolean().default(true),
  autoVoiceResponse: z.boolean().default(true),
}).strict()

export type VoiceInteractionSettings = z.infer<typeof voiceInteractionSettingsSchema>
export const voiceInteractionDefaults = voiceInteractionSettingsSchema.parse({})

/** Native browser noise suppression stays enabled; this setting only affects the optional stronger isolation request. */
export function handsFreeMicrophoneConstraints(level: VoiceInteractionSettings['noiseSuppressionLevel'], supportsVoiceIsolation: boolean) {
  const audio: {
    channelCount: { ideal: number }
    echoCancellation: { ideal: boolean }
    autoGainControl: { ideal: boolean }
    noiseSuppression: { ideal: boolean }
    voiceIsolation?: { ideal: boolean }
  } = {
    channelCount: { ideal: 1 },
    echoCancellation: { ideal: true },
    autoGainControl: { ideal: false },
    noiseSuppression: { ideal: true },
  }
  if (level === 'high' && supportsVoiceIsolation) audio.voiceIsolation = { ideal: true }
  return { audio, video: false as const }
}

export function shouldFallbackFromAudioWorklet(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '')
  return /audio.?worklet|worklet|processor module|addmodule/i.test(message)
}

export const handsFreeAudioSchema = z.object({
  id: z.string().uuid(),
  mimeType: z.literal('audio/wav'),
  bytes: z.instanceof(Uint8Array).refine((bytes) => isValidHandsFreeWav(bytes) && bytes.byteLength <= MAX_AUDIO_BYTES),
}).strict()
export const handsFreeReplySchema = z.object({ id: z.string().uuid().optional(), text: z.string().trim().min(1).max(12_000), ownership: aiOwnershipSchema.optional(), diagnosticDirect: z.boolean().optional() }).strict()
export const localInferenceTraceSchema = z.object({
  stage: z.enum(['request-start', 'first-token', 'complete']),
  timestamp: z.string().datetime(), durationMs: z.number().int().nonnegative().optional(),
  round: z.number().int().nonnegative(),
  model: z.string().min(1).max(200), transport: z.enum(['ollama', 'mlx-worker']), endpoint: z.string().min(1).max(500),
  promptBytes: z.number().int().nonnegative(), toolBytes: z.number().int().nonnegative(), promptTokenEstimate: z.number().int().nonnegative(), numCtx: z.number().int().positive(), numPredict: z.number().int().positive(),
  inputTokens: z.number().int().nonnegative().optional(), outputTokens: z.number().int().nonnegative().optional(),
  temperature: z.number().min(0).max(2), keepAlive: z.string().max(32), stream: z.literal(true),
  think: z.union([z.string(), z.boolean()]).optional(), toolCount: z.number().int().nonnegative(), messageCount: z.number().int().positive(),
}).strict()
export type LocalInferenceTrace = z.infer<typeof localInferenceTraceSchema>
export const voiceTraceEventSchema = z.object({ stage: z.string().min(1).max(80), timestamp: z.string().datetime(), elapsedMs: z.number().int().nonnegative(), durationMs: z.number().int().nonnegative().optional(), detail: z.string().max(1200).optional() }).strict()
export interface HandsFreeReplyProgress { id: string; type: 'model-start' | 'text' | 'trace'; text?: string; trace?: LocalInferenceTrace; ownership?: AIOwnership }
export const handsFreeSpeechSchema = z.object({ id: z.string().uuid(), text: z.string().trim().min(1).max(3800), ownership: aiOwnershipSchema.optional(), cache: z.boolean().optional() }).strict()
export const handsFreeSpeechPartSchema = z.object({ id: z.string().uuid(), index: z.number().int().min(1).max(1000), ownership: aiOwnershipSchema }).strict()
export const voiceDiagnosticsSchema = z.object({ speechMs: z.number().int().nonnegative().optional(), endpointMs: z.number().int().nonnegative().optional(), wavMs: z.number().int().nonnegative().optional(), sttMs: z.number().int().nonnegative().optional(), wakeRecognitionMs: z.number().int().nonnegative().optional(), wakeAcknowledgementMs: z.number().int().nonnegative().optional(), wakeAckCached: z.boolean().optional(), aiPreparationMs: z.number().int().nonnegative().optional(), aiFirstTokenMs: z.number().int().nonnegative().optional(), aiMs: z.number().int().nonnegative().optional(), speechEndToFirstTokenMs: z.number().int().nonnegative().optional(), firstTtsMs: z.number().int().nonnegative().optional(), ttsMs: z.number().int().nonnegative().optional(), firstPlaybackStartMs: z.number().int().nonnegative().optional(), playbackStartMs: z.number().int().nonnegative().optional(), firstAudioMs: z.number().int().nonnegative().optional(), speechEndToAudioMs: z.number().int().nonnegative().optional(), traceId: z.string().uuid().optional(), traceMode: z.enum(['normal', 'direct']).optional(), traceEvents: z.array(voiceTraceEventSchema).max(80).optional(), mainRssMb: z.number().int().nonnegative().optional() }).strict()
export const handsFreeStateSchema = z.object({ state: z.enum(['standby', 'listening', 'processing', 'speaking', 'follow-up', 'paused', 'error']), message: z.string().max(240).optional(), diagnostics: voiceDiagnosticsSchema.optional(), ownership: aiOwnershipSchema.optional() }).strict()

export type HandsFreeState = z.infer<typeof handsFreeStateSchema>
export type HandsFreeAudio = z.infer<typeof handsFreeAudioSchema>
export type HandsFreeReplyResult = { ok: boolean; text?: string; message?: string }
export type HandsFreeSpeechResult = { ok: boolean; id?: string; bytes?: Uint8Array; mimeType?: 'audio/wav'; message?: string; streaming?: boolean; index?: number; done?: boolean; cached?: boolean }

/** Match only a leading configured wake phrase; return the untouched request tail. */
export function extractWakePhrase(transcript: string, configured: readonly string[] = WAKE_PHRASES): { activated: boolean; command: string } {
  const cleaned = transcript.trim().replace(/\s+/g, ' ')
  const phrases = [...configured].sort((a, b) => b.length - a.length)
  for (const phrase of phrases) {
    const escaped = phrase.trim().split(/[\s,]+/).map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\s,]+')
    const match = new RegExp(`^(?:${escaped})(?=$|[\\s,!.?:;-])`, 'i').exec(cleaned)
    if (match) return { activated: true, command: cleaned.slice(match[0].length).replace(/^[\s,!.?:;-]+/, '').trim() }
  }
  return { activated: false, command: cleaned }
}

export function normalizeVoiceCommand(text: string): string {
  return text.trim().replace(/\s+/g, ' ').replace(/[.!?]+$/, '').trim()
}

export function isVoiceInterruption(text: string): 'stop-speech' | 'cancel-task' | 'standby' | undefined {
  const command = normalizeVoiceCommand(extractWakePhrase(text).command || text)
  if (/^(?:please )?(?:stop talking|stop speaking|be quiet|stop|wait|hold on|listen)(?: please)?(?:[\s,]+athena)?$/i.test(command)) return 'stop-speech'
  if (/^(?:please )?(?:cancel (?:the |my )?(?:current )?task|stop (?:the |my )?(?:current )?task|stop working|cancel that)(?: please)?$/i.test(command)) return 'cancel-task'
  if (/^(?:go to )?(?:standby|stop listening|goodbye|that's all)$/i.test(command)) return 'standby'
}

export function silenceEndpointMs(baseMs: number, speechDurationMs: number): number {
  // Longer utterances and questions need room for natural clauses and pauses.
  return Math.min(1500, Math.max(300, baseMs) + (speechDurationMs >= 6000 ? 250 : speechDurationMs >= 3000 ? 120 : 0))
}

/** Adaptive room-noise estimate used only as a soft energy floor after the speech classifier accepts a segment. */
export class AdaptiveNoiseFloor {
  private value = 0.003

  observe(rms: number, speechProbability: number, enabled = true): number {
    if (!enabled || !Number.isFinite(rms) || rms < 0 || speechProbability >= 0.2) return this.value
    const alpha = rms > this.value ? 0.035 : 0.006
    this.value = Math.max(0.0005, Math.min(0.08, this.value + (rms - this.value) * alpha))
    return this.value
  }

  current(): number { return this.value }
  reset(): void { this.value = 0.003 }
}

export function speechConfidenceThreshold(sensitivity: VoiceInteractionSettings['wakeSensitivity'], noiseFloor = 0.003, suppressionLevel: VoiceInteractionSettings['noiseSuppressionLevel'] = 'balanced'): number {
  const base = sensitivity === 'low' ? 0.53 : sensitivity === 'high' ? 0.34 : 0.43
  const noiseLift = Math.min(0.08, Math.max(0, noiseFloor - 0.004) * 2.5)
  const suppressionLift = suppressionLevel === 'high' ? 0.035 : suppressionLevel === 'low' ? -0.015 : 0
  return Math.max(0.3, Math.min(0.68, base + noiseLift + suppressionLift))
}

/** Keep Silero's speech/silence hysteresis narrow so borderline room noise can end a segment. */
export function negativeSpeechConfidenceThreshold(sensitivity: VoiceInteractionSettings['wakeSensitivity'], noiseFloor = 0.003, suppressionLevel: VoiceInteractionSettings['noiseSuppressionLevel'] = 'balanced'): number {
  return Math.max(0.2, speechConfidenceThreshold(sensitivity, noiseFloor, suppressionLevel) - 0.05)
}

/** Silero already classifies speech; this secondary check rejects empty, clipped, or near-silent outputs. */
export function isUsableSpeechSegment(samples: Float32Array, noiseFloor = 0.003): boolean {
  if (samples.length < 16_000 * 0.28 || samples.length > 16_000 * 60) return false
  let energy = 0, peak = 0, finiteCount = 0, clipped = 0
  for (const raw of samples) {
    if (!Number.isFinite(raw)) continue
    const sample = Math.max(-1, Math.min(1, raw))
    finiteCount++
    energy += sample * sample
    peak = Math.max(peak, Math.abs(sample))
    if (Math.abs(sample) >= 0.999) clipped++
  }
  if (finiteCount !== samples.length) return false
  const rms = Math.sqrt(energy / samples.length)
  const energyFloor = Math.max(0.0002, Math.min(0.001, noiseFloor * 0.03))
  return rms >= energyFloor && peak >= Math.max(0.0007, energyFloor * 2) && clipped / samples.length < 0.08
}

/** Encode classifier-approved Silero audio (16 kHz mono float PCM) as a strict PCM16 WAV for local Whisper. */
export function encodeHandsFreeWav(samples: Float32Array, sampleRate = 16_000): Uint8Array<ArrayBuffer> {
  if (sampleRate !== 16_000 || samples.length === 0 || samples.some((sample) => !Number.isFinite(sample))) throw new Error('Invalid speech segment.')
  const dataBytes = samples.length * 2
  if (dataBytes > MAX_AUDIO_BYTES - 44) throw new Error('Speech segment exceeds the local transcription limit.')
  const bytes = new Uint8Array(44 + dataBytes)
  const view = new DataView(bytes.buffer)
  const label = (offset: number, value: string) => { for (let index = 0; index < value.length; index++) view.setUint8(offset + index, value.charCodeAt(index)) }
  label(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); label(8, 'WAVE'); label(12, 'fmt ')
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true)
  label(36, 'data'); view.setUint32(40, dataBytes, true)
  for (let index = 0; index < samples.length; index++) view.setInt16(44 + index * 2, Math.round(Math.max(-1, Math.min(1, samples[index])) * 32767), true)
  return bytes
}

export function isValidHandsFreeWav(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 44 + 16_000 * 0.28 * 2 || bytes.byteLength > MAX_AUDIO_BYTES) return false
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const label = (offset: number, expected: string) => expected.split('').every((character, index) => bytes[offset + index] === character.charCodeAt(0))
  const validHeader = label(0, 'RIFF') && label(8, 'WAVE') && label(12, 'fmt ') && label(36, 'data')
    && view.getUint32(4, true) === bytes.byteLength - 8
    && view.getUint32(16, true) === 16 && view.getUint16(20, true) === 1
    && view.getUint16(22, true) === 1 && view.getUint32(24, true) === 16_000
    && view.getUint16(34, true) === 16 && view.getUint32(40, true) === bytes.byteLength - 44
  if (!validHeader) return false
  let energy = 0, peak = 0
  const samples = (bytes.byteLength - 44) / 2
  for (let index = 0; index < samples; index++) {
    const sample = view.getInt16(44 + index * 2, true) / 32768
    energy += sample * sample; peak = Math.max(peak, Math.abs(sample))
  }
  return Math.sqrt(energy / samples) >= 0.0002 && peak >= 0.0007
}

export const CLARIFICATION_PHRASES = [
  "Sorry, I didn't catch that.", 'Sorry, come again?', 'Hmm, could you say that again?',
  'Wait, what was that?', 'Sorry, I missed that last part.', "I didn't quite hear you.",
  'Could you repeat that for me?', 'Oops, I didn’t get that.', 'One more time?', 'Sorry, what did you say?',
] as const

export function chooseClarification(previous: string | undefined, random = Math.random): string {
  const choices = CLARIFICATION_PHRASES.filter((phrase) => phrase !== previous)
  return choices[Math.min(choices.length - 1, Math.floor(Math.max(0, Math.min(0.999999, random())) * choices.length))]
}
