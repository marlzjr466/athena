import { SPLASH_TRANSITION_MS } from '../../shared/startup'

/** Presentation and application readiness are independent; neither can bypass the other. */
export class StartupGate {
  private presented = false
  private elapsed = false
  private ready = false
  private exiting = false
  private disposed = false
  private skipped = false
  private introTimer?: ReturnType<typeof setTimeout>
  private exitTimer?: ReturnType<typeof setTimeout>
  private deadline: ReturnType<typeof setTimeout>

  constructor(private durationMs: number, private hooks: {
    waiting(): void; transition(durationMs: number): void; complete(): void; timeout(): void
  }) {
    this.deadline = setTimeout(() => { this.dispose(); hooks.timeout() }, 45_000)
  }

  present(): void {
    if (this.disposed || this.presented) return
    this.presented = true
    this.introTimer = setTimeout(() => {
      this.elapsed = true
      if (!this.ready) this.hooks.waiting()
      this.reconcile()
    }, this.durationMs - SPLASH_TRANSITION_MS)
  }

  mainReady(): void { this.ready = true; this.reconcile() }

  skipUnavailableSplash(): void {
    if (this.disposed || this.exiting) return
    clearTimeout(this.introTimer)
    this.skipped = true; this.presented = true; this.elapsed = true
    this.reconcile()
  }

  private reconcile(): void {
    if (this.disposed || this.exiting || !this.presented || !this.elapsed || !this.ready) return
    this.exiting = true
    clearTimeout(this.deadline)
    const fade = this.skipped ? 0 : SPLASH_TRANSITION_MS
    this.hooks.transition(fade)
    this.exitTimer = setTimeout(() => { this.dispose(); this.hooks.complete() }, fade)
  }

  dispose(): void {
    this.disposed = true
    clearTimeout(this.introTimer); clearTimeout(this.exitTimer); clearTimeout(this.deadline)
  }
}
