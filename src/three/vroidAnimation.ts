import { AnimationMixer, LoopOnce, LoopRepeat, type AnimationAction } from 'three'
import type { AthenaState, TaskVisualMode } from '../../shared/contracts'
import type { IdleActionId } from '../../shared/idleActions'
import type { VroidAnimationName, VroidInstance } from './vroidAssets'
import { vroidPlaybackTime, type VroidActionSession, type VroidPlayback, type VroidVoicePhase, type VroidVoiceSession } from '../../shared/vroidActions'

export function vroidActionFor(state: AthenaState, taskMode: TaskVisualMode = 'idle', idleAction?: IdleActionId): VroidAnimationName {
  if (taskMode === 'cancelled') return 'idle'
  if (taskMode === 'failed') return 'sad'
  if (taskMode === 'completed') return 'clapping'
  if (taskMode !== 'idle' || state === 'thinking' || state === 'working') return 'thinking'
  if (state === 'sleeping') return 'sleepy'
  if (state === 'error') return 'sad'
  if (state === 'happy') return 'goodbye'
  if (idleAction === 'slight-jump') return 'jump'
  if (idleAction === 'wave') return 'goodbye'
  if (idleAction === 'look-around') return 'look-around'
  if (idleAction === 'happy-pose') return 'blush'
  if (idleAction === 'bow') return 'bow'
  if (idleAction === 'stretch') return 'relax'
  return 'idle'
}

export class VroidAnimationController {
  readonly mixer: AnimationMixer
  private actions = new Map<VroidAnimationName, AnimationAction>()
  private voiceActions: { gestures?: AnimationAction; expressions?: AnimationAction } = {}
  private current: AnimationAction | null = null
  private currentName: VroidAnimationName | null = null
  private looping = true
  private disposed = false
  private pendingIdle = false
  private retired = new Map<AnimationAction, number>()
  private synchronized = false
  private synchronizedSequence: number | null = null
  private synchronizedLane: 'action' | 'voice' | null = null
  private lastVoiceSession?: VroidVoiceSession
  private voiceExit?: { voice: VroidVoiceSession['previous']; startedAt: number; fadeMs: number }
  get activeName(): VroidAnimationName | null { return this.currentName }
  get isOneShot(): boolean { return !this.looping && this.currentName !== 'idle' }
  get voiceExpressionNames(): readonly string[] { return this.instance.voiceClips?.expressionNames ?? [] }
  private readonly finished = (event: { action: AnimationAction }) => {
    // Defer changes until mixer.update finishes iterating its action list.
    if (!this.synchronized && event.action === this.current && !this.looping) this.pendingIdle = true
  }

  constructor(private readonly instance: VroidInstance) {
    this.mixer = new AnimationMixer(instance.vrm.scene)
    for (const [name, clip] of Object.entries(instance.clips) as [VroidAnimationName, VroidInstance['clips'][VroidAnimationName]][]) {
      if (clip) this.actions.set(name, this.mixer.clipAction(clip))
    }
    if (instance.voiceClips?.gestures) this.voiceActions.gestures = this.mixer.clipAction(instance.voiceClips.gestures)
    if (instance.voiceClips?.expressions) this.voiceActions.expressions = this.mixer.clipAction(instance.voiceClips.expressions)
    this.mixer.addEventListener('finished', this.finished)
    this.play('idle', 0)
    this.mixer.update(0)
    instance.vrm.update(0)
  }

  play(requested: VroidAnimationName, fade = .22, loop = requested === 'idle' || requested === 'thinking' || requested === 'sleepy'): boolean {
    if (this.disposed) return false
    const name = this.actions.has(requested) ? requested : 'idle'
    const next = this.actions.get(name)
    if (!next) return false
    if (this.currentName === name && this.looping === (name === 'idle' || loop)) return name === requested
    this.looping = name === 'idle' || loop
    this.pendingIdle = false
    this.retired.delete(next)
    next.stopFading()
    next.reset()
    next.setLoop(this.looping ? LoopRepeat : LoopOnce, this.looping ? Infinity : 1)
    next.clampWhenFinished = !this.looping
    next.enabled = true
    next.setEffectiveWeight(1)
    if (this.current && this.current !== next && fade > 0) {
      next.crossFadeFrom(this.current, fade, false)
      this.retired.set(this.current, fade)
    }
    else this.current?.stop()
    next.play()
    this.current = next
    this.currentName = name
    return name === requested
  }

  update(delta: number): void {
    if (this.disposed) return
    const dt = Math.max(0, Math.min(.1, delta))
    this.mixer.update(dt)
    for (const [action, remaining] of this.retired) {
      if (remaining <= dt) { action.stop(); this.retired.delete(action) }
      else this.retired.set(action, remaining - dt)
    }
    if (this.pendingIdle) this.play('idle')
  }

  /** Follow the main-process clock, never make scheduling decisions here.
   * Absolute sampling also corrects drift after background throttling/remounts. */
  synchronize(session: VroidActionSession, now: number): void {
    if (this.disposed) return
    this.synchronized = true
    const leavingVoice = this.synchronizedLane === 'voice'
    const next = this.actions.get(session.action)
    if (!next) return
    if (this.synchronizedLane !== 'action' || this.synchronizedSequence !== session.sequence) {
      if (leavingVoice && this.lastVoiceSession) this.voiceExit = { voice: { phase: this.lastVoiceSession.phase, startedAt: this.lastVoiceSession.startedAt }, startedAt: now, fadeMs: session.fadeMs }
      else if (session.previousVoice) this.voiceExit = { voice: session.previousVoice, startedAt: session.startedAt, fadeMs: session.fadeMs }
      this.synchronizedLane = 'action'
      this.synchronizedSequence = session.sequence
      if (!this.voiceExit) this.mixer.stopAllAction()
      this.retired.clear()
      this.pendingIdle = false
      this.current = next
      this.currentName = session.action
      this.looping = session.loop
    }
    const progress = session.fadeMs > 0 ? Math.min(1, Math.max(0, (now - session.startedAt) / session.fadeMs)) : 1
    const weight = progress * progress * (3 - 2 * progress)
    const previous = session.previous && session.previous.action !== session.action ? this.actions.get(session.previous.action) : undefined
    const sample = (action: AnimationAction, playback: VroidPlayback, contribution: number) => {
      action.stopFading()
      action.enabled = true
      action.paused = false
      action.setLoop(LoopRepeat, Infinity)
      action.setEffectiveWeight(contribution)
      action.time = vroidPlaybackTime(playback, now)
      action.play()
    }
    if (this.voiceExit) {
      const exitProgress = this.voiceExit.fadeMs > 0 ? Math.min(1, Math.max(0, (now - this.voiceExit.startedAt) / this.voiceExit.fadeMs)) : 1
      const exitWeight = exitProgress * exitProgress * (3 - 2 * exitProgress)
      const voiceActions = this.voiceExit.voice ? this.voicePhaseActions(this.voiceExit.voice.phase) : []
      if (exitProgress < 1 && this.voiceExit.voice) for (const action of voiceActions) this.sampleLoop(action, this.voiceExit.voice.startedAt, now, 1 - exitWeight)
      else { for (const action of voiceActions) action.stop(); this.voiceExit = undefined; this.lastVoiceSession = undefined }
      previous?.stop()
      sample(next, session, exitWeight)
    } else {
      if (previous && progress < 1) sample(previous, session.previous!, 1 - weight)
      else previous?.stop()
      sample(next, session, previous && progress < 1 ? weight : 1)
    }
    this.mixer.update(0)
  }

  /** Floating voice is a separate presentation lane, timestamped by the shared
   * main-process scheduler so the desktop avatar and Companion preview agree. */
  synchronizeVoice(session: VroidVoiceSession, now: number): void {
    if (this.disposed) return
    this.synchronized = true
    if (this.synchronizedLane !== 'voice' || this.synchronizedSequence !== session.sequence) {
      this.voiceExit = undefined
      this.synchronizedLane = 'voice'
      this.synchronizedSequence = session.sequence
      this.mixer.stopAllAction()
      this.retired.clear()
      this.pendingIdle = false
    }
    const progress = session.fadeMs > 0 ? Math.min(1, Math.max(0, (now - session.startedAt) / session.fadeMs)) : 1
    const weight = progress * progress * (3 - 2 * progress)
    const previous = session.previous && progress < 1 ? this.voicePhaseActions(session.previous.phase) : []
    const current = this.voicePhaseActions(session.phase)
    const previousAction = !session.previous && session.previousAction ? this.actions.get(session.previousAction.action) : undefined
    const sharesAction = Boolean(previousAction && current.includes(previousAction))
    const sameAction = previous.length === 1 && current.length === 1 && previous[0] === current[0]
    if (sameAction || sharesAction) {
      this.sampleLoop(current[0], session.startedAt, now, 1)
    } else {
      if (session.previous && progress < 1) for (const action of previous) this.sampleLoop(action, session.previous.startedAt, now, 1 - weight)
      else for (const action of this.voicePhaseActions(session.previous?.phase ?? 'listening')) action.stop()
      if (previousAction && !session.previous && progress < 1) this.samplePlayback(previousAction, session.previousAction!, now, 1 - weight)
      else previousAction?.stop()
      for (const action of current) this.sampleLoop(action, session.startedAt, now, session.previousAction && !session.previous && progress < 1 ? weight : session.previous && progress < 1 ? weight : 1)
    }
    this.lastVoiceSession = session
    this.currentName = session.phase === 'thinking' ? 'thinking' : session.phase === 'listening' ? 'idle' : null
    this.current = this.currentName ? this.actions.get(this.currentName) ?? null : null
    this.looping = true
    this.mixer.update(0)
  }

  private voicePhaseActions(phase: VroidVoicePhase): AnimationAction[] {
    if (phase === 'talking') {
      const body = this.voiceActions.gestures ?? this.actions.get('idle')
      return [body, this.voiceActions.expressions].filter((action): action is AnimationAction => Boolean(action))
    }
    const action = this.actions.get(phase === 'thinking' ? 'thinking' : 'idle') ?? this.actions.get('idle')
    return action ? [action] : []
  }

  private sampleLoop(action: AnimationAction, startedAt: number, now: number, contribution: number): void {
    action.stopFading()
    action.enabled = true
    action.paused = false
    action.setLoop(LoopRepeat, Infinity)
    action.setEffectiveWeight(contribution)
    const duration = action.getClip().duration
    action.time = duration > 0 ? Math.max(0, (now - startedAt) / 1000) % duration : 0
    action.play()
  }

  private samplePlayback(action: AnimationAction, playback: VroidPlayback, now: number, contribution: number): void {
    action.stopFading()
    action.enabled = true
    action.paused = false
    action.setLoop(playback.loop ? LoopRepeat : LoopOnce, playback.loop ? Infinity : 1)
    action.clampWhenFinished = !playback.loop
    action.setEffectiveWeight(contribution)
    action.time = vroidPlaybackTime(playback, now)
    action.play()
  }

  dispose(): void {
    this.disposed = true
    this.mixer.removeEventListener('finished', this.finished)
    this.mixer.stopAllAction()
    this.mixer.uncacheRoot(this.instance.vrm.scene)
    this.actions.clear()
    this.voiceActions = {}
    this.retired.clear()
    this.current = null
    this.currentName = null
  }
}
