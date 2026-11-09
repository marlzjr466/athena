import { AmbientLight, AnimationMixer, Box3, DirectionalLight, OrthographicCamera, Scene, Vector3, WebGLRenderer } from 'three'
import { desktop } from '../services/desktop'
import { IMPORT_STAGES, type ImportedAvatar, type ModelCommand } from '../../shared/avatarModels'
import { VROID_ACTIONS } from '../../shared/vroidActions'
import { disposeVroid, loadVroidInstance, type VroidInstance } from './vroidAssets'

export async function modelCommand(input: ModelCommand) {
  if (!desktop.avatarModel) throw new Error('The desktop import bridge needs to be loaded. An approved app restart is required; your current models are unchanged.')
  const result = await desktop.avatarModel(input)
  if (!result.ok) throw new Error(result.error ?? 'Model operation failed.')
  return result
}

/** Render a single frame of the actual model, with original VRM materials. */
export function renderModelPortrait(instance: VroidInstance): string {
  const renderer = new WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true })
  const scene = new Scene(), mixer = new AnimationMixer(instance.vrm.scene)
  const oldRotation = instance.vrm.scene.rotation.clone()
  try {
    renderer.setSize(384, 384); renderer.setClearColor(0x000000, 0)
    mixer.clipAction(instance.clips.idle!).play(); mixer.update(0); instance.vrm.update(0)
    const model = instance.vrm.scene
    scene.add(model); scene.updateMatrixWorld(true)
    const bounds = new Box3().setFromObject(model)
    const head = instance.vrm.humanoid.getRawBoneNode('head')!.getWorldPosition(new Vector3())
    const shoulders = (['leftUpperArm', 'rightUpperArm'] as const).map(name => instance.vrm.humanoid.getRawBoneNode(name)?.getWorldPosition(new Vector3())).filter((v): v is Vector3 => Boolean(v))
    const bottom = shoulders.length ? Math.min(...shoulders.map(p => p.y)) - instance.fit.sourceHeight * .055 : head.y - instance.fit.sourceHeight * .18
    const crop = Math.max((bounds.max.y - bottom) * 1.06, ...shoulders.map(p => Math.abs(p.x - head.x) * 2.5), instance.fit.sourceHeight * .3)
    // A fixed square portrait keeps the same shoulder crop at every card size.
    // Orthographic framing avoids perspective-dependent extra empty space.
    const camera = new OrthographicCamera(-crop / 2, crop / 2, crop / 2, -crop / 2, .01, 100)
    const target = new Vector3(head.x, bottom + crop / 2, head.z)
    camera.position.copy(target).add(new Vector3(0, 0, instance.fit.sourceHeight * 2)); camera.lookAt(target)
    scene.add(new AmbientLight('#ffffff', .45))
    const light = new DirectionalLight('#ffffff', 1.15); light.position.set(0, 4, 5); scene.add(light)
    renderer.render(scene, camera)
    return renderer.domElement.toDataURL('image/png')
  } finally { mixer.stopAllAction(); mixer.uncacheRoot(instance.vrm.scene); scene.remove(instance.vrm.scene); instance.vrm.scene.rotation.copy(oldRotation); renderer.dispose(); renderer.forceContextLoss() }
}

const portraits = new Map<string, Promise<string>>()
let portraitQueue: Promise<unknown> = Promise.resolve()
export function forgetModelPortrait(id: string) { portraits.delete(id) }
export function getModelPortrait(id: string): Promise<string> {
  const existing = portraits.get(id)
  if (existing) return existing
  const request = portraitQueue.catch(() => {}).then(async () => {
    const cacheKey = 'athena-bundled-portrait-v2'
    if (id === 'vroid-athena') {
      try { const cached = localStorage.getItem(cacheKey); if (cached?.startsWith('data:image/png;base64,')) return cached } catch { /* Storage may be unavailable. */ }
    }
    const instance = await loadVroidInstance(true, undefined, id)
    try {
      const portrait = renderModelPortrait(instance)
      if (id === 'vroid-athena') { try { localStorage.setItem(cacheKey, portrait) } catch { /* The in-memory cache remains available. */ } }
      return portrait
    } finally { disposeVroid(instance.vrm) }
  })
  portraitQueue = request
  portraits.set(id, request)
  void request.catch(() => portraits.delete(id))
  return request
}

const pending = new Map<string, Promise<void>>()
export function integrateImportedAvatar(model: ImportedAvatar): Promise<void> {
  const previous = pending.get(model.id)
  if (previous) return previous
  const run = (async () => {
    let instance: VroidInstance | undefined
    try {
      const stages: Record<string, typeof IMPORT_STAGES[number]> = { model: IMPORT_STAGES[2], skeleton: IMPORT_STAGES[3], animations: IMPORT_STAGES[4], binding: IMPORT_STAGES[5], idle: IMPORT_STAGES[6] }
      instance = await loadVroidInstance(false, async stage => { if (stages[stage]) await modelCommand({ action: 'progress', id: model.id, stage: stages[stage] }) }, model.id)
      await modelCommand({ action: 'progress', id: model.id, stage: 'Generating avatar thumbnail' })
      const thumbnail = renderModelPortrait(instance)
      await modelCommand({ action: 'progress', id: model.id, stage: 'Finalizing model registration' })
      await modelCommand({ action: 'finish', id: model.id, thumbnail, scale: instance.fit.scale, clips: VROID_ACTIONS.map(({ id }) => ({ id, duration: instance!.clips[id]?.duration, error: instance!.animationErrors[id] })) })
    } catch (error) {
      await modelCommand({ action: 'fail', id: model.id, error: (error instanceof Error ? error.message : String(error)).slice(0, 1000) })
    } finally { if (instance) disposeVroid(instance.vrm); pending.delete(model.id) }
  })()
  pending.set(model.id, run)
  return run
}
