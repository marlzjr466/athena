// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { codexAppServerCapabilities, codexLoginUsesChatGPT, normalizeCodexModel } from '../electron/main/ai/codexCLIService'

describe('official Codex CLI status normalization', () => {
  it('recognizes the documented local login status even when the CLI writes it to stderr', () => {
    expect(codexLoginUsesChatGPT('', 'Logged in using ChatGPT\n')).toBe(true)
    expect(codexLoginUsesChatGPT('Logged in using ChatGPT\n', '')).toBe(true)
    expect(codexLoginUsesChatGPT('', 'Not logged in')).toBe(false)
  })

  it('opts into only the required capability-gated dynamic-tool API without attestation requests', () => {
    expect(codexAppServerCapabilities).toEqual({ experimentalApi: true, requestAttestation: false })
  })

  it('uses provider model metadata for defaults and supported efforts without inventing catalog entries', () => {
    expect(normalizeCodexModel({ id: 'gpt-6-luna', displayName: 'GPT-6 Luna', isDefault: true,
      supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'medium' }, { reasoningEffort: 'high' }, { reasoningEffort: 'xhigh' }], defaultReasoningEffort: 'medium' })).toEqual({
      id: 'gpt-6-luna', displayName: 'GPT-6 Luna', isDefault: true, efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'medium',
    })
    expect(normalizeCodexModel({ id: 'unsupported model', displayName: 'Unsupported' })).toBeNull()
    expect(normalizeCodexModel({ id: 'gpt-hidden', hidden: true })).toBeNull()
  })
})
