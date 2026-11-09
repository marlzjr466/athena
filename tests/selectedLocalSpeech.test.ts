// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { SelectedLocalSpeech } from '../electron/main/voice/selectedLocalSpeech'
import { defaultSettings } from '../shared/settings'

function engine(bytes: number[], calls: string[]) {
  return {
    mimeType: 'audio/wav' as const,
    generate: vi.fn(async (text: string) => { calls.push(text); return new Uint8Array(bytes) }),
    dispose: vi.fn(),
  }
}

describe('selected local voice routing', () => {
  it('routes preview, floating replies and wake acknowledgments to Higgs and propagates errors without fallback', async () => {
    const settings = structuredClone(defaultSettings)
    settings.localVoice.engine = 'higgs-tts-3-4b'
    const chatterbox = engine([1], []), sesame = engine([2], []), higgs = engine([3], [])
    const speech = new SelectedLocalSpeech(() => settings, chatterbox, sesame, higgs)
    const signal = new AbortController().signal
    for (const context of ['preview:higgs', 'athena-local:conversation', 'wake-ack:higgs']) {
      await speech.generate('Hello', 'coral', 1, signal, context)
    }
    expect(higgs.generate).toHaveBeenCalledTimes(3)
    higgs.generate.mockRejectedValueOnce(new Error('Unsupported Higgs architecture'))
    await expect(speech.generate('Hello', 'coral', 1, signal)).rejects.toThrow('Unsupported Higgs architecture')
    expect(chatterbox.generate).not.toHaveBeenCalled()
    expect(sesame.generate).not.toHaveBeenCalled()
    expect(settings.localVoice.engine).toBe('higgs-tts-3-4b')
    speech.dispose()
  })
  it('routes both current and legacy Sesame selections to official CSM', async () => {
    const settings = structuredClone(defaultSettings), chatterboxCalls: string[] = [], officialCalls: string[] = []
    const chatterbox = engine([1], chatterboxCalls), official = engine([2], officialCalls)
    const speech = new SelectedLocalSpeech(() => settings, chatterbox, official, engine([3], []))
    for (const selected of ['sesame-csm-official', 'sesame-csm'] as const) {
      settings.localVoice.engine = selected
      expect(await speech.generate('hello', settings.voiceName, 1, new AbortController().signal)).toEqual(new Uint8Array([2]))
    }
    expect(officialCalls).toEqual(['hello', 'hello'])
    expect(chatterboxCalls).toEqual([])
    settings.localVoice.engine = 'higgs-tts-3-4b'
    expect(await speech.generate('hello', settings.voiceName, 1, new AbortController().signal)).toEqual(new Uint8Array([3]))
    speech.dispose()
  })

  it('caches wake acknowledgments per selected voice key and returns copies', async () => {
    const settings = structuredClone(defaultSettings), calls: string[] = []
    const speech = new SelectedLocalSpeech(() => settings, engine([7, 8], calls), engine([9], []), engine([3], []))
    const signal = new AbortController().signal
    const first = await speech.generateCached('Hey!', settings.voiceName, 1, signal, 'wake:chatterbox:v1')
    const second = await speech.generateCached('Hey!', settings.voiceName, 1, signal, 'wake:chatterbox:v1')
    expect(first).toMatchObject({ cached: false, bytes: new Uint8Array([7, 8]) })
    expect(second).toMatchObject({ cached: true, bytes: new Uint8Array([7, 8]) })
    expect(calls).toEqual(['Hey!'])
    second.bytes[0] = 99
    const third = await speech.generateCached('Hey!', settings.voiceName, 1, signal, 'wake:chatterbox:v1')
    expect(third.bytes).toEqual(new Uint8Array([7, 8]))
    speech.dispose()
  })
})
