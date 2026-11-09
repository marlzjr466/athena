import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CompanionPage } from '../src/features/athena/CompanionPage'
import { CompanionShowcase } from '../src/features/athena/CompanionShowcase'
import { useAthena } from '../src/store/athenaStore'
import { defaultSettings, mergeSettings, restoreSettings } from '../shared/settings'
import type { Snapshot } from '../shared/contracts'
import { showcasePreviewCameraPose, vroidPreviewCameraPose, showcaseRenderPolicy } from '../src/three/showcaseMotion'
import { AVATAR_FADE_MS, avatarTransitionPose } from '../src/three/FloatingAvatarTransition'

// WebGL is verified by the desktop test; these exercise the real page/store UI.
vi.mock('../src/three/CompanionShowcaseScene', () => ({ CompanionShowcaseScene: () => <div data-testid="stage" />, CompanionAvatarThumbnail: () => <span data-testid="avatar-thumbnail" /> }))
const initialStore = useAthena.getState()
const snapshot: Snapshot = { settings: { ...defaultSettings, size: 280, position: { x: 103, y: 202 }, pinned: true }, state: 'idle', flight: null, idleAction: null, displays: [], visible: true, panelMode: 'chat', panelVisible: false, onBattery: false, reducedMotion: false, platform: 'darwin', version: 'test', error: null }
const update = vi.fn(async (patch) => {
  const current = useAthena.getState().snapshot!
  useAthena.setState({ snapshot: { ...current, settings: mergeSettings(current.settings, patch) } })
})
beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
  useAthena.setState({ snapshot, update, command: vi.fn() })
  update.mockClear()
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); useAthena.setState(initialStore) })

describe('companion selection', () => {
  it('shows only VRoid for now while keeping the older variants in saved settings', async () => {
    useAthena.setState({ snapshot: { ...snapshot, settings: { ...snapshot.settings, avatarVariant: 'classic' } } })
    render(<CompanionPage />)
    expect(screen.getAllByTestId('avatar-thumbnail')).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Add Model' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: 'Athena Classic' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Athena Enhanced' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Use Athena/ })).not.toBeInTheDocument()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Athena' })) })
    expect(update).toHaveBeenLastCalledWith({ avatarVariant: 'vroid-athena' })
    expect(screen.getByRole('button', { name: 'Athena' })).toHaveAttribute('aria-pressed', 'true')
    expect(restoreSettings({ avatarVariant: 'classic' }).avatarVariant).toBe('classic')
    expect(restoreSettings({ avatarVariant: 'enhanced' }).avatarVariant).toBe('enhanced')
  })
  it('hides Energy FX without changing its saved value and retains the desktop controls', () => {
    const view = render(<CompanionPage />)
    expect(screen.queryByRole('switch', { name: 'Energy FX' })).not.toBeInTheDocument()
    expect(useAthena.getState().snapshot!.settings.avatarEnergyFX).toBe(snapshot.settings.avatarEnergyFX)
    expect(screen.getByRole('switch', { name: 'Floating Athena' })).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: 'Pin Athena' })).toBeInTheDocument()
    expect(screen.getByRole('slider', { name: 'Athena size' })).toHaveValue('280')
    const stage = view.container.querySelector('.companion-avatar-section')!
    const controls = view.container.querySelector('.companion-settings-panel')!
    expect(stage.compareDocumentPosition(controls) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(stage.parentElement).toBe(controls.parentElement)
    view.unmount()
  })
  it('restores the applied variant on returning and retains persisted preferences across schema restore', async () => {
    const saved = mergeSettings(snapshot.settings, { avatarVariant: 'enhanced', avatarEnergyFX: false })
    useAthena.setState({ snapshot: { ...snapshot, settings: restoreSettings(JSON.parse(JSON.stringify(saved))) } })
    const view = render(<CompanionPage />)
    expect(screen.queryByRole('button', { name: 'Athena Enhanced' })).not.toBeInTheDocument()
    expect(useAthena.getState().snapshot!.settings.avatarVariant).toBe('enhanced')
    view.unmount()
    render(<CompanionPage />)
    expect(useAthena.getState().snapshot!.settings.avatarVariant).toBe('enhanced')
    expect(useAthena.getState().snapshot!.settings.avatarEnergyFX).toBe(false)
    expect(restoreSettings({ avatarVariant: 'invalid' }).avatarVariant).toBe('vroid-athena')
    expect(restoreSettings({ avatarVariant: 'vroid-athena' }).avatarVariant).toBe('vroid-athena')
  })
  it('keeps failed saves from displaying a false applied state', async () => {
    useAthena.setState({ snapshot: { ...snapshot, settings: { ...snapshot.settings, avatarVariant: 'classic' } } })
    useAthena.setState({ update: vi.fn(async () => { useAthena.setState({ error: 'Unable to save this setting.' }) }) })
    render(<CompanionPage />)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Athena' })) })
    expect(screen.getByRole('button', { name: 'Athena' })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('button', { name: 'Athena' })).toBeEnabled()
    expect(useAthena.getState().snapshot!.settings.avatarVariant).toBe('classic')
  })
  it('cleans up pending selection and greeting timers when leaving the showcase', async () => {
    const before = vi.getTimerCount()
    const view = render(<CompanionShowcase snapshot={{ ...snapshot, settings: { ...snapshot.settings, avatarVariant: 'classic' } }} />)
    fireEvent.click(screen.getByRole('button', { name: 'Wave to Athena Classic' }))
    expect(vi.getTimerCount()).toBe(before + 1)
    view.unmount()
    expect(vi.getTimerCount()).toBe(before)
  })
})

describe('avatar preview motion', () => {
  it('frames the measured VRoid body near 80% height and adapts to narrow panels', () => {
    const height = 2.84, width = 1.1
    const pose = vroidPreviewCameraPose(.6, height, width)
    const visibleHeight = 2 * pose.z * Math.tan(pose.fov * Math.PI / 360)
    expect(height / visibleHeight).toBeCloseTo(.8)
    expect(pose.y).toBe(pose.targetY)
    const narrow = vroidPreviewCameraPose(.2, height, width)
    expect(narrow.z).toBeGreaterThan(pose.z)
    expect(width / (2 * narrow.z * Math.tan(narrow.fov * Math.PI / 360) * .2)).toBeLessThanOrEqual(.90001)
  })
  it('keeps a level centered camera and moves back only to fit narrow viewports', () => {
    const wide = showcasePreviewCameraPose(1.6), narrow = showcasePreviewCameraPose(.8)
    expect(wide.x).toBe(0)
    expect(wide.y).toBe(wide.targetY)
    expect(narrow.y).toBe(narrow.targetY)
    expect(narrow.z).toBeGreaterThan(wide.z)
    expect(narrow.fov).toBe(wide.fov)
  })
  it('turns out to invisible and turns in to opaque, with rotation disabled for reduced motion', () => {
    expect(avatarTransitionPose(0, false, false)).toEqual({ opacity: 1, yaw: 0 })
    expect(avatarTransitionPose(1, false, false)).toEqual({ opacity: 0, yaw: 1.35 })
    expect(avatarTransitionPose(0, true, false)).toEqual({ opacity: 0, yaw: -1.35 })
    expect(avatarTransitionPose(1, true, false)).toMatchObject({ opacity: 1 })
    expect(avatarTransitionPose(.5, false, true)).toEqual({ opacity: .5, yaw: 0 })
    expect(avatarTransitionPose(.5, true, true)).toEqual({ opacity: .5, yaw: 0 })
  })
  it('finishes the two-part turn and fade within the requested transition window', () => {
    expect(AVATAR_FADE_MS * 2).toBeGreaterThanOrEqual(600)
    expect(AVATAR_FADE_MS * 2).toBeLessThanOrEqual(900)
  })
  it('reduces continuous rendering and particles under battery and motion preferences', () => {
    expect(showcaseRenderPolicy('quality', false, true)).toEqual({ fps: 15, dpr: 1, particles: 0 })
    expect(showcaseRenderPolicy('balanced', true, false)).toMatchObject({ fps: 8, particles: 0 })
    expect(showcaseRenderPolicy('performance', false, false).fps).toBe(20)
  })
})
