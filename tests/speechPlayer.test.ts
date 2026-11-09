import { describe, expect, it, vi } from 'vitest'
import { SpeechPlayer } from '../src/services/speech/speechPlayer'
import type { AthenaAPI } from '../shared/contracts'

describe('speech playback ownership', () => {
  it('does not stop another window’s playback when its own start is declined', async () => {
    const stopSpeech = vi.fn(async () => ({ ok: true }))
    const api = {
      beginSpeech: vi.fn(async () => ({ ok: false, message: 'Another window is speaking.' })),
      nextSpeech: vi.fn(), speechPlaying: vi.fn(), stopSpeech,
    } as unknown as Pick<AthenaAPI, 'beginSpeech' | 'nextSpeech' | 'speechPlaying' | 'stopSpeech'>
    const player = new SpeechPlayer(api, vi.fn(), () => 1)
    await player.start({ sessionId: 'session', messageId: 'message' })
    player.dispose()
    expect(stopSpeech).toHaveBeenCalledWith({ sessionId: 'session', messageId: 'message', playerOnly: true })
  })
  it('waits for later streaming text, resumes once, and stops after the final segment', async () => {
    const originalAudio = globalThis.Audio
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:athena')
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const players: Array<{ onplaying: (() => void) | null; onended: (() => void) | null }> = []
    class FakeAudio {
      onplaying: (() => void) | null = null
      onended: (() => void) | null = null
      onerror: (() => void) | null = null
      volume = 1
      playbackRate = 1
      constructor(_url: string) { players.push(this) }
      play() { this.onplaying?.(); this.onplaying?.(); return Promise.resolve() }
      pause() {}
      removeAttribute() {}
      load() {}
    }
    Object.defineProperty(globalThis, 'Audio', { configurable: true, value: FakeAudio })
    try {
      const nextSpeech = vi.fn().mockResolvedValueOnce({ ok: true, waiting: true }).mockResolvedValueOnce({ ok: true, index: 1, bytes: new Uint8Array([3, 4]), mimeType: 'audio/wav' }).mockResolvedValueOnce({ ok: true, done: true })
      const stopSpeech = vi.fn(async () => ({ ok: true }))
      const api = { beginSpeech: vi.fn(async () => ({ ok: true, index: 0, bytes: new Uint8Array([1, 2]), mimeType: 'audio/wav' })), nextSpeech, speechPlaying: vi.fn(async () => ({ ok: true })), stopSpeech } as unknown as Pick<AthenaAPI, 'beginSpeech' | 'nextSpeech' | 'speechPlaying' | 'stopSpeech'>
      const player = new SpeechPlayer(api, vi.fn(), () => 1)
      await player.start({ sessionId: 's', messageId: 'm', replay: true })
      expect(api.speechPlaying).toHaveBeenCalledTimes(1)
      expect(api.speechPlaying).toHaveBeenCalledWith({ sessionId: 's', messageId: 'm', index: 0 })
      players[0].onended?.(); await vi.waitFor(() => expect(nextSpeech).toHaveBeenCalledTimes(1))
      player.onChatUpdate(); await vi.waitFor(() => expect(players).toHaveLength(2))
      players[1].onended?.(); await vi.waitFor(() => expect(stopSpeech).toHaveBeenCalled())
      expect(nextSpeech).toHaveBeenCalledTimes(3)
      expect(nextSpeech).toHaveBeenCalledWith({ sessionId: 's', messageId: 'm', index: 1 })
      expect(stopSpeech).toHaveBeenCalledWith({ sessionId: 's', messageId: 'm', playerOnly: true })
      player.dispose()
    } finally {
      Object.defineProperty(globalThis, 'Audio', { configurable: true, value: originalAudio })
      createObjectURL.mockRestore(); revokeObjectURL.mockRestore()
    }
  })
})
