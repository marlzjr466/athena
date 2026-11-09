import { MAX_MESSAGE_LENGTH } from '../../../shared/chat'
import { MAX_RECORDING_MS, TRANSCRIPTION_TIMEOUT_MS, voiceClipSchema, voiceIdentitySchema, type VoiceIdentity, type VoiceResult, type VoiceSnapshot } from '../../../shared/voice'
import { ChatError } from '../ai/AIProvider'
import type { TranscriptionService } from './transcriptionService'

export interface VoiceContext { sessionId: string; fingerprint: string; idle: boolean }
interface Hooks {
  context(): VoiceContext
  allowed(): boolean
  authorize(): Promise<void>
  allowBusyInterrupt?(): boolean
  changed(state: VoiceSnapshot): void
}
interface Capture extends VoiceIdentity { fingerprint: string; authorized: boolean; interruptOnly: boolean; abort: AbortController; timer?: ReturnType<typeof setTimeout> }

export class VoiceController {
  private capture?: Capture
  private state: VoiceSnapshot = { phase: 'idle' }
  private disposed = false
  constructor(private service: TranscriptionService, private hooks: Hooks) {}
  snapshot(): VoiceSnapshot { return { ...this.state } }
  private publish(phase: VoiceSnapshot['phase'], message?: string): void {
    this.state = { phase, id: this.capture?.id, sessionId: this.capture?.sessionId, message }
    this.hooks.changed(this.snapshot())
  }
  private timeout(capture: Capture, ms: number, message: string): void {
    clearTimeout(capture.timer)
    capture.timer = setTimeout(() => { if (this.capture === capture) this.cancel(message) }, ms)
  }
  private valid(capture: Capture): boolean {
    const context = this.hooks.context()
    return this.capture === capture && !capture.abort.signal.aborted && (context.idle || (capture.interruptOnly && Boolean(this.hooks.allowBusyInterrupt?.()))) && context.sessionId === capture.sessionId && context.fingerprint === capture.fingerprint
  }
  async begin(input: unknown): Promise<VoiceResult> {
    const parsed = voiceIdentitySchema.safeParse(input)
    if (!parsed.success || this.disposed) return { ok: false, message: 'Voice input is unavailable.' }
    if (this.capture) return { ok: false, message: 'Voice input is already active.' }
    const context = this.hooks.context()
    if ((!context.idle && !this.hooks.allowBusyInterrupt?.()) || context.sessionId !== parsed.data.sessionId) return { ok: false, message: 'Wait for the response and select the conversation before recording.' }
    const capture: Capture = { ...parsed.data, fingerprint: context.fingerprint, authorized: false, interruptOnly: !context.idle, abort: new AbortController() }
    this.capture = capture
    this.publish('preparing')
    this.timeout(capture, 30_000, 'Microphone setup timed out. Please try again.')
    try {
      await this.hooks.authorize()
      if (!this.valid(capture)) {
        if (this.capture === capture) this.cancel('Voice input cancelled because the conversation changed.')
        return { ok: false, message: 'Voice input cancelled.' }
      }
      if (!this.hooks.allowed()) throw new ChatError('Microphone access is blocked. Check Settings → Privacy and macOS Microphone settings.')
      capture.authorized = true
      // A short lease authorizes getUserMedia, not arbitrary continuous capture.
      return { ok: true }
    } catch (error) {
      const message = error instanceof ChatError ? error.userMessage : 'Microphone setup failed. Check Settings → Privacy.'
      if (this.capture === capture) this.cancel(message)
      return { ok: false, message }
    }
  }
  canCapture(): boolean { return Boolean(this.capture?.authorized && this.valid(this.capture) && this.hooks.allowed() && ['preparing', 'listening'].includes(this.state.phase)) }
  recording(input: unknown): VoiceResult {
    const parsed = voiceIdentitySchema.safeParse(input), capture = this.capture
    if (!parsed.success || !capture || capture.id !== parsed.data.id || capture.sessionId !== parsed.data.sessionId || this.state.phase !== 'preparing' || !this.canCapture()) return { ok: false, message: 'Recording authorization expired.' }
    this.publish('listening')
    this.timeout(capture, MAX_RECORDING_MS + 2_000, 'Recording reached its time limit. Please try a shorter message.')
    return { ok: true }
  }
  reconcile(): void {
    if (this.capture && (!this.valid(this.capture) || (this.state.phase !== 'preparing' && !this.hooks.allowed()))) this.cancel('Voice input cancelled because the conversation or permissions changed.')
  }
  async transcribe(input: unknown): Promise<VoiceResult> {
    const parsed = voiceClipSchema.safeParse(input), capture = this.capture
    if (!parsed.success) { this.cancel('Invalid or oversized recording.'); return { ok: false, message: 'Invalid or oversized recording.' } }
    const clip = parsed.data
    if (!capture || capture.id !== clip.id || capture.sessionId !== clip.sessionId || this.state.phase !== 'listening' || !this.canCapture()) return { ok: false, message: 'Recording authorization expired.' }
    this.publish('transcribing')
    this.timeout(capture, TRANSCRIPTION_TIMEOUT_MS, 'Speech transcription timed out. Please try again.')
    try {
      const transcript = await this.service.transcribe(clip, capture.abort.signal)
      if (!this.valid(capture) || !this.hooks.allowed()) return { ok: false, message: 'Voice input cancelled. No transcript was added.' }
      if (!transcript.trim()) throw new ChatError('No speech was recognized. Please try again.')
      if (transcript.length > MAX_MESSAGE_LENGTH) throw new ChatError('The transcript is too long. Please record a shorter message.')
      this.cancel()
      return { ok: true, transcript }
    } catch (error) {
      const message = error instanceof ChatError ? error.userMessage : 'Could not transcribe this recording. Please try again.'
      if (this.capture === capture) this.cancel(message)
      return { ok: false, message }
    } finally {
      clip.bytes.fill(0)
      if (this.capture === capture) this.cancel()
    }
  }
  cancel(message?: string): void {
    const capture = this.capture
    if (!capture) return
    clearTimeout(capture.timer); capture.abort.abort()
    this.publish('idle', message)
    this.capture = undefined
  }
  cancelRequest(input: unknown): VoiceResult {
    const parsed = voiceIdentitySchema.safeParse(input)
    if (parsed.success && this.capture?.id === parsed.data.id && this.capture.sessionId === parsed.data.sessionId) this.cancel()
    return { ok: true }
  }
  dispose(): void { this.disposed = true; this.cancel() }
}
