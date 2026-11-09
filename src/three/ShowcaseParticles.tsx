import { useEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { BufferGeometry, Color, Float32BufferAttribute, ShaderMaterial } from 'three'

/** One draw call, deterministic positions, no textures or per-frame allocations. */
export function ShowcaseParticles({ count, color }: { count: number; color: string }) {
  const material = useRef<ShaderMaterial>(null)
  const geometry = useMemo(() => {
    const positions: number[] = [], seeds: number[] = []
    for (let i = 0; i < count; i++) {
      const x = ((i * .61803398875) % 1) * 8 - 4
      const y = ((i * .41421356237 + .2) % 1) * 5 - 1.2
      positions.push(x, y, -1.7 - (i % 5) * .3)
      seeds.push(i * 2.399)
    }
    const result = new BufferGeometry()
    result.setAttribute('position', new Float32BufferAttribute(positions, 3))
    result.setAttribute('seed', new Float32BufferAttribute(seeds, 1))
    return result
  }, [count])
  const uniforms = useMemo(() => ({ time: { value: 0 }, pixelRatio: { value: 1 }, tint: { value: new Color(color) } }), [color])
  useEffect(() => () => geometry.dispose(), [geometry])
  useFrame(({ gl }, delta) => {
    if (!material.current) return
    material.current.uniforms.time.value += Math.min(delta, .1)
    material.current.uniforms.pixelRatio.value = gl.getPixelRatio()
  })
  if (!count) return null
  return <points name="showcase-particles" frustumCulled={false}>
    <primitive object={geometry} attach="geometry" />
    <shaderMaterial ref={material} uniforms={uniforms} transparent depthWrite={false} toneMapped={false}
      vertexShader={`
        attribute float seed;
        uniform float time;
        uniform float pixelRatio;
        varying float brightness;
        void main() {
          vec3 p = position;
          p.x += sin(time * .11 + seed) * .08;
          p.y += sin(time * .16 + seed * .7) * .12;
          vec4 view = modelViewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * view;
          gl_PointSize = pixelRatio * (3.5 + sin(seed) * 1.2) * clamp(12.0 / -view.z, .65, 1.4);
          brightness = .35 + .15 * sin(time * .45 + seed);
        }`}
      fragmentShader={`
        uniform vec3 tint;
        varying float brightness;
        void main() {
          float radius = length(gl_PointCoord - .5) * 2.0;
          float alpha = (1.0 - smoothstep(.12, 1.0, radius)) * brightness;
          if (alpha < .01) discard;
          gl_FragColor = vec4(tint, alpha);
        }`}
    />
  </points>
}
