import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ConversationSidebar } from '../src/features/chat/ConversationSidebar'
import { AthenaChatSidebar } from '../src/features/athena-ai/AthenaChatSidebar'
import { useChat } from '../src/store/chatStore'
import { useAthenaChat } from '../src/store/athenaChatStore'
import { emptyChatSnapshot } from '../shared/chat'

vi.mock('../src/services/desktop', () => ({ desktop: { searchChats: vi.fn(async () => []) } }))
const project = { id: '00000000-0000-4000-8000-000000000001', name: 'Example project' }
const command = vi.fn(async () => true)
beforeEach(() => {
  command.mockClear()
  useChat.setState({ pending: false, command, snapshot: { ...emptyChatSnapshot(), sessionId: 'one', sessions: [{ id: 'one', title: 'First conversation', createdAt: 1, updatedAt: 1, config: { provider: 'OpenAI', model: null, effort: 'auto' } }] } })
})
describe('session popovers', () => {
  const open = (mode: 'Rename' | 'Delete') => {
    fireEvent.click(screen.getByRole('button', { name: 'Options for First conversation' }))
    fireEvent.click(screen.getByRole('button', { name: mode }))
  }
  it.each(['Rename', 'Delete'] as const)('dismisses %s on outside click without mutation', (mode) => {
    render(<ConversationSidebar />)
    open(mode)
    expect(screen.getByRole('dialog')).toBeVisible()
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(command).not.toHaveBeenCalled()
  })
  it('keeps internal clicks open and supports Escape', () => {
    render(<ConversationSidebar />); open('Rename')
    fireEvent.pointerDown(screen.getByRole('textbox', { name: 'Conversation title' }))
    expect(screen.getByRole('dialog')).toBeVisible()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })
  it('requires explicit confirmation to delete', async () => {
    render(<ConversationSidebar />); open('Delete')
    expect(command).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(command).toHaveBeenCalledWith({ action: 'delete', id: 'one', confirmed: true })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })
  it('saves renamed sessions and closes the popover', async () => {
    render(<ConversationSidebar />); open('Rename')
    fireEvent.change(screen.getByRole('textbox', { name: 'Conversation title' }), { target: { value: 'Renamed' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(command).toHaveBeenCalledWith({ action: 'rename', id: 'one', title: 'Renamed' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })
  it('shows a spinner for a background run, then an unread completion indicator', () => {
    const initial = useChat.getState().snapshot
    useChat.setState({ snapshot: { ...initial, sessionId: 'two', sessions: [
      { id: 'one', title: 'First conversation', createdAt: 1, updatedAt: 1, config: { provider: 'OpenAI', model: null, effort: 'auto' }, executionStatus: 'running' },
      { id: 'two', title: 'Other conversation', createdAt: 2, updatedAt: 2, config: { provider: 'OpenAI', model: null, effort: 'auto' } },
    ] } })
    render(<ConversationSidebar />)
    expect(screen.getByLabelText('Running')).toHaveClass('conversation-running-icon')
    act(() => useChat.setState({ snapshot: { ...useChat.getState().snapshot, sessions: [
      { id: 'one', title: 'First conversation', createdAt: 1, updatedAt: 1, config: { provider: 'OpenAI', model: null, effort: 'auto' }, unreadCompletion: 'complete' },
      { id: 'two', title: 'Other conversation', createdAt: 2, updatedAt: 2, config: { provider: 'OpenAI', model: null, effort: 'auto' } },
    ] } }))
    expect(screen.getByLabelText('Completed task unread')).toBeInTheDocument()
    expect(screen.queryByLabelText('Running')).toBeNull()
  })
})

it('collapses project sessions independently while preserving project actions and active selection', () => {
  const initial = useChat.getState().snapshot
  useChat.setState({ snapshot: { ...initial, sessions: [
    { id: 'one', title: 'First conversation', createdAt: 1, updatedAt: 1, config: { provider: 'OpenAI', model: null, effort: 'auto' }, project },
    { id: 'two', title: 'Second conversation', createdAt: 2, updatedAt: 2, config: { provider: 'OpenAI', model: null, effort: 'auto' }, project },
  ] } })
  render(<ConversationSidebar />)
  const group = screen.getByRole('button', { name: /Example project/ , expanded: true })
  expect(group).toHaveAttribute('aria-expanded', 'true')
  fireEvent.click(group)
  expect(group).toHaveAttribute('aria-expanded', 'false')
  expect(screen.getByRole('button', { name: 'New chat in Example project' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Options for project Example project' })).toBeInTheDocument()
  expect(window.localStorage.getItem('athena.conversation-projects.online.v1')).toContain(project.id)
  fireEvent.click(screen.getByRole('button', { name: 'New chat in Example project' }))
  expect(command).toHaveBeenCalledWith({ action: 'create', workspaceId: project.id })
  expect(group).toHaveAttribute('aria-expanded', 'false')
})

it('portals project session menus outside the scroll list and preserves the selected session action target', async () => {
  window.localStorage.removeItem('athena.conversation-projects.online.v1')
  const initial = useChat.getState().snapshot
  useChat.setState({ snapshot: { ...initial, sessionId: 'one', sessions: [
    { id: 'one', title: 'First conversation', createdAt: 1, updatedAt: 1, config: { provider: 'OpenAI', model: null, effort: 'auto' }, project },
    { id: 'two', title: 'Second conversation', createdAt: 2, updatedAt: 2, config: { provider: 'OpenAI', model: null, effort: 'auto' }, project },
  ] } })
  render(<ConversationSidebar />)
  fireEvent.click(screen.getByRole('button', { name: 'Options for Second conversation' }))
  const menu = screen.getByRole('dialog', { name: 'Conversation options' })
  expect(menu.parentElement).toBe(document.body)
  expect(command).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Rename' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Conversation title' }), { target: { value: 'Second renamed' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  await waitFor(() => expect(command).toHaveBeenCalledWith({ action: 'rename', id: 'two', title: 'Second renamed' }))
})

it('uses the same portal positioning for Athena local project sessions', async () => {
  window.localStorage.removeItem('athena.conversation-projects.local.v1')
  useAthenaChat.setState({ pending: false, snapshot: { ...emptyChatSnapshot(), sessionId: 'local-one', sessions: [
    { id: 'local-one', title: 'Local conversation', createdAt: 1, updatedAt: 1, config: { provider: 'OpenAI', model: null, effort: 'auto' }, project },
  ] } })
  render(<AthenaChatSidebar linked={false} onLink={() => undefined} onManageModels={() => undefined} />)
  fireEvent.click(screen.getByRole('button', { name: 'Options for Local conversation' }))
  const menu = screen.getByRole('dialog', { name: 'Conversation options' })
  expect(menu.parentElement).toBe(document.body)
  fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
  expect(screen.getByRole('dialog', { name: 'Delete' })).toBeInTheDocument()
  expect(command).not.toHaveBeenCalled()
})
