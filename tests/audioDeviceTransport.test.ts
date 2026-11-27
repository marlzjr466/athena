import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultSettings } from '../shared/settings'
import { emptyAudioDeviceState, type AudioDeviceState } from '../shared/audioDevices'
const mock = vi.hoisted(() => ({ state: {} as AudioDeviceState, preferences: {} as typeof defaultSettings.audioDevices, listener: undefined as undefined | ((state: AudioDeviceState) => void) }))
vi.mock('../src/services/desktop', () => ({ desktop: {
  getSnapshot: async () => ({ settings: { audioDevices: mock.preferences } }),
  audioDevices: vi.fn(async () => mock.state),
  onAudioDevices: (callback: (state: AudioDeviceState) => void) => { mock.listener = callback; return () => { mock.listener = undefined } },
} }))
import { connectAudioDevices, MicrophoneSource, microphoneConstraints, routeSpeech } from '../src/services/speech/audioDevices'
import { VoiceCapture } from '../src/services/speech/voiceCapture'

let disconnect: () => void
let revision = 0
beforeEach(async () => {
  mock.preferences = { ...defaultSettings.audioDevices }
  mock.state = { ...emptyAudioDeviceState(), revision: (revision += 100), input: { deviceId: 'mic-a', label: 'Microphone A' }, output: { deviceId: 'headset-a', label: 'Headset A' } }
  disconnect = connectAudioDevices(); await Promise.resolve(); mock.listener?.(mock.state)
})
afterEach(() => { disconnect(); vi.unstubAllGlobals(); vi.clearAllMocks() })
function stream(id = 'mic-a') {
  let ended: () => void = () => {}
  const track = { readyState: 'live', getSettings: (): MediaTrackSettings => ({ deviceId: id }), stop: vi.fn(() => { track.readyState = 'ended' }), addEventListener: (_type: string, fn: () => void) => { ended = fn } }
  return { value: { getAudioTracks: () => [track], getTracks: () => [track] } as unknown as MediaStream, track, end: () => { track.readyState = 'ended'; ended() } }
}
function changed(patch: Partial<AudioDeviceState>) { mock.state = { ...mock.state, ...patch, revision: mock.state.revision + 1 }; mock.listener?.(mock.state) }
describe('microphone lifecycle', () => {
  it('passes the selected device with echo/noise controls and never drops the device constraint', async () => {
    expect(await microphoneConstraints({ echoCancellation: true, noiseSuppression: true })).toEqual({ video: false, audio: { deviceId: { exact: 'mic-a' }, echoCancellation: true, noiseSuppression: true } })
  })
  it('serializes concurrent opens, retains the same healthy stream, and closes late captures', async () => {
    const first = stream()
    let resolve!: (stream: MediaStream) => void
    const getUserMedia = vi.fn(() => new Promise<MediaStream>(done => { resolve = done }))
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } })
    const source = new MicrophoneSource(() => ({}), vi.fn())
    const pending = source.getStream(), second = source.getStream()
    expect(pending).toBe(second)
    await vi.waitFor(() => expect(getUserMedia).toHaveBeenCalledOnce())
    resolve(first.value); await pending
    expect(await source.getStream()).toBe(first.value)
    expect(getUserMedia).toHaveBeenCalledOnce()
    source.close(); expect(first.track.stop).toHaveBeenCalledOnce()
    const late = stream(), closed = new MicrophoneSource(() => ({}), vi.fn())
    const capture = closed.getStream()
    await vi.waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(2))
    closed.close(); resolve(late.value)
    await expect(capture).rejects.toThrow('cancelled')
    expect(late.track.stop).toHaveBeenCalledOnce()
  })
  it('reopens only after an actual route change and releases the previous microphone first', async () => {
    const a = stream(), b = stream('mic-b'), notify = vi.fn()
    const getUserMedia = vi.fn().mockResolvedValueOnce(a.value).mockImplementationOnce(() => { expect(a.track.stop).toHaveBeenCalledOnce(); return Promise.resolve(b.value) })
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } })
    const source = new MicrophoneSource(() => ({}), notify)
    await source.getStream()
    changed({ microphoneLevel: 0.7 }); expect(notify).not.toHaveBeenCalled()
    changed({ input: { deviceId: 'mic-b', label: 'USB headset' } }); expect(notify).toHaveBeenCalledOnce()
    await source.getStream(); expect(getUserMedia.mock.calls[1][0].audio.deviceId).toEqual({ exact: 'mic-b' })
    b.end(); expect(source.needsReconnect()).toBe(true)
    source.close()
  })
  it('does not retry a permission denial or silently switch an explicit device', async () => {
    const getUserMedia = vi.fn().mockRejectedValue(new DOMException('denied', 'NotAllowedError'))
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } })
    const source = new MicrophoneSource(() => ({ voiceIsolation: true } as MediaTrackConstraints), vi.fn())
    await expect(source.getStream()).rejects.toMatchObject({ name: 'NotAllowedError' })
    expect(getUserMedia).toHaveBeenCalledOnce(); source.close()
  })
  it('finishes initial capture on the automatic headset when consent reveals new endpoints', async () => {
    const first = stream('mic-a'), second = stream('usb'), notify = vi.fn()
    let release!: (value: MediaStream) => void
    const getUserMedia = vi.fn().mockImplementationOnce(() => new Promise<MediaStream>(resolve => { release = resolve })).mockResolvedValueOnce(second.value)
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } })
    const source = new MicrophoneSource(() => ({}), notify)
    const pending = source.getStream()
    await vi.waitFor(() => expect(getUserMedia).toHaveBeenCalledOnce())
    changed({ input: { deviceId: 'usb', label: 'USB' } })
    release(first.value)
    expect(await pending).toBe(second.value)
    expect(first.track.stop).toHaveBeenCalledOnce()
    expect(notify).not.toHaveBeenCalled()
    source.close()
  })
  it('does not treat consent revealing a default microphone identity as a disconnect', async () => {
    changed({ input: { label: 'Microphone unavailable' }, devices: [] })
    const mic = stream('default'), notify = vi.fn()
    mic.track.getSettings = () => ({ deviceId: 'default', groupId: 'physical-mic' } as MediaTrackSettings)
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn(async () => mic.value) } })
    const source = new MicrophoneSource(() => ({}), notify)
    await source.getStream()
    changed({ input: { deviceId: 'revealed-id', label: 'Microphone' }, devices: [{ deviceId: 'revealed-id', groupId: 'physical-mic', label: 'Microphone', kind: 'audioinput' }] })
    expect(notify).not.toHaveBeenCalled(); expect(source.needsReconnect()).toBe(false)
    source.close()
  })
})
describe('speaker privacy and Web Audio routing', () => {
  it('pins both playback paths before play and pauses on disconnect without replay', async () => {
    const audio = { setSinkId: vi.fn(async () => {}), pause: vi.fn(), play: vi.fn() } as unknown as HTMLAudioElement
    const meter = { prepare: vi.fn(async () => {}) }, stopped = vi.fn()
    const off = await routeSpeech(audio, stopped, meter)
    expect(audio.setSinkId).toHaveBeenCalledWith('headset-a')
    expect(meter.prepare).toHaveBeenCalledWith(audio, 'headset-a')
    changed({ outputHeld: true, output: { deviceId: 'speakers', label: 'Built-in speakers' } })
    expect(audio.pause).toHaveBeenCalledOnce(); expect(stopped).toHaveBeenCalledOnce(); expect(audio.play).not.toHaveBeenCalled()
    off()
  })
  it('moves playback and its analyser in place without replay or synthesis', async () => {
    const audio = { muted: false, setSinkId: vi.fn(async () => {}), pause: vi.fn(), play: vi.fn() } as unknown as HTMLAudioElement
    const meter = { prepare: vi.fn(async () => {}), setSinkId: vi.fn(async () => {}) }, stopped = vi.fn()
    const off = await routeSpeech(audio, stopped, meter)
    changed({ output: { deviceId: 'speakers', label: 'Built-in' } })
    await vi.waitFor(() => expect(meter.setSinkId).toHaveBeenLastCalledWith('speakers'))
    expect(audio.setSinkId).toHaveBeenLastCalledWith('speakers')
    expect(stopped).not.toHaveBeenCalled(); expect(audio.play).not.toHaveBeenCalled(); expect(audio.pause).not.toHaveBeenCalled()
    expect(meter.prepare).toHaveBeenCalledOnce(); expect(audio.muted).toBe(false)
    off()
  })
  it('fails closed for unavailable speakers, unconfirmed changes, and unsupported routing', async () => {
    const audio = { pause: vi.fn(), setSinkId: vi.fn(async () => {}) } as unknown as HTMLAudioElement
    mock.state.outputHeld = true
    await expect(routeSpeech(audio, vi.fn())).rejects.toThrow()
    expect(audio.setSinkId).not.toHaveBeenCalled()
    mock.state.outputHeld = false
    await expect(routeSpeech({ pause: vi.fn() } as unknown as HTMLAudioElement, vi.fn())).rejects.toThrow('safely select')
  })
  it('cancels a pending routing operation when the selected output changes', async () => {
    let resolve!: () => void
    const audio = { pause: vi.fn(), setSinkId: vi.fn(() => new Promise<void>(done => { resolve = done })) } as unknown as HTMLAudioElement
    const pending = routeSpeech(audio, vi.fn())
    await vi.waitFor(() => expect(audio.setSinkId).toHaveBeenCalled())
    changed({ outputHeld: true }); resolve()
    await expect(pending).rejects.toThrow('changed before playback')
  })
})

describe('dictation continuity', () => {
  it('replaces the physical microphone behind one stable recording track', async () => {
    const a = stream(), b = stream('mic-b'), destination = stream('stable-recorder'), nodes: Array<{ connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }> = []
    const getUserMedia = vi.fn().mockResolvedValueOnce(a.value).mockResolvedValueOnce(b.value)
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } })
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1)); vi.stubGlobal('cancelAnimationFrame', vi.fn())
    const close = vi.fn(async () => {})
    vi.stubGlobal('AudioContext', class {
      createAnalyser = () => ({ fftSize: 256, getByteTimeDomainData: (data: Uint8Array) => data.fill(128) })
      createMediaStreamDestination = () => ({ stream: destination.value })
      createMediaStreamSource = (_stream: MediaStream) => { const node = { connect: vi.fn(), disconnect: vi.fn() }; nodes.push(node); return node }
      resume = async () => {}; close = close
    })
    const recordings: MediaStream[] = []
    vi.stubGlobal('MediaRecorder', class {
      static isTypeSupported = () => true
      state = 'inactive'; mimeType = 'audio/webm'
      constructor(stream: MediaStream) { recordings.push(stream) }
      start() { this.state = 'recording' }; stop() { this.state = 'inactive' }
    })
    const api = { beginVoice: vi.fn(async () => ({ ok: true })), voiceRecording: vi.fn(async () => ({ ok: true })), cancelVoice: vi.fn(async () => ({ ok: true })), transcribeVoice: vi.fn(async () => ({ ok: true })) }
    const capture = new VoiceCapture(api, { state: vi.fn(), transcript: vi.fn() })
    await capture.begin(crypto.randomUUID())
    expect(capture.phase).toBe('listening'); expect(recordings).toEqual([destination.value])
    changed({ input: { deviceId: 'mic-b', label: 'Replacement microphone' } })
    await vi.waitFor(() => expect(nodes).toHaveLength(2))
    expect(nodes[0].disconnect).toHaveBeenCalledOnce(); expect(a.track.stop).toHaveBeenCalledOnce()
    expect(recordings).toHaveLength(1); expect(capture.phase).toBe('listening'); expect(api.cancelVoice).not.toHaveBeenCalled()
    capture.cancel(); expect(b.track.stop).toHaveBeenCalledOnce(); expect(destination.track.stop).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce()
  })
})
