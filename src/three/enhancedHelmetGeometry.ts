import { BufferGeometry, Float32BufferAttribute } from 'three'

/** Ellipsoidal shell: a continuous round dome, not a bevelled box. */
export const HELMET = { width: .68, height: .565, depth: .49 } as const
export const ENHANCED_EYE_SPACING = .225
export const ENHANCED_EYE_HEIGHT = -.045

export function helmetSurfaceZ(x: number, y: number) {
  return HELMET.depth * Math.sqrt(Math.max(0, 1 - (x / HELMET.width) ** 2 - (y / HELMET.height) ** 2))
}

/** A curved lens patch following the same shell, including its cheek curvature.
 * A radial fan avoids the flat cap and corner planes of an extruded rectangle.
 * Each layer sits just above the shell; no coplanar overlapping triangles.
 */
export function createVisorGeometry(width: number, height: number, lift: number) {
  const segments = 64, rings = 14, offsetY = -.055
  const positions: number[] = [0, offsetY, helmetSurfaceZ(0, offsetY) + lift]
  const indices: number[] = []
  const rounded = (value: number) => Math.sign(value) * Math.abs(value) ** (2 / 2.65)
  for (let ring = 1; ring <= rings; ring++) {
    const radius = ring / rings
    for (let segment = 0; segment < segments; segment++) {
      const angle = segment / segments * Math.PI * 2
      const x = width * radius * rounded(Math.cos(angle))
      const y = height * radius * rounded(Math.sin(angle)) + offsetY
      positions.push(x, y, helmetSurfaceZ(x, y) + lift)
    }
  }
  for (let segment = 0; segment < segments; segment++) {
    indices.push(0, segment + 1, (segment + 1) % segments + 1)
  }
  for (let ring = 1; ring < rings; ring++) {
    for (let segment = 0; segment < segments; segment++) {
      const next = (segment + 1) % segments
      const a = 1 + (ring - 1) * segments + segment, b = 1 + (ring - 1) * segments + next
      const c = 1 + ring * segments + segment, d = 1 + ring * segments + next
      indices.push(a, c, d, a, d, b)
    }
  }
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  geometry.computeBoundingBox()
  geometry.computeBoundingSphere()
  return geometry
}
