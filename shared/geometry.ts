export interface Point { x: number; y: number }
export interface Area extends Point { width: number; height: number }
export interface DisplayArea extends Area { id: number; label: string; primary: boolean }

export const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(n, Math.max(min, max)))
export function fitPosition(point: Point, size: { width: number; height: number }, area: Area, padding = 16): Point {
  const px = Math.min(padding, Math.max(0, (area.width - size.width) / 2))
  const py = Math.min(padding, Math.max(0, (area.height - size.height) / 2))
  return {
    x: Math.round(clamp(point.x, area.x + px, area.x + area.width - size.width - px)),
    y: Math.round(clamp(point.y, area.y + py, area.y + area.height - size.height - py)),
  }
}
export function randomTarget(area: Area, size: { width: number; height: number }, padding = 16, random = Math.random): Point {
  const edge = random() < 0.25
  return fitPosition({
    x: area.x + (edge ? (random() < 0.5 ? 0.08 : 0.92) : random()) * (area.width - size.width),
    y: area.y + (edge ? 0.85 : random()) * (area.height - size.height),
  }, size, area, padding)
}
export const MIN_WANDER_DISTANCE = 150
export function wanderTarget(current: Area, area: Area, padding = 16, random = Math.random): Point {
  const distance = (point: Point) => Math.hypot(point.x - current.x, point.y - current.y)
  let best: Point = current
  for (let attempt = 0; attempt < 10; attempt++) {
    const candidate = randomTarget(area, current, padding, random)
    if (distance(candidate) > distance(best)) best = candidate
    if (distance(best) >= MIN_WANDER_DISTANCE) return best
  }
  // Bounded fallback also finds the largest possible displacement on small displays.
  for (const x of [area.x, area.x + area.width]) for (const y of [area.y, area.y + area.height]) {
    const candidate = fitPosition({ x, y }, current, area, padding)
    if (distance(candidate) > distance(best)) best = candidate
  }
  return fitPosition(best, current, area, padding)
}
export function easeInOutSine(progress: number): number { return -(Math.cos(Math.PI * clamp(progress, 0, 1)) - 1) / 2 }
export function panelPosition(character: Area, panel: { width: number; height: number }, area: Area): Point {
  const right = character.x + character.width + 12
  return fitPosition({
    x: right + panel.width <= area.x + area.width - 12 ? right : character.x - panel.width - 12,
    y: character.y + character.height / 2 - panel.height / 2,
  }, panel, area, 12)
}
export function isCharacterHit(point: Point, bounds: Area): boolean {
  const x = (point.x - bounds.x - bounds.width / 2) / (bounds.width * 0.32)
  const y = (point.y - bounds.y - bounds.height * 0.49) / (bounds.height * 0.43)
  return x * x + y * y <= 1
}
