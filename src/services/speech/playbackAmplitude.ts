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

  async setSinkId(sinkId: string): Promise<void> {
    const generation = this.generation
    this.onLevel(0)
    const context = this.context as (AudioContext & { setSinkId?: (id: string) => Promise<void> }) | undefined
    if (!context?.setSinkId) throw new Error('Audio output routing is unavailable.')
    await context.suspend()
    if (generation !== this.generation) return
    await context.setSinkId(sinkId)
    if (generation === this.generation) await context.resume()
  }

  constructor(private readonly onLevel: (level: number) => void) {}

  async prepare(audio: HTMLAudioElement, sinkId: string): Promise<void> {
    this.stop()
    const generation = this.generation
    const check = () => { if (generation !== this.generation) throw new Error('Audio playback was cancelled.') }
    if (typeof AudioContext === 'undefined') throw new Error('Audio processing is unavailable.')
    this.context ??= new AudioContext()
    await this.context.suspend()
    check()
    const routable = this.context as AudioContext & { setSinkId?: (id: string) => Promise<void> }
    if (typeof routable.setSinkId !== 'function') throw new Error('This runtime cannot route Web Audio to the selected speaker.')
    await routable.setSinkId(sinkId)
    check()
    this.analyser ??= this.context.createAnalyser()
    this.analyser.fftSize = 512
    this.samples ??= new Uint8Array(this.analyser.fftSize)
    this.source = this.context.createMediaElementSource(audio)
    this.source.connect(this.analyser)
    this.analyser.connect(this.context.destination)
    await this.context.resume()
  }

  start(_audio?: HTMLAudioElement): void {
    const generation = this.generation
    clearInterval(this.timer)
    this.timer = setInterval(() => {
      if (generation !== this.generation || !this.analyser || !this.samples) return
      this.analyser.getByteTimeDomainData(this.samples)
      this.onLevel(this.context?.state === 'running' ? speechLevel(audioRms(this.samples)) : 0)
    }, 40)
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
