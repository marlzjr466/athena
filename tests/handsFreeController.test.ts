import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultSettings } from '../shared/settings'
import { encodeHandsFreeWav } from '../shared/handsFree'
import { HANDS_FREE_TRANSCRIPTION_TIMEOUT_MS, HandsFreeController } from '../electron/main/voice/handsFreeController'

afterEach(() => vi.useRealTimers())

describe('hands-free local transcription boundary', () => {
  it('rejects malformed or near-silent WAV before invoking local Whisper', async () => {
    const settings = structuredClone(defaultSettings)
    settings.voiceInteraction.handsFreeEnabled = true
    settings.localAI.speechEngine = 'whisper-cli'
    settings.localAI.speechModelPath = '/models/whisper.bin'
    const local = { transcribe: vi.fn(async () => 'Athena, hello.') }
    const controller = new HandsFreeController(local, () => settings, () => true)
    expect(controller.activate(10).ok).toBe(true)

    const invalid = await controller.transcribe(10, { id: crypto.randomUUID(), mimeType: 'audio/wav', bytes: new Uint8Array(256) })
    expect(invalid.ok).toBe(false)
    expect(local.transcribe).not.toHaveBeenCalled()

    const silence = new Float32Array(16_000).fill(0.00001)
    const silentWav = encodeHandsFreeWav(silence)
    const quiet = await controller.transcribe(10, { id: crypto.randomUUID(), mimeType: 'audio/wav', bytes: silentWav })
    expect(quiet.ok).toBe(false)
    expect(local.transcribe).not.toHaveBeenCalled()
  })

  it('uses only local transcription and clears the submitted audio buffer afterward', async () => {
    const settings = structuredClone(defaultSettings)
    settings.voiceInteraction.handsFreeEnabled = true
    settings.localAI.speechEngine = 'whisper-cli'
    settings.localAI.speechModelPath = '/models/whisper.bin'
    const local = { transcribe: vi.fn(async () => 'Hey Athena, what time is it?') }
    const controller = new HandsFreeController(local, () => settings, () => true)
    controller.activate(12)
    const bytes = encodeHandsFreeWav(new Float32Array(16_000).map((_, index) => Math.sin(index * 0.08) * 0.025))
    const result = await controller.transcribe(12, { id: crypto.randomUUID(), mimeType: 'audio/wav', bytes })
    expect(result).toEqual({ ok: true, transcript: 'Hey Athena, what time is it?' })
    expect(local.transcribe).toHaveBeenCalledOnce()
    expect([...bytes].every((byte) => byte === 0)).toBe(true)
  })

  it('aborts stalled local transcription and returns a recoverable timeout', async () => {
    vi.useFakeTimers()
    const settings = structuredClone(defaultSettings)
    settings.voiceInteraction.handsFreeEnabled = true
    settings.localAI.speechEngine = 'whisper-cli'
    settings.localAI.speechModelPath = '/models/whisper.bin'
    let signal: AbortSignal | undefined
    const local = { transcribe: vi.fn((_clip: unknown, currentSignal: AbortSignal) => {
      signal = currentSignal
      return new Promise<string>((_resolve, reject) => currentSignal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))
    }) }
    const controller = new HandsFreeController(local, () => settings, () => true)
    controller.activate(22)
    const bytes = encodeHandsFreeWav(new Float32Array(16_000).map((_, index) => Math.sin(index * 0.08) * 0.025))
    const pending = controller.transcribe(22, { id: crypto.randomUUID(), mimeType: 'audio/wav', bytes })

    await vi.advanceTimersByTimeAsync(HANDS_FREE_TRANSCRIPTION_TIMEOUT_MS)

    expect(signal?.aborted).toBe(true)
    await expect(pending).resolves.toEqual({ ok: false, message: 'Speech recognition took too long. Try a shorter phrase.' })
    expect([...bytes].every((byte) => byte === 0)).toBe(true)
  })
})
