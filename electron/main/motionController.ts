import { app, screen, type BrowserWindow } from 'electron'
import { fitPosition, isCharacterHit, type Point } from '../../shared/geometry'
import { chooseDestination, createFlightCurve, fixedPositions, flightDuration, flightPhase, flightPoint, nearestPosition, type AthenaWanderPosition, type Flight } from '../../shared/flight'
import type { Settings } from '../../shared/settings'
import type { AthenaState } from '../../shared/contracts'
import type { BehaviorEvent } from '../../shared/behavior'
import { currentArea, movementArea } from './screenManager'
import type { Area } from '../../shared/geometry'
import { log } from './logger'

interface MotionHooks {
  settings(): Settings
  blocked(): string | null
  state(): AthenaState
  behavior(event: BehaviorEvent): void
  settled(point: Point): void
  flight(flight: Flight | null): void
  activity?(): void
  actionRemainingMs?(): number
  taskActive?(): boolean
  pauseForTask?(): boolean
  characterBounds?(): Area
}

export class MotionController {
  // The frame timer serves native dragging, hit testing, and interpolation.
  // Only wanderTimer schedules a journey; it never exists during a journey.
  private frameTimer?: ReturnType<typeof setInterval>
  private wanderTimer?: ReturnType<typeof setTimeout>
  private motion?: Flight
  private previousPosition: AthenaWanderPosition | null = null
  private departurePosition: AthenaWanderPosition | null = null
  private historyDisplay: number | null = null
  private drag?: { cursor: Point; origin: Point; moved: boolean; started: number }
  private ignoring = false
  private ticks = 0
  private active = false
  private parked = false
  get availableForIdle(): boolean { return this.active && !this.drag && !this.motion && !this.window.isDestroyed() && this.window.isVisible() }
  get isDragging(): boolean { return Boolean(this.drag) }
  private lastReason?: string | null

  constructor(private window: BrowserWindow, private hooks: MotionHooks) {
    window.once('closed', () => this.stop())
  }
  start(): void {
    if (this.active || this.window.isDestroyed() || !this.window.isVisible()) return
    this.active = true
    this.setFrameInterval(33)
    this.reconcile()
  }
  stop(): void {
    this.active = false
    clearInterval(this.frameTimer)
    this.frameTimer = undefined
    this.clearWanderTimer()
    this.cancelMovement()
    const wasDragging = Boolean(this.drag)
    this.drag = undefined
    if (wasDragging && this.hooks.state() === 'moving') this.hooks.behavior('REST')
    this.hooks.activity?.()
  }
  restart(): void {
    this.parked = false
    this.clearWanderTimer()
    this.cancelMovement()
    this.reconcile()
  }
  pause(): void { this.restart() }
  private setFrameInterval(milliseconds: number): void {
    clearInterval(this.frameTimer)
    this.frameTimer = this.active ? setInterval(() => this.tick(), milliseconds) : undefined
  }
  private reason(): string | null {
    if (!this.active || this.window.isDestroyed() || !this.window.isVisible() || !this.hooks.settings().floatingEnabled) return 'hidden'
    const settings = this.hooks.settings()
    if (!settings.randomMovement) return 'disabled'
    if (settings.pinned) return 'pinned'
    if (this.drag) return 'dragging'
    const blocked = this.hooks.blocked()
    if (blocked) return blocked
    const state = this.hooks.state()
    const taskActive = this.hooks.taskActive?.() ?? false
    if (taskActive && this.hooks.pauseForTask?.()) return 'task active'
    if (['listening', 'error'].includes(state) || (!taskActive && ['speaking', 'working', 'thinking'].includes(state)) || (state === 'moving' && !this.motion)) return `state: ${state}`
    return null
  }
  reconcile(): void {
    const reason = this.reason()
    if (reason !== this.lastReason) {
      this.debug(reason ? `Paused: ${reason}` : 'Enabled')
      this.lastReason = reason
    }
    if (reason) {
      this.clearWanderTimer()
      this.cancelMovement()
    } else if (!this.motion && !this.wanderTimer) this.scheduleNext()
  }
  private clearWanderTimer(): void {
    clearTimeout(this.wanderTimer)
    this.wanderTimer = undefined
  }
  private scheduleNext(): void {
    this.clearWanderTimer()
    if (this.reason() || this.motion || this.parked) return
    const settings = this.hooks.settings()
    if (settings.enabledPositions.length === 1) {
      const bounds = this.window.getBounds()
      const only = fixedPositions(currentArea(this.window), bounds, settings.edgePadding)[settings.enabledPositions[0]]
      if (Math.hypot(bounds.x - only.x, bounds.y - only.y) <= 1) { this.parked = true; return }
    }
    const seconds = this.hooks.settings().wanderIntervalSeconds
    this.debug(`Next movement in ${seconds} seconds`)
    const beginJourney = () => {
      this.wanderTimer = undefined
      if (this.reason()) { this.reconcile(); return }
      const remaining = this.hooks.actionRemainingMs?.() ?? 0
      if (remaining > 0) { this.wanderTimer = setTimeout(beginJourney, remaining + 1); return }
      const from = this.window.getBounds()
      const area = currentArea(this.window)
      if (area.id !== this.historyDisplay) { this.previousPosition = null; this.historyDisplay = area.id }
      const positions = fixedPositions(area, from, this.hooks.settings().edgePadding)
      const destination = chooseDestination(from, positions, this.previousPosition, Math.random, this.hooks.settings().enabledPositions)
      if (!destination) { this.debug('No space to move'); this.scheduleNext(); return }
      const to = positions[destination]
      this.departurePosition = nearestPosition(from, positions)
      const distance = Math.hypot(to.x - from.x, to.y - from.y)
      if (distance < 1) { this.debug('No space to move'); this.scheduleNext(); return }
      const speed = this.hooks.settings().movementSpeed
      const direction = { x: (to.x - from.x) / distance, y: (to.y - from.y) / distance }
      const curve = createFlightCurve(from, to, from, area, this.hooks.settings().edgePadding)
      this.motion = { from, to, startedAt: Date.now(), durationMs: flightDuration(distance, speed), settleDurationMs: Math.max(200, Math.min(500, 450 / speed)), direction, destination, speed, ...curve, phase: 'launch' }
      // Briefly match the model's 60fps so the compressed 10x landing is sampled.
      this.setFrameInterval(1000 / 60)
      this.debug(`Current: ${this.departurePosition}; next: ${destination}; distance: ${Math.round(distance)}px; speed: ${speed}x; duration: ${this.motion.durationMs}ms; launch`)
      this.hooks.flight({ ...this.motion })
      this.hooks.behavior('MOVE')
    }
    this.wanderTimer = setTimeout(beginJourney, seconds * 1000)
  }
  private cancelMovement(): void {
    if (!this.motion) return
    this.motion = undefined
    this.setFrameInterval(33)
    this.hooks.flight(null)
    if (!this.window.isDestroyed()) this.hooks.settled(this.window.getBounds())
    if (['floating', 'moving'].includes(this.hooks.state())) this.hooks.behavior('REST')
  }
  clamp(): void {
    this.parked = false
    if (this.window.isDestroyed()) return
    const bounds = this.window.getBounds()
    const area = movementArea(this.window, { ...this.hooks.settings(), monitorMode: this.hooks.settings().monitorMode === 'any' ? 'current' : this.hooks.settings().monitorMode })
    const point = fitPosition(bounds, bounds, area, this.hooks.settings().edgePadding)
    this.window.setPosition(point.x, point.y)
    this.hooks.settled(point)
  }
  beginDrag(): void {
    if (this.window.isDestroyed() || !this.window.isVisible()) return
    this.clearWanderTimer()
    this.cancelMovement()
    this.drag = { cursor: screen.getCursorScreenPoint(), origin: this.window.getBounds(), moved: false, started: Date.now() }
    this.parked = false
    this.setIgnoring(false)
    this.hooks.behavior('DRAG')
    this.reconcile()
    this.hooks.activity?.()
  }
  endDrag(): boolean {
    if (!this.drag || this.window.isDestroyed()) return false
    const moved = this.drag.moved
    this.drag = undefined
    this.hooks.settled(this.window.getBounds())
    this.hooks.behavior('ACKNOWLEDGE')
    this.restart()
    return moved
  }
  private setIgnoring(ignore: boolean): void {
    if (ignore === this.ignoring || this.window.isDestroyed()) return
    this.ignoring = ignore
    this.window.setIgnoreMouseEvents(ignore, { forward: true })
  }
  private tick(): void {
    if (this.window.isDestroyed()) { this.stop(); return }
    this.reconcile()
    if (!this.window.isVisible()) return
    const now = Date.now()
    const settings = this.hooks.settings()
    if (this.drag) {
      if (now - this.drag.started > 30_000) { this.endDrag(); return }
      const cursor = screen.getCursorScreenPoint()
      const dx = cursor.x - this.drag.cursor.x
      const dy = cursor.y - this.drag.cursor.y
      if (Math.hypot(dx, dy) > 4) this.drag.moved = true
      if (this.drag.moved) {
        const display = settings.crossMonitor ? screen.getDisplayNearestPoint(cursor).workArea : currentArea(this.window)
        const point = fitPosition({ x: this.drag.origin.x + dx, y: this.drag.origin.y + dy }, this.window.getBounds(), display, settings.edgePadding)
        this.window.setPosition(point.x, point.y)
      }
      return
    }
    if (++this.ticks % 3 === 0) {
      this.setIgnoring(!isCharacterHit(screen.getCursorScreenPoint(), this.hooks.characterBounds?.() ?? this.window.getBounds()))
      this.hooks.activity?.()
    }
    if (!this.motion) return
    const phase = flightPhase(this.motion, now)
    const point = flightPoint(this.motion, now, this.window.getBounds(), currentArea(this.window), settings.edgePadding)
    this.window.setPosition(point.x, point.y)
    if (phase !== this.motion.phase && phase !== 'idle') {
      this.motion.phase = phase
      this.hooks.flight({ ...this.motion })
      this.debug(phase)
    }
    if (phase === 'idle') {
      this.previousPosition = this.departurePosition
      this.debug(`Settled at ${this.motion.destination}`)
      this.motion = undefined
      this.setFrameInterval(33)
      this.hooks.flight(null)
      this.hooks.behavior('REST')
      this.hooks.settled(point)
      this.scheduleNext()
    }
  }
  private debug(message: string): void {
    if (!app.isPackaged) log('athena.wander', { message })
  }
}
