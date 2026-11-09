import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Blob as NodeBlob } from 'node:buffer'
import { VoiceCapture } from '../src/services/speech/voiceCapture'
import type { VoiceResult } from '../shared/voice'
import { MAX_RECORDING_MS } from '../shared/voice'

class Recorder {
  static isTypeSupported = () => true
  static latest: Recorder
  state = 'inactive'
  onstop: (() => void) | null = null
  ondataavailable: ((event: { data: Blob }) => void) | null = null
  onerror: (() => void) | null = null
  constructor() { Recorder.latest = this }
  start() { this.state = 'recording' }
  stop() { this.state = 'inactive'; this.ondataavailable?.({ data: new Blob(['mock audio']) }); this.onstop?.() }
}
function fixture() {
  const stop = vi.fn()
  const stream = { getTracks: () => [{ stop, addEventListener: vi.fn() }] } as unknown as MediaStream
  const getUserMedia = vi.fn(async () => stream)
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } })
  const api = { beginVoice: vi.fn(async (): Promise<VoiceResult> => ({ ok: true })), voiceRecording: vi.fn(async () => ({ ok: true })),
    transcribeVoice: vi.fn(async (): Promise<VoiceResult> => ({ ok: true, transcript: 'Explain this file.' })), cancelVoice: vi.fn(async () => ({ ok: true })) }
  const hooks = { state: vi.fn(), transcript: vi.fn() }
  const capture = new VoiceCapture(api, hooks)
  return { capture, api, hooks, getUserMedia, stop, stream }
}
const sessionId = '00000000-0000-4000-a000-000000000002'
beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal('MediaRecorder', Recorder); vi.stubGlobal('Blob', NodeBlob) })
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals() })
describe('push-to-talk recording', () => {
  it('records audio only, releases tracks before upload, and returns transcript to its original composer', async () => {
    const f = fixture(); await f.capture.begin(sessionId)
    expect(f.getUserMedia).toHaveBeenCalledWith({ audio: { echoCancellation: { ideal: true }, noiseSuppression: { ideal: true }, channelCount: { ideal: 1 } }, video: false })
    expect(f.capture.phase).toBe('listening')
    vi.advanceTimersByTime(600); f.capture.finish()
    expect(f.stop).toHaveBeenCalled()
    await vi.waitFor(() => expect(f.hooks.transcript).toHaveBeenCalledWith('Explain this file.', sessionId))
    expect(f.api.transcribeVoice).toHaveBeenCalledOnce()
    expect(f.capture.phase).toBe('idle'); expect(vi.getTimerCount()).toBe(0)
  })
  it('never accesses microphone when app permission is denied', async () => {
    const f = fixture(); f.api.beginVoice.mockResolvedValue({ ok: false, message: 'Enable microphone.' })
    await f.capture.begin(sessionId)
    expect(f.getUserMedia).not.toHaveBeenCalled(); expect(f.capture.phase).toBe('idle')
    expect(f.hooks.state).toHaveBeenLastCalledWith('idle', 'Enable microphone.')
  })
  it('releases a late getUserMedia stream when cancelled while awaiting the device', async () => {
    const f = fixture(); let resolve!: (stream: MediaStream) => void
    f.getUserMedia.mockImplementation(() => new Promise((done) => { resolve = done }))
    const begin = f.capture.begin(sessionId); await Promise.resolve()
    f.capture.cancel(); resolve(f.stream); await begin
    expect(f.stop).toHaveBeenCalledOnce(); expect(f.api.voiceRecording).not.toHaveBeenCalled()
  })
  it('releasing during permission setup does not start an unintended recording later', async () => {
    const f = fixture(); let resolve!: (result: VoiceResult) => void
    f.api.beginVoice.mockImplementation(() => new Promise((done) => { resolve = done }))
    const begin = f.capture.begin(sessionId); f.capture.finish(); resolve({ ok: true }); await begin
    expect(f.getUserMedia).not.toHaveBeenCalled(); expect(f.capture.phase).toBe('idle')
  })
  it('cancels cleanly without uploading and tolerates repeated cleanup', async () => {
    const f = fixture(); await f.capture.begin(sessionId); f.capture.cancel(); f.capture.cancel()
    expect(f.stop).toHaveBeenCalledOnce(); expect(f.api.cancelVoice).toHaveBeenCalledOnce()
    expect(f.api.transcribeVoice).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0)
  })
  it('ignores a late transcription after the user switches sessions or cancels', async () => {
    const f = fixture(); let resolve!: (result: VoiceResult) => void
    f.api.transcribeVoice.mockImplementation(() => new Promise((done) => { resolve = done }))
    await f.capture.begin(sessionId); vi.advanceTimersByTime(600); f.capture.finish()
    await vi.waitFor(() => expect(f.api.transcribeVoice).toHaveBeenCalledOnce())
    f.capture.cancel(); resolve({ ok: true, transcript: 'wrong session' }); await Promise.resolve()
    expect(f.hooks.transcript).not.toHaveBeenCalled()
  })
  it('automatically stops at 60 seconds and will not start overlapping capture', async () => {
    const f = fixture(); await f.capture.begin(sessionId); await f.capture.begin(sessionId)
    expect(f.getUserMedia).toHaveBeenCalledOnce()
    vi.advanceTimersByTime(MAX_RECORDING_MS)
    expect(f.capture.phase).toBe('transcribing'); expect(f.stop).toHaveBeenCalled()
    await vi.waitFor(() => expect(f.capture.phase).toBe('idle'))
  })
  it('returns a useful missing-device error without leaking browser details', async () => {
    const f = fixture(); f.getUserMedia.mockRejectedValue(new DOMException('private detail', 'NotFoundError'))
    await f.capture.begin(sessionId)
    expect(f.hooks.state).toHaveBeenLastCalledWith('idle', expect.stringContaining('No microphone'))
  })
})
