import { z } from 'zod'

export const MAX_RECORDING_MS = 60_000
export const MAX_AUDIO_BYTES = 4 * 1024 * 1024
export const TRANSCRIPTION_TIMEOUT_MS = 60_000
export const voiceIdentitySchema = z.object({ id: z.string().uuid(), sessionId: z.string().uuid() }).strict()
export const voiceClipSchema = voiceIdentitySchema.extend({
  mimeType: z.enum(['audio/webm', 'audio/webm;codecs=opus', 'audio/mp4', 'audio/wav']),
  bytes: z.instanceof(Uint8Array).refine((bytes) => bytes.byteLength > 0 && bytes.byteLength <= MAX_AUDIO_BYTES),
}).strict()
export type VoiceIdentity = z.infer<typeof voiceIdentitySchema>
export type VoiceClip = z.infer<typeof voiceClipSchema>
export type VoicePhase = 'idle' | 'preparing' | 'listening' | 'transcribing'
export interface VoiceSnapshot { phase: VoicePhase; id?: string; sessionId?: string; message?: string }
export interface VoiceResult { ok: boolean; message?: string; transcript?: string }
