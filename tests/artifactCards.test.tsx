import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ArtifactCards } from '../src/features/chat/ArtifactCards'

const { context } = vi.hoisted(() => ({ context: vi.fn(async (input: { action: string }) => input.action === 'artifact-url'
  ? { ok: true, assetUrl: 'data:image/png;base64,iVBORw0KGgo=' }
  : input.action === 'preview-artifact' ? { ok: true, preview: 'data:image/png;base64,iVBORw0KGgo=' }
    : { ok: true, saved: true }) }))
vi.mock('../src/services/desktop', () => ({ desktop: { chatContext: context } }))

const artifact = {
  id: '00000000-0000-4000-8000-000000000001', name: 'athena.png', mimeType: 'image/png', size: 128,
  createdAt: 1, storageKey: '00000000-0000-4000-8000-000000000001.png', status: 'ready' as const, width: 1024, height: 1536,
}

describe('generated image conversation rendering', () => {
  it('loads the real artifact reference, preserves metadata, and opens the lightbox', async () => {
    render(<ArtifactCards sessionId="00000000-0000-4000-8000-000000000002" artifacts={[artifact]} />)
    await waitFor(() => expect(screen.getByRole('img', { name: 'athena.png' })).toBeVisible())
    expect(screen.getByText(/1024×1536/)).toBeVisible()
    fireEvent.click(screen.getByRole('img', { name: 'athena.png' }))
    expect(screen.getByRole('dialog', { name: 'athena.png full-size viewer' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Zoom in' })).toBeVisible()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(context).toHaveBeenCalledWith({ action: 'artifact-url', sessionId: '00000000-0000-4000-8000-000000000002', id: artifact.id })
  })

  it('does not strand an image in processing when the conversation snapshot rerenders', async () => {
    const view = render(<ArtifactCards sessionId="00000000-0000-4000-8000-000000000002" artifacts={[artifact]} />)
    // Conversation snapshots are recreated while switching sessions and while
    // background executions publish activity. The image request must survive
    // that rerender instead of being treated as an unmounted request.
    view.rerender(<ArtifactCards sessionId="00000000-0000-4000-8000-000000000002" artifacts={[{ ...artifact }]} />)
    await waitFor(() => expect(screen.getByRole('img', { name: 'athena.png' })).toBeVisible())
    expect(screen.queryByText('Processing image…')).toBeNull()
  })
})
