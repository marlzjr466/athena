import { Check, ChevronDown } from 'lucide-react'
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'

export interface CustomSelectOption {
  value: string
  label: string
  disabled?: boolean
}

export function CustomSelect({ ariaLabel, value, options, onChange, disabled = false, className = '', menuPlacement = 'down' }: {
  ariaLabel: string
  value: string
  options: CustomSelectOption[]
  onChange?(value: string): void
  disabled?: boolean
  className?: string
  menuPlacement?: 'up' | 'down' | 'auto'
}) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const [autoPlacement, setAutoPlacement] = useState({up:false,height:260})
  const root = useRef<HTMLDivElement>(null)
  const hoverClose = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const enabled = options.filter((option) => !option.disabled)
  const selected = options.find((option) => option.value === value)
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false) }
    const escape = (event: globalThis.KeyboardEvent) => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape) }
  }, [open])
  useEffect(() => () => clearTimeout(hoverClose.current), [])
  const show = () => {
    clearTimeout(hoverClose.current)
    if (disabled || !enabled.length) return
    if(menuPlacement==='auto'&&root.current){
      const rect=root.current.getBoundingClientRect()
      let top=0,bottom=window.innerHeight,parent=root.current.parentElement
      while(parent){if(/auto|scroll|hidden/.test(getComputedStyle(parent).overflowY)){const clip=parent.getBoundingClientRect();top=Math.max(top,clip.top);bottom=Math.min(bottom,clip.bottom)}parent=parent.parentElement}
      const below=bottom-rect.bottom-12,above=rect.top-top-12,up=below<Math.min(260,options.length*36+12)&&above>below
      setAutoPlacement({up,height:Math.max(60,Math.min(260,up?above:below))})
    }
    setActive(Math.max(0, enabled.findIndex((option) => option.value === value)))
    setOpen(true)
  }
  const closeAfterHover = () => {
    clearTimeout(hoverClose.current)
    hoverClose.current = setTimeout(() => setOpen(false), 140)
  }
  const choose = (next: string) => { onChange?.(next); setOpen(false) }
  const keyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault(); show()
      const direction = event.key === 'ArrowDown' ? 1 : -1
      setActive((current) => (current + direction + enabled.length) % enabled.length)
    } else if ((event.key === 'Enter' || event.key === ' ') && open) {
      event.preventDefault(); if (enabled[active]) choose(enabled[active].value)
    }
  }
  return <div ref={root} className={`custom-select ${menuPlacement === 'up' || (menuPlacement==='auto'&&autoPlacement.up) ? 'opens-up' : ''} ${open ? 'is-open' : ''} ${className}`} onMouseEnter={show} onMouseLeave={closeAfterHover} onFocus={show} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false) }}>
    <button type="button" role="combobox" className="custom-select-trigger" aria-label={ariaLabel} aria-haspopup="listbox" aria-expanded={open} value={value} disabled={disabled} onClick={() => open ? setOpen(false) : show()} onChange={(event) => { const next = event.currentTarget.value; if (next && options.some((option) => option.value === next)) choose(next) }} onKeyDown={keyDown}>
      <span>{selected?.label ?? 'Select'}</span><ChevronDown size={15} aria-hidden="true" />
    </button>
    {open && <div className="custom-select-menu" role="listbox" aria-label={`${ariaLabel} options`} style={menuPlacement==='auto'?{maxHeight:autoPlacement.height}:undefined}>
      {options.map((option) => <button type="button" role="option" aria-selected={option.value === value} className={option.value === value ? 'selected' : ''} key={option.value} disabled={option.disabled} onMouseEnter={() => { const next = enabled.findIndex((item) => item.value === option.value); if (next >= 0) setActive(next) }} onClick={() => choose(option.value)}>
        <span>{option.label}</span>{option.value === value && <Check size={14} aria-hidden="true" />}
      </button>)}
    </div>}
  </div>
}
