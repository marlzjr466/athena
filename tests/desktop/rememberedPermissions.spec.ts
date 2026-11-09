import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { emptyPermissionPreferences } from '../../shared/permissions'

test('remembered permissions management uses secure IPC and persists in an isolated desktop profile', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'athena-remembered-desktop-'))
  // Fixture only: real grant decisions are covered through ChatController tests.
  const id = randomUUID()
  await writeFile(join(profile, 'permissions.json'), JSON.stringify({ version: 2, enabled: emptyPermissionPreferences(), remembered: { enabled: true, rules: [{ id, scope: { operation: 'open_application', project: 'desktop', resources: ['vscode'] }, grantedAt: Date.now() }] } }))
  let app: ElectronApplication | undefined
  const launch = () => electron.launch({ args: ['.'], env: { ...process.env, ATHENA_TEST_DATA: profile } })
  try {
    app = await launch()
    await expect.poll(() => app!.windows().length).toBe(3)
    let page = app.windows().find(page => page.url().includes('surface=control'))!
    await page.getByRole('button', { name: 'Privacy', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Remembered permissions', exact: true })).toBeVisible()
    await expect(page.getByText('vscode', { exact: true })).toBeVisible()
    await page.getByRole('switch', { name: 'Enable Always allow' }).click()
    await expect.poll(() => page.evaluate(() => window.athena!.getPermissions())).toMatchObject({ remembered: { enabled: false } })
    // Renderer cannot submit a fabricated grant or resource through settings IPC.
    expect(await page.evaluate(() => window.athena!.updateRememberedPermissions({ action: 'grant', scope: {} } as never))).toMatchObject({ ok: false })
    await app.close(); app = await launch()
    await expect.poll(() => app!.windows().length).toBe(3)
    page = app.windows().find(page => page.url().includes('surface=control'))!
    await page.getByRole('button', { name: 'Privacy', exact: true }).click()
    await expect(page.getByRole('switch', { name: 'Enable Always allow' })).toHaveAttribute('aria-checked', 'false')
    await page.getByRole('button', { name: 'Revoke', exact: true }).click()
    await expect.poll(async () => (await page.evaluate(() => window.athena!.getPermissions())).remembered?.rules[0].revokedAt).toBeGreaterThan(0)
    await app.close(); app = await launch()
    await expect.poll(() => app!.windows().length).toBe(3)
    page = app.windows().find(page => page.url().includes('surface=control'))!
    await expect.poll(() => page.evaluate(() => window.athena!.getPermissions())).toMatchObject({ remembered: { enabled: false, rules: [{ id, revokedAt: expect.any(Number) }] } })
  } finally { await app?.close() }
})
