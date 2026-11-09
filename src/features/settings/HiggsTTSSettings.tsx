import { useEffect, useState } from 'react'
import { desktop } from '../../services/desktop'
import { SettingRow, Toggle } from '../../components/ui/Controls'
import { CustomSelect } from '../../components/ui/CustomSelect'
import { HIGGS_LICENSE_NOTE, HIGGS_PROFILE_NAME, type HiggsCommand, type HiggsStatus } from '../../../shared/higgsTTS'
import type { Settings } from '../../../shared/settings'

export function HiggsTTSSettings({ value, change }: { value: Settings['localVoice']['higgs']; change(value: Settings['localVoice']['higgs']): void }) {
  const [status, setStatus] = useState<HiggsStatus>()
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [transcript, setTranscript] = useState('')
  const [authorized, setAuthorized] = useState(false)
  const refresh = async () => { const result = await desktop.higgsTTS({ action: 'status' }); if (result.status) setStatus(result.status); if (!result.ok) setNotice(result.message ?? 'Status unavailable.') }
  useEffect(() => { let active = true; void desktop.higgsTTS({ action: 'status' }).then(result => { if (active) { setStatus(result.status); if (!result.ok) setNotice(result.message ?? 'Status unavailable.') } }); return () => { active = false } }, [])
  useEffect(() => { if (!busy && !status?.busy) return; const timer = window.setInterval(() => void refresh(), 2000); return () => window.clearInterval(timer) }, [busy, status?.busy])
  const run = async (command: HiggsCommand) => {
    setBusy(true); setNotice('')
    try {
      const result = await desktop.higgsTTS(command)
      if (result.status) setStatus(result.status)
      setNotice(result.message ?? (result.ok ? 'Saved.' : 'Operation did not complete.'))
      if (result.referenceId) { change({ ...value, referenceId: result.referenceId }); setTranscript(''); setAuthorized(false) }
      if (result.ok && command.action === 'remove-reference' && command.id === value.referenceId) change({ ...value, referenceId: undefined })
    } catch { setNotice('Higgs could not complete the request. Check its isolated runtime and Hugging Face access.') }
    finally { setBusy(false) }
  }
  const reference = status?.references.find(item => item.id === value.referenceId)
  const referenceOptions = [{ value: '', label: 'Model default · unconditioned' }, ...(status?.references ?? []).map(item => ({ value: item.id, label: item.name }))]
  const progress = typeof status?.progress === 'number' ? Math.round(status.progress * 100) : undefined
  return <>
    <SettingRow title="Higgs TTS 3 installation" description="Isolated Transformers runtime · bosonai/higgs-tts-3-4b · no SGLang CUDA stack. Downloads require confirmation. Chatterbox and Sesame files are never overwritten."><div className="voice-actions">
      <button className="chat-action" disabled={busy || status?.busy} onClick={() => void run({ action: 'setup' })}>{status?.runtime ? 'Repair runtime' : 'Install runtime'}</button>
      <button className="chat-action" disabled={busy || status?.busy || !status?.runtime || status.compatible === false} title={status?.compatibilityMessage} onClick={() => void run({ action: 'download' })}>Download official model</button>
      <button className="chat-action" disabled={busy || status?.busy || !status?.downloaded} onClick={() => void run({ action: 'verify' })}>Verify model files</button>
      <button className="chat-action" onClick={() => void run({ action: 'cancel' })} disabled={!busy && !status?.busy}>Cancel</button>
      <button className="chat-action" onClick={() => void run({ action: 'unload' })}>Unload</button>
      <button className="chat-action" disabled={busy || status?.busy || !status?.downloaded} onClick={() => void run({ action: 'remove' })}>Remove model files…</button>
      <button className="chat-action" onClick={() => void refresh()}>Refresh status</button>
    </div></SettingRow>
    <p role="status" className="chat-message-note">{status?.stage ?? 'Checking Higgs TTS 3…'}{status?.busy ? ' · In progress' : ''}{progress !== undefined ? ` · ${progress}%` : ''}{status?.error ? ` · ${status.error}` : ''}</p>
    {status?.compatible === false && <p role="alert" className="chat-message-note">{status.compatibilityMessage}</p>}
    {status?.busy && progress !== undefined && <progress aria-label="Higgs download progress" max={100} value={progress} />}
    <SettingRow title="Voice profile" description="Independent Higgs profile. Chatterbox and Sesame references are not reused automatically."><span>{value.profileName || HIGGS_PROFILE_NAME}</span></SettingRow>
    <SettingRow title="Inference device" description="Device preference is preserved. Apple MPS availability alone does not verify Higgs compatibility. Device fallback is disabled."><CustomSelect ariaLabel="Higgs inference device" value={value.device} options={[{ value: 'mps', label: 'Apple MPS' }, { value: 'cpu', label: 'CPU' }, { value: 'cuda', label: 'CUDA · requires NVIDIA GPU' }]} onChange={device => change({ ...value, device: device as typeof value.device })} /></SettingRow>
    <SettingRow title="Preferred language" description="Saved for Higgs speech. English and Tagalog are documented by the model; local generation must pass runtime compatibility first."><CustomSelect ariaLabel="Higgs language" value={value.language} options={[{ value: 'en', label: 'English' }, { value: 'tl', label: 'Tagalog' }, { value: 'auto', label: 'Model default' }]} onChange={language => change({ ...value, language: language as typeof value.language })} /></SettingRow>
    <SettingRow title="Preferred speaking style"><CustomSelect ariaLabel="Higgs speaking style" value={value.style} options={[{ value: 'auto', label: 'Natural · no style token' }, { value: 'whispering', label: 'Whispering' }, { value: 'shouting', label: 'Shouting' }, { value: 'singing', label: 'Singing' }]} onChange={style => change({ ...value, style: style as typeof value.style })} /></SettingRow>
    <SettingRow title="Emotion preference" description="Auto applies documented sentence-level tokens only when the reply itself is amused, excited, or thoughtful."><CustomSelect ariaLabel="Higgs emotion preference" value={value.emotionPreference} options={[{ value: 'auto', label: 'Context-aware' }, { value: 'amusement', label: 'Amusement' }, { value: 'enthusiasm', label: 'Enthusiasm' }, { value: 'contemplation', label: 'Contemplation' }]} onChange={emotionPreference => change({ ...value, emotionPreference: emotionPreference as typeof value.emotionPreference })} /></SettingRow>
    <SettingRow title="Laughter frequency" description="Uses official <|sfx:laughter|> with vocalization text. Never fakes laughter by inserting plain “haha” into another engine."><CustomSelect ariaLabel="Higgs laughter frequency" value={value.laughterFrequency} options={[{ value: 'contextual', label: 'Contextual' }, { value: 'rare', label: 'Only when the reply is already amused' }, { value: 'off', label: 'Off' }]} onChange={laughterFrequency => change({ ...value, laughterFrequency: laughterFrequency as typeof value.laughterFrequency })} /></SettingRow>
    <SettingRow title="Higgs reference recording" description="Import an authorized 1–20 second WAV and its exact transcript. Athena will not clone a voice without this confirmation, and will not copy Chatterbox or Sesame audio automatically."><CustomSelect ariaLabel="Higgs reference" value={value.referenceId ?? ''} options={referenceOptions} onChange={referenceId => change({ ...value, referenceId: referenceId || undefined })} /></SettingRow>
    {reference && <div className="chat-message-note"><p>{reference.name} · {reference.seconds.toFixed(1)} seconds</p><p>{reference.transcript}</p><button className="chat-action" disabled={busy} onClick={() => void run({ action: 'remove-reference', id: reference.id })}>Remove reference…</button></div>}
    <SettingRow title="Matching reference transcript"><textarea aria-label="Higgs reference transcript" maxLength={1200} value={transcript} onChange={event => setTranscript(event.target.value)} placeholder="Exactly what is spoken in the recording" /></SettingRow>
    <SettingRow title="I have permission to use this recording and voice"><Toggle label="Authorized Higgs reference" checked={authorized} onChange={setAuthorized} /></SettingRow>
    <SettingRow title="Add reference" description="Only a private Higgs copy is stored. Other engines are unchanged."><button className="chat-action" disabled={busy || !status?.runtime || !authorized || !transcript.trim()} onClick={() => void run({ action: 'import-reference', transcript: transcript.trim(), authorized: true })}>Import authorized WAV…</button></SettingRow>
    {status?.device && <p className="chat-message-note">Active inference device: {status.device}{status.loaded ? ' · model loaded' : ''}{status.architecture ? ` · ${status.architecture}` : ''}{status.streaming ? ' · streaming reported by checkpoint' : ' · complete-utterance generation (no verified local streaming)'}</p>}
    {status?.metrics && <p className="chat-message-note">Measured on {status.metrics.device}: load {(status.metrics.loadMs / 1000).toFixed(2)} s · generation {(status.metrics.generationMs / 1000).toFixed(2)} s · first audio {(status.metrics.firstAudioMs / 1000).toFixed(2)} s · audio {status.metrics.audioSeconds.toFixed(2)} s · process peak {(status.metrics.peakProcessBytes / 1024 ** 3).toFixed(2)} GiB. Process peak is not total unified-memory usage.</p>}
    {status?.memoryWarning && <p className="chat-message-note">{status.memoryWarning}</p>}
    <p className="chat-message-note">{HIGGS_LICENSE_NOTE}</p>
    {notice && <p role="status" className="chat-message-note">{notice}</p>}
  </>
}
