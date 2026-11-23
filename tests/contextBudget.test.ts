import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../shared/chat'
import { compactConversationHistoryText, fitConversationHistory } from '../electron/main/ai/contextBudget'

function message(id: string, role: ChatMessage['role'], content: string, index: number): ChatMessage {
  return { id, role, content, status: 'complete', createdAt: index }
}

describe('shared provider conversation context budgeting', () => {
  it('summarizes older turns and retains the latest request verbatim without mutating history', () => {
    const history = Array.from({ length: 30 }, (_, index) => message(`m${index}`, index % 2 ? 'assistant' : 'user',
      index === 0 ? 'MBM-11745 acceptance criteria: preserve the lifecycle path and do not change authorization.' : `Historical turn ${index} ${'detail '.repeat(180)}`, index))
    const latest = message('latest', 'user', 'Review the current lifecycle implementation and report remaining risks.', 31)
    history.push(latest)
    const before = JSON.stringify(history)

    const result = fitConversationHistory(history, 12_000)

    expect(result.compacted).toBe(true)
    expect(result.finalBytes).toBeLessThanOrEqual(12_000)
    expect(result.messages.at(-1)).toEqual(latest)
    expect(result.messages[0].content).toContain('Earlier conversation checkpoint')
    expect(result.messages[0].content).toContain('MBM-11745')
    expect(JSON.stringify(history)).toBe(before)
  })

  it('reports when the current request itself cannot fit instead of truncating it', () => {
    const latest = message('latest', 'user', 'Do not truncate this request. '.repeat(500), 1)
    const result = compactConversationHistoryText([latest], 128)
    expect(result.fits).toBe(false)
    expect(result.text).toContain('Do not truncate this request.')
    expect(result.text.length).toBe(latest.content.length + 'User: '.length)
  })

  it('leaves short history untouched', () => {
    const history = [message('one', 'user', 'Keep this conversation.', 1)]
    expect(fitConversationHistory(history, 1000)).toMatchObject({ messages: history, compacted: false })
  })
})
