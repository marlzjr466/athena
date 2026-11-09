import { avatarName, isVrmAvatar } from '../../shared/avatarModels'
import { Component, Suspense, useEffect, useId, useLayoutEffect, useState, type ReactNode } from 'react'
import { Canvas, useThree } from '@react-three/fiber'
import { AthenaModel } from './AthenaModel'
import { VroidAvatar } from './VroidAvatar'
import { useVroidInstance } from './useVroidInstance'
import { AthenaEffects } from './AthenaEffects'
import { useAthena } from '../store/athenaStore'
import { useVisibility } from '../hooks/useVisibility'
import type { AthenaState } from '../../shared/contracts'
import { desktop } from '../services/desktop'
import { setVoiceAmplitude } from './voiceAmplitude'
import { useWindowSize } from '../hooks/useWindowSize'
import { taskHologramLayout } from '../../shared/taskHologramLayout'
import { taskScreenTitle } from '../../shared/taskActivity'
import { TaskWorkingMode } from './TaskWorkingMode'
import { PerspectiveCamera } from 'three'
import { setFloatingProjection } from './floatingProjection'
import { FloatingAvatarTransition } from './FloatingAvatarTransition'

function RenderClock({ fps, active }: { fps: number; active: boolean }) {
  const invalidate = useThree((state) => state.invalidate)
  useEffect(() => {
    if (!active) return
    invalidate()
    const timer = window.setInterval(invalidate, 1000 / fps)
    return () => window.clearInterval(timer)
  }, [active, fps, invalidate])
  return null
}

function ScenePlacement({ preview, characterSize, anchor, children }: { preview: boolean; characterSize: number; anchor?: { x: number; y: number }; children: ReactNode }) {
  const { size, camera, invalidate } = useThree()
  useLayoutEffect(() => {
    if (!(camera instanceof PerspectiveCamera)) return
    if (!preview) setFloatingProjection(camera, size, characterSize, anchor)
    else {
      camera.clearViewOffset()
      camera.aspect = size.width / size.height
      camera.position.set(0, .1, 4.2)
      camera.lookAt(0, .1, 0)
      camera.updateProjectionMatrix()
    }
    invalidate()
  }, [camera, preview, size.width, size.height, characterSize, anchor?.x, anchor?.y, invalidate])
  return <group name="athena-fixed-anchor" rotation={[0, preview ? -.15 : 0, 0]}>{children}</group>
}
class SceneBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  render() { return this.state.failed ? <SceneFallbackAvatar /> : this.props.children }
}

function SceneFallbackAvatar() {
  const id = useId().replaceAll(':', '')
  return <div className="scene-fallback" role="img" aria-label="Athena companion avatar">
    <svg className="scene-fallback-avatar" viewBox="0 0 220 260" aria-hidden="true">
      <defs>
        <linearGradient id={`${id}-shell`} x1="0" y1="0" x2="1" y2="1"><stop stopColor="#fff" /><stop offset="1" stopColor="#9fb9ca" /></linearGradient>
        <linearGradient id={`${id}-body`} x1="0" y1="0" x2="0.9" y2="1"><stop stopColor="#f5fbff" /><stop offset="1" stopColor="#a8c1d1" /></linearGradient>
        <radialGradient id={`${id}-eye`}><stop stopColor="#c8ffff" /><stop offset=".38" stopColor="#55e8ff" /><stop offset="1" stopColor="#219fff" /></radialGradient>
        <radialGradient id={`${id}-platform`}><stop stopColor="#49dfff" stopOpacity=".34" /><stop offset="1" stopColor="#49dfff" stopOpacity="0" /></radialGradient>
      </defs>
      <ellipse cx="110" cy="236" rx="82" ry="17" fill={`url(#${id}-platform)`} />
      <ellipse cx="110" cy="235" rx="48" ry="6" fill="none" stroke="#70eaff" strokeOpacity=".7" strokeWidth="2" />
      <path d="M110 25V13" stroke="#bdd7e4" strokeWidth="5" strokeLinecap="round" /><circle cx="110" cy="10" r="5" fill="#6beaff" />
      <rect x="54" y="32" width="112" height="89" rx="38" fill={`url(#${id}-shell)`} stroke="#e7f9ff" strokeWidth="3" />
      <path d="M68 54c7-14 19-21 38-21" fill="none" stroke="#fff" strokeOpacity=".9" strokeWidth="4" strokeLinecap="round" />
      <circle cx="84" cy="77" r="10" fill={`url(#${id}-eye)`} /><circle cx="136" cy="77" r="10" fill={`url(#${id}-eye)`} />
      <rect x="93" y="108" width="34" height="15" rx="7" fill="#7896a8" />
      <path d="M82 132q28-14 56 0l13 47q-41 23-82 0z" fill={`url(#${id}-body)`} stroke="#dff6ff" strokeWidth="2" />
      <circle cx="110" cy="153" r="9" fill="#55dfff" fillOpacity=".82" />
      <path d="M80 139 63 172m77-33 17 33" fill="none" stroke={`url(#${id}-shell)`} strokeWidth="15" strokeLinecap="round" />
      <circle cx="62" cy="174" r="8" fill="#c6dbe5" /><circle cx="158" cy="174" r="8" fill="#c6dbe5" />
      <path d="m94 181-5 28m37-28 5 28" fill="none" stroke={`url(#${id}-body)`} strokeWidth="16" strokeLinecap="round" />
      <path d="M81 214h17m24 0h17" stroke="#bad0dc" strokeWidth="10" strokeLinecap="round" />
    </svg>
  </div>
}

export function AthenaScene({ preview = false, reaction }: { preview?: boolean; reaction?: AthenaState }) {
  useEffect(() => {
    if (preview) return
    const unsubscribe = desktop.onSpeechLevel(({ level }) => setVoiceAmplitude(level))
    return () => { unsubscribe(); setVoiceAmplitude(0) }
  }, [preview])
  const snapshot = useAthena((state) => state.snapshot)
  const visible = useVisibility()
  const viewport = useWindowSize()
  const [systemReduced, setSystemReduced] = useState(window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    const update = () => setSystemReduced(media.matches)
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  const { instance: vroidInstance, getInstance, displayed, error: vroidError } = useVroidInstance(isVrmAvatar(snapshot?.settings.avatarVariant), false, snapshot?.settings.avatarVariant)
  if (!snapshot) return null
  const { settings, onBattery } = snapshot
  const vroidLighting = isVrmAvatar(settings.avatarVariant)
  const reduced = settings.reducedMotion || snapshot.reducedMotion || systemReduced || settings.doNotDisturb
  const economy = settings.reduceOnBattery && onBattery
  const fps = reduced ? 8 : snapshot.flight || snapshot.idleAction ? 60 : economy ? 15 : { performance: 20, balanced: 30, quality: 45 }[settings.renderQuality]
  const state = reaction ?? snapshot.state
  const floatingVoiceActive = !preview && snapshot.floatingVoiceActive === true
  const taskMode = preview || floatingVoiceActive ? 'idle' : snapshot.taskVisual?.mode ?? 'idle'
  // The main process gives local chat tasks priority. Direct floating voice
  // gets its own screen-free presentation, including for non-VRM avatars.
  const voiceSession = floatingVoiceActive ? snapshot.vroidActions?.voiceSession ?? null : null
  // The task anchor is in desktop-window coordinates, while the companion
  // page renders Athena in a centered preview canvas. Never apply that screen
  // position to the preview (or while idle), or the avatar can be translated
  // completely outside the preview viewport.
  const taskAnchor = !preview && taskMode !== 'idle' ? snapshot.taskVisual?.anchor : undefined
  const layout = taskHologramLayout(taskAnchor ?? { x: viewport.width / 2, y: viewport.height / 2 }, viewport, settings.size)
  const taskScreen = !preview && taskMode !== 'idle' && settings.taskActivityEnabled && settings.taskHologramsEnabled && (!['completed', 'failed', 'cancelled'].includes(taskMode) || settings.taskCompletionNotification)
    ? { title: taskScreenTitle(taskMode, snapshot.taskVisual?.activityType), label: ['completed', 'failed', 'cancelled'].includes(taskMode) ? taskScreenTitle(taskMode) : snapshot.taskVisual?.label ?? 'Considering your request', detailed: settings.taskDetailedHolograms, screenY: layout.screenY }
    : undefined
  return <SceneBoundary>
    {isVrmAvatar(settings.avatarVariant) && vroidError && <p role="alert">{avatarName(settings.avatarVariant, snapshot.importedAvatars)} could not load: {vroidError}</p>}
    <Canvas
      camera={{ position: [0, .1, 4.2], fov: preview ? 35 : 34 }}
      frameloop="demand" dpr={settings.renderQuality === 'quality' ? [1, 2] : [1, 1.5]}
      gl={{ alpha: true, antialias: settings.renderQuality !== 'performance', powerPreference: preview ? 'default' : 'low-power' }}
      fallback={<SceneFallbackAvatar />}
      onCreated={({ gl }) => gl.setClearColor(0x000000, 0)}
      aria-label={isVrmAvatar(settings.avatarVariant) && vroidInstance ? `${avatarName(settings.avatarVariant, snapshot.importedAvatars)} floating companion` : 'Athena, a pearl-white floating robot with cyan eyes'}
    >
      <RenderClock fps={fps} active={visible && (preview || snapshot.visible)} />
      <ambientLight intensity={vroidLighting ? .45 : 1.7} />
      <directionalLight position={[3, 5, 4]} intensity={vroidLighting ? 1.15 : 3} color={vroidLighting ? '#ffffff' : '#effaff'} />
      <pointLight position={[-3, 1, 2]} intensity={vroidLighting ? .3 : 7} color={vroidLighting ? '#ffffff' : '#5ac8fa'} />
      <pointLight position={[2, 0, -2]} intensity={vroidLighting ? .2 : 5} color={vroidLighting ? '#ffffff' : '#328cff'} />
      <Suspense fallback={null}>
        <ScenePlacement preview={preview} characterSize={settings.size} anchor={taskAnchor}>
          <TaskWorkingMode mode={taskScreen ? taskMode : 'idle'} yaw={voiceSession ? 0 : layout.yaw} listening={Boolean(voiceSession && state === 'listening')} reduced={reduced}>
            <FloatingAvatarTransition variant={settings.avatarVariant} reduced={reduced} ready={!isVrmAvatar(settings.avatarVariant) || Boolean(vroidInstance)} onDisplayedChange={displayed}>{variant => { const shownInstance = getInstance(variant); return isVrmAvatar(variant)
              ? shownInstance && <VroidAvatar key={variant} instance={shownInstance} session={variant === settings.avatarVariant ? snapshot.vroidActions?.session : null} voiceSession={variant === settings.avatarVariant ? voiceSession : null} faceForward={preview || Boolean(voiceSession)} suppressTaskScreen={floatingVoiceActive} state={state} flight={!preview && taskMode === 'idle' ? snapshot.flight : null} idleAction={!preview && taskMode === 'idle' ? snapshot.idleAction : null} intensity={taskMode === 'idle' ? (economy ? 0.25 : settings.animationIntensity) : settings.taskAnimationIntensity * (economy ? .4 : 1)} hover={settings.hoverAnimation} reduced={reduced} taskMode={taskMode} taskFocus={{ x: 0, y: -.4 }} taskScreen={taskScreen} />
              : <AthenaModel variant={variant} energyFX={settings.avatarEnergyFX} state={state} flight={!preview && taskMode === 'idle' ? snapshot.flight : null} idleAction={!preview && taskMode === 'idle' ? snapshot.idleAction : null} glow={settings.glowIntensity * (taskMode === 'idle' ? 1 : 1.12)} intensity={taskMode === 'idle' ? (economy ? 0.25 : settings.animationIntensity) : settings.taskAnimationIntensity * (economy ? .4 : 1)} hover={settings.hoverAnimation} reduced={reduced} taskMode={taskMode} taskFocus={{ x: 0, y: -.4 }} taskScreen={taskScreen} suppressTaskScreen={floatingVoiceActive} />} }</FloatingAvatarTransition>
          </TaskWorkingMode>
          <AthenaEffects flight={!preview && taskMode === 'idle' ? snapshot.flight : null} intensity={reduced || (settings.avatarVariant === 'enhanced' && !settings.avatarEnergyFX) ? 0 : economy ? settings.particleIntensity * 0.3 : settings.particleIntensity} reduced={reduced} working={state === 'thinking' || state === 'working'} />
        </ScenePlacement>
      </Suspense>
    </Canvas>
  </SceneBoundary>
}
