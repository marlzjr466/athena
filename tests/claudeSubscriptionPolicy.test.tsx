import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyAIStatus } from '../shared/ai'

const api = vi.hoisted(() => ({
  getClaudeStatus: vi.fn(),
  testClaudeConnection: vi.fn(),
  activateClaudeAPI: vi.fn(),
  selectClaudeModel: vi.fn(),
  removeClaudeAPIKey: vi.fn(),
}))

vi.mock('../src/services/desktop', () => ({ desktop: api }))

import { ClaudeAPISettings } from '../src/features/settings/ClaudeAPISettings'

describe('Claude subscription eligibility notice', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    api.getClaudeStatus.mockResolvedValue({ ok: true, status: emptyAIStatus(), message: '' })
  })

  it('explains prior-approval restriction and keeps the separate API-key option available', async () => {
    render(<ClaudeAPISettings />)

    expect(await screen.findByText(/third-party apps to offer claude\.ai login or subscription rate limits only with prior Anthropic approval/i)).toBeInTheDocument()
    expect(screen.getByText(/Athena has no approved subscription integration, so Claude subscription sign-in is unavailable here/i)).toBeInTheDocument()
    expect(screen.getByLabelText('Anthropic API key')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /sign in with claude|claude subscription/i })).not.toBeInTheDocument()
  })
})
