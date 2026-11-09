import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AthenaState, TaskVisualMode } from '../../shared/contracts'

test('task holograms render in the native floating window without disturbing the companion preview', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'athena-task-visuals-'))
  const app = await electron.launch({ args: ['.'], env: { ...process.env, ATHENA_TEST_DATA: profile }, timeout: 30_000 })
  const errors: string[] = []
  try {
    await expect.poll(() => app.windows().length).toBe(3)
    const control = app.windows().find((page) => page.url().includes('surface=control'))!
    const floating = app.windows().find((page) => page.url().includes('surface=floating'))!
    for (const page of app.windows()) {
      page.on('pageerror', (error) => errors.push(error.message))
      page.on('console', (message) => { if (message.type() === 'error' && /shader|WebGL|THREE/.test(message.text())) errors.push(message.text()) })
    }
    await expect(control.getByRole('heading', { name: /A little presence/ })).toBeVisible()
    await control.evaluate(() => window.athena!.updateSettings({ randomActions: false, randomMovement: false, taskActivityEnabled: true, taskHologramsEnabled: true, taskDetailedHolograms: true, reducedMotion: false, size: 120 }))
    const snapshot = await control.evaluate(() => window.athena!.getSnapshot())
    const pid = app.process().pid
    const baseBounds = await app.evaluate(({ BrowserWindow, screen }) => {
      const window = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('surface=floating'))!
      const area = screen.getPrimaryDisplay().workArea
      window.setBounds({ x: Math.round(area.x + area.width / 2 - 60), y: Math.round(area.y + area.height / 2 - 60), width: 120, height: 120 }, false)
      return window.getBounds()
    })
    // Test-only inspection of Canvas's existing root ref, with no production
    // global/debug bridge. Check real scene objects, not just DOM status text.
    async function sceneState() {
      return floating.evaluate(() => {
        const canvas = document.querySelector('canvas')! as unknown as Record<string, unknown>
        let fiber = canvas[Object.keys(canvas).find(k => k.startsWith('__reactFiber$'))!] as any
        for (let i = 0; fiber && i < 12; i++, fiber = fiber.return) {
          let state = fiber.memoizedState
          for (let j = 0; state && j < 70; j++, state = state.next) {
            const root = state.memoizedState?.current?.get?.()
            if (!root?.scene) continue
            const screens: any[] = []
            root.scene.traverse((object: any) => { if (object.name === 'task-hologram-screen') screens.push(object) })
            const screen = screens[0], rig = root.scene.getObjectByName('task-working-presentation')
            const light = root.scene.getObjectByName('task-hologram-light')
            const pivot = root.camera.position.clone().set(0, .1, 0).project(root.camera)
            const head = root.scene.getObjectByName('athena-head')
            return { count: screens.length, id: screen?.uuid, visible: screen?.visible, lightId: light?.uuid, lightIntensity: light?.intensity, programs: root.gl.info.programs.length, geometry: screen?.geometry.uuid, opacity: screen?.material.uniforms.opacity.value ?? 0, depthTest: screen?.material.depthTest, time: screen?.material.uniforms.time.value ?? 0, coding: screen?.material.uniforms.coding.value ?? 0, touch: screen?.material.uniforms.touch.value ?? 0, leftTouch: screen?.material.uniforms.leftTouch.value ?? 0, headX: head.rotation.x, headY: head.rotation.y, cameraZ: root.camera.position.z, desktopX: window.screenX + (pivot.x + 1) * root.size.width / 2, desktopY: window.screenY + (1 - pivot.y) * root.size.height / 2, facingX: rig ? 2 * rig.quaternion.y * rig.quaternion.w : 0, quaternionY: rig?.quaternion.y, memory: root.gl.info.memory, calls: root.gl.info.render.calls }
          }
        }
        throw new Error('Canvas scene root was not found')
      })
    }
    async function avatarPixels(anchor: { x: number; y: number }) {
      return app.evaluate(async ({ BrowserWindow }, anchor) => {
        const window = BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().includes('surface=floating'))!
        const image = await window.webContents.capturePage({ x: anchor.x - 60, y: anchor.y - 60, width: 120, height: 120 })
        const bitmap = image.toBitmap()
        let pearl = 0
        for (let i = 0; i < bitmap.length; i += 4) {
          const b = bitmap[i], g = bitmap[i + 1], r = bitmap[i + 2]
          if (bitmap[i + 3] > 100 && Math.min(r, g, b) > 170 && Math.max(r, g, b) - Math.min(r, g, b) < 55) pearl++
        }
        return pearl / (bitmap.length / 4)
      }, anchor)
    }
    await floating.waitForTimeout(300)
    const baselinePixels = await avatarPixels({ x: 60, y: 60 })
    expect(baselinePixels).toBeGreaterThan(.02)
    // Real Electron window/renderer, deterministic task fixtures: no AI calls,
    // credentials, project mutations, or changes to the user's profile.
    async function show(mode: TaskVisualMode, tool: string, anchor = { x: 200, y: 150 }, state?: AthenaState) {
      await app.evaluate(({ BrowserWindow }, { snapshot, mode, tool, anchor, state, baseBounds }) => {
        const taskVisual = { mode, activityType: tool, label: `Test ${tool}`, startedAt: Date.now(), anchor }
        for (const window of BrowserWindow.getAllWindows()) {
          if (window.webContents.getURL().includes('surface=floating')) window.setBounds(mode === 'idle' ? baseBounds : { x: baseBounds.x + 60 - anchor.x, y: baseBounds.y + 60 - anchor.y, width: 400, height: 300 }, false)
          window.webContents.send('athena:changed', { ...snapshot, taskVisual, state: state ?? (mode === 'idle' ? 'idle' : 'working'), visible: true })
        }
      }, { snapshot, mode, tool, anchor, state, baseBounds })
    }
    async function sampleTransition() {
      const frames = []
      for (let i = 0; i < 24; i++) {
        frames.push(await sceneState())
        await floating.waitForTimeout(35)
      }
      return frames
    }
    const entering = sampleTransition()
    await show('terminal', 'run_tests')
    const entryFrames = await entering
    for (const frame of entryFrames) {
      expect(frame.desktopX).toBeCloseTo(baseBounds.x + 60, 1)
      expect(frame.desktopY).toBeCloseTo(baseBounds.y + 60, 1)
    }
    await expect(floating.getByRole('status', { name: 'Athena working: Verify' })).toBeVisible()
    await expect(floating.locator('.task-holograms')).toHaveCount(1)
    const webgl = await control.evaluate(() => {
      const canvas = document.querySelector('canvas')!
      const gl = canvas.getContext('webgl2')
      return { available: Boolean(gl), lost: gl?.isContextLost() }
    })
    expect(webgl).toEqual({ available: true, lost: false })
    await floating.waitForTimeout(1500) // Let the rear-three-quarter turn settle.
    const taskPixels = await avatarPixels({ x: 200, y: 150 })
    expect(taskPixels / baselinePixels).toBeGreaterThan(.4)
    expect(taskPixels / baselinePixels).toBeLessThan(1.75)
    await floating.screenshot({ path: 'test-results/task-terminal.png', omitBackground: true })
    const initial = await sceneState()
    expect(initial.count).toBe(1)
    expect(initial.opacity).toBeGreaterThan(.95)
    expect(initial.depthTest).toBe(true)
    expect(Math.abs(initial.quaternionY)).toBeGreaterThan(.9)
    expect(initial.time).toBeGreaterThan(0)
    expect(initial.cameraZ).toBe(4.2)
    expect(initial.desktopX).toBeCloseTo(baseBounds.x + 60, 4)
    expect(initial.desktopY).toBeCloseTo(baseBounds.y + 60, 4)
    expect(errors).toEqual([])
    await control.screenshot({ path: 'test-results/task-companion-preview.png' })
    for (const [mode, tool, title] of [['exploring', 'list_directory', 'explore'], ['reading', 'read_file', 'read'], ['searching', 'search_files', 'search'], ['typing', 'create_file', 'create'], ['typing', 'apply_patch', 'edit'], ['typing', 'delete_file', 'delete'], ['terminal', 'run_build', 'build'], ['browser', 'browser_verify', 'verify']] as const) {
      await show(mode, tool)
      await expect(floating.locator('.task-holograms')).toHaveAttribute('data-screen', title)
      await expect(floating.locator('.task-holograms')).toHaveCount(1)
      const current = await sceneState()
      expect(current.id).toBe(initial.id)
      expect(current.geometry).toBe(initial.geometry)
      expect(current.memory.geometries).toBe(initial.memory.geometries)
      expect(current.memory.textures).toBeLessThanOrEqual(initial.memory.textures + 1)
      if (title === 'create') { await floating.waitForTimeout(300); await floating.screenshot({ path: 'test-results/task-create.png', omitBackground: true }) }
    }
    await show('typing', 'apply_patch')
    const coding = []
    for (let i = 0; i < 38; i++) {
      await floating.waitForTimeout(500)
      const frame = await sceneState()
      expect(frame.coding).toBe(1)
      expect(frame.desktopX).toBeCloseTo(initial.desktopX, 4)
      expect(frame.desktopY).toBeCloseTo(initial.desktopY, 4)
      coding.push(frame)
    }
    await floating.screenshot({ path: 'test-results/task-code-tapping.png', omitBackground: true })
    expect(Math.max(...coding.map(f => f.headX)) - Math.min(...coding.map(f => f.headX))).toBeGreaterThan(.45)
    expect(Math.max(...coding.map(f => f.headY)) - Math.min(...coding.map(f => f.headY))).toBeGreaterThan(.8)
    expect(Math.max(...coding.map(f => f.touch))).toBeGreaterThan(.9)
    expect(Math.max(...coding.map(f => f.leftTouch))).toBeGreaterThan(.9)
    expect(coding.at(-1)!.time - coding[0].time).toBeGreaterThan(10)
    await floating.screenshot({ path: 'test-results/task-code-tapping.png', omitBackground: true })
    await show('terminal', 'run_tests', undefined, 'listening')
    await floating.waitForTimeout(1400)
    expect((await sceneState()).opacity).toBeLessThan(.01)
    expect(Math.abs((await sceneState()).quaternionY)).toBeLessThan(.01)
    for (const anchor of [{ x: 60, y: 60 }, { x: 340, y: 60 }, { x: 60, y: 240 }, { x: 340, y: 240 }]) {
      await show('typing', 'create_file', anchor)
      await expect.poll(async () => floating.locator('.task-holograms').evaluateAll((screens) => screens.length === 1 && screens.every((screen) => { const r = screen.getBoundingClientRect(); return r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight }))).toBe(true)
    }
    await floating.waitForTimeout(1500)
    expect((await sceneState()).facingX).toBeLessThan(-.5)
    expect(await avatarPixels({ x: 340, y: 240 })).toBeGreaterThan(baselinePixels * .4)
    await floating.screenshot({ path: 'test-results/task-edge.png', omitBackground: true })
    for (const mode of ['completed', 'failed', 'cancelled'] as const) {
      await show('terminal', 'run_tests')
      await floating.waitForTimeout(1200)
      await show(mode, 'apply_patch')
      await expect(floating.locator('.task-holograms')).toHaveClass(new RegExp(`task-holograms-${mode}`))
      await floating.waitForTimeout(mode === 'completed' ? 350 : 100)
      if (mode === 'completed') await floating.screenshot({ path: 'test-results/task-completed.png', omitBackground: true })
      let previousOpacity = (await sceneState()).opacity
      for (let i = 0; i < 45; i++) {
        await floating.waitForTimeout(35)
        const frame = await sceneState()
        expect(frame.id).toBe(initial.id)
        expect(frame.lightId).toBe(initial.lightId)
        // Once the ending starts fading it never flashes back into view.
        expect(frame.opacity).toBeLessThanOrEqual(previousOpacity + .005)
        previousOpacity = frame.opacity
      }
      expect((await sceneState()).opacity).toBeLessThan(.15)
      expect((await sceneState()).desktopX).toBeCloseTo(initial.desktopX, 4)
      expect((await sceneState()).desktopY).toBeCloseTo(initial.desktopY, 4)
    }
    const exiting = sampleTransition()
    await show('idle', '')
    for (const frame of await exiting) {
      expect(frame.desktopX).toBeCloseTo(initial.desktopX, 1)
      expect(frame.desktopY).toBeCloseTo(initial.desktopY, 1)
    }
    await expect(floating.locator('.task-holograms')).toHaveCount(0)
    await floating.waitForTimeout(1500)
    const hidden = await sceneState()
    expect(hidden.count).toBe(1)
    expect(hidden.id).toBe(initial.id)
    expect(hidden.visible).toBe(false)
    expect(hidden.lightId).toBe(initial.lightId)
    expect(hidden.lightIntensity).toBe(0)
    expect(hidden.programs).toBe(initial.programs)
    expect(Math.abs((await sceneState()).quaternionY)).toBeLessThan(.01)
    expect((await sceneState()).desktopX).toBeCloseTo(initial.desktopX, 4)
    expect((await sceneState()).desktopY).toBeCloseTo(initial.desktopY, 4)
    await floating.screenshot({ path: 'test-results/task-returned-idle.png', omitBackground: true })
    await show('terminal', 'run_tests')
    await floating.waitForTimeout(1000)
    expect((await sceneState()).id).toBe(initial.id)
    expect((await sceneState()).visible).toBe(true)
    expect(app.process().pid).toBe(pid)
    expect(errors).toEqual([])
  } finally { await app.close() }
})
