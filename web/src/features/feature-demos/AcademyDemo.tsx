'use client';
import { useState } from 'react';
import { ArrowRight, BookOpen, Check, GraduationCap, Layers3, RefreshCw } from 'lucide-react';
import { CustomSelect } from '@/components/ui/CustomSelect';

// Names and workflow verified against shared/academyCourses.ts and AcademyFineTuningView.
const courses = [
  { value: 'coding', label: 'AI Coding', detail: 'Code generation, debugging, refactoring, testing, and repository understanding.' },
  { value: 'git', label: 'Git Intelligence', detail: 'Branching, merge and rebase, conflict resolution, and GitHub / GitLab workflows.' },
  { value: 'jira', label: 'Jira & Agile', detail: 'User stories, acceptance criteria, Scrum, Kanban, and implementation planning.' },
  { value: 'languages', label: 'Programming Languages', detail: 'Guidance and exercises for TypeScript, JavaScript, Python, Java, SQL, and more.' },
  { value: 'frameworks', label: 'Frameworks', detail: 'Work with React, Next.js, React Native, Expo, Node.js, and Spring Boot.' },
  { value: 'devops', label: 'DevOps', detail: 'Containers, CI/CD, deployment, and infrastructure fundamentals.' },
  { value: 'project', label: 'Project Intelligence & AI Agent Skills', detail: 'Architecture, scoped instructions, authorized file operations, and verified workflows.' },
  { value: 'other', label: 'Other Skills', detail: 'Workspace tools, research, documentation, meeting intelligence, and interview practice.' },
];
const stages = [
  ['Foundation', 'Install versioned guidance as a reusable skill for the selected local model.'],
  ['Knowledge Training', 'Assign approved documents and verify their semantic index with the selected embedding model.'],
  ['Guided Learning', 'Generate a worked example using the installed guidance and retrieved knowledge.'],
  ['Practical Training', 'Review a separate exercise. Desktop coding exercises use an isolated local sandbox.'],
  ['Ready for Evaluation', 'Check the recorded guidance, knowledge index, example, and practical evidence.'],
  ['Final Evaluation', 'Review independent checks, critical failures, and evidence for the tested competencies.'],
];
const tuning = [
  ['Select Model', 'Choose a compatible local model. Each model keeps its own Academy profile.'],
  ['Prepare Training Model', 'Check the local training runtime and a compatible checkpoint. Hardware and architecture support are required.'],
  ['Prepare Dataset', 'Import verified examples and separate training, validation, and held-out test data.'],
  ['Configure Training', 'Set iterations, learning rate, batch size, rank, and checkpoint frequency.'],
  ['Start Fine-Tuning', 'Follow local training progress and save adapter checkpoints. This preview does not train a model.'],
  ['Evaluate Trained Model', 'Compare the base model and checkpoints. Inspect answers and regressions before choosing an adapter.'],
  ['Activate Trained Model', 'Explicitly select a verified adapter. Training does not silently switch an active chat or companion model.'],
];
export function AcademyDemo() {
  const [view, setView] = useState('Courses');
  const [course, setCourse] = useState('coding');
  const [progress, setProgress] = useState<Record<string, number>>({});
  const [tune, setTune] = useState(0);
  const [answer, setAnswer] = useState('');
  const [feedback, setFeedback] = useState(false);
  const step = progress[course] ?? 0;
  const selected = courses.find(item => item.value === course)!;
  return <div className="glass academy-demo" data-reveal>
    <div className="window-bar"><GraduationCap size={15} /><span>athena academy / local learning</span><span className="demo-label">SIMULATION</span></div>
    <div className="demo-tabs" aria-label="Academy views">{['Courses', 'Fine-tuning', 'Practice'].map(name => <button key={name} aria-pressed={view === name} onClick={() => setView(name)}>{name}</button>)}</div>
    <div className="demo-body">
      {view === 'Courses' && <>
        <div className="select-row"><span>Explore a course</span><CustomSelect ariaLabel="Academy course" value={course} onChange={setCourse} options={courses} /></div>
        <p className="demo-description">{selected.detail}</p>
        <div className="academy-progress"><div role="progressbar" aria-label="Sample course walkthrough" aria-valuemin={0} aria-valuemax={6} aria-valuenow={step}><span style={{ width: `${step / 6 * 100}%` }} /></div><span>{step} / 6 stages explored</span></div>
        <ol className="academy-stages">{stages.map(([label], i) => <li key={label} className={step > i ? 'done' : step === i ? 'current' : ''}><span>{step > i ? <Check size={12} /> : i + 1}</span>{label}</li>)}</ol>
        <div className="demo-insight" role="status"><BookOpen size={17} /><div><strong>{step < 6 ? stages[step][0] : 'Evidence before confidence.'}</strong><p>{step < 6 ? stages[step][1] : 'This walkthrough is complete. Actual evaluations run in Athena; this is not a model score or certification.'}</p></div></div>
        <div className="demo-actions"><button className="button-primary" disabled={step === 6} onClick={() => setProgress(p => ({ ...p, [course]: step + 1 }))}>Explore next stage <ArrowRight size={13} /></button><button className="text-button" onClick={() => setProgress(p => ({ ...p, [course]: 0 }))}><RefreshCw size={13} /> Reset</button></div>
      </>}
      {view === 'Fine-tuning' && <>
        <div className="select-row"><span>Training workflow</span><CustomSelect ariaLabel="Fine-tuning stage" value={String(tune)} onChange={value => setTune(Number(value))} options={tuning.map(([label], i) => ({ value: String(i), label }))} /></div>
        <div className="training-path" aria-label="Fine-tuning workflow">{tuning.map(([label], i) => <button key={label} aria-label={`Explore ${label}`} aria-pressed={tune === i} onClick={() => setTune(i)}>{i + 1}</button>)}</div>
        <div className="demo-insight" role="status"><Layers3 size={18} /><div><strong>{tuning[tune][0]}</strong><p>{tuning[tune][1]}</p></div></div>
        <p className="demo-description">Document retrieval supplies context. Fine-tuning changes model behavior through training. Academy keeps these workflows separate.</p>
      </>}
      {view === 'Practice' && <>
        <div className="practice-question"><span className="live-badge">INTERVIEW PRACTICE</span><h3>How would you handle a slow API in a React interface?</h3><p>Try explaining loading, error, and cancellation states.</p></div>
        <label className="demo-input-label" htmlFor="practice-answer">Your practice answer</label><textarea id="practice-answer" value={answer} maxLength={1200} onChange={e => { setAnswer(e.target.value); setFeedback(false); }} placeholder="I would start by…" />
        <button className="button-primary" disabled={!answer.trim()} onClick={() => setFeedback(true)}>Show review checklist <ArrowRight size={13} /></button>
        {feedback && <div className="demo-insight" role="status"><BookOpen size={17} /><div><strong>A checklist for your own review</strong><p>Did you cover loading feedback, retryable errors, request cancellation, and stale responses? This fixed checklist does not evaluate your answer. Athena’s desktop practice can request local-model feedback.</p></div></div>}
      </>}
      <p className="tiny">Explore the desktop workflow with sample data. No training, indexing, code execution, or model evaluation runs on this website.</p>
    </div>
  </div>;
}
