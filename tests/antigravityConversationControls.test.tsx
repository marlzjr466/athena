import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyAIStatus, type AIStatus } from '../shared/ai'
import { emptyChatSnapshot } from '../shared/chat'
import { useChat } from '../src/store/chatStore'

const api = vi.hoisted(() => ({ chatSession: vi.fn() }))
vi.mock('../src/services/desktop', () => ({ desktop: api }))

import { ConversationControls } from '../src/features/chat/ConversationControls'

const sessionId = '11111111-1111-4111-8111-111111111111'
const status: AIStatus = {
  ...emptyAIStatus(), provider: 'Google Antigravity Subscription' as const, active: true,
  model: 'gemini-4-argon', models: ['gemini-4-argon', 'gemini-4-hydrogen'],
  modelLabels: { 'gemini-4-argon': 'Gemini 4 Argon', 'gemini-4-hydrogen': 'Gemini 4 Hydrogen' },
  modelCatalogAvailable: true,
  modelEfforts: { 'gemini-4-argon': ['auto', 'low', 'medium', 'high'] },
  modelEffortDefaults: { 'gemini-4-argon': 'medium' },
}

describe('Antigravity conversation controls', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    api.chatSession.mockResolvedValue({ ok: true })
    useChat.setState({ snapshot: { ...emptyChatSnapshot(), phase: 'idle', sessionId, config: { provider: 'OpenAI', model: 'gpt-6.1-sol', effort: 'auto' } }, pending: false, issue: null })
  })

  it('shows an unavailable saved model instead of presenting Gemini as the active selection', async () => {
    render(<ConversationControls config={status} />)
    expect(screen.getByRole('combobox', { name: 'Conversation model' })).toHaveTextContent('gpt-6.1-sol · unavailable; choose a model')
    expect(screen.queryByRole('combobox', { name: 'Reasoning effort' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('combobox', { name: 'Conversation model' }))
    expect(screen.getByRole('option', { name: /gpt-6.1-sol/ })).toBeDisabled()
    fireEvent.click(screen.getByRole('option', { name: 'Gemini 4 Argon' }))
    await waitFor(() => expect(api.chatSession).toHaveBeenCalledWith({ action: 'configure-model', id: sessionId, model: 'gemini-4-argon' }))

    act(() => useChat.setState({ snapshot: { ...useChat.getState().snapshot, config: { provider: 'OpenAI', model: 'gemini-4-argon', effort: 'auto' } } }))
    expect(screen.getByRole('combobox', { name: 'Conversation model' })).toHaveTextContent('Gemini 4 Argon')
    expect(screen.getByRole('combobox', { name: 'Reasoning effort' })).toHaveTextContent('Auto · Medium runtime default')
    const effort = screen.getByRole('combobox', { name: 'Reasoning effort' })
    fireEvent.mouseEnter(effort.parentElement!)
    expect(screen.getByRole('listbox', { name: 'Reasoning effort options' })).toBeVisible()
    fireEvent.mouseEnter(screen.getByRole('option', { name: 'High' }))
    fireEvent.click(screen.getByRole('option', { name: 'High' }))
    await waitFor(() => expect(api.chatSession).toHaveBeenCalledWith({ action: 'configure-effort', id: sessionId, effort: 'high' }))
  })
})
