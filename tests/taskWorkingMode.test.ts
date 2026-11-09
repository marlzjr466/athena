import { describe, expect, it } from 'vitest'
import { Group, PerspectiveCamera, Vector3 } from 'three'
import { ARM, CONSOLE, consolePoint, workingGaze, workingInteraction, WorkingArmSolver } from '../src/three/taskWorkingPose'
import { workingEnvelope, workingTransitionStart } from '../src/three/TaskWorkingMode'
import { curvedScreenGeometry } from '../src/three/TaskWorkScreen'
import { taskHologramLayout } from '../shared/taskHologramLayout'
import { animateAthena } from '../src/three/AthenaAnimations'
import { setFloatingProjection } from '../src/three/floatingProjection'
import { isCodingScreen } from '../src/three/taskScreenContent'

describe('cinematic working pose', () => {
  it('keeps an in-progress ending faded when the outcome is corrected', () => {
    const started = workingTransitionStart({ mode: 'terminal', at: 0 }, 'completed', 10)
    const corrected = workingTransitionStart(started, 'failed', 11.7)
    expect(workingEnvelope(corrected.mode, 11.7 - corrected.at)).toBe(0)
    const next = workingTransitionStart(corrected, 'terminal', 12)
    expect(next.at).toBe(12)
    expect(workingEnvelope(next.mode, 0)).toBe(1)
  })
  it('keeps finger targets on the curved console and solves shoulders and elbows', () => {
    const solver = new WorkingArmSolver()
    const target = new Vector3()
    for (const mode of ['terminal', 'typing', 'reading', 'searching', 'browser', 'thinking'] as const) {
      for (const height of [.28, .43, .58]) for (const time of [0, 1, 2, 3]) for (const side of [-1, 1]) {
        const point = workingInteraction(mode, '', time, 1, false, height, side)
        consolePoint(point, height, target)
        const shoulder = new Vector3(side * .29, .02, 0)
        expect(target.distanceTo(shoulder)).toBeLessThan(ARM.upper + ARM.lower)
        solver.solve(shoulder, target, side)
        const elbow = new Vector3(0, -ARM.upper, 0).applyQuaternion(solver.upper).add(shoulder)
        const tip = new Vector3(0, -ARM.lower, 0).applyQuaternion(solver.lower).applyQuaternion(solver.upper).add(elbow)
        expect(tip.distanceTo(target)).toBeLessThan(.003)
      }
    }
  })
  it('scans left, right, top and bottom with smooth dwell transitions and stable reduced motion', () => {
    const gaze = Array.from({ length: 40 }, (_, i) => workingGaze('typing', i * 2.7 + 1, .65, false))
    expect(Math.min(...gaze.map(p => p.u))).toBeLessThan(.35)
    expect(Math.max(...gaze.map(p => p.u))).toBeGreaterThan(.65)
    expect(Math.min(...gaze.map(p => p.v))).toBeLessThan(.3)
    expect(Math.max(...gaze.map(p => p.v))).toBeGreaterThan(.75)
    const before = workingGaze('typing', 2.7 - .001, 1, false)
    const after = workingGaze('typing', 2.7 + .001, 1, false)
    expect(Math.hypot(after.u - before.u, after.v - before.v)).toBeLessThan(.001)
    expect(workingGaze('typing', 0, 1, true)).toEqual(workingGaze('typing', 60, 1, true))
  })
  it('alternates deliberate taps with a visible lift-off and enables illustrative code modes', () => {
    const a = workingInteraction('typing', 'Edit', .4 / .9, 1, false)
    const b = workingInteraction('typing', 'Edit', .4 / .9, 1, false, .34, -1)
    expect(a.contact).toBe(1)
    expect(b.contact).toBe(0)
    for (const title of ['Terminal', 'Read', 'Edit', 'Create', 'Build']) expect(isCodingScreen(title)).toBe(true)
    for (const title of ['Complete', 'Needs attention', 'Cancelled']) expect(isCodingScreen(title)).toBe(false)
  })
  it('preserves desktop position and depth scale during viewport expansion, edge-clamping, and restoration', () => {
    const camera = new PerspectiveCamera(34, 1, .1, 100)
    const desktopAnchor = { x: 600, y: 500 }
    const points = [new Vector3(0, .1, 0), new Vector3(.4, .6, .4), new Vector3(-.3, -.5, -.3)]
    const project = (width: number, height: number, anchor: { x: number; y: number }) => {
      setFloatingProjection(camera, { width, height }, 180, anchor)
      return points.map(p => {
        const projected = p.clone().project(camera)
        return { x: desktopAnchor.x - anchor.x + (projected.x + 1) * width / 2, y: desktopAnchor.y - anchor.y + (1 - projected.y) * height / 2 }
      })
    }
    const baseline = project(180, 180, { x: 90, y: 90 })
    for (const anchor of [{ x: 144, y: 153 }, { x: 90, y: 90 }, { x: 198, y: 216 }]) {
      project(288, 306, anchor).forEach((point, i) => {
        expect(point.x).toBeCloseTo(baseline[i].x, 9)
        expect(point.y).toBeCloseTo(baseline[i].y, 9)
      })
    }
    expect(project(180, 180, { x: 90, y: 90 })).toEqual(baseline)
  })
  it('reduces gesture motion without lowering the static working pose', () => {
    expect(workingInteraction('terminal', 'Terminal', 1, 1, true)).toEqual(workingInteraction('terminal', 'Terminal', 30, 1, true))
    expect(workingInteraction('terminal', 'Terminal', 1, 0, false)).toEqual(workingInteraction('terminal', 'Terminal', 30, 0, false))
    expect(workingEnvelope('terminal', 500)).toBe(1)
  })
  it('holds success/failure briefly, cancels neutrally and returns before the lifecycle timer', () => {
    for (const mode of ['completed', 'failed', 'cancelled'] as const) {
      expect(workingEnvelope(mode, 0)).toBe(1)
      expect(workingEnvelope(mode, 1.8)).toBe(0)
    }
    expect(workingEnvelope('completed', .6)).toBe(1)
    expect(workingEnvelope('cancelled', .6)).toBeLessThan(.5)
    expect(workingEnvelope('idle', 0)).toBe(0)
  })
  it('preserves listening head pose over task animation', () => {
    const a = new Group(), b = new Group(), headA = new Group(), headB = new Group()
    const options = { state: 'listening' as const, intensity: .65, hover: true, reduced: false }
    animateAthena(a, headA, 1, .1, options)
    animateAthena(b, headB, 1, .1, { ...options, taskMode: 'terminal' })
    expect(headB.quaternion.toArray()).toEqual(headA.quaternion.toArray())
  })
  it.each([120, 180, 280])('fits the single %ipx console in native task canvases at every edge', (size) => {
    const width = Math.max(200, Math.round(size * 1.6)), height = Math.max(200, Math.round(size * 1.7))
    const camera = new PerspectiveCamera(34, width / height, .1, 100)
    const geometry = curvedScreenGeometry(), points = geometry.attributes.position
    for (const x of [size / 2, width / 2, width - size / 2]) for (const y of [size / 2, height / 2, height - size / 2]) {
      setFloatingProjection(camera, { width, height }, size, { x, y })
      const layout = taskHologramLayout({ x, y }, { width, height }, size)
      const rig = new Group(), screen = new Group()
      rig.rotation.y = layout.yaw
      screen.position.set(0, layout.screenY, CONSOLE.z); screen.rotation.x = CONSOLE.tilt; rig.add(screen); rig.updateMatrixWorld(true)
      for (let i = 0; i < points.count; i++) {
        const p = new Vector3().fromBufferAttribute(points, i).applyMatrix4(screen.matrixWorld).project(camera)
        expect(Math.abs(p.x)).toBeLessThan(1)
        expect(Math.abs(p.y)).toBeLessThan(1)
      }
    }
    geometry.dispose()
  })
})
