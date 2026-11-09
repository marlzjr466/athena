import { useEffect, useRef, useState } from 'react'
import { Square, Volume2 } from 'lucide-react'
import { useAthena } from '../../store/athenaStore'
import { Section, SettingRow, Slider, Toggle } from '../../components/ui/Controls'
import { CustomSelect } from '../../components/ui/CustomSelect'
import { desktop } from '../../services/desktop'
import { VoiceInteractionSettings } from './VoiceInteractionSettings'
import { OfficialCSMSettings } from './OfficialCSMSettings'
import { HiggsTTSSettings } from './HiggsTTSSettings'
import { isHiggsEngine, isSesameEngine } from '../../../shared/localVoice'

export function VoiceSettings() {
  const { snapshot, update } = useAthena()
  const [notice, setNotice] = useState('')
  const [previewing, setPreviewing] = useState(false)
  const [samples, setSamples] = useState<Array<{ bytes: Uint8Array; text: string; label: string }>>([])
  const audio = useRef<HTMLAudioElement | undefined>(undefined)
  const url = useRef<string | undefined>(undefined)
  const generation = useRef(0)
  const active = useRef(false)
  const clear = () => {
    generation.current++; active.current = false
    if (audio.current) { audio.current.onended = null; audio.current.onerror = null; audio.current.pause(); audio.current.removeAttribute('src'); audio.current.load() }
    audio.current = undefined
    if (url.current) URL.revokeObjectURL(url.current)
    url.current = undefined
    setPreviewing(false)
  }
  const stop = () => { clear(); return desktop.stopAllSpeech() }
  useEffect(() => {
    const off = desktop.onLocalVoicePlaybackStopped(clear)
    return () => { off(); const wasActive = active.current; clear(); if (wasActive) void desktop.stopAllSpeech() }
  }, [])
  useEffect(() => { setNotice('') }, [snapshot?.settings.localVoice.engine])
  if (!snapshot) return null
  const settings = snapshot.settings, voice = settings.localVoice
  const change = (patch: Partial<typeof voice>) => void update({ localVoice: { ...voice, ...patch } })
  const officialSelected = isSesameEngine(voice.engine)
  const higgsSelected = isHiggsEngine(voice.engine)
  const voiceEngine = officialSelected ? 'sesame-csm-official' : higgsSelected ? 'higgs-tts-3-4b' : 'chatterbox-turbo'
  const engineLabel = officialSelected ? 'Sesame CSM-1B' : higgsSelected ? 'Higgs TTS 3 4B' : 'Chatterbox Turbo'
  const playBytes = async (bytes: Uint8Array, token: number, mimeType = 'audio/wav') => {
    const objectURL = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mimeType }))
    url.current = objectURL
    const player = new Audio(objectURL); audio.current = player
    player.volume = settings.voiceVolume; player.playbackRate = settings.voiceSpeed
    player.onended = () => { if (token === generation.current) clear() }
    player.onerror = () => { if (token === generation.current) { clear(); setNotice('Audio playback failed. Check your output device.') } }
    await player.play(); if (token === generation.current) setNotice('')
  }
  const replay = async (sample: typeof samples[number]) => {
    const stopped = stop(), token = generation.current
    await stopped
    if (token !== generation.current) return
    active.current = true; setPreviewing(true)
    try { await playBytes(sample.bytes, token) }
    catch { if (token === generation.current) { clear(); setNotice('Sample playback failed.') } }
  }
  const play = async () => {
    const stopped = stop(), token = generation.current
    await stopped
    if (token !== generation.current) return
    active.current = true; setPreviewing(true); setNotice('Preparing Athena’s natural voice…')
    try {
      const result = await desktop.previewLocalVoice()
      if (token !== generation.current) return
      if (!result.ok || !result.bytes?.length) throw new Error(result.message ?? 'Natural voice preview failed.')
      const label = officialSelected
        ? `Sesame · speaker ${voice.officialCSM.speaker} · ${voice.officialCSM.device}`
        : higgsSelected
          ? `Higgs TTS 3 · ${voice.higgs.device} · ${voice.higgs.referenceId ? 'reference ' + voice.higgs.referenceId.slice(0, 8) : 'unconditioned'}`
          : 'Chatterbox Turbo'
      setSamples(previous => [...previous.slice(-1), { bytes: result.bytes!, text: 'Athena’s standard preview', label }])
      await playBytes(result.bytes, token, result.mimeType)
    } catch (error) { if (token === generation.current) { clear(); setNotice(error instanceof Error ? error.message : 'Natural voice preview failed.') } }
  }
  return <div className="settings-page">
    <div className="page-heading"><div><h1>Voice</h1><p>Speech playback, microphone and hands-free conversation settings.</p></div></div>
    <Section title="Voice output" description="Local speech through your selected engine. Chatterbox, official Sesame, and Higgs TTS 3 keep independent configuration. No automatic engine fallback.">
      <SettingRow title="Voice Engine"><CustomSelect ariaLabel="Voice Engine" value={voiceEngine} options={[{ value: 'chatterbox-turbo', label: 'Chatterbox Turbo' }, { value: 'sesame-csm-official', label: 'Sesame CSM-1B · Official' }, { value: 'higgs-tts-3-4b', label: 'Higgs TTS 3 4B' }]} onChange={async engine => { await stop(); change({ engine: engine as typeof voiceEngine }) }} /></SettingRow>
      <SettingRow title="Enable Voice Output"><Toggle label="Enable Voice Output" checked={settings.voiceEnabled} onChange={voiceEnabled => { if (!voiceEnabled) void stop(); void update({ voiceEnabled }) }} /></SettingRow>
      <SettingRow title="Auto Speak Responses"><Toggle label="Auto Speak Responses" checked={voice.autoSpeak} onChange={autoSpeak => change({ autoSpeak })} /></SettingRow>
      <SettingRow title="Mute"><Toggle label="Mute" checked={settings.voiceMuted} onChange={voiceMuted => { if (voiceMuted) void stop(); void update({ voiceMuted }) }} /></SettingRow>
      <SettingRow title="Natural voice" description={officialSelected ? 'Official contextual speech · not a Maya preset' : higgsSelected ? 'Expressive conversational speech with natural laughter, emotion, prosody, and multilingual support.' : voice.profileId === 'athena-youthful' ? 'Athena Youthful · original Amy US-English reference' : 'Your previously selected authorized voice profile'}><span>{engineLabel}</span></SettingRow>
      <div className="slider-row"><Slider label="Expressiveness" disabled={officialSelected || higgsSelected} value={Math.round(voice.expressiveness * 100)} min={0} max={100} unit="%" ends={['Subtle', 'Expressive']} onChange={value => change({ expressiveness: value / 100 })} /></div>
      {officialSelected && <OfficialCSMSettings value={voice.officialCSM} change={officialCSM => change({ officialCSM })} />}
      {higgsSelected && <HiggsTTSSettings value={voice.higgs} change={higgs => change({ higgs })} />}
      <div className="slider-row"><Slider label="Speech Speed" value={settings.voiceSpeed} min={0.5} max={2} step={0.05} unit="×" ends={['0.5×', '2×']} onChange={voiceSpeed => void update({ voiceSpeed })} /></div>
      <div className="slider-row"><Slider label="Volume" value={Math.round(settings.voiceVolume * 100)} min={0} max={100} unit="%" ends={['Quiet', 'Full']} onChange={value => void update({ voiceVolume: value / 100 })} /></div>
      <SettingRow title="Preview and playback"><div className="voice-actions"><button className="chat-action" disabled={previewing || !settings.voiceEnabled || settings.voiceMuted || settings.doNotDisturb} onClick={() => void play()}><Volume2 size={16} />Preview Voice</button><button className="chat-action" onClick={() => void stop()}><Square size={14} />Stop Speaking</button></div></SettingRow>
      {samples.length > 0 && <SettingRow title="Compare generated previews" description="Only the last two actual previews from the selected engine, held in memory until you leave this page. Audio is never relabeled as another engine."><div className="voice-actions">{samples.map((sample, index) => <div key={index}><p>{sample.label}</p><p>{sample.text}</p><button className="chat-action" disabled={previewing || !settings.voiceEnabled || settings.voiceMuted || settings.doNotDisturb} onClick={() => void replay(sample)}>Listen to sample {index + 1}</button></div>)}<button className="chat-action" onClick={() => { void stop(); setSamples([]) }}>Clear previews</button></div></SettingRow>}
      <SettingRow title="Auto-send chat dictation" description="Only affects chat dictation; floating voice conversations remain separate."><Toggle label="Auto-send chat dictation" checked={settings.voiceAutoSend} onChange={voiceAutoSend => void update({ voiceAutoSend })} /></SettingRow>
    </Section>
    <Section title="Natural action responses" description="Announcements describe authorized local tasks only; they never grant permission or imply success.">
      <SettingRow title="Enable Natural Acknowledgments"><Toggle label="Enable Natural Acknowledgments" checked={voice.naturalAcknowledgments} onChange={naturalAcknowledgments => change({ naturalAcknowledgments })} /></SettingRow>
      <SettingRow title="Speak Before Actions"><Toggle label="Speak Before Actions" checked={voice.speakBeforeActions} onChange={speakBeforeActions => change({ speakBeforeActions })} /></SettingRow>
      <SettingRow title="Spoken Progress Updates"><Toggle label="Spoken Progress Updates" checked={voice.spokenProgress} onChange={spokenProgress => change({ spokenProgress })} /></SettingRow>
      <div className="slider-row"><Slider label="Progress Update Frequency" value={voice.progressIntervalSeconds} min={30} max={300} step={15} unit=" sec" ends={['30 sec', '5 min']} onChange={progressIntervalSeconds => change({ progressIntervalSeconds })} /></div>
      <SettingRow title="Completion Announcements"><Toggle label="Completion Announcements" checked={voice.completionAnnouncements} onChange={completionAnnouncements => change({ completionAnnouncements })} /></SettingRow>
      <SettingRow title="Allow Speech Interruption"><Toggle label="Allow Speech Interruption" checked={voice.allowSpeechInterruption} onChange={allowSpeechInterruption => change({ allowSpeechInterruption })} /></SettingRow>
    </Section>
    <VoiceInteractionSettings />
    {notice && <p role="status" className="chat-message-note">{notice}</p>}
  </div>
}
