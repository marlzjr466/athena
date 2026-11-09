import { app } from 'electron'
import { z } from 'zod'
import { BrowserInspector } from './browserInspector'

export function runBrowserWorker(): void {
  const profile = process.env.ATHENA_BROWSER_PROFILE
  if (!profile) { app.exit(1); return }
  app.setPath('userData', profile)
  app.setName('Athena Browser Verification')
  // Inspector closes its window before draining storage and reporting evidence.
  app.on('window-all-closed', () => {})
  const timer = setTimeout(() => app.exit(1), 35_000)
  process.stdin.once('end', () => app.exit(0))
  const send = (data: unknown, done?: () => void) => process.stdout.write('ATHENA_BROWSER:' + JSON.stringify(data) + '\n', done)
  const request = z.object({ baseUrl: z.string().max(1500), path: z.string().max(1500), viewport: z.enum(['desktop', 'mobile']), selectors: z.array(z.string().min(1).max(250)).max(10) }).strict()
  let buffer = '', started = false
  process.stdin.on('data', async (part: Buffer) => {
    if (started) return
    buffer += part.toString()
    if (buffer.length > 12000) { app.exit(1); return }
    if (!buffer.includes('\n')) return
    started = true
    try {
      const input = request.parse(JSON.parse(buffer.trim()))
      const report = await new BrowserInspector(() => true).inspect(input.baseUrl, input.path, input.viewport, input.selectors)
      send({ report }, () => { clearTimeout(timer); app.quit() })
    } catch (error) {
      send({ error: error instanceof Error ? error.message.slice(0, 1000) : 'Browser inspection failed.' }, () => { clearTimeout(timer); app.quit() })
    }
  })
  void app.whenReady().then(() => send({ ready: true }))
}
