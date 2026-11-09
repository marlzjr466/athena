import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fixedPositions } from '../../shared/flight'

test('Free to Wander moves the visible native window after 30 seconds, including on battery', async () => {
  test.setTimeout(85_000)
  const profile = await mkdtemp(join(tmpdir(), 'athena-wander-test-'))
  const app = await electron.launch({ args: ['.'], env: { ...process.env, ATHENA_TEST_DATA: profile } })
  app.process().stdout?.on('data', (data: Buffer) => process.stdout.write(data))
  try {
    await expect.poll(() => app.windows().length).toBe(3)
    const control = app.windows().find((page) => page.url().includes('surface=control'))!
    const floating = app.windows().find((page) => page.url().includes('surface=floating'))!
    await expect(control.getByRole('heading', { name: /A little presence/ })).toBeVisible()
    // Reproduce the old permanent battery blocker with battery saving still enabled.
    await app.evaluate(({ powerMonitor, systemPreferences }) => {
      powerMonitor.isOnBatteryPower = () => true
      const original = systemPreferences.getAnimationSettings()
      systemPreferences.getAnimationSettings = () => ({ ...original, prefersReducedMotion: false })
    })
    await control.evaluate(() => window.athena!.updateSettings({ randomMovement: false }))
    const initial = await control.evaluate(() => window.athena!.getSnapshot())
    expect(initial.settings.wanderIntervalSeconds).toBe(30)
    expect(initial.settings.reduceOnBattery).toBe(true)
    expect(initial.onBattery).toBe(true)
    const bounds = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().includes('surface=floating'))!.getBounds())
    const start = await bounds()
    await control.getByRole('button', { name: 'Floating & movement', exact: true }).click()
    const slider = control.getByRole('slider', { name: 'Movement interval' })
    await expect(slider).toBeDisabled()
    await control.getByRole('switch', { name: 'Free to Wander', exact: true }).click()
    await expect(slider).toBeEnabled()
    const enabledAt = Date.now()
    await control.screenshot({ path: 'test-results/wander-settings.png' })
    const samples: Array<{ x: number; y: number }> = []
    await expect.poll(async () => {
      const point = await bounds()
      samples.push(point)
      const moved = Math.hypot(point.x - start.x, point.y - start.y) > 2
      if (Date.now() - enabledAt < 29_500) expect(moved).toBe(false)
      return moved
    }, { timeout: 36_000, intervals: [250] }).toBe(true)
    expect(Date.now() - enabledAt).toBeGreaterThanOrEqual(29_500)
    const firstFlight = (await control.evaluate(() => window.athena!.getSnapshot())).flight!
    expect(firstFlight.speed).toBe(1)
    expect(firstFlight.phase).not.toBe('idle')
    const landingSamples = app.evaluate(async ({ BrowserWindow }, flight) => {
      const window = BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().includes('surface=floating'))!
      const samples: Array<{ progress: number; x: number; y: number }> = []
      await new Promise<void>((resolve) => {
        const timer = setInterval(() => {
          const progress = (Date.now() - flight.startedAt) / flight.durationMs
          if (progress >= 0.85) { const { x, y } = window.getBounds(); samples.push({ progress, x, y }) }
          if (progress >= 1.05) { clearInterval(timer); resolve() }
        }, 8)
      })
      return samples
    }, firstFlight)
    await floating.screenshot({ path: 'test-results/flight-1x.png', omitBackground: true })
    await expect.poll(async () => (await control.evaluate(() => window.athena!.getSnapshot())).flight?.phase, { timeout: 5000, intervals: [30] }).toBe('turning')
    expect((Date.now() - firstFlight.startedAt) / firstFlight.durationMs).toBeLessThan(0.5)
    await floating.screenshot({ path: 'test-results/flight-turn.png', omitBackground: true })
    await expect.poll(async () => {
      samples.push(await bounds())
      return (await control.evaluate(() => window.athena!.getSnapshot())).flight?.phase
    }, { timeout: 3000, intervals: [30] }).toBe('flying')
    await floating.screenshot({ path: 'test-results/flight-superman.png', omitBackground: true })
    await expect.poll(async () => {
      samples.push(await bounds())
      return (await control.evaluate(() => window.athena!.getSnapshot())).flight?.phase
    }, { timeout: 3000, intervals: [30] }).toBe('decelerating')
    await floating.screenshot({ path: 'test-results/flight-arrival.png', omitBackground: true })
    await expect.poll(() => (Date.now() - firstFlight.startedAt) / firstFlight.durationMs, { intervals: [10] }).toBeGreaterThanOrEqual(0.94)
    await floating.screenshot({ path: 'test-results/flight-landing-upright.png', omitBackground: true })
    await expect.poll(async () => (await control.evaluate(() => window.athena!.getSnapshot())).state, { timeout: 6000, intervals: [100] }).toBe('idle')
    const destination = await bounds()
    const landing = await landingSamples
    const peak = landing.reduce((best, sample) => sample.y < best.y ? sample : best)
    expect(peak.y).toBeLessThanOrEqual(destination.y - 15)
    expect(peak.progress).toBeGreaterThan(0.9)
    expect(peak.progress).toBeLessThan(1)
    expect(landing[0].y).toBeGreaterThan(peak.y)
    expect(landing.at(-1)!.y).toBe(destination.y)
    console.info('Verified physical landing rise and descent:', { peak, targetY: destination.y })
    expect(Math.hypot(destination.x - start.x, destination.y - start.y)).toBeGreaterThanOrEqual(150)
    expect(samples.some((point) => point.x !== start.x || point.y !== start.y)).toBe(true)
    const route = { x: destination.x - start.x, y: destination.y - start.y }
    const routeLength = Math.hypot(route.x, route.y)
    const crossTrack = samples.map((point) => Math.abs(route.x * (point.y - start.y) - route.y * (point.x - start.x)) / routeLength)
    expect(Math.max(...crossTrack)).toBeGreaterThan(60)
    const area = initial.displays.find((display) => destination.x >= display.x && destination.x < display.x + display.width)!
    expect({ x: destination.x, y: destination.y }).toEqual(fixedPositions(area, destination, initial.settings.edgePadding)[firstFlight.destination])
    expect(destination.x + destination.width).toBeLessThanOrEqual(area.x + area.width - initial.settings.edgePadding)
    expect(destination.y + destination.height).toBeLessThanOrEqual(area.y + area.height - initial.settings.edgePadding)
    console.info('Verified visible curved native journey:', { start, destination, maxCrossTrack: Math.max(...crossTrack), elapsedSeconds: (Date.now() - enabledAt) / 1000 })

    // Change the actual settings control while enabled; the next journey uses the new wait.
    await slider.fill('10')
    await control.getByRole('slider', { name: 'Movement speed' }).fill('10')
    await expect.poll(async () => (await control.evaluate(() => window.athena!.getSnapshot())).settings.wanderIntervalSeconds).toBe(10)
    await expect.poll(async () => (await control.evaluate(() => window.athena!.getSnapshot())).settings.movementSpeed).toBe(10)
    await control.screenshot({ path: 'test-results/flight-settings-10x.png' })
    await floating.evaluate(() => {
      const samples: Array<{ flight: import('../../shared/flight').Flight; observedAt: number }> = []
      const off = window.athena!.onSnapshot((snapshot) => { if (snapshot.flight) samples.push({ flight: snapshot.flight, observedAt: Date.now() }) })
      Object.assign(window, { flightTestSamples: samples, flightTestOff: off })
    })
    await expect.poll(async () => {
      const point = await bounds()
      return Math.hypot(point.x - destination.x, point.y - destination.y) > 2
    }, { timeout: 15_000, intervals: [30] }).toBe(true)
    const fastFlight = (await control.evaluate(() => window.athena!.getSnapshot())).flight!
    expect(fastFlight.speed).toBe(10)
    expect(fastFlight.durationMs).toBeLessThanOrEqual(360)
    expect(fastFlight.destination).not.toBe(firstFlight.destination)
    await floating.screenshot({ path: 'test-results/flight-10x.png', omitBackground: true })
    await expect.poll(async () => (await control.evaluate(() => window.athena!.getSnapshot())).state, { timeout: 3000, intervals: [30] }).toBe('idle')
    const fastDestination = await bounds()
    expect({ x: fastDestination.x, y: fastDestination.y }).toEqual(fixedPositions(area, fastDestination, initial.settings.edgePadding)[fastFlight.destination])
    const observations = await floating.evaluate(() => {
      const state = window as unknown as { flightTestSamples: Array<{ flight: import('../../shared/flight').Flight; observedAt: number }>; flightTestOff(): void }
      state.flightTestOff()
      return state.flightTestSamples
    })
    const phases = observations.map(({ flight }) => flight.phase)
    expect(phases).toContain('turning')
    expect(phases).toContain('settling')
    expect(phases.indexOf('turning')).toBeLessThan(phases.indexOf('flying'))
    for (const { flight, observedAt } of observations.filter(({ flight }) => flight.phase === 'turning')) {
      expect((observedAt - flight.startedAt) / flight.durationMs).toBeLessThan(0.5)
    }
    console.info('Verified 10x flight:', { destination: fastFlight.destination, durationMs: fastFlight.durationMs, phases })
    // Stop through the same validated bridge, independent of desktop focus/navigation.
    await control.evaluate(() => window.athena!.updateSettings({ randomMovement: false }))
    expect((await control.evaluate(() => window.athena!.getSnapshot())).settings.randomMovement).toBe(false)
    await expect.poll(async () => (await control.evaluate(() => window.athena!.getSnapshot())).state).toBe('idle')
    const stopped = await bounds()
    await expect(async () => expect(await bounds()).toEqual(stopped)).toPass({ timeout: 1000 })
  } finally { await app.close() }
})
