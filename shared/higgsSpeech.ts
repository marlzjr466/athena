import { HIGGS_SUPPORTED_TOKENS, type HiggsSettings, type HiggsSupportedTokens } from './higgsTTS'

const TOKEN = /<\|([a-z0-9_-]+):([^|<>]*)\|>/gi
const CHATTERBOX_CUE = /\[(?:(?:soft|light|gentle|natural)\s+)?(?:chuckl\w*|laugh\w*|giggl\w*|sigh\w*|gasp\w*)(?:\s+[^\]]{0,60})?\]/gi
const SENSITIVE = /\b(sorry|death|died|grief|suicid\w*|hurt|pain|trauma|hospital|cancer|emergency|abuse|assault|funeral|depress\w*)\b/i
const FUNNY = /\b(funny|hilarious|haha|hehe|jok(?:e|ing)|kidding|lol|embarrassing|you're funny|youre funny)\b/i
const TECHNICAL = /\b(typescript|javascript|python|error|stack trace|compile|function|interface|exception|undefined|null)\b/i
const EXCITED = /^(oh wow|that's awesome|that is awesome|amazing|great news)\b/i
const THOUGHTFUL = /^(hmm|let me think|that's an interesting question|that is an interesting question)\b/i

export interface HiggsDeliveryInput {
  speechText: string
  userText?: string
  kind?: 'chat' | 'preview' | 'wake' | 'error' | 'action' | 'technical'
  settings: Pick<HiggsSettings, 'laughterFrequency' | 'emotionPreference' | 'style'>
  supported?: HiggsSupportedTokens
}

export interface HiggsDelivery {
  spoken: string
  emotion?: string
  style?: string
  sfx?: string
  paused: boolean
}

function allowed(kind: keyof HiggsSupportedTokens, value: string, supported?: HiggsSupportedTokens): boolean {
  if (!Object.prototype.hasOwnProperty.call(HIGGS_SUPPORTED_TOKENS, kind)) return false
  const documented = HIGGS_SUPPORTED_TOKENS[kind] as readonly string[] | undefined
  if (!documented?.includes(value)) return false
  const live = supported?.[kind]
  return !live?.length || live.includes(value)
}

function token(kind: 'emotion' | 'style' | 'prosody' | 'sfx', value: string, supported?: HiggsSupportedTokens): string {
  return allowed(kind, value, supported) ? `<|${kind}:${value}|>` : ''
}

function clean(text: string): string {
  return text.replace(CHATTERBOX_CUE, '').replace(/\s+/g, ' ').trim()
}

function sentences(text: string): string[] {
  const parts = text.split(/(?<=[.!?])\s+/).map((part) => part.trim()).filter(Boolean)
  return parts.length ? parts : [text]
}

function wantsLaughter(input: HiggsDeliveryInput, spoken: string): boolean {
  if (input.settings.laughterFrequency === 'off') return false
  if (input.kind === 'wake' || input.kind === 'error' || input.kind === 'action' || input.kind === 'technical') return false
  if (SENSITIVE.test(spoken) || SENSITIVE.test(input.userText ?? '')) return false
  if (input.kind !== 'preview' && TECHNICAL.test(spoken) && !FUNNY.test(spoken)) return false
  const amused = FUNNY.test(spoken) || /^(?:ha(?:ha)+|heh)\b/i.test(spoken)
  if (input.settings.laughterFrequency === 'rare') return amused
  return amused || FUNNY.test(input.userText ?? '')
}

function sentenceEmotion(sentence: string, input: HiggsDeliveryInput, spoken: string, laugh: boolean): string | undefined {
  if (input.settings.emotionPreference !== 'auto') return input.settings.emotionPreference
  if (laugh && /funny|hilarious|hehe|haha/i.test(sentence)) return 'amusement'
  if (EXCITED.test(sentence) || EXCITED.test(spoken)) return 'enthusiasm'
  if (THOUGHTFUL.test(sentence) || THOUGHTFUL.test(spoken)) return 'contemplation'
  return undefined
}

/** Builds Higgs control tokens for TTS only. Chat display text stays unchanged. */
export function applyHiggsDelivery(input: HiggsDeliveryInput): HiggsDelivery {
  const source = clean(input.speechText)
  if (!source) return { spoken: source, paused: false }
  const existing = [...source.matchAll(TOKEN)]
  if (existing.length) {
    const spoken = source.replace(TOKEN, (_match, kind: string, value: string) => token(kind as 'emotion' | 'style' | 'prosody' | 'sfx', value, input.supported))
      .replace(/(<\|sfx:[a-z_]+\|>)\s+/g, '$1')
    return { spoken: spoken.replace(/\s+/g, ' ').trim(), paused: /<\|prosody:(?:long_)?pause\|>/.test(spoken) }
  }
  const laugh = wantsLaughter(input, source)
  if (laugh && /^oh, really\?/i.test(source) && allowed('sfx', 'laughter', input.supported)) {
    const prefix = [
      input.settings.style !== 'auto' ? token('style', input.settings.style, input.supported) : '',
      token('emotion', 'amusement', input.supported),
    ].join('')
    const rest = source.replace(/^oh, really\?\s*/i, '')
    return {
      spoken: `${prefix}Oh, really? ${token('sfx', 'laughter', input.supported)}Hehe, ${rest}`.replace(/\s+/g, ' ').trim(),
      emotion: 'amusement',
      sfx: 'laughter',
      paused: false,
    }
  }
  const parts = sentences(source)
  const tagged = parts.map((sentence, index) => {
    const emotion = sentenceEmotion(sentence, input, source, laugh)
    const prefix = [
      input.settings.style !== 'auto' ? token('style', input.settings.style, input.supported) : '',
      emotion ? token('emotion', emotion, input.supported) : '',
    ].join('')
    let body = sentence
    if (laugh && index === 0 && allowed('sfx', 'laughter', input.supported) && !/<\|sfx:laughter\|>/.test(sentence) && !/\bhehe\b/i.test(sentence)) {
      body = `${sentence} ${token('sfx', 'laughter', input.supported)}Hehe.`
    }
    if (/\blet me think\b/i.test(sentence) && parts[index + 1]) {
      return `${prefix}${sentence} ${token('prosody', 'pause', input.supported)}`.trim()
    }
    return `${prefix}${body}`.trim()
  })
  const spoken = tagged.join(' ').replace(/\s+/g, ' ').trim()
  return {
    spoken,
    emotion: spoken.match(/<\|emotion:([a-z0-9_-]+)\|>/i)?.[1],
    style: spoken.match(/<\|style:([a-z0-9_-]+)\|>/i)?.[1],
    sfx: spoken.match(/<\|sfx:([a-z0-9_-]+)\|>/i)?.[1],
    paused: /<\|prosody:pause\|>/.test(spoken),
  }
}

export function stripHiggsTokens(text: string): string {
  return text.replace(TOKEN, '').replace(/\s+/g, ' ').trim()
}
