import { test, expect, _electron as electron, type Page } from '@playwright/test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Read the real R3F scene without adding a production debug bridge.
async function inspectScene(page: Page, selector = 'canvas') {
  return page.evaluate((selector) => {
    const canvas = document.querySelector(selector)! as unknown as Record<string, unknown>
    let fiber = canvas[Object.keys(canvas).find(key => key.startsWith('__reactFiber$'))!] as any
    for (let i = 0; fiber && i < 14; i++, fiber = fiber.return) {
      let state = fiber.memoizedState
      for (let j = 0; state && j < 80; j++, state = state.next) {
        const root = state.memoizedState?.current?.get?.()
        if (!root?.scene) continue
        const names: string[] = []
        root.scene.traverse((object: any) => { if (object.name) names.push(object.name) })
        return {
          names,
          opacity: Number((canvas as unknown as HTMLCanvasElement).style.opacity || 1),
          yaw: root.scene.getObjectByName('avatar-switch-transition')?.rotation.y ?? 0,
          avatarScale: (root.scene.getObjectByName('showcase-classic') ?? root.scene.getObjectByName('showcase-enhanced'))?.scale.x ?? null,
          avatarY: (root.scene.getObjectByName('showcase-classic') ?? root.scene.getObjectByName('showcase-enhanced'))?.position.y ?? null,
          camera: { position: root.camera.position.toArray(), rotation: root.camera.rotation.toArray().slice(0, 3) },
          particleCount: root.scene.getObjectByName('showcase-particles')?.geometry.attributes.position.count ?? 0,
        }
      }
    }
    throw new Error('Scene is not ready')
  }, selector)
}

test('Companion preview selects existing 3D avatars, turns between them, and persists the choice', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'athena-showcase-'))
  const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')), ATHENA_TEST_DATA: profile }
  delete env.ELECTRON_RUN_AS_NODE
  const errors: string[] = []
  const launch = async () => {
    const app = await electron.launch({ args: ['.'], env, timeout: 30_000 })
    await expect.poll(() => app.windows().length).toBe(3)
    const control = app.windows().find(page => page.url().includes('surface=control'))!
    const floating = app.windows().find(page => page.url().includes('surface=floating'))!
    for (const page of [control, floating]) page.on('pageerror', error => errors.push(error.message))
    await expect(control.getByRole('heading', { name: 'Choose your Athena' })).toBeVisible()
    return { app, control, floating }
  }

  let session = await launch()
  try {
    let { app, control, floating } = session
    await control.emulateMedia({ reducedMotion: 'no-preference' })
    await control.evaluate(() => window.athena!.updateSettings({ avatarVariant: 'classic', pinned: true, randomActions: false, reduceOnBattery: false, size: 280 }))
    const original = await control.evaluate(() => window.athena!.getSnapshot())
    const floatingBounds = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('surface=floating'))!.getBounds())

    await expect(control.locator('.showcase-thumbnail canvas')).toHaveCount(0)
    await expect(control.locator('.showcase-vroid-thumbnail')).toHaveCount(1)
    await expect(control.getByRole('button', { name: 'Athena Classic' })).toHaveCount(0)
    await expect(control.getByRole('button', { name: 'Athena Enhanced' })).toHaveCount(0)
    await expect(control.getByRole('switch', { name: 'Energy FX' })).toHaveCount(0)
    await expect(control.getByRole('button', { name: 'Add Model' })).toBeDisabled()
    expect(await control.locator('.companion-avatar-section').evaluate(element => getComputedStyle(element).backgroundImage)).toContain('companion-cityscape')
    await expect.poll(async () => (await inspectScene(control, '.showcase-viewport canvas')).names).toContain('athena-classic')
    expect((await inspectScene(control, '.showcase-viewport canvas')).names).not.toContain('athena-enhanced')
    const first = await inspectScene(control, '.showcase-viewport canvas')
    expect(first.camera.rotation.every((value: number) => Math.abs(value) < .0001)).toBe(true)
    expect(first.names).not.toContain('showcase-foot-halo')
    expect(first.avatarScale).toBeLessThan(1.6)
    expect(first.avatarY).toBe(0)
    await control.evaluate(() => window.athena!.updateSettings({ avatarVariant: 'enhanced' }))
    expect((await control.evaluate(() => window.athena!.getSnapshot())).settings.avatarVariant).toBe('enhanced')
    const previewFrames = [], floatingFrames = []
    for (let frame = 0; frame < 6; frame++) {
      await control.waitForTimeout(130)
      previewFrames.push(await inspectScene(control, '.showcase-viewport canvas'))
      floatingFrames.push(await inspectScene(floating))
    }
    expect(previewFrames.some(frame => frame.opacity < .9 && Math.abs(frame.yaw) > .1)).toBe(true)
    expect(floatingFrames.some(frame => frame.opacity < .9 && Math.abs(frame.yaw) > .1)).toBe(true)
    await expect.poll(async () => (await inspectScene(control, '.showcase-viewport canvas')).names).toContain('athena-enhanced')
    await expect.poll(async () => (await inspectScene(control, '.showcase-viewport canvas')).opacity).toBe(1)
    await expect.poll(async () => (await inspectScene(floating)).names).toContain('athena-enhanced')
    await expect.poll(async () => (await inspectScene(floating)).opacity).toBe(1)
    const selectedScene = await inspectScene(control, '.showcase-viewport canvas')
    expect(selectedScene.names).toContain('enhanced-domed-helmet')
    expect(selectedScene.names).toContain('enhanced-visor')
    expect(selectedScene.names).not.toContain('athena-classic')
    expect(selectedScene.names).not.toContain('showcase-foot-halo')
    expect(selectedScene.avatarScale).toBeLessThan(1.6)
    expect(selectedScene.avatarY).toBe(0)
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('surface=floating'))!.getBounds())).toEqual(floatingBounds)
    expect((await floating.evaluate(() => window.athena!.getSnapshot())).settings).toEqual({ ...original.settings, avatarVariant: 'enhanced' })

    await control.evaluate(() => window.athena!.updateSettings({ avatarEnergyFX: false }))
    await expect.poll(async () => (await inspectScene(floating)).names.includes('enhanced-energy')).toBe(false)
    await expect(control.getByRole('switch', { name: 'Floating Athena' })).toBeVisible()
    await expect(control.getByRole('slider', { name: 'Athena size' })).toHaveValue('280')

    for (const width of [1450, 900]) {
      await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('surface=control'))!.setSize(width, 950), width)
      const portrait = await control.locator('.showcase-option[data-avatar="vroid-athena"]').evaluate(card => {
        const image = card.querySelector('img')!
        const imageRegion = card.querySelector('.showcase-thumbnail')!.getBoundingClientRect()
        const label = card.querySelector('.showcase-option-label')!.getBoundingClientRect()
        return { loaded: image.complete && image.naturalWidth > 0, fit: getComputedStyle(image).objectFit, background: getComputedStyle(card.querySelector('.showcase-thumbnail')!).backgroundColor, blurredNameOverlay: imageRegion.bottom >= label.bottom && getComputedStyle(card.querySelector('.showcase-option-label')!).backdropFilter.includes('blur'), fillsWidth: Math.abs(image.getBoundingClientRect().width - imageRegion.width) < 1, cardWidth: card.getBoundingClientRect().width }
      })
      expect(portrait).toMatchObject({ loaded: true, fit: 'cover', background: 'rgba(0, 0, 0, 0)', blurredNameOverlay: true, fillsWidth: true })
      expect(portrait.cardWidth).toBeLessThanOrEqual(136)
      const vroidCard = control.locator('.showcase-option[data-avatar="vroid-athena"]')
      const nameOverlay = vroidCard.locator('.showcase-option-label')
      await expect(vroidCard.getByText('VRoid Studio')).toHaveCount(0)
      await expect(nameOverlay).toHaveCSS('opacity', '0')
      const cardBeforeHover = await vroidCard.boundingBox()
      await vroidCard.hover()
      await expect(nameOverlay).toHaveCSS('opacity', '1')
      expect(await nameOverlay.evaluate(element => getComputedStyle(element).paddingTop)).toBe('3px')
      expect(await vroidCard.boundingBox()).toEqual(cardBeforeHover)
      await control.locator('.showcase-selection h3').hover()
      await expect(nameOverlay).toHaveCSS('opacity', '0')
      const layout = await control.evaluate(() => {
        const preview = document.querySelector('.showcase-preview')!.getBoundingClientRect()
        const panel = document.querySelector('.showcase-panel')!.getBoundingClientRect()
        const modelPanel = document.querySelector('.showcase-model-panel')!.getBoundingClientRect()
        const avatar = document.querySelector('.companion-avatar-section')!.getBoundingClientRect()
        const controls = document.querySelector('.companion-panel-controls')!.getBoundingClientRect()
        return { previewRight: preview.right, avatarBottom: avatar.bottom, panelLeft: panel.left, panelTop: panel.top, panelBottom: panel.bottom, controlsBottom: controls.bottom, modelPanelWidth: modelPanel.width, controlsInsidePanel: controls.left >= panel.left && controls.right <= panel.right && controls.top >= panel.top && controls.bottom <= panel.bottom, overflow: document.documentElement.scrollWidth > innerWidth }
      })
      expect(layout.panelLeft).toBeGreaterThanOrEqual(layout.previewRight)
      expect(layout.panelTop).toBeLessThan(layout.avatarBottom)
      expect(layout.panelBottom - layout.controlsBottom).toBeLessThanOrEqual(24)
      expect(layout.modelPanelWidth).toBeLessThanOrEqual(270)
      expect(layout.controlsInsidePanel).toBe(true)
      expect(layout.overflow).toBe(false)
      await control.locator('.companion-layout').screenshot({ path: width === 1450 ? 'test-results/showcase-wide.png' : 'test-results/showcase-narrow.png' })
    }

    for (let visit = 0; visit < 2; visit++) {
      await control.getByRole('button', { name: 'Appearance', exact: true }).click()
      await control.getByRole('button', { name: 'My companion', exact: true }).click()
      await expect(control.locator('.companion-layout canvas')).toHaveCount(1)
      await expect.poll(async () => (await inspectScene(control, '.showcase-viewport canvas')).names).toContain('athena-enhanced')
    }

    // The transition keeps the latest selection when the preference changes again mid-fade.
    await control.evaluate(async () => {
      await window.athena!.updateSettings({ avatarVariant: 'classic' })
      await new Promise(resolve => setTimeout(resolve, 150))
      await window.athena!.updateSettings({ avatarVariant: 'enhanced' })
    })
    await expect.poll(async () => (await inspectScene(control, '.showcase-viewport canvas')).opacity).toBe(1)
    await expect.poll(async () => (await inspectScene(control, '.showcase-viewport canvas')).names).toContain('athena-enhanced')
    await control.evaluate(() => window.athena!.updateSettings({ reducedMotion: true, avatarVariant: 'classic' }))
    await expect.poll(async () => (await inspectScene(control, '.showcase-viewport canvas')).particleCount).toBe(0)
    await expect.poll(async () => (await inspectScene(control, '.showcase-viewport canvas')).names).toContain('athena-classic')
    await control.evaluate(() => window.athena!.updateSettings({ reducedMotion: false, avatarVariant: 'enhanced' }))
    await expect.poll(async () => (await inspectScene(control, '.showcase-viewport canvas')).names).toContain('athena-enhanced')

    await app.close()
    session = await launch()
    ;({ app, control, floating } = session)
    const restored = await control.evaluate(() => window.athena!.getSnapshot())
    expect(restored.settings.avatarVariant).toBe('enhanced')
    expect(restored.settings.avatarEnergyFX).toBe(false)
    expect(restored.settings.size).toBe(280)
    expect(restored.settings.pinned).toBe(true)
    await expect.poll(async () => (await inspectScene(floating)).names).toContain('athena-enhanced')
    expect(errors).toEqual([])
  } finally { await session.app.close() }
})
