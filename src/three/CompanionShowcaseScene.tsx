import { Component, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { MathUtils, PerspectiveCamera, Vector3 } from 'three'
import { AthenaModel } from './AthenaModel'
import { VroidAvatar } from './VroidAvatar'
import { useVroidInstance } from './useVroidInstance'
import { VROID_AVATAR, type VroidInstance } from './vroidAssets'
import vroidThumbnail from '../assets/avatars/vroid-athena/thumbnail-transparent.png'
import { getModelPortrait, modelCommand } from './importAvatar'
import { FloatingAvatarTransition } from './FloatingAvatarTransition'
import { ShowcaseParticles } from './ShowcaseParticles'
import { AvatarSpawnEffect } from './AvatarSpawnEffect'
import { showcasePreviewCameraPose, vroidPreviewCameraPose, showcaseRenderPolicy, type AvatarVariant } from './showcaseMotion'
import { avatarName, isVrmAvatar, type ImportedAvatar } from '../../shared/avatarModels'
import type { Settings } from '../../shared/settings'
import type { Snapshot } from '../../shared/contracts'

// Keep the spawn effect implementation available while hiding it from the
// showcase until the visual treatment is wanted again.
const SHOW_AVATAR_SPAWN_EFFECT = false

interface SceneProps {
  selected: AvatarVariant; energyFX: boolean; greeting: boolean
  settings: Settings; reduced: boolean; economy: boolean; active: boolean
  activity?: Pick<Snapshot, 'state' | 'flight' | 'taskVisual' | 'vroidActions' | 'importedAvatars' | 'floatingVoiceActive'>
  onVroidError?: (message: string | null) => void
}

function PreviewClock({ active, fps }: { active: boolean; fps: number }) {
  const invalidate = useThree(s => s.invalidate)
  useEffect(() => {
    if (!active) return
    invalidate()
    const interval = window.setInterval(invalidate, 1000 / fps)
    return () => window.clearInterval(interval)
  }, [active, fps, invalidate])
  return null
}

function PreviewCamera({ vroidWidth, instance }: { vroidWidth?: number; instance?: VroidInstance }) {
  const { camera, size, invalidate } = useThree()
  const aspect = size.width / Math.max(1, size.height)
  const baseline = useRef(0)
  const point = useMemo(() => new Vector3(), [])
  const bones = useMemo(() => instance ? (['head', 'hips', 'leftHand', 'rightHand', 'leftFoot', 'rightFoot', 'leftToes', 'rightToes', 'leftLowerArm', 'rightLowerArm', 'leftLowerLeg', 'rightLowerLeg'] as const).map(name => instance.vrm.humanoid.getRawBoneNode(name)).filter(node => node !== null) : [], [instance])
  useLayoutEffect(() => {
    if (!(camera instanceof PerspectiveCamera)) return
    const height = VROID_AVATAR.presentation.targetHeight * VROID_AVATAR.presentation.showcaseScale
    const pose = vroidWidth !== undefined ? vroidPreviewCameraPose(aspect, height, vroidWidth) : showcasePreviewCameraPose(aspect)
    camera.position.set(pose.x, pose.y, pose.z)
    baseline.current = pose.z
    camera.fov = pose.fov
    camera.lookAt(0, pose.targetY, 0)
    camera.updateProjectionMatrix()
    invalidate()
  }, [camera, aspect, invalidate, vroidWidth])
  useFrame((_state, delta) => {
    if (!instance || !(camera instanceof PerspectiveCamera)) return
    // Cheap skeletal envelope extends the measured Idle bounds during gestures.
    // Keep the baseline at 80%; pull back only when hands/head/feet approach an edge.
    const height = VROID_AVATAR.presentation.targetHeight * VROID_AVATAR.presentation.showcaseScale
    const tan = Math.tan(camera.fov * Math.PI / 360)
    let distance = baseline.current
    for (const bone of bones) {
      bone.getWorldPosition(point)
      distance = Math.max(distance, point.z + (Math.abs(point.y - camera.position.y) + height * .10) / (tan * .94), point.z + (Math.abs(point.x) + height * .06) / (tan * aspect * .94))
    }
    camera.position.z = distance > camera.position.z ? distance : MathUtils.damp(camera.position.z, distance, 4, Math.min(delta, .1))
  })
  return null
}

function ThumbnailCamera() {
  const { camera, size, invalidate } = useThree()
  const aspect = size.width / Math.max(1, size.height)
  useLayoutEffect(() => {
    // Keep the face the same size as the square crop while showing the shoulders
    // and upper body beneath the translucent nameplate.
    camera.position.set(0, .25, 2.45 / Math.min(1, aspect))
    camera.lookAt(0, .25, 0)
    camera.updateProjectionMatrix()
    invalidate()
  }, [camera, aspect, invalidate])
  return null
}

function AvatarLights({ accent, thumbnail = false, vroid = false }: { accent: string; thumbnail?: boolean; vroid?: boolean }) {
  return <>
    <ambientLight intensity={vroid ? .45 : thumbnail ? 1.8 : 1.6} color={vroid ? '#ffffff' : '#eaf8ff'} />
    <directionalLight position={[0, 5, 5]} intensity={vroid ? 1.1 : thumbnail ? 2.6 : 3.5} color={vroid ? '#ffffff' : '#f5fbff'} />
    <directionalLight position={[-4, 2, 1]} intensity={vroid ? .22 : 1.8} color={vroid ? '#ffffff' : accent} />
    <directionalLight position={[4, 2, 1]} intensity={vroid ? .16 : 1.5} color={vroid ? '#ffffff' : accent} />
  </>
}

class ShowcaseBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  render() { return this.state.failed ? <p className="showcase-unavailable" role="status">The 3D preview is unavailable. Your companion settings are still available.</p> : this.props.children }
}

export function CompanionShowcaseScene(props: SceneProps) {
  const { instance, error, getInstance, displayed, status } = useVroidInstance(isVrmAvatar(props.selected), false, props.selected)
  const name = avatarName(props.selected, props.activity?.importedAvatars)
  useEffect(() => props.onVroidError?.(isVrmAvatar(props.selected) ? error : null), [error, props.selected, props.onVroidError])
  const policy = showcaseRenderPolicy(props.settings.renderQuality, props.reduced, props.economy)
  const accent = useMemo(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#77d7ed', [])
  return <ShowcaseBoundary>{isVrmAvatar(props.selected) && !instance && !error && <p className="showcase-unavailable" role="status">{status === 'animations' ? `Preparing ${name} animations…` : `Loading ${name}…`}</p>}{error && <p className="showcase-unavailable" role="alert">{name} could not load: {error}</p>}{instance?.unavailable.length ? <p className="showcase-unavailable" role="status">Some VRoid animations could not load: {instance.unavailable.map(name => `${name} (${instance.animationErrors[name]})`).join(', ')}</p> : null}<Canvas camera={{ position: [0, 1.05, 8.7], fov: 35, near: .1, far: 45 }} frameloop="demand" dpr={policy.dpr} gl={{ alpha: true, antialias: props.settings.renderQuality !== 'performance', powerPreference: 'low-power' }} onCreated={({ gl }) => gl.setClearColor(0x000000, 0)} fallback={<p className="showcase-unavailable">WebGL is unavailable. Avatar selection is still available.</p>} aria-label="3D preview of the selected Athena avatar">
    <PreviewClock active={props.active} fps={policy.fps} />
    <AvatarLights accent={accent} vroid={isVrmAvatar(props.selected)} />
    <ShowcaseParticles count={policy.particles} color={accent} />
    {SHOW_AVATAR_SPAWN_EFFECT && (!isVrmAvatar(props.selected) || instance) && <AvatarSpawnEffect key={props.selected} groundY={isVrmAvatar(props.selected) ? -VROID_AVATAR.presentation.targetHeight * VROID_AVATAR.presentation.showcaseScale / 2 - .015 : -1.55} reduced={props.reduced} economy={props.economy || props.settings.renderQuality === 'performance'} active={props.active} />}
    <FloatingAvatarTransition variant={props.selected} reduced={props.reduced} ready={!isVrmAvatar(props.selected) || Boolean(instance)} onDisplayedChange={displayed}>{variant => { const shownInstance = getInstance(variant); return (
      <group name={`showcase-${variant}`} position={[0, 0, 0]} scale={isVrmAvatar(variant) ? VROID_AVATAR.presentation.showcaseScale : variant === 'enhanced' ? 1.58 : 1.55}>
        <PreviewCamera instance={isVrmAvatar(variant) ? shownInstance : undefined} vroidWidth={isVrmAvatar(variant) && shownInstance ? shownInstance.fit.sourceWidth * shownInstance.fit.scale * VROID_AVATAR.presentation.showcaseScale : undefined} />
        {isVrmAvatar(variant)
          ? shownInstance && <VroidAvatar key={variant} instance={shownInstance} faceForward session={variant === props.selected ? props.activity?.vroidActions?.session : null} voiceSession={variant === props.selected && props.activity?.floatingVoiceActive ? props.activity?.vroidActions?.voiceSession : null} state={props.activity?.state ?? 'idle'} taskMode={props.activity?.floatingVoiceActive ? 'idle' : props.activity?.taskVisual?.mode ?? 'idle'} flight={props.activity?.flight} intensity={props.settings.animationIntensity * (props.economy ? .4 : 1)} reduced={props.reduced} hover={props.settings.hoverAnimation} />
          : <AthenaModel faceForward variant={variant} energyFX={props.energyFX} state={variant === props.selected && props.greeting ? 'happy' : 'idle'} glow={props.settings.glowIntensity} intensity={props.settings.animationIntensity * (props.economy ? .4 : 1)} reduced={props.reduced} hover={props.settings.hoverAnimation} />}
      </group>
    ) }}</FloatingAvatarTransition>
  </Canvas></ShowcaseBoundary>
}

function VrmPortrait({ variant, model }: { variant: string; model?: ImportedAvatar }) {
  const [portrait, setPortrait] = useState<string>()
  const [error, setError] = useState('')
  useEffect(() => {
    let live = true
    setPortrait(undefined); setError('')
    if (model && (model.importStatus !== 'ready' || model.thumbnailVersion === 2)) return
    void getModelPortrait(variant).then(async image => {
      if (!live) return
      setPortrait(image)
      if (model) await modelCommand({ action: 'thumbnail', id: model.id, thumbnail: image })
    }).catch(cause => { if (live) setError(`Portrait: ${cause instanceof Error ? cause.message : String(cause)}`) })
    return () => { live = false }
  }, [variant, model?.id, model?.importStatus, model?.thumbnailVersion])
  const source = portrait ?? model?.thumbnail ?? (variant === 'vroid-athena' ? vroidThumbnail : undefined)
  return <>{source && <span className="showcase-portrait-clip"><img className="showcase-vroid-thumbnail" src={source} alt="" draggable={false} /></span>}{error && <span className="portrait-error" role="status" title={error}>Portrait update unavailable</span>}</>
}

export function CompanionAvatarThumbnail({ variant, glow, model }: { variant: AvatarVariant; glow: number; model?: ImportedAvatar }) {
  if (isVrmAvatar(variant)) return <VrmPortrait variant={variant} model={model} />
  return <ShowcaseBoundary><Canvas camera={{ position: [0, .5, 2.45], fov: 35, near: .1, far: 15 }} frameloop="demand" dpr={1} gl={{ alpha: true, antialias: true, powerPreference: 'low-power' }} onCreated={({ gl }) => gl.setClearColor(0x000000, 0)} aria-hidden="true">
    <ThumbnailCamera />
    <AvatarLights accent="#77d7ed" thumbnail />
    <group scale={.8}><AthenaModel faceForward variant={variant} energyFX={false} state="idle" glow={glow} intensity={0} reduced hover={false} /></group>
  </Canvas></ShowcaseBoundary>
}
