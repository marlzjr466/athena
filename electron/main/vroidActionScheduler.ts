import { VROID_ACTION_IDS, VROID_IDLE_MS, VROID_FADE_MS, type VroidActionId, type VroidActionSession, type VroidClipReport, type VroidActionSnapshot, type VroidVoicePhase, type VroidVoicePlayback, type VroidVoiceSession } from '../../shared/vroidActions'

interface Context {
  selected: boolean
  blocked: boolean
  random: boolean
  enabled: readonly VroidActionId[]
  task?: { id: VroidActionId; key: string; loop: boolean }
}
/** Only this process chooses actions. Renderers own separate mixers and follow
 * absolute timestamps, including when joining an already-running action. */
export class VroidActionScheduler {
  private timer?: ReturnType<typeof setTimeout>
  private sequence = 0
  private lastRandom?: VroidActionId
  private handledTask?: string
  private paused = false
  private pendingVoiceExit?: VroidVoicePlayback
  private clips = new Map<VroidActionId, VroidClipReport>()
  session: VroidActionSession | null = null
  voiceSession: VroidVoiceSession | null = null
  constructor(private hooks: { context(): Context; changed(): void }, private now = Date.now, private random = Math.random) {}

  register(reports: VroidClipReport[]): void {
    for (const report of reports) {
      if (!VROID_ACTION_IDS.includes(report.id)) continue
      if (report.duration && Number.isFinite(report.duration) && report.duration > 0 && report.duration <= 600) this.clips.set(report.id, { id: report.id, duration: report.duration })
      else if (!this.clips.get(report.id)?.duration) this.clips.set(report.id, { id: report.id, error: report.error ?? 'Clip has an invalid duration.' })
    }
    this.reconcile()
  }
  reset(): void { this.dispose(); this.clips.clear(); this.handledTask = undefined; this.lastRandom = undefined; this.paused = false }
  snapshot(): VroidActionSnapshot { const context = this.hooks.context(); return { session: this.session, voiceSession: this.voiceSession, clips: [...this.clips.values()], blocked: context.blocked || Boolean(context.task) || Boolean(this.voiceSession) } }
  get remainingMs(): number { return this.session && !this.session.loop ? Math.max(0, this.session.startedAt + this.session.duration * 1000 / this.session.speed - this.now()) : 0 }

  /** Floating voice owns a synchronized animation lane, independent of chat task sessions. */
  setVoicePhase(phase: VroidVoicePhase | null): void {
    if (this.voiceSession?.phase === phase || (!phase && !this.voiceSession)) return
    const priorVoice = this.voiceSession
    const previous = priorVoice ? { phase: priorVoice.phase, startedAt: priorVoice.startedAt } : undefined
    if (phase) {
      const previousAction = priorVoice?.previousAction ?? (!priorVoice ? this.session ?? undefined : undefined)
      this.voiceSession = { source: 'floating-voice', phase, startedAt: this.now(), sequence: ++this.sequence, fadeMs: VROID_FADE_MS, previous, previousAction }
    } else {
      this.pendingVoiceExit = priorVoice ? { phase: priorVoice.phase, startedAt: priorVoice.startedAt } : undefined
      this.voiceSession = null
      const context = this.hooks.context()
      if (context.task && context.selected) {
        this.handledTask = context.task.key
        this.start(context.task.id, 'task', context.task.loop)
      } else if (!context.task && !context.random && context.selected) { this.handledTask = undefined; this.start('idle', 'idle', true) }
    }
    this.reconcile()
    this.hooks.changed()
  }

  private start(action: VroidActionId, source: VroidActionSession['source'], loop: boolean): boolean {
    const duration = this.clips.get(action)?.duration
    if (!duration) return false
    const previous = this.session ? { action: this.session.action, startedAt: this.session.startedAt, duration: this.session.duration, loop: this.session.loop, speed: this.session.speed } : undefined
    const previousVoice = this.pendingVoiceExit
    this.pendingVoiceExit = undefined
    this.session = { action, duration, source, loop, speed: 1, startedAt: this.now(), sequence: ++this.sequence, fadeMs: VROID_FADE_MS, previous, previousVoice }
    return true
  }
  private idle(): void { if (this.session?.action !== 'idle') this.start('idle', 'idle', true) }
  private schedule(at: number): void {
    this.timer = setTimeout(() => { this.timer = undefined; this.reconcile(); this.hooks.changed() }, Math.max(1, at - this.now()))
  }
  reconcile(): void {
    clearTimeout(this.timer); this.timer = undefined
    const context = this.hooks.context()
    const paused = context.blocked || Boolean(context.task) || !context.random || Boolean(this.voiceSession)
    const resumed = this.paused && !paused
    this.paused = paused
    if (!context.selected || !this.clips.get('idle')?.duration) { this.session = null; this.voiceSession = null; this.pendingVoiceExit = undefined; this.handledTask = undefined; return }
    if (context.task) {
      if (this.handledTask !== context.task.key) {
        this.handledTask = context.task.key
        if (!this.start(context.task.id, 'task', context.task.loop)) this.idle()
      }
    } else {
      this.handledTask = undefined
      if (context.blocked) { this.idle(); return }
      if (this.session?.source === 'task' && this.session.loop) this.idle()
    }
    if (!this.session) this.idle()
    if (resumed && this.session?.action === 'idle') this.start('idle', 'idle', true)
    const current = this.session!
    if (!current.loop) {
      if (current.source === 'random' && (!context.random || !context.enabled.includes(current.action))) this.idle()
      else if (this.remainingMs > 0) { this.schedule(this.now() + this.remainingMs); return }
      else this.idle()
    }
    if (context.blocked || context.task || this.voiceSession || !context.random || this.session?.action !== 'idle') return
    const pool = context.enabled.filter(id => id !== 'idle' && Boolean(this.clips.get(id)?.duration))
    if (!pool.length) return
    const due = this.session.startedAt + this.session.fadeMs + VROID_IDLE_MS
    if (this.now() < due) { this.schedule(due); return }
    const distinct = pool.filter(id => id !== this.lastRandom)
    const choices = distinct.length ? distinct : pool
    const id = choices[Math.min(choices.length - 1, Math.floor(this.random() * choices.length))]
    this.lastRandom = id
    this.start(id, 'random', false)
    this.schedule(this.now() + this.remainingMs)
  }
  trigger(id: VroidActionId): { ok: boolean; message?: string } {
    const context = this.hooks.context()
    if (!context.selected) return { ok: false, message: 'Select a ready VRM model first.' }
    if (context.blocked || context.task || this.voiceSession) return { ok: false, message: 'Wait until Athena finishes speaking, flying, or working.' }
    if (id !== 'idle' && !context.enabled.includes(id)) return { ok: false, message: 'Enable this VRoid action before playing it.' }
    if (!this.start(id, id === 'idle' ? 'idle' : 'manual', id === 'idle')) return { ok: false, message: this.clips.get(id)?.error ?? 'The clip is not ready. Open My companion to load and validate it.' }
    this.reconcile()
    this.hooks.changed()
    return { ok: true }
  }
  dispose(): void { clearTimeout(this.timer); this.timer = undefined; this.session = null; this.voiceSession = null; this.pendingVoiceExit = undefined }
}
