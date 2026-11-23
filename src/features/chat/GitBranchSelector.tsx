import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { Check, ChevronDown, GitBranch, Plus, RefreshCw, Search } from 'lucide-react'
import { desktop } from '../../services/desktop'
import { AnchoredPopover } from './AnchoredPopover'
import type { ProjectGitResult, ProjectGitState } from '../../../shared/projectGit'

function GitBranchError({ message, expanded, onToggle }: { message: string; expanded: boolean; onToggle(): void }) {
  const detailsId = useId()
  const overwritten = /would be overwritten by (?:checkout|switch)/i.test(message)
  const hasDetails = overwritten || message.includes('\n') || message.length > 220
  const summary = overwritten
    ? 'Local changes would be overwritten. Your changes are preserved. Commit or stash them before switching.'
    : hasDetails ? 'Git could not complete this request. View details for the full error.' : message
  return <div className="git-branch-error">
    <p role="alert">{summary}</p>
    {hasDetails && <>
      <button className="git-branch-error-toggle" aria-expanded={expanded} aria-controls={detailsId} onClick={onToggle}><ChevronDown size={12} />{expanded ? 'Hide details' : 'Show details'}</button>
      {expanded && <pre id={detailsId} className="git-branch-error-details" tabIndex={0} aria-label="Git error details">{message}</pre>}
    </>}
  </div>
}

export function GitBranchSelector({ sessionId, workspaceId, readOnly = false }: { sessionId: string; workspaceId: string; readOnly?: boolean }) {
  const [state, setState] = useState<ProjectGitState>()
  const [error, setError] = useState(''), [open, setOpen] = useState(false), [creating, setCreating] = useState(false)
  const [query, setQuery] = useState(''), [name, setName] = useState(''), [pending, setPending] = useState(false)
  const [expandedError, setExpandedError] = useState<string>()
  const anchor = useRef<HTMLButtonElement>(null), popup = useRef<HTMLDivElement>(null), search = useRef<HTMLInputElement>(null)
  const alive = useRef(true), refreshing = useRef(false), changing = useRef(false), version = useRef(0)
  const close = useCallback(() => { setOpen(false); setCreating(false); setQuery(''); setName(''); setExpandedError(undefined) }, [])
  const accept = useCallback((result: ProjectGitResult) => {
    if (!alive.current) return
    if (result.state) setState(result.state)
    setError(result.ok ? '' : result.message ?? 'Could not refresh branches.')
    setExpandedError(undefined)
  }, [])
  const refresh = useCallback(async () => {
    if (refreshing.current) return
    refreshing.current = true
    const revision = ++version.current
    try { const result = await desktop.projectGit({ action: 'status', sessionId, workspaceId }); if (revision === version.current) accept(result) }
    catch { if (alive.current) setError('Could not refresh branches. Try again.') }
    finally { refreshing.current = false }
  }, [accept, sessionId, workspaceId])
  useEffect(() => {
    alive.current = true
    const subscriptionId = crypto.randomUUID()
    const initialVersion = version.current
    const unsubscribe = desktop.onProjectGit(event => { if (event.subscriptionId === subscriptionId) { version.current++; accept(event) } })
    void desktop.projectGit({ action: 'watch', sessionId, workspaceId, subscriptionId }).then(result => { if (version.current === initialVersion) accept(result) }).catch(() => { if (alive.current) setError('Could not inspect project branches.') })
    window.addEventListener('focus', refresh)
    return () => { alive.current = false; version.current++; unsubscribe(); window.removeEventListener('focus', refresh); void desktop.projectGit({ action: 'unwatch', sessionId, workspaceId, subscriptionId }).catch(() => {}) }
  }, [sessionId, workspaceId, accept, refresh])
  useEffect(() => {
    if (!open) return
    search.current?.focus()
    const outside = (event: PointerEvent) => { if (!popup.current?.contains(event.target as Node) && !anchor.current?.contains(event.target as Node)) close() }
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); close(); anchor.current?.focus(); return }
      if (!popup.current?.contains(document.activeElement)) return
      const focusable = [...popup.current.querySelectorAll<HTMLElement>('input, button:not(:disabled), [tabindex="0"]')]
      const index = focusable.indexOf(document.activeElement as HTMLElement)
      if (event.key === 'Tab') {
        event.preventDefault(); focusable[(index + (event.shiftKey ? -1 : 1) + focusable.length) % focusable.length]?.focus()
      } else if (!creating && !document.activeElement?.classList.contains('git-branch-error-details') && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
        event.preventDefault(); focusable[(index + (event.key === 'ArrowUp' ? -1 : 1) + focusable.length) % focusable.length]?.focus()
      }
    }
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', keyboard)
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', keyboard) }
  }, [open, creating, close])
  async function change(branch: string, create = false) {
    if (!state || changing.current) return
    changing.current = true; setPending(true); setError(''); ++version.current
    try {
      const result = await desktop.projectGit({ action: create ? 'create' : 'switch', sessionId, workspaceId, branch, expectedHead: state.head })
      if (!alive.current) return
      accept(result)
      if (result.ok) { close(); anchor.current?.focus() }
    } catch { if (alive.current) setError('The Git request was interrupted. Refresh to inspect the current branch before retrying.') }
    finally { changing.current = false; if (alive.current) setPending(false) }
  }
  if (state && !state.repository) return null
  if (!state && !error) return null
  const label = state?.branch ?? (state?.detached ? `Detached · ${state.detached}` : 'Git unavailable')
  const branches = state?.branches.filter(branch => branch.toLocaleLowerCase().includes(query.toLocaleLowerCase())) ?? []
  const ordered = [...branches].sort((a, b) => a === state?.branch ? -1 : b === state?.branch ? 1 : a.localeCompare(b))
  const blocked = readOnly ? 'Read Only mode prevents branch changes.' : state?.mutationBlocked
  const errorMessage = error || state?.error
  return <div className="git-branch-selector">
    <span className="workspace-selector-separator" aria-hidden="true">|</span>
    <button ref={anchor} className="workspace-selector-trigger git-branch-trigger" aria-label={`Git branch: ${label}`} aria-haspopup="dialog" aria-expanded={open} title={label} onClick={() => { if (open) close(); else { setOpen(true); void refresh() } }}><GitBranch size={14} /><span>{label}</span><ChevronDown size={13} /></button>
    {open && <AnchoredPopover anchorRef={anchor} popoverRef={popup} align="start" className="git-branch-popup" label={creating ? 'Create and switch to new branch' : 'Project branches'} onClose={close}>
      {creating ? <form onSubmit={event => { event.preventDefault(); void change(name, true) }}>
        <label htmlFor={`branch-name-${workspaceId}`}>Create and switch to new branch</label>
        <input ref={search} id={`branch-name-${workspaceId}`} autoFocus value={name} onChange={event => setName(event.target.value)} placeholder="feature/my-change" maxLength={255} disabled={pending} autoComplete="off" />
        <p>Start from the current HEAD. Existing uncommitted changes are preserved.</p>
        <div className="git-branch-actions"><button type="button" disabled={pending} onClick={() => setCreating(false)}>Back</button><button type="submit" disabled={pending || !name || !!blocked}>{pending ? 'Creating…' : 'Create and switch'}</button></div>
      </form> : <>
        <div className="git-branch-search"><Search size={15} /><input ref={search} aria-label="Search branches" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search branches" autoComplete="off" /><button aria-label="Refresh branches" title="Refresh branches" disabled={pending} onClick={() => void refresh()}><RefreshCw size={14} /></button></div>
        <div className="git-branch-heading">Local branches</div>
        {state?.detached && <p className="git-branch-note">Detached HEAD at {state.detached}{state.changedFiles ? ` · Uncommitted changes: ${state.changedFiles} files` : ''}</p>}
        <div className="git-branch-list" aria-label="Local branches">
          {ordered.map(branch => <button key={branch} className={`git-branch-option${state?.branch === branch ? ' active' : ''}`} aria-current={state?.branch === branch ? 'true' : undefined} disabled={pending || !!blocked} onClick={() => { if (state?.branch === branch) close(); else void change(branch) }}>
            <GitBranch size={14} /><span><strong>{branch}</strong>{state?.branch === branch && !!state.changedFiles && <small>Uncommitted changes: {state.changedFiles} {state.changedFiles === 1 ? 'file' : 'files'}</small>}</span>{state?.branch === branch && <Check size={14} />}
          </button>)}
          {!ordered.length && <p className="git-branch-note">{query ? 'No matching branches.' : 'No local branches yet.'}</p>}
        </div>
        <button className="git-branch-create" disabled={pending || !!blocked || !state?.head.split('\n')[1]} onClick={() => { setCreating(true); setError('') }}><Plus size={16} />Create and switch to new branch…</button>
      </>}
      {!!blocked && <p className="git-branch-note">{blocked}</p>}
      {!!errorMessage && <GitBranchError message={errorMessage} expanded={expandedError === errorMessage} onToggle={() => setExpandedError(current => current === errorMessage ? undefined : errorMessage)} />}
      {pending && <p role="status" className="git-branch-note">Updating branch…</p>}
    </AnchoredPopover>}
  </div>
}
