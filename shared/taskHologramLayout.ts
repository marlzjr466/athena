/** Composition only: never moves the native window or the avatar's anchor. */
export function taskHologramLayout(anchor: { x: number; y: number }, viewport: { width: number; height: number }, characterSize: number) {
  const horizontalRoom = viewport.width - anchor.x - anchor.x
  const side = horizontalRoom < -characterSize * .15 ? -1 : 1
  const verticalBias = Math.max(-1, Math.min(1, (anchor.y - viewport.height / 2) / Math.max(1, (viewport.height - characterSize) / 2)))
  return { yaw: side * 2.4, screenY: .43 + verticalBias * .15 }
}
