import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { GitBranchSelector } from '../src/features/chat/GitBranchSelector'
import type { ProjectGitCommand, ProjectGitEvent, ProjectGitState } from '../shared/projectGit'
const mocks = vi.hoisted(() => ({ run: vi.fn(), on: vi.fn() }))
vi.mock('../src/services/desktop', () => ({ desktop: { projectGit: mocks.run, onProjectGit: mocks.on } }))
let listener: (event: ProjectGitEvent) => void
const state: ProjectGitState = { repository: true, branch: 'main', head: 'main\n1234', branches: ['feature/one', 'feature/two', 'main'], changedFiles: 3 }
beforeEach(() => { mocks.run.mockReset(); mocks.on.mockReset(); mocks.on.mockImplementation(callback => { listener = callback; return vi.fn() }); mocks.run.mockImplementation(async (command: ProjectGitCommand) => ({ ok: true, state: command.action === 'create' || command.action === 'switch' ? { ...state, branch: command.branch } : state })) })
async function open() { render(<GitBranchSelector sessionId="session" workspaceId="workspace" />); fireEvent.click(await screen.findByRole('button', { name: 'Git branch: main' })); return screen.getByRole('textbox', { name: 'Search branches' }) }
describe('branch popup', () => {
  it('shows current branch, changed files, immediate search, and remains open on hover', async () => {
    const search = await open()
    expect(screen.getByText('Uncommitted changes: 3 files')).toBeVisible()
    fireEvent.pointerMove(screen.getByRole('button', { name: /feature\/one/ })); expect(search).toBeVisible()
    fireEvent.change(search, { target: { value: 'TWO' } }); expect(screen.queryByRole('button', { name: /feature\/one/ })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /feature\/two/ }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(mocks.run).toHaveBeenCalledWith({ action: 'switch', sessionId: 'session', workspaceId: 'workspace', branch: 'feature/two', expectedHead: state.head })
  })
  it('creates a branch and reports backend validation errors without closing', async () => {
    await open(); fireEvent.click(screen.getByRole('button', { name: /Create and switch/ }))
    const name = screen.getByRole('textbox', { name: /Create and switch/ }); fireEvent.change(name, { target: { value: 'new' } })
    mocks.run.mockResolvedValueOnce({ ok: false, message: 'Branch already exists.' }); fireEvent.click(screen.getByRole('button', { name: 'Create and switch' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Branch already exists.')
    fireEvent.click(screen.getByRole('button', { name: 'Create and switch' })); await screen.findByRole('button', { name: 'Git branch: new' })
  })
  it('keeps a long checkout error collapsed while preserving full details and the active branch', async () => {
    await open()
    const message = `error: Your local changes to the following files would be overwritten by checkout:\n${Array.from({ length: 30 }, (_, index) => `src/feature/long-path-${index}.ts`).join('\n')}\nPlease commit your changes or stash them before you switch branches.\nAborting`
    mocks.run.mockResolvedValueOnce({ ok: false, state, message })
    fireEvent.click(screen.getByRole('button', { name: 'feature/one' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Local changes would be overwritten. Your changes are preserved.')
    expect(screen.getByRole('button', { name: 'Git branch: main' })).toBeVisible()
    expect(screen.queryByLabelText('Git error details')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Show details' }))
    expect(screen.getByLabelText('Git error details').textContent).toBe(message)
    expect(screen.getByRole('button', { name: 'Hide details' })).toHaveAttribute('aria-expanded', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'Hide details' }))
    expect(screen.queryByLabelText('Git error details')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'feature/two' }))
    await screen.findByRole('button', { name: 'Git branch: feature/two' })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
  it('keeps unexpected multiline Git errors available in details', async () => {
    await open()
    const message = 'fatal: Git operation failed\nAdditional diagnostic information'
    mocks.run.mockResolvedValueOnce({ ok: false, state, message })
    fireEvent.click(screen.getByRole('button', { name: 'feature/one' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Git could not complete this request.')
    fireEvent.click(screen.getByRole('button', { name: 'Show details' }))
    expect(screen.getByLabelText('Git error details').textContent).toBe(message)
  })
  it('hides non-repositories and displays detached HEAD', async () => {
    mocks.run.mockResolvedValue({ ok: true, state: { repository: false, head: '', branches: [] } })
    const view = render(<GitBranchSelector sessionId="s" workspaceId="w" />)
    await waitFor(() => expect(mocks.run).toHaveBeenCalled()); expect(screen.queryByRole('button')).not.toBeInTheDocument(); view.unmount()
    mocks.run.mockResolvedValue({ ok: true, state: { ...state, branch: undefined, detached: 'abc123' } })
    render(<GitBranchSelector sessionId="s2" workspaceId="w2" />); expect(await screen.findByRole('button', { name: 'Git branch: Detached · abc123' })).toBeVisible()
  })
  it('filters subscription events, updates external changes, and cleans up', async () => {
    const view = render(<GitBranchSelector sessionId="session" workspaceId="workspace" />)
    await screen.findByRole('button', { name: 'Git branch: main' })
    const command = mocks.run.mock.calls[0][0]
    act(() => listener({ subscriptionId: 'wrong', ok: true, state: { ...state, branch: 'other' } })); expect(screen.queryByText('other')).not.toBeInTheDocument()
    act(() => listener({ subscriptionId: command.subscriptionId, ok: true, state: { ...state, branch: 'external' } })); expect(screen.getByRole('button', { name: 'Git branch: external' })).toBeVisible()
    view.unmount(); expect(mocks.run).toHaveBeenCalledWith({ action: 'unwatch', sessionId: 'session', workspaceId: 'workspace', subscriptionId: command.subscriptionId })
  })
  it('supports keyboard escape and disables changes in Read Only', async () => {
    render(<GitBranchSelector sessionId="session" workspaceId="workspace" readOnly />)
    const trigger = await screen.findByRole('button', { name: 'Git branch: main' }); fireEvent.click(trigger)
    expect(screen.getByRole('button', { name: /feature\/one/ })).toBeDisabled()
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Search branches' }), { key: 'Escape' }); expect(screen.queryByRole('dialog')).not.toBeInTheDocument(); expect(trigger).toHaveFocus()
  })
})
