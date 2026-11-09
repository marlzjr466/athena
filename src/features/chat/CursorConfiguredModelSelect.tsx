import { Check, ChevronDown, ChevronLeft, SlidersHorizontal } from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { cursorConfigurationId, cursorConfigurationLabel, cursorSelection, type CursorModel, type CursorModelConfiguration, type CursorSelection } from '../../../shared/cursor'

export function CursorConfiguredModelSelect({ value, models, configurations, disabled, pending, onChange }: {
  value: string; models: CursorModel[]; configurations: CursorModelConfiguration[]; disabled: boolean; pending?: boolean; onChange(id: string): void
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  const [active, setActive] = useState(0)
  const [position, setPosition] = useState({ left: 8, bottom: 8, height: 400, narrow: false })
  const trigger = useRef<HTMLButtonElement>(null)
  const popup = useRef<HTMLDivElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const selected = cursorSelection(value, configurations, models)
  const automatic = configurations.find((model) => model.name === 'Auto' && ['auto', 'default'].includes(model.id))
  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase()
    return configurations.filter((model) => model !== automatic && (!term
      || `${model.name} ${model.id}`.toLowerCase().includes(term)
      || model.options.some((option) => option.category === 'thought_level' && option.options.some((entry) => `${model.name} ${entry.name}`.toLowerCase().includes(term)))))
  }, [configurations, query, automatic])
  const choiceFor = (model: CursorModelConfiguration): CursorSelection => {
    if (selected?.model.id === model.id) return selected
    const values = Object.fromEntries(model.options.map((option) => [option.id, option.currentValue]))
    // Selecting a different model never opts into an extra usage tier.
    if (model.options.some((option) => option.id === 'fast' && option.options.some((entry) => entry.value === 'false'))) values.fast = 'false'
    return { model, values }
  }
  const listChoices = filtered.flatMap((model) => {
    const base = choiceFor(model)
    const effort = model.options.find((option) => option.category === 'thought_level' && /effort|reasoning|thought_level/i.test(option.id))
    if (!effort) return [{ selection: base, label: cursorConfigurationLabel(base), key: model.id }]
    return effort.options.map((entry) => {
      const selection = { model, values: { ...base.values, [effort.id]: entry.value } }
      return { selection, label: `${model.name} ${entry.name}`, key: `${model.id}:${entry.value}` }
    })
  })
  const editedModel = configurations.find((model) => model.id === editing)
  const edited = editedModel ? choiceFor(editedModel) : null
  const close = () => { setOpen(false); setEditing(null); trigger.current?.focus() }
  useLayoutEffect(() => {
    if (!open) return
    const place = () => {
      const rect = trigger.current?.getBoundingClientRect()
      if (!rect) return
      const narrow = window.innerWidth < 520
      const width = narrow ? Math.min(300, window.innerWidth - 16) : editing ? 482 : 268
      const height = Math.min(460, Math.max(150, rect.top - 16))
      setPosition({ left: Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8)), bottom: Math.max(8, window.innerHeight - rect.top + 8), height, narrow })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true) }
  }, [open, editing])
  useEffect(() => {
    if (!open) return
    search.current?.focus()
    const outside = (event: PointerEvent) => {
      if (!popup.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) { setOpen(false); setEditing(null) }
    }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [open])
  const apply = (selection: CursorSelection, dismiss = false) => {
    if (disabled) return
    onChange(cursorConfigurationId(selection.model, selection.values))
    if (dismiss) close()
  }
  return <div className="custom-select conversation-model-selector cursor-configured-select">
    <button ref={trigger} type="button" role="combobox" aria-label="Conversation model" aria-haspopup="dialog" aria-expanded={open} disabled={disabled}
      className="custom-select-trigger" title={value} onClick={() => { setOpen(!open); setQuery(''); setActive(0); setEditing(null) }}>
      <span>{pending ? 'Next: ' : ''}{selected ? cursorConfigurationLabel(selected) : models.find((model) => model.id === value)?.label ?? 'Select Cursor model'}</span><ChevronDown size={15} />
    </button>
    {open && createPortal(<div ref={popup} role="dialog" aria-label="Cursor model settings" className={`cursor-picker-popover ${position.narrow ? 'narrow' : ''}`}
      style={{ left: position.left, bottom: position.bottom, maxHeight: position.height }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') { event.preventDefault(); close() }
        if (event.target !== search.current || disabled) return
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setActive((index) => (index + (event.key === 'ArrowDown' ? 1 : -1) + listChoices.length) % Math.max(1, listChoices.length)) }
        if (event.key === 'Enter' && listChoices[active]) { event.preventDefault(); apply(listChoices[active].selection, true) }
      }}>
      {(!position.narrow || !editing) && <div className="cursor-picker-models">
        <input ref={search} type="search" aria-label="Search Cursor models" placeholder="Search models" value={query} onChange={(event) => { setQuery(event.target.value); setActive(0) }} />
        {automatic && <button className="cursor-picker-auto" type="button" role="switch" aria-label="Cursor Auto model" aria-checked={selected?.model.id === automatic.id} disabled={disabled || selected?.model.id === automatic.id} onClick={() => apply(choiceFor(automatic), true)}><span>Auto</span><span className="cursor-picker-switch" data-checked={selected?.model.id === automatic.id} /></button>}
        <div role="listbox" aria-label="Conversation model options" className="cursor-picker-list">
          {listChoices.map(({ selection, label, key }, index) => {
            const isSelected = selected?.model.id === selection.model.id && cursorConfigurationId(selected.model, selected.values) === cursorConfigurationId(selection.model, selection.values)
            return <div key={key} className={`cursor-picker-row ${index === active || editing === selection.model.id ? 'active' : ''}`}>
              <button type="button" role="option" aria-selected={isSelected} disabled={disabled} title={cursorConfigurationId(selection.model, selection.values)} onMouseEnter={() => setActive(index)} onClick={() => apply(selection, true)}>
                <span>{label}</span>{isSelected && <Check size={13} />}
              </button>
              {!!selection.model.options.length && <button type="button" className="cursor-picker-edit" aria-label={`Edit ${label} settings`} aria-expanded={editing === selection.model.id} disabled={disabled} onClick={() => setEditing(editing === selection.model.id ? null : selection.model.id)}><SlidersHorizontal size={12} /><span>Edit</span></button>}
            </div>
          })}
          {!listChoices.length && <p>No matching models</p>}
        </div>
      </div>}
      {edited && <div className="cursor-picker-parameters">
        {position.narrow && <button type="button" onClick={() => setEditing(null)}><ChevronLeft size={14} /> Models</button>}
        {edited.model.options.map((option) => {
          const isToggle = option.id === 'fast' && option.options.length === 2 && option.options.every((entry) => ['true', 'false'].includes(entry.value))
          return <section key={option.id} aria-label={`${option.name} settings`}>
            <div className="cursor-picker-heading">{isToggle ? 'Options' : option.name}</div>
            {isToggle
              ? <button type="button" role="switch" aria-label="Cursor Fast mode" aria-checked={edited.values[option.id] === 'true'} disabled={disabled} onClick={() => apply({ ...edited, values: { ...edited.values, [option.id]: edited.values[option.id] === 'true' ? 'false' : 'true' } })}><span>Fast</span><span className="cursor-picker-switch" data-checked={edited.values[option.id] === 'true'} /></button>
              : <div role="group" aria-label={`Cursor ${option.name}`}>
                {option.options.map((entry) => <button type="button" key={entry.value} aria-pressed={edited.values[option.id] === entry.value} disabled={disabled}
                  onClick={() => apply({ ...edited, values: { ...edited.values, [option.id]: entry.value } })}>
                  <span>{entry.name}</span>{edited.values[option.id] === entry.value && <Check size={13} />}
                </button>)}
              </div>}
          </section>
        })}
        {pending && <p className="cursor-picker-pending">Applies after the current task.</p>}
      </div>}
    </div>, document.body)}
  </div>
}
