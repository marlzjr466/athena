import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CopilotStatus } from '../shared/copilot'

const api = vi.hoisted(() => ({ copilot: vi.fn(), getAIStatus: vi.fn(), openExternalLink: vi.fn() }))
vi.mock('../src/services/desktop', () => ({ desktop: api }))

import { CopilotSettings } from '../src/features/settings/CopilotSettings'

const connected: CopilotStatus = {
  accounts: [{ id: 'cli:octocat', login: 'octocat', enabled: true, kind: 'cli' }],
  activeId: 'cli:octocat',
  message: 'Use browser sign-in, device-code sign-in, or connect your existing Copilot CLI. No Client ID is needed.',
  cli: { installed: true, version: '1.0.106', phase: 'connected', message: 'GitHub identity verified. Copilot CLI connected.' },
}

describe('Copilot settings connected account', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    api.copilot.mockResolvedValue(connected)
    api.getAIStatus.mockResolvedValue({ ok: true, message: 'GitHub Copilot subscription.', status: { models: ['model-a', 'model-b'] } })
  })

  it('replaces sign-in actions with the connected account view', async () => {
    render(<CopilotSettings />)
    expect(await screen.findByText('● Connected')).toBeInTheDocument()
    expect(screen.getByText('octocat')).toBeInTheDocument()
    expect(screen.getByText('Subscription models · streaming · cancellable')).toBeInTheDocument()
    expect(screen.getByText('Authorized project workspace')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Sign in with GitHub (Browser)' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Sign in with GitHub (Device Code)' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Connect Existing Copilot CLI' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Select' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Refresh status & models' })).toBeEnabled()
  })

  it('signs out the selected account and returns to sign-in', async () => {
    api.copilot.mockImplementation(async (command: { action: string }) => command.action === 'remove' ? { accounts: [], activeId: null, message: 'Signed out.' } : connected)
    render(<CopilotSettings />)
    fireEvent.click(await screen.findByRole('button', { name: 'Sign out' }))
    expect(await screen.findByRole('button', { name: 'Sign in with GitHub (Browser)' })).toBeEnabled()
    expect(api.copilot).toHaveBeenCalledWith({ action: 'remove', id: 'cli:octocat' })
    expect(screen.queryByText('● Connected')).not.toBeInTheDocument()
  })

  it('refreshes model availability without offering another login', async () => {
    render(<CopilotSettings />)
    fireEvent.click(await screen.findByRole('button', { name: 'Refresh status & models' }))
    await waitFor(() => expect(api.getAIStatus).toHaveBeenCalledOnce())
    expect(await screen.findByText(/2 models available/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Sign in with GitHub (Browser)' })).not.toBeInTheDocument()
  })
})
