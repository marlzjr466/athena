import { useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, FolderOpen, LoaderCircle, MessageSquare, MoreHorizontal, Pencil, Plus, Search, ShieldAlert, Trash2 } from 'lucide-react'
import type { ConversationSummary, WorkspaceReference } from '../../../shared/conversations'
import { desktop } from '../../services/desktop'
import { useAthenaChat } from '../../store/athenaChatStore'
import { readProjectCollapseState, writeProjectCollapseState, type ProjectCollapseState } from '../chat/projectCollapse'

function relativeTime(timestamp: number): string {
  const elapsed = Date.now() - timestamp
  if (elapsed < 60_000) return 'now'
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m`
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h`
  if (elapsed < 604_800_000) return `${Math.floor(elapsed / 86_400_000)}d`
  return new Date(timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function AthenaChatSidebar({ linked, onLink, onManageModels }: { linked: boolean; onLink(linked: boolean): void; onManageModels(): void }) {
  const { snapshot, command, pending } = useAthenaChat()
  const [query, setQuery] = useState('')
  const [matches, setMatches] = useState<string[] | null>(null)
  const [popup, setPopup] = useState<{ id: string; mode: 'options' | 'rename' | 'delete' } | null>(null)
  const [projectPopup, setProjectPopup] = useState<{ id: string; sessionId: string; mode: 'options' | 'rename' | 'delete' } | null>(null)
  const [title, setTitle] = useState('')
  const [searchError, setSearchError] = useState('')
  const popupRef = useRef<HTMLDivElement>(null)
  const projectPopupRef = useRef<HTMLDivElement>(null)
  const [expandedProjects, setExpandedProjects] = useState<ProjectCollapseState>(() => readProjectCollapseState('local'))
  useEffect(() => {
    if (!popup && !projectPopup) return
    const outside = (event: PointerEvent) => {
      const target = event.target as Node
      if (popup && !popupRef.current?.contains(target)) setPopup(null)
      if (projectPopup && !projectPopupRef.current?.contains(target)) setProjectPopup(null)
    }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { setPopup(null); setProjectPopup(null) } }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape) }
  }, [popup, projectPopup])
  useEffect(() => { setPopup(null); setProjectPopup(null) }, [snapshot.sessionId])
  useEffect(() => { writeProjectCollapseState('local', expandedProjects) }, [expandedProjects])
  useEffect(() => {
    let live = true
    if (!query.trim()) { setMatches(null); return }
    const timer = setTimeout(() => void desktop.searchAthenaChats({ query }).then(ids => { if (live) { setMatches(ids); setSearchError('') } }).catch(() => { if (live) setSearchError('Search unavailable. Try again.') }), 180)
    return () => { live = false; clearTimeout(timer) }
  }, [query, snapshot.sessions?.length])
  const visible = (snapshot.sessions ?? []).filter(session => matches === null || matches.includes(session.id))
  const projectMap = new Map<string, { project: WorkspaceReference; sessions: ConversationSummary[] }>()
  const ungrouped: ConversationSummary[] = []
  for (const session of visible) {
    if (!session.project) { ungrouped.push(session); continue }
    const group = projectMap.get(session.project.id) ?? { project: session.project, sessions: [] }
    group.sessions.push(session)
    projectMap.set(session.project.id, group)
  }
  const projects = [...projectMap.values()].sort((a, b) => (b.sessions[0]?.updatedAt ?? 0) - (a.sessions[0]?.updatedAt ?? 0))
  const activeProjectId = snapshot.sessions?.find((session) => session.id === snapshot.sessionId)?.project?.id
  useEffect(() => {
    if (!activeProjectId || Object.prototype.hasOwnProperty.call(expandedProjects, activeProjectId)) return
    setExpandedProjects((current) => ({ ...current, [activeProjectId]: true }))
  }, [activeProjectId, expandedProjects])
  const projectAction = async (input: Parameters<typeof desktop.athenaChatContext>[0]) => {
    try {
      const result = await desktop.athenaChatContext(input)
      if (!result.ok) setSearchError(result.message ?? 'Could not update this local project.')
      return result.ok
    } catch { setSearchError('Could not update this local project. Try again.'); return false }
  }
  const toggleProject = (projectId: string) => setExpandedProjects((current) => ({ ...current, [projectId]: !(current[projectId] ?? true) }))
  const sessionEntry = (session: ConversationSummary, nested = false) => <div key={session.id} data-conversation-id={session.id} className={`conversation-entry ${nested ? 'project-session' : ''} ${snapshot.sessionId === session.id ? 'selected' : ''}`}>
    <button type="button" className="conversation-select" aria-current={snapshot.sessionId === session.id ? 'page' : undefined} disabled={pending} title={session.executionStatus === 'waiting-approval' ? `${session.title} — Waiting for approval` : session.title} onClick={() => void command({ action: 'switch', id: session.id })}>{session.executionStatus === 'waiting-approval' ? <ShieldAlert className="conversation-approval-icon" size={13} aria-label="Waiting for approval" /> : session.executionStatus === 'running' ? <LoaderCircle className="conversation-running-icon" size={13} aria-label="Running" /> : snapshot.sessionId === session.id ? <span className="active-conversation-dot" aria-hidden="true" /> : <MessageSquare size={13} />}<span>{session.title}</span><small>{relativeTime(session.updatedAt)}</small></button>
    <div className="conversation-options" ref={popup?.id === session.id ? popupRef : undefined}>
      <button type="button" className="chat-action" aria-label={`Options for ${session.title}`} aria-expanded={popup?.id === session.id} onClick={() => setPopup(popup?.id === session.id ? null : { id: session.id, mode: 'options' })}>•••</button>
      {popup?.id === session.id && <div className="conversation-popover" role="dialog" aria-label={popup.mode === 'options' ? 'Conversation options' : popup.mode === 'rename' ? 'Rename conversation' : 'Delete'}>
        {popup.mode === 'options' ? <><button type="button" className="chat-action" onClick={() => { setPopup({ id: session.id, mode: 'rename' }); setTitle(session.title) }}><Pencil size={13} /> Rename</button><button type="button" className="chat-action" disabled={pending} onClick={() => setPopup({ id: session.id, mode: 'delete' })}><Trash2 size={13} /> Delete</button></> : popup.mode === 'rename' ? <form onSubmit={event => { event.preventDefault(); void command({ action: 'rename', id: session.id, title }).then(ok => { if (ok) setPopup(null) }) }}><input autoFocus aria-label="Conversation title" maxLength={120} value={title} onChange={event => setTitle(event.target.value)} /><button className="chat-action" disabled={!title.trim() || pending}>Save</button><button type="button" className="chat-action" onClick={() => setPopup(null)}>Cancel</button></form> : <><strong>Delete this conversation?</strong><p>A recovery copy stays in Athena’s private local archive.</p><div><button type="button" className="chat-action" onClick={() => setPopup(null)}>Cancel</button><button type="button" className="chat-action" disabled={pending} onClick={() => void command({ action: 'delete', id: session.id, confirmed: true }).then(ok => { if (ok) setPopup(null) })}>Delete</button></div></>}
      </div>}
    </div>
  </div>
  return <aside className="conversation-sidebar athena-chat-sidebar" aria-label="Athena Chat sessions">
    <button className="button secondary new-conversation" type="button" disabled={pending} onClick={() => void command({ action: 'create' })}><Plus size={16} /> New chat</button>
    <label className="conversation-search"><Search size={14} /><input aria-label="Search local conversations" placeholder="Search conversations" maxLength={200} value={query} onChange={event => setQuery(event.target.value)} /></label>
    {searchError && <p role="alert">{searchError}</p>}
    <div className="conversation-list">
      {!!projects.length && <div className="conversation-section-label">Projects</div>}
      {projects.map(({ project, sessions }) => { const expanded = expandedProjects[project.id] ?? true; const runningCount = sessions.filter((session) => session.executionStatus === 'running' || session.executionStatus === 'queued').length; return <section className={`conversation-project ${expanded ? 'is-expanded' : 'is-collapsed'}`} key={project.id} aria-label={`${project.name} project`}><header><button type="button" className="conversation-project-toggle" aria-expanded={expanded} aria-controls={`local-project-sessions-${project.id}`} onClick={() => toggleProject(project.id)}><span aria-hidden="true">{expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</span><FolderOpen size={16} /><strong title={project.name}>{project.name}</strong></button>{runningCount > 0 && <span className="project-activity" title={`${runningCount} active conversation${runningCount === 1 ? '' : 's'}`}><LoaderCircle size={12} /> {runningCount}</span>}<button type="button" className="chat-action" aria-label={`New chat in ${project.name}`} title={`New chat in ${project.name}`} disabled={pending} onClick={() => void command({ action: 'create', workspaceId: project.id })}><Plus size={15} /></button><div className="project-options" ref={projectPopup?.id === project.id ? projectPopupRef : undefined}><button type="button" className="chat-action" aria-label={`Options for project ${project.name}`} aria-expanded={projectPopup?.id === project.id} onClick={() => { setPopup(null); setProjectPopup(projectPopup?.id === project.id ? null : { id: project.id, sessionId: sessions[0].id, mode: 'options' }) }}><MoreHorizontal size={16} /></button>{projectPopup?.id === project.id && <div className="conversation-popover project-popover" role="dialog" aria-label={projectPopup.mode === 'options' ? 'Project options' : projectPopup.mode === 'rename' ? 'Rename project' : 'Delete project'}>
        {projectPopup.mode === 'options' ? <><button type="button" className="chat-action" onClick={() => { setTitle(project.name); setProjectPopup({ ...projectPopup, mode: 'rename' }) }}><Pencil size={13} /> Rename project</button><button type="button" className="chat-action" onClick={() => setProjectPopup({ ...projectPopup, mode: 'delete' })}><Trash2 size={13} /> Delete project</button></> : projectPopup.mode === 'rename' ? <form onSubmit={event => { event.preventDefault(); void projectAction({ action: 'project-rename', sessionId: projectPopup.sessionId, id: project.id, name: title }).then(ok => { if (ok) setProjectPopup(null) }) }}><label htmlFor={`local-project-name-${project.id}`}>Project name</label><input id={`local-project-name-${project.id}`} autoFocus maxLength={255} value={title} onChange={event => setTitle(event.target.value)} /><div><button type="button" className="chat-action" onClick={() => setProjectPopup(null)}>Cancel</button><button className="chat-action" disabled={!title.trim()}>Save project</button></div></form> : <><strong>Delete this project?</strong><p>Every conversation under this project will move to Athena’s private recovery archive.</p><div><button type="button" className="chat-action" onClick={() => setProjectPopup(null)}>Cancel</button><button type="button" className="chat-action" onClick={() => void projectAction({ action: 'project-delete', sessionId: projectPopup.sessionId, id: project.id, confirmed: true }).then(ok => { if (ok) setProjectPopup(null) })}>Delete project</button></div></>}
      </div>}</div></header><div id={`local-project-sessions-${project.id}`} className="project-session-list" aria-hidden={!expanded}>{sessions.map(session => sessionEntry(session, true))}</div></section> })}
      {!!ungrouped.length && <div className="conversation-section-label">Chats</div>}
      {ungrouped.map(session => sessionEntry(session))}
      {!visible.length && <p className="conversation-empty">No matching conversations.</p>}
    </div>
    <div className="athena-chat-link"><label><input type="checkbox" checked={linked} onChange={event => onLink(event.target.checked)} /> Link this active chat to floating Athena animations</label><p>Only this active local chat may drive the avatar; its model remains independent of the floating model.</p><button className="chat-action" onClick={onManageModels}>Manage local models</button></div>
    <p className="chat-privacy-note">Private history on this Mac</p>
  </aside>
}
