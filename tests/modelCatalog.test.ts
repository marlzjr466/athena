import { describe, expect, it } from 'vitest'
import { isAvailableOpenAIAPIGptModel, isSelectableOpenAIAPIGptModel, openAIAPIGptModels } from '../shared/modelCatalog'

describe('OpenAI API GPT model catalog filtering', () => {
  it('includes every live GPT-5.6+ variant and excludes older generations', () => {
    expect(openAIAPIGptModels(['gpt-5', 'gpt-5.5-pro', 'gpt-5.6', 'gpt-5.6-codex', 'gpt-5.6-pro', 'gpt-6', 'gpt-6-mini', 'gpt-6.1-codex-mini']))
      .toEqual(['gpt-6.1-codex-mini', 'gpt-6', 'gpt-6-mini', 'gpt-5.6', 'gpt-5.6-codex', 'gpt-5.6-pro'])
  })

  it('compares major and minor numbers semantically and sorts newest first', () => {
    expect(openAIAPIGptModels(['gpt-6.9', 'gpt-6.10', 'gpt-7.2', 'gpt-6', 'gpt-5.6', 'gpt-5.6.1', 'gpt-5.5.99', 'gpt-6.1.2']))
      .toEqual(['gpt-7.2', 'gpt-6.10', 'gpt-6.9', 'gpt-6.1.2', 'gpt-6', 'gpt-5.6.1', 'gpt-5.6'])
    expect(isSelectableOpenAIAPIGptModel('gpt-5.5.99')).toBe(false)
  })

  it('preserves exact supported suffixes and orders aliases before dated snapshots', () => {
    expect(openAIAPIGptModels(['gpt-6.1-pro-2026-11-21', 'gpt-6.1-codex', 'gpt-6.1-pro', 'gpt-6.1-pro-2026-11-20', 'gpt-6.1']))
      .toEqual(['gpt-6.1', 'gpt-6.1-codex', 'gpt-6.1-pro', 'gpt-6.1-pro-2026-11-21', 'gpt-6.1-pro-2026-11-20'])
  })

  it('excludes non-chat model families, fine tunes, ambiguous versions, and deduplicates IDs', () => {
    const models = ['gpt-6-image', 'gpt-6-realtime', 'gpt-6-audio-preview', 'gpt-6-transcribe', 'gpt-6-embedding', 'gpt-6-moderation', 'gpt-6-search-preview', 'gpt-6-legacy', 'gpt-6-deprecated', 'gpt-6..1', 'ft:gpt-6', 'gpt-image-2', 'gpt-6-codex', 'gpt-6-codex']
    expect(openAIAPIGptModels(models)).toEqual(['gpt-6-codex'])
    expect(isSelectableOpenAIAPIGptModel('gpt-5.6-codex')).toBe(true)
    expect(isSelectableOpenAIAPIGptModel('gpt-5.5-codex')).toBe(false)
    expect(isSelectableOpenAIAPIGptModel('gpt-6-image')).toBe(false)
    expect(isAvailableOpenAIAPIGptModel('gpt-6', ['gpt-6.1-pro'])).toBe(false)
  })

  it('returns an empty list when the authenticated account has no matching models', () => {
    expect(openAIAPIGptModels(['gpt-4.1', 'o4-mini', 'gpt-realtime'])).toEqual([])
  })
})
