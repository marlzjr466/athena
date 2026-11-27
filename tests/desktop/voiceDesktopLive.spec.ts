import { test, expect, _electron as electron } from '@playwright/test'
import { build } from 'esbuild'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

test('signed Athena verifies native desktop voice actions and reports capture availability', async () => {
  test.skip(process.platform !== 'darwin' || process.env.ATHENA_DESKTOP_LIVE !== '1', 'Opt-in real macOS Accessibility and Screen Recording test')
  test.setTimeout(120_000)
  const profile = await mkdtemp(join(tmpdir(), 'athena-desktop-live-'))
  const adapter = join(profile, 'desktop-adapter.cjs')
  await build({ stdin: { contents: `export { MacOSDesktopPlatform } from './electron/main/desktop/macOSDesktopPlatform'; export { MacOSScreenCapture } from './electron/main/screenCapture/macOSScreenCapture'`, resolveDir: process.cwd(), loader: 'ts' }, outfile: adapter, bundle: true, platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'silent' })
  await writeFile(join(profile, 'settings.json'), JSON.stringify({ floatingEnabled: false, randomActions: false, randomMovement: false, webAccess: { webSearchEnabled: false, automaticStartup: false } }))
  const app = await electron.launch({ executablePath: resolve('release/mac-arm64/Athena.app/Contents/MacOS/Athena'), args: [`--user-data-dir=${profile}`], env: { ...process.env, ATHENA_TEST_DATA: profile } })
  try {
    expect(await realpath(await app.evaluate(({ app }) => app.getPath('userData')))).toBe(await realpath(profile))
    expect(await app.evaluate(({ systemPreferences }) => systemPreferences.isTrustedAccessibilityClient(false)), 'The exact signed app must have actual OS authorization').toBe(true)
    if (process.env.ATHENA_CAPTURE_PERMISSION_REQUEST === '1') {
      await expect.poll(() => app.windows().some(page => page.url().includes('surface=control'))).toBe(true)
      const control = app.windows().find(page => page.url().includes('surface=control'))!
      await control.evaluate(async () => {
        await window.athena!.setPermissionEnabled({ permission: 'screenCapture', enabled: true })
        await window.athena!.requestPermission({ permission: 'screenCapture' })
      })
    }
    const result = await app.evaluate(async ({ app, systemPreferences }, adapter) => {
      const require = process.getBuiltinModule('module').createRequire(`${app.getAppPath()}/package.json`)
      const { MacOSDesktopPlatform, MacOSScreenCapture } = require(adapter)
      const desktop = new MacOSDesktopPlatform(), signal = new AbortController().signal
      try {
        const alreadyRunning = (await desktop.runningApplications(signal)).some((item: { app: string }) => item.app === 'com.apple.calculator')
        const opened = await desktop.openApplication('calculator', signal)
        const observed = await desktop.inspectAccessibility('calculator', signal)
        const seven = observed.elements.find((item: { label: string; role: string }) => item.role === 'AXButton' && /^(7|seven)$/i.test(item.label))
        const clicked = seven ? await desktop.clickAccessibleElement('calculator', seven.label, signal) : undefined
        const after = await desktop.inspectAccessibility('calculator', signal)
        let capture: { width: number; height: number; bytes: number } | undefined
        if (systemPreferences.getMediaAccessStatus('screen') === 'granted') {
          const screen = new MacOSScreenCapture()
          try {
            const window = (await screen.windows(signal)).find((item: { name: string }) => /calculator/i.test(item.name))
            if (window) { const [image] = await screen.captureWindow(window, signal); capture = { width: image.width, height: image.height, bytes: image.dataURL.length } }
          } finally { screen.dispose() }
        }
        return { alreadyRunning, opened, observed, clicked, after, capture, screenStatus: systemPreferences.getMediaAccessStatus('screen') }
      } finally { desktop.dispose() }
    }, adapter)
    // Only Calculator fixture metadata is persisted; no screenshot or other app content.
    await writeFile('/tmp/athena-desktop-live-results.json', JSON.stringify(result, null, 2))
    expect(result.opened.ok).toBe(true)
    expect(result.observed.elements.length).toBeGreaterThan(0)
    expect(result.clicked).toMatchObject({ ok: true, verified: true })
    expect(result.after.elements.some((item: { value?: string }) => /7/.test(item.value ?? ''))).toBe(true)
    if (result.screenStatus === 'granted') {
      expect(result.capture?.width).toBeGreaterThan(0)
      expect(result.capture?.height).toBeGreaterThan(0)
    } else test.info().annotations.push({ type: 'blocked', description: `Selected-window capture: actual macOS permission is ${result.screenStatus}. Not counted as passed.` })
    const control = app.windows().find(page => page.url().includes('surface=control'))!
    const floating = app.windows().find(page => page.url().includes('surface=floating'))!
    await control.evaluate(async () => {
      for (const permission of ['microphone', 'desktopAutomation', 'accessibilityControl'] as const) await window.athena!.setPermissionEnabled({ permission, enabled: true })
      const { settings } = await window.athena!.getSnapshot()
      await window.athena!.updateSettings({ aiMode: 'local', localAI: { ...settings.localAI, speechEngine: 'whisper-cli', speechModelPath: '/tmp/transcript-test-not-used' }, voiceInteraction: { ...settings.voiceInteraction, handsFreeEnabled: true }, automationPermissions: { ...settings.automationPermissions, desktopApplicationControl: true, desktopUIInteraction: true } })
    })
    const lease = await floating.evaluate(async () => window.athena!.enableHandsFree((await window.athena!.getChat()).sessionId))
    expect(lease.ok, lease.message).toBe(true)
    const voice = await floating.evaluate(ownership => window.athena!.answerHandsFree({ text: 'Click "7" in Calculator', ownership }), lease.ownership!)
    expect(voice, JSON.stringify(voice)).toMatchObject({ ok: true, text: expect.stringContaining('state changed') })
    await control.evaluate(async () => { const { settings } = await window.athena!.getSnapshot(); await window.athena!.updateSettings({ automationPermissions: { ...settings.automationPermissions, desktopUIInteraction: false } }) })
    expect(await floating.evaluate(ownership => window.athena!.answerHandsFree({ text: 'Click "7" in Calculator', ownership }), lease.ownership!)).toMatchObject({ ok: false })
    await writeFile('/tmp/athena-desktop-live-results.json', JSON.stringify({ ...result, voiceRegistry: true, disabledPermissionBlocked: true }, null, 2))
  } finally { await app.close(); await rm(profile, { recursive: true, force: true }) }
})
