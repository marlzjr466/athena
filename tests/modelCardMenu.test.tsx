import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ModelCardMenu } from '../src/features/athena/ModelCardMenu'
import type { ImportedAvatar } from '../shared/avatarModels'

const model = { id: 'imported-11111111-1111-4111-8111-111111111111', name: 'Luna' } as ImportedAvatar
describe('avatar card actions', () => {
  it('opens an accessible menu and routes Rename and Delete separately from selection', () => {
    const rename = vi.fn(), remove = vi.fn()
    render(<ModelCardMenu model={model} onRename={rename} onDelete={remove} />)
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Luna' }))
    expect(screen.getByRole('menuitem', { name: 'Rename' })).toHaveFocus()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }))
    expect(rename).toHaveBeenCalledOnce()
    expect(remove).not.toHaveBeenCalled()
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Luna' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }))
    expect(remove).toHaveBeenCalledOnce()
  })
  it('supports arrow navigation, Escape, and outside dismissal', () => {
    render(<ModelCardMenu model={model} onRename={vi.fn()} onDelete={vi.fn()} />)
    const trigger = screen.getByRole('button', { name: 'Actions for Luna' })
    fireEvent.click(trigger)
    fireEvent.keyDown(screen.getByRole('menuitem', { name: 'Rename' }), { key: 'ArrowDown' })
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toHaveFocus()
    fireEvent.keyDown(screen.getByRole('menuitem', { name: 'Delete' }), { key: 'Escape' })
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
    fireEvent.click(trigger)
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })
})
