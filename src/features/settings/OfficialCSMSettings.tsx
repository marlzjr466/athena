import { useEffect, useState } from 'react'
import { desktop } from '../../services/desktop'
import { SettingRow, Toggle } from '../../components/ui/Controls'
import { CustomSelect } from '../../components/ui/CustomSelect'
import { ATHENA_CSM_REFERENCE_ID, type CSMStatus, type OfficialCSMCommand } from '../../../shared/officialCSM'
import type { Settings } from '../../../shared/settings'

export function OfficialCSMSettings({ value, change }: { value: Settings['localVoice']['officialCSM']; change(value: Settings['localVoice']['officialCSM']): void }) {
  const [status, setStatus] = useState<CSMStatus>()
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [transcript, setTranscript] = useState('')
  const [authorized, setAuthorized] = useState(false)
  const refresh = async () => { const result = await desktop.officialCSM({ action: 'status' }); if (result.status) setStatus(result.status); if (!result.ok) setNotice(result.message ?? 'Status unavailable.') }
  useEffect(() => { let active = true; void desktop.officialCSM({ action: 'status' }).then(result => { if (active) { setStatus(result.status); if (!result.ok) setNotice(result.message ?? 'Status unavailable.') } }); return () => { active = false } }, [])
  useEffect(() => { if (!busy && !status?.busy) return; const timer = window.setInterval(() => void refresh(), 2000); return () => clearInterval(timer) }, [busy, status?.busy])
  const run = async (command: OfficialCSMCommand) => {
    setBusy(true); setNotice('')
    try {
      const result = await desktop.officialCSM(command)
      if (result.status) setStatus(result.status)
      setNotice(result.message ?? (result.ok ? 'Saved.' : 'Operation did not complete.'))
      if (result.referenceId) { change({ ...value, referenceId: result.referenceId }); setTranscript(''); setAuthorized(false) }
      if (result.ok && command.action === 'remove-reference' && command.id === value.referenceId) change({ ...value, referenceId: undefined })
    } catch { setNotice('Official CSM could not complete the request. Check its runtime and gated-model access.') }
    finally { setBusy(false) }
  }
  const reference = status?.references.find(item => item.id === value.referenceId)
  const referenceOptions = [{ value: '', label: status?.automaticReferenceAvailable ? 'Athena stable voice · automatic' : 'No reference available' }, ...(status?.references ?? []).filter(item => item.id !== ATHENA_CSM_REFERENCE_ID).map(item => ({ value: item.id, label: `${item.name} · speaker ${item.speaker}` }))]
  return <>
    <SettingRow title="Official Sesame installation" description="Isolated PyTorch runtime · SesameAILabs/csm · no MLX. Downloads require confirmation and your own Hugging Face gated-model access."><div className="voice-actions">
      <button className="chat-action" disabled={busy || status?.busy} onClick={() => void run({ action: 'setup' })}>{status?.runtime ? 'Repair runtime' : 'Install runtime'}</button>
      <button className="chat-action" disabled={busy || status?.busy || !status?.runtime} onClick={() => void run({ action: 'download' })}>Download official models</button>
      <button className="chat-action" onClick={() => void run({ action: 'cancel' })} disabled={!busy && !status?.busy}>Cancel</button>
      <button className="chat-action" onClick={() => void run({ action: 'unload' })}>Unload</button>
      <button className="chat-action" onClick={() => void refresh()}>Refresh status</button>
    </div></SettingRow>
    <p role="status" className="chat-message-note">{status?.stage ?? 'Checking official CSM…'}{status?.busy ? ' · In progress (indeterminate)' : ''}{status?.error ? ` · ${status.error}` : ''}</p>
    <SettingRow title="Inference device" description="CPU is the conservative official example path. MPS is experimental and may fail on unsupported operations; Athena never silently changes the device or engine."><CustomSelect ariaLabel="Sesame inference device" value={value.device} options={[{ value: 'cpu', label: 'CPU' }, { value: 'mps', label: 'Apple MPS · experimental' }, { value: 'cuda', label: 'CUDA · requires NVIDIA GPU' }]} onChange={device => change({ ...value, device: device as typeof value.device })} /></SettingRow>
    <SettingRow title="Speaker identity" description="An identity in the speech context—not a Maya voice preset. Use the same identity as your reference for a consistent voice."><CustomSelect ariaLabel="Sesame speaker" value={String(value.speaker)} options={[{ value: '0', label: 'Speaker 0' }, { value: '1', label: 'Speaker 1' }]} onChange={speaker => change({ ...value, speaker: Number(speaker) })} /></SettingRow>
    <SettingRow title="Speech context" description="Official Segment text/audio conditioning is kept within one generated response so longer replies stay coherent. Earlier floating turns are not reused as voice conditioning, which prevents speaker and accent drift."><Toggle label="Sesame speech context" checked={value.context} onChange={context => change({ ...value, context })} /></SettingRow>
    <SettingRow title="Sesame reference recording" description="Athena automatically uses a private copy of a verified US-English reference to keep one Sesame voice and reduce accent drift. You can replace it with an authorized 1–20 second WAV and its exact transcript; Chatterbox settings are unchanged."><CustomSelect ariaLabel="Sesame reference" value={value.referenceId ?? ''} options={referenceOptions} onChange={referenceId => change({ ...value, referenceId: referenceId || undefined })} /></SettingRow>
    {reference && <div className="chat-message-note"><p>{reference.name} · {reference.seconds.toFixed(1)} seconds · speaker {reference.speaker}</p><p>{reference.transcript}</p><button className="chat-action" disabled={busy} onClick={() => void run({ action: 'remove-reference', id: reference.id })}>Remove reference…</button></div>}
    <SettingRow title="Matching reference transcript"><textarea aria-label="Sesame reference transcript" maxLength={1200} value={transcript} onChange={event => setTranscript(event.target.value)} placeholder="Exactly what is spoken in the recording" /></SettingRow>
    <SettingRow title="I have permission to use this recording and voice"><Toggle label="Authorized Sesame reference" checked={authorized} onChange={setAuthorized} /></SettingRow>
    <SettingRow title="Add reference" description="Only a private copy is stored. The source recording is not changed."><button className="chat-action" disabled={busy || !status?.runtime || !authorized || !transcript.trim()} onClick={() => void run({ action: 'import-reference', transcript: transcript.trim(), speaker: value.speaker, authorized: true })}>Import authorized WAV…</button></SettingRow>
    <p className="chat-message-note">CSM produces complete audio segments, not streaming audio. Its original watermark is preserved. Expressiveness sliders and Chatterbox laughter tags do not apply; cadence and emotion depend on genuine text/audio context. The released base model is not Sesame’s production Maya voice.</p>
    {status?.metrics && <p className="chat-message-note">Measured on {status.metrics.device}: load {(status.metrics.loadMs / 1000).toFixed(2)} s · generation {(status.metrics.generationMs / 1000).toFixed(2)} s · first complete audio {(status.metrics.totalMs / 1000).toFixed(2)} s · audio {status.metrics.audioSeconds.toFixed(2)} s · process peak {(status.metrics.peakProcessBytes / 1024 ** 3).toFixed(2)} GiB · {status.metrics.contextSegments} context segments. Process peak is not total unified-memory usage.</p>}
    {notice && <p role="status" className="chat-message-note">{notice}</p>}
  </>
}
