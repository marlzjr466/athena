import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('Full Mac modes propagate through IPC, remain provider-bound, and survive restart', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'athena-fullmac-desktop-'))
  let app: ElectronApplication | undefined
  const launch = () => electron.launch({ args: ['.'], env: { ...process.env, ATHENA_TEST_DATA: profile } })
  try {
    app = await launch()
    await expect.poll(() => app!.windows().length).toBe(3)
    let control = app.windows().find((page) => page.url().includes('surface=control'))!
    await expect(control.getByRole('button', { name: 'Privacy', exact: true })).toBeVisible()
    await control.evaluate(() => window.athena!.updateSettings({ aiMode: 'local' }))
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = (async () => ({ response: 1, checkboxChecked: false })) as typeof dialog.showMessageBox })
    expect(await control.evaluate(() => window.athena!.setPermissionEnabled({ permission: 'personalFiles', enabled: true }))).toMatchObject({ ok: true })
    for (const mode of ['project-only', 'full-read-only', 'full-read-write'] as const) {
      expect(await control.evaluate((mode) => window.athena!.setFilesystemAccess({ mode }), mode)).toMatchObject({ ok: true, snapshot: { filesystemAccess: { mode, active: mode !== 'project-only' } } })
    }
    await control.evaluate(() => window.athena!.updateSettings({ aiMode: 'cloud' }))
    expect(await control.evaluate(() => window.athena!.getPermissions())).toMatchObject({ filesystemAccess: { active: false } })
    await control.evaluate(() => window.athena!.updateSettings({ aiMode: 'local' }))
    expect(await control.evaluate(() => window.athena!.getPermissions())).toMatchObject({ filesystemAccess: { mode: 'full-read-write', active: true } })
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = (async () => ({ response: 0, checkboxChecked: false })) as typeof dialog.showMessageBox })
    expect(await control.evaluate(() => window.athena!.setFilesystemAccess({ mode: 'full-read-only' }))).toMatchObject({ ok: false })
    expect(await control.evaluate(() => window.athena!.getPermissions())).toMatchObject({ filesystemAccess: { mode: 'full-read-write', active: true } })
    await app.close(); app = await launch()
    await expect.poll(() => app!.windows().length).toBe(3)
    control = app.windows().find((page) => page.url().includes('surface=control'))!
    await expect(control.getByRole('button', { name: 'Privacy', exact: true })).toBeVisible()
    expect(await control.evaluate(() => window.athena!.getPermissions())).toMatchObject({ filesystemAccess: { mode: 'full-read-write', active: true } })
    await control.getByRole('button', { name: 'Privacy', exact: true }).click()
    await expect(control.getByRole('button', { name: /^Full Mac — Read & Write/ })).toHaveAttribute('aria-pressed', 'true')
  } finally { await app?.close() }
})

test('permission opt-ins, real status reads, mocked OS decisions, IPC boundaries and persistence', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'athena-permissions-desktop-'))
  let app: ElectronApplication | undefined
  const launch = () => electron.launch({ args: ['.'], env: { ...process.env, ATHENA_TEST_DATA: profile } })
  try {
    app = await launch()
    await expect.poll(() => app!.windows().length).toBe(3)
    let control = app.windows().find((page) => page.url().includes('surface=control'))!
    const floating = app.windows().find((page) => page.url().includes('surface=floating'))!
    await expect(control.getByRole('button', { name: 'Privacy', exact: true })).toBeVisible()
    const initial = await control.evaluate(() => window.athena!.getPermissions())
    expect(initial.permissions).toHaveLength(6)
    expect(initial.permissions.every((entry) => !entry.enabled && !entry.capabilityAllowed)).toBe(true)
    expect(await control.evaluate(() => window.athena!.getApplications())).toMatchObject({ ok: false })
    expect(await floating.evaluate(() => window.athena!.getApplications().then(() => false, () => true))).toBe(true)
    // Read-only comparison to actual OS state. Never show a real OS prompt in tests.
    const actualMicrophone = await app.evaluate(({ systemPreferences }) => systemPreferences.getMediaAccessStatus('microphone'))
    const mapped = { granted: 'allowed', denied: 'denied', restricted: 'restricted', 'not-determined': 'not-requested', unknown: 'unavailable' }
    expect(initial.permissions.find((p) => p.permission === 'microphone')!.osStatus).toBe(mapped[actualMicrophone])
    expect(await floating.evaluate(() => window.athena!.requestPermission({ permission: 'microphone' }).then(() => false, () => true))).toBe(true)
    expect(await control.evaluate(() => window.athena!.setPermissionEnabled({ permission: 'shell', enabled: true } as never))).toMatchObject({ ok: false })
    expect(await control.evaluate(() => window.athena!.updateSettings({ permissions: { microphone: true } } as never).then(() => false, () => true))).toBe(true)
    await app.evaluate(({ systemPreferences, shell }) => {
      const state = globalThis as unknown as { permissionTestStatus: string; permissionTestRequests: number; permissionTestURL: string }
      state.permissionTestStatus = 'not-determined'; state.permissionTestRequests = 0; state.permissionTestURL = ''
      systemPreferences.getMediaAccessStatus = () => state.permissionTestStatus as ReturnType<typeof systemPreferences.getMediaAccessStatus>
      systemPreferences.askForMediaAccess = async () => { state.permissionTestRequests++; state.permissionTestStatus = 'denied'; return false }
      systemPreferences.isTrustedAccessibilityClient = () => false
      shell.openExternal = async (url) => { state.permissionTestURL = url }
    })
    await control.getByRole('button', { name: 'Privacy', exact: true }).click()
    await expect(control.getByRole('heading', { name: 'Permissions', exact: true })).toBeVisible()
    await control.getByRole('switch', { name: 'Local Browser Verification', exact: true }).click()
    await control.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(control.getByRole('switch', { name: 'Local Browser Verification', exact: true })).not.toBeChecked()
    await control.getByRole('switch', { name: 'Local Browser Verification', exact: true }).click()
    await control.getByRole('button', { name: 'Enable preference', exact: true }).click()
    await expect(control.getByRole('switch', { name: 'Local Browser Verification', exact: true })).toBeChecked()
    expect(await control.evaluate(() => window.athena!.isCapabilityAllowed({ permission: 'browserAutomation' }))).toBe(true)
    await control.getByRole('switch', { name: 'Application Detection', exact: true }).click()
    await expect(control.getByRole('dialog')).toBeVisible()
    await control.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(control.getByRole('switch', { name: 'Application Detection', exact: true })).not.toBeChecked()
    await control.getByRole('switch', { name: 'Application Detection', exact: true }).click()
    await control.getByRole('button', { name: 'Enable preference', exact: true }).click()
    await expect(control.getByRole('switch', { name: 'Application Detection', exact: true })).toBeChecked()
    expect(await control.evaluate(() => window.athena!.isCapabilityAllowed({ permission: 'applicationDetection' }))).toBe(true)
    const detected = await control.evaluate(() => window.athena!.getApplications())
    expect(detected.ok).toBe(true)
    if (detected.ok) expect(Array.isArray(detected.running)).toBe(true)
    await control.getByRole('button', { name: 'Check active and running apps' }).click()
    await expect(control.getByRole('status').filter({ hasText: 'Active app:' })).toBeVisible()
    await control.getByRole('switch', { name: 'Microphone Access', exact: true }).click()
    await control.getByRole('button', { name: 'Enable preference', exact: true }).click()
    await expect(control.getByRole('switch', { name: 'Microphone Access', exact: true })).toBeChecked()
    expect(await app.evaluate(() => (globalThis as unknown as { permissionTestRequests: number }).permissionTestRequests)).toBe(0)
    await control.getByRole('button', { name: 'Request macOS access for Microphone Access', exact: true }).click()
    await expect(control.getByRole('alert')).toContainText('Access is not enabled')
    expect(await control.evaluate(() => window.athena!.isCapabilityAllowed({ permission: 'microphone' }))).toBe(false)
    expect(await app.evaluate(() => (globalThis as unknown as { permissionTestRequests: number }).permissionTestRequests)).toBe(1)
    await control.getByRole('button', { name: 'System Settings for Microphone Access', exact: true }).click()
    expect(await app.evaluate(() => (globalThis as unknown as { permissionTestURL: string }).permissionTestURL)).toBe('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone')
    await app.evaluate(() => { (globalThis as unknown as { permissionTestStatus: string }).permissionTestStatus = 'granted' })
    await control.getByRole('button', { name: 'Refresh permissions', exact: true }).click()
    await expect.poll(() => control.evaluate(() => window.athena!.isCapabilityAllowed({ permission: 'microphone' }))).toBe(true)
    await control.getByRole('switch', { name: 'Microphone Access', exact: true }).click()
    await expect(control.getByRole('switch', { name: 'Microphone Access', exact: true })).not.toBeChecked()
    expect(await control.evaluate(() => window.athena!.getPermissionStatus({ permission: 'microphone' }))).toMatchObject({ enabled: false, osStatus: 'allowed', capabilityAllowed: false })
    await control.screenshot({ path: 'test-results/permissions.png' })
    const saved = JSON.parse(await readFile(join(profile, 'permissions.json'), 'utf8'))
    expect(saved).toEqual({ version: 2, enabled: { microphone: false, screenCapture: false, applicationDetection: true, desktopAutomation: false, personalFiles: false, browserAutomation: true }, filesystemAccess: { mode: 'project-only', active: false, provider: null } })
    await app.close(); app = await launch()
    await expect.poll(() => app!.windows().length).toBe(3)
    control = app.windows().find((page) => page.url().includes('surface=control'))!
    await expect(control.getByRole('button', { name: 'Privacy', exact: true })).toBeVisible()
    expect(await control.evaluate(() => window.athena!.getPermissionStatus({ permission: 'applicationDetection' }))).toMatchObject({ enabled: true, osStatus: 'not-required', capabilityAllowed: true })
    expect(await control.evaluate(() => window.athena!.isCapabilityAllowed({ permission: 'microphone' }))).toBe(false)
    expect(await control.evaluate(() => window.athena!.isCapabilityAllowed({ permission: 'browserAutomation' }))).toBe(true)
  } finally { await app?.close() }
})
