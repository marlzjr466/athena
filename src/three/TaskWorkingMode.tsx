import { createContext, useContext, useMemo, useRef, type ReactNode } from 'react'
import { useFrame } from '@react-three/fiber'
import { Group, MathUtils, Quaternion, Vector3 } from 'three'
import type { TaskVisualMode } from '../../shared/contracts'

export const taskEnding = (mode: TaskVisualMode) => ['completed', 'failed', 'cancelled'].includes(mode)
export function workingTransitionStart(previous: { mode: TaskVisualMode; at: number }, mode: TaskVisualMode, now: number) {
  if (!Number.isFinite(previous.at)) return { mode, at: now }
  if (previous.mode === mode) return previous
  // An outcome correction changes the screen, not the fade's progress.
  return { mode, at: taskEnding(previous.mode) && taskEnding(mode) ? previous.at : now }
}
export function workingEnvelope(mode: TaskVisualMode, elapsed: number) {
  if (mode === 'idle') return 0
  if (!taskEnding(mode)) return 1
  const hold = mode === 'cancelled' ? .15 : .65
  const fade = mode === 'cancelled' ? .75 : .85
  return 1 - MathUtils.smoothstep(elapsed, hold, hold + fade)
}
export interface WorkingFrame { blend: number; opacity: number; elapsed: number }
const WorkingContext = createContext<{ current: WorkingFrame }>({ current: { blend: 0, opacity: 0, elapsed: 0 } })
export const useWorkingFrame = () => useContext(WorkingContext)

/** Rotate the presentation, not the camera/window. Runs before pose callbacks. */
export function TaskWorkingMode({ mode, yaw, listening, reduced, children }: { mode: TaskVisualMode; yaw: number; listening: boolean; reduced: boolean; children: ReactNode }) {
  const rig = useRef<Group>(null)
  const frame = useRef<WorkingFrame>({ blend: 0, opacity: 0, elapsed: 0 })
  const start = useRef({ mode, at: Number.NaN })
  const workYaw = useRef(yaw)
  const rotation = useMemo(() => ({ target: new Quaternion(), axis: new Vector3(0, 1, 0) }), [])
  useFrame(({ clock }, delta) => {
    start.current = workingTransitionStart(start.current, mode, clock.elapsedTime)
    const dt = Math.min(delta, .1)
    const elapsed = clock.elapsedTime - start.current.at
    // Idle restores the small window (and a centered layout). Finish turning
    // back from the original side, not the idle layout's default direction.
    if (mode !== 'idle' && !taskEnding(mode)) workYaw.current = yaw
    const envelope = listening ? 0 : workingEnvelope(mode, elapsed)
    frame.current.elapsed = elapsed
    frame.current.blend = MathUtils.damp(frame.current.blend, envelope, reduced ? 12 : 6, dt)
    frame.current.opacity = MathUtils.damp(frame.current.opacity, envelope, 9, dt)
    if (rig.current) {
      rotation.target.setFromAxisAngle(rotation.axis, workYaw.current * frame.current.blend)
      rig.current.quaternion.slerp(rotation.target, 1 - Math.exp(-(reduced ? 16 : 10) * dt))
    }
  }, -1)
  return <WorkingContext.Provider value={frame}><group ref={rig} name="task-working-presentation">{children}</group></WorkingContext.Provider>
}
