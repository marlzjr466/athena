import { Check, ChevronDown } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { anchorIsVisible, computePopoverPosition, getPopoverBounds, type PopoverPosition } from '../../features/chat/AnchoredPopover'

export interface CustomSelectOption {
  value: string
  label: string
  disabled?: boolean
  description?: string
}

const DEFAULT_MENU_MAX_HEIGHT = 260

export function CustomSelect({ ariaLabel, value, options, onChange, disabled = false, className = '', menuPlacement = 'auto' }: {
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
  const [position, setPosition] = useState<PopoverPosition | null>(null)
  const [triggerWidth, setTriggerWidth] = useState(0)
  const [menuContext, setMenuContext] = useState('')
  const root = useRef<HTMLDivElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const hoverClose = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const enabled = options.filter((option) => !option.disabled)
  const selected = options.find((option) => option.value === value)
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node) && !menu.current?.contains(event.target as Node)) setOpen(false)
    }
    const escape = (event: globalThis.KeyboardEvent) => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape) }
  }, [open])
  useEffect(() => () => clearTimeout(hoverClose.current), [])
  useLayoutEffect(() => {
    if (!open) { setPosition(null); return }
    const reposition = () => {
      const trigger = root.current?.querySelector<HTMLElement>('.custom-select-trigger')
      const popup = menu.current
      if (!trigger || !popup) return
      if (!anchorIsVisible(trigger)) { setOpen(false); return }
      const anchor = trigger.getBoundingClientRect()
      setTriggerWidth(current => current === anchor.width ? current : anchor.width)
      // Measure against stylesheet sizing rather than the previous positioned
      // inline size. This keeps content-driven width responsive and preserves
      // each menu's CSS max-height across scroll and viewport updates.
      const inlineWidth = popup.style.width
      const inlineMinWidth = popup.style.minWidth
      const inlineMaxHeight = popup.style.maxHeight
      popup.style.width = ''
      popup.style.minWidth = `${anchor.width}px`
      popup.style.maxHeight = ''
      const configuredMaxHeight = Number.parseFloat(getComputedStyle(popup).maxHeight)
      const menuMaxHeight = Number.isFinite(configuredMaxHeight) ? configuredMaxHeight : DEFAULT_MENU_MAX_HEIGHT
      const bounds = popup.getBoundingClientRect()
      const contentHeight = Math.max(bounds.height, popup.scrollHeight + Math.max(0, popup.offsetHeight - popup.clientHeight))
      const height = Math.min(contentHeight, menuMaxHeight)
      popup.style.width = inlineWidth
      popup.style.minWidth = inlineMinWidth
      popup.style.maxHeight = inlineMaxHeight
      const preference = menuPlacement === 'up' ? 'above' : menuPlacement === 'down' ? 'below' : 'auto'
      // The popup starts at the rendered trigger width, then may expand to its
      // intrinsic content width. The positioner clamps the result to the
      // available viewport or overflow ancestor.
      const measuredWidth = Math.max(anchor.width, bounds.width)
      const placed = computePopoverPosition(anchor, { width: measuredWidth, height }, { width: window.innerWidth, height: window.innerHeight }, 8, 6, 'end', getPopoverBounds(trigger), preference)
      const next = { ...placed, scrollable: contentHeight > placed.maxHeight }
      setPosition(current => current && current.top === next.top && current.left === next.left && current.width === next.width && current.maxHeight === next.maxHeight && current.placement === next.placement && current.scrollable === next.scrollable ? current : next)
    }
    reposition()
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(reposition)
    if (root.current) observer?.observe(root.current)
    if (menu.current) observer?.observe(menu.current)
    document.addEventListener('scroll', reposition, true)
    window.addEventListener('resize', reposition)
    window.visualViewport?.addEventListener('resize', reposition)
    window.visualViewport?.addEventListener('scroll', reposition)
    return () => {
      observer?.disconnect()
      document.removeEventListener('scroll', reposition, true)
      window.removeEventListener('resize', reposition)
      window.visualViewport?.removeEventListener('resize', reposition)
      window.visualViewport?.removeEventListener('scroll', reposition)
    }
  }, [open, menuPlacement, options.length])
  const show = () => {
    clearTimeout(hoverClose.current)
    if (disabled || !enabled.length) return
    const context = root.current?.closest('.media-settings, .meeting, .cursor-model-select')
    setMenuContext(context ? [...context.classList].filter(name => ['media-settings', 'meeting', 'cursor-model-select'].includes(name)).join(' ') : '')
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
  return <div ref={root} className={`custom-select ${open && position?.placement === 'above' ? 'opens-up' : ''} ${open ? 'is-open' : ''} ${className}`} onMouseEnter={show} onMouseLeave={closeAfterHover} onFocus={show} onBlur={(event) => {
    const target = event.relatedTarget as Node | null
    if (!event.currentTarget.contains(target) && !menu.current?.contains(target)) setOpen(false)
  }}>
    <button type="button" role="combobox" className="custom-select-trigger" aria-label={ariaLabel} title={selected?.description ? `${selected.label}\n${selected.description}` : selected?.label} aria-haspopup="listbox" aria-expanded={open} value={value} disabled={disabled} onClick={() => open ? setOpen(false) : show()} onChange={(event) => { const next = event.currentTarget.value; if (next && options.some((option) => option.value === next)) choose(next) }} onKeyDown={keyDown}>
      <span>{selected?.label ?? 'Select'}</span><ChevronDown size={15} aria-hidden="true" />
    </button>
    {open && createPortal(<div className={`custom-select-portal-context ${menuContext}`} onMouseEnter={() => clearTimeout(hoverClose.current)} onMouseLeave={closeAfterHover}>
      <div ref={menu} className="custom-select-menu" role="listbox" aria-label={`${ariaLabel} options`} style={{ position: 'fixed', top: position?.top ?? 0, left: position?.left ?? 0, width: position?.width, minWidth: triggerWidth ? Math.min(triggerWidth, position?.width ?? triggerWidth) : undefined, maxHeight: position?.maxHeight, overflowY: position?.scrollable ? 'auto' : 'visible', visibility: position ? 'visible' : 'hidden' }}>
        {options.map((option) => <button type="button" role="option" aria-selected={option.value === value} title={option.description ? `${option.label}\n${option.description}` : option.label} className={option.value === value ? 'selected' : ''} key={option.value} disabled={option.disabled} onMouseEnter={() => { const next = enabled.findIndex((item) => item.value === option.value); if (next >= 0) setActive(next) }} onClick={() => choose(option.value)}>
          <span>{option.label}</span>{option.value === value && <Check size={14} aria-hidden="true" />}
        </button>)}
      </div>
    </div>, document.body)}
  </div>
}
