import { useEffect, useRef, useState } from 'react'
import { LoaderCircle } from 'lucide-react'
import { desktop } from '../../services/desktop'

export function OpenInVSCode({ sessionId, workspaceId, onError }: { sessionId: string; workspaceId: string; onError(message: string): void }) {
  const [available, setAvailable] = useState(false), [pending, setPending] = useState(false)
  const alive = useRef(false), opening = useRef(false), checking = useRef(false), revision = useRef(0)
  useEffect(() => {
    alive.current = true
    const refresh = async () => {
      if (checking.current || opening.current || document.hidden) return
      checking.current = true
      const version = ++revision.current
      try {
        const result = await desktop.projectEditor({ action: 'status' })
        if (alive.current && version === revision.current) setAvailable(result.ok && result.available === true)
      } catch { if (alive.current && version === revision.current) setAvailable(false) }
      finally { checking.current = false }
    }
    void refresh()
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    const timer = window.setInterval(refresh, 60_000)
    return () => { alive.current = false; revision.current++; clearInterval(timer); window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh) }
  }, [sessionId, workspaceId])
  async function open() {
    if (opening.current) return
    opening.current = true; revision.current++; setPending(true)
    onError('')
    try {
      const result = await desktop.projectEditor({ action: 'open', sessionId, workspaceId })
      if (!alive.current) return
      if (result.available !== undefined) setAvailable(result.available)
      if (!result.ok) onError(result.message ?? 'Could not open VS Code. Check its installation and try again.')
    } catch { if (alive.current) onError('Could not contact the project launcher. Try again or restart Athena.') }
    finally { opening.current = false; if (alive.current) setPending(false) }
  }
  if (!available) return null
  return <div className="project-editor-control">
    <span className="workspace-selector-separator" aria-hidden="true">|</span>
    <button type="button" className="workspace-selector-trigger project-editor-trigger" aria-label="Open in VS Code" aria-busy={pending} title="Open project folder in Visual Studio Code" disabled={pending} onClick={() => void open()}>
      {pending ? <LoaderCircle size={14} className="project-editor-spinner" aria-hidden="true" /> : <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor"><path fillRule="evenodd" d="m17 2 5 2v16l-5 2-10-8-4 3-2-1V8l2-1 4 3L17 2Zm0 5-7 5 7 5V7ZM3 9v6l3-3-3-3Z" /></svg>}
      <span>{pending ? 'Opening…' : 'Open in VS Code'}</span>
    </button>
  </div>
}
