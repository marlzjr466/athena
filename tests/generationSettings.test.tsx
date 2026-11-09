import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { GenerationSettings } from '../src/features/settings/GenerationSettings'
import { useAthena } from '../src/store/athenaStore'
import { defaultSettings } from '../shared/settings'
import type { Snapshot } from '../shared/contracts'
const api = vi.hoisted(() => ({ updateSettings: vi.fn() }))
vi.mock('../src/services/desktop', () => ({ desktop: api }))
const snapshot: Snapshot = { settings: defaultSettings, displays: [], state: 'idle', flight: null, idleAction: null, visible: true, panelMode: 'chat', panelVisible: false, onBattery: false, reducedMotion: false, platform: 'darwin', version: 'test', error: null }
beforeEach(() => { vi.clearAllMocks(); useAthena.setState({ snapshot, error: null }); api.updateSettings.mockResolvedValue(snapshot) })
describe('generation settings', () => {
  it('saves a custom budget and continuation count through the existing settings bridge', async () => {
    render(<GenerationSettings model="gpt-5.6-luna" />)
    expect(screen.getByLabelText('Output budget per request')).toHaveAttribute('max', '128000')
    fireEvent.change(screen.getByLabelText('Output budget per request'), { target: { value: '45000' } })
    fireEvent.change(screen.getByLabelText('Maximum output continuations'), { target: { value: '2' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save generation settings' }))
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledWith({ aiGeneration: { outputTokens: 45000, maxOutputContinuations: 2 } }))
    expect(await screen.findByRole('status')).toHaveTextContent('Generation settings saved')
  })
  it('allows automatic budgets and clamps UI input to the current model’s documented output maximum', async () => {
    render(<GenerationSettings model="gpt-4.1" />)
    expect(screen.getByLabelText('Output budget per request')).toHaveAttribute('max', '32768')
    fireEvent.click(screen.getByRole('button', { name: 'Save generation settings' }))
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledWith({ aiGeneration: { outputTokens: null, maxOutputContinuations: 3 } }))
  })
})
