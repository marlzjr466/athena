import { useEffect, useState } from 'react'
import { Section } from '../../components/ui/Controls'
import { CustomSelect } from '../../components/ui/CustomSelect'
import { desktop } from '../../services/desktop'
import { codingChallengeDescriptions, codingChallengeIds, type AcademyStudioCommand, type AcademyStudioSnapshot, type CodingChallengeId, type InterviewMode } from '../../../shared/academyStudio'

const empty: AcademyStudioSnapshot = { meetings: [], interviews: [], attempts: [] }
export function AcademyStudio({ model }: { model: string }) {
  const [data, setData] = useState<AcademyStudioSnapshot>(empty)
  const [transcript, setTranscript] = useState('')
  const [topic, setTopic] = useState('')
  const [mode, setMode] = useState<InterviewMode>('practice')
  const [answer, setAnswer] = useState('')
  const [search, setSearch] = useState('')
  const [challenge, setChallenge] = useState<CodingChallengeId>('sum-pairs')
  const [code, setCode] = useState(codingChallengeDescriptions['sum-pairs'].starter)
  const [hintsShown, setHintsShown] = useState(0)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const available = typeof desktop.getAcademyStudio === 'function' && typeof desktop.academyStudioCommand === 'function'
  useEffect(() => {
    if (!available) { setNotice('Practice & Notes will be available after the next authorized Athena app restart.'); return }
    let mounted = true
    void desktop.getAcademyStudio().then(value => { if (mounted) setData({ ...value, attempts: value.attempts ?? [] }) }).catch(() => { if (mounted) setNotice('Practice & Notes history is unavailable.') })
    return () => { mounted = false }
  }, [available])
  const run = async (command: AcademyStudioCommand) => {
    if (!available) return
    setBusy(true); setNotice('')
    try {
      const result = await desktop.academyStudioCommand(command)
      setData({ ...result.snapshot, attempts: result.snapshot.attempts ?? [] })
      setNotice(result.message ?? (result.ok ? 'Saved locally for this model.' : 'The local request did not complete.'))
      if (result.transcript) setTranscript(result.transcript)
      if (result.ok && command.action === 'prepare-meeting') setTranscript('')
      if (result.ok && command.action === 'answer-interview') setAnswer('')
    } catch { setNotice('The local request failed; no completion was recorded.') }
    finally { setBusy(false) }
  }
  const modelInterviews = data.interviews.filter(item => item.model === model)
  const pending = modelInterviews.find(item => !item.answer)
  const meetings = data.meetings.filter(item => item.model === model && `${item.summary} ${item.transcript}`.toLowerCase().includes(search.toLowerCase()))
  const attempts = data.attempts.filter(item => item.model === model)
  return <>
    <Section title="Interview practice" description="Ask a question and receive constructive feedback through the selected local Ollama model. This is practice—not covert assistance or an objectively scored assessment.">
      <div className="academy-studio-fields">
        <label htmlFor="academy-interview-topic">Topic</label><input id="academy-interview-topic" value={topic} maxLength={120} onChange={event => setTopic(event.target.value)} placeholder="For example, React architecture or system design" disabled={!available || busy} />
        <label htmlFor="academy-interview-mode">Response mode</label><CustomSelect ariaLabel="Interview response mode" value={mode} options={[{ value: 'practice', label: 'Interview Practice' }, { value: 'quick', label: 'Quick Answer' }, { value: 'detailed', label: 'Detailed Answer' }, { value: 'technical', label: 'Technical Answer' }]} onChange={value => setMode(value as InterviewMode)} />
        <button type="button" className="button secondary" disabled={!available || busy || !topic.trim()} onClick={() => void run({ action: 'start-interview', model, topic: topic.trim(), mode })}>Ask practice question</button>
      </div>
      {pending && <div className="academy-studio-record"><strong>{pending.topic} · {pending.mode}</strong><p>{pending.question}</p><label htmlFor="academy-interview-answer">Your answer</label><textarea id="academy-interview-answer" value={answer} maxLength={6000} onChange={event => setAnswer(event.target.value)} disabled={busy} /><button type="button" className="button secondary" disabled={busy || !answer.trim()} onClick={() => void run({ action: 'answer-interview', id: pending.id, answer: answer.trim() })}>Get local feedback</button></div>}
      {modelInterviews.filter(item => item.feedback).slice(0, 10).map(item => <details className="academy-studio-record" key={item.id}><summary>{item.topic} · {new Date(item.createdAt).toLocaleString()}</summary><p><strong>Question:</strong> {item.question}</p><p><strong>Your answer:</strong> {item.answer}</p><p><strong>Draft feedback:</strong> {item.feedback}</p><button type="button" className="button secondary" disabled={busy} onClick={() => void run({ action: 'delete-interview', id: item.id })}>Delete practice record</button></details>)}
    </Section>
    <Section title="Coding examination practice" description="Practice original JavaScript exercises. Submissions run in a bounded macOS sandbox with no network and only private temporary-file writes. This is self-practice, not help during a prohibited assessment.">
      <div className="academy-studio-fields">
        <label htmlFor="academy-coding-challenge">Challenge</label><CustomSelect ariaLabel="Coding practice challenge" value={challenge} options={codingChallengeIds.map(id => ({ value: id, label: codingChallengeDescriptions[id].title }))} onChange={value => { const id = value as CodingChallengeId; setChallenge(id); setCode(codingChallengeDescriptions[id].starter); setHintsShown(0) }} />
        <p>{codingChallengeDescriptions[challenge].prompt}</p>
        <div className="academy-inline-actions"><button type="button" className="button secondary" disabled={hintsShown >= codingChallengeDescriptions[challenge].hints.length} onClick={() => setHintsShown(value => value + 1)}>Show next hint</button><span>Hint {hintsShown}/{codingChallengeDescriptions[challenge].hints.length}</span></div>
        {codingChallengeDescriptions[challenge].hints.slice(0, hintsShown).map((hint, index) => <p key={index} className="chat-message-note">{hint}</p>)}
        <label htmlFor="academy-coding-solution">JavaScript solution · define function solve</label><textarea id="academy-coding-solution" className="academy-instructions academy-meeting-transcript" spellCheck={false} value={code} maxLength={12_000} onChange={event => setCode(event.target.value)} disabled={!available || busy} />
        <button type="button" className="button secondary" disabled={!available || busy || !code.trim()} onClick={() => void run({ action: 'run-coding-practice', model, challenge, code })}>Run isolated tests</button>
      </div>
      {attempts.slice(0, 10).map(attempt => <details className="academy-studio-record" key={attempt.id}><summary>{codingChallengeDescriptions[attempt.challenge].title} · {attempt.passed}/{attempt.total} checks · {new Date(attempt.createdAt).toLocaleString()}</summary><ul>{attempt.results.map((result, index) => <li key={index}>{result.passed ? 'Pass' : 'Not passed'} · {result.name} · {result.detail}</li>)}</ul><button type="button" className="button secondary" disabled={busy} onClick={() => void run({ action: 'delete-coding-attempt', id: attempt.id })}>Delete practice result</button></details>)}
    </Section>
    <Section title="Meeting notes" description="Paste an authorized transcript or explicitly import a short audio excerpt. Athena transcribes with local Whisper and uses only your selected local model for draft notes. No microphone or cloud AI service starts here.">
      <button type="button" className="button secondary" disabled={!available || busy} onClick={() => void run({ action: 'import-meeting-audio', model })}>Import audio and transcribe locally…</button>
      <label className="academy-field-label" htmlFor="academy-meeting-transcript">Transcript text · 20–12,000 characters</label>
      <textarea id="academy-meeting-transcript" className="academy-instructions academy-meeting-transcript" value={transcript} maxLength={12_000} onChange={event => setTranscript(event.target.value)} disabled={!available || busy} placeholder="Paste a transcript you are authorized to process…" />
      <div className="academy-inline-actions"><span>{transcript.length}/12,000</span><button type="button" className="button secondary" disabled={!available || busy || transcript.trim().length < 20} onClick={() => void run({ action: 'prepare-meeting', model, transcript: transcript.trim() })}>Prepare draft notes locally</button></div>
      <label className="academy-field-label" htmlFor="academy-meeting-search">Search saved notes</label><input id="academy-meeting-search" className="academy-studio-search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Search summary or transcript" />
      {meetings.map(note => <details className="academy-studio-record" key={note.id}><summary>{new Date(note.createdAt).toLocaleString()} · {note.summary.slice(0, 100)}</summary><p>{note.summary}</p><h3>Decisions supported by transcript quotes</h3>{note.decisions.length ? <ul>{note.decisions.map((item, index) => <li key={index}>{item.text}<blockquote>{item.quote}</blockquote></li>)}</ul> : <p>No quoted decision was verified.</p>}<h3>Action items supported by transcript quotes</h3>{note.actionItems.length ? <ul>{note.actionItems.map((item, index) => <li key={index}>{item.text}{item.owner ? ` · ${item.owner}` : ''}<blockquote>{item.quote}</blockquote></li>)}</ul> : <p>No quoted action item was verified.</p>}<details><summary>Original transcript</summary><pre>{note.transcript}</pre></details><div className="academy-inline-actions"><button type="button" className="button secondary" disabled={busy} onClick={() => void run({ action: 'export-meeting', id: note.id })}>Export Markdown</button><button type="button" className="button secondary" disabled={busy} onClick={() => void run({ action: 'delete-meeting', id: note.id })}>Delete meeting record</button></div></details>)}
      {meetings.length === 0 && <p className="chat-message-note">No saved notes match this local model and search.</p>}
    </Section>
    {busy && <div className="academy-inline-actions"><span>Local model is working…</span><button type="button" className="button secondary" onClick={() => void desktop.academyStudioCommand({ action: 'cancel' }).then(result => setNotice(result.message ?? 'Cancellation requested.'))}>Cancel local request</button></div>}
    {notice && <p className="chat-message-note" role="status">{notice}</p>}
  </>
}
