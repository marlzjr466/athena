import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Plus, Check } from 'lucide-react'
import '../../styles/mediaGeneration.css'

export interface ComposerAction {
  label: string
  icon: ReactNode
  disabled?: boolean
  selected?: boolean
  run(): void
}
/** A portal keeps the menu clear of transcript/composer overflow containers. */
export function ComposerActions({ actions, disabled }: { actions: ComposerAction[]; disabled?: boolean }) {
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState({
    left: 0,
    bottom: 0,
    maxHeight: 260,
  })
  const trigger = useRef<HTMLButtonElement>(null),
    menu = useRef<HTMLDivElement>(null)
  const close = (focus = false) => {
    setOpen(false)
    if (focus) trigger.current?.focus()
  }
  useLayoutEffect(() => {
    if (!open) return
    const place = () => {
      const rect = trigger.current?.getBoundingClientRect()
      if (rect)
        setPosition({
          left: Math.max(8, Math.min(rect.left, window.innerWidth - 248)),
          bottom: window.innerHeight - rect.top + 8,
          maxHeight: Math.max(40, rect.top - 16),
        })
    }
    place()
    const focus = requestAnimationFrame(() =>
      menu.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus(),
    )
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      cancelAnimationFrame(focus)
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open])
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node))
        close()
    }
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        close(true)
      }
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('keydown', key)
    }
  }, [open])
  return (
    <>
      <button
        ref={trigger}
        className="chat-action"
        type="button"
        aria-label="Composer actions"
        title="Attachments and tools"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault()
            setOpen(true)
          }
        }}
      >
        <Plus size={19} />
      </button>
      {open &&
        createPortal(
          <div
            ref={menu}
            className="custom-select-menu composer-action-menu"
            role="menu"
            aria-label="Composer actions"
            style={position}
            onBlur={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget) && e.relatedTarget !== trigger.current) close()
            }}
            onKeyDown={(e) => {
              const items = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
              const index = items.indexOf(document.activeElement as HTMLButtonElement)
              if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) {
                e.preventDefault()
                const next =
                  e.key === 'Home'
                    ? 0
                    : e.key === 'End'
                      ? items.length - 1
                      : (index + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
                items[next]?.focus()
              }
              if (e.key === 'Tab') close()
            }}
          >
            {actions.map((action) => (
              <button
                type="button"
                role="menuitem"
                key={action.label}
                disabled={action.disabled}
                className={action.selected ? 'selected' : ''}
                onClick={() => {
                  close(true)
                  action.run()
                }}
              >
                {action.icon}
                <span>{action.label}</span>
                {action.selected && <Check size={14} />}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  )
}
