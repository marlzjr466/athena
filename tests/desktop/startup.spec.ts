import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

async function launch(startHidden = false, duration?: string, missing?: 'vrm' | 'vrma') {
  const profile = await mkdtemp(join(tmpdir(), 'athena-startup-'))
  if (startHidden) await writeFile(join(profile, 'settings.json'), JSON.stringify({ startHidden: true }))
  const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')), ATHENA_TEST_DATA: profile, ...(duration ? { ATHENA_SPLASH_DURATION_SECONDS: duration } : {}) }
  delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({ args: ['.'], env, timeout: 30000 })
  if (missing) await app.context().route(new RegExp(`\\.${missing}(?:$|\\?)`), route => route.abort())
  const splash = await app.firstWindow()
  await expect(splash.locator('.splash')).toHaveClass(/playing/)
  return { app, splash }
}
async function nativeWindows(app: ElectronApplication) {
  return app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => ({
    url: window.webContents.getURL(), visible: window.isVisible(), opacity: window.getOpacity(),
  })))
}

test('cinematic startup shows the real VRM, gates activation, and crossfades to the existing workspace', async () => {
  const { app, splash } = await launch()
  const errors: string[] = []
  splash.on('pageerror', error => errors.push(error.message))
  try {
    expect(await splash.evaluate(() => window.athena)).toBeUndefined()
    await expect.poll(async () => (await nativeWindows(app)).length).toBe(4)
    expect((await nativeWindows(app)).filter(window => window.visible).map(window => window.url)).toEqual(['athena://renderer/splash.html'])
    await app.evaluate(({ app }) => app.emit('second-instance', {}, [], ''))
    expect((await nativeWindows(app)).filter(window => window.visible)).toHaveLength(1)
    await expect(splash.locator('.splash-character')).toHaveAttribute('data-model', 'ready', { timeout: 4000 })
    await expect.poll(() => splash.evaluate(async () => Date.now() - (await window.athenaSplash!.getState()).startedAt), { intervals: [50] }).toBeGreaterThanOrEqual(4200)
    await expect(splash.locator('.splash-character')).toHaveClass(/revealed/)
    expect(await splash.locator('.splash-character').evaluate(element => Number(getComputedStyle(element).opacity))).toBeGreaterThan(.9)
    await splash.screenshot({ path: 'test-results/startup-identity.png' })
    await expect.poll(async () => {
      const windows = await nativeWindows(app)
      return windows.some(window => window.url.includes('splash.html') && window.opacity < .95 && window.opacity > 0)
        && windows.some(window => window.url.includes('surface=control') && window.visible)
    }, { intervals: [50], timeout: 4000 }).toBe(true)
    await expect.poll(() => app.windows().length, { timeout: 4000 }).toBe(3)
    const control = app.windows().find(page => page.url().includes('surface=control'))!
    await expect(control.getByRole('heading', { name: 'Choose your Avatar' })).toBeVisible()
    expect((await nativeWindows(app)).find(window => window.url.includes('surface=floating'))?.visible).toBe(true)
    await control.screenshot({ path: 'test-results/startup-workspace.png' })
    expect(errors).toEqual([])
  } finally { await app.close() }
})

test('start-hidden remains hidden after a five-second introduction', async () => {
  const { app } = await launch(true, '5')
  try {
    await expect.poll(() => app.windows().length, { timeout: 10000 }).toBe(3)
    expect((await nativeWindows(app)).every(window => !window.visible)).toBe(true)
  } finally { await app.close() }
})

for (const asset of ['vrm', 'vrma'] as const) test(`missing ${asset} assets leave the typography intro and still open Athena`, async () => {
  const { app, splash } = await launch(false, '5', asset)
  try {
    await expect(splash.locator('.splash-character')).toHaveAttribute('data-fallback', 'true', { timeout: 4000 })
    await expect(splash.getByRole('heading', { name: 'Athena', exact: true })).toBeVisible()
    await expect.poll(() => app.windows().length, { timeout: 10000 }).toBe(3)
    expect((await nativeWindows(app)).find(window => window.url.includes('surface=control'))?.visible).toBe(true)
  } finally { await app.close() }
})

test('closing Athena during its introduction releases the splash and exits', async () => {
  const { app } = await launch()
  const process = app.process()
  const closed = app.waitForEvent('close')
  await app.evaluate(({ app }) => app.quit())
  await closed
  expect(process.exitCode).toBe(0)
})

test('both production preloads are self-contained for the Electron sandbox', async () => {
  for (const file of ['preload', 'splash']) {
    const source = await readFile(`out/preload/${file}.cjs`, 'utf8')
    expect(/require\(["']\.\//.test(source)).toBe(false)
  }
})
