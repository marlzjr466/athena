import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { VRM } from '@pixiv/three-vrm'
import { createVRMAnimationClip } from '@pixiv/three-vrm-animation'
import { AnimationMixer, SkinnedMesh, Texture, Vector3 } from 'three'
import { createCanvas, loadImage } from '@napi-rs/canvas'
import { createVroidLoader, createVroidVoiceClips, disposeVroid, VROID_ANIMATIONS, VROID_AVATAR, VROID_VOICE_ANIMATIONS } from '../src/three/vroidAssets'
import type { VroidInstance } from '../src/three/vroidAssets'
import { VroidAnimationController } from '../src/three/vroidAnimation'
import { VROID_ACTIONS, type VroidActionId } from '../shared/vroidActions'

const root = resolve(process.cwd(), 'src/assets/avatars/vroid-athena')
const fileBuffer = (path: string): ArrayBuffer => {
  const bytes = readFileSync(path)
  return Uint8Array.from(bytes).buffer
}
afterEach(() => vi.unstubAllGlobals())
function gltfJson(path: string) {
  const bytes = readFileSync(path)
  expect(bytes.subarray(0, 4).toString()).toBe('glTF')
  const length = bytes.readUInt32LE(12)
  return JSON.parse(bytes.subarray(20, 20 + length).toString()) as Record<string, any>
}

describe('supplied VRoid assets', () => {
  it('contains the real VRM avatar, spring bones, expressions, and humanoid bones', () => {
    const model = gltfJson(resolve(root, 'model.vrm'))
    expect(model.extensionsUsed).toContain('VRMC_vrm')
    expect(model.extensionsUsed).toContain('VRMC_springBone')
    expect(Object.keys(model.extensions.VRMC_vrm.humanoid.humanBones).length).toBeGreaterThan(40)
    expect(model.extensions.VRMC_vrm.expressions.preset.blink).toBeDefined()
    expect(model.extensions.VRMC_vrm.expressions.preset.aa).toBeDefined()
  })
  it('discovers every supplied VRMA file with humanoid animation channels', () => {
    const modelBones = new Set(Object.keys(gltfJson(resolve(root, 'model.vrm')).extensions.VRMC_vrm.humanoid.humanBones))
    const names = readdirSync(resolve(root, 'animations')).filter(name => name.endsWith('.vrma')).sort()
    const required = ['idle.vrma', 'bow.vrma', 'angry.vrma', 'blush.vrma', 'clapping.vrma', 'goodbye.vrma', 'jump.vrma', 'look-around.vrma', 'relax.vrma', 'sad.vrma', 'sleepy.vrma', 'surprised.vrma', 'thinking.vrma']
    expect(names).toEqual(expect.arrayContaining(required))
    expect(VROID_AVATAR.id).toBe('vroid-athena')
    expect(Object.keys(VROID_ANIMATIONS)).toHaveLength(20)
    expect(names).toHaveLength(22)
    for (const action of VROID_ACTIONS) expect(VROID_ANIMATIONS[action.id], action.file).toBeTruthy()
    expect(VROID_VOICE_ANIMATIONS.gestures).toBeTruthy()
    expect(VROID_VOICE_ANIMATIONS.expressions).toBeTruthy()
    for (const name of names) {
      const animation = gltfJson(resolve(root, 'animations', name))
      expect(animation.extensionsUsed).toContain('VRMC_vrm_animation')
      expect(animation.animations[0].channels.length).toBeGreaterThan(0)
      const bones = animation.extensions.VRMC_vrm_animation.humanoid.humanBones as Record<string, { node: number }>
      // Some supplied clips intentionally omit fingers; only mapped bones are
      // required, not an identical channel count across independent assets.
      expect(Object.keys(bones).length).toBeGreaterThan(0)
      for (const [name, bone] of Object.entries(bones)) {
        expect(modelBones.has(name)).toBe(true)
        expect(bone.node).toBeLessThan(animation.nodes.length)
      }
    }
  })
  it('decodes the real embedded textures and binds Relax VRMA to the real humanoid', async () => {
    const close = vi.fn()
    const decode = vi.fn(async () => ({ width: 1, height: 1, close }) as unknown as ImageBitmap)
    vi.stubGlobal('createImageBitmap', decode)
    const loader = createVroidLoader()
    const model = await loader.parseAsync(fileBuffer(resolve(root, 'model.vrm')), '')
    const vrm = model.userData.vrm as VRM
    expect(vrm).toBeDefined()
    expect(decode).toHaveBeenCalled()
    expect(vrm.materials?.some(material => (material as unknown as { map?: Texture }).map instanceof Texture)).toBe(true)

    const animation = await loader.parseAsync(fileBuffer(resolve(root, 'animations/relax.vrma')), '')
    const clip = createVRMAnimationClip(animation.userData.vrmAnimations[0], vrm)
    expect(clip.tracks.length).toBeGreaterThan(40)
    const arm = vrm.humanoid.getNormalizedBoneNode('leftUpperArm')!
    const rawArm = vrm.humanoid.getRawBoneNode('leftUpperArm')!
    const skinnedMeshes: SkinnedMesh[] = []
    vrm.scene.traverse(object => { if (object instanceof SkinnedMesh) skinnedMeshes.push(object) })
    expect(skinnedMeshes.some(mesh => mesh.skeleton.bones.some(bone => bone === rawArm))).toBe(true)
    const start = arm.quaternion.clone()
    const rawStart = rawArm.quaternion.clone()
    const mixer = new AnimationMixer(vrm.scene)
    mixer.clipAction(clip).play()
    const lowerArm = vrm.humanoid.getRawBoneNode('leftLowerArm')!
    const directions: number[] = []
    for (let i = 0; i < 20; i++) {
      mixer.update(.15)
      vrm.update(.15)
      vrm.scene.updateMatrixWorld(true)
      const direction = lowerArm.getWorldPosition(new Vector3()).sub(rawArm.getWorldPosition(new Vector3())).normalize()
      directions.push(Number(direction.y.toFixed(2)))
    }
    expect(Math.max(...directions) - Math.min(...directions)).toBeGreaterThan(1)
    mixer.stopAllAction()
    vrm.humanoid.resetNormalizedPose()
    vrm.update(0)
    mixer.clipAction(clip).reset().play()
    mixer.update(.55)
    vrm.update(.55)
    const first = arm.quaternion.clone()
    const rawFirst = rawArm.quaternion.clone()
    mixer.update(.55)
    vrm.update(.55)
    expect(first.angleTo(start)).toBeGreaterThan(.01)
    expect(arm.quaternion.angleTo(first)).toBeGreaterThan(.01)
    expect(rawFirst.angleTo(rawStart)).toBeGreaterThan(.01)
    expect(rawArm.quaternion.angleTo(rawFirst)).toBeGreaterThan(.01)
    const clips: VroidInstance['clips'] = {}
    let gestureAnimation
    let expressionAnimation
    for (const name of readdirSync(resolve(root, 'animations')).filter(name => name.endsWith('.vrma'))) {
      const loaded = await loader.parseAsync(fileBuffer(resolve(root, 'animations', name)), '')
      const animation = loaded.userData.vrmAnimations?.[0]
      expect(animation, `${name}.vrma should load`).toBeDefined()
      if (name === 'Talking_Gestures_Only.vrma') { gestureAnimation = animation; continue }
      if (name === 'Talking.vrma') { expressionAnimation = animation; continue }
      const clip = createVRMAnimationClip(animation, vrm)
      expect(clip.tracks.length, `${name} should bind to the VRM`).toBeGreaterThan(0)
      const id = VROID_ACTIONS.find(action => action.file.normalize('NFC') === name.normalize('NFC'))!.id
      expect(clip.duration).toBeGreaterThan(0)
      expect(clip.validate()).toBe(true)
      clips[id] = clip
    }
    const voiceClips = createVroidVoiceClips(gestureAnimation, expressionAnimation, vrm)
    expect(voiceClips.gestures?.tracks.length).toBeGreaterThan(0)
    expect(voiceClips.gestures?.tracks.every(track => track.name.endsWith('.quaternion') || track.name.endsWith('.position'))).toBe(true)
    expect(voiceClips.expressions?.tracks.length).toBeGreaterThan(0)
    expect(voiceClips.expressionNames).toEqual(expect.arrayContaining(['happy', 'blink']))
    expect(voiceClips.expressions?.tracks.some(track => track.name.endsWith('.quaternion') || track.name.endsWith('.position'))).toBe(false)
    expect(voiceClips.expressionNames.some(name => ['aa', 'ee', 'ih', 'oh', 'ou'].includes(name))).toBe(false)
    const gestureTargets = new Set(voiceClips.gestures!.tracks.map(track => track.name))
    expect(voiceClips.expressions?.tracks.some(track => gestureTargets.has(track.name))).toBe(false)
    const expressionMixer = new AnimationMixer(vrm.scene)
    const expressionAction = expressionMixer.clipAction(voiceClips.expressions!).play()
    vrm.expressionManager!.setValue('aa', .4)
    let maxHappy = 0
    for (let i = 0; i <= 20; i++) {
      expressionAction.time = voiceClips.expressions!.duration * i / 20
      expressionMixer.update(0)
      maxHappy = Math.max(maxHappy, vrm.expressionManager!.getValue('happy') ?? 0)
    }
    expect(maxHappy).toBeGreaterThan(0)
    expect(vrm.expressionManager!.getValue('aa')).toBeCloseTo(.4)
    expressionMixer.stopAllAction()
    expressionMixer.uncacheRoot(vrm.scene)
    vrm.expressionManager!.setValue('aa', 0)
    mixer.stopAllAction()
    mixer.uncacheRoot(vrm.scene)
    const controller = new VroidAnimationController({ vrm, clips, voiceClips, animationExpressionNames: {} } as VroidInstance)
    const bones = ['hips', 'spine', 'head', 'leftUpperArm', 'rightUpperArm', 'leftUpperLeg', 'rightUpperLeg'] as const
    for (const [name, clip] of Object.entries(clips)) {
      expect(controller.play(name as VroidActionId, 0, false)).toBe(true)
      controller.update(.01)
      vrm.update(.01)
      const initial = bones.map(bone => vrm.humanoid.getRawBoneNode(bone)!.quaternion.clone())
      let moved = false
      for (let i = 0; i < Math.ceil(clip!.duration * 10) + 5; i++) {
        controller.update(.1)
        vrm.update(.1)
        bones.forEach((bone, index) => {
          const q = vrm.humanoid.getRawBoneNode(bone)!.quaternion
          expect(q.toArray().every(Number.isFinite), `${name}: finite skeleton`).toBe(true)
          if (q.angleTo(initial[index]) > .002) moved = true
        })
      }
      expect(moved, `${name}: actual skinned skeleton should move`).toBe(true)
      expect(controller.activeName, `${name}: should return to Idle`).toBe('idle')
    }
    let sequence = 0
    for (const { id } of VROID_ACTIONS) {
      const clip = clips[id]!
      const session = { action: id, duration: clip.duration, startedAt: 1000, sequence: ++sequence, loop: id === 'idle', source: 'manual' as const, speed: 1, fadeMs: 220 }
      controller.synchronize(session, 1300)
      vrm.update(.03)
      const initial = bones.map(bone => vrm.humanoid.getRawBoneNode(bone)!.quaternion.clone())
      let moved = false
      for (let i = 1; i <= 12; i++) {
        controller.synchronize(session, 1000 + clip.duration * 1000 * i / 13)
        vrm.update(.03)
        bones.forEach((bone, index) => { if (vrm.humanoid.getRawBoneNode(bone)!.quaternion.angleTo(initial[index]) > .002) moved = true })
      }
      expect(moved, `${id}: timestamped playback must deform the actual skeleton`).toBe(true)
    }
    controller.dispose()
    disposeVroid(vrm)
    expect(close).toHaveBeenCalled()
  })
  it('keeps the original portrait and uses a transparent head-and-shoulders thumbnail', async () => {
    const model = gltfJson(resolve(root, 'model.vrm'))
    const image = model.extensions.VRMC_vrm.meta.thumbnailImage as number
    expect(model.images[image].bufferView).toBeTypeOf('number')
    const thumbnail = readFileSync(resolve(root, 'thumbnail.png'))
    expect(thumbnail.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
    expect(thumbnail.readUInt32BE(16)).toBeGreaterThanOrEqual(256)
    expect(thumbnail.readUInt32BE(20)).toBeGreaterThanOrEqual(256)
    const transparent = await loadImage(resolve(root, 'thumbnail-transparent.png'))
    const canvas = createCanvas(transparent.width, transparent.height)
    const context = canvas.getContext('2d')
    context.drawImage(transparent, 0, 0)
    const alpha = (x: number, y: number) => context.getImageData(x, y, 1, 1).data[3]
    expect(alpha(Math.floor(transparent.width / 2), 5)).toBeLessThan(10)
    expect(alpha(Math.floor(transparent.width / 2), Math.floor(transparent.height * .65))).toBeGreaterThan(200)
    expect(alpha(Math.floor(transparent.width / 2), Math.floor(transparent.height * .98))).toBeGreaterThan(200)
  })
})
