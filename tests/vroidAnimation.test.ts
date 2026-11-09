import { describe, expect, it } from 'vitest'
import { AnimationClip, Group, NumberKeyframeTrack, VectorKeyframeTrack } from 'three'
import { vroidActionFor } from '../src/three/vroidAnimation'
import { VroidAnimationController } from '../src/three/vroidAnimation'
import type { VroidInstance } from '../src/three/vroidAssets'
import type { VroidActionSession } from '../shared/vroidActions'
import type { VroidVoiceSession } from '../shared/vroidActions'

describe('VRoid action mapping', () => {
  it('synchronizes independent mixers after joining mid-action and corrects frame drift', () => {
    const first = fixture(), second = fixture()
    const a = new VroidAnimationController(first), b = new VroidAnimationController(second)
    const session: VroidActionSession = { action: 'bow', startedAt: 1000, duration: 1, loop: false, speed: 1, sequence: 1, source: 'manual', fadeMs: 220, previous: { action: 'idle', startedAt: 0, duration: 1, loop: true, speed: 1 } }
    for (const now of [1050, 1100, 1700, 1900, 2100]) {
      a.synchronize(session, now)
      b.synchronize(session, now)
      expect(first.vrm.scene.position.y).toBeCloseTo(second.vrm.scene.position.y)
      expect(first.vrm.scene.position.y).toBeGreaterThan(.9)
    }
    // One-shots hold their last valid pose until main supplies Idle.
    expect(first.vrm.scene.position.y).toBeCloseTo(2.1)
    const idle: VroidActionSession = { ...session, action: 'idle', startedAt: 2100, sequence: 2, loop: true, previous: session }
    a.synchronize(idle, 2210); b.synchronize(idle, 2210)
    expect(first.vrm.scene.position.y).toBeCloseTo(second.vrm.scene.position.y)
    expect(first.vrm.scene.position.y).toBeGreaterThan(1)
    a.dispose(); b.dispose()
  })
  it('uses actual imported clips for idle, work, reactions and idle actions', () => {
    expect(vroidActionFor('idle')).toBe('idle')
    expect(vroidActionFor('idle', 'idle', 'bow')).toBe('bow')
    expect(vroidActionFor('working', 'terminal')).toBe('thinking')
    expect(vroidActionFor('idle', 'idle', 'slight-jump')).toBe('jump')
    expect(vroidActionFor('idle', 'idle', 'look-around')).toBe('look-around')
    expect(vroidActionFor('idle', 'idle', 'wave')).toBe('goodbye')
    expect(vroidActionFor('sleeping')).toBe('sleepy')
    expect(vroidActionFor('error')).toBe('sad')
  })
  it('uses the imported Clapping animation on task completion', () => {
    expect(vroidActionFor('working', 'completed')).toBe('clapping')
  })
  it('crossfades available clips, falls back for missing clips, and releases mixer actions', () => {
    const scene = new Group()
    const makeClip = (name: string) => new AnimationClip(name, 1, [new VectorKeyframeTrack('.position', [0, 1], [0, .1, 0, 0, 0, 0])])
    const instance = { vrm: { scene, update: () => {} }, clips: { idle: makeClip('idle'), jump: makeClip('jump') }, unavailable: ['angry'] } as unknown as VroidInstance
    const controller = new VroidAnimationController(instance)
    expect(controller.play('jump')).toBe(true)
    controller.update(.1)
    expect(controller.play('angry')).toBe(false)
    controller.update(.1)
    controller.dispose()
    expect(controller.mixer.existingAction(instance.clips.idle!)).toBeNull()
  })
  it('primes Idle, completes one-shots and keeps an animated base pose during crossfades', () => {
    const instance = fixture()
    const controller = new VroidAnimationController(instance)
    expect(controller.activeName).toBe('idle')
    expect(instance.vrm.scene.position.y).toBeCloseTo(1)
    controller.play('bow')
    for (let i = 0; i < 25; i++) {
      controller.update(.1)
      expect(instance.vrm.scene.position.y).toBeGreaterThan(.5)
    }
    expect(controller.activeName).toBe('idle')
    for (let i = 0; i < 100; i++) controller.update(.1)
    expect(controller.activeName).toBe('idle')
    expect(instance.vrm.scene.position.y).toBeGreaterThan(.9)
    controller.dispose()
  })
  it('interrupts a random action for work, then resumes idle without replaying the completed action', () => {
    const controller = new VroidAnimationController(fixture())
    controller.play('bow')
    expect(controller.activeName).toBe('bow')
    controller.play('thinking')
    for (let i = 0; i < 40; i++) controller.update(.1)
    expect(controller.activeName).toBe('thinking')
    controller.play('idle')
    controller.update(.1)
    expect(controller.activeName).toBe('idle')
    controller.dispose()
  })
  it('plays synchronized voice gesture and facial layers, loops them, and cleans them up on cancellation', () => {
    const instance = fixture()
    const previewInstance = fixture()
    const face = new Group()
    face.name = 'Face'
    ;(face as Group & { weight: number }).weight = 0
    instance.vrm.scene.add(face)
    const previewFace = new Group()
    previewFace.name = 'Face'
    ;(previewFace as Group & { weight: number }).weight = 0
    previewInstance.vrm.scene.add(previewFace)
    const gestures = new AnimationClip('voice gestures', 1, [new VectorKeyframeTrack('.position', [0, 1], [0, 0, 0, 0, 1, 0])])
    const expressions = new AnimationClip('voice expression', 1, [new NumberKeyframeTrack('Face.weight', [0, 1], [0, 1])])
    instance.voiceClips = { gestures, expressions, expressionNames: ['happy'] }
    previewInstance.voiceClips = { gestures: gestures.clone(), expressions: expressions.clone(), expressionNames: ['happy'] }
    const controller = new VroidAnimationController(instance)
    const previewController = new VroidAnimationController(previewInstance)
    const voice: VroidVoiceSession = { source: 'floating-voice', phase: 'talking', startedAt: 1000, sequence: 1, fadeMs: 0, previous: { phase: 'thinking', startedAt: 0 } }
    controller.synchronizeVoice(voice, 1250)
    previewController.synchronizeVoice(voice, 1250)
    expect(instance.vrm.scene.position.y).toBeCloseTo(.25)
    expect((face as Group & { weight: number }).weight).toBeCloseTo(.25)
    controller.synchronizeVoice(voice, 2250)
    previewController.synchronizeVoice(voice, 2250)
    expect(instance.vrm.scene.position.y).toBeCloseTo(.25)
    expect((face as Group & { weight: number }).weight).toBeCloseTo(.25)
    expect(previewInstance.vrm.scene.position.y).toBeCloseTo(instance.vrm.scene.position.y)
    expect((previewFace as Group & { weight: number }).weight).toBeCloseTo((face as Group & { weight: number }).weight)
    const expressionAction = controller.mixer.existingAction(expressions)!
    const idle: VroidActionSession = { action: 'idle', startedAt: 2250, duration: 1, loop: true, speed: 1, sequence: 2, source: 'idle', fadeMs: 220 }
    controller.synchronize(idle, 2300)
    previewController.synchronize(idle, 2300)
    expect(expressionAction.isRunning()).toBe(true)
    controller.synchronize(idle, 2520)
    previewController.synchronize(idle, 2520)
    expect(expressionAction.isRunning()).toBe(false)
    controller.dispose()
    previewController.dispose()
  })
})

function fixture(): VroidInstance {
  const scene = new Group()
  const clip = (name: string, y: number) => new AnimationClip(name, 1, [new VectorKeyframeTrack('.position', [0, 1], [0, y, 0, 0, y + .1, 0])])
  return { vrm: { scene, update: () => {} }, clips: { idle: clip('idle', 1), bow: clip('bow', 2), clapping: clip('clapping', 3), thinking: clip('thinking', 4) } } as unknown as VroidInstance
}
