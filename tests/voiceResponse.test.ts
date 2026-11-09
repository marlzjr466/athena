import { describe, expect, it } from 'vitest'
import { VoiceSegmentQueue, VoiceSentenceBuffer, voiceReasoningEffort } from '../shared/voiceResponse'

describe('streamed voice responses', () => {
  it('releases completed sentences before the provider finishes and preserves the remainder', () => {
    const buffer = new VoiceSentenceBuffer()
    expect(buffer.push('React is a JavaScript library. It helps')).toEqual(['React is a JavaScript library.'])
    expect(buffer.push(' build interfaces.')).toEqual(['It helps build interfaces.'])
    expect(buffer.flush()).toEqual([])
  })
  it('allows long responses to begin at a natural phrase and omits source appendices', () => {
    const buffer = new VoiceSentenceBuffer()
    expect(buffer.push('I found the current documentation, and here are the important changes to consider; there is a new release')).toEqual(['I found the current documentation,', 'and here are the important changes to consider;'])
    expect(buffer.push('.\n\nSources:\n- https://example.com')).toEqual(['there is a new release.'])
    expect(buffer.flush()).toEqual([])
  })
  it('cancels queued segments without delivering stale speech', async () => {
    const queue = new VoiceSegmentQueue()
    queue.push('First.')
    expect(await queue.take()).toBe('First.')
    const waiting = queue.take()
    queue.cancel()
    expect(await waiting).toBeUndefined()
    queue.push('Stale.')
    expect(await queue.take()).toBeUndefined()
  })
  it('keeps the selected model and picks only supported effort levels', () => {
    expect(voiceReasoningEffort('Hi!', 'gpt-5.6-sol', 'auto', true)).toBe('low')
    expect(voiceReasoningEffort('What is React?', 'gpt-5.6-sol', 'auto', true)).toBe('medium')
    expect(voiceReasoningEffort('Investigate and refactor this app', 'gpt-5.6-sol', 'auto', true)).toBe('high')
    expect(voiceReasoningEffort('Hi!', 'gpt-5.6-sol', 'xhigh', true)).toBe('xhigh')
    expect(voiceReasoningEffort('Hi!', 'gpt-5.6-sol', 'high', false)).toBe('high')
    expect(voiceReasoningEffort('Hi!', 'unverified-model', 'auto', true)).toBe('auto')
  })
})
