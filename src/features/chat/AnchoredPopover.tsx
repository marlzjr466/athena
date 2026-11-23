import { useCallback, useLayoutEffect, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'

export interface PopoverRect { top: number; right: number; bottom: number; left: number; width: number; height: number }
export interface PopoverPosition { top: number; left: number; maxHeight: number; placement: 'above' | 'below'; scrollable: boolean }

/** Places a menu next to its trigger while keeping the full menu inside the viewport. */
export function computePopoverPosition(anchor: PopoverRect, menu: { width: number; height: number }, viewport: { width: number; height: number }, margin = 8, gap = 6, align: 'start' | 'end' = 'end'): PopoverPosition {
  const width = Math.min(Math.max(0, menu.width), Math.max(0, viewport.width - margin * 2))
  const below = Math.max(0, viewport.height - margin - anchor.bottom - gap)
  const above = Math.max(0, anchor.top - margin - gap)
  const placement = menu.height <= below || below >= above ? 'below' : 'above'
  // If neither side alone fits, slide the full menu within the viewport. It
  // may overlap the trigger, but does not need an unnecessary internal scrollbar.
  const maxHeight = Math.max(0, Math.min(menu.height, viewport.height - margin * 2))
  const rawTop = placement === 'below' ? anchor.bottom + gap : anchor.top - gap - maxHeight
  const top = Math.max(margin, Math.min(rawTop, viewport.height - margin - maxHeight))
  const left = Math.max(margin, Math.min(align === 'start' ? anchor.left : anchor.right - width, viewport.width - margin - width))
  return { top, left, maxHeight, placement, scrollable: menu.height > maxHeight }
}

function anchorIsVisible(anchor: HTMLElement): boolean {
  const rect = anchor.getBoundingClientRect()
  // JSDOM and detached layout passes can report zero-sized boxes; treat those as unknown, not offscreen.
  if ((rect.width > 0 || rect.height > 0) && (rect.bottom <= 0 || rect.top >= window.innerHeight || rect.right <= 0 || rect.left >= window.innerWidth)) return false
  for (let parent = anchor.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
    const style = getComputedStyle(parent)
    if (!/(auto|scroll|hidden|clip)/.test(`${style.overflow} ${style.overflowX} ${style.overflowY}`)) continue
    const clip = parent.getBoundingClientRect()
    if (clip.width && clip.height && (rect.bottom <= clip.top || rect.top >= clip.bottom || rect.right <= clip.left || rect.left >= clip.right)) return false
  }
  return true
}

export function AnchoredPopover({ anchorRef, popoverRef, className, label, onClose, children, align = 'end' }: {
  anchorRef: RefObject<HTMLElement | null>
  popoverRef: RefObject<HTMLDivElement | null>
  className: string
  label: string
  align?: 'start' | 'end'
  onClose(): void
  children: ReactNode
}) {
  const [position, setPosition] = useState<PopoverPosition | null>(null)
  const reposition = useCallback(() => {
    const anchor = anchorRef.current, menu = popoverRef.current
    if (!anchor || !menu || !anchor.isConnected) return
    if (!anchorIsVisible(anchor)) { onClose(); return }
    const rect = anchor.getBoundingClientRect()
    const bounds = menu.getBoundingClientRect()
    const intrinsicHeight = Math.max(bounds.height, menu.scrollHeight + Math.max(0, menu.offsetHeight - menu.clientHeight))
    const next = computePopoverPosition(rect, { width: bounds.width || menu.offsetWidth, height: intrinsicHeight }, { width: window.innerWidth, height: window.innerHeight }, 8, 6, align)
    setPosition(current => current && current.top === next.top && current.left === next.left && current.maxHeight === next.maxHeight && current.placement === next.placement && current.scrollable === next.scrollable ? current : next)
  }, [anchorRef, popoverRef, onClose, align])

  useLayoutEffect(() => {
    reposition()
    const anchor = anchorRef.current, menu = popoverRef.current
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(reposition)
    if (anchor) observer?.observe(anchor)
    if (menu) observer?.observe(menu)
    // Capture scroll events so nested project lists also trigger repositioning.
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
  }, [anchorRef, popoverRef, reposition])

  // The outer popup stays mounted while Options changes to Rename or Delete.
  // Its previous maxHeight must not constrain the new content.
  useLayoutEffect(() => { reposition() }, [children, reposition])

  return createPortal(<div ref={popoverRef} className={className} role="dialog" aria-label={label} style={{ position: 'fixed', top: position?.top ?? 0, left: position?.left ?? 0, maxHeight: position?.maxHeight, overflowY: position?.scrollable ? 'auto' : 'visible', visibility: position ? 'visible' : 'hidden' }}>{children}</div>, document.body)
}
