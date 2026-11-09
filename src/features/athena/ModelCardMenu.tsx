import { useEffect, useRef, useState } from 'react'
import { EllipsisVertical, Pencil, Trash2 } from 'lucide-react'
import type { ImportedAvatar } from '../../../shared/avatarModels'

export function ModelCardMenu({ model, onRename, onDelete }: { model: ImportedAvatar; onRename(): void; onDelete(): void }) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!open) return
    root.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus()
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false) }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [open])
  return <div className="model-card-actions" ref={root} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false) }} onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); setOpen(false); trigger.current?.focus() }
    if (open && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault()
      const items = [...(root.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])]
      const current = items.indexOf(document.activeElement as HTMLButtonElement)
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (current + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length
      items[next]?.focus()
    }
  }}>
    <button ref={trigger} className="model-menu-trigger" aria-label={`Actions for ${model.name}`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}><EllipsisVertical size={16} /></button>
    {open && <div className="model-card-menu" role="menu" aria-label={`${model.name} actions`}>
      <button role="menuitem" onClick={() => { setOpen(false); onRename() }}><Pencil size={13} /> Rename</button>
      <button role="menuitem" className="model-delete-action" onClick={() => { setOpen(false); onDelete() }}><Trash2 size={13} /> Delete</button>
    </div>}
  </div>
}
