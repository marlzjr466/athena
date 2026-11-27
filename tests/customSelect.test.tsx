import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { CustomSelect } from '../src/components/ui/CustomSelect'

describe('CustomSelect popovers', () => {
  it('portals the menu and keeps long options inside a clipped settings panel', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 400 })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 300 })
    render(<div data-testid="settings-panel" style={{ overflowX: 'auto', overflowY: 'auto' }}>
      <CustomSelect ariaLabel="Sub-agent model" value="inherit" options={[
        { value: 'inherit', label: 'Inherit parent model' },
        { value: 'model', label: 'GPT-6.2-Astra · ChatGPT · t.mjrlangomez@gmail.com' },
      ]} />
    </div>)
    const panel = screen.getByTestId('settings-panel')
    vi.spyOn(panel, 'getBoundingClientRect').mockReturnValue({ top: 40, left: 100, right: 380, bottom: 290, width: 280, height: 250 } as DOMRect)
    const trigger = screen.getByRole('combobox', { name: 'Sub-agent model' })
    vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({ top: 230, left: 330, right: 370, bottom: 260, width: 40, height: 30 } as DOMRect)
    fireEvent.click(trigger)
    const menu = screen.getByRole('listbox', { name: 'Sub-agent model options' })
    vi.spyOn(menu, 'getBoundingClientRect').mockReturnValue({ top: 0, left: 0, right: 180, bottom: 400, width: 180, height: 400 } as DOMRect)
    fireEvent(window, new Event('resize'))
    expect(menu.parentElement?.parentElement).toBe(document.body)
    expect(menu.style.position).toBe('fixed')
    const left = Number.parseFloat(menu.style.left)
    const width = Number.parseFloat(menu.style.width)
    expect(width).toBe(180)
    expect(left).toBe(190)
    expect(left + width).toBe(370)
    expect(menu.style.maxHeight).toBe('234px')
    expect(menu.style.overflowY).toBe('auto')
    expect(menu.textContent).toContain('t.mjrlangomez@gmail.com')
    expect(screen.getByRole('option', { name: /GPT-6.2-Astra/ })).toHaveAttribute('title', 'GPT-6.2-Astra · ChatGPT · t.mjrlangomez@gmail.com')
  })

  it('closes from Escape, outside clicks, and option selection', () => {
    const onChange = vi.fn()
    render(<div><button type="button">Outside</button><CustomSelect ariaLabel="Test select" value="one" options={[{ value: 'one', label: 'One' }, { value: 'two', label: 'Two' }]} onChange={onChange}/></div>)
    const trigger = screen.getByRole('combobox', { name: 'Test select' })
    fireEvent.click(trigger)
    expect(screen.getByRole('listbox', { name: 'Test select options' })).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('listbox', { name: 'Test select options' })).toBeNull()
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('option', { name: 'Two' }))
    expect(onChange).toHaveBeenCalledWith('two')
    expect(screen.queryByRole('listbox', { name: 'Test select options' })).toBeNull()
  })

  it('keeps long option lists at the shared menu height and scrolls internally', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 800 })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 })
    render(<CustomSelect ariaLabel="Long select" value="one" options={Array.from({ length: 30 }, (_, index) => ({ value: index ? String(index) : 'one', label: `Option ${index + 1}` }))} />)
    const trigger = screen.getByRole('combobox', { name: 'Long select' })
    vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({ top: 100, left: 400, right: 650, bottom: 136, width: 250, height: 36 } as DOMRect)
    fireEvent.click(trigger)
    const menu = screen.getByRole('listbox', { name: 'Long select options' })
    vi.spyOn(menu, 'getBoundingClientRect').mockReturnValue({ top: 0, left: 0, right: 250, bottom: 700, width: 250, height: 700 } as DOMRect)
    Object.defineProperty(menu, 'scrollHeight', { configurable: true, value: 1080 })
    fireEvent(window, new Event('resize'))
    expect(menu.style.maxHeight).toBe('260px')
    expect(menu.style.overflowY).toBe('auto')
  })

  it('uses the trigger as its minimum width and expands for wider content', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 800 })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 600 })
    render(<CustomSelect ariaLabel="Wide select" value="one" options={[
      { value: 'one', label: 'One' },
      { value: 'wide', label: 'A wider option that needs additional popup space' },
    ]} />)
    const trigger = screen.getByRole('combobox', { name: 'Wide select' })
    vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({ top: 100, left: 200, right: 500, bottom: 136, width: 300, height: 36 } as DOMRect)
    fireEvent.click(trigger)
    const menu = screen.getByRole('listbox', { name: 'Wide select options' })
    vi.spyOn(menu, 'getBoundingClientRect').mockReturnValue({ top: 0, left: 0, right: 350, bottom: 100, width: 350, height: 100 } as DOMRect)
    fireEvent(window, new Event('resize'))
    expect(menu.style.minWidth).toBe('300px')
    expect(menu.style.width).toBe('350px')
    expect(menu.style.left).toBe('150px')
  })

  it('shrinks below the trigger width only when the available viewport requires it', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 240 })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 600 })
    render(<CustomSelect ariaLabel="Constrained select" value="one" options={[{ value: 'one', label: 'One' }]} />)
    const trigger = screen.getByRole('combobox', { name: 'Constrained select' })
    vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({ top: 100, left: 0, right: 300, bottom: 136, width: 300, height: 36 } as DOMRect)
    fireEvent.click(trigger)
    const menu = screen.getByRole('listbox', { name: 'Constrained select options' })
    vi.spyOn(menu, 'getBoundingClientRect').mockReturnValue({ top: 0, left: 0, right: 180, bottom: 100, width: 180, height: 100 } as DOMRect)
    fireEvent(window, new Event('resize'))
    expect(menu.style.minWidth).toBe('224px')
    expect(menu.style.width).toBe('224px')
    expect(menu.style.left).toBe('8px')
  })
})
