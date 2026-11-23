import { StreamFault } from './streamRecovery'

/** Only transport transitions and received events advance this clock. */
export class ResponseWatchdog {
  private timer?: ReturnType<typeof setTimeout>
  private started = Date.now()
  private first?: number
  private last?: number
  constructor(private controller: AbortController, private policy: { responseConnectionSeconds: number; responseFirstEventSeconds: number; streamInactivitySeconds: number }) {}
  private arm(kind: 'connection_timeout' | 'first_event_timeout' | 'stream_inactivity', seconds: number) {
    this.dispose()
    this.timer = setTimeout(() => this.controller.abort(new StreamFault(kind === 'connection_timeout' ? 'request_initialization_timeout' : kind, `${kind === 'connection_timeout' ? 'The provider did not return response headers' : kind === 'first_event_timeout' ? 'The provider returned headers but no first response activity' : 'The provider stopped sending response activity'} within the configured ${seconds}-second window. Completed operations are preserved.`, { configuredTimeoutMs: seconds * 1000, ...this.metrics() })), seconds * 1000)
  }
  connecting() { this.started = Date.now(); this.first = this.last = undefined; this.arm('connection_timeout', this.policy.responseConnectionSeconds) }
  connected() { this.arm('first_event_timeout', this.policy.responseFirstEventSeconds) }
  event() { this.last = Date.now(); this.first ??= this.last; this.arm('stream_inactivity', this.policy.streamInactivitySeconds) }
  metrics() { return { timeToFirstEventMs: this.first === undefined ? undefined : this.first - this.started, sinceLastEventMs: this.last === undefined ? undefined : Date.now() - this.last } }
  dispose() { clearTimeout(this.timer); this.timer = undefined }
}
