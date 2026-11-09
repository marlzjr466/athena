import { MathUtils, Quaternion, Vector3 } from 'three'
import type { TaskVisualMode } from '../../shared/contracts'

export const CONSOLE = { width: 3, height: 1.5, z: .74, curve: .27, tilt: .12 } as const
export const ARM = { upper: .35, lower: .44, restScale: .4 / .79 } as const
export type ScreenPoint = { u: number; v: number; contact: number }

const noise = (seed: number) => { const value = Math.sin(seed * 127.1 + 311.7) * 43758.5453; return value - Math.floor(value) }
const ending = (mode: TaskVisualMode) => ['completed', 'failed', 'cancelled', 'idle'].includes(mode)

/** Dwell at varied left/right/top/bottom regions, then ease to the next one.
 * Seeded per interval, not randomized each frame (so no jitter/allocations). */
export function workingGaze(mode: TaskVisualMode, time: number, intensity: number, reduced: boolean): ScreenPoint {
  if (reduced || intensity === 0 || ending(mode)) return { u: .5, v: .48, contact: 0 }
  const tick = time / 2.7, slot = Math.floor(tick)
  const target = (index: number) => {
    const direction = (((index % 4) + 4) % 4 + Math.floor(noise(Math.floor(index / 4) + 71) * 4)) % 4
    const jitter = (noise(index) - .5) * .08
    return { u: direction === 0 ? .28 + jitter : direction === 1 ? .72 + jitter : .5 + jitter, v: direction === 2 ? .83 + jitter : direction === 3 ? .23 + jitter : .52 + jitter }
  }
  const from = target(slot - 1), to = target(slot)
  const ease = MathUtils.smoothstep(tick - slot, 0, .30)
  const amount = .65 + Math.min(1, intensity) * .35
  return { u: .5 + (MathUtils.lerp(from.u, to.u, ease) - .5) * amount, v: .5 + (MathUtils.lerp(from.v, to.v, ease) - .5) * amount, contact: 0 }
}

/** Alternating press/dwell/retract cycles. Both hands and ripples use this. */
export function workingInteraction(mode: TaskVisualMode, title: string, time: number, intensity: number, reduced: boolean, screenY = .34, side = 1): ScreenPoint {
  const motion = reduced || ending(mode) ? 0 : intensity
  const fast = mode === 'terminal' || mode === 'typing'
  const cycle = time * (fast ? .9 : .48) + (side === -1 ? .5 : 0)
  const beat = Math.floor(cycle), phase = cycle - beat
  const contact = motion === 0 ? 0 : MathUtils.smoothstep(phase, .16, .34) * (1 - MathUtils.smoothstep(phase, .48, .76))
  const u = .5 + side * (.10 + (noise(beat + side * 17) - .5) * .022 * motion)
  const v = .38 - (screenY - .34) / CONSOLE.height + (noise(beat + 31) - .5) * .025 * motion
  return { u, v, contact: mode === 'thinking' || title === 'Response' ? contact * .45 : contact }
}

/** Surface coordinates in the body frame, including the upward tilt. */
export function consolePoint(point: ScreenPoint, screenY: number, target: Vector3) {
  const x = (point.u - .5) * CONSOLE.width
  const y = (point.v - .5) * CONSOLE.height
  const z = -CONSOLE.curve * (2 * point.u - 1) ** 2
  return target.set(x, screenY + y * Math.cos(CONSOLE.tilt) - z * Math.sin(CONSOLE.tilt), CONSOLE.z + y * Math.sin(CONSOLE.tilt) + z * Math.cos(CONSOLE.tilt))
}

/** Allocation-free two-joint IK for the procedural arm rig. */
export class WorkingArmSolver {
  readonly upper = new Quaternion()
  readonly lower = new Quaternion()
  private down = new Vector3(0, -1, 0)
  private direction = new Vector3()
  private bend = new Vector3()
  private upperDirection = new Vector3()
  private elbow = new Vector3()
  private lowerDirection = new Vector3()
  private inverse = new Quaternion()
  solve(shoulder: Vector3, target: Vector3, side: number) {
    const distance = MathUtils.clamp(this.direction.subVectors(target, shoulder).length(), .09, ARM.upper + ARM.lower - .002)
    this.direction.normalize()
    this.bend.set(side * .8, -.6, 0).addScaledVector(this.direction, -this.bend.dot(this.direction)).normalize()
    const cosine = MathUtils.clamp((ARM.upper ** 2 + distance ** 2 - ARM.lower ** 2) / (2 * ARM.upper * distance), -1, 1)
    this.upperDirection.copy(this.direction).multiplyScalar(cosine).addScaledVector(this.bend, Math.sqrt(1 - cosine ** 2))
    this.elbow.copy(shoulder).addScaledVector(this.upperDirection, ARM.upper)
    this.lowerDirection.copy(shoulder).addScaledVector(this.direction, distance).sub(this.elbow).normalize()
    this.upper.setFromUnitVectors(this.down, this.upperDirection)
    this.lower.setFromUnitVectors(this.down, this.lowerDirection).premultiply(this.inverse.copy(this.upper).invert())
    return this
  }
}
