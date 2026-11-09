import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyChatSnapshot, type ChatSnapshot } from '../shared/chat'
import { defaultConversationConfig } from '../shared/conversations'
import { defaultSettings } from '../shared/settings'
import type { Snapshot } from '../shared/contracts'
import { useAthena } from '../src/store/athenaStore'
import { useAthenaChat } from '../src/store/athenaChatStore'

const api = vi.hoisted(() => ({ getSlashCommands: vi.fn(), getAthenaChat: vi.fn(), onAthenaChat: vi.fn(), getLocalStatus: vi.fn(), focusAthenaChat: vi.fn(), sendAthenaChat: vi.fn(), athenaChatSession: vi.fn(), athenaChatContext: vi.fn(), searchAthenaChats: vi.fn(), retryAthenaChat: vi.fn(), stopAthenaChat: vi.fn(), clearAthenaChat: vi.fn(), updateSettings: vi.fn(), copyChatText: vi.fn() }))
vi.mock('../src/services/desktop', () => ({ desktop: api, isDesktop: true }))
import { AthenaChat } from '../src/features/athena-ai/AthenaChat'

const sessionId = 'd049d3a2-86e9-45b5-bb91-6c539d04f018'
const secondId = '91fa7798-77c3-4f28-8cd7-74d41bc305cf'
const snapshot = (): ChatSnapshot => ({ ...emptyChatSnapshot(), revision: 1, sessionId, config: { ...defaultConversationConfig(), model: 'coder:3b' }, sessions: [
  { id: sessionId, title: 'Local coding', createdAt: 1, updatedAt: 2, config: { ...defaultConversationConfig(), model: 'coder:3b' } },
  { id: secondId, title: 'Private ideas', createdAt: 1, updatedAt: 1, config: { ...defaultConversationConfig(), model: 'qwen2.5:3b' } },
], attachments: [], workspaces: [] })

beforeEach(() => {
  vi.clearAllMocks()
  useAthenaChat.setState({ snapshot: emptyChatSnapshot(), issue: null, pending: false })
  useAthena.setState({ snapshot: { settings: { ...defaultSettings, aiMode: 'subscription', localAI: { ...defaultSettings.localAI, model: 'qwen2.5:3b' } }, state: 'idle' } as Snapshot, page: 'my-athena-chat' })
  api.getSlashCommands.mockResolvedValue({ commands: [], globalEnabled: false })
  api.getAthenaChat.mockResolvedValue(snapshot())
  api.onAthenaChat.mockReturnValue(() => {})
  api.getLocalStatus.mockResolvedValue({ connected: true, message: 'Ready', models: [
    { name: 'coder:3b', capabilities: ['completion', 'tools'], size: 3_000_000_000, family: 'coder', contextLength: 32768 },
    { name: 'qwen2.5:3b', capabilities: ['completion'], size: 2_000_000_000 },
    { name: 'mlx:athena-coder-v2', label: 'Athena Coder v2', provider: 'mlx', capabilities: ['completion'], size: 1 },
    { name: 'embed:1b', capabilities: ['embedding'], size: 1_000_000_000 },
  ], arch: 'arm64', totalMemoryBytes: 24_000_000_000, freeMemoryBytes: 12_000_000_000, whisperInstalled: false, macSpeechAvailable: false, macVoices: [] })
  api.focusAthenaChat.mockResolvedValue({ ok: true })
  api.sendAthenaChat.mockResolvedValue({ ok: true })
  api.athenaChatSession.mockResolvedValue({ ok: true })
  api.athenaChatContext.mockResolvedValue({ ok: true })
  api.searchAthenaChats.mockResolvedValue([secondId])
  api.updateSettings.mockImplementation(async (patch: Partial<typeof defaultSettings>) => ({ settings: { ...useAthena.getState().snapshot!.settings, ...patch }, state: 'idle' }))
})

describe('private Athena Chat page', () => {
  it('uses its session model without changing the floating model or online provider and manages private history', async () => {
    render(<AthenaChat />)
    expect(await screen.findByRole('combobox', { name: 'Athena Chat model' })).toHaveValue('coder:3b')
    fireEvent.click(screen.getByRole('combobox', { name: 'Athena Chat model' }))
    expect(screen.getByRole('option', { name: 'embed:1b · Ollama · no chat' })).toBeDisabled()
    await waitFor(() => expect(api.focusAthenaChat).toHaveBeenCalledWith({ active: true, sessionId }))
    fireEvent.click(screen.getByRole('option', { name: 'qwen2.5:3b · Ollama' }))
    await waitFor(() => expect(api.athenaChatSession).toHaveBeenCalledWith({ action: 'configure-model', id: sessionId, model: 'qwen2.5:3b' }))
    expect(useAthena.getState().snapshot?.settings.localAI.model).toBe('qwen2.5:3b')
    expect(useAthena.getState().snapshot?.settings.aiMode).toBe('subscription')
    fireEvent.change(screen.getByRole('textbox', { name: 'Search local conversations' }), { target: { value: 'ideas' } })
    expect(await screen.findByText('Private ideas')).toBeInTheDocument()
    await waitFor(() => expect(within(screen.getByRole('complementary', { name: 'Athena Chat sessions' })).queryByText('Local coding')).not.toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'New chat' }))
    expect(api.athenaChatSession).toHaveBeenCalledWith({ action: 'create' })
  })

  it('offers read-only project analysis for an authorized MLX project', async () => {
    const value = snapshot()
    value.config!.model = 'mlx:athena-coder-v2'
    value.workspaces = [{ id: secondId, name: 'Project', authorized: true }]
    api.getAthenaChat.mockResolvedValue(value)
    render(<AthenaChat />)
    const button = await screen.findByRole('button', { name: 'Analyze project' })
    expect(button).toBeEnabled()
    fireEvent.click(button)
    await waitFor(() => expect(api.sendAthenaChat).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('read-only mode') })))
    act(() => useAthenaChat.setState({ snapshot: { ...value, revision: 3, workspaces: [{ id: secondId, name: 'Project', authorized: false }] }, pending: false }))
    expect(screen.getByRole('button', { name: 'Analyze project' })).toBeDisabled()
  })

  it('sends only through local IPC and toggles avatar linking without changing local model', async () => {
    render(<AthenaChat />)
    await screen.findByRole('combobox', { name: 'Athena Chat model' })
    fireEvent.change(screen.getByRole('textbox', { name: 'Message local Athena' }), { target: { value: 'Explain this function' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send local message' }))
    await waitFor(() => expect(api.sendAthenaChat).toHaveBeenCalledWith(expect.objectContaining({ text: 'Explain this function', sessionId })))
    fireEvent.click(screen.getByRole('checkbox', { name: /Link this active chat/ }))
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledWith({ athenaChatAvatarLinked: false }))
    expect(useAthena.getState().snapshot?.settings.localAI.model).toBe('qwen2.5:3b')
  })

  it('persists the latest local draft when leaving the page before debounce completes', async () => {
    const view = render(<AthenaChat />)
    await screen.findByRole('combobox', { name: 'Athena Chat model' })
    fireEvent.change(screen.getByRole('textbox', { name: 'Message local Athena' }), { target: { value: 'Private unfinished thought' } })
    view.unmount()
    expect(api.athenaChatSession).toHaveBeenCalledWith({ action: 'draft', id: sessionId, text: 'Private unfinished thought' })
  })

  it('shares the online conversation layout and toggles the matching sidebar', async () => {
    render(<AthenaChat />)
    await screen.findByRole('combobox', { name: 'Athena Chat model' })
    expect(screen.getByLabelText('Private Athena Chat')).toHaveClass('conversation-workbench')
    expect(screen.getByRole('complementary', { name: 'Athena Chat sessions' })).toHaveClass('conversation-sidebar')
    expect(screen.getByRole('button', { name: 'Toggle local conversation sidebar' })).toHaveAttribute('aria-expanded', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'Toggle local conversation sidebar' }))
    expect(screen.queryByRole('complementary', { name: 'Athena Chat sessions' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Toggle local conversation sidebar' })).toHaveAttribute('aria-expanded', 'false')
  })

  it('renders streaming local content, source evidence and real tool records', async () => {
    render(<AthenaChat />)
    await screen.findByRole('combobox', { name: 'Athena Chat model' })
    act(() => useAthenaChat.setState({ snapshot: { ...snapshot(), revision: 3, phase: 'thinking', messages: [{ id: secondId, role: 'assistant', content: 'Local answer with `code`.', status: 'streaming', createdAt: 100, sources: [{ workspace: 'Project', path: 'src/main.ts', start: 1, end: 3 }], execution: { startedAt: 100, updatedAt: 101, status: 'working', activities: [{ id: sessionId, tool: 'read_file', label: 'Read file · src/main.ts', startedAt: 100, finishedAt: 101, status: 'complete', summary: 'Read actual file.' }], timeline: [{ id: secondId, kind: 'activity', activityId: sessionId, createdAt: 100 }] } }] } }))
    expect(screen.getByText(/Local answer with/)).toBeInTheDocument()
    fireEvent.click(screen.getByText('1 operation'))
    fireEvent.click(screen.getByText('src/main.ts · complete'))
    expect(screen.getByText('Read actual file.')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Source Evidence · 1'))
    expect(screen.getByText('Project/src/main.ts:1–3')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Stop local response' })).toBeInTheDocument()
  })

  it('uses online-style conversation options for local rename and delete without touching online history', async () => {
    render(<AthenaChat />)
    await screen.findByRole('combobox', { name: 'Athena Chat model' })
    fireEvent.click(screen.getByRole('button', { name: 'Options for Local coding' }))
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Conversation options' })).getByRole('button', { name: 'Rename' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Conversation title' }), { target: { value: 'Renamed locally' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.athenaChatSession).toHaveBeenCalledWith({ action: 'rename', id: sessionId, title: 'Renamed locally' }))
    fireEvent.click(screen.getByRole('button', { name: 'Options for Private ideas' }))
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Conversation options' })).getByRole('button', { name: 'Delete' }))
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Delete' })).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(api.athenaChatSession).toHaveBeenCalledWith({ action: 'delete', id: secondId, confirmed: true }))
  })

  it('keeps user copy and edit actions outside the bubble and omits the user timestamp', async () => {
    render(<AthenaChat />)
    await screen.findByRole('combobox', { name: 'Athena Chat model' })
    act(() => useAthenaChat.setState({ snapshot: { ...snapshot(), revision: 2, messages: [{ id: secondId, role: 'user', content: 'A private prompt', status: 'complete', createdAt: 100 }] } }))
    const bubble = screen.getByLabelText('Your local message')
    expect(bubble.querySelector('time')).toBeNull()
    expect(within(bubble).queryByRole('button', { name: 'Copy message' })).not.toBeInTheDocument()
    const actions = bubble.parentElement?.querySelector('.chat-user-actions')
    expect(actions).not.toBeNull()
    expect(within(actions as HTMLElement).getByRole('button', { name: 'Copy message' })).toBeInTheDocument()
    fireEvent.click(within(actions as HTMLElement).getByRole('button', { name: 'Edit message' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Edit message' }), { target: { value: 'Revised private prompt' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save & resend' }))
    await waitFor(() => expect(api.athenaChatSession).toHaveBeenCalledWith({ action: 'edit', id: sessionId, messageId: secondId, text: 'Revised private prompt' }))
  })

  it('does not repeat obsolete generic web and screen notices from saved local history', async () => {
    render(<AthenaChat />)
    await screen.findByRole('combobox', { name: 'Athena Chat model' })
    const legacyNotice = 'Web search is disabled in Settings → AI → Tools & Web Access. Local clock tools remain available. Screen awareness requires a model with verified vision and function-calling support. No screen is captured with this model.'
    act(() => useAthenaChat.setState({ snapshot: { ...snapshot(), revision: 2, contextNotice: legacyNotice, messages: [{ id: secondId, role: 'user', content: 'Hello', status: 'complete', createdAt: 100 }] } }))
    expect(screen.queryByText(/Web search is disabled/)).not.toBeInTheDocument()
    expect(screen.queryByText(/Screen awareness requires/)).not.toBeInTheDocument()
    act(() => useAthenaChat.setState({ snapshot: { ...snapshot(), revision: 3, contextNotice: legacyNotice, messages: [{ id: secondId, role: 'user', content: 'Can you see my screen?', status: 'complete', createdAt: 100 }] } }))
    expect(screen.getByText(/Screen awareness requires/)).toBeInTheDocument()
    expect(screen.queryByText(/Web search is disabled/)).not.toBeInTheDocument()
  })
})

it('shows discovered local commands and sends the selected source using keyboard navigation', async () => {
  const entry = { id: 'project:fixture:spec', name: '/platform-spec', source: 'Claude Project', scope: 'project', execution: 'prompt', description: 'Plan a feature', argumentHint: '[topic]', skillPath: 'skills/platform-spec', sourceFile: '.claude/commands/platform-spec.md', compatibility: 'athena-tools' }
  api.getSlashCommands.mockResolvedValue({ commands: [entry], globalEnabled: false })
  render(<AthenaChat />)
  const input = await screen.findByRole('textbox', { name: 'Message local Athena' })
  await waitFor(() => expect(api.getSlashCommands).toHaveBeenCalledWith({ action: 'list', sessionId, surface: 'local' }))
  fireEvent.change(input, { target: { value: '/platform', selectionStart: 9 } })
  expect(await screen.findByRole('option', { name: /platform-spec/ })).toHaveTextContent('skills/platform-spec')
  fireEvent.keyDown(input, { key: 'ArrowDown' }); fireEvent.keyDown(input, { key: 'Enter' })
  expect(input).toHaveValue('/platform-spec ')
  expect(api.sendAthenaChat).not.toHaveBeenCalled()
  fireEvent.change(input, { target: { value: '/platform-spec fixture' } })
  fireEvent.keyDown(input, { key: 'Enter' })
  await waitFor(() => expect(api.sendAthenaChat).toHaveBeenCalledWith(expect.objectContaining({ text: '/platform-spec fixture', commandId: entry.id })))
})
it('keeps approval buttons usable during a waiting local generation and renders its diff', async () => {
  const value = snapshot()
  value.phase = 'thinking'
  value.messages = [{ id: secondId, role: 'assistant', content: '', status: 'streaming', createdAt: 100, execution: { startedAt: 100, updatedAt: 101, status: 'working', activities: [], approval: { id: sessionId, title: 'Review project changes', description: 'Create utility', changes: [{ id: secondId, path: 'src/add.ts', diff: '+export const add = 1', status: 'proposed' }] } } }]
  api.getAthenaChat.mockResolvedValue(value)
  render(<AthenaChat />)
  const prompt = await screen.findByRole('region', { name: 'Local tool approval' })
  expect(prompt.parentElement).toHaveClass('chat-composer-shell')
  const approve = screen.getByRole('button', { name: 'Allow once' })
  expect(approve).toBeEnabled()
  expect(screen.getByText('+export const add = 1')).toBeInTheDocument()
  fireEvent.click(approve)
  await waitFor(() => expect(api.athenaChatSession).toHaveBeenCalledWith({ action: 'agent-approval', id: sessionId, approvalId: sessionId, allow: true }))
})
