import { describe, expect, it } from 'vitest'
import { knownReasoningEfforts, resolveReasoningEfforts } from '../shared/modelCapabilities'

describe('shared reasoning capability resolution', () => {
  it('uses documented OpenAI API levels while preserving subscription metadata', () => {
    expect(knownReasoningEfforts('cloud', 'gpt-5.6-sol')).toEqual(['auto', 'none', 'low', 'medium', 'high', 'xhigh', 'max'])
    expect(knownReasoningEfforts('cloud', 'gpt-6-astra')).toEqual(['auto', 'low', 'medium', 'high', 'xhigh', 'max'])
    expect(knownReasoningEfforts('cloud', 'gpt-6.1-terra')).toEqual(['auto', 'none', 'low', 'medium', 'high', 'xhigh', 'max'])
    expect(knownReasoningEfforts('cloud', 'gpt-6.2-sol')).toEqual(['auto', 'low', 'medium', 'high', 'xhigh', 'max'])
    expect(knownReasoningEfforts('cloud', 'gpt-5.6-codex')).toBeUndefined()
    expect(knownReasoningEfforts('subscription', 'gpt-5.2-pro')).toEqual(['auto', 'medium', 'high', 'xhigh'])
  })

  it('uses trusted Claude family metadata if an account catalog omits effort metadata', () => {
    expect(resolveReasoningEfforts('claude-api', 'claude-opus-4-6', undefined)).toEqual(['auto', 'low', 'medium', 'high', 'max'])
    expect(resolveReasoningEfforts('claude-api', 'claude-opus-5-5', undefined)).toEqual(['auto', 'low', 'medium', 'high', 'xhigh', 'max'])
  })

  it('keeps explicit unsupported metadata distinct from missing metadata', () => {
    expect(resolveReasoningEfforts('claude-api', 'claude-opus-4-6', [])).toEqual([])
    expect(resolveReasoningEfforts('custom-gateway', 'unknown-model')).toBeUndefined()
  })
})
