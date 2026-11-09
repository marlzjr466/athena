import { app } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChatError } from './AIProvider'
import { managedProcessLifecycle } from './ownedProcess'
import { redactOutput } from './agentCommands'
import { resolveLocalBrowserURL, type BrowserViewport, type LocalBrowserReport } from './browserInspector'
export { resolveLocalBrowserURL, type BrowserViewport, type LocalBrowserReport } from './browserInspector'

export class LocalBrowserVerificationService {
  private workers = new Map<ChildProcess, () => Promise<void>>()
  constructor(private allowed: () => boolean) {}
  async dispose(): Promise<void> { await Promise.all([...this.workers.values()].map((stop) => stop().catch(() => undefined))) }
  async inspect(baseUrl: string, path: string, viewport: BrowserViewport, selectors: string[] = [], signal = new AbortController().signal): Promise<LocalBrowserReport> {
    if (!this.allowed()) throw new ChatError('Browser verification is not authorized. Enable Local Browser Verification in Settings → Permissions.')
    resolveLocalBrowserURL(baseUrl, path)
    signal.throwIfAborted()
    const profile = mkdtempSync(join(tmpdir(), 'athena-browser-worker-'))
    const args = [...(app.isPackaged ? [] : [process.argv[1] || app.getAppPath()]), '--athena-browser-worker', '--user-data-dir=' + profile]
    const child = spawn(process.execPath, args, { detached: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: '/usr/bin:/bin', HOME: profile, TMPDIR: profile, LANG: 'en_US.UTF-8', ATHENA_BROWSER_PROFILE: profile } })
    const lifecycle = managedProcessLifecycle(child, () => { this.workers.delete(child); rmSync(profile, { recursive: true, force: true }) })
    this.workers.set(child, lifecycle.dispose)
    let cleanup = () => {}
    try {
      return await new Promise<LocalBrowserReport>((resolve, reject) => {
        let sent = false, buffer = '', diagnostic = ''
        const fail = (message: string) => reject(new ChatError(message))
        const aborted = () => fail('Browser verification cancelled. Athena and the project server remain running.')
        const timer = setTimeout(() => fail('Browser verification timed out. The isolated browser was stopped; Athena remains running.'), 30_000)
        const permissionTimer = setInterval(() => { if (!this.allowed()) fail('Browser verification permission was revoked.') }, 250)
        cleanup = () => { clearTimeout(timer); clearInterval(permissionTimer); signal.removeEventListener('abort', aborted) }
        signal.addEventListener('abort', aborted, { once: true })
        const message = (message: unknown) => {
          const data = message as { ready?: boolean; report?: LocalBrowserReport; error?: string }
          if (data?.ready && !sent) {
            sent = true
            child.stdin.write(JSON.stringify({ baseUrl, path, viewport, selectors }) + '\n', (error) => { if (error) fail('Browser worker connection failed.') })
          } else if (data?.report) resolve(data.report)
          else if (data?.error) fail(data.error.slice(0, 1000))
        }
        child.stdout.on('data', (part: Buffer) => {
          buffer += part.toString()
          if (buffer.length > 100_000) { fail('Browser evidence exceeded its size limit.'); return }
          let end: number
          while ((end = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, end); buffer = buffer.slice(end + 1)
            if (line.startsWith('ATHENA_BROWSER:')) { try { message(JSON.parse(line.slice(15))) } catch { fail('Browser evidence could not be parsed.') } }
          }
        })
        child.stderr.on('data', (part: Buffer) => { diagnostic = redactOutput((diagnostic + part.toString()).slice(-1500)) })
        child.stdin.on('error', () => fail('Browser worker connection closed.'))
        child.once('error', () => fail('Could not start the isolated browser worker.'))
        child.once('close', (code, termination) => fail('Browser worker exited (' + (termination ?? code) + '). Verification is blocked; Athena, its conversation, and the project server remain running. ' + diagnostic))
        if (signal.aborted) aborted()
      })
    } finally { cleanup(); await lifecycle.dispose().catch(() => undefined) }
  }
}
