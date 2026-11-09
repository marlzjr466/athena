import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ContextSettings } from '../src/features/settings/ContextSettings'
import { ConversationControls } from '../src/features/chat/ConversationControls'
import { useChat } from '../src/store/chatStore'
import { emptyChatSnapshot } from '../shared/chat'
import { emptyAIStatus } from '../shared/ai'
import { contextDefaults } from '../shared/context'
import { useAthena } from '../src/store/athenaStore'
import { defaultSettings } from '../shared/settings'
import type { Snapshot } from '../shared/contracts'
const api = vi.hoisted(() => ({ chatSession: vi.fn(), chatContext: vi.fn(), getLocalStatus: vi.fn() }))
vi.mock('../src/services/desktop', () => ({ desktop: api }))
const id = '11111111-1111-4111-8111-111111111111'
beforeEach(() => {
  vi.clearAllMocks(); api.chatSession.mockResolvedValue({ ok: true })
  api.chatContext.mockResolvedValue({ ok: true, root: '/authorized/project' })
  api.getLocalStatus.mockResolvedValue({ connected: true, models: [{ name: 'gpt-oss:20b' }] })
  useAthena.setState({ snapshot: { settings: defaultSettings } as Snapshot })
  useChat.setState({ snapshot: { ...emptyChatSnapshot(), sessionId: id, config: { provider: 'OpenAI', model: 'gpt-5.6-luna', effort: 'medium', contextSettings: contextDefaults() }, sessions: [{ id, title: 'Project planning', createdAt: 1, updatedAt: 1, config: { provider: 'OpenAI', model: 'gpt-5.6-luna', effort: 'medium' } }] }, pending: false, issue: null })
})
describe('AI-page context controls', () => {
  it('shows authorized root and permits revocation during execution without changing model settings', async () => {
    useChat.setState({ snapshot: { ...useChat.getState().snapshot, phase: 'thinking', workspaces: [{ id, name: 'Project', authorized: true }] } })
    render(<ContextSettings disabled />)
    expect(await screen.findByText('/authorized/project')).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('Project access level'))
    fireEvent.click(screen.getByRole('option', { name: 'Read Only' }))
    await waitFor(() => expect(api.chatSession).toHaveBeenCalledWith({ action: 'project-permissions', id, mode: 'read-only', allowDeletion: true, allowCommands: true }))
    expect(screen.getByRole('button', { name: 'Save limits' })).toBeDisabled()
  })
  it('removes provider/context from the composer without removing model or effort', () => {
    render(<ConversationControls config={{ ...emptyAIStatus(), active: true, model: 'gpt-5.6-luna', models: ['gpt-5.6-luna'] }} />)
    expect(screen.queryByLabelText('AI provider')).not.toBeInTheDocument()
    expect(screen.queryByText('Context')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Conversation model')).toBeInTheDocument()
    expect(screen.getByLabelText('Reasoning effort')).toBeInTheDocument()
  })
  it('does not discover local models from online conversation controls', () => {
    useAthena.setState({ snapshot: { settings: { ...defaultSettings, aiMode: 'local', localAI: { ...defaultSettings.localAI, model: 'gpt-oss:20b' } } } as Snapshot })
    render(<ConversationControls config={emptyAIStatus()} />)
    expect(screen.getByLabelText('Conversation model')).toBeInTheDocument()
    expect(api.getLocalStatus).not.toHaveBeenCalled()
    expect(screen.getByLabelText('Conversation model')).toBeDisabled()
  })
  it('saves context controls to the active session and identifies it clearly', async () => {
    render(<ContextSettings disabled={false} />)
    expect(screen.getByText(/Applies to “Project planning”/)).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Search results per call'), { target: { value: '15' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save limits' }))
    await waitFor(() => expect(api.chatSession).toHaveBeenCalledWith({ action: 'configure-context', id, settings: { ...contextDefaults(), maxSearchResults: 15 } }))
    expect(await screen.findByText('Context limits saved for this conversation.')).toBeInTheDocument()
  })
  it('disables changes during an active request', () => {
    render(<ContextSettings disabled />)
    expect(screen.getByRole('button', { name: 'Save limits' })).toBeDisabled()
  })
})
