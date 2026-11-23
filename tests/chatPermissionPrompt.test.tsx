import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatView } from '../src/features/chat/ChatView'
import { useChat } from '../src/store/chatStore'
import { useAthena } from '../src/store/athenaStore'
import { emptyChatSnapshot } from '../shared/chat'
import { defaultSettings } from '../shared/settings'
import type { Snapshot } from '../shared/contracts'

const sessionId = '00000000-0000-4000-a000-000000000002'
const approvalId = '11111111-1111-4111-8111-111111111111'
const mocks = vi.hoisted(() => ({
  getChat: vi.fn(), getAIStatus: vi.fn(), getUnifiedAccounts: vi.fn(async () => ({ accounts: [], refreshedAt: Date.now() })), getSlashCommands: vi.fn(), sendChat: vi.fn(), chatSession: vi.fn(),
  chatContext: vi.fn(),
  onChat: vi.fn(() => () => {}), stopAllSpeech: vi.fn(async () => ({ ok: true })),
}))
vi.mock('../src/services/desktop', () => ({ desktop: mocks, isDesktop: true }))
vi.mock('../src/features/chat/ConversationSidebar', () => ({ ConversationSidebar: () => null }))
vi.mock('../src/features/chat/ConversationControls', () => ({ ConversationControls: () => null }))
vi.mock('../src/features/chat/WorkspacePanel', () => ({ WorkspacePanel: () => null }))
vi.mock('../src/features/voice/PushToTalk', () => ({ PushToTalk: () => null }))
vi.mock('../src/features/voice/useSpeechOutput', () => ({ useSpeechOutput: () => ({ status: { phase: 'idle' }, stopSpeaking: () => {}, speakMessage: () => {} }) }))

beforeEach(() => {
  vi.clearAllMocks()
  useChat.setState({ snapshot: emptyChatSnapshot(), pending: false, issue: null })
  useAthena.setState({ snapshot: { settings: defaultSettings, visible: false } as Snapshot })
  mocks.getChat.mockResolvedValue({
    ...emptyChatSnapshot(),
    phase: 'thinking',
    sessionId,
    revision: 1,
    config: { provider: 'OpenAI', model: 'gpt-5.2', effort: 'auto' },
    draft: '',
    attachments: [],
    workspaces: [],
    messages: [
      { id: 'user', role: 'user', content: 'run tests', status: 'complete', createdAt: 1 },
      {
        id: 'assistant',
        role: 'assistant',
        content: 'Need permission',
        status: 'streaming',
        createdAt: 2,
        execution: {
          status: 'working',
          startedAt: 2,
          updatedAt: 2,
          activities: [],
          approval: {
            id: approvalId,
            title: 'Run isolated project command',
            description: 'npm test -- project.test.ts',
            rememberScope: { operation: 'sandbox_check_command', project: '/project', resources: ['/project'] },
          },
        },
      },
    ],
  })
  mocks.getAIStatus.mockResolvedValue({ ok: true, status: { provider: 'OpenAI', active: true, model: 'gpt-5.2', models: ['gpt-5.2'] } })
  mocks.getSlashCommands.mockResolvedValue({ commands: [], globalEnabled: false })
  mocks.sendChat.mockResolvedValue({ ok: true })
  mocks.chatSession.mockResolvedValue({ ok: true })
  mocks.chatContext.mockResolvedValue({ ok: true })
})

describe('conversation permission prompt placement', () => {
  it('blocks another Antigravity send while a saved model is absent from the current catalog', async () => {
    useAthena.setState({ snapshot: { settings: { ...defaultSettings, aiMode: 'antigravity' }, visible: false } as Snapshot })
    mocks.getChat.mockResolvedValue({ ...emptyChatSnapshot(), phase: 'idle', revision: 1, sessionId, config: { provider: 'OpenAI', model: 'gpt-6.1-sol', effort: 'auto' }, messages: [], attachments: [], workspaces: [] })
    mocks.getAIStatus.mockResolvedValue({ ok: true, status: { provider: 'Google Antigravity Subscription', active: true, model: 'gemini-4-argon', models: ['gemini-4-argon'], modelCatalogAvailable: true } })
    render(<ChatView />)
    expect(await screen.findByText(/saved Antigravity model gpt-6\.1-sol is no longer available/)).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Message Athena' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled()
    expect(mocks.sendChat).not.toHaveBeenCalled()
  })
  it('anchors the active conversation prompt above the composer and keeps approval IPC unchanged', async () => {
    render(<ChatView />)
    const prompt = await screen.findByRole('region', { name: 'Approval required' })
    const composer = document.querySelector('.ai-chat-composer')
    expect(prompt.parentElement).toHaveClass('agent-approval-host')
    expect(prompt.parentElement?.parentElement).toHaveClass('chat-composer-shell')
    expect(composer && (prompt.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_FOLLOWING)).toBeTruthy()
    expect(screen.queryByLabelText('Agent activity')?.querySelector('.agent-approval')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Allow once' }))
    await waitFor(() => expect(mocks.chatSession).toHaveBeenCalledWith({ action: 'agent-approval', id: sessionId, approvalId, allow: true }))
    const host = prompt.parentElement
    await waitFor(() => expect(host).toHaveAttribute('hidden'))
    expect(screen.queryByText('Decision recorded. Athena is continuing the task.')).not.toBeInTheDocument()
    expect(screen.getByTestId('permission-prompt-shell')).toBe(prompt)
    expect(host?.style.height).toBe('')
    const current = useChat.getState().snapshot
    act(() => useChat.setState({ snapshot: {
      ...current,
      revision: current.revision + 1,
      phase: 'idle',
      messages: current.messages.map(message => message.execution ? { ...message, status: 'complete', execution: { ...message.execution, approval: undefined } } : message),
    } }))
    await waitFor(() => expect(host).toHaveAttribute('hidden'))
    expect(screen.queryByRole('region', { name: 'Approval required' })).not.toBeInTheDocument()
    expect(composer).toBeTruthy()
  })

  it('keeps the same prompt shell mounted but hidden during the approval gap', async () => {
    const nextId = '22222222-2222-4222-8222-222222222222'
    render(<ChatView />)
    const composer = document.querySelector('.ai-chat-composer')
    const shell = document.querySelector('.chat-composer-shell')
    fireEvent.click(await screen.findByRole('button', { name: 'Allow once' }))
    const promptShell = screen.getByTestId('permission-prompt-shell')
    const host = promptShell.parentElement
    await waitFor(() => expect(host).toHaveAttribute('hidden'))
    expect(screen.queryByText('Decision recorded. Athena is continuing the task.')).not.toBeInTheDocument()
    expect(document.querySelector('.ai-chat-composer')).toBe(composer)
    const snapshot = useChat.getState().snapshot
    act(() => {
      useChat.setState({
        snapshot: {
          ...snapshot,
          revision: snapshot.revision + 1,
          phase: 'thinking',
          messages: snapshot.messages.map((message) => message.execution ? { ...message, execution: { ...message.execution, approval: undefined } } : message),
        },
      })
    })
    expect(screen.getByTestId('permission-prompt-shell')).toBe(promptShell)
    expect(host).toHaveAttribute('hidden')
    act(() => {
      const current = useChat.getState().snapshot
      useChat.setState({
        snapshot: {
          ...current,
          revision: current.revision + 1,
          phase: 'thinking',
          messages: current.messages.map((message) => message.execution ? {
            ...message,
            execution: {
              ...message.execution,
              approval: {
                id: nextId,
                title: 'Next command',
                description: 'ls',
                rememberScope: { operation: 'sandbox_check_command', project: '/project', resources: ['/project'] },
              },
            },
          } : message),
        },
      })
    })
    expect(screen.getByRole('region', { name: 'Approval required' }).parentElement?.parentElement).toBe(shell)
    expect(host).not.toHaveAttribute('hidden')
    expect(screen.getByTestId('permission-prompt-shell')).toBe(promptShell)
    expect(screen.getByText('Next command')).toBeVisible()
    expect(document.querySelector('.ai-chat-composer')).toBe(composer)
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }))
    await waitFor(() => expect(host).toHaveAttribute('hidden'))
    expect(mocks.chatSession).toHaveBeenCalledWith({ action: 'agent-approval', id: sessionId, approvalId: nextId, allow: false })
    const complete = useChat.getState().snapshot
    act(() => useChat.setState({ snapshot: {
      ...complete,
      revision: complete.revision + 1,
      phase: 'idle',
      messages: complete.messages.map(message => message.execution ? { ...message, status: 'complete', execution: { ...message.execution, approval: undefined } } : message),
    } }))
    await waitFor(() => expect(host).toHaveAttribute('hidden'))
    expect(document.querySelector('.ai-chat-composer')).toBe(composer)
  })

  it('does not restart transcript auto-scroll for an approval-only snapshot update', async () => {
    const scrollTo = vi.spyOn(Element.prototype, 'scrollTo')
    const requestFrame = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { callback(0); return 1 })
    render(<ChatView />)
    await screen.findByRole('region', { name: 'Approval required' })
    scrollTo.mockClear()
    const current = useChat.getState().snapshot
    act(() => useChat.setState({ snapshot: {
      ...current,
      revision: current.revision + 1,
      messages: current.messages.map(message => message.execution ? {
        ...message,
        execution: {
          ...message.execution,
          updatedAt: (message.execution.updatedAt ?? 0) + 1,
          approval: { ...message.execution.approval!, id: '22222222-2222-4222-8222-222222222222', title: 'Next command' },
        },
      } : message),
    } }))
    expect(screen.getByText('Next command')).toBeVisible()
    expect(scrollTo).not.toHaveBeenCalled()
    requestFrame.mockRestore()
    scrollTo.mockRestore()
  })

  it('keeps a failed conversation approval visible and retryable', async () => {
    mocks.chatSession.mockResolvedValueOnce({ ok: false, message: 'Permission could not be saved.' })
    render(<ChatView />)
    fireEvent.click(await screen.findByRole('button', { name: 'Allow once' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('This approval could not be completed. You can try again.')
    expect(screen.getByRole('button', { name: 'Allow once' })).toBeEnabled()
    mocks.chatSession.mockResolvedValueOnce({ ok: true })
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }))
    await waitFor(() => expect(document.querySelector('.agent-approval-host')).toHaveAttribute('hidden'))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Allow once' })).not.toBeInTheDocument()
    expect(mocks.chatSession).toHaveBeenLastCalledWith({ action: 'agent-approval', id: sessionId, approvalId, allow: false })
  })
})
