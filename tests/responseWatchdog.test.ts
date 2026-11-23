// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest'
import { ResponseWatchdog } from '../electron/main/ai/responseWatchdog'
import { classifyStreamFailure } from '../electron/main/ai/streamRecovery'
afterEach(() => vi.useRealTimers())
const policy = { responseConnectionSeconds: 60, responseFirstEventSeconds: 180, streamInactivitySeconds: 120 }
it.each(['connecting', 'connected', 'event'] as const)('classifies timeout at %s', phase => {
 vi.useFakeTimers(); const controller = new AbortController(), watch = new ResponseWatchdog(controller, policy)
 watch[phase](); vi.advanceTimersByTime(181000)
 expect(classifyStreamFailure(controller.signal.reason)).toBe(phase === 'connecting' ? 'request_initialization_timeout' : phase === 'connected' ? 'first_event_timeout' : 'stream_inactivity')
 watch.dispose()
})
it('keeps a genuinely active long stream alive and clears the clock before tools', () => {
 vi.useFakeTimers(); const controller = new AbortController(), watch = new ResponseWatchdog(controller, policy)
 watch.connecting(); watch.connected(); vi.advanceTimersByTime(170000); expect(controller.signal.aborted).toBe(false)
 for(let i=0;i<30;i++){ watch.event(); vi.advanceTimersByTime(100000) }
 expect(controller.signal.aborted).toBe(false); watch.dispose(); vi.advanceTimersByTime(500000); expect(controller.signal.aborted).toBe(false)
})
it('does not mislabel an unowned TimeoutError as the task deadline', () => {
 expect(classifyStreamFailure(new DOMException('timeout', 'TimeoutError'))).toBe('request_timeout')
})
