import { clamp } from '../../shared/geometry'
import type { IdleActionId, IdleActionSession } from '../../shared/idleActions'

const neutral = { x: 0, y: 0, z: 0, lift: 0, scale: 1, arm: 0.2, otherArm: -0.2, legs: 0.13, headYaw: 0, headPitch: 0 }
type ActionPose = typeof neutral
const ease = (t: number) => t * t * (3 - 2 * t)
// Each action owns only local model transforms and returns smoothly to neutral.
const animations: Record<IdleActionId, (t: number, envelope: number) => Partial<ActionPose>> = {
  sitting: (_t, e) => ({ lift: -0.12 * e, legs: -1.35 * e + 0.13, arm: 0.2 + e * 0.25, otherArm: -0.2 - e * 0.25, x: 0.12 * e }),
  'slight-jump': (t, e) => ({ lift: Math.sin(Math.PI * t) * 0.18, scale: 1 - Math.sin(Math.PI * t * 2) * e * 0.04, arm: 0.2 + 0.25 * e, otherArm: -0.2 - 0.25 * e }),
  wave: (t, e) => ({ arm: 0.2 + e * (1.85 + Math.sin(t * Math.PI * 10) * 0.3), z: -0.07 * e, headYaw: -0.12 * e }),
  'turn-around': (t) => ({ y: Math.PI * Math.sin(Math.PI * t) ** 2 }),
  'front-flip': (t, e) => ({ x: -Math.PI * 2 * ease(t), scale: 1 - e * 0.25, lift: Math.sin(Math.PI * t) * 0.09, arm: 0.2 + 0.65 * e, otherArm: -0.2 - 0.65 * e }),
  'back-flip': (t, e) => ({ x: Math.PI * 2 * ease(t), scale: 1 - e * 0.25, lift: Math.sin(Math.PI * t) * 0.09, arm: 0.2 + 0.65 * e, otherArm: -0.2 - 0.65 * e }),
  'small-spin': (t, e) => ({ y: Math.PI * 2 * ease(t), arm: 0.2 + 0.6 * e, otherArm: -0.2 - 0.6 * e, scale: 1 - 0.08 * e }),
  'look-around': (t, e) => ({ headYaw: Math.sin(t * Math.PI * 2) * 0.6 * e, headPitch: -Math.sin(t * Math.PI) * 0.12 }),
  stretch: (_t, e) => ({ arm: 0.2 + 2.4 * e, otherArm: -0.2 - 2.4 * e, lift: 0.045 * e, headPitch: -0.08 * e }),
  'hover-bounce': (t) => ({ lift: Math.sin(t * Math.PI * 2) ** 2 * 0.12 }),
  bow: (_t, e) => ({ x: 0.62 * e, headPitch: 0.15 * e, lift: -0.04 * e }),
  'happy-pose': (t, e) => ({ arm: 0.2 + 1.8 * e, otherArm: -0.2 - 1.8 * e, lift: Math.sin(t * Math.PI * 3) ** 2 * e * 0.09, z: Math.sin(t * Math.PI * 4) * 0.09 * e }),
}
export function idleActionPose(action: IdleActionSession | null | undefined, now: number): ActionPose {
  if (!action || now <= action.startedAt || now >= action.startedAt + action.durationMs) return { ...neutral }
  const t = clamp((now - action.startedAt) / action.durationMs, 0, 1)
  const envelope = ease(clamp(t / 0.2, 0, 1)) * (1 - ease(clamp((t - 0.8) / 0.2, 0, 1)))
  return { ...neutral, ...animations[action.id](t, envelope) }
}
