import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { Color, DoubleSide, Mesh, PlaneGeometry, PointLight, ShaderMaterial, Vector2 } from 'three'
import type { TaskVisualMode } from '../../shared/contracts'
import { CONSOLE, workingGaze, workingInteraction } from './taskWorkingPose'
import { isCodingScreen, taskScreenTexture } from './taskScreenContent'
import { useWorkingFrame } from './TaskWorkingMode'

export function curvedScreenGeometry() {
  const geometry = new PlaneGeometry(CONSOLE.width, CONSOLE.height, 32, 4)
  const position = geometry.attributes.position
  const uv = geometry.attributes.uv
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i) / (CONSOLE.width / 2)
    position.setZ(i, -CONSOLE.curve * x * x)
    // The console's readable side faces Athena (-Z), not away from her.
    uv.setX(i, 1 - uv.getX(i))
  }
  geometry.computeVertexNormals()
  return geometry
}

/** One curved mesh. Ripples, scan lines and focus are drawn in its shader;
 * there are no overlay planes, DOM panels, bloom passes or shadow maps. */
export function TaskWorkScreen({ mode, title, label, detailed, reduced, intensity, screenY }: { mode: TaskVisualMode; title: string; label: string; detailed: boolean; reduced: boolean; intensity: number; screenY: number }) {
  const geometry = useMemo(curvedScreenGeometry, [])
  const texture = useMemo(() => taskScreenTexture(title, label, detailed, mode), [title, label, detailed, mode])
  const mesh = useRef<Mesh>(null)
  const material = useRef<ShaderMaterial>(null)
  const light = useRef<PointLight>(null)
  const frame = useWorkingFrame()
  const uniforms = useMemo(() => ({ map: { value: texture }, opacity: { value: 0 }, time: { value: 0 }, focus: { value: new Vector2() }, leftFocus: { value: new Vector2() }, gaze: { value: new Vector2() }, touch: { value: 0 }, leftTouch: { value: 0 }, coding: { value: 0 }, rows: { value: 8 }, motion: { value: 0 }, accent: { value: new Color('#53dcff') } }), [])
  useEffect(() => () => geometry.dispose(), [geometry])
  // Swap maps before the old texture is disposed; a demand-rendered frame
  // must never sample the previous, already disposed texture.
  useLayoutEffect(() => { if (material.current) material.current.uniforms.map.value = texture }, [texture])
  useEffect(() => () => texture.dispose(), [texture])
  useFrame(({ clock }) => {
    // R3F/Three copy primitive uniform values when applying material props.
    // Mutate the live material, not the original initializer object.
    if (!material.current) return
    const live = material.current.uniforms
    const visible = frame.current.opacity > .005
    if (mesh.current) mesh.current.visible = visible
    live.opacity.value = visible ? frame.current.opacity : 0
    if (light.current) light.current.intensity = visible ? frame.current.opacity * .9 : 0
    if (!visible) return
    const point = workingInteraction(mode, title, clock.elapsedTime, intensity, reduced, screenY)
    const leftPoint = workingInteraction(mode, title, clock.elapsedTime, intensity, reduced, screenY, -1)
    const gaze = workingGaze(mode, clock.elapsedTime, intensity, reduced)
    live.time.value = reduced ? 0 : clock.elapsedTime
    live.focus.value.set(1 - point.u, point.v)
    live.leftFocus.value.set(1 - leftPoint.u, leftPoint.v)
    live.gaze.value.set(1 - gaze.u, gaze.v)
    live.touch.value = point.contact
    live.leftTouch.value = leftPoint.contact
    live.coding.value = isCodingScreen(title) ? 1 : 0
    live.rows.value = detailed ? 8 : 4
    live.motion.value = reduced || intensity === 0 ? 0 : 1
    live.accent.value.set(mode === 'failed' ? '#ffaf76' : mode === 'completed' ? '#85ffd0' : mode === 'cancelled' ? '#aac4d0' : '#53dcff')
  })
  return <>
    <mesh ref={mesh} name="task-hologram-screen" visible={false} geometry={geometry} position={[0, screenY, CONSOLE.z]} rotation={[CONSOLE.tilt, 0, 0]}>
      <shaderMaterial ref={material} uniforms={uniforms} transparent depthWrite={false} depthTest side={DoubleSide} toneMapped={false}
        vertexShader={`varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`}
        fragmentShader={`uniform sampler2D map; uniform float opacity, time, touch, leftTouch, coding, rows, motion; uniform vec2 focus, leftFocus, gaze; uniform vec3 accent; varying vec2 vUv;
          float ripple(vec2 center, float press) {
            float distanceToTouch = length((vUv - center) * vec2(2.0, 1.0));
            return (1.0 - smoothstep(.003, .011, abs(distanceToTouch - (.018 + press * .05)))) * press;
          }
          void main() {
            vec4 tex = texture2D(map, vUv);
            float row = floor((.66 - vUv.y) / .0625);
            float progress = mix(rows * 40.0, mod(time * 22.0, rows * 40.0 + 50.0), motion);
            float chars = clamp(progress - row * 40.0, 0.0, 40.0);
            float caretX = .495 + chars * .0124;
            float codeArea = step(.495, vUv.x) * step(vUv.x, .96) * step(0.0, row) * step(row, rows - 1.0) * coding;
            // Sample the clear gap below this row so hidden characters reveal
            // the same glass surface, not an opaque colored masking block.
            vec3 glass = texture2D(map, vec2(vUv.x, .66 - (row + .90) * .0625)).rgb;
            tex.rgb = mix(tex.rgb, glass, codeArea * step(caretX, vUv.x));
            float activeRow = step(row * 40.0, progress) * step(progress, (row + 1.0) * 40.0);
            float caret = (1.0 - smoothstep(.0015, .0035, abs(vUv.x - caretX))) * activeRow * codeArea * motion * step(0.0, sin(time * 8.0));
            float halo = exp(-length((vUv - gaze) * vec2(2.0, 1.0)) * 20.0) * .1;
            float scan = pow(max(0.0, sin(vUv.y * 100.0 - time * 1.3)), 18.0) * .025;
            vec3 color = tex.rgb + accent * ((ripple(focus, touch) * .6 + ripple(leftFocus, leftTouch) * .6 + halo + scan + caret * .65) * step(.1, tex.a));
            gl_FragColor = vec4(color, tex.a * opacity);
            #include <colorspace_fragment>
          }`} />
    </mesh>
    <pointLight ref={light} name="task-hologram-light" color="#45d9ff" position={[0, screenY, CONSOLE.z - .12]} intensity={0} distance={2} decay={2} />
  </>
}
