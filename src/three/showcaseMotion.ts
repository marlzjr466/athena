import type { Settings } from '../../shared/settings'

export type AvatarVariant = Settings['avatarVariant']
export const AVATAR_LABELS: Record<AvatarVariant, string> = { classic: 'Athena Classic', enhanced: 'Athena Enhanced', 'vroid-athena': 'Athena' }

// Keep the full body in view as the preview column narrows.
export function showcasePreviewCameraPose(aspect: number) {
  const fov = 35, halfHeight = 2.55, halfWidth = 2.25
  const distance = Math.max(halfHeight, halfWidth / Math.max(.55, aspect)) / Math.tan(fov * Math.PI / 360) + .6
  return { x: 0, y: 1.05, z: distance, targetY: 1.05, fov }
}

export function vroidPreviewCameraPose(aspect: number, height: number, width: number) {
  const fov = 35
  // Frame measured body dimensions at 80% height, preserving full width on
  // narrow panels. This camera is independent of the desktop size preference.
  const z = Math.max(height / .8, width / (.9 * Math.max(.1, aspect))) / (2 * Math.tan(fov * Math.PI / 360))
  return { x: 0, y: height * .035, z, targetY: height * .035, fov }
}

export function showcaseRenderPolicy(quality: Settings['renderQuality'], reduced: boolean, economy: boolean) {
  return { fps: reduced ? 8 : economy ? 15 : { performance: 20, balanced: 30, quality: 45 }[quality], dpr: economy || quality === 'performance' ? 1 : quality === 'quality' ? 1.75 : 1.5, particles: reduced || economy ? 0 : quality === 'performance' ? 8 : 24 }
}
