import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { VroidActionSettings } from '../src/features/settings/VroidActionSettings'
import { useAthena } from '../src/store/athenaStore'
import { defaultSettings, mergeSettings, restoreSettings } from '../shared/settings'
import { VROID_ACTIONS, VROID_RANDOM_IDS } from '../shared/vroidActions'
import type { Snapshot } from '../shared/contracts'
const { play } = vi.hoisted(() => ({ play: vi.fn(async () => ({ ok: true })) }))
vi.mock('../src/services/desktop', () => ({ desktop: { playVroidAction: play } }))
const original = useAthena.getState()
beforeEach(() => {
  const snapshot = { settings: { ...defaultSettings, avatarVariant: 'vroid-athena', enabledActions: ['wave'] }, vroidActions: { session: null, blocked: false, clips: VROID_ACTIONS.map(({ id }) => ({ id, duration: 2 })) } } as unknown as Snapshot
  useAthena.setState({ snapshot, update: vi.fn(async patch => {
    const previous = useAthena.getState().snapshot!
    useAthena.setState({ snapshot: { ...previous, settings: mergeSettings(previous.settings, patch) } })
  }) })
  play.mockClear()
})
afterEach(() => useAthena.setState(original))
it('shows all English labels and original filenames, including always-enabled Idle', () => {
  render(<VroidActionSettings />)
  for (const action of VROID_ACTIONS) {
    expect(screen.getByRole('button', { name: `Play ${action.label}` })).toBeEnabled()
    expect(screen.getByRole('switch', { name: `Enable ${action.label}` })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByText(new RegExp(action.file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))).toBeInTheDocument()
  }
  expect(screen.getByRole('switch', { name: 'Enable Idle' })).toBeDisabled()
})
it('persists independent VRoid toggles and routes manual playback through desktop IPC', async () => {
  render(<VroidActionSettings />)
  await act(async () => { fireEvent.click(screen.getByRole('switch', { name: 'Enable Bow' })) })
  expect(screen.getByRole('button', { name: 'Play Bow' })).toBeDisabled()
  const saved = restoreSettings(JSON.parse(JSON.stringify(useAthena.getState().snapshot!.settings)))
  expect(saved.vroidEnabledActions).toEqual(VROID_RANDOM_IDS.filter(id => id !== 'bow'))
  expect(saved.enabledActions).toEqual(['wave'])
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Play Peace Sign' })) })
  expect(play).toHaveBeenCalledExactlyOnceWith('peace-sign')
})
