import OpenAI, { toFile } from 'openai'
import type { VoiceClip } from '../../../shared/voice'
import { TRANSCRIPTION_TIMEOUT_MS } from '../../../shared/voice'
import { ChatError } from '../ai/AIProvider'
import { billingErrorMessage } from '../ai/apiErrors'

export const TRANSCRIPTION_MODEL = 'gpt-transcribe'
export interface TranscriptionService { transcribe(clip: VoiceClip, signal: AbortSignal): Promise<string> }

export class OpenAITranscriptionService implements TranscriptionService {
  constructor(private key: () => Promise<string>, private request: typeof fetch = fetch) {}
  async transcribe(clip: VoiceClip, signal: AbortSignal): Promise<string> {
    const apiKey = await this.key()
    signal.throwIfAborted()
    const client = new OpenAI({ apiKey, maxRetries: 0, timeout: TRANSCRIPTION_TIMEOUT_MS,
      fetch: (url, options) => this.request(url, { ...options, redirect: 'error' }) })
    try {
      const file = await toFile(clip.bytes, clip.mimeType === 'audio/mp4' ? 'speech.mp4' : 'speech.webm', { type: clip.mimeType })
      signal.throwIfAborted()
      const result = await client.audio.transcriptions.create({ file, model: TRANSCRIPTION_MODEL, response_format: 'json' }, { signal })
      return result.text.trim()
    } catch (error) {
      if (signal.aborted) throw new ChatError('Voice input cancelled.')
      // Never return raw provider errors: they may contain request data.
      if (error instanceof OpenAI.APIError) {
        if (error.status === 401) throw new ChatError('Your OpenAI API key is invalid. Check Settings → AI.')
        const billing = billingErrorMessage(error.code)
        if (billing) throw new ChatError(billing)
        if (error.status === 429) throw new ChatError('OpenAI rate limit reached. Wait a moment before recording again.')
        if (error.status === 403 || error.status === 404) throw new ChatError('Your OpenAI account cannot access the speech transcription model.')
        if (error.status === 400) throw new ChatError('OpenAI could not decode this recording. Please record again.')
      }
      throw new ChatError('Speech transcription failed or timed out. Check your connection and try again.')
    }
  }
}
