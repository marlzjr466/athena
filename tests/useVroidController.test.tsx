import { StrictMode } from 'react'
import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { AnimationClip, Group, VectorKeyframeTrack } from 'three'
import { useVroidController } from '../src/three/useVroidController'
import type { VroidInstance } from '../src/three/vroidAssets'

describe('VRoid mixer lifetime', () => {
  it('remains animated after StrictMode setup/cleanup/setup and releases the final mixer', () => {
    const scene = new Group()
    const idle = new AnimationClip('idle', 1, [new VectorKeyframeTrack('.position', [0, 1], [0, 1, 0, 0, 2, 0])])
    const instance = { vrm: { scene, update: () => {} }, clips: { idle } } as unknown as VroidInstance
    const hook = renderHook(() => useVroidController(instance), { wrapper: StrictMode })
    const controller = hook.result.current.current!
    expect(controller.activeName).toBe('idle')
    const initial = scene.position.y
    controller.update(.1)
    expect(scene.position.y).toBeGreaterThan(initial)
    hook.unmount()
    expect(controller.activeName).toBeNull()
    expect(controller.mixer.existingAction(idle)).toBeNull()
  })
})
