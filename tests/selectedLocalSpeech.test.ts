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
  it('routes local speech to Chatterbox and propagates errors without a hidden fallback', async () => {
    const settings = structuredClone(defaultSettings), local = engine([1], [])
    const speech = new SelectedLocalSpeech(() => settings, local)
    const signal = new AbortController().signal
    expect(await speech.generate('Hello', 'coral', 1, signal)).toEqual(new Uint8Array([1]))
    local.generate.mockRejectedValueOnce(new Error('Local runtime unavailable'))
    await expect(speech.generate('Hello', 'coral', 1, signal)).rejects.toThrow('Local runtime unavailable')
    speech.dispose(); expect(local.dispose).toHaveBeenCalledOnce()
  })

  it('caches wake acknowledgments per selected voice key and returns copies', async () => {
    const settings = structuredClone(defaultSettings), calls: string[] = []
    const speech = new SelectedLocalSpeech(() => settings, engine([7, 8], calls))
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
