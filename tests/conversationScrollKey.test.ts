import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../shared/chat'
import type { AgentApproval } from '../shared/agent'
import { conversationScrollKey } from '../src/features/chat/conversationScrollKey'

const approval = (id: string): AgentApproval => ({ id, title: `Request ${id}`, description: 'Confirm an isolated command.' })
const message = (request?: AgentApproval, content = 'Still working', updatedAt = 1): ChatMessage => ({
  id: 'assistant-task',
  role: 'assistant',
  content,
  status: 'streaming',
  createdAt: 1,
  execution: {
    startedAt: 1,
    updatedAt,
    status: 'working',
    activities: [],
    approval: request,
  },
})

describe('conversation scroll key', () => {
  it('does not change for approval ID, approval content, or execution timestamp updates', () => {
    expect(conversationScrollKey([message(approval('first'))])).toBe(conversationScrollKey([message(approval('second'), 'Still working', 2)]))
  })

  it('changes when transcript text or visible execution status changes', () => {
    const initial = message(approval('first'))
    const completed: ChatMessage = { ...initial, status: 'complete' }
    expect(conversationScrollKey([initial])).not.toBe(conversationScrollKey([message(undefined, 'New response')]))
    expect(conversationScrollKey([initial])).not.toBe(conversationScrollKey([completed]))
  })
})
