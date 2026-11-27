import { createRef, useState } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { AnchoredPopover, computePopoverPosition, getPopoverBounds, type PopoverRect } from '../src/features/chat/AnchoredPopover'

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

  it('keeps the menu within the nearest clipped settings panel', () => {
    const position = computePopoverPosition(rect(250, 480, 286, 440), { width: 290, height: 400 }, { width: 800, height: 768 }, 8, 6, 'start', { top: 40, left: 100, right: 500, bottom: 550 })
    expect(position.width).toBe(290)
    expect(position.left).toBe(202)
    expect(position.left + position.width).toBe(492)
    expect(position.top).toBeGreaterThanOrEqual(48)
    expect(position.top + position.maxHeight).toBeLessThanOrEqual(542)
  })

  it('uses overflow ancestors as bounds for fixed menus', () => {
    const panel = document.createElement('div')
    panel.style.overflowX = 'auto'
    panel.style.overflowY = 'auto'
    document.body.append(panel)
    const anchor = document.createElement('button')
    panel.append(anchor)
    vi.spyOn(panel, 'getBoundingClientRect').mockReturnValue({ top: 40, left: 100, right: 500, bottom: 550, width: 400, height: 510 } as DOMRect)
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 800 })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 768 })
    expect(getPopoverBounds(anchor)).toEqual({ top: 40, left: 100, right: 500, bottom: 550 })
    panel.remove()
  })

  it('can use viewport space for a portaled session menu without inheriting a short list height', () => {
    const anchor = rect(500, 290, 530, 266)
    const listBounds = { top: 490, left: 20, right: 300, bottom: 540 }
    const constrained = computePopoverPosition(anchor, { width: 185, height: 120 }, { width: 800, height: 768 }, 8, 6, 'end', listBounds)
    const viewport = computePopoverPosition(anchor, { width: 185, height: 120 }, { width: 800, height: 768 })
    expect(constrained.maxHeight).toBeLessThan(120)
    expect(constrained.scrollable).toBe(true)
    expect(viewport.maxHeight).toBe(120)
    expect(viewport.scrollable).toBe(false)
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
