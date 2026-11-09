import { z } from 'zod'
import { stripTrailingSourcesSection } from './chat'
import type { AIOwnership } from './aiOwnership'

export const SPEECH_VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse', 'marin', 'cedar'] as const
export const speechVoiceSchema = z.enum(SPEECH_VOICES)
export type SpeechVoice = z.infer<typeof speechVoiceSchema>
export const DEFAULT_SPEECH_VOICE: SpeechVoice = 'coral'
export const MIN_SPEECH_SPEED = 0.5
export const MAX_SPEECH_SPEED = 2
export const MAX_SPEECH_CHUNK_CHARACTERS = 1_100
export const MAX_SPEECH_AUDIO_BYTES = 8 * 1024 * 1024
export const speechIdentitySchema = z.object({ sessionId: z.uuid(), messageId: z.uuid() }).strict()
export const speechStartSchema = speechIdentitySchema.extend({ replay: z.boolean().optional() }).strict()
export const speechStopSchema = speechIdentitySchema.extend({ playerOnly: z.boolean().optional() }).strict()
export const speechPartSchema = speechIdentitySchema.extend({ index: z.number().int().min(0).max(1_000) }).strict()
export type SpeechIdentity = z.infer<typeof speechIdentitySchema>
export type SpeechStart = z.infer<typeof speechStartSchema>
export type SpeechStop = z.infer<typeof speechStopSchema>
export type SpeechPart = z.infer<typeof speechPartSchema>
export interface SpeechAudioResult { ok: boolean; message?: string; bytes?: Uint8Array; mimeType?: 'audio/mpeg' | 'audio/wav'; index?: number; count?: number; waiting?: boolean; done?: boolean; sampleId?: string }
export interface SpeechStatus { ownership?: AIOwnership; phase: 'idle' | 'generating' | 'playing'; sessionId?: string; messageId?: string; index?: number; count?: number; message?: string; announcement?: boolean; offered?: boolean }

// Speech is a rendering of visible assistant text, never an executable instruction.
export function speechText(markdown: string): string {
  return stripTrailingSourcesSection(markdown)
    .replace(/```[\s\S]*?(?:```|$)/g, ' Code block omitted. ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/gi, 'a link')
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/gm, '')
    .replace(/[*_~]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function speechChunks(markdown: string): string[] {
  let remaining = speechText(markdown)
  const parts: string[] = []
  while (remaining) {
    if (remaining.length <= MAX_SPEECH_CHUNK_CHARACTERS) { parts.push(remaining); break }
    const candidate = remaining.slice(0, MAX_SPEECH_CHUNK_CHARACTERS)
    const sentence = Math.max(candidate.lastIndexOf('. '), candidate.lastIndexOf('? '), candidate.lastIndexOf('! '))
    const space = candidate.lastIndexOf(' ')
    const cut = sentence >= MAX_SPEECH_CHUNK_CHARACTERS / 2 ? sentence + 1 : space >= MAX_SPEECH_CHUNK_CHARACTERS / 2 ? space : MAX_SPEECH_CHUNK_CHARACTERS
    parts.push(remaining.slice(0, cut).trim())
    remaining = remaining.slice(cut).trimStart()
  }
  return parts
}

// Release complete thoughts while a reply is streaming. If a provider has not
// emitted punctuation yet, the first complete word is enough to start local
// TTS while the rest of the answer is still being generated. The final reply
// releases any remaining words, so no text is silently lost at completion.
export function nextStreamSpeechPart(markdown: string, consumed: number, complete: boolean, completeThought = false): { text: string; consumed: number } | undefined {
  const rendered = speechText(markdown)
  const start = Math.min(consumed, rendered.length)
  const remaining = rendered.slice(start).trimStart()
  const skipped = rendered.slice(start).length - remaining.length
  if (!remaining) return undefined
  const limit = 320
  const window = remaining.slice(0, limit)
  const sentence = /[.!?](?=\s|$)/g
  let end = 0
  for (const match of window.matchAll(sentence)) {
    const position = match.index + 1
    if (position >= 1) { end = position; break }
  }
  if (!end && remaining.length >= 180) {
    const clause = Math.max(window.lastIndexOf(', '), window.lastIndexOf('; '), window.lastIndexOf(': '))
    if (clause >= 80) end = clause + 1
  }
  // Responses often stream without punctuation until later. Start on the
  // first word boundary, even when that word is only one or a few characters
  // long (for example, "I"), rather than waiting for a large text buffer.
  // Never hand TTS an unfinished word just to hit a character threshold.
  if (!end && consumed === 0 && !completeThought) {
    const boundary = remaining.search(/\s/)
    if (boundary >= 0) end = boundary
  }
  if (!end && (complete || remaining.length > limit)) {
    const boundary = window.lastIndexOf(' ')
    end = remaining.length <= limit ? remaining.length : boundary > 60 ? boundary : limit
  }
  if (!end) return undefined
  return { text: remaining.slice(0, end).trim(), consumed: start + skipped + end }
}
