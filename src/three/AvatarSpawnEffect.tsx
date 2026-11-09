import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { AdditiveBlending, DoubleSide, Group, ShaderMaterial } from 'three'

const vertex = `
  varying vec2 effectUv;
  void main() {
    effectUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

const rings = `
  uniform float time;
  uniform float tier;
  varying vec2 effectUv;
  float ring(float radius, float target, float width) {
    return exp(-pow((radius - target) / max(width, fwidth(radius) * .65), 2.0));
  }
  void main() {
    vec2 p = (effectUv - .5) * 2.0;
    float radius = length(p);
    float angle = atan(p.y, p.x);
    float pulse = .92 + .08 * sin(time * 1.7);
    vec3 tint = mix(vec3(.04, .72, 1.0), vec3(.47, .20, 1.0), smoothstep(-.25, .9, p.x));
    float orbit = .55 + .45 * pow(.5 + .5 * sin(angle * 2.0 - time * .65), 5.0);
    float target = tier < .5 ? .82 : tier < 1.5 ? .61 : .44;
    float orbitStrength = tier < .5 ? orbit : 1.0;
    float lines = ring(radius, target, tier < 1.5 ? .006 : .008) * orbitStrength;
    float bloom = ring(radius, target, tier < .5 ? .025 : tier < 1.5 ? .019 : .038)
      * (tier < .5 ? .4 : tier < 1.5 ? .22 : .48) * orbitStrength;
    float center = tier < .5 ? exp(-radius * radius * 20.0) : 0.0;
    float spark = tier < .5 ? pow(max(0.0, cos(angle - time * .55)), 160.0) * ring(radius, target, .025) : 0.0;
    float haze = tier < .5 ? exp(-radius * radius * 3.5) * .20 : 0.0;
    float alpha = clamp((lines * 1.12 + bloom + center + spark + haze) * pulse, 0.0, 1.0);
    alpha *= 1.0 - smoothstep(.9, 1.0, radius);
    vec3 color = mix(tint, vec3(.66, 1.0, 1.0), clamp(lines * .75 + center * .8 + spark, 0.0, 1.0));
    if (alpha < .003) discard;
    gl_FragColor = vec4(color, alpha);
  }
`

const glow = `
  uniform float time;
  varying vec2 effectUv;
  void main() {
    vec2 p = vec2((effectUv.x - .5) * 2.0, effectUv.y);
    float base = exp(-p.x * p.x * 5.0 - pow((p.y - .14) * 13.0, 2.0));
    float column = exp(-p.x * p.x * 22.0) * pow(1.0 - p.y, 3.0);
    float alpha = (base * .65 + column * .24) * smoothstep(0.0, .1, p.y);
    alpha *= .94 + .06 * sin(time * 1.7);
    vec3 color = mix(vec3(.08, .66, 1.0), vec3(.7, 1.0, 1.0), base);
    gl_FragColor = vec4(color, alpha);
  }
`

const beam = `
  uniform float time;
  varying vec2 effectUv;
  void main() {
    float lane = floor(effectUv.x * 18.0);
    float seed = fract(sin(lane * 127.1 + 19.7) * 43758.5453);
    float x = fract(effectUv.x * 18.0) - .5;
    float head = fract(time * (.23 + seed * .16) + seed) * 1.35 - .15;
    float behind = head - effectUv.y;
    float streak = exp(-x * x * 310.0) * exp(-max(behind, 0.0) * 17.0)
      * smoothstep(-.018, .01, behind);
    float tip = exp(-x * x * 400.0 - pow(behind * 60.0, 2.0));
    float edge = smoothstep(0.0, .08, effectUv.y) * (1.0 - smoothstep(.65, 1.0, effectUv.y));
    float rays = pow(.5 + .5 * cos(effectUv.x * 113.1), 38.0) * pow(1.0 - effectUv.y, 2.0) * .06;
    float alpha = (streak * .65 + tip * .9 + rays) * edge;
    vec3 tint = mix(vec3(.08, .65, 1.0), vec3(.5, .32, 1.0), seed * .55);
    gl_FragColor = vec4(mix(tint, vec3(.7, 1.0, 1.0), tip), alpha);
  }
`

/** Preview-only light: shares the demand canvas clock; no textures, extra
 * animation loop, postprocessing pass, or changes to the avatar skeleton. */
export function AvatarSpawnEffect({ groundY, reduced, economy, active }: { groundY: number; reduced: boolean; economy: boolean; active: boolean }) {
  const rig = useRef<Group>(null)
  const ringMaterials = useRef<(ShaderMaterial | null)[]>([])
  const beamMaterial = useRef<ShaderMaterial>(null)
  const elapsed = useRef(0)
  const uniforms = useMemo(() => ({ time: { value: 0 } }), [])
  const ringUniforms = useMemo(() => [0, 1, 2].map(tier => ({ time: { value: 0 }, tier: { value: tier } })), [])
  useFrame(({ camera }, delta) => {
    if (active && !reduced) elapsed.current += Math.min(delta, .1)
    const time = elapsed.current
    for (const material of ringMaterials.current) if (material) material.uniforms.time.value = time
    if (beamMaterial.current) beamMaterial.current.uniforms.time.value = time
    if (rig.current) {
      const progress = reduced ? 1 : Math.min(1, time / .85)
      const visibleWidth = 2 * Math.abs(camera.position.z) / camera.projectionMatrix.elements[0]
      const fit = Math.min(1, visibleWidth * .44 / 1.5)
      const scale = fit * (.72 + .28 * (1 - Math.pow(1 - progress, 3)))
      rig.current.scale.set(scale, 1, scale)
    }
  })
  return <group name="avatar-foot-spawn-effect" position={[0, groundY, 0]} ref={rig}>
    {ringUniforms.map((ringUniform, tier) => <mesh key={tier} name={`spawn-ring-${tier + 1}`} position={[0, [.09, .045, 0][tier], 0]} rotation={[-Math.PI / 2, 0, 0]} scale={[1.5, .85, 1]}>
      <planeGeometry args={[2, 2]} />
      <shaderMaterial ref={material => { ringMaterials.current[tier] = material }} uniforms={ringUniform} vertexShader={vertex} fragmentShader={rings} transparent blending={AdditiveBlending} depthWrite={false} side={DoubleSide} toneMapped={false} />
    </mesh>)}
    <mesh position={[0, .20, -.08]}>
      <planeGeometry args={[2.3, .5]} />
      <shaderMaterial uniforms={uniforms} vertexShader={vertex} fragmentShader={glow} transparent blending={AdditiveBlending} depthWrite={false} toneMapped={false} />
    </mesh>
    <mesh name="spawn-rising-lights" position={[0, .575, 0]}>
      <cylinderGeometry args={[.65, .85, 1.15, economy ? 20 : 40, 1, true]} />
      <shaderMaterial ref={beamMaterial} uniforms={uniforms} vertexShader={vertex} fragmentShader={beam} transparent blending={AdditiveBlending} depthWrite={false} side={DoubleSide} toneMapped={false} />
    </mesh>
  </group>
}
