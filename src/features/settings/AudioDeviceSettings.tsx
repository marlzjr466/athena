import '../../styles/audioDevices.css'
import { useEffect, useRef, useState } from 'react'
import { CustomSelect } from '../../components/ui/CustomSelect'
import { Section, SettingRow, Toggle } from '../../components/ui/Controls'
import { useAthena } from '../../store/athenaStore'
import { desktop } from '../../services/desktop'
import { MicrophoneSource, currentAudioDevices, onAudioDevices, refreshAudioDevices } from '../../services/speech/audioDevices'
import { supportedAudioDevice, type AudioDeviceSettings as Preferences } from '../../../shared/audioDevices'

export function AudioDeviceSettings({ testVoice, voiceBusy }: { testVoice(): Promise<void>; voiceBusy: boolean }) {
  const { snapshot, update, error } = useAthena()
  const [devices, setDevices] = useState(currentAudioDevices)
  const [notice, setNotice] = useState('')
  const [starting, setStarting] = useState(false)
  const test = useRef<{ source?: MicrophoneSource; context?: AudioContext; timer?: ReturnType<typeof setInterval>; cancelled: boolean } | undefined>(undefined)
  const clearTest = () => {
    const active = test.current; test.current = undefined
    if (active) { active.cancelled = true; clearInterval(active.timer); active.source?.close(); void active.context?.close().catch(() => {}) }
  }
  const stopTest = async () => { clearTest(); await desktop.audioDevices({ action: 'test-stop' }).catch(() => {}) }
  useEffect(() => {
    const off = onAudioDevices(state => { setDevices(state); if (!state.testActive) clearTest() })
    const refresh = () => {
      if (!document.hidden) void refreshAudioDevices(true).then(() => setDevices(currentAudioDevices())).catch(() => setNotice('Could not refresh audio devices. Reopen Voice Settings to retry.'))
    }
    refresh()
    window.addEventListener('focus', refresh)
    return () => { window.removeEventListener('focus', refresh); off(); void stopTest() }
  }, [])
  const settings = snapshot?.settings
  if (!settings) return null
  const preferences = settings.audioDevices
  const change = async (patch: Partial<Preferences>) => {
    setNotice(''); await stopTest(); await update({ audioDevices: { ...preferences, ...patch } })
  }
  const options = (kind: 'audioinput' | 'audiooutput') => {
    const route = kind === 'audioinput' ? devices.input : devices.output
    return [{ value: 'default', label: `Automatic · ${route.label}` }, ...devices.devices.filter(d => d.kind === kind && supportedAudioDevice(d)).map(d => ({ value: d.deviceId, label: d.label }))]
  }
  const selected = (kind: 'audioinput' | 'audiooutput', id: string) => options(kind).some(d => d.value === id) ? id : 'default'
  const startTest = async () => {
    if (starting || devices.testActive) return
    setStarting(true); setNotice('')
    const active: NonNullable<typeof test.current> = { cancelled: false }; test.current = active
    try {
      await desktop.audioDevices({ action: 'test-start' })
      if (active.cancelled) { await stopTest(); return }
      // Monitor the existing wake-word stream instead of opening a second microphone.
      if (settings.voiceInteraction.handsFreeEnabled) { setNotice('Monitoring the hands-free microphone for 15 seconds. No recording is saved.'); return }
      active.source = new MicrophoneSource(() => ({ echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: { ideal: 1 } }), () => { if (active.source?.needsReconnect()) { void stopTest(); setNotice('Input changed. Test the newly selected microphone again.') } })
      const stream = await active.source.getStream()
      if (active.cancelled) return
      const context = new AudioContext(); active.context = context
      const analyser = context.createAnalyser(); analyser.fftSize = 512
      context.createMediaStreamSource(stream).connect(analyser) // No connection to speakers; no feedback.
      await context.resume()
      if (active.cancelled) { await context.close().catch(() => {}); return }
      const samples = new Float32Array(analyser.fftSize)
      active.timer = setInterval(() => {
        if (active.cancelled) return
        analyser.getFloatTimeDomainData(samples)
        const level = Math.min(1, Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length) * 5)
        void desktop.audioDevices({ action: 'level', level }).catch(() => { void stopTest() })
      }, 100)
      setNotice('Microphone connected. Speak to check the level; no audio is saved or transcribed. Test ends after 15 seconds.')
    } catch (failure) { await stopTest(); setNotice(failure instanceof Error ? failure.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : 'Could not test the microphone. Check Privacy settings.') }
    finally { setStarting(false) }
  }
  return <Section title="Audio Devices" description="Automatic uses the newest connected external device, or built-in audio when none is connected. Input and output are selected independently. Bluetooth microphones can switch headsets to a lower-quality hands-free profile; available input and output endpoints depend on the headset and OS.">
    <SettingRow title="Microphone" description={devices.input.message}><CustomSelect ariaLabel="Microphone device" value={selected('audioinput', preferences.inputDeviceId)} options={options('audioinput')} onChange={inputDeviceId => void change({ inputDeviceId })} /></SettingRow>
    <SettingRow title="Speaker" description={devices.output.message}><CustomSelect ariaLabel="Speaker device" value={selected('audiooutput', preferences.outputDeviceId)} options={options('audiooutput')} onChange={outputDeviceId => void change({ outputDeviceId })} /></SettingRow>
    <SettingRow title="Automatic device switching" description="Prefer newly connected devices. With this off, keep the current device while available. Disconnected devices always recover automatically; speech may continue through built-in speakers."><Toggle label="Automatic device switching" checked={preferences.automaticSwitching} onChange={automaticSwitching => void change({ automaticSwitching })} /></SettingRow>
    <SettingRow title="Current connection"><span role="status">Input: {devices.input.label}<br />Output: {devices.output.label}</span></SettingRow>
    {devices.outputHeld && <SettingRow title="Speech paused" description={devices.message}><button className="chat-action" disabled={!devices.output.deviceId} onClick={() => { void desktop.audioDevices({ action: 'confirm-output' }).catch(() => setNotice('Choose an available speaker first.')) }}>Use current speaker</button></SettingRow>}
    <SettingRow title="Live microphone input level" description="Available during a microphone test; monitoring never plays your microphone through the speakers."><div className="audio-input-meter" role="meter" aria-label="Microphone input level" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(devices.microphoneLevel * 100)}><span style={{ transform: `scaleX(${devices.microphoneLevel})` }} /></div></SettingRow>
    <SettingRow title="Test audio"><div className="voice-actions"><button className="chat-action" disabled={starting} onClick={() => { void (devices.testActive ? stopTest() : startTest()) }}>{devices.testActive ? 'Stop microphone test' : starting ? 'Connecting…' : 'Test microphone'}</button><button className="chat-action" disabled={voiceBusy || !settings.voiceEnabled || settings.voiceMuted || settings.doNotDisturb} onClick={() => { void testVoice() }}>Test Athena voice</button></div></SettingRow>
    {(notice || error) && <p role="status" className="chat-message-note">{error ?? notice}</p>}
  </Section>
}
