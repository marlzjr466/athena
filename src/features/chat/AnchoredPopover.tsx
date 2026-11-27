import { useCallback, useLayoutEffect, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'

export interface PopoverRect { top: number; right: number; bottom: number; left: number; width: number; height: number }
export interface PopoverPosition { top: number; left: number; width: number; maxHeight: number; placement: 'above' | 'below'; scrollable: boolean }

/** Places a menu next to its trigger while keeping the full menu inside the viewport. */
export interface PopoverBounds { top: number; left: number; right: number; bottom: number }

export function computePopoverPosition(anchor: PopoverRect, menu: { width: number; height: number }, viewport: { width: number; height: number }, margin = 8, gap = 6, align: 'start' | 'end' = 'end', bounds: PopoverBounds = { top: 0, left: 0, right: viewport.width, bottom: viewport.height }, preference: 'auto' | 'above' | 'below' = 'auto'): PopoverPosition {
  const leftEdge = Math.max(bounds.left + margin, margin)
  const rightEdge = Math.min(bounds.right - margin, viewport.width - margin)
  const topEdge = Math.max(bounds.top + margin, margin)
  const bottomEdge = Math.min(bounds.bottom - margin, viewport.height - margin)
  const width = Math.min(Math.max(0, menu.width), Math.max(0, rightEdge - leftEdge))
  const below = Math.max(0, bottomEdge - anchor.bottom - gap)
  const above = Math.max(0, anchor.top - topEdge - gap)
  const placement = preference === 'above' ? 'above' : preference === 'below' ? 'below' : menu.height <= below || below >= above ? 'below' : 'above'
  // If neither side alone fits, slide the full menu within the viewport. It
  // may overlap the trigger, but does not need an unnecessary internal scrollbar.
  const maxHeight = Math.max(0, Math.min(menu.height, bottomEdge - topEdge))
  const rawTop = placement === 'below' ? anchor.bottom + gap : anchor.top - gap - maxHeight
  const top = Math.max(topEdge, Math.min(rawTop, bottomEdge - maxHeight))
  const left = Math.max(leftEdge, Math.min(align === 'start' ? anchor.left : anchor.right - width, rightEdge - width))
  return { top, left, width, maxHeight, placement, scrollable: menu.height > maxHeight }
}

export function getPopoverBounds(anchor: HTMLElement): PopoverBounds {
  const bounds: PopoverBounds = { top: 0, left: 0, right: window.innerWidth, bottom: window.innerHeight }
  for (let parent = anchor.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
    const style = getComputedStyle(parent)
    const rect = parent.getBoundingClientRect()
    if (!rect.width && !rect.height) continue
    if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) {
      bounds.left = Math.max(bounds.left, rect.left)
      bounds.right = Math.min(bounds.right, rect.right)
    }
    if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
      bounds.top = Math.max(bounds.top, rect.top)
      bounds.bottom = Math.min(bounds.bottom, rect.bottom)
    }
  }
  return bounds
}

export function anchorIsVisible(anchor: HTMLElement): boolean {
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

export function AnchoredPopover({ anchorRef, popoverRef, className, label, onClose, children, align = 'end', boundary = 'anchor' }: {
  anchorRef: RefObject<HTMLElement | null>
  popoverRef: RefObject<HTMLDivElement | null>
  className: string
  label: string
  align?: 'start' | 'end'
  boundary?: 'anchor' | 'viewport'
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
    const viewport = { width: window.innerWidth, height: window.innerHeight }
    const available = boundary === 'viewport' ? { top: 0, left: 0, right: viewport.width, bottom: viewport.height } : getPopoverBounds(anchor)
    const next = computePopoverPosition(rect, { width: bounds.width || menu.offsetWidth, height: intrinsicHeight }, viewport, 8, 6, align, available)
    setPosition(current => current && current.top === next.top && current.left === next.left && current.width === next.width && current.maxHeight === next.maxHeight && current.placement === next.placement && current.scrollable === next.scrollable ? current : next)
  }, [anchorRef, popoverRef, onClose, align, boundary])

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

  return createPortal(<div ref={popoverRef} className={className} role="dialog" aria-label={label} style={{ position: 'fixed', top: position?.top ?? 0, left: position?.left ?? 0, width: position?.width, maxHeight: position?.maxHeight, overflowY: position?.scrollable ? 'auto' : 'visible', visibility: position ? 'visible' : 'hidden' }}>{children}</div>, document.body)
}
