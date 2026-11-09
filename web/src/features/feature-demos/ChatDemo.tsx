'use client';
import { useEffect, useRef, useState } from 'react';
import { ArrowUp, Paperclip, Folder, Plus, MessageSquare, Check, Cpu } from 'lucide-react';
import { CustomSelect } from '@/components/ui/CustomSelect';
type Message = { role: 'you' | 'athena'; text: string };
const welcome: Message[] = [{ role: 'athena', text: 'Hey, I’m Athena. A thought, a project, a big idea — where shall we start?' }];
const sampleReply = (prompt: string, model: string, attachment: string) => {
  if (attachment) return `I’ve added the sample ${attachment} to this conversation. In Athena, file and image attachments give your selected model more context. This preview uses sample content only.`;
  if (/project|repo|code|build/i.test(prompt)) return 'Let’s make something. In your linked project, I can explore files, plan a change, and work with Claude Code or Codex while you follow each tool operation. Try the development demo below to see the workflow.';
  if (/local|private|model/i.test(prompt)) return `With ${model}, you choose where the conversation happens. Ollama powers local inference; online providers connect when you choose them. Try the intelligence demo to explore both paths.`;
  return 'One idea at a time. I can help you think it through, keep your project context close, and pick up where you left off. This is a scripted preview — the desktop app connects to your chosen AI model.';
};
export function ChatDemo() {
  const [messages, setMessages] = useState<Message[]>(welcome);
  const [prompt, setPrompt] = useState('Help me build something great.');
  const [model, setModel] = useState('Local · Ollama');
  const [effort, setEffort] = useState('Balanced');
  const [attachment, setAttachment] = useState('');
  const [session, setSession] = useState('First conversation');
  const [busy, setBusy] = useState(false);
  const [stream, setStream] = useState('');
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const log = useRef<HTMLDivElement>(null);
  useEffect(() => { try { const saved = JSON.parse(localStorage.getItem('athena-demo-chat') || 'null'); if (Array.isArray(saved) && saved.every(m => ['you', 'athena'].includes(m.role) && typeof m.text === 'string')) setMessages(saved.slice(-12)); } catch {} return () => { if (timer.current) clearInterval(timer.current); }; }, []);
  useEffect(() => { if (log.current) log.current.scrollTop = log.current.scrollHeight; }, [messages, stream]);
  function send() {
    if (!prompt.trim() || busy) return;
    const next = [...messages, { role: 'you' as const, text: prompt.trim().slice(0, 400) }].slice(-10);
    const reply = sampleReply(prompt, model, attachment);
    setMessages(next); setBusy(true); setStream(''); setPrompt('');
    let cursor = 0;
    timer.current = setInterval(() => {
      cursor += 7; setStream(reply.slice(0, cursor));
      if (cursor >= reply.length) {
        clearInterval(timer.current!); timer.current = null;
        const finished = [...next, { role: 'athena' as const, text: reply }];
        setMessages(finished); setStream(''); setBusy(false);
        try { localStorage.setItem('athena-demo-chat', JSON.stringify(finished)); } catch {}
      }
    }, 25);
  }
  function reset() { if (timer.current) clearInterval(timer.current); setBusy(false); setStream(''); setMessages(welcome); setSession('New conversation'); try { localStorage.removeItem('athena-demo-chat'); } catch {} }
  return <div className="glass chat-demo" data-reveal><div className="window-bar"><div className="window-dots"><i /><i /><i /></div><span>athena / your workspace</span><span className="demo-label">INTERACTIVE DEMO</span></div>
    <div className="chat-toolbar"><span><Folder size={13} /> starlight-app</span><button aria-label="Start new sample conversation" onClick={reset}><Plus size={15} /></button></div>
    <div className="chat-models"><CustomSelect ariaLabel="AI model" value={model} onChange={setModel} options={['Local · Ollama', 'Online · OpenAI', 'Online · Anthropic'].map(value => ({ value, label: value }))} /><CustomSelect ariaLabel="Reasoning effort" value={effort} onChange={setEffort} options={['Balanced', 'Quick', 'Deep reasoning'].map(value => ({ value, label: value }))} /></div>
    <div className="chat-log" ref={log} data-lenis-prevent aria-label="Sample conversation">{messages.map((message, i) => <div key={i} className={`chat-message ${message.role}`}><span className="message-avatar">{message.role === 'athena' ? 'A' : 'Y'}</span><div><strong>{message.role === 'athena' ? 'Athena' : 'You'}</strong><p>{message.text}</p></div></div>)}{busy && <div className="chat-message athena"><span className="message-avatar">A</span><div><strong>Athena <span className="stream-label">streaming</span></strong><p>{stream}<span className="typing-caret" /></p></div></div>}</div>
    <div className="activity-line" role="status">{busy ? <><Cpu size={12} /> {effort} · composing sample response…</> : <><Check size={12} /> {session} · saved in this browser</>}</div>
    <form className="chat-input" onSubmit={e => { e.preventDefault(); send(); }}><input aria-label="Message Athena demo" maxLength={400} value={prompt} onChange={e => setPrompt(e.target.value)} placeholder="Ask Athena anything…" /><button aria-label="Send demo message" disabled={busy || !prompt.trim()} type="submit"><ArrowUp size={18} /></button></form>
    <div className="attachment-row"><Paperclip size={13} /><CustomSelect ariaLabel="Sample attachment" value={attachment} onChange={setAttachment} options={[{ value: '', label: 'Attach a sample' }, { value: 'project-brief.md', label: 'project-brief.md' }, { value: 'interface.png', label: 'interface.png' }]} /><MessageSquare size={13} /><span>Scripted preview · no AI connection</span></div>
  </div>;
}
