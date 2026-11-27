import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('Accessibility recovery identifies the running copy without inventing or changing OS trust', async () => {
  test.skip(process.platform !== 'darwin', 'macOS app-bundle permission recovery')
  const profile = await mkdtemp(join(tmpdir(), 'athena-accessibility-recovery-'))
  await writeFile(join(profile, 'settings.json'), JSON.stringify({ floatingEnabled: false, randomActions: false, randomMovement: false, webAccess: { webSearchEnabled: false, automaticStartup: false } }))
  const app = await electron.launch({ args: ['.'], env: { ...process.env, ATHENA_TEST_DATA: profile } })
  try {
    await expect.poll(() => app.windows().some(page => page.url().includes('surface=control'))).toBe(true)
    const control = app.windows().find(page => page.url().includes('surface=control'))!
    const floating = app.windows().find(page => page.url().includes('surface=floating'))!
    await app.evaluate(({ systemPreferences, shell }) => {
      const fixture = globalThis as unknown as { trusted: boolean; prompts: number; revealed: string[] }
      fixture.trusted = false; fixture.prompts = 0; fixture.revealed = []
      systemPreferences.isTrustedAccessibilityClient = prompt => { if (prompt) fixture.prompts++; return fixture.trusted }
      shell.showItemInFolder = path => { fixture.revealed.push(path) }
    })
    await control.evaluate(() => window.athena!.setPermissionEnabled({ permission: 'accessibilityControl', enabled: true }))
    await control.getByRole('button', { name: 'Privacy', exact: true }).click()
    const card = control.locator('.permission-card[aria-label="Accessibility UI Control"]')
    await expect(card).toContainText('Capability gate: Blocked')
    await expect(card).toContainText('another copy or an older build')
    const initial = await control.evaluate(() => window.athena!.getPermissionStatus({ permission: 'accessibilityControl' }))
    expect(initial.appPath).toMatch(/\.app$/)
    await expect(card.locator('code')).toHaveText(initial.appPath!)
    await card.getByRole('button', { name: 'Show this Athena app' }).click()
    expect(await app.evaluate(() => (globalThis as unknown as { revealed: string[] }).revealed)).toEqual([initial.appPath])
    expect(await app.evaluate(() => (globalThis as unknown as { prompts: number }).prompts)).toBe(0)
    expect(await control.evaluate(() => window.athena!.openPermissionSettings({ permission: 'accessibilityControl', operation: 'reveal-app', path: '/another.app' } as never))).toMatchObject({ ok: false })
    expect(await floating.evaluate(() => window.athena!.openPermissionSettings({ permission: 'accessibilityControl', operation: 'reveal-app' }).then(() => false, () => true))).toBe(true)
    await app.evaluate(() => { (globalThis as unknown as { trusted: boolean }).trusted = true })
    await control.getByRole('button', { name: 'Refresh permissions' }).click()
    await expect(card).toContainText('Capability gate: Allowed')
    await app.evaluate(() => { (globalThis as unknown as { trusted: boolean }).trusted = false })
    await control.getByRole('button', { name: 'Refresh permissions' }).click()
    await expect(card).toContainText('Capability gate: Blocked')
  } finally { await app.close(); await rm(profile, { recursive: true, force: true }) }
})
