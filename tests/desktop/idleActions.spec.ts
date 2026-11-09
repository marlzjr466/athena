import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fixedPositions } from '../../shared/flight'

test('idle actions run at the sole enabled stop, stay local, cancel safely and persist', async () => {
  test.setTimeout(80000)
  const profile = await mkdtemp(join(tmpdir(), 'athena-actions-test-'))
  let app = await electron.launch({ args: ['.'], env: { ...process.env, ATHENA_TEST_DATA: profile } })
  try {
    await expect.poll(() => app.windows().length).toBe(3)
    let control = app.windows().find((page) => page.url().includes('surface=control'))!
    const floating = app.windows().find((page) => page.url().includes('surface=floating'))!
    const errors: string[] = []
    floating.on('pageerror', (error) => errors.push(error.message))
    await control.evaluate(() => window.athena!.updateSettings({ randomMovement: false, randomActions: false, movementSpeed: 10, wanderIntervalSeconds: 10, actionIntervalSeconds: 10 }))
    await control.getByRole('button', { name: 'Floating & movement', exact: true }).click()
    for (const label of ['Top Right', 'Mid Left', 'Mid Right', 'Bottom Left', 'Bottom Right']) await control.getByRole('switch', { name: label, exact: true }).click()
    await expect(control.getByRole('switch', { name: 'Top Left', exact: true })).toBeDisabled()
    expect((await control.evaluate(() => window.athena!.getSnapshot())).settings.enabledPositions).toEqual(['top-left'])
    await control.getByRole('switch', { name: 'Free to Wander', exact: true }).click()
    const bounds = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('surface=floating'))!.getBounds())
    const snapshot = await control.evaluate(() => window.athena!.getSnapshot())
    const target = fixedPositions(snapshot.displays[0], await bounds(), snapshot.settings.edgePadding)['top-left']
    await expect.poll(async () => {
      const b = await bounds()
      return Math.hypot(b.x - target.x, b.y - target.y)
    }, { timeout: 16000 }).toBe(0)
    await expect.poll(async () => (await control.evaluate(() => window.athena!.getSnapshot())).state).toBe('idle')
    await control.evaluate(() => window.athena!.updateSettings({ enabledActions: ['wave'] }))
    await control.getByRole('switch', { name: 'Random Actions', exact: true }).click()
    await expect(control.getByRole('slider', { name: 'Action interval', exact: true })).toBeEnabled()
    const enabledAt = Date.now()
    const stationary = await bounds()
    await expect.poll(async () => {
      const current = await control.evaluate(() => window.athena!.getSnapshot())
      expect(await bounds()).toEqual(stationary)
      expect(current.flight).toBe(null)
      if (Date.now() - enabledAt < 9500) expect(current.idleAction).toBe(null)
      return current.idleAction?.id
    }, { timeout: 14000, intervals: [100] }).toBe('wave')
    await expect.poll(async () => {
      const action = (await control.evaluate(() => window.athena!.getSnapshot())).idleAction
      return action ? (Date.now() - action.startedAt) / action.durationMs : 0
    }, { intervals: [30] }).toBeGreaterThan(0.3)
    await floating.screenshot({ path: 'test-results/action-wave.png', omitBackground: true })
    await control.getByRole('switch', { name: 'Wave / Hello', exact: true }).click()
    await expect.poll(async () => (await control.evaluate(() => window.athena!.getSnapshot())).idleAction).toBe(null)
    await expect(control.getByText('All actions are off. Athena will rest quietly.')).toBeVisible()
    await control.getByRole('switch', { name: 'Front Flip', exact: true }).click()
    await expect.poll(async () => (await control.evaluate(() => window.athena!.getSnapshot())).idleAction?.id, { timeout: 14000, intervals: [50] }).toBe('front-flip')
    // Capture in the middle of the flip using its actual shared timeline.
    await expect.poll(async () => {
      const action = (await control.evaluate(() => window.athena!.getSnapshot())).idleAction!
      return action ? (Date.now() - action.startedAt) / action.durationMs : 0
    }, { intervals: [30] }).toBeGreaterThan(0.4)
    await floating.screenshot({ path: 'test-results/action-flip.png', omitBackground: true })
    expect(await bounds()).toEqual(stationary)
    await floating.evaluate(() => window.athena!.beginDrag())
    await expect.poll(async () => (await control.evaluate(() => window.athena!.getSnapshot())).idleAction).toBe(null)
    await floating.evaluate(() => window.athena!.endDrag())
    await control.getByRole('switch', { name: 'Happy Pose', exact: true }).scrollIntoViewIfNeeded()
    await control.screenshot({ path: 'test-results/action-settings.png' })
    expect(errors).toEqual([])
    await app.close()
    app = await electron.launch({ args: ['.'], env: { ...process.env, ATHENA_TEST_DATA: profile } })
    await expect.poll(() => app.windows().length).toBe(3)
    control = app.windows().find((page) => page.url().includes('surface=control'))!
    const restored = (await control.evaluate(() => window.athena!.getSnapshot())).settings
    expect(restored.enabledPositions).toEqual(['top-left'])
    expect(restored.enabledActions).toEqual(['front-flip'])
    expect(restored.actionIntervalSeconds).toBe(10)
    expect(restored.randomActions).toBe(true)
  } finally { await app.close() }
})
