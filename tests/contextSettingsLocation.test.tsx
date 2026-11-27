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
const api = vi.hoisted(() => ({ chatSession: vi.fn(), chatContext: vi.fn(), getLocalStatus: vi.fn(), getPermissions: vi.fn(), setFilesystemAccess: vi.fn() }))
vi.mock('../src/services/desktop', () => ({ desktop: api }))
const id = '11111111-1111-4111-8111-111111111111'
beforeEach(() => {
  vi.clearAllMocks(); api.chatSession.mockResolvedValue({ ok: true })
  api.chatContext.mockResolvedValue({ ok: true, root: '/authorized/project' })
  api.getLocalStatus.mockResolvedValue({ connected: true, models: [{ name: 'gpt-oss:20b' }] })
  api.getPermissions.mockResolvedValue({ filesystemAccess: { mode: 'project-only', active: false, provider: null } })
  api.setFilesystemAccess.mockResolvedValue({ ok: true })
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
  it('offers Full Access with a warning, requires confirmation once, and labels the active mode', async () => {
    useChat.setState({ snapshot: { ...useChat.getState().snapshot, workspaces: [{ id, name: 'Project', authorized: true }] } })
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true)
    const view = render(<ConversationControls config={{ ...emptyAIStatus(), active: true, model: 'gpt-5.6-luna', models: ['gpt-5.6-luna'] }} />)
    fireEvent.click(screen.getByRole('combobox', { name: 'Coding agent permissions' }))
    expect(screen.getByRole('option', { name: 'Full Access' })).toHaveAttribute('title', 'Full Access\nAutomatically allow permission-controlled operations without asking for confirmation.')
    fireEvent.click(screen.getByRole('option', { name: 'Full Access' }))
    expect(api.chatSession).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Coding agent permissions' })).not.toBeDisabled())
    fireEvent.click(screen.getByRole('combobox', { name: 'Coding agent permissions' }))
    fireEvent.click(screen.getByRole('option', { name: 'Full Access' }))
    await waitFor(() => expect(api.chatSession).toHaveBeenCalledWith({ action: 'agent-mode', id, mode: 'full-access', confirmed: true }))
    expect(confirm).toHaveBeenCalledTimes(2)
    useChat.setState({ snapshot: { ...useChat.getState().snapshot, config: { ...useChat.getState().snapshot.config!, agentMode: 'full-access', fullAccessWorkspaceId: id } } })
    view.rerender(<ConversationControls config={{ ...emptyAIStatus(), active: true, model: 'gpt-5.6-luna', models: ['gpt-5.6-luna'] }} />)
    expect(screen.getByRole('combobox', { name: 'Coding agent permissions' })).toHaveAttribute('title', 'Full Access\nAutomatically allow permission-controlled operations without asking for confirmation.')
    expect(screen.getByRole('combobox', { name: 'Coding agent permissions' }).closest('.full-access-active')).not.toBeNull()
    confirm.mockRestore()
  })
  it('switches an active Full Mac grant to Project Only before enabling conversation Full Access', async () => {
    api.getPermissions.mockResolvedValue({ filesystemAccess: { mode: 'full-read-write', active: true, provider: 'cursor' } })
    useChat.setState({ snapshot: { ...useChat.getState().snapshot, workspaces: [{ id, name: 'Project', authorized: true }] } })
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<ConversationControls config={{ ...emptyAIStatus(), active: true, model: 'gpt-5.6-luna', models: ['gpt-5.6-luna'] }} />)
    fireEvent.click(screen.getByRole('combobox', { name: 'Coding agent permissions' }))
    fireEvent.click(screen.getByRole('option', { name: 'Full Access' }))
    await waitFor(() => expect(api.chatSession).toHaveBeenCalledWith({ action: 'agent-mode', id, mode: 'full-access', confirmed: true }))
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('switch the current provider from Full Mac Access to Project Only'))
    expect(api.setFilesystemAccess).toHaveBeenCalledWith({ mode: 'project-only' })
    expect(api.setFilesystemAccess.mock.invocationCallOrder[0]).toBeLessThan(api.chatSession.mock.invocationCallOrder[0])
    confirm.mockRestore()
  })
  it('keeps the existing mode when Project Only cannot be activated', async () => {
    api.getPermissions.mockResolvedValue({ filesystemAccess: { mode: 'full-read-write', active: true, provider: 'cursor' } })
    api.setFilesystemAccess.mockResolvedValue({ ok: false, message: 'Scope change failed.' })
    useChat.setState({ snapshot: { ...useChat.getState().snapshot, workspaces: [{ id, name: 'Project', authorized: true }] } })
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<ConversationControls config={{ ...emptyAIStatus(), active: true, model: 'gpt-5.6-luna', models: ['gpt-5.6-luna'] }} />)
    fireEvent.click(screen.getByRole('combobox', { name: 'Coding agent permissions' }))
    fireEvent.click(screen.getByRole('option', { name: 'Full Access' }))
    await waitFor(() => expect(useChat.getState().issue).toBe('Scope change failed.'))
    expect(api.chatSession).not.toHaveBeenCalled()
    expect(screen.getByRole('combobox', { name: 'Coding agent permissions' })).toHaveTextContent('Ask Before Changes')
    confirm.mockRestore()
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
    expect(screen.getByText(/Applies across providers in “Project planning”/)).toBeInTheDocument()
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

it('shows matching request measurements after restore and clears them when the model switches', () => {
  const chat = useChat.getState().snapshot
  const model = 'gpt-6.2-astra'
  const route = { provider: 'subscription' as const, accountId: 'fixture' }
  const config = { ...chat.config!, model, accountRoute: route }
  const execution = { status:'complete' as const, startedAt:1, updatedAt:2, activities:[], promptBudget:{
    routeKey: JSON.stringify([route.provider,route.accountId,model]), effective:272000, documented:1050000, prompt:2400,
    output:4096, safeInput:227104, system:800, developer:700, project:300, tools:200, history:400, registered:51, loaded:3, reason:'Account model catalog',
  }}
  useChat.setState({snapshot:{...chat,config,messages:[{id:'fixture',role:'assistant',content:'Done',status:'complete',createdAt:1,execution}]}})
  const catalog={refreshedAt:1,accounts:[{route,name:'Fixture',enabled:true,state:'connected' as const,models:[{id:model,label:model,available:true,contextLimits:{source:'reported' as const,contextWindow:272000}}]}]}
  const page=render(<ContextSettings catalog={catalog} provider="subscription" subscriptionMode disabled={false}/>)
  expect(screen.getByText(/Estimated prompt 2,400 tokens/)).toBeInTheDocument()
  expect(screen.getByText('3 tools loaded · 51 registered')).toBeInTheDocument()
  expect(screen.getByText(/Effective window 272,000 · Documented API model window 1,050,000/)).toBeInTheDocument()
  page.unmount()
  useChat.setState({snapshot:{...useChat.getState().snapshot,config:{...config,model:'gpt-6.2-sol'}}})
  render(<ContextSettings catalog={catalog} provider="subscription" subscriptionMode disabled={false}/>)
  expect(screen.queryByText(/Estimated prompt 2,400 tokens/)).toBeNull()
})
