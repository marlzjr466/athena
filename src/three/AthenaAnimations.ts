import { MathUtils, type Group } from 'three'
import type { AthenaState, TaskVisualMode } from '../../shared/contracts'
import type { Flight } from '../../shared/flight'
import type { IdleActionSession } from '../../shared/idleActions'

export interface AnimationOptions { state: AthenaState; intensity: number; hover: boolean; reduced: boolean; flight?: Flight | null; idleAction?: IdleActionSession | null; taskMode?: import('../../shared/contracts').TaskVisualMode; taskFocus?: { x: number; y: number }; consoleHeadTracking?: boolean }
export function taskGesture(mode: TaskVisualMode, focus: { x: number; y: number }, time: number, intensity: number, reduced: boolean) {
  const strength = reduced ? 0 : intensity
  const tapping = mode === 'typing' || mode === 'terminal'
  const scanning = ['reading', 'exploring', 'searching', 'browser'].includes(mode)
  const pulse = Math.sin(time * (tapping ? 7 : 2.2)) * (tapping ? .1 : .035)
  const outcome = ['completed', 'failed', 'cancelled'].includes(mode)
  const reach = tapping ? .72 : scanning ? .55 : .32
  const bias = focus.x * .16
  return {
    // The arms begin angled outward. Turn both inward and forward to meet the
    // single screen over Athena's chest; alternate tiny taps for active edits.
    rightZ: .2 + strength * (outcome ? mode === 'completed' ? .38 : 0 : -reach + bias - pulse),
    leftZ: -.2 + strength * (outcome ? mode === 'completed' ? -.38 : 0 : reach - bias - pulse),
    rightX: outcome ? 0 : -(tapping ? 1.6 + pulse : scanning ? 1.25 : .88) * strength,
    leftX: outcome ? 0 : -(tapping ? 1.05 - pulse : scanning ? .68 : .46) * strength,
  }
}
export function animateAthena(body: Group, head: Group, time: number, delta: number, options: AnimationOptions): void {
  const intensity = options.reduced ? 0 : options.intensity
  const listening = options.state === 'listening'
  const speaking = options.state === 'speaking'
  const thinking = options.state === 'thinking'
  const taskActive = Boolean(options.taskMode && options.taskMode !== 'idle' && !listening)
  const taskOutcome = options.taskMode === 'completed'
  const voiceActive = listening || speaking || thinking || taskActive
  const flight = voiceActive ? null : options.flight
  if (options.idleAction && !flight && !voiceActive) {
    body.position.y = MathUtils.damp(body.position.y, 0, 10, delta)
    body.rotation.set(0, 0, 0)
    return
  }
  const moving = options.state === 'moving' || options.state === 'floating'
  const happy = options.state === 'happy'
  const sleeping = options.state === 'sleeping'
  const bob = taskActive ? Math.sin(time * 1.9) * 0.032 * intensity : options.hover ? Math.sin(time * (happy ? 5 : 1.6)) * (happy ? 0.12 : 0.07) * intensity * (flight ? 0.2 : 1) : 0
  body.position.y = MathUtils.damp(body.position.y, bob, 5, delta)
  body.rotation.x = MathUtils.damp(body.rotation.x, taskActive ? .11 * intensity : listening ? 0.055 * intensity : speaking ? 0.02 * intensity : 0, 5, delta)
  body.rotation.z = MathUtils.damp(body.rotation.z, flight ? 0 : taskActive ? -0.025 * intensity : moving ? -0.13 : Math.sin(time * 0.8) * 0.025 * intensity, 4, delta)
  body.rotation.y = MathUtils.damp(body.rotation.y, flight ? 0 : taskActive ? (options.taskFocus?.x ?? 0) * 0.14 * intensity : listening ? 0 : moving ? 0.18 : Math.sin(time * 0.5) * 0.12 * intensity, 3, delta)
  head.rotation.z = MathUtils.damp(head.rotation.z, flight ? 0 : taskActive ? (options.taskMode === 'failed' ? .1 : -.035) * intensity : listening ? (-0.09 + Math.sin(time * 0.55) * 0.012) * intensity : happy ? -0.12 : thinking ? -0.09 * intensity : Math.sin(time * (speaking ? 1.15 : 0.7)) * (speaking ? 0.035 : 0.025) * intensity, listening ? 7 : 4, delta)
  if (options.consoleHeadTracking && !listening) return
  head.rotation.x = MathUtils.damp(head.rotation.x, flight ? 0 : taskActive ? (-(options.taskFocus?.y ?? -1) * .7 + Math.sin(time * (taskOutcome ? 5 : 1.3)) * (taskOutcome ? .08 : .012)) * intensity : listening ? (-0.065 + Math.sin(time * 0.9) * 0.013) * intensity : sleeping ? 0.18 : Math.sin(time * (speaking ? 2.3 : 1.1)) * (speaking ? 0.055 : 0.025) * intensity, listening ? 7 : 4, delta)
  head.rotation.y = MathUtils.damp(head.rotation.y, taskActive ? ((options.taskFocus?.x ?? 0) * .38 + Math.sin(time * .65) * .025) * intensity : head.rotation.y, 5, delta)
  if (taskOutcome) body.rotation.z += Math.sin(time * 5) * 0.018 * intensity
}
