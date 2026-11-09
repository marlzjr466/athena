import { useEffect, useState } from 'react'
import { CustomSelect } from '../../components/ui/CustomSelect'
import { Section, SettingRow, Slider, Toggle } from '../../components/ui/Controls'
import { desktop } from '../../services/desktop'
import { useAthena } from '../../store/athenaStore'

const sensitivities = [
  { value: 'low', label: 'Low · fewer false activations' },
  { value: 'balanced', label: 'Balanced' },
  { value: 'high', label: 'High · picks up quieter speech' },
]
const suppressionLevels = [
  { value: 'low', label: 'Low · standard microphone filtering' },
  { value: 'balanced', label: 'Balanced · recommended' },
  { value: 'high', label: 'High · stronger voice isolation' },
]

export function VoiceInteractionSettings() {
  const { snapshot, update } = useAthena()
  const settings = snapshot?.settings
  const interaction = settings?.voiceInteraction
  const handsFreeState = snapshot?.handsFreeState
  const [notice, setNotice] = useState('')
  const [microphone, setMicrophone] = useState('Checking…')
  const [inputDevice, setInputDevice] = useState('Checking connected inputs…')
  const [speechService, setSpeechService] = useState('Checking local Whisper…')
  const [phrases, setPhrases] = useState(interaction?.wakePhrases.join(', ') ?? '')
  useEffect(() => { if (interaction) setPhrases(interaction.wakePhrases.join(', ')) }, [interaction?.wakePhrases.join('|')])
  const refreshMicrophone = () => {
    void Promise.resolve().then(() => desktop.getPermissionStatus({ permission: 'microphone' })).then((status) => setMicrophone(status.capabilityAllowed ? 'Allowed' : status.status === 'denied' ? 'Denied in macOS' : status.enabled ? status.osStatus : 'Not enabled in Athena')).catch(() => setMicrophone('Unavailable'))
    void navigator.mediaDevices?.enumerateDevices().then((devices) => {
      const count = devices.filter((device) => device.kind === 'audioinput').length
      setInputDevice(count ? `${count} microphone input${count === 1 ? '' : 's'} available` : 'No microphone input found. Connect or select an input device in macOS Sound settings.')
    }).catch(() => setInputDevice('Could not inspect microphone inputs. Check macOS Sound settings.'))
  }
  useEffect(() => { refreshMicrophone() }, [])
  useEffect(() => {
    navigator.mediaDevices?.addEventListener('devicechange', refreshMicrophone)
    return () => navigator.mediaDevices?.removeEventListener('devicechange', refreshMicrophone)
  }, [])
  useEffect(() => {
    let cancelled = false
    void desktop.getLocalStatus().then((status) => {
      if (cancelled) return
      setSpeechService(!status.whisperInstalled ? 'Whisper is unavailable. Install/configure it in My Athena → Local AI setup → Local voice.'
        : !settings?.localAI.speechModelPath ? 'Choose a local Whisper model in My Athena → Local AI setup → Local voice.'
          : status.whisperModelAvailable === false ? 'The selected Whisper model file is unavailable. Re-select it in My Athena → Local AI setup → Local voice.'
            : 'Local speech recognition is ready.')
    }).catch(() => { if (!cancelled) setSpeechService('Could not check local Whisper. Open My Athena → Local AI setup → Local voice.') })
    return () => { cancelled = true }
  }, [settings?.localAI.speechModelPath])
  if (!settings || !interaction) return null
  const change = (patch: Partial<typeof interaction>) => { setNotice(''); void update({ voiceInteraction: { ...interaction, ...patch } }) }
  const toggleHandsFree = async (enabled: boolean) => {
    setNotice('')
    if (!enabled) {
      const result = await desktop.disableHandsFree()
      setNotice(result.ok ? 'Hands-free listening is off.' : 'Could not turn hands-free listening off.')
      return
    }
    const result = await desktop.enableHandsFree()
    refreshMicrophone()
    if (result.ok) setNotice('Hands-free is enabled. Microphone startup and listening status are shown below.')
    else setNotice(result.message ?? 'Hands-free Athena could not be enabled.')
  }
  const savePhrases = () => {
    const parsed = [...new Set(phrases.split(',').map((entry) => entry.trim()).filter(Boolean))]
    if (!parsed.length || parsed.length > 12) { setNotice('Add between 1 and 12 wake phrases.'); return }
    change({ wakePhrases: parsed })
    setNotice('Wake phrases saved.')
  }
  return <Section title="Hands-free voice interaction" description="Athena listens for the configured name only after explicit opt-in. Local Silero speech detection rejects noise before local Whisper; passive audio is never sent to an AI provider or saved.">
    <SettingRow title="Hands-Free Athena" description="Always listen locally for Athena’s name while the floating companion is visible. Requires microphone permission and a local Whisper model.">
      <Toggle label="Hands-Free Athena" checked={interaction.handsFreeEnabled} onChange={(enabled) => { void toggleHandsFree(enabled) }} />
    </SettingRow>
    <SettingRow title="Hands-free status" description="This reflects the actual microphone and wake-listener state, not just the saved preference."><span role="status">{!interaction.handsFreeEnabled ? 'Off' : handsFreeState?.state === 'error' ? handsFreeState.message ?? 'Microphone unavailable' : handsFreeState?.state === 'standby' ? 'Listening for Athena' : handsFreeState?.state === 'listening' ? 'Hearing speech' : handsFreeState?.state === 'follow-up' ? 'Ready for follow-up' : handsFreeState?.state === 'processing' ? handsFreeState.message ?? 'Processing' : handsFreeState?.state === 'speaking' ? 'Athena is speaking' : handsFreeState?.message ?? 'Starting microphone…'}</span></SettingRow>
    {import.meta.env.DEV && handsFreeState?.diagnostics && <SettingRow title="Voice diagnostics" description="Recent stage durations in milliseconds; no speech or transcript content is recorded. Updates only when the voice state changes."><div role="status">{Object.entries(handsFreeState.diagnostics).map(([stage, duration]) => `${stage}: ${duration}`).join(' · ')}</div></SettingRow>}
    <SettingRow title="Microphone status" description="Athena checks both this app’s permission and macOS microphone authorization."><div className="voice-actions"><span>{microphone}</span><button type="button" className="chat-action" onClick={refreshMicrophone}>Refresh</button>{interaction.handsFreeEnabled && <button type="button" className="chat-action" onClick={() => void toggleHandsFree(false)}>Stop Listening</button>}</div></SettingRow>
    <SettingRow title="Input device" description="A disconnected device or exhausted local speech service is diagnosed here before retries continue."><span role="status">{inputDevice}</span></SettingRow>
    <SettingRow title="Voice detection sensitivity" description="Local Silero VAD uses speech confidence—not microphone loudness alone—to decide when a person is speaking."><CustomSelect ariaLabel="Voice detection sensitivity" value={interaction.wakeSensitivity} options={sensitivities} onChange={(wakeSensitivity) => change({ wakeSensitivity: wakeSensitivity as typeof interaction.wakeSensitivity })} /></SettingRow>
    <SettingRow title="Background noise suppression" description="Always on and processed locally before Silero VAD. The level changes filtering strength; High also requests voice isolation when supported by this Mac’s audio stack."><CustomSelect ariaLabel="Noise suppression level" value={interaction.noiseSuppressionLevel} options={suppressionLevels} onChange={(noiseSuppressionLevel) => change({ noiseSuppressionLevel: noiseSuppressionLevel as typeof interaction.noiseSuppressionLevel })} /></SettingRow>
    <SettingRow title="Automatic noise calibration" description="Learns a slow in-memory room-noise floor from frames Silero classifies as non-speech. No microphone samples are retained."><Toggle label="Automatic noise calibration" checked={interaction.automaticNoiseCalibration} onChange={(automaticNoiseCalibration) => change({ automaticNoiseCalibration })} /></SettingRow>
    <SettingRow title="Local speech recognition" description="Hands-free wake phrases and command segments are checked only by local Whisper; service errors are shown here rather than spoken aloud."><span role="status">{speechService}</span></SettingRow>
    <SettingRow title="Wake phrases" description="Comma-separated names and phrases. “Athena” and “Hey Athena” are included by default."><div className="voice-shortcut-setting"><input aria-label="Wake phrases" value={phrases} onChange={(event) => setPhrases(event.target.value)} onBlur={savePhrases} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); savePhrases() } }} /><button type="button" className="button secondary" onClick={savePhrases}>Save</button></div></SettingRow>
    <SettingRow title="Conversational follow-up" description="Continue speaking without repeating Athena’s name for a short window after she responds."><Toggle label="Conversational follow-up" checked={interaction.followUpEnabled} onChange={(followUpEnabled) => change({ followUpEnabled })} /></SettingRow>
    <div className="slider-row"><Slider label="Follow-up timeout" value={interaction.followUpTimeoutSeconds} min={5} max={60} step={1} unit=" sec" ends={['5 sec', '60 sec']} onChange={(followUpTimeoutSeconds) => change({ followUpTimeoutSeconds })} /></div>
    <div className="slider-row"><Slider label="End-of-speech delay" value={interaction.endOfSpeechDelayMs} min={300} max={1500} step={50} unit=" ms" ends={['300 ms', '1.5 sec']} onChange={(endOfSpeechDelayMs) => change({ endOfSpeechDelayMs })} /></div>
    <SettingRow title="Adaptive voice reasoning" description="Use low effort for simple conversation, medium for general questions, and high for complex requests when the selected model supports it. The selected provider and model never change. Turn this off to use the conversation’s selected effort."><Toggle label="Adaptive voice reasoning" checked={interaction.adaptiveVoiceReasoning} onChange={(adaptiveVoiceReasoning) => change({ adaptiveVoiceReasoning })} /></SettingRow>
    <div className="slider-row"><Slider label="Voice AI response timeout" value={interaction.aiResponseTimeoutSeconds} min={30} max={600} step={15} unit=" sec" ends={['30 sec', '10 min']} onChange={(aiResponseTimeoutSeconds) => change({ aiResponseTimeoutSeconds })} /></div>
    <SettingRow title="Allow speech interruption" description="Speaking over Athena stops playback immediately and routes your new utterance through local recognition."><Toggle label="Allow speech interruption" checked={interaction.allowSpeechInterruption} onChange={(allowSpeechInterruption) => change({ allowSpeechInterruption })} /></SettingRow>
    <SettingRow title="Spoken responses" description="Reply through Athena’s configured local voice. Turning this off keeps voice requests silent; it never falls back to cloud TTS."><Toggle label="Automatic spoken replies" checked={interaction.autoVoiceResponse} onChange={(autoVoiceResponse) => change({ autoVoiceResponse })} /></SettingRow>
    <SettingRow title="Floating indicators" description="Show compact status and latest voice-only reply near Athena without a waveform or chat transcript."><div className="voice-actions"><Toggle label="Show floating reply preview" checked={settings.showFloatingBubble} onChange={(showFloatingBubble) => void update({ showFloatingBubble })} /><Toggle label="Show active project" checked={settings.showFloatingProject} onChange={(showFloatingProject) => void update({ showFloatingProject })} /></div></SettingRow>
    <p className="chat-privacy-note">Wake detection uses short-utterance local Whisper recognition with silence endpointing. It is less lightweight than a dedicated trained wake-word model, but does not require cloud inference, a vendor account, or an Athena-specific model. Configure the local Whisper engine and model in My Athena → Local AI setup → Local voice.</p>
    {notice && <p role="status" className="chat-message-note">{notice}</p>}
  </Section>
}
