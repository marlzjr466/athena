import { Check, ChevronDown } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'

export interface CursorChoice { id: string; label: string; family: string }

export function CursorModelSelect({ value, models, disabled, onChange, pending, catalogAvailable = true }: { value: string; models: CursorChoice[]; disabled: boolean; onChange(id: string): void; pending?: boolean; catalogAvailable?: boolean }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const root = useRef<HTMLDivElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const ordered = useMemo(() => {
    const groups = new Map<string, CursorChoice[]>()
    for (const model of models) groups.set(model.family, [...(groups.get(model.family) ?? []), model])
    return [...groups.values()].flat()
  }, [models])
  const filtered = useMemo(() => ordered.filter((model) => `${model.label} ${model.id} ${model.family}`.toLowerCase().includes(query.toLowerCase().trim())), [ordered, query])
  const selected = models.find((model) => model.id === value)
  const legacyAuto = value.toLowerCase() === 'auto' || value.toLowerCase() === 'auto/model'
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false) }
    document.addEventListener('pointerdown', outside)
    search.current?.focus()
    return () => document.removeEventListener('pointerdown', outside)
  }, [open])
  const show = () => {
    if (disabled || !models.length) return
    setQuery(''); setActive(Math.max(0, ordered.findIndex((model) => model.id === value))); setOpen(true)
  }
  const choose = (id: string) => { if (disabled) return; onChange(id); setOpen(false); root.current?.querySelector<HTMLButtonElement>('.custom-select-trigger')?.focus() }
  const keyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') { event.preventDefault(); setOpen(false); root.current?.querySelector<HTMLButtonElement>('.custom-select-trigger')?.focus(); return }
    if (disabled) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (!open) { show(); return }
      setActive((current) => (current + (event.key === 'ArrowDown' ? 1 : -1) + filtered.length) % Math.max(1, filtered.length))
    } else if (event.key === 'Enter' && open && filtered[active]) { event.preventDefault(); choose(filtered[active].id) }
  }
  return <div ref={root} className={`custom-select conversation-model-selector cursor-model-select opens-up ${open ? 'is-open' : ''}`} onKeyDown={keyDown}>
    <button type="button" role="combobox" className="custom-select-trigger" aria-label="Conversation model" aria-haspopup="listbox" aria-expanded={open} disabled={disabled} title={pending ? 'Applies after the current task' : legacyAuto ? 'Previous default model' : selected?.id ?? value} onClick={() => open ? setOpen(false) : show()}>
      <span>{pending ? 'Next: ' : ''}{selected?.label ?? (legacyAuto ? 'Previous default · select model' : value ? `${catalogAvailable ? 'Unavailable' : 'Catalog unavailable'}: ${value}` : 'Select Cursor model')}</span><ChevronDown size={15} aria-hidden="true" />
    </button>
    {open && <div className="custom-select-menu cursor-model-menu">
      <input ref={search} type="search" role="searchbox" aria-label="Search Cursor models" placeholder="Search models…" value={query} onChange={(event) => { setQuery(event.target.value); setActive(0) }} />
      <div role="listbox" aria-label="Conversation model options">
        {filtered.map((model, index) => <div key={model.id}>
          {(index === 0 || filtered[index - 1].family !== model.family) && <div className="cursor-model-group" role="presentation">{model.family}</div>}
          <button type="button" role="option" aria-selected={model.id === value} disabled={disabled} className={`${model.id === value ? 'selected' : ''} ${index === active ? 'active' : ''}`} title={model.id} onMouseEnter={() => setActive(index)} onClick={() => choose(model.id)}><span>{model.label}</span>{model.id === value && <Check size={14} aria-hidden="true" />}</button>
        </div>)}
        {!filtered.length && <p className="cursor-model-empty">No matching Cursor models</p>}
      </div>
    </div>}
  </div>
}
