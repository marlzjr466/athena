import { beforeEach, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { emptyAIStatus } from '../shared/ai'
import { emptyChatSnapshot } from '../shared/chat'
import { useChat } from '../src/store/chatStore'

vi.mock('../src/services/desktop', () => ({ desktop: { chatSession: vi.fn(async () => ({ ok: true })) } }))
import { ConversationControls } from '../src/features/chat/ConversationControls'

const id = '11111111-1111-4111-8111-111111111111'
beforeEach(() => useChat.setState({ snapshot: { ...emptyChatSnapshot(), sessionId: id, config: { provider: 'OpenAI', model: 'gpt-4.1', effort: 'high' } }, pending: false, issue: null }))

it('keeps a hidden saved API model visible as unavailable and requires explicit GPT-5.6+ selection', () => {
  render(<ConversationControls config={{ ...emptyAIStatus(), provider: 'OpenAI', active: true, model: 'gpt-6.1-pro', models: ['gpt-5.6-codex', 'gpt-6.1-pro'] }} />)
  expect(screen.getByLabelText('Conversation model')).toHaveTextContent('gpt-4.1 · unavailable; choose a model')
  fireEvent.click(screen.getByLabelText('Conversation model'))
  expect(screen.getByRole('option', { name: 'gpt-4.1 · unavailable; choose a model' })).toBeDisabled()
  expect(screen.getByRole('option', { name: 'gpt-6.1-pro' })).toBeInTheDocument()
  expect(screen.queryByRole('combobox', { name: 'Reasoning effort' })).not.toBeInTheDocument()
})

it('preserves reasoning effort controls for eligible models', () => {
  useChat.setState({ snapshot: { ...useChat.getState().snapshot, config: { provider: 'OpenAI', model: 'gpt-5.6-sol', effort: 'high' } } })
  render(<ConversationControls config={{ ...emptyAIStatus(), provider: 'OpenAI', active: true, model: 'gpt-5.6-sol', models: ['gpt-5.6-sol'] }} />)
  expect(screen.getByLabelText('Reasoning effort')).toHaveTextContent('High')
})

it('keeps a saved GPT-6 model unavailable when a live refresh removes it', () => {
  useChat.setState({ snapshot: { ...useChat.getState().snapshot, config: { provider: 'OpenAI', model: 'gpt-6', effort: 'high' } } })
  render(<ConversationControls config={{ ...emptyAIStatus(), provider: 'OpenAI', active: true, model: 'gpt-6.1-pro', models: ['gpt-6.1-pro'] }} />)
  expect(screen.getByLabelText('Conversation model')).toHaveTextContent('gpt-6 · unavailable; choose a model')
  expect(screen.queryByLabelText('Reasoning effort')).not.toBeInTheDocument()
})
