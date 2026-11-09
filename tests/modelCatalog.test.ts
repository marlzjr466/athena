import { describe, expect, it } from 'vitest'
import { latestConversationModels } from '../shared/modelCatalog'

describe('latest conversation model catalog', () => {
  it('keeps the newest generation per tier and the explicitly retained GPT-5.6 family', () => {
    expect(latestConversationModels(['gpt-4.1', 'gpt-5.6-luna', 'gpt-6-sol', 'gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-luna'])).toEqual(['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-luna', 'gpt-5.6-luna'])
  })
  it('prefers aliases, otherwise the newest snapshot, without duplicates', () => {
    expect(latestConversationModels(['gpt-5.2', 'gpt-5.2', 'gpt-5.2-2025-12-11', 'gpt-5.2-pro-2025-12-11', 'gpt-5.2-pro-2026-01-01'])).toEqual(['gpt-5.2', 'gpt-5.2-pro-2026-01-01'])
  })
  it('excludes specialized, chat-only, fine-tuned and non-conversational models', () => {
    expect(latestConversationModels(['gpt-image-2', 'gpt-5.2-chat-latest', 'gpt-realtime', 'text-embedding-3-small', 'gpt-5.3-codex', 'ft:gpt-5', 'gpt-5.2'])).toEqual(['gpt-5.2'])
    expect(latestConversationModels([])).toEqual([])
  })
  it('works with older account catalogs and future version numbers', () => {
    expect(latestConversationModels(['gpt-5', 'gpt-5.1', 'gpt-5.2', 'gpt-5-mini'])).toEqual(['gpt-5.2', 'gpt-5-mini'])
    expect(latestConversationModels(['gpt-7.9', 'gpt-7.10'])).toEqual(['gpt-7.10'])
  })
})
