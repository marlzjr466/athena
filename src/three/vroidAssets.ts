import { VRMLoaderPlugin, VRMUtils, type VRM } from '@pixiv/three-vrm'
import { VRMAnimationLoaderPlugin, createVRMAnimationClip, createVRMAnimationExpressionTracks, createVRMAnimationHumanoidTracks, type VRMAnimation } from '@pixiv/three-vrm-animation'
import { GLTFLoader, type GLTFParser } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { AnimationClip, AnimationMixer, Box3, Material, Mesh, SkinnedMesh, Texture, Vector3 } from 'three'
import modelUrl from '../assets/avatars/vroid-athena/model.vrm?url'
import { VROID_ACTIONS, type VroidActionId, type VroidVoiceClips } from '../../shared/vroidActions'
import { desktop } from '../services/desktop'

// Register only animation files actually present in the project.
const animationFiles = import.meta.glob<string>('../assets/avatars/vroid-athena/animations/*.vrma', { query: '?url', import: 'default', eager: true })
export const VROID_ANIMATIONS = Object.fromEntries(VROID_ACTIONS.map(action => [action.id,
  Object.entries(animationFiles).find(([path]) => path.split('/').at(-1)?.normalize('NFC') === action.file.normalize('NFC'))?.[1],
])) as Record<VroidActionId, string | undefined>
const voiceAnimationFiles = Object.fromEntries(
  ['Talking_Gestures_Only.vrma', 'Talking.vrma'].map(file => [file, Object.entries(animationFiles).find(([path]) => path.split('/').at(-1)?.normalize('NFC') === file.normalize('NFC'))?.[1]]),
) as Record<'Talking_Gestures_Only.vrma' | 'Talking.vrma', string | undefined>
export const VROID_VOICE_ANIMATIONS = {
  gestures: voiceAnimationFiles['Talking_Gestures_Only.vrma'],
  expressions: voiceAnimationFiles['Talking.vrma'],
} as const
export type VroidAnimationName = VroidActionId
export const VROID_AVATAR = {
  id: 'vroid-athena', name: 'Athena', modelUrl, animations: VROID_ANIMATIONS,
  presentation: { targetHeight: 2, showcaseScale: 1.42 },
} as const

export interface VroidInstance {
  vrm: VRM
  clips: Partial<Record<VroidAnimationName, AnimationClip>>
  animationExpressionNames: Partial<Record<VroidAnimationName, string[]>>
  voiceClips: VroidVoiceClips
  unavailable: VroidAnimationName[]
  animationErrors: Partial<Record<VroidAnimationName, string>>
  fit: { scale: number; offsetX?: number; offsetY: number; sourceHeight: number; sourceWidth: number }
}

const mouthVisemes = new Set(['aa', 'ee', 'ih', 'oh', 'ou'])

/** Split the supplied talking files into disjoint body and expression layers. */
export function createVroidVoiceClips(gestureAnimation: VRMAnimation | undefined, expressionAnimation: VRMAnimation | undefined, vrm: VRM): VroidVoiceClips {
  let gestures: AnimationClip | undefined
  let expressions: AnimationClip | undefined
  const expressionNames: string[] = []
  if (gestureAnimation) {
    const tracks = createVRMAnimationHumanoidTracks(gestureAnimation, vrm.humanoid, vrm.meta.metaVersion)
    const humanoidTracks = [...tracks.translation.values(), ...tracks.rotation.values()]
    if (humanoidTracks.length) gestures = new AnimationClip('FloatingAthenaTalkingGestures', gestureAnimation.duration, humanoidTracks)
  }
  if (expressionAnimation && vrm.expressionManager) {
    const tracks = createVRMAnimationExpressionTracks(expressionAnimation, vrm.expressionManager)
    const facialTracks = [...tracks.preset.entries(), ...tracks.custom.entries()]
      .filter(([name]) => !mouthVisemes.has(name))
    if (facialTracks.length) {
      expressionNames.push(...facialTracks.map(([name]) => name))
      expressions = new AnimationClip('FloatingAthenaTalkingExpressions', expressionAnimation.duration, facialTracks.map(([, track]) => track))
    }
  }
  return { gestures, expressions, expressionNames }
}

export function fitVroid(bounds: Box3, targetHeight = VROID_AVATAR.presentation.targetHeight) {
  const height = bounds.getSize(new Vector3()).y
  if (!Number.isFinite(height) || height <= .01 || height > 10) throw new Error(`VRoid model has invalid bounds (height ${height}).`)
  const scale = targetHeight / height
  return { scale, offsetX: -(bounds.min.x + bounds.max.x) * scale / 2, offsetY: -(bounds.min.y + bounds.max.y) * scale / 2, sourceHeight: height, sourceWidth: bounds.getSize(new Vector3()).x }
}

export function installEmbeddedVrmImageLoader(parser: GLTFParser) {
  // GLTFLoader normally turns embedded image bufferViews into blob: URLs and
  // fetches them. Decode the VRM's own bytes directly so the desktop renderer
  // works under Athena's deliberately narrow image/connect CSP.
  const original = parser.loadImageSource.bind(parser)
  const images = new Map<number, Promise<Texture>>()
  parser.loadImageSource = (index, imageLoader) => {
    const source = parser.json.images?.[index] as { bufferView?: number; mimeType?: string } | undefined
    if (source?.bufferView === undefined) return original(index, imageLoader)
    const cached = images.get(index)
    if (cached) return cached.then(texture => texture.clone())
    const image = parser.getDependency('bufferView', source.bufferView)
      .then((bytes: ArrayBuffer) => createImageBitmap(new Blob([bytes], { type: source.mimeType }), { colorSpaceConversion: 'none' }))
      .then(bitmap => {
        const texture = new Texture(bitmap)
        texture.needsUpdate = true
        texture.userData.mimeType = source.mimeType
        return texture
      }).catch(error => {
        images.delete(index)
        throw new Error(`Embedded VRM image ${index} could not be decoded`, { cause: error })
      })
    images.set(index, image)
    return image
  }
  return { name: 'ATHENA_embedded_vrm_images' }
}

export function createVroidLoader() {
  const loader = new GLTFLoader()
  loader.register(installEmbeddedVrmImageLoader)
  loader.register(parser => new VRMLoaderPlugin(parser))
  loader.register(parser => new VRMAnimationLoaderPlugin(parser))
  return loader
}

export async function loadVroidInstance(thumbnail = false, onProgress?: (stage: string) => void | Promise<void>, modelId = 'vroid-athena', options: { animations?: VroidAnimationName[]; signal?: AbortSignal } = {}): Promise<VroidInstance> {
  const loader = createVroidLoader()
  const load = async (url: string) => {
    if (!options.signal) return loader.loadAsync(url)
    const response = await fetch(url, { signal: options.signal })
    if (!response.ok) throw new Error(`Avatar asset unavailable (${response.status})`)
    return loader.parseAsync(await response.arrayBuffer(), '')
  }
  await onProgress?.('model')
  const model = modelId === 'vroid-athena' ? await load(modelUrl) : await loader.parseAsync(new Uint8Array(await desktop.readAvatarModel(modelId)).buffer, '')
  const vrm = model.userData.vrm as VRM | undefined
  if (!vrm) throw new Error('The selected file did not contain a VRM avatar.')
  VRMUtils.rotateVRM0(vrm)
  const clips: VroidInstance['clips'] = {}
  const animationExpressionNames: VroidInstance['animationExpressionNames'] = {}
  const expressionNameByTrack = new Map((vrm.expressionManager?.expressions ?? []).map(expression => [`${expression.name}.weight`, expression.expressionName]))
  let voiceClips: VroidVoiceClips = { expressionNames: [] }
  const unavailable: VroidAnimationName[] = []
  const animationErrors: VroidInstance['animationErrors'] = {}
  try {
    options.signal?.throwIfAborted()
    await onProgress?.('skeleton')
    if (!vrm.humanoid.getNormalizedBoneNode('hips') || !vrm.humanoid.getNormalizedBoneNode('head')) throw new Error('The model has no usable humanoid hips/head mapping.')
    await onProgress?.('animations')
    vrm.scene.updateMatrixWorld(true)
    const names: VroidAnimationName[] = options.animations ?? (thumbnail ? ['idle'] : VROID_ACTIONS.map(action => action.id))
    await onProgress?.('binding')
    await Promise.all(names.map(async name => {
      try {
        const url = VROID_ANIMATIONS[name]
        if (!url) throw new Error(`Missing animation asset: ${VROID_ACTIONS.find(action => action.id === name)?.file}`)
        const animation = await load(url)
        const vrma = animation.userData.vrmAnimations?.[0]
        if (!vrma) throw new Error('No VRMA animation in file')
        const clip = createVRMAnimationClip(vrma, vrm)
        if (!clip.tracks.length) throw new Error('VRMA has no compatible tracks')
        if (!Number.isFinite(clip.duration) || clip.duration <= 0 || !clip.validate()) throw new Error('VRMA has invalid duration or animation tracks')
        animationExpressionNames[name] = clip.tracks.map(track => expressionNameByTrack.get(track.name)).filter((expression): expression is string => Boolean(expression))
        clips[name] = clip
      } catch (error) {
        unavailable.push(name)
        animationErrors[name] = error instanceof Error ? error.message : String(error)
        console.warn(`VRM animation ${name} is unavailable`, error)
      }
    }))
    options.signal?.throwIfAborted()
    if (!thumbnail && !options.animations) {
      const [gestureResult, expressionResult] = await Promise.allSettled([
        VROID_VOICE_ANIMATIONS.gestures ? loader.loadAsync(VROID_VOICE_ANIMATIONS.gestures) : Promise.reject(new Error('Talking_Gestures_Only.vrma is missing.')),
        VROID_VOICE_ANIMATIONS.expressions ? loader.loadAsync(VROID_VOICE_ANIMATIONS.expressions) : Promise.reject(new Error('Talking.vrma is missing.')),
      ])
      const gesture = gestureResult.status === 'fulfilled' ? gestureResult.value.userData.vrmAnimations?.[0] : undefined
      const expression = expressionResult.status === 'fulfilled' ? expressionResult.value.userData.vrmAnimations?.[0] : undefined
      try { voiceClips = createVroidVoiceClips(gesture, expression, vrm) }
      catch (error) { console.warn('Floating voice animation layers could not be prepared; using the existing animation system.', error) }
      if (!voiceClips.gestures && gestureResult.status === 'rejected') console.warn('Floating voice gestures are unavailable', gestureResult.reason)
      if (!voiceClips.expressions && expressionResult.status === 'rejected') console.warn('Floating voice expressions are unavailable; using the existing facial animation system.', expressionResult.reason)
    }
    await onProgress?.('idle')
    if (!clips.idle) throw new Error('Could not prepare Idle.vrma. The model will not be activated in a rest pose. ' + (animationErrors.idle ?? 'Idle.vrma is missing.'))
    // Measure the real posed body, not the wide rest-pose arms. Prepare a pose
    // before publishing readiness so no first-frame T-pose can flash on screen.
    const primer = new AnimationMixer(vrm.scene)
    primer.clipAction(clips.idle).play()
    primer.update(0)
    vrm.update(0)
    vrm.scene.updateMatrixWorld(true)
    vrm.scene.traverse(object => { if (object instanceof SkinnedMesh) { object.computeBoundingBox(); object.computeBoundingSphere() } })
    const fit = fitVroid(new Box3().setFromObject(vrm.scene))
    primer.stopAllAction()
    primer.uncacheRoot(vrm.scene)
    await onProgress?.('ready')
    return { vrm, clips, animationExpressionNames, voiceClips, unavailable, animationErrors, fit }
  } catch (error) {
    disposeVroid(vrm)
    throw error
  }
}

export function disposeVroid(vrm: VRM): void {
  const geometries = new Set<Mesh['geometry']>()
  const materials = new Set<Material>()
  const textures = new Set<Texture>()
  const bitmaps = new Set<{ close: () => void }>()
  // MToon exposes its maps through prototype getters, so Object.values alone
  // misses the embedded images (and leaves decoded ImageBitmaps resident).
  const textureProperties = [
    'map', 'normalMap', 'emissiveMap', 'alphaMap', 'aoMap', 'bumpMap', 'displacementMap',
    'envMap', 'lightMap', 'metalnessMap', 'roughnessMap', 'specularMap',
    'shadeMultiplyTexture', 'shadingShiftTexture', 'matcapTexture',
    'rimMultiplyTexture', 'outlineWidthMultiplyTexture', 'uvAnimationMaskTexture',
  ] as const
  vrm.scene.traverse(object => {
    if (!(object instanceof Mesh)) return
    geometries.add(object.geometry)
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      if (!material) continue
      materials.add(material)
      for (const value of Object.values(material)) if (value instanceof Texture) textures.add(value)
      for (const property of textureProperties) {
        const value = (material as unknown as Record<string, unknown>)[property]
        if (value instanceof Texture) textures.add(value)
      }
    }
  })
  geometries.forEach(geometry => geometry.dispose())
  materials.forEach(material => material.dispose())
  textures.forEach(texture => {
    if (typeof texture.image?.close === 'function') bitmaps.add(texture.image)
    texture.dispose()
  })
  bitmaps.forEach(bitmap => bitmap.close())
}
