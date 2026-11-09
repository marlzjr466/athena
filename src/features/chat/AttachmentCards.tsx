import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Copy, Download, FileText, Minus, Pencil, Plus, X } from 'lucide-react'
import type { Attachment } from '../../../shared/conversations'
import { desktop } from '../../services/desktop'

type Preview = { preview?: string; text?: string; snippet?: string }

export function fitImageZoom(imageWidth: number, imageHeight: number, stageWidth: number, stageHeight: number): number {
  if (imageWidth <= 0 || imageHeight <= 0 || stageWidth <= 0 || stageHeight <= 0) return 100
  const horizontalSpace = Math.min(150, Math.max(16, stageWidth / 4))
  const verticalSpace = Math.min(150, Math.max(16, stageHeight / 4))
  return 100 * Math.min(Math.max(1, stageWidth - horizontalSpace * 2) / imageWidth, Math.max(1, stageHeight - verticalSpace * 2) / imageHeight)
}

export function AttachmentCards({ sessionId, attachments, remove, restoreText, context = desktop.chatContext }: { sessionId: string; attachments: Attachment[]; remove?: (id: string) => void; restoreText?: (attachment: Attachment) => void; context?: typeof desktop.chatContext }) {
  const [previews, setPreviews] = useState<Record<string, Preview>>({})
  const [activeId, setActiveId] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [editingTextId, setEditingTextId] = useState<string | null>(null)
  const [editingText, setEditingText] = useState('')
  const [savingText, setSavingText] = useState(false)
  const [zoom, setZoom] = useState<number | null>(null)
  const [fitZoom, setFitZoom] = useState(100)
  const [imageSize, setImageSize] = useState<{ id: string; width: number; height: number } | null>(null)
  const stage = useRef<HTMLDivElement | null>(null)
  const image = useRef<HTMLImageElement | null>(null)
  const opener = useRef<HTMLButtonElement | null>(null)
  const inFlight = useRef(new Set<string>())
  const mounted = useRef(true)
  const sessionRef = useRef(sessionId)
  sessionRef.current = sessionId
  const active = attachments.find((attachment) => attachment.id === activeId)
  const imageActive = Boolean(active && previews[active.id]?.preview)
  const displayedZoom = zoom ?? (imageActive ? fitZoom : 100)
  const activeIdRef = useRef(activeId)
  activeIdRef.current = activeId

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  useEffect(() => {
    for (const attachment of attachments) if (attachment.kind === 'image' && !previews[attachment.id] && !inFlight.current.has(attachment.id)) {
      inFlight.current.add(attachment.id)
      void context({ action: 'preview', sessionId, id: attachment.id }).then((result) => {
        if (!mounted.current || sessionRef.current !== sessionId) return
        if (result.ok && result.preview) setPreviews((current) => ({ ...current, [attachment.id]: { preview: result.preview } }))
        else if (activeIdRef.current === attachment.id) setError(result.message ?? 'Preview unavailable.')
      }).catch(() => {}).finally(() => { inFlight.current.delete(attachment.id) })
    }
    // Text attachments in the composer get a bounded local preview. The full
    // text is fetched only when the user opens the viewer or restores it.
    if (remove && typeof context === 'function') for (const attachment of attachments) if (attachment.kind === 'text' && !previews[attachment.id]?.snippet && !previews[attachment.id]?.text && !inFlight.current.has(attachment.id)) {
      inFlight.current.add(attachment.id)
      void context({ action: 'preview', sessionId, id: attachment.id }).then((result) => {
        if (!mounted.current || sessionRef.current !== sessionId) return
        if (result.ok && result.text !== undefined) setPreviews((current) => ({ ...current, [attachment.id]: { snippet: result.text!.replace(/\s+/g, ' ').trim().slice(0, 180) } }))
      }).catch(() => {}).finally(() => { inFlight.current.delete(attachment.id) })
    }
  }, [attachments, previews, sessionId])

  useEffect(() => {
    if (!active || typeof context !== 'function' || previews[active.id]?.preview || previews[active.id]?.text !== undefined || inFlight.current.has(active.id)) return
    inFlight.current.add(active.id)
    void context({ action: 'preview', sessionId, id: active.id }).then((result) => {
      if (!mounted.current || sessionRef.current !== sessionId) return
      if (result.ok) setPreviews((current) => ({ ...current, [active.id]: { preview: result.preview, text: result.text } }))
      else if (activeIdRef.current === active.id) setError(result.message ?? 'Preview unavailable.')
    }).catch(() => { if (mounted.current && sessionRef.current === sessionId && activeIdRef.current === active.id) setError('Preview unavailable.') }).finally(() => { inFlight.current.delete(active.id) })
  }, [active, previews, sessionId])

  const close = () => { setActiveId(null); setError(''); opener.current?.focus() }
  const select = (id: string) => { setActiveId(id); setError(''); setZoom(null); setImageSize(null); setFitZoom(100) }
  useEffect(() => {
    if (!activeId) return
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = previous }
  }, [activeId])
  useEffect(() => {
    if (!imageActive || !stage.current || !image.current) return
    const resize = () => {
      if (!stage.current || !image.current) return
      setFitZoom(fitImageZoom(image.current.naturalWidth, image.current.naturalHeight, stage.current.clientWidth, stage.current.clientHeight))
    }
    resize()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(resize)
    observer.observe(stage.current)
    return () => observer.disconnect()
  }, [activeId, imageActive])
  useEffect(() => {
    if (!activeId) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); close() }
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        const index = attachments.findIndex((entry) => entry.id === activeId)
        const next = attachments[index + (event.key === 'ArrowLeft' ? -1 : 1)]
        if (next) { event.preventDefault(); select(next.id) }
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [activeId, attachments])

  const download = async () => {
    if (!active) return
    try {
      const result = await context({ action: 'download', sessionId, id: active.id })
      if (!result.ok) setError(result.message ?? 'Could not save this attachment.')
    } catch { setError('Could not save this attachment.') }
  }
  const beginTextEdit = async (attachment: Attachment) => {
    if (typeof context !== 'function') return
    setError('')
    const existing = previews[attachment.id]?.text
    if (existing !== undefined) { setEditingTextId(attachment.id); setEditingText(existing); return }
    inFlight.current.add(attachment.id)
    try {
      const result = await context({ action: 'preview', sessionId, id: attachment.id })
      if (!result.ok || result.text === undefined) { setError(result.message ?? 'Text preview unavailable.'); return }
      const text = result.text
      setPreviews((current) => ({ ...current, [attachment.id]: { text, snippet: text.replace(/\s+/g, ' ').trim().slice(0, 180) } }))
      setEditingTextId(attachment.id); setEditingText(text)
    } catch { setError('Text preview unavailable.') }
    finally { inFlight.current.delete(attachment.id) }
  }
  const saveTextEdit = async (attachment: Attachment) => {
    if (typeof context !== 'function' || !editingText.trim()) return
    setSavingText(true); setError('')
    try {
      const result = await context({ action: 'update-text', sessionId, id: attachment.id, text: editingText })
      if (!result.ok) { setError(result.message ?? 'Could not update the attachment.'); return }
      setPreviews((current) => ({ ...current, [attachment.id]: { text: editingText, snippet: editingText.replace(/\s+/g, ' ').trim().slice(0, 180) } }))
      setEditingTextId(null)
    } catch { setError('Could not update the attachment.') }
    finally { setSavingText(false) }
  }
  const renameText = async (attachment: Attachment) => {
    if (typeof context !== 'function') return
    const name = window.prompt('Attachment name', attachment.name)
    if (!name || name === attachment.name) return
    try {
      const result = await context({ action: 'rename', sessionId, id: attachment.id, name })
      if (!result.ok) setError(result.message ?? 'Could not rename the attachment.')
    } catch { setError('Could not rename the attachment.') }
  }
  const copyText = async (attachment: Attachment) => {
    if (typeof context !== 'function') return
    try {
      const result = await context({ action: 'preview', sessionId, id: attachment.id })
      if (!result.ok || result.text === undefined) { setError(result.message ?? 'Could not read the attachment.'); return }
      if (!navigator.clipboard?.writeText) { setError('Clipboard access is unavailable.'); return }
      await navigator.clipboard.writeText(result.text)
    } catch { setError('Could not copy the attachment.') }
  }
  const thumbnail = (attachment: Attachment) => previews[attachment.id]?.preview
    ? <img src={previews[attachment.id].preview} alt={attachment.name} />
    : <span className="attachment-file-preview" aria-hidden="true"><FileText size={22} /></span>

  return <div className="attachment-cards">
    {attachments.map((attachment) => <div className={`attachment-card ${remove ? 'is-composer-attachment' : 'is-message-attachment'} ${attachment.kind === 'image' ? 'is-image-attachment' : 'is-file-attachment'}`} key={attachment.id}>
      {attachment.kind === 'text' && remove ? editingTextId === attachment.id ? <div className="text-attachment-card text-attachment-editor">
        <textarea aria-label={`Edit ${attachment.name}`} value={editingText} onChange={(event) => setEditingText(event.target.value)} />
        <div className="text-attachment-editor-actions"><button type="button" className="text-attachment-restore" disabled={savingText || !editingText.trim()} onClick={() => void saveTextEdit(attachment)}>Save</button><button type="button" className="text-attachment-restore" disabled={savingText} onClick={() => setEditingTextId(null)}>Cancel</button></div>
      </div> : <div className="text-attachment-card">
        <button type="button" className="text-attachment-preview" aria-label={`Preview ${attachment.name}`} title={`Preview ${attachment.name}`} onClick={(event) => { opener.current = event.currentTarget; select(attachment.id) }}><span className="text-attachment-icon" aria-hidden="true"><FileText size={18} /></span><span className="text-attachment-copy"><strong>{attachment.name}</strong><small>{previews[attachment.id]?.snippet || `${attachment.characters.toLocaleString()} characters`}</small></span></button>
        <div className="text-attachment-actions">
          {restoreText && <button type="button" className="text-attachment-restore" aria-label={`Show ${attachment.name} in text field`} onClick={() => restoreText(attachment)}>Show in text field <span aria-hidden="true">→</span></button>}
          <button type="button" className="text-attachment-icon-action" aria-label={`Edit ${attachment.name}`} title="Edit" onClick={() => void beginTextEdit(attachment)}><Pencil size={13} /></button>
          <button type="button" className="text-attachment-icon-action" aria-label={`Rename ${attachment.name}`} title="Rename" onClick={() => void renameText(attachment)}><span aria-hidden="true">Aa</span></button>
          <button type="button" className="text-attachment-icon-action" aria-label={`Copy ${attachment.name}`} title="Copy" onClick={() => void copyText(attachment)}><Copy size={13} /></button>
        </div>
        <button type="button" className="attachment-remove text-attachment-remove" aria-label={`Remove ${attachment.name}`} title={`Remove ${attachment.name}`} onClick={() => remove(attachment.id)}><X size={15} /></button>
      </div> : <>
        <button type="button" className="attachment-open" aria-label={`Preview ${attachment.name}`} title={`Preview ${attachment.name}`} onClick={(event) => { opener.current = event.currentTarget; select(attachment.id) }}>{thumbnail(attachment)}</button>
        {remove && <button type="button" className="attachment-remove" aria-label={`Remove ${attachment.name}`} title={`Remove ${attachment.name}`} onClick={() => remove(attachment.id)}><X size={16} /></button>}
      </>}
    </div>)}
    {active && createPortal(<div className="attachment-viewer" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) close() }}>
      <section className="attachment-viewer-dialog" role="dialog" aria-modal="true" aria-label={`Preview ${active.name}`} onKeyDown={(event) => {
        if (event.key !== 'Tab') return
        const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
        const first = buttons[0], last = buttons.at(-1)
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
      }}>
        <header className="attachment-viewer-toolbar">
          <span className="attachment-viewer-name" title={active.name}>{active.name}</span>
          <div className="attachment-viewer-actions">
            <button type="button" aria-label="Zoom out" title="Zoom out" disabled={displayedZoom <= 1} onClick={() => setZoom(Math.max(1, displayedZoom / 1.25))}><Minus size={17} /></button>
            <span aria-live="polite">{Math.round(displayedZoom)}%</span>
            <button type="button" aria-label="Zoom in" title="Zoom in" disabled={displayedZoom >= Math.max(800, fitZoom)} onClick={() => setZoom(Math.min(Math.max(800, fitZoom), displayedZoom * 1.25))}><Plus size={17} /></button>
            <button type="button" aria-label="Download attachment" title="Download" onClick={() => void download()}><Download size={18} /></button>
            <button type="button" aria-label="Close preview" title="Close preview" autoFocus onClick={close}><X size={20} /></button>
          </div>
        </header>
        <div className="attachment-viewer-body">
          {attachments.length > 1 && <nav className="attachment-viewer-rail" aria-label="Attachments">{attachments.map((attachment) => <button type="button" key={attachment.id} aria-label={`Show ${attachment.name}`} aria-current={attachment.id === active.id ? 'true' : undefined} title={attachment.name} className={attachment.id === active.id ? 'selected' : ''} onClick={() => select(attachment.id)}>{thumbnail(attachment)}{!previews[attachment.id]?.preview && <small>{attachment.name.split('.').at(-1)?.slice(0, 5).toUpperCase()}</small>}</button>)}</nav>}
          <div ref={stage} className={`attachment-viewer-stage ${imageActive ? 'is-image' : ''}`} role="region" aria-label={`${active.name} preview`}>
            {error ? <p role="alert" className="attachment-viewer-error">{error}</p> : previews[active.id]?.preview ? <img ref={image} src={previews[active.id].preview} alt={active.name} onLoad={(event) => { const { naturalWidth: width, naturalHeight: height } = event.currentTarget; setImageSize({ id: active.id, width, height }); if (stage.current) setFitZoom(fitImageZoom(width, height, stage.current.clientWidth, stage.current.clientHeight)) }} style={imageSize?.id === active.id ? { width: `${imageSize.width * displayedZoom / 100}px`, height: `${imageSize.height * displayedZoom / 100}px` } : undefined} /> : previews[active.id]?.text !== undefined ? <div className="attachment-viewer-document"><small>{/\.(pdf|docx|xlsx)$/i.test(active.name) ? 'Extracted text preview' : 'File preview'}</small><pre style={{ fontSize: `${12 * displayedZoom / 100}px` }}>{previews[active.id].text}</pre></div> : <p role="status">Loading preview…</p>}
          </div>
        </div>
      </section>
    </div>, document.body)}
  </div>
}
