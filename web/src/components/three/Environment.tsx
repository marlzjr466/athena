'use client';
import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Sparkles, Line } from '@react-three/drei';
import { Color, Group, MathUtils, PointLight } from 'three';
import { useExperience } from '@/features/scroll-experience/ExperienceProvider';

export function HolographicPanel({ position, rotation = 0 }: { position: [number, number, number]; rotation?: number }) {
  const { settings } = useExperience();
  return <group position={position} rotation={[0, rotation, 0]}>
    <mesh><planeGeometry args={[.68, .43]} /><meshBasicMaterial color="#0c3450" transparent opacity={.4} depthWrite={false} /></mesh>
    <Line points={[[-.34, -.215, 0], [-.34, .215, 0], [.34, .215, 0], [.34, -.215, 0], [-.34, -.215, 0]]} color={settings.color} transparent opacity={.45} />
    {[0, 1, 2, 3].map(i => <mesh key={i} position={[-.04, .12 - i * .08, .005]}><planeGeometry args={[i % 2 ? .32 : .5, .012]} /><meshBasicMaterial color={settings.color} transparent opacity={i === 0 ? .7 : .25} /></mesh>)}
  </group>;
}
export function Environment({ mobile }: { mobile: boolean }) {
  const { chapter, settings, reduced, progress } = useExperience();
  const rings = useRef<Group>(null);
  const panels = useRef<Group>(null);
  const glow = useRef<PointLight>(null);
  const target = useMemo(() => new Color(), []);
  const secondary = useMemo(() => new Color('#646bff'), []);
  const network = chapter === 'intelligence' || chapter === 'development' || chapter === 'academy' || chapter === 'capabilities';
  const nodes = useMemo(() => Array.from({ length: 12 }, (_, i) => [Math.sin(i * 2.4) * 1.4, .8 + (i % 5) * .4, -.8 - Math.cos(i * 2.4) * .5] as [number, number, number]), []);
  useFrame(({ clock }, delta) => {
    if (rings.current && !reduced) rings.current.rotation.z = clock.elapsedTime * .04;
    if (panels.current) { panels.current.position.y = reduced ? 0 : Math.sin(clock.elapsedTime * .7) * .035; panels.current.scale.setScalar(MathUtils.damp(panels.current.scale.x, chapter === 'home' || chapter === 'meet' ? .01 : 1, 3, delta)); }
    if (glow.current) glow.current.color.lerp(target.set(settings.color).lerp(secondary, Math.sin(progress.current.value) ** 2 * .35), .02);
  });
  return <>
    <ambientLight intensity={.45} />
    <directionalLight position={[2, 5, 4]} intensity={1.1} color="#ffffff" />
    <directionalLight position={[-3, 2, -1]} intensity={.22} color="#d6efff" />
    <pointLight ref={glow} position={[0, 1, 2]} intensity={.3} color={settings.color} distance={6} />
    <group position={[0, -.04, 0]}>
      <mesh><cylinderGeometry args={[1.28, 1.38, .12, mobile ? 48 : 96]} /><meshStandardMaterial color="#10263d" metalness={.85} roughness={.3} /></mesh>
      {[1.05, 1.27, 1.48].map((r, i) => <mesh key={r} rotation={[-Math.PI / 2, 0, 0]} position={[0, .066 - i * .018, 0]}><torusGeometry args={[r, i === 1 ? .012 : .005, 8, 96]} /><meshBasicMaterial color={settings.color} transparent opacity={i === 1 ? .85 : .3} /></mesh>)}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, .063, 0]}><circleGeometry args={[1.2, 64]} /><meshBasicMaterial color={settings.color} transparent opacity={.04} /></mesh>
    </group>
    <group ref={rings} position={[0, 1.45, -.65]} rotation={[0, 0, -.3]}>
      {[1.8, 1.94].map((r, i) => <mesh key={r}><torusGeometry args={[r, .006, 8, 128, i ? Math.PI * 1.5 : Math.PI * 1.85]} /><meshBasicMaterial color={settings.color} transparent opacity={i ? .14 : .32} /></mesh>)}
    </group>
    {!reduced && <Sparkles count={mobile ? 25 : 85} scale={[5, 5, 3]} position={[0, 1.5, -1]} size={mobile ? 1.3 : 1.8} speed={.2} color={settings.color} opacity={.55} />}
    <group ref={panels} scale={.01}>
      <HolographicPanel position={[-1.25, 1.65, -.4]} rotation={.3} />
      <HolographicPanel position={[1.12, 2, -.6]} rotation={-.4} />
      {!mobile && <HolographicPanel position={[1.3, .85, -.4]} rotation={-.3} />}
    </group>
    {network && <group>{nodes.map((point, i) => <group key={i}><mesh position={point}><sphereGeometry args={[.025, 8, 8]} /><meshBasicMaterial color={i % 3 ? settings.color : '#ffa96a'} /></mesh><Line points={[point, nodes[(i + 3) % nodes.length]]} color={settings.color} transparent opacity={.15} /></group>)}</group>}
  </>;
}
