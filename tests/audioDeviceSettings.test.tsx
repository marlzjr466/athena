import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { AudioDeviceSettings } from '../src/features/settings/AudioDeviceSettings'
import { defaultSettings, mergeSettings } from '../shared/settings'
import { emptyAudioDeviceState } from '../shared/audioDevices'
import type { Snapshot } from '../shared/contracts'
import { useAthena } from '../src/store/athenaStore'
const mock = vi.hoisted(() => ({ command: vi.fn(), current: {} as ReturnType<typeof emptyAudioDeviceState>, listener: undefined as undefined | ((state: ReturnType<typeof emptyAudioDeviceState>) => void) }))
vi.mock('../src/services/desktop', () => ({ desktop: { audioDevices: mock.command } }))
vi.mock('../src/services/speech/audioDevices', () => ({ currentAudioDevices: () => mock.current, refreshAudioDevices: async () => {}, onAudioDevices: (listener: typeof mock.listener) => { mock.listener = listener; return () => {} }, MicrophoneSource: class {} }))
beforeEach(() => {
  mock.current = { ...emptyAudioDeviceState(), devices: [
    { deviceId: 'usb', kind: 'audioinput', groupId: 'usb', label: 'USB microphone' },
    { deviceId: 'headphones', kind: 'audiooutput', groupId: 'usb', label: 'USB headphones' },
  ] }
  mock.current.devices.push({ deviceId: 'teams', kind: 'audiooutput', groupId: 'teams', label: 'Microsoft Teams Audio Device' })
  mock.command.mockReset().mockImplementation(async () => mock.current)
  useAthena.setState({ error: null, snapshot: { settings: structuredClone(defaultSettings) } as Snapshot, update: async patch => {
    const snapshot = useAthena.getState().snapshot!
    useAthena.setState({ snapshot: { ...snapshot, settings: mergeSettings(snapshot.settings, patch) } })
  } })
})
describe('Audio Devices settings', () => {
  it('saves separate input/output choices and automatic switching without changing voice engine or permissions', async () => {
    render(<AudioDeviceSettings testVoice={vi.fn()} voiceBusy={false} />)
    fireEvent.click(screen.getByLabelText('Microphone device'))
    fireEvent.click(screen.getByRole('option', { name: 'USB microphone' }))
    await waitFor(() => expect(useAthena.getState().snapshot!.settings.audioDevices.inputDeviceId).toBe('usb'))
    fireEvent.click(screen.getByLabelText('Speaker device'))
    expect(screen.queryByRole('option', { name: /Teams/ })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('option', { name: 'USB headphones' }))
    await waitFor(() => expect(useAthena.getState().snapshot!.settings.audioDevices.outputDeviceId).toBe('headphones'))
    fireEvent.click(screen.getByRole('switch', { name: 'Automatic device switching' }))
    await waitFor(() => expect(useAthena.getState().snapshot!.settings.audioDevices.automaticSwitching).toBe(false))
    expect(useAthena.getState().snapshot!.settings.localVoice).toEqual(defaultSettings.localVoice)
    expect(useAthena.getState().snapshot!.settings.voiceInteraction.handsFreeEnabled).toBe(false)
  })
  it('hides an unavailable saved device and shows a clear blocked-test error', async () => {
    const snapshot = useAthena.getState().snapshot!
    useAthena.setState({ snapshot: { ...snapshot, settings: mergeSettings(snapshot.settings, { audioDevices: { ...defaultSettings.audioDevices, outputDeviceId: 'missing-headset' } }) } })
    mock.command.mockImplementation(async input => { if (input.action === 'test-start') throw new Error('Allow Microphone Access in Privacy.'); return mock.current })
    render(<AudioDeviceSettings testVoice={vi.fn()} voiceBusy={false} />)
    expect(screen.getByLabelText('Speaker device')).toHaveTextContent('Automatic')
    fireEvent.click(screen.getByRole('button', { name: /^Test microphone$/ }))
    await screen.findByText('Allow Microphone Access in Privacy.')
    expect(useAthena.getState().snapshot!.settings.audioDevices.outputDeviceId).toBe('missing-headset')
  })
  it('requires explicit speaker confirmation after a route change and uses the existing voice preview', () => {
    mock.current.outputHeld = true; mock.current.output = { deviceId: 'headphones', label: 'USB headphones' }
    const preview = vi.fn(async () => {})
    render(<AudioDeviceSettings testVoice={preview} voiceBusy={false} />)
    fireEvent.click(screen.getByRole('button', { name: 'Use current speaker' }))
    expect(mock.command).toHaveBeenCalledWith({ action: 'confirm-output' })
    fireEvent.click(screen.getByRole('button', { name: 'Test Athena voice' }))
    expect(preview).toHaveBeenCalledOnce()
  })
})
