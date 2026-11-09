import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { RoundedBox } from '@react-three/drei'
import { Group, Mesh, MathUtils, MeshStandardMaterial, MeshBasicMaterial, Quaternion, Vector3, Euler } from 'three'
import { animateAthena, taskGesture, type AnimationOptions } from './AthenaAnimations'
import { flightPose } from '../../shared/flight'
import { idleActionPose } from './AthenaIdleActions'
import { mouthOpenForAmplitude, voiceAmplitude } from './voiceAmplitude'
import { TaskWorkScreen } from './TaskWorkScreen'
import { ARM, consolePoint, workingGaze, workingInteraction, WorkingArmSolver } from './taskWorkingPose'
import { useWorkingFrame } from './TaskWorkingMode'
import type { TaskVisualMode } from '../../shared/contracts'
import type { Settings } from '../../shared/settings'
import { EnhancedEnergy, EnhancedHead, EnhancedLeg, EnhancedLowerArm, EnhancedSurface, EnhancedTorso, EnhancedUpperArm } from './EnhancedAthena'
import { ENHANCED_EYE_HEIGHT, ENHANCED_EYE_SPACING } from './enhancedHelmetGeometry'

const pearl = '#e1eef5'
const navy = '#101d33'
const cyan = '#39dbff'

function Joint({ position, scale = 1 }: { position: [number, number, number]; scale?: number }) {
  return <mesh position={position} scale={scale}><sphereGeometry args={[0.095, 16, 12]} /><meshStandardMaterial color={navy} metalness={0.7} roughness={0.3} /></mesh>
}
function Eye({ x, glow, eyeRef }: { x: number; glow: number; eyeRef?: React.RefObject<Mesh | null> }) {
  return <mesh ref={eyeRef} position={[x, 0.055, 0.398]} rotation={[0, 0, x < 0 ? -0.08 : 0.08]}>
    <capsuleGeometry args={[0.038, 0.055, 6, 12]} /><meshStandardMaterial color="#aaf4ff" emissive={cyan} emissiveIntensity={2.5 * glow} toneMapped={false} />
  </mesh>
}
export function AthenaModel({ glow, taskScreen, suppressTaskScreen = false, variant = 'classic', energyFX = true, faceForward = false, ...options }: AnimationOptions & { glow: number; variant?: Settings['avatarVariant']; energyFX?: boolean; faceForward?: boolean; taskScreen?: { title: string; label: string; detailed: boolean; screenY: number }; suppressTaskScreen?: boolean }) {
  const enhanced = variant === 'enhanced'
  const restArmScale = enhanced ? .87 : ARM.restScale
  const eyeSpacing = enhanced ? ENHANCED_EYE_SPACING : .18
  const eyeHeight = enhanced ? ENHANCED_EYE_HEIGHT : .055
  const body = useRef<Group>(null)
  const head = useRef<Group>(null)
  const leftEye = useRef<Mesh>(null)
  const rightEye = useRef<Mesh>(null)
  const mouth = useRef<Mesh>(null)
  const arm = useRef<Group>(null)
  const otherArm = useRef<Group>(null)
  const elbows = useRef<Array<Group | null>>([])
  const working = useWorkingFrame()
  // Keep the one console and its light mounted after the first task. Removing
  // lights at the fade boundary recompiles every lit character material.
  const retainedScreen = useRef<(NonNullable<typeof taskScreen> & { mode: TaskVisualMode }) | null>(null)
  if (taskScreen) retainedScreen.current = { ...taskScreen, mode: options.taskMode ?? 'idle' }
  const screen = retainedScreen.current
  const work = useMemo(() => ({ solver: new WorkingArmSolver(), target: new Vector3(), shoulder: new Vector3(), rest: new Quaternion(), lower: new Quaternion(), euler: new Euler() }), [])
  // This outer group owns flight rotation and contains every visible model part.
  // Idle/head animation writes only to nested groups, so it cannot replace this pose.
  const flightRig = useRef<Group>(null)
  const actionRig = useRef<Group>(null)
  const legs = useRef<Array<Group | null>>([])
  const core = useRef<MeshStandardMaterial>(null)
  const thrusters = useRef<Array<MeshBasicMaterial | null>>([])
  useFrame(({ clock }, delta) => {
    if (!body.current || !head.current) return
    const t = clock.elapsedTime
    const voiceActive = options.state === 'listening' || options.state === 'speaking' || options.state === 'thinking'
    const taskMode = options.taskMode ?? 'idle'
    const taskActive = taskMode !== 'idle'
    const flight = voiceActive || taskActive ? null : options.flight
    const tracksConsole = Boolean(taskScreen && working.current.blend > .005 && options.state !== 'listening')
    animateAthena(body.current, head.current, t, Math.min(delta, 0.1), { ...options, consoleHeadTracking: tracksConsole })
    // Showcase-only presentation: keep both faces square to the front view.
    // Hover, blinking and waving remain active; floating/task rigs are unchanged.
    if (faceForward) { body.current.rotation.set(0, 0, 0); head.current.rotation.set(0, 0, 0) }
    const pose = flightPose(options.reduced ? null : flight ?? null, Date.now())
    const action = !options.reduced && !flight && !voiceActive && !taskActive ? options.idleAction : null
    const actionPose = idleActionPose(action, Date.now())
    if (actionRig.current) {
      for (const axis of ['x', 'y', 'z'] as const) actionRig.current.rotation[axis] = action ? actionPose[axis] : MathUtils.damp(actionRig.current.rotation[axis], 0, 10, Math.min(delta, .1))
      actionRig.current.position.y = MathUtils.damp(actionRig.current.position.y, actionPose.lift, 10, Math.min(delta, .1))
      actionRig.current.scale.setScalar(MathUtils.damp(actionRig.current.scale.x, actionPose.scale, 10, Math.min(delta, .1)))
    }
    for (const leg of legs.current) if (leg) leg.rotation.x = actionPose.legs
    if (action) { head.current.rotation.set(actionPose.headPitch, actionPose.headYaw, 0) }
    else if (!options.taskMode || options.taskMode === 'idle' || options.state === 'listening') head.current.rotation.y = MathUtils.damp(head.current.rotation.y, options.state === 'listening' && !options.reduced ? Math.sin(t * 0.45) * 0.035 : 0, 7, Math.min(delta, 0.1))
    if (flightRig.current) {
      if (flight) flightRig.current.rotation.set(pose.pitch, pose.yaw, pose.lean, 'ZXY')
      else for (const axis of ['x', 'y', 'z'] as const) flightRig.current.rotation[axis] = MathUtils.damp(flightRig.current.rotation[axis], 0, 10, Math.min(delta, .1))
      flightRig.current.position.y = MathUtils.damp(flightRig.current.position.y, pose.lift, 10, Math.min(delta, .1))
      flightRig.current.scale.setScalar(MathUtils.damp(flightRig.current.scale.x, 1 - pose.wing / 2.55 * .08, 10, Math.min(delta, .1)))
    }
    const listeningEnergy = options.state === 'listening' ? 1 + (options.reduced ? 0 : Math.sin(t * 3) * 0.15) : 0
    const taskGlow = options.taskMode && options.taskMode !== 'idle' ? .22 + (options.reduced ? 0 : Math.sin(t * 2.2) * .07 * options.intensity) : 0
    if (core.current) core.current.emissiveIntensity = glow * ((enhanced ? 1.3 : 2) + pose.energy * 3 + listeningEnergy + taskGlow)
    for (const material of thrusters.current) if (material) material.opacity = Math.min(1, glow * 0.4 + pose.energy * 0.6)
    const blink = options.state === 'sleeping' ? 0.15 : t % 5.8 > 5.62 ? 0.12 : 1
    if (mouth.current) {
      if (enhanced) mouth.current.visible = options.state === 'speaking'
      const open = mouthOpenForAmplitude(voiceAmplitude(), options.state === 'speaking')
      mouth.current.scale.y = MathUtils.damp(mouth.current.scale.y, 0.08 + open * 0.75, open ? 18 : 30, Math.min(delta, 0.1))
      mouth.current.scale.x = MathUtils.damp(mouth.current.scale.x, 0.85 + open * 0.2, 14, Math.min(delta, 0.1))
    }
    for (const eye of [leftEye.current, rightEye.current]) if (eye) {
      eye.scale.y = MathUtils.damp(eye.scale.y, blink, 35, Math.min(delta, 0.1))
      eye.position.y = MathUtils.damp(eye.position.y, eyeHeight - (options.state !== 'listening' && options.taskMode && options.taskMode !== 'idle' && options.taskMode !== 'completed' ? .043 : 0), 6, Math.min(delta, .1))
      ;(eye.material as MeshStandardMaterial).emissiveIntensity = glow * ((enhanced ? 1.1 : 2.5) + listeningEnergy)
    }
    const workBlend = working.current.blend
    if (taskScreen && workBlend > .005 && options.state !== 'listening') {
      const gaze = workingGaze(taskMode, t, options.intensity, options.reduced)
      consolePoint(gaze, taskScreen.screenY, work.target)
      const pitch = MathUtils.clamp(Math.atan2(.6 - work.target.y, work.target.z), -.48, .55)
      const yaw = MathUtils.clamp(Math.atan2(work.target.x, work.target.z), -.7, .7)
      const nod = taskMode === 'completed' && !options.reduced ? Math.sin(Math.min(1, working.current.elapsed / .65) * Math.PI) * .12 : 0
      head.current.rotation.x = MathUtils.damp(head.current.rotation.x, (pitch + nod) * workBlend, 9, Math.min(delta, .1))
      head.current.rotation.y = MathUtils.damp(head.current.rotation.y, yaw * workBlend, 6, Math.min(delta, .1))
      for (const [eye, side] of [[leftEye.current, -1], [rightEye.current, 1]] as const) if (eye) {
        eye.position.x = MathUtils.damp(eye.position.x, side * eyeSpacing + (gaze.u - .5) * .055 * workBlend, 8, Math.min(delta, .1))
        eye.position.y = MathUtils.damp(eye.position.y, eyeHeight - .015 + (gaze.v - .5) * .045 * workBlend, 8, Math.min(delta, .1))
      }
      for (const side of [-1, 1]) {
        const shoulder = side === 1 ? arm.current : otherArm.current
        const elbow = elbows.current[side === 1 ? 1 : 0]
        if (!shoulder || !elbow) continue
        const touch = workingInteraction(taskMode, taskScreen.title, t, options.intensity, options.reduced, taskScreen.screenY, side)
        consolePoint(touch, taskScreen.screenY, work.target)
        // Clear lift-off between presses; the fingertip meets the actual
        // curved surface at contact instead of hovering in a tiny loop.
        work.target.z -= .09 * (1 - touch.contact)
        work.solver.solve(work.shoulder.set(side * .29, .02, 0), work.target, side)
        work.rest.setFromEuler(work.euler.set(0, 0, side * .2)).slerp(work.solver.upper, workBlend)
        work.lower.identity().slerp(work.solver.lower, workBlend)
        shoulder.quaternion.slerp(work.rest, 1 - Math.exp(-18 * Math.min(delta, .1)))
        elbow.quaternion.slerp(work.lower, 1 - Math.exp(-18 * Math.min(delta, .1)))
        shoulder.scale.y = restArmScale + workBlend * (1 - restArmScale)
      }
      return
    }
    for (const elbow of elbows.current) if (elbow) elbow.quaternion.slerp(work.lower.identity(), 1 - Math.exp(-8 * Math.min(delta, .1)))
    for (const shoulder of [arm.current, otherArm.current]) if (shoulder) {
      shoulder.scale.y = MathUtils.damp(shoulder.scale.y, restArmScale, 8, Math.min(delta, .1))
      shoulder.rotation.y = MathUtils.damp(shoulder.rotation.y, 0, 8, Math.min(delta, .1))
    }
    if (leftEye.current) leftEye.current.position.x = MathUtils.damp(leftEye.current.position.x, -eyeSpacing, 8, Math.min(delta, .1))
    if (rightEye.current) rightEye.current.position.x = MathUtils.damp(rightEye.current.position.x, eyeSpacing, 8, Math.min(delta, .1))
    if (taskMode !== 'idle' && !taskScreen && options.state !== 'listening') {
      const gesture = taskGesture(taskMode, options.taskFocus ?? { x: 0, y: 0 }, t, options.intensity, options.reduced)
      if (arm.current) {
        arm.current.rotation.z = MathUtils.damp(arm.current.rotation.z, gesture.rightZ, 6, Math.min(delta, .1))
        arm.current.rotation.x = MathUtils.damp(arm.current.rotation.x, gesture.rightX, 6, Math.min(delta, .1))
      }
      if (otherArm.current) {
        otherArm.current.rotation.z = MathUtils.damp(otherArm.current.rotation.z, gesture.leftZ, 6, Math.min(delta, .1))
        otherArm.current.rotation.x = MathUtils.damp(otherArm.current.rotation.x, gesture.leftX, 6, Math.min(delta, .1))
      }
      return
    }
    if (arm.current) arm.current.rotation.x = MathUtils.damp(arm.current.rotation.x, 0, 6, Math.min(delta, .1))
    if (otherArm.current) otherArm.current.rotation.x = MathUtils.damp(otherArm.current.rotation.x, 0, 6, Math.min(delta, .1))
    if (arm.current) arm.current.rotation.z = flight ? 0.2 + pose.wing : action ? actionPose.arm : MathUtils.damp(arm.current.rotation.z, options.state === 'happy' ? 1.5 + Math.sin(t * 12) * 0.15 : options.state === 'speaking' ? 0.24 + Math.sin(t * 1.8) * 0.055 : 0.2, 6, Math.min(delta, 0.1))
    if (otherArm.current) otherArm.current.rotation.z = flight ? -0.2 - pose.wing : action ? actionPose.otherArm : MathUtils.damp(otherArm.current.rotation.z, options.state === 'speaking' ? -0.24 + Math.sin(t * 1.45) * 0.045 : -0.2, 6, Math.min(delta, 0.1))
  })
  return <EnhancedSurface enabled={enhanced}><group name={`athena-${variant}`} scale={enhanced ? .9 : 1}><group ref={flightRig}><group ref={actionRig}><group ref={body}>
    <group ref={head} name="athena-head" position={[0, 0.6, 0]}>
      {enhanced ? <EnhancedHead glow={glow} leftEye={leftEye} rightEye={rightEye} mouth={mouth} /> : <>
      <RoundedBox args={[0.99, 0.82, 0.72]} radius={0.26} smoothness={5}>
        <meshStandardMaterial color={pearl} metalness={0.28} roughness={0.24} />
      </RoundedBox>
      <RoundedBox args={[0.83, 0.53, 0.14]} radius={0.19} smoothness={5} position={[0, 0.01, 0.32]}>
        <meshStandardMaterial color="#071625" metalness={0.5} roughness={0.17} />
      </RoundedBox>
      <Eye x={-0.18} glow={glow} eyeRef={leftEye} /><Eye x={0.18} glow={glow} eyeRef={rightEye} />
      <mesh ref={mouth} position={[0, -0.135, 0.411]} scale={[0.85, 0.08, 1]}><circleGeometry args={[0.052, 24]} /><meshBasicMaterial color="#001019" /></mesh>
      <mesh position={[0, -0.12, 0.4]} rotation={[0, 0, Math.PI]}><torusGeometry args={[0.052, 0.008, 8, 24, Math.PI]} /><meshBasicMaterial color={cyan} /></mesh>
      {[-1, 1].map((side) => <group key={side} position={[side * 0.51, 0.03, 0]} rotation={[0, 0, side * 0.06]}>
        <mesh rotation={[0, 0, Math.PI / 2]}><cylinderGeometry args={[0.18, 0.18, 0.12, 32]} /><meshStandardMaterial color={navy} metalness={0.6} roughness={0.3} /></mesh>
        <mesh position={[side * 0.07, 0, 0]} rotation={[0, Math.PI / 2, 0]}><torusGeometry args={[0.125, 0.02, 10, 32]} /><meshStandardMaterial color={cyan} emissive={cyan} emissiveIntensity={glow * 1.7} toneMapped={false} /></mesh>
        <RoundedBox args={[0.12, 0.49, 0.29]} radius={0.05} position={[side * 0.025, -0.22, -0.07]} rotation={[0, 0, side * 0.17]}><meshStandardMaterial color={pearl} metalness={0.3} roughness={0.3} /></RoundedBox>
      </group>)}
      <mesh position={[0, 0.428, 0.04]} rotation={[Math.PI / 2, 0, 0]}><torusGeometry args={[0.43, 0.012, 8, 60, Math.PI * 1.65]} /><meshStandardMaterial color={cyan} emissive={cyan} emissiveIntensity={glow * 1.5} transparent opacity={0.8} /></mesh>
      <mesh position={[0, 0.31, 0.326]} rotation={[0, 0, Math.PI / 4]}><boxGeometry args={[0.065, 0.065, 0.018]} /><meshStandardMaterial color={cyan} emissive={cyan} emissiveIntensity={glow * 2} /></mesh>
      </>}
    </group>
    {enhanced ? <EnhancedTorso glow={glow} core={core} /> : <>
    <Joint position={[0, 0.12, 0]} />
    <mesh position={[0, -0.14, 0]}><capsuleGeometry args={[0.23, 0.28, 8, 24]} /><meshStandardMaterial color={pearl} metalness={0.35} roughness={0.25} /></mesh>
    <RoundedBox args={[0.3, 0.25, 0.08]} radius={0.07} position={[0, -0.07, 0.207]}><meshStandardMaterial color={navy} metalness={0.6} roughness={0.3} /></RoundedBox>
    <mesh position={[0, -0.055, 0.256]} rotation={[0, 0, Math.PI / 4]}><boxGeometry args={[0.095, 0.095, 0.02]} /><meshStandardMaterial ref={core} color="#adf6ff" emissive={cyan} emissiveIntensity={glow * 2} toneMapped={false} /></mesh>
    <mesh position={[0, -0.33, 0]} rotation={[Math.PI / 2, 0, 0]}><torusGeometry args={[0.205, 0.018, 8, 32]} /><meshStandardMaterial color={cyan} emissive={cyan} emissiveIntensity={glow} /></mesh>
    </>}
    {screen && !suppressTaskScreen && <TaskWorkScreen mode={screen.mode} title={screen.title} label={screen.label} detailed={screen.detailed} reduced={options.reduced} intensity={options.intensity} screenY={screen.screenY} />}
    {[-1, 1].map((side) => <group key={side} name={side === 1 ? 'athena-arm-right' : 'athena-arm-left'} position={[side * 0.29, 0.02, 0]} rotation={[0, 0, side * 0.2]} ref={side === 1 ? arm : otherArm}>
      {enhanced ? <EnhancedUpperArm side={side} glow={glow} /> : <>
      <Joint position={[0, 0, 0]} />
      <mesh position={[0, -ARM.upper / 2, 0]}><capsuleGeometry args={[0.081, ARM.upper - .13, 6, 16]} /><meshStandardMaterial color={pearl} metalness={0.3} roughness={0.25} /></mesh>
      </>}
      <group ref={(value) => { elbows.current[side === 1 ? 1 : 0] = value }} position={[0, -ARM.upper, 0]}>
        {enhanced ? <EnhancedLowerArm side={side} glow={glow} energy={energyFX} /> : <>
        <Joint position={[0, 0, 0]} scale={.7} />
        <mesh position={[0, -(ARM.lower - .11) / 2, 0]}><capsuleGeometry args={[.073, ARM.lower - .22, 6, 16]} /><meshStandardMaterial color={pearl} metalness={.3} roughness={.25} /></mesh>
        <mesh position={[0, -(ARM.lower - .082), 0]}><sphereGeometry args={[.079, 16, 12]} /><meshStandardMaterial color={navy} metalness={.5} roughness={.25} /></mesh>
        <mesh position={[0, -(ARM.lower - .026), 0]}><capsuleGeometry args={[.021, .024, 4, 8]} /><meshStandardMaterial color={navy} metalness={.5} roughness={.25} /></mesh>
        </>}
      </group>
    </group>)}
    {[-1, 1].map((side) => <group key={side} ref={(group) => { legs.current[side === -1 ? 0 : 1] = group }} position={[side * (enhanced ? .158 : .13), -0.43, 0]} rotation={[0.13, 0, side * 0.06]}>
      {enhanced ? <EnhancedLeg glow={glow} /> : <>
      <Joint position={[0, 0, 0]} scale={0.85} />
      <mesh position={[0, -0.16, 0]}><capsuleGeometry args={[0.092, 0.16, 6, 16]} /><meshStandardMaterial color={pearl} metalness={0.3} roughness={0.28} /></mesh>
      <RoundedBox args={[0.18, 0.13, 0.27]} radius={0.05} position={[0, -0.32, 0.04]}><meshStandardMaterial color={navy} metalness={0.5} roughness={0.3} /></RoundedBox>
      </>}
      <mesh position={[0, enhanced ? -.605 : -.397, 0.04]} rotation={[Math.PI / 2, 0, 0]}><circleGeometry args={[0.055, 20]} /><meshBasicMaterial ref={(material) => { thrusters.current[side === -1 ? 0 : 1] = material }} color={cyan} transparent opacity={glow * 0.4} /></mesh>
    </group>)}
    {enhanced && energyFX && <EnhancedEnergy reduced={options.reduced} intensity={Math.min(1, glow)} />}
  </group></group></group></group></EnhancedSurface>
}
