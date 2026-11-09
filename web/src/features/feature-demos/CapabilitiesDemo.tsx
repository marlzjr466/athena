'use client';
import { useState } from 'react';
import { BookOpen, Check, Globe2, ShieldCheck } from 'lucide-react';
import { CustomSelect } from '@/components/ui/CustomSelect';
const topics = [
  { id: 'knowledge', label: 'Knowledge library', icon: BookOpen },
  { id: 'research', label: 'Web research', icon: Globe2 },
  { id: 'automation', label: 'Automation', icon: ShieldCheck },
] as const;
export function CapabilitiesDemo() {
  const [topic, setTopic] = useState<typeof topics[number]['id']>('knowledge');
  const [source, setSource] = useState('project-guide.md');
  const [retrieved, setRetrieved] = useState(false);
  const [corrections, setCorrections] = useState(false);
  const [provider, setProvider] = useState('Brave Search API');
  const [research, setResearch] = useState(false);
  const [allowFiles, setAllowFiles] = useState(false);
  return <div className="glass capabilities-demo" data-reveal>
    <div className="panel-heading"><span>MORE OF YOUR EVERYDAY, CONNECTED</span><span className="demo-label">PREVIEW</span></div>
    <div className="capability-tabs">{topics.map(({ id, label, icon: Icon }) => <button key={id} aria-pressed={topic === id} onClick={() => setTopic(id)}><Icon size={18} /><span>{label}</span></button>)}</div>
    {topic === 'knowledge' && <div className="capability-detail"><h3>Bring your own understanding.</h3><p className="demo-description">Approved documents become searchable context through local embeddings. Model-specific verified corrections can supply relevant examples without changing model weights.</p><div className="select-row"><span>Sample source</span><CustomSelect ariaLabel="Knowledge source" value={source} onChange={value => { setSource(value); setRetrieved(false); }} options={['project-guide.md', 'coding-conventions.md'].map(value => ({ value, label: value }))} /></div><button className="button-secondary" onClick={() => setRetrieved(!retrieved)}><BookOpen size={14} />{retrieved ? 'Hide sample context' : 'Retrieve sample context'}</button>{retrieved && <blockquote className="source-excerpt"><span>{source} · sample excerpt</span>{source === 'project-guide.md' ? '“Keep data access separate from interface components.”' : '“Add an accessible name to icon-only controls.”'}</blockquote>}<div className="setting-row"><span>Use verified corrections</span><button className="toggle" role="switch" aria-label="Verified corrections preview" aria-checked={corrections} onClick={() => setCorrections(!corrections)}><span /></button></div><p className="tiny" role="status">{corrections ? 'Example: include your approved response-format preference in matching requests.' : 'Your correction examples stay optional and specific to the selected model.'}</p></div>}
    {topic === 'research' && <div className="capability-detail"><h3>Stay curious. Stay informed.</h3><p className="demo-description">Athena can search public websites and read pages when internet access is enabled. Search settings are separate from the model writing your answer.</p><div className="select-row"><span>Search provider</span><CustomSelect ariaLabel="Research provider" value={provider} onChange={value => { setProvider(value); setResearch(false); }} options={['Brave Search API', 'OpenAI Responses web search'].map(value => ({ value, label: value }))} /></div><button className="button-secondary" onClick={() => setResearch(!research)}><Globe2 size={14} />Explore search workflow</button>{research && <ol className="workflow-list"><li><Check size={13} />Receive your question</li><li><Check size={13} />Search with {provider}</li><li><Check size={13} />Read public sources as untrusted context</li><li><Check size={13} />Return an answer with source references</li></ol>}<p className="tiny">Workflow illustration only. No search request or account connection is made here.</p></div>}
    {topic === 'automation' && <div className="capability-detail"><h3>Useful actions. Clear boundaries.</h3><p className="demo-description">The desktop assistant can navigate Athena, manage conversations, open supported applications, and work in authorized projects. File, terminal, and application permissions are controlled separately.</p><div className="setting-row"><span>Sample project file access</span><button className="toggle" role="switch" aria-label="Sample project file access" aria-checked={allowFiles} onClick={() => setAllowFiles(!allowFiles)}><span /></button></div><div className="permission-example" role="status"><ShieldCheck size={22} /><div><strong>{allowFiles ? 'Read allowed · sample-project/' : 'Read blocked · permission required'}</strong><p>{allowFiles ? 'The example allows reading only the selected project. File modification and terminal access remain separate choices.' : 'The sample read waits until the corresponding permission is enabled.'}</p></div></div><p className="tiny">Demonstration switches never grant this website desktop access or change Athena’s settings.</p></div>}
  </div>;
}
