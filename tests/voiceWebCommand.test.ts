import { describe, expect, it } from 'vitest'
import { parseVoiceWebOpen } from '../src/features/voice/voiceWebCommand'

describe('floating voice browser requests', () => {
  it('recognizes numbered search-result follow-ups without inventing a URL', () => {
    expect(parseVoiceWebOpen('Open the first search result')).toEqual({ kind: 'result', index: 1 })
    expect(parseVoiceWebOpen('Show me the second result')).toEqual({ kind: 'result', index: 2 })
    expect(parseVoiceWebOpen('Open that documentation')).toEqual({ kind: 'result', index: 1 })
    expect(parseVoiceWebOpen('Show me the website you found')).toEqual({ kind: 'result', index: 1 })
  })
  it('maps a few unambiguous official sites and literal URLs to the existing approved desktop action', () => {
    expect(parseVoiceWebOpen('Open GitHub')).toEqual({ kind: 'url', url: 'https://github.com/' })
    expect(parseVoiceWebOpen('Open the official React website')).toEqual({ kind: 'url', url: 'https://react.dev/' })
    expect(parseVoiceWebOpen('Open https://example.com/docs')).toEqual({ kind: 'url', url: 'https://example.com/docs' })
    expect(parseVoiceWebOpen('Open VS Code')).toBeUndefined()
  })
})
