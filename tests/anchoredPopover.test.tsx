import { createRef, useState } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { AnchoredPopover, computePopoverPosition, type PopoverRect } from '../src/features/chat/AnchoredPopover'

const rect = (top: number, right: number, bottom: number, left = right - 24): PopoverRect => ({ top, right, bottom, left, width: right - left, height: bottom - top })

describe('collision-aware session popover positioning', () => {
  it('opens below a trigger near the top or middle when there is room', () => {
    expect(computePopoverPosition(rect(24, 250, 48), { width: 185, height: 100 }, { width: 800, height: 768 }).placement).toBe('below')
    expect(computePopoverPosition(rect(300, 250, 324), { width: 185, height: 100 }, { width: 800, height: 768 }).placement).toBe('below')
  })

  it('flips above a trigger near the bottom and keeps the menu inside the viewport', () => {
    const position = computePopoverPosition(rect(730, 285, 754), { width: 207, height: 150 }, { width: 800, height: 768 })
    expect(position.placement).toBe('above')
    expect(position.top).toBeGreaterThanOrEqual(8)
    expect(position.top + position.maxHeight).toBeLessThanOrEqual(760)
  })

  it('clamps horizontally and fits the full menu without scrolling when neither side alone has room', () => {
    const rightEdge = computePopoverPosition(rect(300, 798, 324, 774), { width: 207, height: 100 }, { width: 800, height: 768 })
    expect(rightEdge.left).toBe(585)
    const narrow = computePopoverPosition(rect(370, 190, 394, 166), { width: 207, height: 400 }, { width: 390, height: 420 })
    expect(narrow.maxHeight).toBe(400)
    expect(narrow.scrollable).toBe(false)
    expect(narrow.top + narrow.maxHeight).toBeLessThanOrEqual(412)
    expect(narrow.left).toBeGreaterThanOrEqual(8)
    expect(narrow.left + 207).toBeLessThanOrEqual(382)
  })

  it('only scrolls when the menu is taller than the viewport itself', () => {
    const position = computePopoverPosition(rect(180, 300, 204), { width: 185, height: 500 }, { width: 800, height: 420 })
    expect(position.maxHeight).toBe(404)
    expect(position.scrollable).toBe(true)
  })

  it('renders in a body portal, flips after resize, and closes when its trigger scrolls out of view', () => {
    const anchorRef = createRef<HTMLButtonElement>()
    const menuRef = createRef<HTMLDivElement>()
    const onClose = vi.fn()
    function Harness() {
      const [open, setOpen] = useState(false)
      return <div data-testid="scroll-parent" style={{ overflowY: 'auto' }}>
        <button ref={anchorRef} onClick={() => setOpen(true)}>Open menu</button>
        {open && <AnchoredPopover anchorRef={anchorRef} popoverRef={menuRef} className="anchored-session-popover" label="Session options" onClose={() => { onClose(); setOpen(false) }}>Rename</AnchoredPopover>}
      </div>
    }
    render(<Harness />)
    const anchor = screen.getByRole('button', { name: 'Open menu' })
    const viewport = { width: 800, height: 768 }
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: viewport.width })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: viewport.height })
    vi.spyOn(anchor, 'getBoundingClientRect').mockReturnValue(rect(730, 285, 754) as DOMRect)
    fireEvent.click(anchor)
    const menu = screen.getByRole('dialog', { name: 'Session options' })
    vi.spyOn(menu, 'getBoundingClientRect').mockReturnValue({ ...rect(0, 207, 150), width: 207, height: 150 } as DOMRect)
    fireEvent(window, new Event('resize'))
    expect(menu.parentElement).toBe(document.body)
    expect(menu.style.position).toBe('fixed')
    expect(Number.parseFloat(menu.style.top)).toBeLessThan(730)
    expect(menu.style.overflowY).toBe('visible')

    const scrollParent = screen.getByTestId('scroll-parent')
    vi.spyOn(scrollParent, 'getBoundingClientRect').mockReturnValue(rect(0, 300, 200, 0) as DOMRect)
    vi.spyOn(anchor, 'getBoundingClientRect').mockReturnValue(rect(220, 285, 244) as DOMRect)
    fireEvent.scroll(scrollParent)
    expect(onClose).toHaveBeenCalledOnce()
    expect(screen.queryByRole('dialog', { name: 'Session options' })).toBeNull()
  })
})
