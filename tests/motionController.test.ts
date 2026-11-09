import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import { MotionController } from '../electron/main/motionController'
import { defaultSettings, type Settings } from '../shared/settings'
import { transition } from '../shared/behavior'
import type { AthenaState } from '../shared/contracts'
import { fixedPositions, type Flight } from '../shared/flight'

const native = vi.hoisted(() => ({ cursor: { x: 0, y: 0 }, area: { x: -1920, y: 25, width: 1920, height: 1015, id: 1 } }))
vi.mock('electron', () => ({ app: { isPackaged: true }, screen: { getCursorScreenPoint: () => native.cursor, getDisplayNearestPoint: () => ({ workArea: native.area }) } }))
vi.mock('../electron/main/screenManager', () => ({ currentArea: () => native.area, movementArea: () => native.area }))

function fixture(patch: Partial<Settings> = {}) {
  let settings = { ...defaultSettings, edgePadding: 16, ...patch }
  let state: AthenaState = 'idle'
  let blocked: string | null = null
  let destroyed = false
  let visible = true
  let actionEnds = 0
  let closed = () => {}
  let bounds = { x: -500, y: 400, width: 180, height: 180 }
  const writes = vi.fn((x: number, y: number) => {
    if (destroyed) throw new Error('Window accessed after destruction')
    bounds = { ...bounds, x, y }
  })
  const behavior = vi.fn((event: Parameters<typeof transition>[1]) => { state = transition(state, event) })
  const settled = vi.fn()
  const flight = vi.fn<(flight: Flight | null) => void>()
  const window = {
    isDestroyed: () => destroyed, isVisible: () => visible,
    getBounds: () => ({ ...bounds }), setPosition: writes, setIgnoreMouseEvents: vi.fn(),
    once: (_event: string, listener: () => void) => { closed = listener },
  } as unknown as BrowserWindow
  const controller = new MotionController(window, { settings: () => settings, state: () => state, blocked: () => blocked, behavior, settled, flight, actionRemainingMs: () => Math.max(0, actionEnds - Date.now()) })
  return {
    controller, writes, behavior, settled, flight, bounds: () => bounds,
    action: (duration: number) => { actionEnds = Date.now() + duration },
    update: (patch: Partial<Settings>) => { settings = { ...settings, ...patch }; controller.restart() },
    block: (reason: string | null) => { blocked = reason; controller.reconcile() },
    state: (value: AthenaState) => { state = value; controller.reconcile() },
    hide: () => { visible = false; controller.stop() },
    show: () => { visible = true; controller.start() },
    destroy: () => { destroyed = true; closed() },
  }
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); native.cursor = { x: 0, y: 0 } })
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })

describe('scheduled native wandering', () => {
  it.each([0.5, 1, 2, 5, 10])('samples the physical landing rise even at %sx and returns to one idle frame timer', (movementSpeed) => {
    const f = fixture({ movementSpeed, enabledPositions: ['bottom-left'] })
    f.controller.start()
    vi.advanceTimersByTime(30_000)
    const flight = f.flight.mock.calls[0][0]!
    vi.advanceTimersByTime(flight.durationMs * 0.85)
    f.writes.mockClear()
    vi.advanceTimersByTime(flight.durationMs * 0.15 + flight.settleDurationMs + 100)
    expect(Math.min(...f.writes.mock.calls.map(([, y]) => y))).toBeLessThan(flight.to.y - 8)
    expect({ x: f.bounds().x, y: f.bounds().y }).toEqual(flight.to)
    expect(f.behavior).toHaveBeenLastCalledWith('REST')
    expect(vi.getTimerCount()).toBe(1) // one enabled stop: parked, no further wander timeout
    f.controller.stop()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('waits exactly the default 30 seconds before starting one native glide', () => {
    const f = fixture(); f.controller.start(); f.controller.start()
    expect(vi.getTimerCount()).toBe(2) // one frame clock + one wander timeout
    vi.advanceTimersByTime(29_999)
    expect(f.writes).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(f.behavior).toHaveBeenCalledWith('MOVE')
    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(400)
    expect(f.writes).toHaveBeenCalled()
  })
  it('never schedules disabled wandering', () => {
    const f = fixture({ randomMovement: false }); f.controller.start()
    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(120_000)
    expect(f.writes).not.toHaveBeenCalled()
  })
  it('replaces the old deadline when the interval changes from 30 to 60', () => {
    const f = fixture(); f.controller.start(); vi.advanceTimersByTime(20_000)
    f.update({ wanderIntervalSeconds: 60 })
    expect(vi.getTimerCount()).toBe(2)
    vi.advanceTimersByTime(59_999)
    expect(f.behavior).not.toHaveBeenCalledWith('MOVE')
    vi.advanceTimersByTime(1)
    expect(f.behavior).toHaveBeenCalledWith('MOVE')
  })
  it('suspends while pinned, then waits the entire interval after unpinning', () => {
    const f = fixture({ pinned: true }); f.controller.start(); vi.advanceTimersByTime(60_000)
    expect(f.writes).not.toHaveBeenCalled()
    f.update({ pinned: false }); vi.advanceTimersByTime(29_999)
    expect(f.writes).not.toHaveBeenCalled()
    vi.advanceTimersByTime(100)
    expect(f.behavior).toHaveBeenCalledWith('MOVE')
  })
  it('unpinning never enables a disabled wander preference', () => {
    const f = fixture({ pinned: true, randomMovement: false }); f.controller.start()
    f.update({ pinned: false }); vi.advanceTimersByTime(60_000)
    expect(f.writes).not.toHaveBeenCalled()
  })
  it('stops immediately when disabled mid-glide and stays at the interrupted position', () => {
    const f = fixture(); f.controller.start(); vi.advanceTimersByTime(30_600)
    const position = f.bounds(); const calls = f.writes.mock.calls.length
    f.update({ randomMovement: false }); vi.advanceTimersByTime(120_000)
    expect(f.bounds()).toEqual(position)
    expect(f.writes).toHaveBeenCalledTimes(calls)
    expect(f.behavior).toHaveBeenLastCalledWith('REST')
  })
  it('manual dragging cancels a pending countdown, then uses the configured wait after drop', () => {
    const f = fixture({ wanderIntervalSeconds: 60 }); f.controller.start(); vi.advanceTimersByTime(50_000)
    f.controller.beginDrag(); vi.advanceTimersByTime(5000)
    expect(f.behavior).not.toHaveBeenCalledWith('MOVE')
    f.controller.endDrag(); vi.advanceTimersByTime(59_999)
    expect(f.behavior).not.toHaveBeenCalledWith('MOVE')
    vi.advanceTimersByTime(1)
    expect(f.behavior).toHaveBeenCalledWith('MOVE')
  })
  it('manual dragging cancels an active automated glide', () => {
    const f = fixture(); f.controller.start(); vi.advanceTimersByTime(30_500)
    f.controller.beginDrag()
    const calls = f.writes.mock.calls.length
    vi.advanceTimersByTime(1000)
    expect(f.writes).toHaveBeenCalledTimes(calls)
    native.cursor = { x: -100_000, y: -100_000 }
    vi.advanceTimersByTime(33)
    expect(f.bounds()).toMatchObject({ x: -1904, y: 41 })
    expect(f.controller.endDrag()).toBe(true)
  })
  it('waits after completion and never overlaps journeys', () => {
    const f = fixture({ wanderIntervalSeconds: 10 }); f.controller.start()
    vi.advanceTimersByTime(10_000)
    expect(vi.getTimerCount()).toBe(1)
    while (f.settled.mock.calls.length === 0) vi.advanceTimersByTime(33)
    const calls = f.writes.mock.calls.length
    expect(vi.getTimerCount()).toBe(2)
    vi.advanceTimersByTime(9900)
    expect(f.writes).toHaveBeenCalledTimes(calls)
    expect(f.behavior.mock.calls.filter(([event]) => event === 'MOVE')).toHaveLength(1)
    vi.advanceTimersByTime(200)
    expect(f.behavior.mock.calls.filter(([event]) => event === 'MOVE')).toHaveLength(2)
  })
  it('cancels while interacting and restarts only after interaction ends', () => {
    const f = fixture(); f.controller.start(); vi.advanceTimersByTime(20_000)
    f.block('user interaction'); vi.advanceTimersByTime(60_000)
    expect(f.writes).not.toHaveBeenCalled()
    f.block(null); vi.advanceTimersByTime(29_999)
    expect(f.writes).not.toHaveBeenCalled()
    vi.advanceTimersByTime(100)
    expect(f.behavior).toHaveBeenCalledWith('MOVE')
  })
  it.each(['listening', 'speaking', 'working', 'thinking', 'moving'] as AthenaState[])('respects the %s state and restarts after it ends', (state) => {
    const f = fixture(); f.controller.start(); f.state(state)
    vi.advanceTimersByTime(60_000); expect(f.writes).not.toHaveBeenCalled()
    f.state('idle'); vi.advanceTimersByTime(29_999); expect(f.writes).not.toHaveBeenCalled()
    vi.advanceTimersByTime(100); expect(f.behavior).toHaveBeenCalledWith('MOVE')
  })
  it('cleans up on hide, show, stop and destruction', () => {
    const f = fixture(); f.controller.start(); f.hide()
    expect(vi.getTimerCount()).toBe(0)
    f.show(); vi.advanceTimersByTime(29_999); expect(f.writes).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1000); f.destroy()
    expect(vi.getTimerCount()).toBe(0)
    const calls = f.writes.mock.calls.length
    vi.advanceTimersByTime(120_000); f.controller.start(); f.controller.restart()
    expect(f.writes).toHaveBeenCalledTimes(calls)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('does not leave a stale dragging state after hide or suspend', () => {
    const f = fixture(); f.controller.start(); f.controller.beginDrag(); f.hide()
    expect(f.behavior).toHaveBeenLastCalledWith('REST')
    f.show(); vi.advanceTimersByTime(30_100)
    expect(f.behavior).toHaveBeenCalledWith('MOVE')
  })
  it('interpolates many bounded intermediate positions instead of teleporting', () => {
    const f = fixture(); const start = f.bounds(); f.controller.start(); vi.advanceTimersByTime(34_050)
    expect(f.writes.mock.calls.length).toBeGreaterThanOrEqual(45)
    for (const [x, y] of f.writes.mock.calls) {
      expect(x).toBeGreaterThanOrEqual(-1904); expect(x + 180).toBeLessThanOrEqual(-16)
      // Landing can rise into edge padding, but never outside the work area.
      expect(y).toBeGreaterThanOrEqual(native.area.y); expect(y + 180).toBeLessThanOrEqual(1024)
    }
    const finish = f.bounds()
    expect(Math.hypot(start.x - finish.x, start.y - finish.y)).toBeGreaterThanOrEqual(150)
  })
})

describe('fixed flight integration', () => {
  it('lets a short active action finish without resetting the full wander interval', () => {
    const f = fixture(); f.controller.start(); vi.advanceTimersByTime(29500)
    f.action(2200)
    vi.advanceTimersByTime(500)
    expect(f.flight).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1701)
    expect(f.flight.mock.calls[0][0]?.phase).toBe('launch')
    expect(vi.getTimerCount()).toBe(1)
  })
  it.each([0.5, 1, 2, 5, 10])('finishes exactly at a named destination with %sx speed before restarting the timer', (speed) => {
    const f = fixture({ movementSpeed: speed }); f.controller.start(); vi.advanceTimersByTime(30_000)
    const flight = f.flight.mock.calls[0][0]!
    expect(flight.speed).toBe(speed)
    expect(f.behavior).toHaveBeenLastCalledWith('MOVE')
    expect(flight.to).toEqual(fixedPositions(native.area, f.bounds(), 16)[flight.destination])
    vi.advanceTimersByTime(flight.durationMs + 34)
    expect(f.bounds()).toMatchObject(flight.to)
    expect(vi.getTimerCount()).toBe(1) // settling still owns this journey
    vi.advanceTimersByTime(flight.settleDurationMs + 34)
    expect(f.flight).toHaveBeenLastCalledWith(null)
    expect(f.behavior).toHaveBeenLastCalledWith('REST')
    expect(vi.getTimerCount()).toBe(2)
    expect(f.bounds()).toMatchObject(flight.to)
  })
  it('does not immediately revisit the departure on consecutive flights', () => {
    const f = fixture({ wanderIntervalSeconds: 10, movementSpeed: 10 }); f.controller.start()
    const destinations: string[] = []
    for (let i = 0; i < 6; i++) {
      vi.advanceTimersByTime(10_000)
      const flight = f.flight.mock.calls.filter(([value]) => value?.phase === 'launch').at(-1)![0]!
      destinations.push(flight.destination)
      vi.advanceTimersByTime(flight.durationMs + flight.settleDurationMs + 34)
    }
    for (let i = 2; i < destinations.length; i++) {
      expect(destinations[i]).not.toBe(destinations[i - 1])
      expect(destinations[i]).not.toBe(destinations[i - 2])
    }
  })
  it('clears renderer flight data when manual dragging interrupts a turn', () => {
    const f = fixture(); f.controller.start(); vi.advanceTimersByTime(30_000)
    const flight = f.flight.mock.calls[0][0]!
    vi.advanceTimersByTime(flight.durationMs * 0.25)
    f.controller.beginDrag()
    expect(f.flight).toHaveBeenLastCalledWith(null)
  })
  it('lands at the only enabled stop and then leaves no wander timer', () => {
    const f = fixture({ enabledPositions: ['mid-left'] }); f.controller.start(); vi.advanceTimersByTime(30000)
    const flight = f.flight.mock.calls[0][0]!
    expect(flight.destination).toBe('mid-left')
    vi.advanceTimersByTime(flight.durationMs + flight.settleDurationMs + 100)
    expect(vi.getTimerCount()).toBe(1) // native frame loop only
    const count = f.flight.mock.calls.length
    vi.advanceTimersByTime(90000)
    expect(f.flight.mock.calls.length).toBe(count)
  })
  it('never selects a disabled destination, even when avoiding the previous stop', () => {
    const f = fixture({ enabledPositions: ['top-left', 'bottom-right'], wanderIntervalSeconds: 10, movementSpeed: 10 })
    f.controller.start()
    for (let i = 0; i < 4; i++) {
      vi.advanceTimersByTime(10000)
      const flight = f.flight.mock.calls.filter(([v]) => v?.phase === 'launch').at(-1)![0]!
      expect(['top-left', 'bottom-right']).toContain(flight.destination)
      vi.advanceTimersByTime(flight.durationMs + flight.settleDurationMs + 100)
    }
  })
})
