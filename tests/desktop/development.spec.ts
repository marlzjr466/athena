import { test, expect, _electron as electron } from '@playwright/test'
import { resolveConfig } from 'electron-vite'
import { createServer } from 'vite'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('development renderer boots with a nonce-protected React refresh preamble', async () => {
  const config = await resolveConfig({}, 'serve')
  const server = await createServer({ ...config.config!.renderer, configFile: false, server: { host: '127.0.0.1', port: 0 } })
  await server.listen()
  const profile = await mkdtemp(join(tmpdir(), 'athena-dev-test-'))
  const errors: string[] = []
  const app = await electron.launch({ args: ['.'], env: { ...process.env, ATHENA_TEST_DATA: profile, ELECTRON_RENDERER_URL: server.resolvedUrls!.local[0].replace(/\/$/, '') } })
  try {
    app.on('window', (page) => page.on('pageerror', (error) => errors.push(error.message)))
    await expect.poll(() => app.windows().length).toBe(3)
    const control = app.windows().find((page) => page.url().includes('surface=control'))!
    await expect(control.getByRole('heading', { name: /A little presence/ })).toBeVisible()
    await expect(control.locator('canvas')).toBeVisible()
    const policy = await control.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content')
    expect(policy).toContain("'nonce-")
    expect(policy).not.toContain("script-src 'self' 'unsafe-inline'")
    expect(await control.locator('script[type="module"]').evaluateAll((elements) => elements.every((element) => Boolean((element as HTMLScriptElement).nonce)))).toBe(true)
    expect(errors).toEqual([])
  } finally { await app.close(); await server.close() }
})
