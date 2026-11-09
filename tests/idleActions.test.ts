import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IdleActionController } from '../electron/main/idleActionController'
import { ACTION_DEFINITIONS, IDLE_ACTIONS, chooseIdleAction } from '../shared/idleActions'
import { defaultSettings, type Settings } from '../shared/settings'
import { idleActionPose } from '../src/three/AthenaIdleActions'

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0) })
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })
function fixture() {
  let settings: Settings = { ...defaultSettings, enabledActions: ['wave'] }
  let eligible = true
  const changed = vi.fn()
  const controller = new IdleActionController({ settings: () => settings, eligible: () => eligible, changed })
  return { controller, changed, update: (patch: Partial<Settings>) => { settings = { ...settings, ...patch }; controller.restart() }, eligible: (value: boolean) => { eligible = value; controller.reconcile() } }
}
describe('independent idle-action scheduler', () => {
  it('waits 30 seconds, plays one action, then waits again after completion', () => {
    const f = fixture()
    f.controller.reconcile(); f.controller.reconcile()
    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(29999)
    expect(f.controller.current).toBe(null)
    vi.advanceTimersByTime(1)
    expect(f.controller.current?.id).toBe('wave')
    f.controller.reconcile()
    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(ACTION_DEFINITIONS.wave.durationMs)
    expect(f.controller.current).toBe(null)
    vi.advanceTimersByTime(29999)
    expect(f.controller.current).toBe(null)
    vi.advanceTimersByTime(1)
    expect(f.controller.current?.id).toBe('wave')
  })
  it('restarts the countdown immediately when its interval changes', () => {
    const f = fixture(); f.controller.reconcile(); vi.advanceTimersByTime(20000)
    f.update({ actionIntervalSeconds: 60 })
    vi.advanceTimersByTime(59999); expect(f.controller.current).toBe(null)
    vi.advanceTimersByTime(1); expect(f.controller.current?.id).toBe('wave')
  })
  it('pauses and cancels safely for ineligible activity, then restarts a full wait', () => {
    const f = fixture(); f.controller.reconcile(); vi.advanceTimersByTime(30000)
    f.eligible(false)
    expect(f.controller.current).toBe(null)
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(60000); f.eligible(true)
    vi.advanceTimersByTime(29999); expect(f.controller.current).toBe(null)
    vi.advanceTimersByTime(1); expect(f.controller.current?.id).toBe('wave')
  })
  it('does nothing with all actions off or Random Actions off', () => {
    const f = fixture(); f.update({ enabledActions: [] })
    expect(vi.getTimerCount()).toBe(0)
    f.update({ enabledActions: ['wave'], randomActions: false })
    expect(vi.getTimerCount()).toBe(0)
  })
  it('cancels a running action when it is disabled and disposes all timers', () => {
    const f = fixture(); f.controller.reconcile(); vi.advanceTimersByTime(30000)
    f.update({ enabledActions: ['bow'] })
    expect(f.controller.current).toBe(null)
    vi.advanceTimersByTime(30000); expect(f.controller.current?.id).toBe('bow')
    f.controller.dispose(); f.controller.reconcile()
    expect(f.controller.current).toBe(null)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('selects only enabled actions and avoids immediate repeats when possible', () => {
    for (let i = 0; i < 100; i++) expect(chooseIdleAction(['bow', 'wave'], 'wave', () => i / 100)).toBe('bow')
    expect(chooseIdleAction(['wave'], 'wave')).toBe('wave')
    expect(chooseIdleAction([], null)).toBe(null)
  })
})
describe('bounded model-only action poses', () => {
  it.each(IDLE_ACTIONS)('%s returns to neutral and keeps motion within the local window', (id) => {
    const action = { id, startedAt: 1000, durationMs: ACTION_DEFINITIONS[id].durationMs }
    expect(idleActionPose(action, 1000)).toEqual(idleActionPose(null, 0))
    for (let step = 0; step <= 100; step++) {
      const pose = idleActionPose(action, 1000 + step / 100 * action.durationMs)
      expect(Object.values(pose).every(Number.isFinite)).toBe(true)
      expect(Math.abs(pose.lift)).toBeLessThanOrEqual(0.18)
      expect(pose.scale).toBeGreaterThanOrEqual(0.75)
      expect(pose.scale).toBeLessThanOrEqual(1.04)
    }
    expect(idleActionPose(action, 1000 + action.durationMs)).toEqual(idleActionPose(null, 0))
  })
})
