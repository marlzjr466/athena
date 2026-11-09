import { cloneElement, useEffect, useId, useRef, useState, type ReactElement } from 'react'
import { createPortal } from 'react-dom'

/** A small portal-based tooltip so message controls are not clipped by the transcript scroller. */
export function ChatTooltip({ label, children }: { label: string; children: ReactElement<{ 'aria-describedby'?: string }> }) {
  const id = useId(), anchor = useRef<HTMLSpanElement>(null)
  const [visible, setVisible] = useState(false), [position, setPosition] = useState({ left: 0, top: 0, below: false })
  const hovered = useRef(false), focused = useRef(false)
  const update = () => {
    const rect = anchor.current?.getBoundingClientRect()
    if (rect) {
      const halfWidth = Math.min(116, Math.max(8, window.innerWidth / 2 - 8))
      const center = rect.left + rect.width / 2
      const below = rect.top < 42
      setPosition({ left: Math.max(halfWidth, Math.min(window.innerWidth - halfWidth, center)), top: below ? rect.bottom + 7 : rect.top - 7, below })
    }
  }
  useEffect(() => {
    if (!visible) return
    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => { window.removeEventListener('resize', update); window.removeEventListener('scroll', update, true) }
  }, [visible])
  return <span ref={anchor} className="chat-tooltip-anchor"
    onMouseEnter={() => { hovered.current = true; update(); setVisible(true) }}
    onMouseLeave={() => { hovered.current = false; if (!focused.current) setVisible(false) }}
    onFocusCapture={() => { focused.current = true; update(); setVisible(true) }}
    onBlurCapture={() => { focused.current = false; if (!hovered.current) setVisible(false) }}>
    {cloneElement(children, { 'aria-describedby': visible ? id : undefined })}
    {visible && createPortal(<span id={id} role="tooltip" className={`chat-tooltip ${position.below ? 'below' : ''}`} style={{ left: position.left, top: position.top }}>{label}</span>, document.body)}
  </span>
}
