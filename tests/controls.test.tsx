import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Toggle } from '../src/components/ui/Controls'

describe('accessible settings switches', () => {
  it('exposes state and requests the inverse state on click', () => {
    const onChange = vi.fn()
    render(<Toggle checked label="Random movement" onChange={onChange} />)
    const control = screen.getByRole('switch', { name: 'Random movement' })
    expect(control).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(control)
    expect(onChange).toHaveBeenCalledWith(false)
  })
  it('does not modify a disabled permission', () => {
    const onChange = vi.fn()
    render(<Toggle checked={false} disabled label="Microphone" onChange={onChange} />)
    fireEvent.click(screen.getByRole('switch', { name: 'Microphone' }))
    expect(onChange).not.toHaveBeenCalled()
  })
})
