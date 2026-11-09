import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { DevelopmentServerService, ServerOptions, DevelopmentServerInfo } from '../../electron/main/ai/developmentServer'
import type { LocalBrowserVerificationService } from '../../electron/main/ai/localBrowserVerification'

declare global {
  var serverFixture: {
    servers: DevelopmentServerService; browser: LocalBrowserVerificationService; pid: number
    checkpoint: { task: string; completed: string[] }
    start(root: string, options?: ServerOptions): Promise<DevelopmentServerInfo>
    cleanup(): Promise<void>
  }
}

test('external wrapper, shared handle, restart, browser verification and child failure preserve the desktop PID and UI', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'athena-external-lifecycle-'))
  const entry = join(directory, 'harness.cjs'), project = join(directory, 'external-project'), second = join(directory, 'second-project')
  execFileSync(resolve('node_modules/.bin/esbuild'), ['tests/fixtures/externalServerHarness.ts', '--bundle', '--platform=node', '--format=cjs', '--external:electron', '--outfile=' + entry])
  for (const root of [project, second]) {
    await mkdir(root)
    await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { 'dev:mock': 'node server.cjs' } }))
    await writeFile(join(root, 'server.cjs'), `
      const http = require('node:http');
      if (process.argv.length !== 2) throw new Error('Unexpected injected framework flags');
      const page = '<meta name="viewport" content="width=device-width,initial-scale=1"><title>External project</title><button id="action">Ready</button><div id="empty">No items</div>';
      const server = http.createServer((req, res) => {
        if (req.url === '/crash') { res.end('closing'); setTimeout(() => process.exit(7), 25); return; }
        res.setHeader('Content-Type', 'text/html'); res.end(page);
      });
      server.listen(Number(process.env.PORT), '127.0.0.1', () => console.log('http://127.0.0.1:' + server.address().port + '/'));
    `)
  }
  let desktop: ElectronApplication | undefined
  try {
    desktop = await electron.launch({ args: [entry] })
    const window = await desktop.firstWindow()
    await expect(window.getByRole('heading')).toHaveText('Athena process fixture')
    const pid = await desktop.evaluate(() => process.pid)
    if (process.env.ATHENA_OLLAMA_LIVE_TEST === '1') {
      const localAI = await desktop.evaluate(async () => {
        const response = await fetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(3000) })
        return { status: response.status, modelCount: ((await response.json()) as { models?: unknown[] }).models?.length ?? 0 }
      })
      expect(localAI.status).toBe(200)
      expect(localAI.modelCount).toBeGreaterThan(0)
    }
    const first = await desktop.evaluate(async (_electron, root) => globalThis.serverFixture.start(root), project)
    expect(first.pid).not.toBe(pid)
    expect(first.root).toBe(await realpath(project))
    const reused = await desktop.evaluate(async (_electron, root) => globalThis.serverFixture.start(root), project)
    expect(reused.id).toBe(first.id)
    const reachable = await desktop.evaluate(async (_electron, id) => globalThis.serverFixture.servers.verifyReachable('conversation', '/', undefined, undefined, undefined, id), first.id)
    expect(reachable.status).toBe(200)
    for (const viewport of ['desktop', 'mobile'] as const) {
      const report = await desktop.evaluate(async (_electron, input) => globalThis.serverFixture.browser.inspect(input.url, '/', input.viewport, ['#action', '#empty']), { url: first.url, viewport })
      expect(report.title).toBe('External project')
      expect(report.viewport.width).toBe(viewport === 'desktop' ? 1280 : 390)
      expect(report.selectors[0], JSON.stringify({ viewport, report })).toMatchObject({ found: true, visible: true, focusable: true })
      expect(typeof report.selectors[0].hoverable).toBe('boolean')
      expect(report.consoleErrors).toEqual([])
    }
    const other = await desktop.evaluate(async (_electron, root) => globalThis.serverFixture.start(root), second)
    expect(other.id).not.toBe(first.id)
    const replaced = await desktop.evaluate(async (_electron, input) => globalThis.serverFixture.start(input.root, { restart: true, serverId: input.id }), { root: project, id: first.id })
    expect(replaced.id).not.toBe(first.id)
    expect(replaced.pid).not.toBe(first.pid)
    expect(await desktop.evaluate((_electron, id) => globalThis.serverFixture.servers.get('conversation', undefined, undefined, undefined, id), first.id)).toBeNull()
    expect(await desktop.evaluate(async () => {
      try { await globalThis.serverFixture.servers.verifyReachable('missing'); return 'unexpected' } catch (error) { return (error as Error).message }
    })).toContain('handle is missing')
    await desktop.evaluate(async (_electron, url) => { const res = await fetch(url + 'crash'); await res.text() }, replaced.url)
    await expect.poll(() => desktop!.evaluate((_electron, id) => globalThis.serverFixture.servers.get('conversation', undefined, undefined, undefined, id), replaced.id)).toBeNull()
    expect(await desktop.evaluate((_electron, id) => globalThis.serverFixture.servers.get('conversation', undefined, undefined, undefined, id)?.id, other.id)).toBe(other.id)
    expect(await desktop.evaluate(() => process.pid)).toBe(pid)
    expect(await desktop.evaluate(() => globalThis.serverFixture.checkpoint)).toEqual({ task: 'preserved', completed: ['file-one'] })
    await expect(window.getByRole('heading')).toBeVisible()
    expect(await desktop.evaluate(async (_electron, id) => globalThis.serverFixture.servers.stop('conversation', id), other.id)).toBe(true)
  } finally { if (desktop) { await desktop.evaluate(async () => globalThis.serverFixture.cleanup()).catch(() => undefined); await desktop.close() } }
})
