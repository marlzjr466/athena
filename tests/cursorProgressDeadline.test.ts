import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProgressDeadline } from '../electron/main/ai/progressDeadline'
import { cursorMeaningfulACPUpdate } from '../electron/main/ai/cursorACP'

afterEach(() => vi.useRealTimers())

describe('Cursor long-running ACP prompt', () => {
  it('continues past 16 and 30 minutes while meaningful work arrives', () => {
    vi.useFakeTimers()
    const expired = vi.fn()
    const deadline = new ProgressDeadline(30 * 60_000, expired)
    vi.advanceTimersByTime(16 * 60_000)
    expect(expired).not.toHaveBeenCalled()
    deadline.touch()
    vi.advanceTimersByTime(16 * 60_000)
    expect(expired).not.toHaveBeenCalled()
    deadline.touch()
    vi.advanceTimersByTime(16 * 60_000)
    expect(expired).not.toHaveBeenCalled()
    deadline.clear()
  })

  it('expires a genuinely stalled prompt and does not count heartbeats', () => {
    vi.useFakeTimers()
    const expired = vi.fn()
    new ProgressDeadline(30 * 60_000, expired)
    expect(cursorMeaningfulACPUpdate({ method: 'session/update', params: { update: { sessionUpdate: 'heartbeat' } } })).toBe(false)
    expect(cursorMeaningfulACPUpdate({ method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { text: 'Working' } } } })).toBe(true)
    vi.advanceTimersByTime(30 * 60_000)
    expect(expired).toHaveBeenCalledOnce()
  })

  it('does not expire while a permission decision is pending', () => {
    vi.useFakeTimers()
    const expired = vi.fn()
    const deadline = new ProgressDeadline(30 * 60_000, expired)
    deadline.pause()
    vi.advanceTimersByTime(60 * 60_000)
    expect(expired).not.toHaveBeenCalled()
    deadline.resume()
    vi.advanceTimersByTime(29 * 60_000)
    expect(expired).not.toHaveBeenCalled()
    vi.advanceTimersByTime(60_000)
    expect(expired).toHaveBeenCalledOnce()
  })

  it('recognizes tool completion and approval requests as progress', () => {
    expect(cursorMeaningfulACPUpdate({ method: 'session/update', params: { update: { sessionUpdate: 'tool_call_update', toolCallId: 'one', status: 'completed' } } })).toBe(true)
    expect(cursorMeaningfulACPUpdate({ method: 'session/request_permission', id: 3 })).toBe(true)
  })
})
