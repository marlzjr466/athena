import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { Group, Mesh, MeshBasicMaterial } from 'three'
import { flightDirection, flightPose, type Flight } from '../../shared/flight'

export function AthenaEffects({ intensity, reduced, working, flight }: { intensity: number; reduced: boolean; working: boolean; flight: Flight | null }) {
  const orbit = useRef<Group>(null)
  const trail = useRef<Group>(null)
  const ring = useRef<MeshBasicMaterial>(null)
  const particles = useMemo(() => Array.from({ length: 22 }, (_, i) => ({
    position: [Math.sin(i * 2.4) * (0.66 + (i % 4) * 0.1), -0.65 + ((i * 0.137) % 1.9), Math.cos(i * 2.4) * 0.55] as [number, number, number],
    size: 0.009 + (i % 3) * 0.004,
  })), [])
  useFrame(({ clock }, delta) => {
    const pose = flightPose(reduced ? null : flight, Date.now())
    const direction = flight ? flightDirection(flight, Date.now()) : { x: 0, y: 0 }
    if (orbit.current && !reduced) orbit.current.rotation.y += Math.min(delta, 0.1) * (working ? 0.65 : 0.09 + pose.energy)
    if (ring.current) ring.current.opacity = 0.4 + pose.energy * 0.35
    if (trail.current) {
      trail.current.visible = Boolean(flight) && !reduced && intensity > 0
      trail.current.children.forEach((child, i) => {
        const mesh = child as Mesh<never, MeshBasicMaterial>
        const age = (clock.elapsedTime * 2.5 + i / 10) % 1
        const distance = 0.2 + age * 0.7
        mesh.position.set(-direction.x * distance + Math.sin(i * 7) * 0.08, direction.y * distance, -0.1)
        mesh.scale.setScalar(0.65 + age * 0.5)
        mesh.material.opacity = (1 - age) * pose.energy * intensity * 0.6
      })
    }
  })
  return <group>
    <group position={[0, -0.98, 0]} rotation={[-Math.PI / 2, 0, 0]}>
      <mesh><ringGeometry args={[0.38, 0.39, 64]} /><meshBasicMaterial ref={ring} color="#49cfff" transparent opacity={0.4} side={2} /></mesh>
      <mesh><ringGeometry args={[0.48, 0.484, 64]} /><meshBasicMaterial color="#49cfff" transparent opacity={0.18} side={2} /></mesh>
      <mesh><circleGeometry args={[0.28, 48]} /><meshBasicMaterial color="#168bcc" transparent opacity={0.055} side={2} /></mesh>
    </group>
    <group ref={orbit}>
      {particles.slice(0, Math.round(particles.length * intensity)).map((particle, i) => <mesh key={i} position={particle.position}>
        <sphereGeometry args={[particle.size, 6, 6]} /><meshBasicMaterial color="#72dfff" transparent opacity={0.3 + (i % 3) * 0.2} />
      </mesh>)}
    </group>
    <group ref={trail} visible={false}>{Array.from({ length: 10 }, (_, i) => <mesh key={i}><sphereGeometry args={[0.022, 6, 6]} /><meshBasicMaterial color="#72dfff" transparent opacity={0} depthWrite={false} /></mesh>)}</group>
  </group>
}
