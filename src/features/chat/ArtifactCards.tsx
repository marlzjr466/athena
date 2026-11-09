import { Download, Edit3, ExternalLink, FileArchive, FileImage, FileText, Maximize2, Share2, X, ZoomIn, ZoomOut } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { GeneratedArtifact } from '../../../shared/chat'
import { desktop } from '../../services/desktop'

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

type Pan = { x: number; y: number }

/**
 * Renders generated media as first-class conversation content. Image bytes are
 * never placed in the chat record: the main process mints a short-lived,
 * ownership-checked athena://artifact capability for the renderer.
 */
export function ArtifactCards({ sessionId, artifacts }: { sessionId: string; artifacts: GeneratedArtifact[] }) {
  const [sources, setSources] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState<Record<string, boolean>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [notice, setNotice] = useState('')
  const [lightbox, setLightbox] = useState<GeneratedArtifact | null>(null)
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState<Pan>({ x: 0, y: 0 })
  const requested = useRef(new Set<string>())
  const fallbackTried = useRef(new Set<string>())
  const drag = useRef<{ x: number; y: number; pan: Pan } | null>(null)
  const mounted = useRef(true)
  const sessionRef = useRef(sessionId)
  sessionRef.current = sessionId

  useEffect(() => {
    // React Strict Mode replays setup/cleanup once in development. Resetting
    // the guard on setup keeps hydration valid there while still preventing
    // state writes after the component is genuinely unmounted.
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  useEffect(() => {
    const images = artifacts.filter((artifact) => artifact.mimeType.startsWith('image/'))
    for (const artifact of images) {
      const key = `${sessionId}:${artifact.id}`
      if (requested.current.has(key)) continue
      requested.current.add(key)
      setLoading((current) => ({ ...current, [artifact.id]: true }))
      void desktop.chatContext({ action: 'artifact-url', sessionId, id: artifact.id }).then(async (result) => {
        if (!mounted.current || sessionRef.current !== sessionId) return
        if (result.ok && result.assetUrl) {
          setSources((current) => ({ ...current, [artifact.id]: result.assetUrl! }))
          setLoading((current) => ({ ...current, [artifact.id]: false }))
          return
        }
        // Browser previews and older packaged data remain compatible while the
        // secure asset capability is unavailable.
        const fallback = await desktop.chatContext({ action: 'preview-artifact', sessionId, id: artifact.id })
        if (!mounted.current || sessionRef.current !== sessionId) return
        if (fallback.ok && fallback.preview) {
          setSources((current) => ({ ...current, [artifact.id]: fallback.preview! }))
          setErrors((current) => ({ ...current, [artifact.id]: '' }))
        } else setErrors((current) => ({ ...current, [artifact.id]: fallback.message ?? result.message ?? 'Image preview is unavailable.' }))
        setLoading((current) => ({ ...current, [artifact.id]: false }))
      }).catch(() => {
        if (!mounted.current || sessionRef.current !== sessionId) return
        setLoading((current) => ({ ...current, [artifact.id]: false }))
        setErrors((current) => ({ ...current, [artifact.id]: 'Image preview is unavailable.' }))
      })
    }
  }, [artifacts, sessionId])

  useEffect(() => {
    if (!lightbox) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setLightbox(null)
      if (event.key === '+' || event.key === '=') setZoom((current) => Math.min(4, current + .25))
      if (event.key === '-') setZoom((current) => Math.max(.5, current - .25))
      if (event.key === '0') { setZoom(1); setPan({ x: 0, y: 0 }) }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [lightbox])

  const download = async (artifact: GeneratedArtifact) => {
    setNotice('')
    try {
      const result = await desktop.chatContext({ action: 'download-artifact', sessionId, id: artifact.id })
      if (!result.ok) setNotice(result.message ?? 'Could not save the generated file.')
      else if (result.saved) setNotice(`${artifact.name} saved.`)
    } catch { setNotice('Could not save the generated file.') }
  }
  const open = async (artifact: GeneratedArtifact) => {
    setNotice('')
    try {
      const result = await desktop.chatContext({ action: 'open-artifact', sessionId, id: artifact.id })
      if (!result.ok) setNotice(result.message ?? 'Could not open the generated file.')
    } catch { setNotice('Could not open the generated file.') }
  }
  const previewForShare = async (artifact: GeneratedArtifact): Promise<string | undefined> => {
    const existing = sources[artifact.id]
    if (existing?.startsWith('data:')) return existing
    const result = await desktop.chatContext({ action: 'preview-artifact', sessionId, id: artifact.id })
    if (result.ok && result.preview) {
      setSources((current) => ({ ...current, [artifact.id]: result.preview! }))
      return result.preview
    }
    throw new Error(result.message ?? 'Image bytes are unavailable for sharing.')
  }
  const recoverImagePreview = async (artifact: GeneratedArtifact) => {
    const key = `${sessionId}:${artifact.id}`
    if (fallbackTried.current.has(key)) {
      setSources((current) => { const next = { ...current }; delete next[artifact.id]; return next })
      setErrors((current) => ({ ...current, [artifact.id]: 'The generated image could not be loaded.' }))
      return
    }
    fallbackTried.current.add(key)
    try {
      const result = await desktop.chatContext({ action: 'preview-artifact', sessionId, id: artifact.id })
      if (result.ok && result.preview) setSources((current) => ({ ...current, [artifact.id]: result.preview! }))
      else {
        setSources((current) => { const next = { ...current }; delete next[artifact.id]; return next })
        setErrors((current) => ({ ...current, [artifact.id]: result.message ?? 'The generated image could not be loaded.' }))
      }
    } catch {
      setSources((current) => { const next = { ...current }; delete next[artifact.id]; return next })
      setErrors((current) => ({ ...current, [artifact.id]: 'The generated image could not be loaded.' }))
    }
  }
  const share = async (artifact: GeneratedArtifact) => {
    setNotice('')
    try {
      const source = await previewForShare(artifact)
      if (!source) throw new Error('Image bytes are unavailable for sharing.')
      const blob = await (await fetch(source)).blob()
      const file = new File([blob], artifact.name, { type: artifact.mimeType })
      const shareApi = navigator as Navigator & { share?: (data: { title?: string; text?: string; files?: File[] }) => Promise<void>; canShare?: (data: { files?: File[] }) => boolean }
      if (shareApi.share && (!shareApi.canShare || shareApi.canShare({ files: [file] }))) {
        await shareApi.share({ title: artifact.name, files: [file] })
        return
      }
      const ClipboardItemCtor = (window as Window & { ClipboardItem?: new (items: Record<string, Blob>) => ClipboardItem }).ClipboardItem
      if (navigator.clipboard?.write && ClipboardItemCtor) {
        await navigator.clipboard.write([new ClipboardItemCtor({ [blob.type]: blob })])
        setNotice('Image copied to the clipboard.')
      } else setNotice('System sharing is unavailable. Use Download to export the image.')
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Could not share the generated image.') }
  }
  const showLightbox = (artifact: GeneratedArtifact) => {
    if (!sources[artifact.id]) return
    setZoom(1); setPan({ x: 0, y: 0 }); setLightbox(artifact)
  }
  const source = lightbox ? sources[lightbox.id] : undefined

  return <div className="chat-artifacts" aria-label="Generated files">
    {artifacts.map((artifact) => {
      const image = artifact.mimeType.startsWith('image/')
      const imageSource = sources[artifact.id]
      const Icon = image ? FileImage : artifact.mimeType.includes('zip') ? FileArchive : FileText
      if (image) return <figure className="chat-generated-image" key={artifact.id}>
        <div className="chat-generated-image-frame">
          {loading[artifact.id] && <div className="chat-generated-image-status" role="status">Processing image…</div>}
          {!loading[artifact.id] && imageSource && <button type="button" className="chat-generated-image-trigger" onClick={() => showLightbox(artifact)} aria-label={`Open ${artifact.name} full size`}><img className="chat-generated-image-preview" src={imageSource} alt={artifact.name} onError={() => void recoverImagePreview(artifact)} /></button>}
          {!loading[artifact.id] && !imageSource && <div className="chat-generated-image-status error" role="alert">{errors[artifact.id] ?? 'Image preview is unavailable.'}</div>}
          {imageSource && <button type="button" className="chat-generated-image-expand" onClick={() => showLightbox(artifact)} aria-label={`Open ${artifact.name} full size`} title="Open full size"><Maximize2 size={15} /></button>}
        </div>
        <figcaption className="chat-generated-image-caption">
          <div className="chat-generated-image-meta"><strong title={artifact.name}>{artifact.name}</strong><small>{artifact.mimeType} · {formatBytes(artifact.size)}{artifact.width && artifact.height ? ` · ${artifact.width}×${artifact.height}` : ''}</small></div>
          <div className="chat-generated-image-actions">
            <button type="button" className="chat-action chat-image-action" disabled title="Image editing is not exposed by the current provider" aria-label="Edit image unavailable"><Edit3 size={15} /> Edit</button>
            <button type="button" className="chat-action chat-icon-action" aria-label={`Download ${artifact.name}`} title="Download" onClick={() => void download(artifact)}><Download size={16} /></button>
            <button type="button" className="chat-action chat-icon-action" aria-label={`Share ${artifact.name}`} title="Share or copy" onClick={() => void share(artifact)}><Share2 size={16} /></button>
            <button type="button" className="chat-action chat-icon-action" aria-label={`Open ${artifact.name}`} title="Open in default app" onClick={() => void open(artifact)}><ExternalLink size={16} /></button>
          </div>
        </figcaption>
      </figure>
      return <article className="chat-artifact" key={artifact.id}>
        <Icon size={24} aria-hidden="true" />
        <div className="chat-artifact-info"><strong title={artifact.name}>{artifact.name}</strong><small>{artifact.mimeType} · {formatBytes(artifact.size)}</small></div>
        <div className="chat-artifact-actions"><button type="button" className="chat-action chat-icon-action" aria-label={`Open ${artifact.name}`} title="Open" onClick={() => void open(artifact)}><ExternalLink size={16} /></button><button type="button" className="chat-action chat-icon-action" aria-label={`Save ${artifact.name}`} title="Save As" onClick={() => void download(artifact)}><Download size={17} /></button></div>
      </article>
    })}
    {notice && <p className="chat-message-note" role="status">{notice}</p>}
    {lightbox && source && <div className="chat-image-lightbox" role="dialog" aria-modal="true" aria-label={`${lightbox.name} full-size viewer`} onMouseDown={(event) => { if (event.target === event.currentTarget) setLightbox(null) }}>
      <button type="button" className="chat-image-lightbox-close chat-action" aria-label="Close image viewer" onClick={() => setLightbox(null)}><X size={19} /></button>
      <div className="chat-image-lightbox-viewport" onWheel={(event) => { event.preventDefault(); setZoom((current) => Math.max(.5, Math.min(4, current + (event.deltaY < 0 ? .15 : -.15)))) }} onPointerDown={(event) => { if (zoom <= 1) return; event.currentTarget.setPointerCapture(event.pointerId); drag.current = { x: event.clientX, y: event.clientY, pan } }} onPointerMove={(event) => { if (!drag.current) return; setPan({ x: drag.current.pan.x + event.clientX - drag.current.x, y: drag.current.pan.y + event.clientY - drag.current.y }) }} onPointerUp={() => { drag.current = null }} onPointerCancel={() => { drag.current = null }}>
        <img src={source} alt={lightbox.name} className="chat-image-lightbox-image" style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }} draggable={false} />
      </div>
      <div className="chat-image-lightbox-toolbar"><button type="button" className="chat-action" onClick={() => setZoom((current) => Math.max(.5, current - .25))} aria-label="Zoom out"><ZoomOut size={16} /> Zoom out</button><button type="button" className="chat-action" onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }) }}>Fit</button><button type="button" className="chat-action" onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }) }}>Original</button><button type="button" className="chat-action" onClick={() => setZoom((current) => Math.min(4, current + .25))} aria-label="Zoom in"><ZoomIn size={16} /> Zoom in</button><button type="button" className="chat-action" onClick={() => void download(lightbox)}><Download size={16} /> Download</button><button type="button" className="chat-action" onClick={() => void share(lightbox)}><Share2 size={16} /> Share</button></div>
    </div>}
  </div>
}
