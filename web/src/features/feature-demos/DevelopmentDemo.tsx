'use client';
import { useEffect, useRef, useState } from 'react';
import { Check, ChevronRight, Code2, FileCode2, Folder, Play, Terminal } from 'lucide-react';
import { CustomSelect } from '@/components/ui/CustomSelect';
const steps = ['Inspect src/greeting.ts', 'Locate the missing fallback', 'Update the greeting function', 'Run the sample test suite'];
const before = `export function greet(name?: string) {\n  return \`Hello, \${name.trim()}!\`;\n}`;
const after = `export function greet(name?: string) {\n  const label = name?.trim() || 'friend';\n  return \`Hello, \${label}!\`;\n}`;
export function DevelopmentDemo() {
  const [agent, setAgent] = useState('Codex');
  const [step, setStep] = useState(-1);
  const [running, setRunning] = useState(false);
  const [tab, setTab] = useState('greeting.ts');
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => () => { if (timer.current) clearInterval(timer.current); }, []);
  function run() { if (timer.current) clearInterval(timer.current); setStep(0); setRunning(true); let n = 0; timer.current = setInterval(() => { n++; setStep(n); if (n === 4) { clearInterval(timer.current!); setRunning(false); } }, 850); }
  return <div className="glass code-demo" data-reveal><div className="window-bar"><div className="window-dots"><i /><i /><i /></div><span>starlight / workspace</span><span className="demo-label">SIMULATED</span></div><div className="code-toolbar"><span><Folder size={13} /> src</span><CustomSelect ariaLabel="Development agent" value={agent} disabled={running} onChange={setAgent} options={['Codex', 'Claude Code'].map(value => ({ value, label: value }))} /></div><div className="code-tabs">{['greeting.ts', 'greeting.test.ts'].map(file => <button key={file} aria-pressed={tab === file} onClick={() => setTab(file)}><FileCode2 size={13} /> {file}</button>)}</div><pre tabIndex={0} aria-label="Sample source code"><code>{tab === 'greeting.ts' ? step >= 2 ? after : before : `test('welcomes everyone', () => {\n  expect(greet()).toBe('Hello, friend!');\n  expect(greet('Ada')).toBe('Hello, Ada!');\n});`}</code></pre><div className="agent-title"><Code2 size={14} /><strong>{agent} activity</strong><span>{step >= 4 ? 'COMPLETE' : running ? 'WORKING' : 'READY'}</span></div><ol className="agent-steps">{steps.map((label, i) => <li key={label} className={step > i ? 'done' : step === i ? 'current' : ''}>{step > i ? <Check size={13} /> : <ChevronRight size={13} />}<span>{label}</span>{step === i && <span className="activity-pulse" />}</li>)}</ol><div className="terminal-output" role="status"><Terminal size={13} /><span>{step >= 4 ? '✓ 2 sample tests passed · demonstration output' : step < 0 ? '$ Ready when you are.' : `$ ${steps[Math.min(step, 3)].toLowerCase()}…`}</span></div><button className="code-run" onClick={run} disabled={running}><Play size={13} />{running ? `${agent} is working…` : step >= 4 ? 'Replay the workflow' : 'Fix the greeting bug'}</button><p className="tiny">A scripted walkthrough of repository exploration, file inspection, code generation, debugging, and terminal progress. No code is executed.</p></div>;
}
