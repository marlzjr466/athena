import { useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { Group, MathUtils } from 'three'
import type { AnimationOptions } from './AthenaAnimations'
import { useVroidController } from './useVroidController'
import type { VroidInstance } from './vroidAssets'
import { flightPose } from '../../shared/flight'
import { voiceAmplitude } from './voiceAmplitude'
import { TaskWorkScreen } from './TaskWorkScreen'
import type { TaskVisualMode } from '../../shared/contracts'
import type { VroidActionSession, VroidVoiceSession } from '../../shared/vroidActions'

type Screen = { title: string; label: string; detailed: boolean; screenY: number }

export function VroidAvatar({ instance, taskScreen, faceForward = false, session, voiceSession, suppressTaskScreen = false, ...options }: AnimationOptions & { instance: VroidInstance; taskScreen?: Screen; faceForward?: boolean; session?: VroidActionSession | null; voiceSession?: VroidVoiceSession | null; suppressTaskScreen?: boolean }) {
  const controllerRef = useVroidController(instance)
  const flightRig = useRef<Group>(null)
  const actionRig = useRef<Group>(null)
  const body = useRef<Group>(null)
  const nextBlink = useRef(2 + Math.random() * 2)
  const voicePhase = useRef<VroidVoiceSession['phase'] | null>(null)
  const expressionResetSequence = useRef<number | null>(null)
  const retainedScreen = useRef<(Screen & { mode: TaskVisualMode }) | null>(null)
  if (taskScreen) retainedScreen.current = { ...taskScreen, mode: options.taskMode ?? 'idle' }
  const screen = retainedScreen.current

  useFrame(({ clock }, delta) => {
    const dt = Math.min(delta, .1)
    const now = Date.now()
    const controller = controllerRef.current
    if (!controller) return
    const expressions = instance.vrm.expressionManager
    if (voicePhase.current === 'talking' && voiceSession?.phase !== 'talking' && expressions) {
      for (const name of instance.voiceClips.expressionNames) expressions.setValue(name, 0)
    }
    voicePhase.current = voiceSession?.phase ?? null
    const working = options.taskMode && options.taskMode !== 'idle'
    const voiceBusy = options.state === 'listening' || options.state === 'speaking' || options.state === 'thinking'
    const flight = working || voiceBusy || faceForward ? null : options.flight ?? null
    const pose = flightPose(options.reduced ? null : flight, Date.now())
    if (flightRig.current) {
      const rig = flightRig.current
      rig.rotation.order = 'ZXY'
      rig.rotation.x = MathUtils.damp(rig.rotation.x, pose.pitch, 10, dt)
      rig.rotation.y = MathUtils.damp(rig.rotation.y, pose.yaw, 10, dt)
      rig.rotation.z = MathUtils.damp(rig.rotation.z, pose.lean, 10, dt)
    }
    if (body.current) {
      const bob = options.reduced || !options.hover ? 0 : Math.sin(clock.elapsedTime * 1.6) * .035 * options.intensity
      body.current.position.y = MathUtils.damp(body.current.position.y, bob, 5, dt)
    }
    if (voiceSession) controller.synchronizeVoice(voiceSession, now)
    else if (session) controller.synchronize(session, now)
    else controller.update(dt) // Initial Idle while the validated catalog reaches main.

    if (!expressions) { instance.vrm.update(dt); return }
    const animatedVoiceExpressions = new Set<string>()
    const voiceExpressionNamesFor = (phase: VroidVoiceSession['phase']) => {
      const action = phase === 'thinking' ? 'thinking' : 'idle'
      return phase === 'talking' ? controller.voiceExpressionNames : instance.animationExpressionNames?.[action] ?? []
    }
    const addVoiceExpressions = (phase: VroidVoiceSession['phase']) => voiceExpressionNamesFor(phase).forEach(name => animatedVoiceExpressions.add(name))
    if (voiceSession) {
      addVoiceExpressions(voiceSession.phase)
      const transitionProgress = voiceSession.fadeMs > 0 ? Math.max(0, Math.min(1, (now - voiceSession.startedAt) / voiceSession.fadeMs)) : 1
      if (transitionProgress < 1 && voiceSession.previous) addVoiceExpressions(voiceSession.previous.phase)
      else if (transitionProgress < 1 && voiceSession.previousAction) {
        for (const name of instance.animationExpressionNames?.[voiceSession.previousAction.action] ?? []) animatedVoiceExpressions.add(name)
      }
    } else if (session?.previousVoice && now < session.startedAt + session.fadeMs) addVoiceExpressions(session.previousVoice.phase)
    const previousVoicePhase = voiceSession?.previous?.phase
    const talkLayerFinished = voiceSession && previousVoicePhase !== undefined && voiceSession.phase !== previousVoicePhase
      && now >= voiceSession.startedAt + voiceSession.fadeMs && expressionResetSequence.current !== voiceSession.sequence
    const previousExitPhase = session?.previousVoice?.phase
    const voiceExitFinished = !voiceSession && session && previousExitPhase !== undefined
      && now >= session.startedAt + session.fadeMs && expressionResetSequence.current !== session.sequence
    if (talkLayerFinished || voiceExitFinished) {
      const finishedPhase = talkLayerFinished ? voiceSession?.previous?.phase : session?.previousVoice?.phase
      for (const name of finishedPhase ? voiceExpressionNamesFor(finishedPhase) : []) if (!animatedVoiceExpressions.has(name)) expressions.setValue(name, 0)
      expressionResetSequence.current = voiceSession?.sequence ?? session?.sequence ?? null
    }
    const t = clock.elapsedTime
    if (t > nextBlink.current + .15) nextBlink.current = t + 2.5 + Math.random() * 3
    const blink = t >= nextBlink.current && t < nextBlink.current + .15 ? Math.sin((t - nextBlink.current) / .15 * Math.PI) : 0
    const emotion = controller.activeName === 'angry' ? 'angry'
      : controller.activeName === 'surprised' ? 'surprised'
        : options.taskMode === 'failed' || options.state === 'error' || controller.activeName === 'sad' ? 'sad'
          : options.taskMode === 'completed' || options.state === 'happy' || options.state === 'speaking' || controller.activeName === 'blush' ? 'happy'
            : options.state === 'thinking' || options.state === 'listening' || working ? 'relaxed' : null
    for (const name of ['happy', 'sad', 'angry', 'surprised', 'relaxed'] as const) {
      if (!animatedVoiceExpressions.has(name) && expressions.getExpression(name)) expressions.setValue(name, name === emotion ? options.state === 'speaking' || options.state === 'listening' ? .2 : .65 : 0)
    }
    if (!animatedVoiceExpressions.has('blink') && expressions.getExpression('blink')) expressions.setValue('blink', options.state === 'sleeping' ? .8 : blink)
    if (expressions.getExpression('aa')) expressions.setValue('aa', options.state === 'speaking' ? voiceAmplitude() * .85 : 0)
    instance.vrm.update(dt)
  })

  return <group name="athena-vroid" ref={flightRig}>
    <group ref={actionRig}>
      <group ref={body}>
        <primitive object={instance.vrm.scene} position={[instance.fit.offsetX ?? 0, instance.fit.offsetY, 0]} scale={instance.fit.scale} dispose={null} />
      </group>
      {screen && !suppressTaskScreen && <TaskWorkScreen mode={screen.mode} title={screen.title} label={screen.label} detailed={screen.detailed} reduced={options.reduced} intensity={options.intensity} screenY={screen.screenY} />}
    </group>
  </group>
}
