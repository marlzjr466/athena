'use client';
import { useEffect, useRef, useState } from 'react';
import { Check, Download, FileText, Monitor, NotebookPen, Play, RefreshCw } from 'lucide-react';
import { CustomSelect } from '@/components/ui/CustomSelect';

const templates = ['Technical discussion', 'Daily standup', 'General meeting', 'Interview practice'];
const transcript = [
  { time: '00:12', name: 'Alex', text: 'Let’s keep the first release focused on the onboarding flow.' },
  { time: '00:28', name: 'Sam', text: 'I’ll finish the empty and error states before our next review.' },
  { time: '00:43', name: 'Alex', text: 'What needs to happen before we can test with the team?' },
  { time: '00:57', name: 'Sam', text: 'A test account and an accessible keyboard path. Alex will prepare the account.' },
];
const notes = ['Decision: focus the first release on onboarding.', 'Sam: finish empty and error states before the next review.', 'Alex: prepare a test account; verify the keyboard path.'];
export function MeetingDemo() {
  const [template, setTemplate] = useState(templates[0]);
  const [tab, setTab] = useState('Live Transcript');
  const [segments, setSegments] = useState(0);
  const [running, setRunning] = useState(false);
  const [confirmed, setConfirmed] = useState<number[]>([]);
  const [question, setQuestion] = useState('What should we do next?');
  const [answer, setAnswer] = useState(false);
  const [screen, setScreen] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => () => { if (timer.current) clearInterval(timer.current); }, []);
  function replay() {
    if (timer.current) clearInterval(timer.current);
    setTab('Live Transcript'); setSegments(0); setRunning(true);
    let count = 0;
    timer.current = setInterval(() => { count++; setSegments(count); if (count === transcript.length) { clearInterval(timer.current!); timer.current = null; setRunning(false); } }, 650);
  }
  function exportNotes() {
    const text = `# Sample meeting — ${template}\n\n${notes.map((note, i) => `- [${confirmed.includes(i) ? 'x' : ' '}] ${note}`).join('\n')}\n\nWebsite demonstration, not a real meeting record.\n`;
    const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown' }));
    const link = document.createElement('a'); link.href = url; link.download = 'athena-sample-meeting.md'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <div className="glass meeting-demo" data-reveal>
    <div className="window-bar"><NotebookPen size={15} /><span>meeting intelligence / sample workspace</span><span className="demo-label">SIMULATION</span></div>
    <div className="meeting-demo-toolbar"><div><strong>Starlight · product check-in</strong><span><i className="status-dot" />{running ? 'Playing sample transcript' : 'Sample meeting · no recording'}</span></div><CustomSelect ariaLabel="Meeting template" value={template} onChange={setTemplate} options={templates.map(value => ({ value, label: value }))} /></div>
    <div className="demo-tabs meeting-demo-tabs" aria-label="Meeting views">{['Live Transcript', 'AI Notes', 'Ask Athena', 'Screen Context', 'Quick Answers'].map(name => <button key={name} aria-pressed={tab === name} onClick={() => setTab(name)}>{name}</button>)}</div>
    <div className="demo-body">
      <div className="meeting-demo-content">
        {tab === 'Live Transcript' && <><div className="meeting-transcript" aria-live="polite">{segments === 0 ? <div className="demo-empty"><NotebookPen size={28} /><h3>Be in the conversation.</h3><p>Play a sample to see timestamped transcript segments arrive.</p></div> : transcript.slice(0, segments).map(item => <article key={item.time}><span>{item.time} · {item.name}</span><p>{item.text}</p></article>)}</div><button className="button-primary" disabled={running} onClick={replay}>{segments ? <RefreshCw size={13} /> : <Play size={13} />}{running ? 'Playing sample…' : segments ? 'Replay sample meeting' : 'Play sample meeting'}</button></>}
        {tab === 'AI Notes' && <><p className="demo-description">Review decisions and action items against the sample transcript.</p><div className="meeting-notes">{notes.map((note, i) => <label key={note}><input type="checkbox" checked={confirmed.includes(i)} onChange={e => setConfirmed(ids => e.target.checked ? [...ids, i] : ids.filter(id => id !== i))} /><span>{note}</span></label>)}</div><div className="demo-actions"><span className="tiny"><Check size={12} />{confirmed.length} of 3 reviewed</span><button className="button-secondary" onClick={exportNotes}><Download size={13} /> Export sample notes</button></div></>}
        {tab === 'Ask Athena' && <><p className="demo-description">Ask about the sample meeting. Desktop answers use the selected model and available meeting context.</p><form onSubmit={e => { e.preventDefault(); if (question.trim()) setAnswer(true); }}><label className="demo-input-label" htmlFor="meeting-question">Ask about the sample</label><input id="meeting-question" value={question} maxLength={300} onChange={e => { setQuestion(e.target.value); setAnswer(false); }} /><button className="button-primary" disabled={!question.trim()} type="submit">Show sample response</button></form>{answer && <div className="demo-insight" role="status"><FileText size={17} /><div><strong>Next steps from this sample</strong><p>Sam owns the empty and error states. Alex owns the test account. Review keyboard accessibility before the team test. This is a scripted response, not an answer generated from your question.</p></div></div>}</>}
        {tab === 'Screen Context' && <><div className="sample-screen"><div><span className="window-dots"><i /><i /><i /></span>sample interface</div><code>&lt;button aria-label="Continue"&gt;<br />&nbsp; Continue<br />&lt;/button&gt;</code></div><button className="button-secondary" onClick={() => setScreen(!screen)}><Monitor size={14} />{screen ? 'Hide sample explanation' : 'Explain sample screen'}</button>{screen && <p className="demo-description" role="status">The sample shows a button with an accessible name. Check focus visibility and whether the next screen is announced. Athena’s desktop screen assistance uses explicitly authorized capture; this preview never reads your screen.</p>}</>}
        {tab === 'Quick Answers' && <><span className="live-badge">SAMPLE DETECTED QUESTION</span><h3 className="meeting-question">“What needs to happen before we can test with the team?”</h3><div className="demo-insight"><FileText size={17} /><div><strong>A draft to review</strong><p>Finish the empty/error states, prepare a test account, and check the keyboard path. You decide what to use from a suggested answer.</p></div></div></>}
      </div>
      <p className="tiny">Desktop features include local transcription, AI notes, saved meeting history, a floating panel, and authorized screen context. This preview uses invented sample content; no microphone, system audio, or screen capture is requested.</p>
    </div>
  </div>;
}
