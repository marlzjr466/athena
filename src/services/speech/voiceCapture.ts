import type { AthenaAPI } from '../../../shared/contracts'
import { MAX_AUDIO_BYTES, MAX_RECORDING_MS, type VoiceIdentity, type VoicePhase } from '../../../shared/voice'

type VoiceAPI = Pick<AthenaAPI, 'beginVoice' | 'voiceRecording' | 'transcribeVoice' | 'cancelVoice'> & Partial<Pick<AthenaAPI, 'getSnapshot'>>

export async function recordingToWav(blob: Blob): Promise<Uint8Array<ArrayBuffer>> {
  const context = new AudioContext()
  try {
    const decoded = await context.decodeAudioData(await blob.arrayBuffer())
    const frames = Math.ceil(decoded.duration * 16_000)
    const offline = new OfflineAudioContext(1, frames, 16_000)
    const source = offline.createBufferSource()
    source.buffer = decoded; source.connect(offline.destination); source.start()
    const pcm = (await offline.startRendering()).getChannelData(0)
    const bytes = new Uint8Array(44 + pcm.length * 2)
    const view = new DataView(bytes.buffer)
    const label = (offset: number, value: string) => { for (let index = 0; index < value.length; index++) view.setUint8(offset + index, value.charCodeAt(index)) }
    label(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); label(8, 'WAVE'); label(12, 'fmt ')
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true)
    view.setUint32(24, 16_000, true); view.setUint32(28, 32_000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true)
    label(36, 'data'); view.setUint32(40, pcm.length * 2, true)
    for (let index = 0; index < pcm.length; index++) view.setInt16(44 + index * 2, Math.round(Math.max(-1, Math.min(1, pcm[index])) * 32767), true)
    return bytes
  } finally { await context.close() }
}
interface Recording extends VoiceIdentity {
  phase: VoicePhase; stream?: MediaStream; recorder?: MediaRecorder
  chunks: Blob[]; size: number; startedAt: number; timer?: ReturnType<typeof setTimeout>
  audioContext?: AudioContext; analyser?: AnalyserNode; levelFrame?: number
}
interface CaptureHooks { state(phase: VoicePhase, message?: string): void; transcript(text: string, sessionId: string): void; level?(value: number): void; meter?(available: boolean): void }

export class VoiceCapture {
  private active?: Recording
  constructor(private api: VoiceAPI, private hooks: CaptureHooks) {}
  get phase(): VoicePhase { return this.active?.phase ?? 'idle' }
  get id(): string | undefined { return this.active?.id }
  private phaseChanged(recording: Recording, phase: VoicePhase): void {
    recording.phase = phase; this.hooks.state(phase); if (phase === 'idle') { this.hooks.level?.(0); this.hooks.meter?.(false) }
  }
  private startLevelMeter(recording: Recording, stream: MediaStream): void {
    if (typeof AudioContext === 'undefined' || typeof requestAnimationFrame === 'undefined') return
    try {
      const context = new AudioContext()
      const analyser = context.createAnalyser()
      analyser.fftSize = 256
      context.createMediaStreamSource(stream).connect(analyser)
      recording.audioContext = context; recording.analyser = analyser
      this.hooks.meter?.(true)
      const values = new Uint8Array(analyser.fftSize)
      const sample = () => {
        if (this.active !== recording || recording.phase === 'idle') return
        analyser.getByteTimeDomainData(values)
        let sum = 0
        for (const value of values) { const normalized = (value - 128) / 128; sum += normalized * normalized }
        this.hooks.level?.(Math.min(1, Math.sqrt(sum / values.length) * 3.2))
        recording.levelFrame = requestAnimationFrame(sample)
      }
      void context.resume().catch(() => {})
      recording.levelFrame = requestAnimationFrame(sample)
    } catch { /* Audio metering is an enhancement; recording can continue without it. */ }
  }
  async begin(sessionId: string): Promise<void> {
    if (this.active) return
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') { this.hooks.state('idle', 'Microphone recording is unavailable in this runtime.'); return }
    const recording: Recording = { id: crypto.randomUUID(), sessionId, phase: 'preparing', chunks: [], size: 0, startedAt: 0 }
    this.active = recording
    this.phaseChanged(recording, 'preparing')
    try {
      const result = await this.api.beginVoice({ id: recording.id, sessionId })
      if (this.active !== recording) return
      if (!result.ok) { this.cancel(result.message); return }
      let stream: MediaStream
      try {
        // Prefer clean mono input, but do not make optional constraints a reason to
        // reject a perfectly usable microphone on older Electron/macOS devices.
        stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: { ideal: true }, noiseSuppression: { ideal: true }, channelCount: { ideal: 1 } }, video: false })
      } catch (error) {
        const name = error && typeof error === 'object' && 'name' in error ? String(error.name) : ''
        if (!['OverconstrainedError', 'NotReadableError', 'AbortError'].includes(name)) throw error
        stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
      }
      if (this.active !== recording) { stream.getTracks().forEach((track) => track.stop()); return }
      recording.stream = stream
      this.startLevelMeter(recording, stream)
      const authorized = await this.api.voiceRecording({ id: recording.id, sessionId })
      if (this.active !== recording) return
      if (!authorized.ok) { this.cancel(authorized.message); return }
      const mimeTypes = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']
      const supported = mimeTypes.filter((type) => MediaRecorder.isTypeSupported(type))
      let recorder: MediaRecorder | undefined
      let mimeType = ''
      for (const type of [...supported, '']) {
        try {
          recorder = type ? new MediaRecorder(stream, { mimeType: type, audioBitsPerSecond: 64_000 }) : new MediaRecorder(stream, { audioBitsPerSecond: 64_000 })
          mimeType = recorder.mimeType || type || 'audio/webm'
          break
        } catch { /* try the next codec supported by this Electron runtime */ }
      }
      if (!recorder) { this.cancel('This microphone format is not supported by the current Athena runtime. Please restart Athena and try again.'); return }
      recording.recorder = recorder
      recorder.ondataavailable = (event) => {
        if (this.active !== recording || !event.data.size) return
        recording.size += event.data.size
        if (recording.size > MAX_AUDIO_BYTES) { this.cancel('Recording is too large. Please try a shorter message.'); return }
        recording.chunks.push(event.data)
      }
      recorder.onerror = () => this.cancel('The microphone stopped working. Check your input device and try again.')
      recorder.onstop = () => {
        if (this.active !== recording) return
        if (recording.phase === 'transcribing') void this.upload(recording, mimeType)
        else this.cancel('The microphone stopped unexpectedly. Please record again.')
      }
      stream.getTracks().forEach((track) => track.addEventListener('ended', () => {
        // A few macOS audio drivers briefly report an ended track while the
        // input route is being selected. Give the route a moment to recover.
        setTimeout(() => { if (this.active === recording && recording.phase === 'listening' && track.readyState === 'ended') this.cancel('Microphone disconnected. Please check the selected input device and try again.') }, 250)
      }, { once: true }))
      recorder.start(250)
      recording.startedAt = Date.now()
      this.phaseChanged(recording, 'listening')
      recording.timer = setTimeout(() => this.finish(), MAX_RECORDING_MS)
    } catch (error) {
      if (this.active !== recording) return
      const name = error && typeof error === 'object' && 'name' in error ? error.name : ''
      this.cancel(name === 'NotAllowedError' || name === 'SecurityError' ? 'Microphone access was denied. Enable Athena in Settings → Privacy → Microphone and macOS System Settings → Privacy & Security → Microphone.'
        : name === 'NotFoundError' ? 'No microphone input is available. Select a connected input device in macOS Sound settings and try again.'
        : name === 'NotReadableError' || name === 'AbortError' ? 'The microphone is busy or unavailable. Close other apps using the microphone, then try again.'
        : 'Could not start the microphone. Check that an input device is connected and available.')
    }
  }
  finish(): void {
    const recording = this.active
    if (!recording) return
    if (recording.phase === 'preparing') { this.cancel('Released before recording started. Hold again when microphone access is ready.'); return }
    if (recording.phase !== 'listening') return
    if (Date.now() - recording.startedAt < 300) { this.cancel('Hold the microphone a little longer to record your message.'); return }
    clearTimeout(recording.timer)
    this.phaseChanged(recording, 'transcribing')
    recording.recorder?.stop()
    recording.stream?.getTracks().forEach((track) => track.stop())
  }
  private async upload(recording: Recording, mimeType: string): Promise<void> {
    try {
      const blob = new Blob(recording.chunks, { type: mimeType })
      recording.chunks = []
      // Subscription inference still uses Athena's local Whisper service for
      // speech-to-text (ChatGPT plan access does not provide a transcription
      // endpoint here). Convert both Local AI and ChatGPT Subscription
      // recordings to the WAV format that LocalWhisperTranscription accepts.
      const mode = (await this.api.getSnapshot?.())?.settings.aiMode
      const localTranscription = mode === 'local' || mode === 'subscription'
      const bytes = localTranscription ? await recordingToWav(blob) : new Uint8Array(await blob.arrayBuffer())
      if (this.active !== recording) { bytes.fill(0); return }
      if (!bytes.byteLength || bytes.byteLength > MAX_AUDIO_BYTES) { this.cancel('No usable audio was recorded. Please try again.'); return }
      try {
        const result = await this.api.transcribeVoice({ id: recording.id, sessionId: recording.sessionId, mimeType: localTranscription ? 'audio/wav' : mimeType as 'audio/webm', bytes })
        if (this.active !== recording) return
        if (!result.ok || !result.transcript) { this.cancel(result.message ?? 'No speech was recognized.'); return }
        this.hooks.transcript(result.transcript, recording.sessionId)
        this.cancel('Transcription complete. See your conversation for the transcript.')
      } finally { bytes.fill(0) }
    } catch { if (this.active === recording) this.cancel('Could not transcribe this recording. Check the selected speech service and try again.') }
  }
  cancel(message?: string): void {
    const recording = this.active
    this.active = undefined
    if (recording) {
      clearTimeout(recording.timer)
      if (recording.recorder) {
        recording.recorder.onstop = null; recording.recorder.ondataavailable = null; recording.recorder.onerror = null
        if (recording.recorder.state !== 'inactive') recording.recorder.stop()
      }
      recording.stream?.getTracks().forEach((track) => track.stop())
      if (recording.levelFrame !== undefined && typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(recording.levelFrame)
      if (recording.audioContext) void recording.audioContext.close().catch(() => {})
      recording.audioContext = undefined; recording.analyser = undefined; recording.levelFrame = undefined
      recording.chunks = []
      void this.api.cancelVoice({ id: recording.id, sessionId: recording.sessionId }).catch(() => {})
    }
    this.hooks.state('idle', message)
  }
}
