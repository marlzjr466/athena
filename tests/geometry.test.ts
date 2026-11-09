import { describe, expect, it } from 'vitest'
import { easeInOutSine, fitPosition, isCharacterHit, panelPosition, randomTarget } from '../shared/geometry'

describe('desktop boundaries', () => {
  const display = { x: -1920, y: 25, width: 1920, height: 1015 }
  const size = { width: 180, height: 180 }
  it('clamps to usable bounds, including negative monitor origins', () => {
    expect(fitPosition({ x: -4000, y: -900 }, size, display)).toEqual({ x: -1904, y: 41 })
    expect(fitPosition({ x: 100, y: 5000 }, size, display)).toEqual({ x: -196, y: 844 })
  })
  it('recovers a saved position from a disconnected monitor', () => {
    expect(fitPosition({ x: -1800, y: 400 }, size, { x: 0, y: 25, width: 1440, height: 850 })).toEqual({ x: 16, y: 400 })
  })
  it('handles an unusually small work area without negative available space', () => {
    expect(fitPosition({ x: 300, y: 300 }, { width: 180, height: 180 }, { x: 0, y: 0, width: 190, height: 190 })).toEqual({ x: 5, y: 5 })
  })
  it('generates hundreds of targets wholly inside the work area', () => {
    for (let i = 0; i < 500; i++) {
      const target = randomTarget(display, size)
      expect(target.x).toBeGreaterThanOrEqual(-1904)
      expect(target.x + size.width).toBeLessThanOrEqual(-16)
      expect(target.y).toBeGreaterThanOrEqual(41)
      expect(target.y + size.height).toBeLessThanOrEqual(1024)
    }
  })
  it('places the panel left at the right edge and keeps it above the bottom edge', () => {
    const area = { x: 0, y: 25, width: 1440, height: 850 }
    const point = panelPosition({ x: 1240, y: 670, ...size }, { width: 330, height: 390 }, area)
    expect(point.x).toBe(898)
    expect(point.y + 390).toBeLessThanOrEqual(863)
  })
  it('places the panel right at the left edge', () => {
    expect(panelPosition({ x: 16, y: 45, ...size }, { width: 330, height: 390 }, { x: 0, y: 25, width: 1440, height: 850 }).x).toBe(208)
  })
  it('eases monotonically from the exact start to exact destination', () => {
    expect(easeInOutSine(0)).toBeCloseTo(0)
    expect(easeInOutSine(0.5)).toBeCloseTo(0.5)
    expect(easeInOutSine(1)).toBe(1)
    expect(easeInOutSine(2)).toBe(1)
    expect(easeInOutSine(0.1)).toBeLessThan(0.1)
  })
  it('lets clicks through transparent corners but keeps the character interactive', () => {
    const bounds = { x: 100, y: 100, ...size }
    expect(isCharacterHit({ x: 190, y: 180 }, bounds)).toBe(true)
    expect(isCharacterHit({ x: 101, y: 101 }, bounds)).toBe(false)
    expect(isCharacterHit({ x: 279, y: 279 }, bounds)).toBe(false)
  })
})
