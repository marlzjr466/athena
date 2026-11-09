import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatView } from '../src/features/chat/ChatView'
import { useChat } from '../src/store/chatStore'
import { useAthena } from '../src/store/athenaStore'
import { emptyChatSnapshot } from '../shared/chat'
import { defaultSettings } from '../shared/settings'
import type { Snapshot } from '../shared/contracts'

const sessionId = '00000000-0000-4000-a000-000000000002'
const command = { id: 'project:one:claude-command:.claude/commands/platform-spec.md', name: '/platform-spec', description: 'Generate a platform specification', source: 'Claude Project' as const, sourceFile: '.claude/commands/platform-spec.md', scope: 'project' as const, execution: 'prompt' as const }
const mocks = vi.hoisted(() => ({
  getChat: vi.fn(), getAIStatus: vi.fn(), getSlashCommands: vi.fn(), sendChat: vi.fn(), chatSession: vi.fn(),
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
  mocks.getChat.mockResolvedValue({ ...emptyChatSnapshot(), sessionId, revision: 1, config: { provider: 'OpenAI', model: 'gpt-5.2', effort: 'auto' }, draft: '', attachments: [], workspaces: [] })
  mocks.getAIStatus.mockResolvedValue({ ok: true, status: { provider: 'OpenAI', active: true, model: 'gpt-5.2', models: ['gpt-5.2'] } })
  mocks.getSlashCommands.mockResolvedValue({ commands: [command], globalEnabled: false })
  mocks.sendChat.mockResolvedValue({ ok: true })
  mocks.chatSession.mockResolvedValue({ ok: true })
  mocks.chatContext.mockResolvedValue({ ok: true })
})

describe('slash command composer', () => {
  it('turns an oversized plain-text paste into a managed attachment without losing it', async () => {
    const text = `Implementation prompt\n${'const answer = 42;\n'.repeat(900)}`
    const attachment = { id: '11111111-1111-4111-8111-111111111111', name: 'Pasted code.ts', kind: 'text', mime: 'text/plain', size: text.length, characters: text.length, origin: 'paste' } as const
    mocks.chatContext.mockImplementation(async (request: { action: string }) => {
      if (request.action === 'import-pasted') {
        useChat.setState((state) => ({ snapshot: { ...state.snapshot, revision: state.snapshot.revision + 1, attachments: [attachment] } }))
      }
      return { ok: true, ...(request.action === 'preview' ? { text } : {}) }
    })
    const view = render(<ChatView />)
    try {
      const input = await screen.findByRole('textbox', { name: 'Message Athena' })
      await waitFor(() => expect(input).not.toBeDisabled())
      fireEvent.paste(input, { clipboardData: { getData: (type: string) => type === 'text/plain' ? text : '' } })
      await waitFor(() => expect(mocks.chatContext).toHaveBeenCalledWith(expect.objectContaining({ action: 'import-pasted', sessionId, text })))
      expect(input).toHaveValue('')
      expect(await screen.findByText('Pasted code.ts')).toBeVisible()
      expect(screen.queryByText(/exceeds the message length limit/)).not.toBeInTheDocument()
    } finally { view.unmount() }
  })
  it('clears the project authorization warning after the folder is reconnected', async () => {
    const workspace = { id: 'project-one', name: 'map-governance-ui', fingerprint: 'project-fingerprint', authorized: false }
    mocks.getChat.mockResolvedValue({ ...emptyChatSnapshot(), sessionId, revision: 1, config: { provider: 'OpenAI', model: 'gpt-5.2', effort: 'auto' }, draft: '', attachments: [], workspaces: [workspace] })
    mocks.getSlashCommands.mockResolvedValueOnce({ commands: [], globalEnabled: false, message: 'Project commands are unavailable until this folder is reauthorized.' })
      .mockResolvedValue({ commands: [command], globalEnabled: false })
    const view = render(<ChatView />)
    try {
      await screen.findByText('Project commands are unavailable until this folder is reauthorized.')
      useChat.setState((state) => ({ snapshot: { ...state.snapshot, workspaces: [{ ...workspace, authorized: true }] } }))
      await waitFor(() => expect(screen.queryByText('Project commands are unavailable until this folder is reauthorized.')).not.toBeInTheDocument())
      expect(mocks.getSlashCommands).toHaveBeenCalledTimes(2)
    } finally { view.unmount() }
  })
  it('pastes rich HTML as editable Markdown at the caret and keeps the original draft', async () => {
    const view = render(<ChatView />)
    try {
      const input = await screen.findByRole('textbox', { name: 'Message Athena' }) as HTMLTextAreaElement
      await waitFor(() => expect(input).not.toBeDisabled())
      fireEvent.change(input, { target: { value: 'Before after' } })
      input.setSelectionRange(7, 7)
      fireEvent.paste(input, { clipboardData: { getData: (type: string) => type === 'text/html' ? '<ul><li>Alpha</li><li><strong>Beta</strong></li></ul>' : 'Alpha Beta' } })
      expect(input.value).toContain('Before - Alpha\n- **Beta**after')
      expect(input.selectionStart).toBe(input.value.indexOf('after'))
      expect(mocks.sendChat).not.toHaveBeenCalled()
    } finally { view.unmount() }
  })
  it('sends a chosen assistant answer directly while preserving an unsent composer draft', async () => {
    mocks.getChat.mockResolvedValue({ ...emptyChatSnapshot(), sessionId, revision: 1, config: { provider: 'OpenAI', model: 'gpt-5.2', effort: 'auto' }, draft: 'Unsent draft', attachments: [], workspaces: [], messages: [{ id: 'choice', role: 'assistant', status: 'complete', content: 'Choose one:\n- React\n- Vue', createdAt: 1 }] })
    const view = render(<ChatView />)
    try {
      const input = await screen.findByRole('textbox', { name: 'Message Athena' })
      await waitFor(() => expect(input).not.toBeDisabled())
      fireEvent.click(screen.getByRole('radio', { name: 'Vue' }))
      fireEvent.click(screen.getByRole('button', { name: 'Send choice' }))
      await waitFor(() => expect(mocks.sendChat).toHaveBeenCalledWith({ text: 'Vue', sessionId, requestId: expect.any(String) }))
      expect(input).toHaveValue('Unsent draft')
    } finally { view.unmount() }
  })
  it('opens immediately, filters, navigates with arrows, selects with Enter and sends exact arguments', async () => {
    const view = render(<ChatView />)
    try {
      const input = await screen.findByRole('textbox', { name: 'Message Athena' })
      await waitFor(() => expect(input).not.toBeDisabled())
      fireEvent.change(input, { target: { value: '/' } })
      const menu = screen.getByRole('listbox', { name: 'Slash command suggestions' })
      expect(within(menu).getByText('/platform-spec')).toBeInTheDocument()
      fireEvent.change(input, { target: { value: '/plat' } })
      expect(within(menu).getByRole('option', { name: /platform-spec/i })).toBeInTheDocument()
      fireEvent.keyDown(input, { key: 'ArrowDown' })
      fireEvent.keyDown(input, { key: 'ArrowUp' })
      fireEvent.keyDown(input, { key: 'Enter' })
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
      expect(screen.getByText('/platform-spec', { selector: '.chat-command-chip' })).toBeInTheDocument()
      fireEvent.change(input, { target: { value: 'MBM-11559 "src/components"' } })
      fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
      await waitFor(() => expect(mocks.sendChat).toHaveBeenCalledWith({ text: '/platform-spec MBM-11559 "src/components"', commandId: command.id, sessionId, requestId: expect.any(String) }))
    } finally { view.unmount() }
  })
  it('supports mouse selection, Tab, Escape, and ordinary slashes without menu capture', async () => {
    const view = render(<ChatView />)
    try {
      const input = await screen.findByRole('textbox', { name: 'Message Athena' })
      await waitFor(() => expect(input).not.toBeDisabled())
      fireEvent.change(input, { target: { value: 'https://example.com/path' } })
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
      fireEvent.change(input, { target: { value: '/' } })
      expect(screen.getByRole('listbox')).toBeInTheDocument()
      fireEvent.keyDown(input, { key: 'Escape' })
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
      fireEvent.change(input, { target: { value: '/plat' } })
      fireEvent.click(screen.getByRole('option', { name: /platform-spec/i }))
      expect(screen.getByText('/platform-spec', { selector: '.chat-command-chip' })).toBeInTheDocument()
      fireEvent.keyDown(input, { key: 'Backspace', target: { selectionStart: 0, selectionEnd: 0 } })
      fireEvent.change(input, { target: { value: '/plat' } })
      fireEvent.keyDown(input, { key: 'Tab' })
      expect(screen.getByText('/platform-spec', { selector: '.chat-command-chip' })).toBeInTheDocument()
    } finally { view.unmount() }
  })
  it('asks for a source when an unselected typed command is ambiguous', async () => {
    mocks.getSlashCommands.mockResolvedValue({ commands: [{ ...command, name: '/review', id: 'claude:review' }, { ...command, name: '/review', id: 'codex:review', source: 'Codex Project' }], globalEnabled: false })
    const view = render(<ChatView />)
    try {
      const input = await screen.findByRole('textbox', { name: 'Message Athena' })
      await waitFor(() => expect(input).not.toBeDisabled())
      await waitFor(() => expect(mocks.getSlashCommands).toHaveBeenCalled())
      fireEvent.change(input, { target: { value: '/review src/components' } })
      fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
      expect(mocks.sendChat).not.toHaveBeenCalled()
      expect(screen.getByText(/Choose which \/review definition/)).toBeVisible()
      expect(screen.getAllByRole('option')).toHaveLength(2)
    } finally { view.unmount() }
  })
  it.each(['/platform-spec MBM-11559 "src/components/shared"', '  /platform-spec MBM-11559 "src/components/shared"'])('recognizes a manually entered or pasted registered command without selecting autocomplete: %s', async (text) => {
    const view = render(<ChatView />)
    try {
      const input = await screen.findByRole('textbox', { name: 'Message Athena' })
      await waitFor(() => expect(input).not.toBeDisabled())
      await waitFor(() => expect(mocks.getSlashCommands).toHaveBeenCalled())
      if (text.startsWith('  /')) fireEvent.paste(input, { clipboardData: { getData: () => text } })
      fireEvent.change(input, { target: { value: text, selectionStart: text.length, selectionEnd: text.length } })
      expect(screen.getByText('/platform-spec', { selector: '.chat-command-chip' })).toBeInTheDocument()
      expect(input).toHaveValue('MBM-11559 "src/components/shared"')
      fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
      await waitFor(() => expect(mocks.sendChat).toHaveBeenCalledWith({ text, commandId: command.id, sessionId, requestId: expect.any(String) }))
    } finally { view.unmount() }
  })
  it('blocks an unknown typed command instead of treating it as a normal AI request', async () => {
    const view = render(<ChatView />)
    try {
      const input = await screen.findByRole('textbox', { name: 'Message Athena' })
      await waitFor(() => expect(input).not.toBeDisabled())
      fireEvent.change(input, { target: { value: '/platform-not-installed MBM-2' } })
      fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
      expect(mocks.sendChat).not.toHaveBeenCalled()
      expect(screen.getByText(/not registered in this conversation/)).toBeVisible()
    } finally { view.unmount() }
  })
  it('recalls only user messages, navigates both directions, highlights recalled commands and restores the draft', async () => {
    const draft = 'My unsent draft'
    const messages = [
      { id: 'u1', role: 'user' as const, content: 'Explain React hooks', status: 'complete' as const, createdAt: 1 },
      { id: 'a1', role: 'assistant' as const, content: 'Use hooks', status: 'complete' as const, createdAt: 2 },
      { id: 'u2', role: 'user' as const, content: '/platform-spec MBM-11559', status: 'complete' as const, createdAt: 3 },
      { id: 'a2', role: 'assistant' as const, content: 'Done', status: 'complete' as const, createdAt: 4 },
      { id: 'u3', role: 'user' as const, content: '/platform-spec MBM-11390', status: 'complete' as const, createdAt: 5 },
      { id: 'transient', role: 'user' as const, content: 'not saved', status: 'streaming' as const, createdAt: 6 },
    ]
    mocks.getChat.mockResolvedValue({ ...emptyChatSnapshot(), sessionId, revision: 1, messages, config: { provider: 'OpenAI', model: 'gpt-5.2', effort: 'auto' }, draft, attachments: [], workspaces: [] })
    const view = render(<ChatView />)
    try {
      const input = await screen.findByRole('textbox', { name: 'Message Athena' }) as HTMLTextAreaElement
      await waitFor(() => expect(input).not.toBeDisabled())
      input.setSelectionRange(0, 0)
      fireEvent.keyDown(input, { key: 'ArrowUp' })
      expect(input).toHaveValue('MBM-11390')
      expect(screen.getByText('/platform-spec', { selector: '.chat-command-chip' })).toBeInTheDocument()
      fireEvent.keyDown(input, { key: 'ArrowUp' })
      expect(input).toHaveValue('MBM-11559')
      fireEvent.keyDown(input, { key: 'ArrowUp' })
      expect(input).toHaveValue('Explain React hooks')
      fireEvent.keyDown(input, { key: 'ArrowDown' })
      expect(input).toHaveValue('MBM-11559')
      fireEvent.keyDown(input, { key: 'ArrowDown' })
      expect(input).toHaveValue('MBM-11390')
      fireEvent.keyDown(input, { key: 'ArrowDown' })
      expect(input).toHaveValue(draft)
      expect(mocks.sendChat).not.toHaveBeenCalled()
    } finally { view.unmount() }
  })
  it('loads older submitted history when navigation reaches the current page boundary', async () => {
    const visible = [
      { id: 'u5', role: 'user' as const, content: 'Previous page boundary', status: 'complete' as const, createdAt: 5 },
      { id: 'u6', role: 'user' as const, content: 'Most recent message', status: 'complete' as const, createdAt: 6 },
    ]
    mocks.getChat.mockResolvedValue({ ...emptyChatSnapshot(), sessionId, revision: 1, messages: visible, hasMore: true, config: { provider: 'OpenAI', model: 'gpt-5.2', effort: 'auto' }, draft: '', attachments: [], workspaces: [] })
    mocks.chatSession.mockImplementation(async (request: any) => {
      if (request.action === 'more') useChat.setState(state => ({ snapshot: { ...state.snapshot, revision: state.snapshot.revision + 1, messages: [{ id: 'u4', role: 'user', content: 'Loaded older message', status: 'complete', createdAt: 4 }, ...visible], hasMore: false } }))
      return { ok: true }
    })
    const view = render(<ChatView />)
    try {
      const input = await screen.findByRole('textbox', { name: 'Message Athena' }) as HTMLTextAreaElement
      await waitFor(() => expect(input).not.toBeDisabled())
      fireEvent.keyDown(input, { key: 'ArrowUp' })
      expect(input).toHaveValue('Most recent message')
      fireEvent.keyDown(input, { key: 'ArrowUp' })
      expect(input).toHaveValue('Previous page boundary')
      fireEvent.keyDown(input, { key: 'ArrowUp' })
      await waitFor(() => expect(input).toHaveValue('Loaded older message'))
      expect(mocks.chatSession).toHaveBeenCalledWith({ action: 'more', id: sessionId })
    } finally { view.unmount() }
  })
})
