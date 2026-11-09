import { describe, expect, it } from 'vitest'
import { defaultSettings, mergeSettings, restoreSettings } from '../shared/settings'
import { deliveryStyle, prepareLocalSpeech, voiceProfileSchema, localVoiceCommandSchema, voiceStudioSchema, mayUseLaughterContext, selectVoiceExample, type VoiceStudio } from '../shared/localVoice'
import { speechChunks, speechText } from '../shared/speech'

describe('local-only voice settings and speech preparation', () => {
  it('defaults to Chatterbox Turbo with local auto-speak and persists the selected engine', () => {
    expect(defaultSettings.localVoice).toMatchObject({ engine: 'chatterbox-turbo', profileId: 'athena-youthful', style: 'conversational', expressiveness: 0.65, autoSpeak: true })
    const saved = mergeSettings(defaultSettings, { localVoice: { ...defaultSettings.localVoice, engine: 'sesame-csm', expressiveness: 0.8 } })
    expect(restoreSettings(JSON.parse(JSON.stringify(saved))).localVoice).toEqual(saved.localVoice)
  })
  it('rejects invalid engines and expressiveness', () => {
    expect(() => mergeSettings(defaultSettings, { localVoice: { ...defaultSettings.localVoice, engine: 'cloud' as never } })).toThrow()
    expect(() => mergeSettings(defaultSettings, { localVoice: { ...defaultSettings.localVoice, expressiveness: 2 } })).toThrow()
  })
  it('describes the US accent as reference metadata rather than an unsupported inference control', () => {
    const profile = voiceProfileSchema.parse({ id: 'athena-youthful', name: 'Athena Youthful', builtIn: true, accent: 'en-US', referenceSource: 'US English synthetic sample' })
    expect(profile.accent).toBe('en-US')
    expect(defaultSettings.localVoice).not.toHaveProperty('accent')
  })
  it('uses subtle delivery styles without changing user-selected styles', () => {
    expect(deliveryStyle('Sorry, I could not open it.', 'conversational')).toBe('concerned')
    expect(deliveryStyle('Great, it is done.', 'conversational')).toBe('happy')
    expect(deliveryStyle('Hello there!', 'conversational')).toBe('warm')
    expect(deliveryStyle('Hello there!', 'calm')).toBe('calm')
  })
  it('uses a restrained local chuckle only for already-amused text', () => {
    expect(prepareLocalSpeech('Haha, that was clever.', 'chatterbox-turbo')).toBe('[chuckle] that was clever.')
    expect(prepareLocalSpeech('The tests failed.', 'chatterbox-turbo')).toBe('The tests failed.')
    expect(prepareLocalSpeech('[chuckle] That was clever.', 'sesame-csm')).toBe('That was clever.')
  })
  it('skips long code and raw URLs and bounds synthesis segments', () => {
    const prepared = speechText('See https://example.com/path.\n```ts\nconst secret = 42\n```')
    expect(prepared).not.toContain('https://')
    expect(prepared).not.toContain('const secret')
    expect(speechChunks('A sentence. '.repeat(200)).every((chunk) => chunk.length <= 1100)).toBe(true)
  })
  it('migrates existing voice preferences without enabling laughter or changing the engine', () => {
    const old = restoreSettings({ localVoice: { engine: 'sesame-csm', profileId: 'athena-youthful', expressiveness: .4 } })
    expect(old.localVoice).toMatchObject({ engine: 'sesame-csm', expressiveness: .4, sesame: { naturalLaughter: false, conversationContext: true, keepWarmSeconds: 120 } })
  })
  it('requires explicit reference authorization, bounded storage, and stable IDs', () => {
    expect(localVoiceCommandSchema.safeParse({ action: 'add-example', name: 'Warm', profileId: 'adult', text: 'Hello', kind: 'conversation', authorized: false }).success).toBe(false)
    expect(localVoiceCommandSchema.safeParse({ action: 'sample', id: '../../outside.wav' }).success).toBe(false)
    expect(voiceStudioSchema.parse({})).toEqual({ examples: [], samples: [] })
  })
  it('never injects CSM laughter tags and excludes sensitive text from laughter conditioning', () => {
    expect(prepareLocalSpeech('[chuckling] Hello [giggle]', 'sesame-csm')).toBe('Hello')
    expect(prepareLocalSpeech('[soft chuckle] Hello [laugh softly]', 'sesame-csm')).toBe('Hello')
    expect(mayUseLaughterContext("Oh, that's funny!")).toBe(true)
    for (const text of ['The tests passed.', 'A funny joke about grief.', 'Sorry, that was embarrassing.']) expect(mayUseLaughterContext(text)).toBe(false)
  })
  it('requires actual listener approval of the exact laughter example before live use', () => {
    const id = crypto.randomUUID(), studio: VoiceStudio = { examples: [{ id, profileId: 'voice', name: 'Gentle laugh', text: 'That is funny.', kind: 'laughter', enabled: true, authorized: true, createdAt: new Date().toISOString() }], samples: [] }
    expect(selectVoiceExample(studio, 'voice', 'That is funny.', true, false)).toBeUndefined()
    expect(selectVoiceExample(studio, 'voice', 'That is funny.', true, true)?.id).toBe(id)
    studio.samples.push({ id: crypto.randomUUID(), profileId: 'voice', conditioningExampleId: id, text: 'Funny.', personality: 'Warm', expressiveness: .65, createdAt: new Date().toISOString(), rating: 4, laughterHeard: true, metrics: { loadMs: 0, firstAudioMs: 1, generationMs: 2, audioSeconds: 1, realtimeFactor: 1, peakMetalBytes: 1, peakProcessBytes: 1, chunks: 1, measuredAt: new Date().toISOString() } })
    expect(selectVoiceExample(studio, 'voice', 'That is funny.', true, false)?.id).toBe(id)
    expect(selectVoiceExample(studio, 'voice', 'Sorry, that was funny.', true, false)).toBeUndefined()
    expect(selectVoiceExample(studio, 'other', 'That is funny.', true, false)).toBeUndefined()
    expect(selectVoiceExample(studio, 'voice', 'That is funny.', false, false)).toBeUndefined()
  })
})
