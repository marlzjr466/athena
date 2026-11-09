import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('native companion lifecycle, controls, movement, security, and persistence', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'athena-desktop-test-'))
  let app: ElectronApplication | undefined
  const errors: string[] = []
  async function launch() {
    const instance = await electron.launch({ args: ['.'], env: { ...process.env, ATHENA_TEST_DATA: profile }, timeout: 30_000 })
    instance.process().stdout?.on('data', (data: Buffer) => process.stdout.write(data))
    instance.on('window', (page) => page.on('pageerror', (error) => errors.push(error.message)))
    await expect.poll(() => instance.windows().length).toBe(3)
    const control = instance.windows().find((page) => page.url().includes('surface=control'))!
    await expect(control.getByRole('heading', { name: /A little presence/ })).toBeVisible()
    return { instance, control }
  }
  const snapshot = (page: Page) => page.evaluate(() => window.athena!.getSnapshot())
  try {
    let session = await launch()
    app = session.instance
    let control = session.control
    const floating = app.windows().find((page) => page.url().includes('surface=floating'))!
    await expect(floating.locator('canvas')).toBeVisible()
    await expect.poll(async () => (await snapshot(control)).visible).toBe(true)
    const rendererProcesses = await app.evaluate(({ app }) => app.getAppMetrics().filter((metric) => metric.type === 'Tab').map((metric) => metric.sandboxed))
    expect(rendererProcesses.length).toBeGreaterThan(0)
    for (const sandboxed of rendererProcesses) expect(sandboxed).toBe(true)
    for (const page of app.windows()) expect(await page.evaluate(() => Object.keys(window.athena!).sort())).toEqual(['activateAI', 'beginDrag', 'command', 'endDrag', 'getAIStatus', 'getSnapshot', 'onNavigate', 'onSnapshot', 'removeAIKey', 'selectAIModel', 'testAIConnection', 'updateSettings', 'getChat', 'sendChat', 'retryChat', 'stopChat', 'clearChat', 'copyChatText', 'onChat', 'getPermissions', 'getPermissionStatus', 'setPermissionEnabled', 'requestPermission', 'openPermissionSettings', 'isCapabilityAllowed', 'chatSession', 'chatContext', 'searchChats'].sort())
    expect(await control.evaluate(() => typeof (window as unknown as { require?: unknown }).require)).toBe('undefined')
    const floatingProperties = await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().includes('surface=floating'))!
      return { alwaysOnTop: window.isAlwaysOnTop(), background: window.getBackgroundColor(), resizable: window.isResizable() }
    })
    // Electron's getter returns RGB even when the backing native window has alpha.
    expect(floatingProperties).toEqual({ alwaysOnTop: true, background: '#000000', resizable: false })
    expect(await floating.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgba(0, 0, 0, 0)')
    await control.screenshot({ path: 'test-results/control-center.png' })
    await floating.screenshot({ path: 'test-results/floating-athena.png', omitBackground: true })
    const cornerAlpha = await app.evaluate(async ({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().includes('surface=floating'))!
      const image = await window.webContents.capturePage()
      return image.toBitmap()[3]
    })
    expect(cornerAlpha).toBe(0)

    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().includes('surface=control'))!.focus())
    await control.getByRole('switch', { name: 'Pin Athena', exact: true }).click()
    await expect.poll(async () => (await snapshot(control)).settings.pinned).toBe(true)
    expect((await snapshot(control)).settings.randomMovement).toBe(true)
    await control.getByRole('button', { name: 'Large', exact: true }).click()
    await expect.poll(async () => (await snapshot(control)).settings.size).toBe(280)
    const bounds = () => app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().includes('surface=floating'))!.getBounds())
    await expect.poll(async () => (await bounds()).width).toBe(280)

    // Drive native cursor coordinates deterministically; movement still uses real BrowserWindows and IPC.
    const origin = await bounds()
    await app.evaluate(({ screen }, point) => {
      const state = globalThis as unknown as { originalCursor: typeof screen.getCursorScreenPoint; testCursor: { x: number; y: number } }
      state.originalCursor = screen.getCursorScreenPoint
      state.testCursor = point
      screen.getCursorScreenPoint = () => state.testCursor
    }, { x: origin.x + 140, y: origin.y + 140 })
    await floating.evaluate(() => window.athena!.beginDrag())
    await app.evaluate(() => { const state = globalThis as unknown as { testCursor: { x: number; y: number } }; state.testCursor = { x: -100_000, y: -100_000 } })
    await expect.poll(async () => (await bounds()).x).toBeLessThan(origin.x)
    expect(await floating.evaluate(() => window.athena!.endDrag())).toBe(true)
    const dragged = await bounds()
    const displays = (await snapshot(control)).displays
    expect(displays.some((area) => dragged.x >= area.x && dragged.y >= area.y && dragged.x + dragged.width <= area.x + area.width && dragged.y + dragged.height <= area.y + area.height)).toBe(true)
    await app.evaluate(({ screen }) => { screen.getCursorScreenPoint = (globalThis as unknown as { originalCursor: typeof screen.getCursorScreenPoint }).originalCursor })

    await control.evaluate(() => window.athena!.command('open-panel'))
    const panel = app.windows().find((page) => page.url().includes('surface=panel'))!
    await expect(panel.getByRole('heading', { name: 'A little hello.' })).toBeVisible()
    await panel.screenshot({ path: 'test-results/mini-panel.png', omitBackground: true })
    await panel.getByRole('button', { name: 'A little smaller', exact: true }).click()
    await expect.poll(async () => (await snapshot(control)).settings.size).toBe(260)
    await expect(panel.getByText('A little adjustment. I’m now 260 pixels tall.')).toBeVisible()
    await panel.getByRole('button', { name: 'Close panel', exact: true }).click()

    const before = await bounds()
    await control.evaluate(() => window.athena!.updateSettings({ randomMovement: true, pinned: false, wanderIntervalSeconds: 10, movementSpeed: 5, reducedMotion: false }))
    const systemReduced = (await snapshot(control)).reducedMotion
    if (!systemReduced) await expect.poll(async () => JSON.stringify(await bounds()) !== JSON.stringify(before), { timeout: 15_000 }).toBe(true)
    await control.evaluate(() => window.athena!.command('pin'))
    await control.evaluate(() => window.athena!.command('hide'))
    expect((await snapshot(control)).visible).toBe(false)
    await control.evaluate(() => window.athena!.command('show'))
    expect((await snapshot(control)).visible).toBe(true)
    await expect(control.evaluate(() => window.athena!.updateSettings({ size: 900 }))).rejects.toThrow()
    await control.getByRole('button', { name: 'Appearance', exact: true }).click()
    await expect(control.getByRole('heading', { name: 'A companion, your way.' })).toBeVisible()
    await control.screenshot({ path: 'test-results/appearance-settings.png' })
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().includes('surface=control'))!.close())
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(3)
    await app.close()
    app = undefined

    session = await launch()
    app = session.instance
    control = session.control
    expect((await snapshot(control)).settings.size).toBe(260)
    expect((await snapshot(control)).settings.pinned).toBe(true)
    expect((await snapshot(control)).settings.randomMovement).toBe(true)
    expect((await snapshot(control)).settings.wanderIntervalSeconds).toBe(10)
    expect((await snapshot(control)).settings.movementSpeed).toBe(5)
    expect(errors).toEqual([])
  } finally { await app?.close() }
})
