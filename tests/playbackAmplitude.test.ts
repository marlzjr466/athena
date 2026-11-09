import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { audioRms, PlaybackAmplitude, speechLevel } from '../src/services/speech/playbackAmplitude'
import { mouthOpenForAmplitude, setVoiceAmplitude, voiceAmplitude } from '../src/three/voiceAmplitude'

describe('playback-driven mouth signal', () => {
  it('treats silence as closed and scales speech intensity without exceeding the rig range', () => {
    expect(audioRms(new Uint8Array([128, 128, 128]))).toBe(0)
    expect(speechLevel(audioRms(new Uint8Array([128, 128])))).toBe(0)
    const soft = speechLevel(audioRms(new Uint8Array([118, 138])))
    const loud = speechLevel(audioRms(new Uint8Array([96, 160])))
    expect(loud).toBeGreaterThan(soft)
    expect(speechLevel(10)).toBe(1)
    setVoiceAmplitude(loud)
    expect(mouthOpenForAmplitude(voiceAmplitude(), true)).toBe(loud)
    expect(mouthOpenForAmplitude(voiceAmplitude(), false)).toBe(0)
    setVoiceAmplitude(0)
  })
})

describe('playback analyser lifecycle', () => {
  const original = globalThis.AudioContext
  const values = new Uint8Array(512)
  const connect = vi.fn()
  const disconnect = vi.fn()
  const close = vi.fn(async () => {})
  const source = { connect, disconnect }
  const analyser = { fftSize: 512, connect, disconnect, getByteTimeDomainData: (target: Uint8Array) => target.set(values) }
  const createMediaElementSource = vi.fn(() => source)
  const context = { createAnalyser: () => analyser, createMediaElementSource, destination: {}, resume: vi.fn(async () => {}), close }
  beforeEach(() => {
    vi.useFakeTimers()
    values.fill(128)
    Object.defineProperty(globalThis, 'AudioContext', { configurable: true, value: class { constructor() { return context } } })
  })
  afterEach(() => {
    vi.clearAllTimers(); vi.useRealTimers(); vi.clearAllMocks()
    Object.defineProperty(globalThis, 'AudioContext', { configurable: true, value: original })
  })
  it('samples only during real playback and stops immediately on interruption', async () => {
    const levels = vi.fn()
    const meter = new PlaybackAmplitude(levels)
    expect(vi.getTimerCount()).toBe(0)
    meter.start({} as HTMLAudioElement)
    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(40)
    expect(levels).toHaveBeenLastCalledWith(0)
    values.fill(128); values[0] = 0; values[1] = 255
    vi.advanceTimersByTime(40)
    expect(levels.mock.lastCall?.[0]).toBeGreaterThan(0)
    meter.stop()
    expect(levels).toHaveBeenLastCalledWith(0)
    expect(vi.getTimerCount()).toBe(0)
    meter.start({} as HTMLAudioElement)
    expect(createMediaElementSource).toHaveBeenCalledTimes(2)
    meter.dispose()
    expect(vi.getTimerCount()).toBe(0)
    expect(close).toHaveBeenCalledOnce()
  })
})
