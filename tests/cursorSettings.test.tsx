import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({ getCursorStatus: vi.fn(), getChat: vi.fn(), onChat: vi.fn(() => () => {}), signInCursor: vi.fn(), signOutCursor: vi.fn() }))
vi.mock('../src/services/desktop', () => ({ desktop: api }))

import { CursorSettings } from '../src/features/settings/CursorSettings'

const connected = {
  installed: true, authenticated: true, identity: 'athena@example.test', version: '2026.10.01',
  message: 'Cursor CLI is signed in.', modelCatalogAvailable: true,
  models: [
    { id: 'auto', label: 'Auto' },
    { id: 'grok-4.7-high', label: 'Grok 4.7 High' },
    { id: 'kimi-k2', label: 'Kimi K2' },
    { id: 'claude-opus-5', label: 'Claude Opus 5' },
  ],
}

describe('Cursor settings model catalog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    api.getCursorStatus.mockResolvedValue(connected)
    api.getChat.mockResolvedValue({ config: { model: 'kimi-k2', cursorModel: 'kimi-k2' } })
  })

  it('shows connection information without the collapsible model catalog and still refreshes', async () => {
    const { container, unmount } = render(<CursorSettings />)
    expect(await screen.findByText('● Connected')).toBeInTheDocument()
    expect(api.getCursorStatus).toHaveBeenCalledTimes(1)
    expect(api.getCursorStatus).toHaveBeenCalledWith({ cachedOnly: true })
    expect(screen.queryByText('4 available')).not.toBeInTheDocument()
    expect(container.querySelector('details')).toBeNull()
    expect(screen.queryByText('Grok 4.7 High')).not.toBeInTheDocument()
    expect(screen.queryByText('Kimi K2')).not.toBeInTheDocument()
    expect(screen.getByText(/private, separately granted Cursor chat folder/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Refresh status & models' }))
    await waitFor(() => expect(api.getCursorStatus).toHaveBeenLastCalledWith({ refreshModels: true }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh status & models' })).toBeEnabled())
    unmount()
    render(<CursorSettings />)
    expect(await screen.findByText('● Connected')).toBeInTheDocument()
    expect(screen.queryByText('○ Checking…')).not.toBeInTheDocument()
    expect(api.getCursorStatus.mock.calls).toEqual([[{ cachedOnly: true }], [{ refreshModels: true }], [{ cachedOnly: true }]])
  })

  it('does not retry a failed check on page visits and keeps browser sign-in available', async () => {
    api.getCursorStatus.mockResolvedValue({ ...connected, authenticated: false, authenticationStatus: 'unknown', message: 'Status check failed.', models: [] })
    const { unmount } = render(<CursorSettings />)
    expect(await screen.findByText('Status check failed. · 2026.10.01')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Sign in with Cursor' })).toBeEnabled()
    unmount()
    render(<CursorSettings />)
    await screen.findByText('Status check failed. · 2026.10.01')
    expect(api.getCursorStatus.mock.calls).toEqual([[{ cachedOnly: true }], [{ cachedOnly: true }]])
    expect(api.signInCursor).not.toHaveBeenCalled()
    api.signInCursor.mockResolvedValue(connected)
    fireEvent.click(screen.getByRole('button', { name: 'Sign in with Cursor' }))
    expect(await screen.findByText('● Connected')).toBeInTheDocument()
    expect(api.signInCursor).toHaveBeenCalledTimes(1)
  })

  it('does not let a late cache read overwrite an explicit successful refresh', async () => {
    let finishCache!: (value: typeof connected) => void
    api.getCursorStatus.mockImplementation(({ cachedOnly }) => cachedOnly ? new Promise((resolve) => { finishCache = resolve }) : Promise.resolve(connected))
    render(<CursorSettings />)
    fireEvent.click(screen.getByRole('button', { name: 'Check Cursor status' }))
    expect(await screen.findByText('● Connected')).toBeInTheDocument()
    await act(async () => finishCache({ ...connected, authenticated: false }))
    expect(screen.getByText('● Connected')).toBeInTheDocument()
  })
})
