import type { SpeechVoice } from '../../../shared/speech'

export interface SpeechService {
  readonly mimeType?: 'audio/mpeg' | 'audio/wav'
  generate(text: string, voice: SpeechVoice, speed: number, signal: AbortSignal, contextKey?: string): Promise<Uint8Array>
  stream?(text: string, voice: SpeechVoice, speed: number, signal: AbortSignal, contextKey: string): AsyncGenerator<Uint8Array>
}
