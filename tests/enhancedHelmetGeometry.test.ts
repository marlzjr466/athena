import { describe, expect, it } from 'vitest'
import { createVisorGeometry, HELMET, helmetSurfaceZ } from '../src/three/enhancedHelmetGeometry'

describe('rounded reference helmet', () => {
  it('uses a continuously curved ellipsoid rather than a flat box front', () => {
    expect(helmetSurfaceZ(0, 0)).toBe(HELMET.depth)
    expect(helmetSurfaceZ(HELMET.width, 0)).toBe(0)
    expect(helmetSurfaceZ(0, HELMET.height)).toBe(0)
    expect(helmetSurfaceZ(.3, 0)).toBeLessThan(helmetSurfaceZ(.2, 0))
    expect(helmetSurfaceZ(.5, .1)).toBeLessThan(helmetSurfaceZ(.3, .1))
    expect(helmetSurfaceZ(-.3, .2)).toBe(helmetSurfaceZ(.3, -.2))
  })
  it('builds a smooth visor conforming to the curved cheeks without flat cap planes', () => {
    const visor = createVisorGeometry(.537, .302, .014)
    try {
      const vertices = visor.getAttribute('position'), normals = visor.getAttribute('normal')
      expect(vertices.count).toBeLessThan(1000)
      for (let i = 0; i < vertices.count; i++) {
        const x = vertices.getX(i), y = vertices.getY(i), z = vertices.getZ(i)
        expect(z).toBeCloseTo(helmetSurfaceZ(x, y) + .014, 5)
        expect(Number.isFinite(normals.getX(i) + normals.getY(i) + normals.getZ(i))).toBe(true)
        expect(normals.getZ(i)).toBeGreaterThan(0)
      }
      expect(visor.boundingBox!.max.z - visor.boundingBox!.min.z).toBeGreaterThan(.15)
    } finally { visor.dispose() }
  })
  it('keeps all layered visor surfaces outside the shell with symmetric boundaries', () => {
    for (const [width, height, lift] of [[.577, .341, .004], [.557, .322, .009], [.537, .302, .014]]) {
      const geometry = createVisorGeometry(width, height, lift)
      try {
        expect(geometry.boundingBox!.max.x).toBeCloseTo(-geometry.boundingBox!.min.x, 5)
        expect(geometry.boundingBox!.max.y + geometry.boundingBox!.min.y).toBeCloseTo(-.11, 5)
        const position = geometry.getAttribute('position')
        for (let i = 0; i < position.count; i++) expect(position.getZ(i)).toBeGreaterThan(helmetSurfaceZ(position.getX(i), position.getY(i)))
      } finally { geometry.dispose() }
    }
  })
})
