import { useState } from 'react'
import { Section, SettingRow, Toggle } from '../../components/ui/Controls'
import { CustomSelect } from '../../components/ui/CustomSelect'
import { academyComparison, type AcademyCommand, type AcademyCorrection, type AcademyProfile, type AcademySnapshot, type AcademyEvaluationTrack } from '../../../shared/academy'
import type { LocalModel } from '../../../shared/localAI'
import { AcademyTrainingPanel } from './AcademyTrainingPanel'

type CorrectionKind = AcademyCorrection['kind']
const kinds: Array<{ value: CorrectionKind; label: string }> = [
  { value: 'code', label: 'Verified code solution' }, { value: 'convention', label: 'Coding convention' },
  { value: 'explanation', label: 'Corrected explanation' }, { value: 'format', label: 'Preferred response format' },
  { value: 'workflow', label: 'Successful workflow' },
]

export function AcademyAdvanced({ model, selectedModel, profile, snapshot, track, busy, run }: {
  model: string; selectedModel?: LocalModel; profile: AcademyProfile; snapshot: AcademySnapshot; track: AcademyEvaluationTrack;
  busy: boolean; run(command: AcademyCommand): Promise<void>
}) {
  const [kind, setKind] = useState<CorrectionKind>('explanation')
  const [prompt, setPrompt] = useState('')
  const [correction, setCorrection] = useState('')
  const [evidence, setEvidence] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const entries = (snapshot.corrections ?? []).filter(item => item.model === model)
  const comparable = academyComparison(snapshot, track)
  const clear = () => { setEditingId(null); setKind('explanation'); setPrompt(''); setCorrection(''); setEvidence('') }
  const edit = (entry: AcademyCorrection) => { setEditingId(entry.id); setKind(entry.kind); setPrompt(entry.prompt); setCorrection(entry.correction); setEvidence(entry.evidence) }
  const submit = async () => {
    await run(editingId ? { action: 'update-correction', model, id: editingId, kind, prompt, correction, evidence } : { action: 'save-correction', model, kind, prompt, correction, evidence })
    // Keep the form on failure; the user can clear it explicitly after checking the status.
  }
  return <>
    <Section title="Compare local models" description="Scores are comparable only within the same small prompt track and each model's current digest. A delta is not proof of broad capability or of fine-tuning improvement.">
      <p className="chat-message-note">Track: {track}. Run a fresh evaluation for each model to populate a like-for-like comparison.</p>
      <div className="academy-comparison"><h3>Current model versions</h3>{comparable.map(item => <p key={item.model}><span>{item.model}</span><span>{item.latest ? `${item.latest.passed}/${item.latest.total}${item.previous ? ` · prior ${item.previous.passed}/${item.previous.total}` : ''}` : item.digest ? 'No current-digest result' : 'Digest unavailable'}</span></p>)}</div>
    </Section>
    <Section title="Learn from verified corrections" description="You approve and control each reusable example. These records stay in this model's private Academy profile; they are not weight updates or cloud training data.">
      <SettingRow title="Use matching corrections" description="Off by default. When on, up to two relevant examples for this exact model digest may be added to new local requests; they never grant tool permissions."><Toggle label="Learn from verified corrections" checked={profile.learnFromCorrections} onChange={enabled => void run({ action: 'learning-toggle', model, enabled })} /></SettingRow>
      {!profile.digest && <p className="chat-message-note">Ollama has not reported a stable digest. Athena will not apply saved examples until this model version can be verified.</p>}
      <div className="academy-studio-fields">
        <label htmlFor="academy-correction-kind">Correction type</label><CustomSelect ariaLabel="Correction type" value={kind} options={kinds} onChange={value => setKind(value as CorrectionKind)} />
        <label htmlFor="academy-correction-prompt">Original request or situation</label><textarea id="academy-correction-prompt" value={prompt} maxLength={1200} onChange={event => setPrompt(event.target.value)} placeholder="Describe when this correction is relevant…" />
        <label htmlFor="academy-correction-answer">Verified correction</label><textarea id="academy-correction-answer" value={correction} maxLength={2400} onChange={event => setCorrection(event.target.value)} placeholder="Enter the solution or preference you personally verified…" />
        <label htmlFor="academy-correction-evidence">How was it verified?</label><textarea id="academy-correction-evidence" value={evidence} maxLength={1200} onChange={event => setEvidence(event.target.value)} placeholder="For example, test result, file review, or your own confirmation…" />
        <div className="academy-inline-actions"><button type="button" className="button secondary" disabled={busy || !profile.digest || prompt.trim().length < 4 || correction.trim().length < 4 || evidence.trim().length < 4} onClick={() => void submit()}>{editingId ? 'Save correction changes' : 'Save verified correction'}</button>{editingId && <button type="button" className="button secondary" onClick={clear}>Cancel editing</button>}<button type="button" className="button secondary" disabled={busy || !entries.length} onClick={() => void run({ action: 'export-corrections', model })}>Export my corrections</button></div>
      </div>
      {entries.map(entry => <details key={entry.id} className="academy-studio-record"><summary>{entry.kind} · {entry.prompt.slice(0, 100)}{entry.digest !== profile.digest ? ' · older model version' : ''}</summary><p><strong>Correction:</strong> {entry.correction}</p><p><strong>Verification:</strong> {entry.evidence}</p><div className="academy-inline-actions"><button type="button" className="button secondary" disabled={busy} onClick={() => edit(entry)}>Edit</button><button type="button" className="button secondary" disabled={busy} onClick={() => void run({ action: 'remove-correction', id: entry.id })}>Delete</button></div></details>)}
      {!entries.length && <p className="chat-message-note">No approved corrections for this model yet.</p>}
    </Section>
    {selectedModel && <AcademyTrainingPanel model={selectedModel} />}
  </>
}
