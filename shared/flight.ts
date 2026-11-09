import { clamp, fitPosition, type Area, type Point } from './geometry'

export const WANDER_POSITIONS = ['top-left', 'top-right', 'mid-left', 'mid-right', 'bottom-left', 'bottom-right'] as const
export type AthenaWanderPosition = typeof WANDER_POSITIONS[number]
export type AthenaMovementPhase = 'idle' | 'launch' | 'flying' | 'decelerating' | 'turning' | 'settling'
export interface Flight {
  startedAt: number
  durationMs: number
  settleDurationMs: number
  from: Point
  to: Point
  direction: Point
  destination: AthenaWanderPosition
  speed: number
  arcHeight: number
  turnDirection: -1 | 1
  controls: { first: Point; second: Point }
  phase: AthenaMovementPhase
}

export function fixedPositions(area: Area, size: Pick<Area, 'width' | 'height'>, padding: number): Record<AthenaWanderPosition, Point> {
  const left = area.x + padding
  const right = area.x + area.width - size.width - padding
  const top = area.y + padding
  const middle = area.y + (area.height - size.height) / 2
  const bottom = area.y + area.height - size.height - padding
  return Object.fromEntries(WANDER_POSITIONS.map((id) => [id, fitPosition({ x: id.endsWith('left') ? left : right, y: id.startsWith('top') ? top : id.startsWith('mid') ? middle : bottom }, size, area, padding)])) as Record<AthenaWanderPosition, Point>
}
export function nearestPosition(point: Point, positions: Record<AthenaWanderPosition, Point>): AthenaWanderPosition {
  return WANDER_POSITIONS.reduce((best, id) => Math.hypot(point.x - positions[id].x, point.y - positions[id].y) < Math.hypot(point.x - positions[best].x, point.y - positions[best].y) ? id : best)
}
export function chooseDestination(current: Point, positions: Record<AthenaWanderPosition, Point>, previous: AthenaWanderPosition | null, random = Math.random, enabled: readonly AthenaWanderPosition[] = WANDER_POSITIONS): AthenaWanderPosition | null {
  const nearest = nearestPosition(current, positions)
  // Tiny work areas may collapse several semantic positions onto the same pixel.
  const reachable = enabled.filter((id) => Math.hypot(current.x - positions[id].x, current.y - positions[id].y) > 1)
  const alternatives = reachable.filter((id) => id !== nearest && id !== previous)
  const candidates = alternatives.length ? alternatives : reachable.filter((id) => id !== nearest)
  const choices = candidates.length ? candidates : reachable
  return choices.length ? choices[Math.min(choices.length - 1, Math.floor(random() * choices.length))] : null
}
export const MIN_MOVEMENT_DURATION_MS = 250
export const MAX_MOVEMENT_DURATION_MS = 6000
export function flightDuration(distance: number, speed: number): number {
  return clamp(clamp(distance * 3, 1800, 3600) / clamp(speed, 0.5, 10), MIN_MOVEMENT_DURATION_MS, MAX_MOVEMENT_DURATION_MS)
}
export const easeOutCubic = (value: number) => 1 - (1 - clamp(value, 0, 1)) ** 3
export function easeInOutCubic(value: number) {
  const t = clamp(value, 0, 1)
  return t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2
}
export const turnProgress = (progress: number) => clamp(progress / 0.5, 0, 1)
const smoothstep = (value: number) => { const t = clamp(value, 0, 1); return t * t * (3 - 2 * t) }
export function landingLift(progress: number): number {
  // Zero velocity at takeoff, the small peak, and touchdown; same clock as flight.
  return progress < 0.95
    ? smoothstep((progress - 0.88) / 0.07)
    : 1 - smoothstep((progress - 0.95) / 0.05)
}
export function createFlightCurve(from: Point, to: Point, size: Pick<Area, 'width' | 'height'>, area: Area, padding: number) {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const distance = Math.max(1, Math.hypot(dx, dy))
  const minimum = fitPosition(area, size, area, padding)
  const maximum = fitPosition({ x: area.x + area.width, y: area.y + area.height }, size, area, padding)
  const base = { x: from.x + dx * 0.28, y: from.y + dy * 0.28 }
  const desiredRadius = Math.min(distance * 0.85, Math.max(maximum.x - minimum.x, maximum.y - minimum.y) * 0.6, 700)
  const candidate = (turnDirection: -1 | 1) => {
    const normal = { x: -dy / distance * turnDirection, y: dx / distance * turnDirection }
    let radius = desiredRadius
    for (const axis of ['x', 'y'] as const) {
      if (Math.abs(normal[axis]) > 1e-8) radius = Math.min(radius, ((normal[axis] > 0 ? maximum[axis] : minimum[axis]) - base[axis]) / normal[axis])
    }
    radius = Math.max(0, radius)
    return { turnDirection, arcHeight: radius, controls: {
      first: { x: base.x + normal.x * radius, y: base.y + normal.y * radius },
      second: { x: from.x + dx * 0.76, y: from.y + dy * 0.76 },
    } }
  }
  const positive = candidate(1)
  const negative = candidate(-1)
  return positive.arcHeight >= negative.arcHeight ? positive : negative
}
const cubicBezier = (start: number, first: number, second: number, end: number, t: number) => {
  const inverse = 1 - t
  return inverse ** 3 * start + 3 * inverse ** 2 * t * first + 3 * inverse * t ** 2 * second + t ** 3 * end
}
export function flightProgress(flight: Flight, now: number) { return clamp((now - flight.startedAt) / flight.durationMs, 0, 1) }
export function flightPhase(flight: Flight, now: number): AthenaMovementPhase {
  const elapsed = now - flight.startedAt
  if (now >= flight.startedAt + flight.durationMs + flight.settleDurationMs) return 'idle'
  if (elapsed >= flight.durationMs) return 'settling'
  const t = flightProgress(flight, now)
  // Dominant phase only; pose envelopes overlap on this same flight timeline.
  return t < 0.1 ? 'launch' : t < 0.5 ? 'turning' : t < 0.7 ? 'flying' : t < 0.9 ? 'decelerating' : 'settling'
}
export function flightPoint(flight: Flight, now: number, size: Pick<Area, 'width' | 'height'>, area: Area, padding: number): Point {
  const t = flightProgress(flight, now)
  const eased = easeOutCubic(t)
  const controls = flight.controls
  const approach = fitPosition({
    x: cubicBezier(flight.from.x, controls.first.x, controls.second.x, flight.to.x, eased),
    y: cubicBezier(flight.from.y, controls.first.y, controls.second.y, flight.to.y, eased),
  }, size, area, padding)
  // The landing may use the top padding, but never leave the usable work area.
  // With no overhead clearance, safely reduce the rise rather than clip Athena.
  const height = Math.min(clamp(size.height * 0.1, 8, 24), Math.max(0, flight.to.y - area.y))
  return fitPosition({ x: approach.x, y: approach.y - height * landingLift(t) }, size, area, 0)
}
export function flightDirection(flight: Flight, now: number): Point {
  const u = easeOutCubic(flightProgress(flight, now))
  const v = 1 - u
  const derivative = (axis: 'x' | 'y') => 3 * v * v * (flight.controls.first[axis] - flight.from[axis]) + 6 * v * u * (flight.controls.second[axis] - flight.controls.first[axis]) + 3 * u * u * (flight.to[axis] - flight.controls.second[axis])
  const x = derivative('x'), y = derivative('y')
  const length = Math.hypot(x, y)
  return length > 1e-8 ? { x: x / length, y: y / length } : flight.direction
}
export function flightPose(flight: Flight | null, now: number) {
  if (!flight || now >= flight.startedAt + flight.durationMs + flight.settleDurationMs) return { lean: 0, pitch: 0, yaw: 0, lift: 0, energy: 0, wing: 0 }
  const t = flightProgress(flight, now)
  const launch = smoothstep(t / 0.1)
  const braking = 1 - smoothstep((t - 0.65) / 0.35)
  const power = launch * braking
  const turn = turnProgress(t)
  const aerialTurn = turn < 1 - 1e-6 ? flight.turnDirection * Math.PI * 2 * smoothstep(turn) : 0
  const bank = turn < 1 ? Math.sin(turn * Math.PI) : 0
  // Hold Superman flight through 85%, then stand upright before the landing peak.
  const neutral = 1 - easeInOutCubic((t - 0.85) / 0.09)
  const flying = launch * neutral
  const direction = flightDirection(flight, now)
  // Local +Y is Athena's head-to-feet axis. Screen Y points down; model Y points up.
  const initialHeading = Math.atan2(-(flight.controls.first.x - flight.from.x), -(flight.controls.first.y - flight.from.y))
  const angle = Math.atan2(-direction.x, -direction.y)
  const heading = initialHeading + Math.atan2(Math.sin(angle - initialHeading), Math.cos(angle - initialHeading))
  return {
    lean: heading * flying,
    pitch: 0.18 * flying,
    // With ZXY rotation order, local Y rolls around the aligned flight axis.
    yaw: aerialTurn + flight.turnDirection * 0.22 * bank,
    // Rise/descent is physical window motion, not a second post-arrival model bounce.
    lift: 0,
    energy: power * (0.65 + flight.speed * 0.035),
    wing: flying * 2.55,
  }
}
