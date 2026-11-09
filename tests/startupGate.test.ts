import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StartupGate } from '../electron/main/startupGate'
import { splashDurationMs } from '../shared/startup'

beforeEach(() => vi.useFakeTimers())
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })
const fixture = (duration = 6000) => {
  const hooks = { waiting: vi.fn(), transition: vi.fn(), complete: vi.fn(), timeout: vi.fn() }
  return { gate: new StartupGate(duration, hooks), ...hooks }
}

describe('startup presentation and readiness gate', () => {
  it.each([[undefined, 6000], ['', 6000], ['bad', 6000], ['Infinity', 6000], [4, 5000], [6.5, 6500], [9, 8000]])('normalizes %s to %s ms', (input, expected) => {
    expect(splashDurationMs(input)).toBe(expected)
  })
  it.each([5000, 6000, 8000])('crossfades only during the final second of a %s ms presentation', duration => {
    const f = fixture(duration)
    f.gate.mainReady()
    vi.advanceTimersByTime(2000) // Loading the splash is not part of its presentation.
    expect(f.transition).not.toHaveBeenCalled()
    f.gate.present(); f.gate.present()
    vi.advanceTimersByTime(duration - 1001)
    expect(f.transition).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(f.transition).toHaveBeenCalledExactlyOnceWith(1000)
    expect(f.complete).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1000)
    expect(f.complete).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('holds a visible identity until the main application is ready', () => {
    const f = fixture(); f.gate.present()
    vi.advanceTimersByTime(12000)
    expect(f.waiting).toHaveBeenCalledOnce()
    expect(f.transition).not.toHaveBeenCalled()
    f.gate.mainReady(); f.gate.mainReady()
    expect(f.transition).toHaveBeenCalledOnce()
    vi.advanceTimersByTime(1000)
    expect(f.complete).toHaveBeenCalledOnce()
  })
  it('bypasses a failed splash while still waiting for the application', () => {
    const f = fixture(); f.gate.skipUnavailableSplash()
    vi.advanceTimersByTime(7000)
    expect(f.complete).not.toHaveBeenCalled()
    f.gate.mainReady(); vi.runOnlyPendingTimers()
    expect(f.transition).toHaveBeenCalledExactlyOnceWith(0)
    expect(f.complete).toHaveBeenCalledOnce()
    expect(f.timeout).not.toHaveBeenCalled()
  })
  it('reports a startup timeout without exposing an unready main window', () => {
    const f = fixture(); f.gate.present()
    vi.advanceTimersByTime(45000)
    expect(f.timeout).toHaveBeenCalledOnce()
    f.gate.mainReady()
    expect(f.transition).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
  it.each([0, 3000, 5500])('cancels every callback when exiting at %s ms', elapsed => {
    const f = fixture(); f.gate.present(); f.gate.mainReady()
    vi.advanceTimersByTime(elapsed)
    f.gate.dispose(); f.gate.dispose()
    vi.advanceTimersByTime(60000)
    expect(f.complete).not.toHaveBeenCalled()
    expect(f.timeout).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
})
