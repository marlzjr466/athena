import { describe, expect, it } from 'vitest'
import { Euler, Vector3 } from 'three'
import { chooseDestination, createFlightCurve, fixedPositions, flightDirection, flightDuration, flightPhase, flightPoint, flightPose, landingLift, WANDER_POSITIONS, type Flight } from '../shared/flight'
import { defaultSettings, restoreSettings, settingsPatchSchema } from '../shared/settings'

const area = { x: -1440, y: 25, width: 1440, height: 900 }
const size = { width: 180, height: 180 }
const positions = fixedPositions(area, size, 24)
function journey(from = positions['top-left'], to = positions['top-right'], speed = 1): Flight {
  const distance = Math.hypot(to.x - from.x, to.y - from.y)
  return { startedAt: 1000, durationMs: flightDuration(distance, speed), settleDurationMs: 450, from, to, destination: 'top-right', direction: { x: (to.x - from.x) / distance, y: (to.y - from.y) / distance }, speed, phase: 'launch', ...createFlightCurve(from, to, size, area, 24) }
}
const at = (flight: Flight, t: number) => flight.startedAt + flight.durationMs * t
const headAxis = (flight: Flight, t: number) => {
  const pose = flightPose(flight, at(flight, t))
  return new Vector3(0, 1, 0).applyEuler(new Euler(pose.pitch, pose.yaw, pose.lean, 'ZXY'))
}

describe('six intentional positions', () => {
  it('resolves all six stops on a negative-origin display', () => {
    expect(positions).toEqual({ 'top-left': { x: -1416, y: 49 }, 'top-right': { x: -204, y: 49 }, 'mid-left': { x: -1416, y: 385 }, 'mid-right': { x: -204, y: 385 }, 'bottom-left': { x: -1416, y: 721 }, 'bottom-right': { x: -204, y: 721 } })
  })
  it.each([80, 180, 400])('keeps each destination visible at %spx', (dimension) => {
    for (const point of Object.values(fixedPositions(area, { width: dimension, height: dimension }, 24))) {
      expect(point.x).toBeGreaterThanOrEqual(area.x + 24)
      expect(point.y).toBeGreaterThanOrEqual(area.y + 24)
      expect(point.x + dimension).toBeLessThanOrEqual(area.x + area.width - 24)
      expect(point.y + dimension).toBeLessThanOrEqual(area.y + area.height - 24)
    }
  })
  it('excludes the current and previous stop', () => {
    for (const current of WANDER_POSITIONS) for (const previous of WANDER_POSITIONS) for (let i = 0; i < 100; i++) {
      const next = chooseDestination(positions[current], positions, previous, () => i / 100)
      expect(next).not.toBe(current)
      expect(next).not.toBe(previous)
      expect(WANDER_POSITIONS).toContain(next)
    }
  })
  it('supports a manual drop without snapping', () => {
    const drop = { x: -650, y: 260 }
    expect(WANDER_POSITIONS).toContain(chooseDestination(drop, positions, null))
    expect(drop).toEqual({ x: -650, y: 260 })
  })
  it('handles a work area too small to wander', () => {
    const tiny = fixedPositions({ x: 0, y: 0, width: 180, height: 180 }, size, 24)
    expect(chooseDestination({ x: 0, y: 0 }, tiny, null)).toBe(null)
  })
})

describe('wide progressive sweep', () => {
  it('creates a large inward arc that tightens toward its exact endpoint', () => {
    const flight = journey()
    const points = Array.from({ length: 101 }, (_, i) => flightPoint(flight, at(flight, i / 100), size, area, 24))
    const offsets = points.map((p) => Math.abs(p.y - flight.from.y))
    expect(Math.max(...offsets)).toBeGreaterThan(200)
    expect(offsets[80]).toBeLessThan(2)
    expect(points[0]).toEqual(flight.from)
    expect(points[100]).toEqual(flight.to)
    expect(Math.hypot(points[100].x - points[90].x, points[100].y - points[90].y)).toBeLessThan(Math.hypot(points[20].x - points[10].x, points[20].y - points[10].y))
  })
  it('keeps every route visible, with forward progress before the landing rise', () => {
    for (const from of [...Object.values(positions), { x: -800, y: 420 }]) for (const to of Object.values(positions)) {
      if (from.x === to.x && from.y === to.y) continue
      const flight = journey(from, to)
      let previous = -1
      for (let i = 0; i <= 100; i++) {
        const p = flightPoint(flight, at(flight, i / 100), size, area, 24)
        expect(p.x).toBeGreaterThanOrEqual(area.x + 24)
        expect(p.y).toBeGreaterThanOrEqual(area.y)
        expect(p.x + size.width).toBeLessThanOrEqual(area.x + area.width - 24)
        expect(p.y + size.height).toBeLessThanOrEqual(area.y + area.height - 24)
        const progress = (p.x - from.x) * flight.direction.x + (p.y - from.y) * flight.direction.y
        if (i <= 88) expect(progress).toBeGreaterThanOrEqual(previous - 1)
        previous = progress
      }
      expect(flightPoint(flight, at(flight, 1), size, area, 24)).toEqual(to)
    }
  })
  it('uses the curve tangent to steer, rather than the fixed destination vector', () => {
    const flight = journey()
    expect(flightDirection(flight, at(flight, 0.1)).y).toBeGreaterThan(0.2)
    expect(flightDirection(flight, at(flight, 0.6)).y).toBeLessThan(0)
    expect(flightDirection(flight, at(flight, 1)).x).toBeCloseTo(1)
    expect(flightDirection(flight, at(flight, 1)).y).toBeCloseTo(0)
  })
})

describe('Superman pose and axial roll', () => {
  it.each([0.5, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10])('leads with the head throughout the roll and returns to idle at %sx', (speed) => {
    const flight = journey(undefined, undefined, speed)
    for (const t of [0.1, 0.2, 0.25, 0.35, 0.49, 0.5, 0.65, 0.8, 0.85]) {
      const tangent = flightDirection(flight, at(flight, t))
      const head = headAxis(flight, t)
      expect(head.dot(new Vector3(tangent.x, -tangent.y, 0))).toBeGreaterThan(0.98)
    }
    expect(Math.abs(headAxis(flight, 0.6).x)).toBeGreaterThan(0.95)
    expect(flightPose(flight, at(flight, 0.15)).wing).toBeGreaterThan(2)
    expect(flightPose(flight, at(flight, 1)).lean).toBeCloseTo(0)
    expect(flightPose(flight, at(flight, 1)).yaw).toBeCloseTo(0)
    expect(flightPose(flight, at(flight, 1) + 100).lift).toBe(0)
    expect(flightPose(flight, at(flight, 1) + 450)).toEqual(flightPose(null, 0))
    expect(flightPhase(flight, at(flight, 1) + 450)).toBe('idle')
  })
  it('completes one signed roll in the first half without a late reverse spin', () => {
    for (const turnDirection of [-1, 1] as const) {
      const flight = { ...journey(), turnDirection }
      expect(flightPose(flight, at(flight, 0.25)).yaw).toBeCloseTo(turnDirection * (Math.PI + 0.22))
      expect(flightPose(flight, at(flight, 0.499)).yaw).toBeCloseTo(turnDirection * Math.PI * 2, 2)
      expect(flightPose(flight, at(flight, 0.5)).yaw).toBeCloseTo(0)
      expect(flightPose(flight, at(flight, 0.9)).yaw).toBeCloseTo(0)
    }
  })
  it('keeps vertical and diagonal headings continuous while crossing the angle seam', () => {
    for (const from of Object.values(positions)) for (const to of Object.values(positions)) {
      if (from.x === to.x && from.y === to.y) continue
      const flight = journey(from, to)
      let previous = flightPose(flight, at(flight, 0.1)).lean
      for (let i = 11; i <= 80; i++) {
        const pose = flightPose(flight, at(flight, i / 100))
        expect(Math.abs(pose.lean - previous)).toBeLessThan(0.3)
        previous = pose.lean
      }
    }
  })
  it('preserves speed scaling, limits and persisted preferences', () => {
    expect([0.5, 1, 2, 5, 10].map((speed) => flightDuration(1000, speed))).toEqual([6000, 3000, 1500, 600, 300])
    expect(flightDuration(1, 10)).toBe(250)
    expect(defaultSettings.movementSpeed).toBe(1)
    expect(defaultSettings.wanderIntervalSeconds).toBe(30)
    expect(restoreSettings({ movementSpeed: 100 }).movementSpeed).toBe(10)
    expect(restoreSettings({ movementSpeed: -4 }).movementSpeed).toBe(0.5)
    expect(restoreSettings({ movementSpeed: Infinity }).movementSpeed).toBe(1)
    expect(settingsPatchSchema.safeParse({ movementSpeed: 11 }).success).toBe(false)
  })
})

describe('synchronized upright landing', () => {
  it.each([0.5, 1, 2, 5, 10])('stands smoothly before the peak and physically descends at %sx', (speed) => {
    for (const destination of WANDER_POSITIONS) {
      const from = positions[destination.endsWith('left') ? 'mid-right' : 'mid-left']
      const flight = journey(from, positions[destination], speed)
      const pose = (t: number) => flightPose(flight, at(flight, t))
      const point = (t: number) => flightPoint(flight, at(flight, t), size, area, 24)
      expect(pose(0.85).wing).toBeCloseTo(2.55)
      expect(pose(0.851).wing).toBeGreaterThan(2.54)
      expect(pose(0.9).wing).toBeLessThan(1)
      expect(pose(0.94).lean).toBeCloseTo(0)
      expect(pose(0.95).pitch).toBeCloseTo(0)
      expect(pose(0.95).yaw).toBeCloseTo(0)
      expect(point(0.95).y).toBe(flight.to.y - 18)
      expect(point(0.95).y).toBeLessThan(point(0.9).y)
      const descent = [0.95, 0.96, 0.97, 0.98, 0.99, 1].map((t) => point(t).y)
      expect(descent).toEqual([...descent].sort((a, b) => a - b))
      expect(descent[5] - descent[4]).toBeLessThan(descent[3] - descent[2])
      expect(point(1)).toEqual(flight.to)
      expect(point(1.1)).toEqual(flight.to)
      for (const value of Object.values(pose(1))) expect(value).toBeCloseTo(0)
    }
  })
  it('has no lift before 88%, smooth joins, and no post-arrival bounce', () => {
    expect(landingLift(0.85)).toBe(0)
    expect(landingLift(0.88)).toBe(0)
    expect(landingLift(0.95)).toBe(1)
    expect(landingLift(1)).toBe(0)
    expect(landingLift(1.1)).toBe(0)
    for (const t of [0.88, 0.95, 1]) {
      expect(Math.abs(landingLift(t + 0.00001) - landingLift(t - 0.00001)) / 0.00002).toBeLessThan(0.02)
    }
  })
  it('limits the rise when the target has little or no overhead clearance', () => {
    for (const clearance of [0, 4, 10]) {
      const flight = journey(positions['bottom-left'], { x: positions['top-right'].x, y: area.y + clearance })
      const peak = flightPoint(flight, at(flight, 0.95), size, area, 0)
      expect(peak.y).toBe(area.y)
      expect(flightPoint(flight, at(flight, 1), size, area, 0)).toEqual(flight.to)
    }
  })
})
