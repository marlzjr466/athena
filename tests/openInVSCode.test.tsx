import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OpenInVSCode } from '../src/features/chat/OpenInVSCode'
import type { ProjectEditorResult } from '../shared/projectEditor'
const run = vi.hoisted(() => vi.fn())
vi.mock('../src/services/desktop', () => ({ desktop: { projectEditor: run } }))
beforeEach(() => { run.mockReset(); run.mockResolvedValue({ ok: true, available: true }); Object.defineProperty(document, 'hidden', { configurable: true, value: false }) })
afterEach(() => vi.useRealTimers())
describe('Open in VS Code header action', () => {
  it('hides unavailable installations and updates detection on focus', async () => {
    run.mockResolvedValueOnce({ ok: true, available: false })
    render(<OpenInVSCode sessionId="session" workspaceId="project" onError={vi.fn()} />)
    await waitFor(() => expect(run).toHaveBeenCalledOnce()); expect(screen.queryByRole('button')).not.toBeInTheDocument()
    fireEvent.focus(window)
    const button = await screen.findByRole('button', { name: 'Open in VS Code' })
    expect(button).toHaveAttribute('title', 'Open project folder in Visual Studio Code')
    run.mockResolvedValue({ ok: true, available: false }); fireEvent.focus(window)
    await waitFor(() => expect(screen.queryByRole('button')).not.toBeInTheDocument())
  })
  it('launches the selected project once, shows loading and reports failure', async () => {
    const onError = vi.fn()
    render(<OpenInVSCode sessionId="session" workspaceId="project" onError={onError} />)
    const button = await screen.findByRole('button', { name: 'Open in VS Code' })
    let finish!: (result: ProjectEditorResult) => void
    run.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    fireEvent.click(button); fireEvent.click(button)
    expect(button).toBeDisabled(); expect(button).toHaveTextContent('Opening…')
    expect(run).toHaveBeenCalledTimes(2)
    expect(run).toHaveBeenLastCalledWith({ action: 'open', sessionId: 'session', workspaceId: 'project' })
    await act(async () => finish({ ok: false, message: 'Project folder is missing.' }))
    expect(onError).toHaveBeenLastCalledWith('Project folder is missing.')
    expect(button).toBeEnabled()
  })
  it('does not send stale launch results to a different project conversation', async () => {
    const onError = vi.fn()
    const view = render(<OpenInVSCode key="a" sessionId="a" workspaceId="project-a" onError={onError} />)
    const button = await screen.findByRole('button', { name: 'Open in VS Code' })
    let finish!: (result: ProjectEditorResult) => void
    run.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    fireEvent.click(button)
    view.rerender(<OpenInVSCode key="b" sessionId="b" workspaceId="project-b" onError={onError} />)
    await screen.findByRole('button', { name: 'Open in VS Code' })
    await act(async () => finish({ ok: false, message: 'Old failure' }))
    expect(onError).not.toHaveBeenCalledWith('Old failure')
    fireEvent.click(screen.getByRole('button', { name: 'Open in VS Code' }))
    await waitFor(() => expect(run).toHaveBeenLastCalledWith({ action: 'open', sessionId: 'b', workspaceId: 'project-b' }))
  })
  it('refreshes while visible and removes timers/listeners when unmounted', async () => {
    vi.useFakeTimers()
    const view = render(<OpenInVSCode sessionId="session" workspaceId="project" onError={vi.fn()} />)
    await act(async () => {})
    await act(async () => vi.advanceTimersByTime(60_000)); expect(run).toHaveBeenCalledTimes(2)
    Object.defineProperty(document, 'hidden', { configurable: true, value: true })
    await act(async () => vi.advanceTimersByTime(60_000)); expect(run).toHaveBeenCalledTimes(2)
    view.unmount(); fireEvent.focus(window)
    await act(async () => vi.advanceTimersByTime(60_000)); expect(run).toHaveBeenCalledTimes(2)
  })
})
