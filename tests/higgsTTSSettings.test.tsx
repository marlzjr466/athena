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
  mock.csm.mockResolvedValue({ ok: true, status: { runtime: true, downloaded: false, loaded: false, busy: false, stage: 'Runtime verified', references: [] } })
  mock.higgs.mockResolvedValue({ ok: true, status: { runtime: true, downloaded: false, verified: false, loaded: false, busy: false, stage: 'Runtime verified; download next', references: [] } })
  useAthena.setState({ snapshot: { settings: structuredClone(defaultSettings) } as Snapshot, update: async patch => {
    const snapshot = useAthena.getState().snapshot!
    useAthena.setState({ snapshot: { ...snapshot, settings: mergeSettings(snapshot.settings, patch) } })
  } })
})
afterEach(cleanup)
describe('Voice page Higgs engine selector', () => {
  const choose = (label: string, option: string) => {
    fireEvent.click(screen.getByLabelText(label))
    fireEvent.click(screen.getByRole('option', { name: option }))
  }
  it('keeps voice playback controls without the preview text editor or presets', () => {
    render(<VoiceSettings />)
    expect(screen.getByRole('button', { name: /Preview Voice/ })).toBeTruthy()
    expect(screen.queryByText('Preview text')).toBeNull()
    expect(screen.queryByText(/Use the same sentences to compare engines/)).toBeNull()
    expect(screen.queryByText('Normal greeting')).toBeNull()
    expect(screen.queryByText('Technical explanation')).toBeNull()
  })
  it('shows an architecture failure instead of offering an unusable weight download', async () => {
    mock.higgs.mockResolvedValue({ ok: true, status: { runtime: true, downloaded: false, compatible: false, compatibilityMessage: 'Unsupported architecture higgs_multimodal_qwen3', stage: 'Dependencies installed', references: [] } })
    render(<VoiceSettings />)
    choose('Voice Engine', 'Higgs TTS 3 4B')
    expect(await screen.findByRole('alert')).toHaveTextContent('Unsupported architecture')
    expect(screen.getByRole('button', { name: 'Download official model' })).toBeDisabled()
    fireEvent.click(screen.getByLabelText('Higgs speaking style'))
    expect(screen.queryByRole('option', { name: 'Conversational' })).toBeNull()
    expect(screen.getByRole('option', { name: 'Whispering' })).toBeTruthy()
  })
  it('adds Higgs as a third engine without changing the default or Sesame controls', async () => {
    render(<VoiceSettings />)
    expect((screen.getByLabelText('Voice Engine') as HTMLSelectElement).value).toBe('chatterbox-turbo')
    expect(mock.higgs).not.toHaveBeenCalled()
    choose('Voice Engine', 'Higgs TTS 3 4B')
    expect(await screen.findByText('Expressive conversational speech with natural laughter, emotion, prosody, and multilingual support.')).toBeTruthy()
    expect((screen.getByLabelText('Expressiveness') as HTMLInputElement).disabled).toBe(true)
    expect(screen.getByText('Athena — Higgs Expressive')).toBeTruthy()
    expect(useAthena.getState().snapshot!.settings.localVoice.engine).toBe('higgs-tts-3-4b')
    expect(useAthena.getState().snapshot!.settings.localVoice.profileId).toBe('athena-youthful')
    choose('Voice Engine', 'Sesame CSM-1B · Official')
    await screen.findByText('Runtime verified')
    expect(useAthena.getState().snapshot!.settings.localVoice.higgs.device).toBe('mps')
    expect(screen.getByText('Existing microphone settings')).toBeTruthy()
  })
  it('requires an authorized Higgs transcript before native reference import', async () => {
    render(<VoiceSettings />)
    choose('Voice Engine', 'Higgs TTS 3 4B')
    await screen.findByText('Runtime verified; download next')
    const button = screen.getByRole('button', { name: 'Import authorized WAV…' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Higgs reference transcript'), { target: { value: 'Hello Athena.' } })
    fireEvent.click(screen.getByRole('switch', { name: 'Authorized Higgs reference' }))
    expect(button.disabled).toBe(false)
    fireEvent.click(button)
    await waitFor(() => expect(mock.higgs).toHaveBeenCalledWith({ action: 'import-reference', transcript: 'Hello Athena.', authorized: true }))
  })
})
