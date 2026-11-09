import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { preview } from 'vite'

test('Cursor settings reads cached status until an explicit check and preserves a verified connection across visits', async () => {
  test.skip(process.env.ATHENA_CURSOR_STATUS_LIVE_TEST !== '1', 'Requires an existing signed-in Cursor CLI account; sends no prompts.')
  const profile = await mkdtemp(join(tmpdir(), 'athena-cursor-status-'))
  const server = await preview({ configFile: false, build: { outDir: 'out/renderer' }, preview: { host: '127.0.0.1', port: 0 } })
  const app = await electron.launch({ args: ['.'], env: { ...process.env, ATHENA_TEST_DATA: profile, ELECTRON_RENDERER_URL: server.resolvedUrls!.local[0].replace(/\/$/, '') } })
  try {
    await expect.poll(() => app.windows().some((page) => page.url().includes('surface=control'))).toBe(true)
    const control = app.windows().find((page) => page.url().includes('surface=control'))!
    await expect(control.getByRole('button', { name: 'AI', exact: true })).toBeVisible()
    await control.evaluate(() => window.athena!.updateSettings({ randomMovement: false, randomActions: false, aiMode: 'cursor' }))
    await control.getByRole('button', { name: 'AI', exact: true }).click()
    await expect(control.getByRole('button', { name: 'Check Cursor status' })).toBeEnabled()
    expect(await control.evaluate(() => window.athena!.getCursorStatus({ cachedOnly: true }))).toMatchObject({ authenticationStatus: 'unknown', version: null })
    // The generic AI status endpoint must also be passive.
    await control.evaluate(() => window.athena!.getAIStatus())
    expect(await control.evaluate(() => window.athena!.getCursorStatus({ cachedOnly: true }))).toMatchObject({ authenticationStatus: 'unknown', version: null })
    await control.getByRole('button', { name: 'Check Cursor status' }).click()
    await expect(control.getByText('● Connected', { exact: true })).toBeVisible({ timeout: 75_000 })
    const verified = await control.evaluate(() => window.athena!.getCursorStatus({ cachedOnly: true }))
    expect(verified.authenticated).toBe(true)
    expect(verified.modelCatalogAvailable).toBe(true)
    await control.getByRole('button', { name: 'Conversation', exact: true }).click()
    await control.getByRole('button', { name: 'AI', exact: true }).click()
    await expect(control.getByText('● Connected', { exact: true })).toBeVisible()
    expect(await control.evaluate(() => window.athena!.getCursorStatus({ cachedOnly: true }))).toEqual(verified)
    await control.screenshot({ path: 'test-results/cursor-connected.png' })
  } finally { await app.close(); await new Promise<void>((resolve) => server.httpServer.close(() => resolve())) }
})
