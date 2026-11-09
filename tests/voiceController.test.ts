import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { VoiceController, type VoiceContext } from '../electron/main/voice/voiceController'
import { allowsVoiceMedia, mainFrameMediaRequestContext } from '../electron/main/voice/mediaPolicy'
import { MAX_AUDIO_BYTES, MAX_RECORDING_MS, TRANSCRIPTION_TIMEOUT_MS, voiceClipSchema, type VoiceSnapshot } from '../shared/voice'
import { ChatError } from '../electron/main/ai/AIProvider'

const identity = { id: '00000000-0000-4000-a000-000000000001', sessionId: '00000000-0000-4000-a000-000000000002' }
const clip = () => ({ ...identity, mimeType: 'audio/webm' as const, bytes: new Uint8Array([1, 2, 3]) })
function fixture() {
  let allowed = true
  const context: VoiceContext = { sessionId: identity.sessionId, fingerprint: 'same-project-and-model', idle: true }
  const states: VoiceSnapshot[] = []
  const transcribe = vi.fn(async (_clip, _signal: AbortSignal) => 'Explain this project.')
  const authorize = vi.fn(async () => {})
  const controller = new VoiceController({ transcribe }, { context: () => context, allowed: () => allowed, authorize, changed: (state) => states.push(state) })
  return { controller, context, states, transcribe, authorize, revoke: () => { allowed = false } }
}
beforeEach(() => vi.useFakeTimers())
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })
describe('voice lifecycle', () => {
  it('requires authorization, transitions listening/thinking/idle and returns text without a separate chat pipeline', async () => {
    const f = fixture()
    expect(f.controller.canCapture()).toBe(false)
    expect(await f.controller.begin(identity)).toEqual({ ok: true })
    expect(f.controller.canCapture()).toBe(true)
    expect(f.controller.recording(identity).ok).toBe(true)
    const audio = clip()
    expect(await f.controller.transcribe(audio)).toEqual({ ok: true, transcript: 'Explain this project.' })
    expect(f.states.map((state) => state.phase)).toEqual(['preparing', 'listening', 'transcribing', 'idle'])
    expect(audio.bytes.every((byte) => byte === 0)).toBe(true)
    expect(f.controller.canCapture()).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('does not record or upload without permission', async () => {
    const f = fixture(); f.revoke()
    expect((await f.controller.begin(identity)).ok).toBe(false)
    expect(f.controller.recording(identity).ok).toBe(false)
    expect((await f.controller.transcribe(clip())).ok).toBe(false)
    expect(f.transcribe).not.toHaveBeenCalled()
  })
  it('never permits capture before asynchronous authorization succeeds; cancel invalidates pending permission', async () => {
    const f = fixture(); let resolve!: () => void
    f.authorize.mockImplementation(() => new Promise<void>((done) => { resolve = done }))
    const pending = f.controller.begin(identity)
    expect(f.controller.canCapture()).toBe(false)
    f.controller.cancel(); resolve()
    expect((await pending).ok).toBe(false)
    expect(f.controller.canCapture()).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('permits only one recording and one upload, rejecting duplicate/stale IDs', async () => {
    const f = fixture(); await f.controller.begin(identity); f.controller.recording(identity)
    expect((await f.controller.begin(identity)).ok).toBe(false)
    expect((await f.controller.transcribe({ ...clip(), id: crypto.randomUUID() })).ok).toBe(false)
    await f.controller.transcribe(clip())
    expect((await f.controller.transcribe(clip())).ok).toBe(false)
    expect(f.transcribe).toHaveBeenCalledOnce()
  })
  it('accepts an interrupt-only recording during a running task when explicitly enabled', async () => {
    const context: VoiceContext = { sessionId: identity.sessionId, fingerprint: 'task', idle: false }
    const transcribe = vi.fn(async () => 'Cancel the current task')
    const controller = new VoiceController({ transcribe }, { context: () => context, allowed: () => true, authorize: async () => {}, allowBusyInterrupt: () => true, changed: () => {} })
    expect((await controller.begin(identity)).ok).toBe(true)
    expect(controller.recording(identity).ok).toBe(true)
    expect(await controller.transcribe(clip())).toEqual({ ok: true, transcript: 'Cancel the current task' })
    expect(transcribe).toHaveBeenCalledOnce()
  })
  it.each(['session', 'model', 'busy', 'permission'])('cancels when %s changes', async (change) => {
    const f = fixture(); await f.controller.begin(identity); f.controller.recording(identity)
    if (change === 'session') f.context.sessionId = crypto.randomUUID()
    if (change === 'model') f.context.fingerprint = 'different-model'
    if (change === 'busy') f.context.idle = false
    if (change === 'permission') f.revoke()
    f.controller.reconcile()
    expect(f.controller.snapshot().phase).toBe('idle')
    expect((await f.controller.transcribe(clip())).ok).toBe(false)
    expect(f.transcribe).not.toHaveBeenCalled()
  })
  it('cancels in-flight transcription and discards late results', async () => {
    const f = fixture(); let resolve!: (text: string) => void
    f.transcribe.mockImplementation(() => new Promise<string>((done) => { resolve = done }))
    await f.controller.begin(identity); f.controller.recording(identity)
    const result = f.controller.transcribe(clip())
    expect(f.controller.canCapture()).toBe(false)
    f.controller.cancel(); resolve('must not leak to the next session')
    expect((await result).ok).toBe(false)
    expect(f.transcribe.mock.calls[0][1].aborted).toBe(true)
  })
  it('cleans up after capture timeout, transcription timeout and disposal', async () => {
    const f = fixture(); await f.controller.begin(identity); f.controller.recording(identity)
    vi.advanceTimersByTime(MAX_RECORDING_MS + 2_000)
    expect(f.controller.snapshot().phase).toBe('idle')
    await f.controller.begin(identity); f.controller.recording(identity)
    let resolve!: (text: string) => void
    f.transcribe.mockImplementation(() => new Promise<string>((done) => { resolve = done }))
    const result = f.controller.transcribe(clip())
    vi.advanceTimersByTime(TRANSCRIPTION_TIMEOUT_MS)
    expect(f.controller.snapshot().message).toMatch(/timed out/)
    resolve('late'); expect((await result).ok).toBe(false)
    f.controller.dispose()
    expect((await f.controller.begin(identity)).ok).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })
  it.each(['', 'x'.repeat(12_001)])('rejects empty or oversized transcripts', async (text) => {
    const f = fixture(); f.transcribe.mockResolvedValue(text)
    await f.controller.begin(identity); f.controller.recording(identity)
    expect((await f.controller.transcribe(clip())).ok).toBe(false)
    expect(f.controller.snapshot().phase).toBe('idle')
  })
  it('uses sanitized errors and clears state on provider failure', async () => {
    const f = fixture(); f.transcribe.mockRejectedValue(new ChatError('Credits exhausted.'))
    await f.controller.begin(identity); f.controller.recording(identity)
    expect(await f.controller.transcribe(clip())).toEqual({ ok: false, message: 'Credits exhausted.' })
    expect(vi.getTimerCount()).toBe(0)
  })
  it('validates clip size, MIME and identity', () => {
    for (const input of [{ ...clip(), bytes: new Uint8Array() }, { ...clip(), bytes: new Uint8Array(MAX_AUDIO_BYTES + 1) }, { ...clip(), mimeType: 'video/webm' }, { ...clip(), path: '/private/file' }]) expect(voiceClipSchema.safeParse(input).success).toBe(false)
  })
})
describe('Electron audio-only lease', () => {
  const valid = { senderId: 1, controlId: 1, permission: 'media', isMainFrame: true, requestingUrl: 'file:///athena/index.html?surface=control', controlUrl: 'file:///athena/index.html?surface=control', mediaTypes: ['audio'], captureAllowed: true }
  it('permits audio only in the active trusted control or floating-panel lease', () => {
    expect(allowsVoiceMedia(valid)).toBe(true)
    expect(allowsVoiceMedia({ ...valid, senderId: 3, controlId: 3, requestingUrl: 'file:///athena/index.html?surface=panel', controlUrl: 'file:///athena/index.html?surface=panel' })).toBe(true)
    for (const patch of [{ senderId: 2 }, { isMainFrame: false }, { requestingUrl: 'https://example.com' }, { permission: 'display-capture' }, { mediaTypes: ['audio', 'video'] }, { mediaTypes: ['video'] }, { mediaTypes: ['unknown'] }, { mediaTypes: [] }, { captureAllowed: false }]) expect(allowsVoiceMedia({ ...valid, ...patch })).toBe(false)
  })
  it('derives a trusted main-frame context for Electron media requests', () => {
    const url = 'athena://renderer/index.html?surface=floating'
    expect(mainFrameMediaRequestContext({ currentUrl: url, mainFrameUrl: url, securityOrigin: 'athena://renderer' }))
      .toEqual({ isMainFrame: true, requestingUrl: url })
    expect(mainFrameMediaRequestContext({ currentUrl: url, mainFrameUrl: url, securityOrigin: 'athena://renderer/' }))
      .toEqual({ isMainFrame: true, requestingUrl: url })
    expect(mainFrameMediaRequestContext({ currentUrl: url, mainFrameUrl: url, securityOrigin: 'https://attacker.example' }).isMainFrame).toBe(false)
    expect(mainFrameMediaRequestContext({ currentUrl: url, mainFrameUrl: 'athena://renderer/other.html?surface=floating' }).isMainFrame).toBe(false)
    expect(mainFrameMediaRequestContext({ currentUrl: url }).isMainFrame).toBe(false)
  })
})
