import { useEffect, useState } from 'react'
import { FilePlus2, FolderOpen, Unplug, X } from 'lucide-react'
import { useChat } from '../../store/chatStore'
import { desktop } from '../../services/desktop'
import type { ProjectFile } from '../../../shared/conversations'
import { CustomSelect } from '../../components/ui/CustomSelect'

export function WorkspacePanel({ close, report }: { close(): void; report(message: string): void }) {
  const { snapshot } = useChat()
  const projects = snapshot.workspaces ?? []
  const [selected, setSelected] = useState(projects[0]?.id ?? ''), [query, setQuery] = useState(''), [offset, setOffset] = useState(0)
  const [files, setFiles] = useState<ProjectFile[]>([]), [total, setTotal] = useState(0), [loading, setLoading] = useState(false), [issue, setIssue] = useState(''), [version, setVersion] = useState(0)
  useEffect(() => { if (!projects.some((project) => project.id === selected)) setSelected(projects[0]?.id ?? '') }, [projects, selected])
  useEffect(() => {
    let live = true
    if (!selected || !snapshot.sessionId) { setFiles([]); return }
    setLoading(true)
    const timer = setTimeout(() => void desktop.chatContext({ action: 'browse', sessionId: snapshot.sessionId!, id: selected, query, offset }).then((result) => {
      if (!live) return
      setFiles(result.files ?? []); setTotal(result.total ?? 0); setIssue(result.ok ? result.truncated ? 'Showing a bounded source index; generated and sensitive files are excluded.' : '' : result.message ?? 'Could not read project.'); setLoading(false)
    }).catch(() => { if (live) { setIssue('Could not read this project. Select the folder again.'); setLoading(false) } }), 250)
    return () => { live = false; clearTimeout(timer) }
  }, [selected, query, offset, version, snapshot.sessionId])
  return <section className="workspace-panel" aria-label="Project source browser"><header><FolderOpen size={16} /><strong>Project context</strong><button className="chat-action" aria-label="Close project browser" onClick={close}><X size={16} /></button></header>
    <div className="workspace-controls"><CustomSelect ariaLabel="Active project" value={selected} options={projects.map((project) => ({ value: project.id, label: `${project.name}${project.authorized ? '' : ' · reauthorize'}` }))} onChange={(value) => { setSelected(value); setOffset(0) }} /><button className="chat-action" onClick={() => setVersion((value) => value + 1)}>Refresh</button><button className="chat-action" aria-label="Disconnect project" disabled={!selected} onClick={() => void desktop.chatContext({ action: 'disconnect', sessionId: snapshot.sessionId!, id: selected }).then((result) => { if (!result.ok) report(result.message ?? 'Could not disconnect.') }).catch(() => report('Could not disconnect.'))}><Unplug size={14} /></button></div>
    <input aria-label="Search project files and code" placeholder="Search paths, functions, imports, or code…" maxLength={200} value={query} onChange={(event) => { setQuery(event.target.value); setOffset(0) }} />
    <p className="chat-message-note">Read only · Relevant excerpts go to the provider chosen in Settings when you send. Files refresh on each search and question.</p>
    {projects.some((project) => project.id === selected && !project.authorized) && <div role="status"><p className="chat-message-note">Select the same folder once to reconnect your existing sessions. Athena will remember access on this Mac. Do not delete your conversations.</p><button className="chat-action" disabled={snapshot.phase !== 'idle' || !snapshot.sessionId} onClick={() => void desktop.chatContext({ action: 'connect', sessionId: snapshot.sessionId! }).then((result) => { if (!result.ok) report(result.message ?? 'Could not reconnect.'); else setVersion((value) => value + 1) }).catch(() => report('Could not reconnect this project.'))}>Reconnect project folder</button></div>}
    {loading && <p role="status">Indexing source files…</p>}{issue && <p role="status">{issue}</p>}
    <div className="workspace-files">{files.map((file) => <div key={`${file.path}:${file.line}`}><span title={file.excerpt}><code>{file.path}:{file.line}</code><small>{file.excerpt}</small></span><button className="chat-action" title={`Attach ${file.path}`} aria-label={`Attach ${file.path}`} disabled={snapshot.phase !== 'idle'} onClick={() => void desktop.chatContext({ action: 'attach-source', sessionId: snapshot.sessionId!, id: selected, path: file.path }).then((result) => report(result.ok ? 'Source file attached.' : result.message ?? 'Could not attach file.')).catch(() => report('Could not attach file.'))}><FilePlus2 size={15} /></button></div>)}</div>
    <footer><button className="chat-action" disabled={offset === 0} onClick={() => setOffset((value) => Math.max(0, value - 100))}>Previous</button><span>{total ? offset + 1 : 0}–{Math.min(offset + 100, total)} of {total}</span><button className="chat-action" disabled={offset + 100 >= total} onClick={() => setOffset((value) => value + 100)}>Next</button></footer>
  </section>
}
