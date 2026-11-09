import { handsFreeAudioSchema, type HandsFreeAudio } from '../../../shared/handsFree'
import type { Settings } from '../../../shared/settings'
import type { TranscriptionService } from './transcriptionService'
import { ChatError } from '../ai/AIProvider'
import { log } from '../logger'
import { basename } from 'node:path'

export const HANDS_FREE_TRANSCRIPTION_TIMEOUT_MS = 30_000

/** Local-only transcription lease for the floating surface. It never uses the cloud router. */
export class HandsFreeController {
  private ownerId?: number
  private requests = new Map<string, AbortController>()
  private disposed = false

  constructor(private localTranscription: TranscriptionService, private settings: () => Settings, private allowed: () => boolean) {}

  activate(senderId: number): { ok: boolean; message?: string } {
    if (this.disposed) return { ok: false, message: 'Hands-free voice is unavailable.' }
    if (!this.settings().voiceInteraction.handsFreeEnabled) return { ok: false, message: 'Enable Hands-Free Athena in Settings → Voice first.' }
    if (!this.allowed()) return { ok: false, message: 'Enable Microphone Access in Settings → Privacy first.' }
    if (this.settings().localAI.speechEngine !== 'whisper-cli' || !this.settings().localAI.speechModelPath) return { ok: false, message: 'Configure a local Whisper model in Settings → AI → Local Voice for private wake-word detection.' }
    if (this.ownerId !== undefined && this.ownerId !== senderId) return { ok: false, message: 'Hands-free microphone is already active in Athena.' }
    this.ownerId = senderId
    return { ok: true }
  }

  canCapture(senderId: number): boolean {
    return !this.disposed && this.ownerId === senderId && this.settings().voiceInteraction.handsFreeEnabled && this.allowed()
  }

  async transcribe(senderId: number, input: unknown): Promise<{ ok: boolean; transcript?: string; message?: string }> {
    const parsed = handsFreeAudioSchema.safeParse(input)
    if (!parsed.success) return { ok: false, message: 'Invalid or oversized wake-word audio.' }
    if (!this.canCapture(senderId)) return { ok: false, message: 'Hands-free microphone authorization expired.' }
    const clip: HandsFreeAudio = parsed.data
    if (this.requests.has(clip.id)) return { ok: false, message: 'This audio segment is already being transcribed.' }
    const abort = new AbortController()
    this.requests.set(clip.id, abort)
    const started = performance.now()
    log('voice.whisper', { traceId: clip.id, stage: 'start', model: basename(this.settings().localAI.speechModelPath), processPerUtterance: true, wavBytes: clip.bytes.byteLength })
    let timedOut = false
    const timeout = setTimeout(() => { timedOut = true; abort.abort() }, HANDS_FREE_TRANSCRIPTION_TIMEOUT_MS)
    try {
      // Deliberately call LocalWhisperTranscription directly. Wake detection must
      // never follow the currently selected cloud transcription route.
      const transcript = await this.localTranscription.transcribe({ id: clip.id, sessionId: clip.id, mimeType: clip.mimeType, bytes: clip.bytes }, abort.signal)
      if (timedOut) { log('voice.whisper', { traceId: clip.id, stage: 'timeout', durationMs: Math.round(performance.now() - started) }); return { ok: false, message: 'Speech recognition took too long. Try a shorter phrase.' } }
      if (!this.canCapture(senderId) || abort.signal.aborted) { log('voice.whisper', { traceId: clip.id, stage: 'cancelled', durationMs: Math.round(performance.now() - started) }); return { ok: false, message: 'Hands-free transcription was cancelled.' } }
      log('voice.whisper', { traceId: clip.id, stage: 'complete', durationMs: Math.round(performance.now() - started), transcriptCharacters: transcript.length })
      return { ok: true, transcript }
    } catch (error) {
      if (timedOut) { log('voice.whisper', { traceId: clip.id, stage: 'timeout', durationMs: Math.round(performance.now() - started) }); return { ok: false, message: 'Speech recognition took too long. Try a shorter phrase.' } }
      if (abort.signal.aborted) { log('voice.whisper', { traceId: clip.id, stage: 'cancelled', durationMs: Math.round(performance.now() - started) }); return { ok: false, message: 'Hands-free transcription was cancelled.' } }
      log('voice.whisper', { traceId: clip.id, stage: 'failed', durationMs: Math.round(performance.now() - started), error: error instanceof ChatError ? 'local transcription error' : 'unknown transcription error' })
      return { ok: false, message: error instanceof ChatError ? error.userMessage : 'Local wake-word recognition failed.' }
    } finally {
      clearTimeout(timeout)
      clip.bytes.fill(0)
      if (this.requests.get(clip.id) === abort) this.requests.delete(clip.id)
    }
  }

  cancel(senderId: number, id?: string): void {
    if (this.ownerId !== senderId) return
    if (id) this.requests.get(id)?.abort()
    else for (const abort of this.requests.values()) abort.abort()
  }

  deactivate(senderId?: number): void {
    if (senderId !== undefined && this.ownerId !== senderId) return
    this.ownerId = undefined
    this.cancelAll()
  }

  reconcile(): void {
    if (!this.settings().voiceInteraction.handsFreeEnabled || !this.allowed()) this.deactivate()
  }

  dispose(): void { this.disposed = true; this.deactivate() }

  private cancelAll(): void {
    for (const abort of this.requests.values()) abort.abort()
    this.requests.clear()
  }
}
