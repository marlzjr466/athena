import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { ModelDialog } from '../src/features/athena/ModelDialog'
import type { ImportedAvatar } from '../shared/avatarModels'
const mocks = vi.hoisted(() => ({ command: vi.fn(), integrate: vi.fn(async () => {}), forget: vi.fn() }))
vi.mock('../src/three/importAvatar', () => ({ modelCommand: mocks.command, integrateImportedAvatar: mocks.integrate, forgetModelPortrait: mocks.forget }))
const model = { id: 'imported-00000000-0000-4000-8000-000000000001', name: 'Luna', importStatus: 'processing' } as ImportedAvatar
beforeEach(() => {
  vi.clearAllMocks()
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', '') }
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open') }
})
it('uses the native picker, suggests a filename, waits for confirmation, and keeps the customized name', async () => {
  const close = vi.fn()
  mocks.command.mockResolvedValueOnce({ ok: true, pick: { token: 'token', fileName: 'Character.vrm', suggestedName: 'Character' } }).mockResolvedValueOnce({ ok: true, model })
  render(<ModelDialog models={[]} onClose={close} />)
  expect(screen.getByRole('button', { name: 'Import Model' })).toBeDisabled()
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Choose .vrm file' })))
  expect(mocks.command).toHaveBeenCalledExactlyOnceWith({ action: 'pick' })
  expect(screen.getByLabelText('Model Name')).toHaveValue('Character')
  expect(screen.getByText('Character.vrm')).toBeVisible()
  fireEvent.change(screen.getByLabelText('Model Name'), { target: { value: '  Luna  ' } })
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Import Model' })))
  expect(mocks.command).toHaveBeenLastCalledWith({ action: 'import', token: 'token', name: 'Luna' })
  expect(mocks.integrate).toHaveBeenCalledWith(model)
  expect(close).toHaveBeenCalledOnce()
})
it('validates duplicate and whitespace-only names before sending an import request', async () => {
  mocks.command.mockResolvedValue({ ok: true, pick: { token: 'token', fileName: 'Character.vrm', suggestedName: 'Character' } })
  render(<ModelDialog models={[]} onClose={vi.fn()} />)
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Choose .vrm file' })))
  for (const value of ['Athena', '  ']) {
    fireEvent.change(screen.getByLabelText('Model Name'), { target: { value } })
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Import Model' })))
    expect(screen.getByRole('alert')).toBeVisible()
  }
  expect(mocks.command).toHaveBeenCalledTimes(1)
})
it('renames only the stable record and never reloads geometry or integrates again', async () => {
  mocks.command.mockResolvedValue({ ok: true })
  render(<ModelDialog models={[model]} rename={model} onClose={vi.fn()} />)
  expect(screen.getByLabelText('Model Name')).toHaveValue('Luna')
  fireEvent.change(screen.getByLabelText('Model Name'), { target: { value: 'Rin' } })
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save Name' })))
  expect(mocks.command).toHaveBeenCalledExactlyOnceWith({ action: 'rename', id: model.id, name: 'Rin' })
  expect(mocks.integrate).not.toHaveBeenCalled()
})
it('cancels without importing and reports picker failures without losing the dialog', async () => {
  const close = vi.fn()
  mocks.command.mockRejectedValue(new Error('Choose a .vrm file.'))
  render(<ModelDialog models={[]} onClose={close} />)
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Choose .vrm file' })))
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Choose a .vrm file.'))
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(close).toHaveBeenCalledOnce()
  expect(mocks.integrate).not.toHaveBeenCalled()
})
it('requires confirmation before deletion and releases the deleted portrait cache', async () => {
  const close = vi.fn()
  mocks.command.mockResolvedValue({ ok: true })
  render(<ModelDialog models={[model]} remove={model} onClose={close} />)
  expect(screen.getByRole('heading')).toHaveTextContent('Delete Luna?')
  expect(screen.queryByLabelText('Model Name')).not.toBeInTheDocument()
  expect(mocks.command).not.toHaveBeenCalled()
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Delete Model' })))
  expect(mocks.command).toHaveBeenCalledExactlyOnceWith({ action: 'delete', id: model.id })
  expect(mocks.forget).toHaveBeenCalledWith(model.id)
  expect(close).toHaveBeenCalledOnce()
})
it('keeps the deletion dialog open on failure and does not send deletion when cancelled', async () => {
  const close = vi.fn()
  mocks.command.mockRejectedValue(new Error('Model storage directory is not authorized.'))
  render(<ModelDialog models={[model]} remove={model} onClose={close} />)
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Delete Model' })))
  expect(screen.getByRole('alert')).toHaveTextContent('not authorized')
  expect(close).not.toHaveBeenCalled()
  expect(mocks.forget).not.toHaveBeenCalled()
  mocks.command.mockClear()
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(mocks.command).not.toHaveBeenCalled()
  expect(close).toHaveBeenCalledOnce()
})
