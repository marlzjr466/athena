import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { defaultSettings } from '../shared/settings'
import type { Snapshot } from '../shared/contracts'
import { useAthena } from '../src/store/athenaStore'
const api = vi.hoisted(() => ({ getWebSearchStatus: vi.fn(), restartWebSearch: vi.fn(), updateSettings: vi.fn() }))
vi.mock('../src/services/desktop', () => ({ desktop: api }))
import { WebToolsSettings } from '../src/features/settings/WebToolsSettings'
beforeEach(() => {
  vi.resetAllMocks()
  useAthena.setState({ snapshot: { settings: { ...defaultSettings, webAccess: { ...defaultSettings.webAccess, webSearchEnabled: true } }, state: 'idle' } as Snapshot })
  api.getWebSearchStatus.mockResolvedValue({ provider: 'Local SearXNG', hasKey: false, local: { state: 'error', message: 'Retry initialization.' }, note: 'Retry initialization.' })
  api.restartWebSearch.mockResolvedValue({ ok: true, message: 'Local SearXNG restarted.' })
  api.updateSettings.mockImplementation(async patch => ({ ...useAthena.getState().snapshot, settings: { ...useAthena.getState().snapshot!.settings, ...patch } }))
})
it('shows the default managed provider and retries initialization without credentials', async () => {
  render(<WebToolsSettings />)
  expect(screen.getByRole('combobox', { name: 'Web search provider' })).toHaveTextContent('Local SearXNG (Default)')
  expect(screen.queryByLabelText('Brave Search API key')).not.toBeInTheDocument()
  fireEvent.click(await screen.findByRole('button', { name: 'Retry Initialization' }))
  await waitFor(() => expect(api.restartWebSearch).toHaveBeenCalledOnce())
  expect(await screen.findByText('Local SearXNG restarted.')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('switch', { name: 'Automatic search startup' }))
  await waitFor(() => expect(api.updateSettings).toHaveBeenCalledWith({ webAccess: expect.objectContaining({ searchProvider: 'searxng', automaticStartup: false }) }))
})
it('disables startup actions when Internet Access is off', async () => {
  useAthena.setState({ snapshot: { settings: defaultSettings, state: 'idle' } as Snapshot })
  render(<WebToolsSettings />)
  expect(await screen.findByRole('button', { name: 'Retry Initialization' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Test Search Connection' })).toBeDisabled()
})
