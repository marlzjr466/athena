import { AmbientLight, DirectionalLight, Group, HemisphereLight, PerspectiveCamera, Scene, WebGLRenderer } from 'three'
import { disposeVroid, loadVroidInstance, type VroidInstance } from '../three/vroidAssets'
import { VroidAnimationController } from '../three/vroidAnimation'
import type { StartupPresentation } from '../../shared/startup'

/** A single canvas, original materials, two existing clips, and no postprocessing buffers. */
export function createSplashScene(host: HTMLElement, options: {
  signal: AbortSignal; reduced: boolean; presentation(): StartupPresentation
}): () => void {
  let renderer: WebGLRenderer
  try { renderer = new WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'low-power' }) }
  catch { host.dataset.fallback = 'true'; return () => {} }
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5))
  renderer.setClearColor(0x000000, 0)
  host.append(renderer.domElement)
  const scene = new Scene(), rig = new Group()
  scene.add(rig)
  const camera = new PerspectiveCamera(30, 1, .1, 30)
  scene.add(new AmbientLight('#c9f0ff', .35), new HemisphereLight('#e1f6ff', '#283d6a', .25))
  const key = new DirectionalLight('#f7fcff', 1.1); key.position.set(-2, 4, 5)
  const rim = new DirectionalLight('#50d6ff', .8); rim.position.set(3, 2, -2)
  const violet = new DirectionalLight('#818cff', .32); violet.position.set(-3, 1, -1)
  scene.add(key, rim, violet)
  const resize = () => {
    const { width, height } = host.getBoundingClientRect()
    camera.aspect = width / Math.max(1, height)
    camera.position.set(0, .12, Math.max(4.9, 3.1 / camera.aspect))
    camera.lookAt(0, .05, 0); camera.updateProjectionMatrix()
    renderer.setSize(width, height, false)
  }
  const observer = new ResizeObserver(resize); observer.observe(host); resize()
  let model: VroidInstance | undefined, controller: VroidAnimationController | undefined
  let disposed = false, greeted = false, revealed = false, previous = 0
  const cleanup = () => {
    if (disposed) return
    disposed = true
    renderer.setAnimationLoop(null); observer.disconnect()
    options.signal.removeEventListener('abort', cleanup)
    renderer.domElement.removeEventListener('webglcontextlost', lost)
    controller?.dispose()
    if (model) disposeVroid(model.vrm)
    scene.clear(); renderer.renderLists.dispose(); renderer.dispose(); renderer.forceContextLoss()
    renderer.domElement.remove()
  }
  const lost = (event: Event) => { event.preventDefault(); host.dataset.fallback = 'true'; cleanup() }
  renderer.domElement.addEventListener('webglcontextlost', lost)
  options.signal.addEventListener('abort', cleanup, { once: true })
  if (options.signal.aborted) { cleanup(); return cleanup }

  // Athena's existing "wave" action maps to goodbye.vrma. The separate Greeting
  // clip is a deep bow, which obscures the face during this short introduction.
  void loadVroidInstance(false, undefined, 'vroid-athena', { animations: ['idle', 'goodbye'], signal: options.signal }).then(instance => {
    if (disposed) { disposeVroid(instance.vrm); return }
    model = instance
    controller = new VroidAnimationController(instance)
    instance.vrm.scene.position.set(instance.fit.offsetX ?? 0, instance.fit.offsetY, 0)
    instance.vrm.scene.scale.setScalar(instance.fit.scale)
    rig.add(instance.vrm.scene)
    host.dataset.model = 'ready'
  }).catch(() => { if (!disposed) { host.dataset.fallback = 'true'; cleanup() } })

  renderer.setAnimationLoop((now: number) => {
    const dt = previous ? Math.min((now - previous) / 1000, .05) : 0
    previous = now
    const state = options.presentation()
    const elapsed = state.startedAt ? Math.max(0, (Date.now() - state.startedAt) / 1000) : 0
    const scale = state.durationMs / 6000
    if (model && controller) {
      if (!revealed && elapsed >= 1.5 * scale && state.stage !== 'exiting') { revealed = true; host.classList.add('revealed') }
      if (!greeted && elapsed >= 3 * scale) { greeted = true; if (!options.reduced) controller.play('goodbye', .45, false) }
      controller.update(options.reduced ? 0 : dt)
      const expressions = model.vrm.expressionManager
      // Let authored expression tracks retain ownership; only supply absent blinking.
      if (!model.animationExpressionNames[controller.activeName ?? 'idle']?.includes('blink')) {
        const blinkAt = (elapsed + .6) % 3.8
        expressions?.setValue('blink', blinkAt < .16 ? Math.sin(blinkAt / .16 * Math.PI) : 0)
      }
      rig.position.y = options.reduced ? 0 : Math.sin(elapsed * 1.3) * .018
      rig.rotation.y = options.reduced ? 0 : Math.sin(elapsed * .45) * .025
      // Idle.vrma supplies breathing/head motion; all geometry and materials stay intact.
      model.vrm.update(dt)
    }
    renderer.render(scene, camera)
  })
  return cleanup
}
