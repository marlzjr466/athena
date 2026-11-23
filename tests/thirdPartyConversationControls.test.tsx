import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { emptyAIStatus, type AIStatus } from '../shared/ai'
import { emptyChatSnapshot } from '../shared/chat'
import { useChat } from '../src/store/chatStore'

const api = vi.hoisted(() => ({ chatSession: vi.fn() }))
vi.mock('../src/services/desktop', () => ({ desktop: api }))
import { ConversationControls } from '../src/features/chat/ConversationControls'

const sessionId = '11111111-1111-4111-8111-111111111111'
const status: AIStatus = { ...emptyAIStatus(), provider: 'Third-Party Inference', inferenceProfile: true, active: true, model: 'gateway-reasoning', models: ['gateway-reasoning', 'gateway-plain'], modelEfforts: { 'gateway-reasoning': ['auto','none','minimal','high'] }, modelEffortDefaults: { 'gateway-reasoning': 'minimal' } }

beforeEach(() => {
  vi.clearAllMocks()
  api.chatSession.mockResolvedValue({ ok: true })
  useChat.setState({ snapshot: { ...emptyChatSnapshot(), phase: 'idle', sessionId, config: { provider: 'OpenAI', model: 'gateway-reasoning', effort: 'auto' } }, pending: false, issue: null })
})

it('shows only configured third-party reasoning levels and hides the selector for a plain model', async () => {
  render(<ConversationControls config={status} />)
  const effort=screen.getByRole('combobox',{name:'Reasoning effort'})
  expect(effort).toHaveTextContent('Auto · Minimal configured default')
  fireEvent.click(effort)
  expect(screen.getByRole('option',{name:'None'})).toBeInTheDocument()
  expect(screen.getByRole('option',{name:'Minimal'})).toBeInTheDocument()
  expect(screen.queryByRole('option',{name:'Low'})).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('option',{name:'High'}))
  await waitFor(()=>expect(api.chatSession).toHaveBeenCalledWith({action:'configure-effort',id:sessionId,effort:'high'}))
  act(()=>useChat.setState({ snapshot: { ...useChat.getState().snapshot, config: { provider:'OpenAI',model:'gateway-plain',effort:'auto' } } }))
  expect(screen.queryByRole('combobox',{name:'Reasoning effort'})).not.toBeInTheDocument()
})
