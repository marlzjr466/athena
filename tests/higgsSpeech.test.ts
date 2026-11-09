import { describe, expect, it } from 'vitest'
import { applyHiggsDelivery, stripHiggsTokens } from '../shared/higgsSpeech'
import { defaultHiggsSettings, higgsSettingsSchema, HIGGS_SUPPORTED_TOKENS } from '../shared/higgsTTS'
import { defaultSettings, mergeSettings, restoreSettings } from '../shared/settings'
import { prepareLocalSpeech } from '../shared/localVoice'

const settings = defaultHiggsSettings

describe('Higgs expressive delivery', () => {
  it('uses all 43 documented controls and rejects unsupported values even in stale tokenizer metadata', () => {
    expect(Object.values(HIGGS_SUPPORTED_TOKENS).flat()).toHaveLength(43)
    for (const [category, values] of Object.entries(HIGGS_SUPPORTED_TOKENS)) {
      for (const value of values) {
        const tag = `<|${category}:${value}|>`
        expect(applyHiggsDelivery({ speechText: `${tag}Hello`, settings }).spoken).toContain(tag)
      }
    }
    const spoken = applyHiggsDelivery({
      speechText: '<|style:conversational|><|emotion:happy|><|sfx:chuckle|><|unknown:thing|>Hello', settings,
      supported: { emotion: ['happy'], style: ['conversational'], prosody: [], sfx: ['chuckle'] },
    })
    expect(spoken.spoken).toBe('Hello')
    expect(applyHiggsDelivery({ speechText: 'Hello.', settings }).spoken).toBe('Hello.')
  })
  it('migrates the old Higgs style without changing the selected engine, reference or other engines', () => {
    const saved = structuredClone(defaultSettings)
    saved.localVoice.engine = 'higgs-tts-3-4b'
    const restored = restoreSettings({ ...saved, localVoice: { ...saved.localVoice, higgs: { ...saved.localVoice.higgs, style: 'conversational', device: 'cpu' } } })
    expect(restored.localVoice.higgs.style).toBe('auto')
    expect(restored.localVoice.higgs.device).toBe('cpu')
    expect(restored.localVoice.engine).toBe('higgs-tts-3-4b')
    expect(restored.localVoice.officialCSM).toEqual(saved.localVoice.officialCSM)
    expect(restored.localVoice.style).toEqual(saved.localVoice.style)
    expect(higgsSettingsSchema.safeParse({ style: 'podcast' }).success).toBe(false)
  })
  it('places supported styles before each sentence and attaches sound-effect vocalizations', () => {
    expect(applyHiggsDelivery({ speechText: 'Hello. Come closer.', settings: { ...settings, style: 'whispering' } }).spoken)
      .toBe('<|style:whispering|>Hello. <|style:whispering|>Come closer.')
    expect(applyHiggsDelivery({ speechText: '<|sfx:laughter|> Hehe, welcome.', settings }).spoken)
      .toBe('<|sfx:laughter|>Hehe, welcome.')
  })
  it('keeps chat text separate from spoken control tokens', () => {
    const spoken = applyHiggsDelivery({ speechText: "Oh, really? That's actually pretty funny!", userText: "Athena, you're funny.", kind: 'chat', settings })
    expect(spoken.spoken).toContain('<|emotion:amusement|>')
    expect(spoken.spoken).toContain('<|sfx:laughter|>')
    expect(spoken.spoken).toMatch(/Hehe/)
    expect(stripHiggsTokens(spoken.spoken)).not.toContain('<|')
  })
  it('does not laugh on technical requests', () => {
    const spoken = applyHiggsDelivery({
      speechText: 'The TypeScript error is coming from a missing return type on this function.',
      userText: 'Hey Athena, can you fix this TypeScript issue?',
      kind: 'chat',
      settings,
    })
    expect(spoken.spoken).not.toContain('<|sfx:laughter|>')
  })
  it('tags excitement, contemplation pauses, and wake text without laughter', () => {
    expect(applyHiggsDelivery({ speechText: "Oh wow! That's awesome!", kind: 'chat', settings }).spoken).toContain('<|emotion:enthusiasm|>')
    expect(applyHiggsDelivery({ speechText: "Let me think about that. Okay, here's what I found.", kind: 'chat', settings }).spoken).toContain('<|prosody:pause|>')
    expect(applyHiggsDelivery({ speechText: "I'm listening.", kind: 'wake', settings }).spoken).not.toContain('<|sfx:laughter|>')
  })
  it('preserves Higgs independently of Chatterbox and Sesame settings', () => {
    const saved = mergeSettings(defaultSettings, { localVoice: { ...defaultSettings.localVoice, engine: 'higgs-tts-3-4b', higgs: { ...defaultSettings.localVoice.higgs, device: 'cpu', laughterFrequency: 'rare' } } })
    const restored = restoreSettings(JSON.parse(JSON.stringify(saved)))
    expect(restored.localVoice.engine).toBe('higgs-tts-3-4b')
    expect(restored.localVoice.profileId).toBe('athena-youthful')
    expect(restored.localVoice.higgs.laughterFrequency).toBe('rare')
    expect(restored.localVoice.officialCSM.device).toBe('cpu')
    expect(prepareLocalSpeech('[chuckle] Hello', 'higgs-tts-3-4b')).toBe('Hello')
  })
})
