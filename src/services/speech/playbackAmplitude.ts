// A small, playback-only meter. It never captures the microphone or generates audio.
export function audioRms(samples: Uint8Array): number {
  if (!samples.length) return 0
  let sum = 0
  for (const sample of samples) {
    const value = (sample - 128) / 128
    sum += value * value
  }
  return Math.sqrt(sum / samples.length)
}

export function speechLevel(rms: number): number {
  if (!Number.isFinite(rms)) return 0
  return Math.max(0, Math.min(1, (rms - 0.012) / 0.15))
}

export class PlaybackAmplitude {
  private context?: AudioContext
  private analyser?: AnalyserNode
  private source?: MediaElementAudioSourceNode
  private samples?: Uint8Array<ArrayBuffer>
  private timer?: ReturnType<typeof setInterval>
  private generation = 0

  constructor(private readonly onLevel: (level: number) => void) {}

  start(audio: HTMLAudioElement): void {
    this.stop()
    if (typeof AudioContext === 'undefined') return
    try {
      this.context ??= new AudioContext()
      this.analyser ??= this.context.createAnalyser()
      this.analyser.fftSize = 512
      this.samples ??= new Uint8Array(this.analyser.fftSize)
      this.source = this.context.createMediaElementSource(audio)
      this.source.connect(this.analyser)
      this.analyser.connect(this.context.destination)
      const generation = this.generation
      void this.context.resume().catch(() => { if (generation === this.generation) this.stop() })
      this.timer = setInterval(() => {
        if (generation !== this.generation || !this.analyser || !this.samples) return
        this.analyser.getByteTimeDomainData(this.samples)
        this.onLevel(speechLevel(audioRms(this.samples)))
      }, 40)
    } catch {
      this.stop()
    }
  }

  stop(): void {
    this.generation++
    clearInterval(this.timer)
    this.timer = undefined
    this.source?.disconnect()
    this.source = undefined
    this.analyser?.disconnect()
    this.onLevel(0)
  }

  dispose(): void {
    this.stop()
    const context = this.context
    this.context = undefined
    this.analyser = undefined
    this.samples = undefined
    if (context) void context.close().catch(() => {})
  }
}
