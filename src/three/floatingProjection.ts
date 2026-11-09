import type { PerspectiveCamera } from 'three'

/** Grow/crop the viewport around a fixed camera, never dolly the character.
 * Screen coordinates remain identical even for points away from Z=0. */
export function setFloatingProjection(camera: PerspectiveCamera, size: { width: number; height: number }, characterSize: number, anchor = { x: size.width / 2, y: size.height / 2 }) {
  const unit = Math.max(1, characterSize)
  camera.position.set(0, .1, 4.2)
  camera.lookAt(0, .1, 0)
  camera.setViewOffset(unit, unit, unit / 2 - anchor.x, unit / 2 - anchor.y, size.width, size.height)
  camera.updateMatrixWorld()
}
