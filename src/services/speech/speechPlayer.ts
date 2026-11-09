import type { AthenaAPI } from '../../../shared/contracts'
import type { SpeechAudioResult, SpeechIdentity, SpeechStart, SpeechStatus } from '../../../shared/speech'
import { PlaybackAmplitude } from './playbackAmplitude'

type SpeechAPI = Pick<AthenaAPI, 'beginSpeech' | 'nextSpeech' | 'speechPlaying' | 'stopSpeech'>

export class SpeechPlayer {
  private current?: SpeechIdentity
  private audio?: HTMLAudioElement
  private url?: string
  private stopped = false
  private waitingIndex?: number
  private advancingFor?: SpeechIdentity
  private retryAfterAdvance = false
  private meter: PlaybackAmplitude
  constructor(private api: SpeechAPI, private changed: (status: SpeechStatus) => void, private volume: () => number, private speed: () => number = () => 1, onLevel: (level: number) => void = () => {}) {
    this.meter = new PlaybackAmplitude(onLevel)
  }

  private clearAudio(): void {
    this.meter.stop()
    if (this.audio) {
      this.audio.onended = null; this.audio.onerror = null; this.audio.onplaying = null
      this.audio.pause(); this.audio.removeAttribute('src'); this.audio.load()
      this.audio = undefined
    }
    if (this.url) { URL.revokeObjectURL(this.url); this.url = undefined }
  }
  async start(identity: SpeechStart): Promise<void> {
    this.stop()
    this.stopped = false
    this.current = identity
    this.waitingIndex = undefined
    this.changed({ ...identity, phase: 'generating' })
    try { await this.playPart(identity, await this.api.beginSpeech(identity)) }
    catch { if (this.same(identity)) this.stop('Speech could not start. Try again later.') }
  }
  private same(identity: SpeechIdentity): boolean {
    return !this.stopped && this.current === identity
  }
  private async playPart(identity: SpeechIdentity, result: SpeechAudioResult): Promise<void> {
    if (!this.same(identity)) return
    if (result.ok && result.waiting) {
      this.waitingIndex ??= 0
      return
    }
    if (result.ok && result.done) { this.stop(); return }
    if (!result.ok || !result.bytes?.byteLength || result.index === undefined) {
      this.stop(result.message ?? 'Speech audio was unavailable.')
      return
    }
    this.waitingIndex = undefined
    this.clearAudio()
    const bytes = result.bytes
    this.url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: result.mimeType ?? 'audio/mpeg' }))
    bytes.fill(0)
    const audio = new Audio(this.url)
    this.audio = audio
    audio.volume = this.volume()
    audio.playbackRate = this.speed()
    const { index, count } = result
    let playbackAccepted: Promise<boolean> = Promise.resolve(false)
    let playbackStarted = false
    audio.onplaying = () => {
      if (!this.same(identity) || playbackStarted) return
      playbackStarted = true
      this.meter.start(audio)
      playbackAccepted = this.api.speechPlaying({ sessionId: identity.sessionId, messageId: identity.messageId, index }).then((accepted) => {
        if (!this.same(identity)) return false
        if (!accepted.ok) { this.stop(`Speech playback stopped: ${accepted.reason ?? 'the audio session expired'}.`); return false }
        this.changed({ ...identity, phase: 'playing', index, count })
        return true
      }).catch(() => { if (this.same(identity)) this.stop('Speech playback lost its desktop connection.'); return false })
    }
    audio.onended = async () => {
      this.meter.stop()
      if (!await playbackAccepted) { if (this.same(identity)) this.stop('Speech playback ended before it started.'); return }
      if (!this.same(identity)) return
      this.clearAudio()
      this.waitingIndex = index + 1
      this.changed({ ...identity, phase: 'generating', index: index + 1, count })
      void this.advance(identity)
    }
    audio.onerror = () => { if (this.same(identity)) this.stop('Audio playback failed. Check your output device.') }
    try { await audio.play() }
    catch { if (this.same(identity)) this.stop('Audio playback was blocked. Press Send again or check your sound output.') }
  }
  private async advance(identity: SpeechIdentity): Promise<void> {
    const index = this.waitingIndex
    if (!this.same(identity) || index === undefined || this.advancingFor === identity) return
    this.advancingFor = identity
    try { await this.playPart(identity, await this.api.nextSpeech({ sessionId: identity.sessionId, messageId: identity.messageId, index })) }
    catch { if (this.same(identity)) this.stop('Speech could not continue.') }
    finally {
      if (this.advancingFor === identity) this.advancingFor = undefined
      if (this.retryAfterAdvance) { this.retryAfterAdvance = false; if (this.same(identity)) void this.advance(identity) }
    }
  }
  onChatUpdate(): void {
    if (!this.current || this.waitingIndex === undefined) return
    if (this.advancingFor === this.current) this.retryAfterAdvance = true
    else void this.advance(this.current)
  }
  handleRemote(status: SpeechStatus): void {
    if (status.phase === 'idle' && this.current && status.sessionId === this.current.sessionId && status.messageId === this.current.messageId) this.stop(status.message)
  }
  setVolume(): void { if (this.audio) this.audio.volume = this.volume() }
  setSpeed(): void { if (this.audio) this.audio.playbackRate = this.speed() }
  stop(message?: string): void {
    const identity = this.current
    this.stopped = true
    this.current = undefined
    this.waitingIndex = undefined
    this.advancingFor = undefined
    this.retryAfterAdvance = false
    this.clearAudio()
    if (identity) {
      void this.api.stopSpeech({ sessionId: identity.sessionId, messageId: identity.messageId, playerOnly: true }).catch(() => {})
      this.changed({ phase: 'idle', message })
    }
  }
  dispose(): void { this.stop(); this.meter.dispose() }
}
