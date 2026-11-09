import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ProjectAccessSettings } from '../src/features/settings/ProjectAccessSettings'
import { emptyChatSnapshot } from '../shared/chat'
import { contextDefaults } from '../shared/context'

const mocks = vi.hoisted(() => ({ command: vi.fn(() => Promise.resolve(true)), chatContext: vi.fn(async () => ({ ok: true, root: '/project' })) }))
vi.mock('../src/store/chatStore', () => ({ useChat: () => ({ snapshot: {
  ...emptyChatSnapshot(), sessionId: '00000000-0000-4000-a000-000000000002',
  workspaces: [{ id: '00000000-0000-4000-a000-000000000003', name: 'Project', authorized: true }],
  config: { agentMode: 'ask', contextSettings: { ...contextDefaults(), allowProjectCommands: false } },
}, command: mocks.command, pending: false, issue: null }) }))
vi.mock('../src/services/desktop', () => ({ desktop: { chatContext: mocks.chatContext } }))

describe('project permission settings', () => {
  it('offers all four modes and enables command permission when Advanced Agent is selected', () => {
    render(<ProjectAccessSettings />)
    const select = screen.getByRole('combobox', { name: 'Project access level' })
    fireEvent.click(select)
    expect(screen.getAllByRole('option')).toHaveLength(4)
    fireEvent.click(screen.getByRole('option', { name: 'Advanced Agent' }))
    expect(mocks.command).toHaveBeenCalledWith(expect.objectContaining({ action: 'project-permissions', mode: 'advanced', allowCommands: true }))
  })
})
