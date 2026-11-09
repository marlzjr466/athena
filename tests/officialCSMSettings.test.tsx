// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { VoiceSettings } from '../src/features/settings/VoiceSettings'
import { useAthena } from '../src/store/athenaStore'
import { defaultSettings, mergeSettings } from '../shared/settings'
import type { Snapshot } from '../shared/contracts'

const mock = vi.hoisted(() => ({ csm: vi.fn(), higgs: vi.fn(), stop: vi.fn(async () => ({ ok: true })) }))
vi.mock('../src/services/desktop', () => ({ desktop: { officialCSM: mock.csm, higgsTTS: mock.higgs, stopAllSpeech: mock.stop, onLocalVoicePlaybackStopped: () => () => {} } }))
vi.mock('../src/features/settings/VoiceInteractionSettings', () => ({ VoiceInteractionSettings: () => <div>Existing microphone settings</div> }))
beforeEach(() => {
  mock.csm.mockReset(); mock.higgs.mockReset(); mock.stop.mockClear()
  mock.higgs.mockResolvedValue({ ok: true, status: { runtime: false, downloaded: false, verified: false, loaded: false, busy: false, stage: 'Not loaded', references: [] } })
  mock.csm.mockResolvedValue({ ok: true, status: { runtime: true, downloaded: false, loaded: false, busy: false, stage: 'Runtime verified; gated access required', references: [] } })
  useAthena.setState({ snapshot: { settings: structuredClone(defaultSettings) } as Snapshot, update: async patch => {
    const snapshot = useAthena.getState().snapshot!
    useAthena.setState({ snapshot: { ...snapshot, settings: mergeSettings(snapshot.settings, patch) } })
  } })
})
afterEach(cleanup)
describe('Voice page official engine selector', () => {
  const choose = (label: string, option: string) => {
    fireEvent.click(screen.getByLabelText(label))
    fireEvent.click(screen.getByRole('option', { name: option }))
  }
  it('defaults to unchanged Chatterbox controls and never installs or signs in automatically', async () => {
    render(<VoiceSettings />)
    expect((screen.getByLabelText('Voice Engine') as HTMLSelectElement).value).toBe('chatterbox-turbo')
    expect(screen.getByText('Athena Youthful · original Amy US-English reference')).toBeTruthy()
    expect((screen.getByLabelText('Expressiveness') as HTMLInputElement).disabled).toBe(false)
    expect(mock.csm).not.toHaveBeenCalled()
    choose('Voice Engine', 'Sesame CSM-1B · Official')
    await screen.findByText('Runtime verified; gated access required')
    expect((screen.getByLabelText('Expressiveness') as HTMLInputElement).disabled).toBe(true)
    expect(mock.csm.mock.calls.every(([command]) => command.action === 'status')).toBe(true)
    expect(screen.getByText('Existing microphone settings')).toBeTruthy()
    choose('Sesame speaker', 'Speaker 1')
    choose('Voice Engine', 'Chatterbox Turbo')
    expect(useAthena.getState().snapshot!.settings.localVoice.profileId).toBe('athena-youthful')
    choose('Voice Engine', 'Sesame CSM-1B · Official')
    expect((screen.getByLabelText('Sesame speaker') as HTMLSelectElement).value).toBe('1')
  })
  it('requires an authorized transcript before native reference import and displays errors', async () => {
    render(<VoiceSettings />)
    choose('Voice Engine', 'Sesame CSM-1B · Official')
    await screen.findByText('Runtime verified; gated access required')
    const button = screen.getByRole('button', { name: 'Import authorized WAV…' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Sesame reference transcript'), { target: { value: 'Hello Athena.' } })
    expect(button.disabled).toBe(true)
    fireEvent.click(screen.getByRole('switch', { name: 'Authorized Sesame reference' }))
    expect(button.disabled).toBe(false)
    mock.csm.mockResolvedValueOnce({ ok: false, message: 'Reference must be 1–20 seconds.' })
    fireEvent.click(button)
    await waitFor(() => expect(screen.getByText('Reference must be 1–20 seconds.')).toBeTruthy())
    expect(mock.csm).toHaveBeenCalledWith({ action: 'import-reference', transcript: 'Hello Athena.', speaker: 0, authorized: true })
  })
})
