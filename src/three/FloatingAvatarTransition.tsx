import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import type { Group } from 'three'
import type { AvatarVariant } from './showcaseMotion'

export const AVATAR_FADE_MS = 440
export function avatarTransitionPose(progress: number, entering: boolean, reduced: boolean) {
  const t = Math.max(0, Math.min(1, progress))
  const eased = t * t * (3 - 2 * t)
  return { opacity: entering ? eased : 1 - eased, yaw: reduced ? 0 : entering ? -1.35 * (1 - eased) : 1.35 * eased }
}

/** One persistent animation rig, with appearance changed only at zero opacity.
 * Fade the canvas as a composite to preserve the visor's depth and translucent
 * effects. No per-material transparency changes or second running character.
 */
export function FloatingAvatarTransition({ variant, reduced, ready = true, onDisplayedChange, children }: { variant: AvatarVariant; reduced: boolean; ready?: boolean; onDisplayedChange?: (variant: AvatarVariant) => void; children: (variant: AvatarVariant) => ReactNode }) {
  const [displayed, setDisplayed] = useState<AvatarVariant | null>(ready ? variant : null)
  const latest = useRef(variant)
  const readyRef = useRef(ready)
  const group = useRef<Group>(null)
  const phase = useRef<'idle' | 'out' | 'swap' | 'in'>('idle')
  const startedAt = useRef(0)
  const { gl, invalidate } = useThree()
  useLayoutEffect(() => { latest.current = variant; readyRef.current = ready; invalidate() }, [variant, ready, invalidate])
  useLayoutEffect(() => { if (displayed) onDisplayedChange?.(displayed) }, [displayed, onDisplayedChange])
  useLayoutEffect(() => {
    if (phase.current === 'swap') { phase.current = 'in'; startedAt.current = performance.now(); invalidate() }
  }, [displayed, invalidate])
  useLayoutEffect(() => () => { gl.domElement.style.opacity = '1' }, [gl])
  useFrame(() => {
    if (phase.current === 'idle') {
      if (latest.current === displayed || !readyRef.current) return
      if (!displayed) {
        gl.domElement.style.opacity = '0'
        phase.current = 'swap'
        setDisplayed(latest.current)
        return
      }
      phase.current = 'out'; startedAt.current = performance.now()
    }
    if (phase.current === 'swap') return
    // A demand canvas may be hidden or throttled. Drive this finite transition
    // independently; never depend on the desktop wander/render timer to swap.
    invalidate()
    const progress = (performance.now() - startedAt.current) / (reduced ? 100 : AVATAR_FADE_MS)
    const pose = avatarTransitionPose(progress, phase.current === 'in', reduced)
    gl.domElement.style.opacity = String(pose.opacity)
    if (group.current) group.current.rotation.y = pose.yaw
    if (progress < 1) return
    if (phase.current === 'out') {
      // A rapid switch back may cancel the requested replacement while fading.
      if (latest.current === displayed) { phase.current = 'in'; startedAt.current = performance.now() }
      else if (readyRef.current) { phase.current = 'swap'; setDisplayed(latest.current) }
      else { phase.current = 'in'; startedAt.current = performance.now() }
    } else { phase.current = 'idle'; gl.domElement.style.opacity = '1'; if (group.current) group.current.rotation.y = 0 }
  }, -.5)
  return <group name="avatar-switch-transition" ref={group}>{displayed && children(displayed)}</group>
}
