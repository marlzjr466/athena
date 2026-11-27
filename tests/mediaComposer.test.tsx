import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ComposerActions } from '../src/features/chat/ComposerActions'
import { MediaRevision } from '../src/features/chat/MediaJobControls'
import { MediaGenerationSettings } from '../src/features/settings/MediaGenerationSettings'
import { defaultSettings, mergeSettings } from '../shared/settings'
import type { Snapshot } from '../shared/contracts'
import { useAthena } from '../src/store/athenaStore'
const mock = vi.hoisted(() => ({ command: vi.fn() }))
vi.mock('../src/services/desktop', () => ({
  desktop: {
    mediaGeneration: mock.command,
    inferenceConnections: async () => ({ connections: [] }),
  },
}))
beforeEach(() => {
  mock.command.mockReset().mockResolvedValue({
    routes: [
      {
        id: 'image',
        connection: 'a',
        provider: 'Fixture images',
        model: 'image-model',
        billing: 'api',
        operations: ['image', 'edit-image'],
        controls: ['quality', 'count'],
        values: { quality: ['low', 'high'] },
      },
      {
        id: 'video',
        connection: 'b',
        provider: 'Fixture videos',
        model: 'video-model',
        billing: 'api',
        operations: ['video', 'animate'],
        controls: ['duration'],
      },
    ],
    notices: ['Subscription endpoint has no generation tool.'],
    paidRequests: 0,
  })
  useAthena.setState({
    error: null,
    snapshot: { settings: structuredClone(defaultSettings) } as Snapshot,
    update: async (patch) => {
      const snapshot = useAthena.getState().snapshot!
      useAthena.setState({
        snapshot: {
          ...snapshot,
          settings: mergeSettings(snapshot.settings, patch),
        },
      })
    },
  })
})
describe('media composer and shared settings', () => {
  it('moves actions into one accessible popup and handles navigation, selection and dismissal', async () => {
    const a = vi.fn(),
      b = vi.fn()
    render(
      <ComposerActions
        actions={[
          { label: 'Add photos and files', icon: <span />, run: a },
          { label: 'Create image', icon: <span />, run: b },
          { label: 'Create video', icon: <span />, run: vi.fn() },
        ]}
      />,
    )
    expect(screen.queryByRole('menu')).toBeNull()
    const plus = screen.getByRole('button', { name: 'Composer actions' })
    fireEvent.click(plus)
    await waitFor(() => expect(screen.getByRole('menuitem', { name: 'Add photos and files' })).toHaveFocus())
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' })
    expect(screen.getByRole('menuitem', { name: 'Create image' })).toHaveFocus()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Create image' }))
    expect(b).toHaveBeenCalledOnce()
    expect(a).not.toHaveBeenCalled()
    expect(screen.queryByRole('menu')).toBeNull()
    fireEvent.click(plus)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(plus).toHaveFocus()
    fireEvent.click(plus)
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('menu')).toBeNull()
  })
  it('edits by selecting a conversation reference without an inline form', async () => {
    mock.command.mockResolvedValue({ ok: true })
    const { container } = render(<MediaRevision sessionId="session" parentId="source" video={false} />)
    expect(container.querySelector('form')).toBeNull()
    expect(container.querySelector('input')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Animate image' }))
    await waitFor(() =>
      expect(mock.command).toHaveBeenCalledWith({
        action: 'compose',
        sessionId: 'session',
        parentId: 'source',
        mode: 'video',
        operation: 'animate',
      }),
    )
  })
  it('uses shared selects and switches, keeps image/video preferences independent and persists defaults', async () => {
    const { container, unmount } = render(<MediaGenerationSettings />)
    expect(container.querySelector('select')).toBeNull()
    expect(mock.command).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Check generation providers' }))
    await screen.findByText('Fixture images · image-model')
    fireEvent.click(screen.getByRole('combobox', { name: 'Image preferred provider' }))
    fireEvent.click(screen.getByRole('option', { name: 'Fixture images' }))
    await waitFor(() =>
      expect(useAthena.getState().snapshot!.settings.mediaGeneration.image.preferred).toBe('image'),
    )
    fireEvent.click(screen.getByRole('combobox', { name: 'Image default quality' }))
    expect(screen.queryByRole('option', { name: 'medium' })).toBeNull()
    fireEvent.click(screen.getByRole('option', { name: 'high' }))
    await waitFor(() =>
      expect(useAthena.getState().snapshot!.settings.mediaGeneration.image.defaults.quality).toBe('high'),
    )
    expect(useAthena.getState().snapshot!.settings.mediaGeneration.video.defaults).toEqual({})
    fireEvent.click(screen.getByRole('switch', { name: 'Enable video generation' }))
    await waitFor(() =>
      expect(useAthena.getState().snapshot!.settings.mediaGeneration.video.enabled).toBe(false),
    )
    expect(useAthena.getState().snapshot!.settings.mediaGeneration.confirmPaid).toBe(true)
    unmount()
    render(<MediaGenerationSettings />)
    expect(screen.getByRole('combobox', { name: 'Image preferred model' })).toHaveTextContent('Saved model')
    expect(screen.getByRole('switch', { name: 'Enable video generation' })).toHaveAttribute(
      'aria-checked',
      'false',
    )
  })
})
