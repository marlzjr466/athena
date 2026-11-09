import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { AttachmentCards, fitImageZoom } from '../src/features/chat/AttachmentCards'
import type { Attachment } from '../shared/conversations'

const mocks = vi.hoisted(() => ({ chatContext: vi.fn() }))
vi.mock('../src/services/desktop', () => ({ desktop: mocks }))

const sessionId = '11111111-1111-4111-8111-111111111111'
const attachments: Attachment[] = [
  { id: '22222222-2222-4222-8222-222222222222', name: 'photo.png', kind: 'image', mime: 'image/png', size: 20, characters: 0 },
  { id: '33333333-3333-4333-8333-333333333333', name: 'notes.md', kind: 'text', mime: 'text/plain', size: 20, characters: 20 },
  { id: '44444444-4444-4444-8444-444444444444', name: 'report.pdf', kind: 'text', mime: 'text/plain', size: 20, characters: 20 },
]

describe('attachment viewer', () => {
  it('fits the complete image with 150px margins where the viewport permits', () => {
    expect(fitImageZoom(1600, 900, 1400, 1000)).toBe(68.75)
    expect(fitImageZoom(1600, 900, 500, 400)).toBe(15.625)
  })
  it('shows the full-screen viewer, switches files, zooms, downloads, and closes with Escape', async () => {
    mocks.chatContext.mockImplementation(async ({ action, id }: { action: string; id: string }) => action === 'download'
      ? { ok: true, saved: true }
      : id === attachments[0].id ? { ok: true, preview: 'data:image/png;base64,AA==' }
        : { ok: true, text: id === attachments[1].id ? '# Notes\nHello Athena' : 'Page 1\nPDF content' })
    render(<AttachmentCards sessionId={sessionId} attachments={attachments} />)
    const opener = screen.getByRole('button', { name: 'Preview photo.png' })
    fireEvent.click(opener)
    const dialog = await screen.findByRole('dialog', { name: 'Preview photo.png' })
    expect(within(dialog).getByRole('navigation', { name: 'Attachments' })).toBeVisible()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Zoom in' }))
    expect(within(dialog).getByText('125%')).toBeVisible()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Show notes.md' }))
    expect(await within(dialog).findByText(/Hello Athena/)).toBeVisible()
    expect(within(dialog).getByText('100%')).toBeVisible()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Show report.pdf' }))
    expect(await within(dialog).findByText(/PDF content/)).toBeVisible()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Download attachment' }))
    await waitFor(() => expect(mocks.chatContext).toHaveBeenCalledWith({ action: 'download', sessionId, id: attachments[2].id }))
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(opener).toHaveFocus()
  })
})
