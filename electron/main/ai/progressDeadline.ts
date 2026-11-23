/** A bounded inactivity window. Only callers that observed useful work touch it. */
export class ProgressDeadline {
  private timer: ReturnType<typeof setTimeout> | undefined
  private paused = false
  constructor(private readonly durationMs: number, private readonly expired: () => void) { this.touch() }
  touch(): void {
    if (this.paused) return
    this.clear()
    this.timer = setTimeout(this.expired, this.durationMs)
  }
  clear(): void { if (this.timer) clearTimeout(this.timer); this.timer = undefined }
  pause(): void { this.paused = true; this.clear() }
  resume(): void { this.paused = false; this.touch() }
}
