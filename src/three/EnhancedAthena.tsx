import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode, type RefObject } from 'react'
import { useFrame } from '@react-three/fiber'
import { RoundedBox } from '@react-three/drei'
import { CanvasTexture, CatmullRomCurve3, EquirectangularReflectionMapping, Group, Mesh, MeshStandardMaterial, SplineCurve, SRGBColorSpace, Vector2, Vector3 } from 'three'
import { ARM } from './taskWorkingPose'
import { createVisorGeometry, ENHANCED_EYE_HEIGHT, ENHANCED_EYE_SPACING, HELMET, helmetSurfaceZ } from './enhancedHelmetGeometry'

const cyan = '#20bdf7'
const FinishContext = createContext<CanvasTexture | null>(null)

/** Small local studio reflection map: no network asset or continual capture. */
export function EnhancedSurface({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  const texture = useMemo(() => {
    if (!enabled) return null
    const canvas = document.createElement('canvas'); canvas.width = 256; canvas.height = 128
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    const ambient = ctx.createLinearGradient(0, 0, 0, 128)
    ambient.addColorStop(0, '#b8c8ec'); ambient.addColorStop(.48, '#182b45'); ambient.addColorStop(1, '#03101e')
    ctx.fillStyle = ambient; ctx.fillRect(0, 0, 256, 128)
    ctx.fillStyle = '#f0f8ff'; ctx.fillRect(28, 20, 48, 24); ctx.fillRect(152, 18, 24, 35)
    ctx.fillStyle = '#26bdf5'; ctx.fillRect(4, 40, 5, 58); ctx.fillRect(204, 28, 4, 45)
    const result = new CanvasTexture(canvas); result.mapping = EquirectangularReflectionMapping; result.colorSpace = SRGBColorSpace
    return result
  }, [enabled])
  useEffect(() => () => texture?.dispose(), [texture])
  return <FinishContext.Provider value={texture}>{children}</FinishContext.Provider>
}
function Shell() {
  const envMap = useContext(FinishContext)
  return <meshPhysicalMaterial color="#e9edf8" metalness={.22} roughness={.22} clearcoat={1} clearcoatRoughness={.12} envMap={envMap} envMapIntensity={.65} />
}
function Obsidian() {
  const envMap = useContext(FinishContext)
  return <meshPhysicalMaterial color="#030911" metalness={.48} roughness={.17} clearcoat={1} envMap={envMap} envMapIntensity={.55} />
}
function Alloy() {
  return <meshStandardMaterial color="#8493a7" metalness={.88} roughness={.27} />
}
// Profiled hollow armor, with a rolled lip and a visible dark joint beneath.
// These are tapered shells, not stretched spheres or rectangular limb blocks.
const forearmProfile = new SplineCurve([[.075, -.252], [.095, -.252], [.108, -.225], [.114, -.17], [.108, -.105], [.091, -.05], [.07, -.03], [.055, -.04], [.06, -.10], [.075, -.252]].map(([r, y]) => new Vector2(r, y))).getPoints(48)
const shinProfile = new SplineCurve([[.105, -.48], [.137, -.48], [.14, -.45], [.127, -.37], [.102, -.25], [.088, -.218], [.072, -.224], [.074, -.28], [.105, -.48]].map(([r, y]) => new Vector2(r, y))).getPoints(48)
function LightRing({ radius, glow, thickness = .009 }: { radius: number; glow: number; thickness?: number }) {
  return <mesh><torusGeometry args={[radius, thickness, 10, 48]} /><meshStandardMaterial color="#7ce8ff" emissive={cyan} emissiveIntensity={glow * 1.1} toneMapped={false} /></mesh>
}
function CurvedVisor({ width, height, lift, name, children }: { width: number; height: number; lift: number; name?: string; children: ReactNode }) {
  const geometry = useMemo(() => createVisorGeometry(width, height, lift), [width, height, lift])
  useEffect(() => () => geometry.dispose(), [geometry])
  return <mesh name={name}><primitive object={geometry} attach="geometry" />{children}</mesh>
}

/** Mesh root deliberately retains the existing gaze/blink animation contract.
 * Glass, reflection dots and the illuminated iris all blink together. */
function LensEye({ side, glow, eyeRef }: { side: number; glow: number; eyeRef: RefObject<Mesh | null> }) {
  const x = side * ENHANCED_EYE_SPACING
  return <mesh name="enhanced-round-eye" ref={eyeRef} position={[x, ENHANCED_EYE_HEIGHT, helmetSurfaceZ(x, ENHANCED_EYE_HEIGHT) + .034]} rotation={[.055, side * .28, 0]}>
    <torusGeometry args={[.135, .012, 12, 48]} />
    <meshStandardMaterial color="#5bd8ee" emissive={cyan} emissiveIntensity={glow * 1.1} toneMapped={false} />
    <mesh position={[0, 0, -.012]} scale={[1, 1, .25]}><sphereGeometry args={[.126, 32, 24]} /><Obsidian /></mesh>
    <mesh position={[0, 0, -.008]}><torusGeometry args={[.151, .006, 8, 48]} /><meshStandardMaterial color="#183b4d" metalness={.65} roughness={.23} /></mesh>
    <mesh position={[0, -.012, .013]} rotation={[0, 0, Math.PI * 1.12]}><torusGeometry args={[.10, .005, 8, 32, Math.PI * .76]} /><meshBasicMaterial color="#275879" /></mesh>
    {[[-.033, .057, .016], [-.011, .039, .01], [.013, .018, .006]].map(([dx, dy, radius], index) => <mesh key={index} position={[dx, dy, .024]} scale={[.8, 1, .45]}>
      <sphereGeometry args={[radius, 12, 10]} /><meshBasicMaterial color={index ? '#5bc8e6' : '#e6fbff'} toneMapped={false} />
    </mesh>)}
  </mesh>
}

export function EnhancedHead({ glow, leftEye, rightEye, mouth }: { glow: number; leftEye: RefObject<Mesh | null>; rightEye: RefObject<Mesh | null>; mouth: RefObject<Mesh | null> }) {
  const crown = useMemo(() => new CatmullRomCurve3(Array.from({ length: 33 }, (_, i) => {
    const x = -.28 + i / 32 * .56
    const y = .415 + .075 * (Math.abs(x) / .28) ** 5
    return new Vector3(x, y, helmetSurfaceZ(x, y) + .004)
  })), [])
  return <group name="enhanced-head-shell">
    <mesh name="enhanced-domed-helmet" scale={[HELMET.width, HELMET.height, HELMET.depth]}>
      <sphereGeometry args={[1, 64, 48]} /><Shell />
    </mesh>
    {/* The visor wraps around the spherical cheeks; it has no flat box cap. */}
    <CurvedVisor width={.577} height={.341} lift={.004} name="enhanced-visor-rim"><meshStandardMaterial color="#c6d1e1" metalness={.4} roughness={.28} /></CurvedVisor>
    <CurvedVisor width={.557} height={.322} lift={.009}><meshStandardMaterial color="#344152" metalness={.5} roughness={.24} /></CurvedVisor>
    <CurvedVisor width={.537} height={.302} lift={.014} name="enhanced-visor"><Obsidian /></CurvedVisor>
    <mesh name="enhanced-crown-seam"><tubeGeometry args={[crown, 48, .007, 8, false]} /><meshStandardMaterial color="#316a7c" metalness={.6} roughness={.24} /></mesh>
    <mesh><tubeGeometry args={[crown, 48, .0035, 8, false]} /><meshStandardMaterial color="#63e4ef" emissive={cyan} emissiveIntensity={glow * .55} /></mesh>
    <LensEye side={-1} glow={glow} eyeRef={leftEye} /><LensEye side={1} glow={glow} eyeRef={rightEye} />
    {/* No permanent cartoon smile in this reference. Speech still has a subtle
        animated display aperture, made visible only while speaking by the rig. */}
    <mesh name="enhanced-speech-aperture" ref={mouth} visible={false} position={[0, -.19, helmetSurfaceZ(0, -.19) + .021]} scale={[.85, .08, 1]}><circleGeometry args={[.046, 24]} /><meshBasicMaterial color={cyan} /></mesh>
    {[-1, 1].map(side => <group name="enhanced-ear" key={side} position={[side * .612, .005, -.04]} rotation={[0, side * Math.PI / 2, 0]} scale={[.86, 1, 1]}>
      <mesh scale={[1, 1, .3]}><sphereGeometry args={[.285, 40, 28]} /><Shell /></mesh>
      <mesh position={[0, 0, .073]}><torusGeometry args={[.228, .016, 12, 48]} /><meshStandardMaterial color="#748b9e" metalness={.7} roughness={.25} /></mesh>
      <group position={[0, 0, .082]}><LightRing radius={.209} thickness={.012} glow={glow * .7} /></group>
      <mesh position={[0, 0, .083]} scale={[1, 1, .12]}><sphereGeometry args={[.188, 32, 24]} /><Shell /></mesh>
      <mesh position={[0, 0, .108]} scale={[1, 1, .2]}><sphereGeometry args={[.092, 24, 16]} /><meshStandardMaterial color="#8bd5df" metalness={.35} roughness={.25} /></mesh>
    </group>)}
  </group>
}

export function EnhancedTorso({ glow, core }: { glow: number; core: RefObject<MeshStandardMaterial | null> }) {
  return <group name="enhanced-torso">
    <mesh position={[0, .055, 0]}><cylinderGeometry args={[.125, .15, .12, 32]} /><Obsidian /></mesh>
    <mesh position={[0, -.12, 0]} scale={[1.12, 1.02, .79]}><sphereGeometry args={[.275, 40, 28]} /><Shell /></mesh>
    <mesh position={[0, -.33, -.01]} scale={[.75, 1.1, .68]}><sphereGeometry args={[.20, 32, 24]} /><Obsidian /></mesh>
    <mesh position={[0, -.30, .082]} scale={[.69, 1.04, .69]}><sphereGeometry args={[.20, 32, 24]} /><Shell /></mesh>
    <mesh position={[0, -.435, 0]} scale={[1.2, .6, .82]}><sphereGeometry args={[.18, 32, 24]} /><Shell /></mesh>
    <group name="enhanced-round-core" position={[0, -.055, .218]}>
      <mesh scale={[1, 1, .22]}><sphereGeometry args={[.078, 32, 24]} /><Obsidian /></mesh>
      <LightRing radius={.075} thickness={.006} glow={glow * .7} />
      <mesh position={[0, 0, .021]}><circleGeometry args={[.047, 32]} /><meshStandardMaterial ref={core} color="#4ad9ed" emissive={cyan} emissiveIntensity={glow} toneMapped={false} /></mesh>
      <mesh position={[0, 0, .023]}><circleGeometry args={[.017, 24]} /><Obsidian /></mesh>
    </group>
    <mesh position={[0, -.246, .191]} scale={[1, .35, .23]}><sphereGeometry args={[.073, 24, 16]} /><Obsidian /></mesh>
  </group>
}

function JointHub({ radius = .078 }: { radius?: number }) {
  return <group>
    <mesh rotation={[Math.PI / 2, 0, 0]}><cylinderGeometry args={[radius, radius, .065, 24]} /><Alloy /></mesh>
    <mesh position={[0, 0, .036]}><torusGeometry args={[radius * .72, .007, 8, 24]} /><Obsidian /></mesh>
    <mesh position={[0, 0, .04]}><circleGeometry args={[radius * .36, 20]} /><Alloy /></mesh>
  </group>
}

export function EnhancedUpperArm({ side, glow }: { side: number; glow: number }) {
  return <group name="enhanced-upper-arm">
    <mesh><sphereGeometry args={[.115, 24, 18]} /><Obsidian /></mesh>
    <group position={[side * .084, .015, 0]} rotation={[0, side * Math.PI / 2, side * -.22]}>
      <mesh scale={[1, 1, .33]}><sphereGeometry args={[.135, 28, 20]} /><Shell /></mesh>
      <group position={[0, 0, .042]}><LightRing radius={.09} glow={glow * .35} thickness={.004} /></group>
    </group>
    <mesh position={[0, -.18, 0]}><capsuleGeometry args={[.066, .15, 8, 20]} /><Obsidian /></mesh>
    <mesh position={[0, -.17, .062]}><cylinderGeometry args={[.018, .018, .17, 12]} /><Alloy /></mesh>
    <mesh position={[side * .046, -.18, -.017]}><cylinderGeometry args={[.012, .012, .14, 10]} /><Alloy /></mesh>
  </group>
}

/** Four jointed fingers plus an opposed thumb, white armor over dark mechanics. */
function MechanicalHand({ side, glow, energy }: { side: number; glow: number; energy: boolean }) {
  return <group name="enhanced-hand" position={[0, -(ARM.lower - .13), 0]}>
    <mesh scale={[1, 1.05, .65]}><sphereGeometry args={[.082, 24, 18]} /><Obsidian /></mesh>
    <mesh position={[0, .007, -.035]} scale={[1, 1, .3]}><sphereGeometry args={[.079, 24, 18]} /><Shell /></mesh>
    {[-1.5, -.5, .5, 1.5].map((finger, index) => <group name="enhanced-finger" key={finger} position={[finger * .036, -.042, .012]} rotation={[.2, 0, finger * .07]}>
      <mesh><sphereGeometry args={[.019, 12, 10]} /><Alloy /></mesh>
      <mesh position={[0, -.026, .004]}><capsuleGeometry args={[.017, .024, 5, 12]} /><Shell /></mesh>
      <group position={[0, -.051, .012]} rotation={[.27, 0, 0]}>
        <mesh><sphereGeometry args={[.016, 12, 10]} /><Alloy /></mesh>
        <mesh position={[0, -.024, .002]}><capsuleGeometry args={[.015, index === 0 || index === 3 ? .022 : .032, 5, 12]} /><Shell /></mesh>
        <mesh position={[0, -.042, .006]}><sphereGeometry args={[.014, 12, 10]} /><Obsidian /></mesh>
      </group>
    </group>)}
    <group name="enhanced-thumb" position={[-side * .073, -.002, .014]} rotation={[.25, 0, -side * .85]}>
      <mesh><sphereGeometry args={[.024, 14, 10]} /><Alloy /></mesh>
      <mesh position={[0, -.028, .007]}><capsuleGeometry args={[.021, .027, 5, 12]} /><Shell /></mesh>
      <mesh position={[0, -.055, .019]}><sphereGeometry args={[.019, 12, 10]} /><Alloy /></mesh>
      <mesh position={[0, -.074, .026]} rotation={[.35, 0, 0]}><capsuleGeometry args={[.018, .018, 5, 12]} /><Shell /></mesh>
    </group>
    {energy && <group position={[0, -.025, .084]}>
      <mesh><sphereGeometry args={[.014, 16, 12]} /><meshBasicMaterial color="#bbfaff" toneMapped={false} /></mesh>
      <LightRing radius={.045} glow={glow * .65} thickness={.002} />
    </group>}
  </group>
}

export function EnhancedLowerArm({ side, glow, energy }: { side: number; glow: number; energy: boolean }) {
  return <group name="enhanced-lower-arm">
    <mesh><sphereGeometry args={[.081, 24, 18]} /><Obsidian /></mesh>
    <group position={[0, 0, .051]}><JointHub radius={.053} /></group>
    <mesh name="enhanced-forearm-armor" scale={[1, 1, .89]}><latheGeometry args={[forearmProfile, 40]} /><Shell /></mesh>
    <mesh position={[0, -.26, 0]}><cylinderGeometry args={[.071, .071, .06, 24]} /><Obsidian /></mesh>
    <mesh position={[0, -.264, 0]} rotation={[Math.PI / 2, 0, 0]}><torusGeometry args={[.072, .009, 8, 32]} /><Alloy /></mesh>
    <MechanicalHand side={side} energy={energy} glow={glow} />
  </group>
}

export function EnhancedLeg({ glow }: { glow: number }) {
  return <group name="enhanced-leg">
    <mesh><sphereGeometry args={[.098, 24, 18]} /><Obsidian /></mesh>
    <mesh position={[0, -.12, 0]}><capsuleGeometry args={[.074, .12, 8, 20]} /><Obsidian /></mesh>
    <mesh position={[0, -.14, .074]}><cylinderGeometry args={[.019, .019, .13, 12]} /><Alloy /></mesh>
    <mesh position={[0, -.252, .005]}><sphereGeometry args={[.083, 24, 18]} /><Obsidian /></mesh>
    <mesh name="enhanced-shin-armor" position={[0, 0, .007]} scale={[1, 1, .92]}><latheGeometry args={[shinProfile, 40]} /><Shell /></mesh>
    <group position={[0, -.219, .083]} rotation={[-.25, 0, 0]}><LightRing radius={.046} glow={glow * .25} thickness={.003} /></group>
    <mesh position={[0, -.48, .025]}><sphereGeometry args={[.093, 24, 18]} /><Obsidian /></mesh>
    <RoundedBox name="enhanced-boot-sole" args={[.273, .024, .34]} radius={.01} smoothness={4} position={[0, -.59, .075]}><Obsidian /></RoundedBox>
    <mesh name="enhanced-toe-cap" position={[0, -.582, .075]} scale={[.139, .135, .18]}><sphereGeometry args={[1, 40, 24, 0, Math.PI * 2, 0, Math.PI / 2]} /><Shell /></mesh>
    <RoundedBox args={[.12, .035, .025]} radius={.012} smoothness={3} position={[0, -.559, .249]}><Obsidian /></RoundedBox>
    <mesh position={[0, -.479, .13]} rotation={[-.25, 0, 0]}><cylinderGeometry args={[.002, .002, .09, 6]} /><Alloy /></mesh>
  </group>
}

/** Optional surrounding effects, independent of the reference character shell. */
export function EnhancedEnergy({ reduced, intensity }: { reduced: boolean; intensity: number }) {
  const orbit = useRef<Group>(null)
  useFrame((_, delta) => { if (orbit.current && !reduced) orbit.current.rotation.y += Math.min(delta, .1) * .38 })
  return <group name="enhanced-energy" ref={orbit}>
    {[-1, 1].map(side => <group key={side} position={[0, side * .29, 0]} rotation={[Math.PI / 2 + side * .22, side * .3, 0]}>
      <mesh><torusGeometry args={[.9, .006, 6, 72, Math.PI * 1.65]} /><meshBasicMaterial color="#9defff" transparent opacity={.75 * intensity} toneMapped={false} depthWrite={false} /></mesh>
      <mesh><torusGeometry args={[.9, .021, 6, 72, Math.PI * 1.65]} /><meshBasicMaterial color={cyan} transparent opacity={.08 * intensity} toneMapped={false} depthWrite={false} /></mesh>
    </group>)}
    {!reduced && Array.from({ length: 12 }, (_, i) => <mesh key={i} position={[Math.cos(i * 2.4) * .88, -.65 + (i % 6) * .26, Math.sin(i * 2.4) * .68]}>
      <sphereGeometry args={[.012 + (i % 3) * .004, 6, 6]} /><meshBasicMaterial color="#a7f6ff" transparent opacity={intensity * .6} toneMapped={false} />
    </mesh>)}
    {[0, 1].map(i => <group key={i} position={[i ? -.73 : .73, .15, 0]} rotation={[0, 0, i ? .15 : -.15]}>
      {[0, 1, 2].map(j => <mesh key={j} position={[j % 2 ? .035 : 0, j * .07, 0]} rotation={[0, 0, j % 2 ? -.45 : .45]}><cylinderGeometry args={[.003, .003, .09, 5]} /><meshBasicMaterial color={cyan} transparent opacity={intensity * .45} /></mesh>)}
    </group>)}
  </group>
}
