import { SearchError } from '../../../shared/searchOutcome'
import { log } from '../logger'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile, chmod, readdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { randomBytes, createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { LocalSearchStatus } from '../../../shared/webAccess'
import { readResponseBytes } from './responseBody'

export const searxngEngines = (news: boolean) => news ? ['duckduckgo news', 'bing news'] : ['duckduckgo', 'bing', 'brave', 'wikipedia']

export class SearxngRuntime {
  private child?: ChildProcessWithoutNullStreams
  private starting?: Promise<void>
  private provisioning?: Promise<string>
  private stopping?: Promise<void>
  private endpoint?: string
  private token = ''
  private wanted = false
  private disposed = false
  private failures = 0
  private timer?: ReturnType<typeof setTimeout>
  private state: LocalSearchStatus = { state: 'stopped', message: 'Local search is stopped.' }
  constructor(private root: string, private bundle: string) {}
  status(): LocalSearchStatus { return { ...this.state } }
  async initialize(): Promise<void> {
    try { await this.provision(); if (!this.wanted) this.state = { ...this.state, state: 'stopped', message: 'Local search is ready. Enable Internet Access to search.' } }
    catch (error) { this.state = { state: 'error', message: error instanceof Error && error.message.startsWith('The ') ? error.message : 'Local search initialization failed. Check available disk space and retry initialization.' } }
  }
  async provision(): Promise<string> {
    if (this.provisioning) return this.provisioning
    this.provisioning = this.install().finally(() => { this.provisioning = undefined })
    return this.provisioning
  }
  private async install(): Promise<string> {
    this.state = { state: 'starting', message: 'Preparing the bundled search runtime…' }
    const manifestText = await readFile(join(this.bundle, 'manifest.json'), 'utf8').catch(() => { throw new Error('The search runtime is missing from this Athena installation. Reinstall a complete Athena build, then retry initialization.') })
    const manifest = JSON.parse(manifestText)
    if (manifest.target !== `${process.platform}-${process.arch}` || !/^searxng-[\w.-]+$/.test(manifest.revision)) throw new Error('The bundled search runtime is incompatible with this platform. Install the matching Athena build.')
    const identity = createHash('sha256').update(manifestText).digest('hex').slice(0, 16)
    const destination = join(this.root, 'runtimes', identity)
    await mkdir(join(this.root, 'runtimes'), { recursive: true, mode: 0o700 })
    for (const entry of await readdir(join(this.root, 'runtimes'), { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith('.install-')) await rm(join(this.root, 'runtimes', entry.name), { recursive: true, force: true })
    }
    if (await readFile(join(destination, 'manifest.json'), 'utf8').catch(() => '') !== manifestText) {
      const stage = await mkdtemp(join(this.root, 'runtimes', '.install-'))
      try {
        await cp(this.bundle, stage, { recursive: true, dereference: false, verbatimSymlinks: true })
        await rename(stage, destination)
      } finally { await rm(stage, { recursive: true, force: true }) }
    }
    this.state.version = manifest.revision
    return destination
  }
  async start(signal?: AbortSignal): Promise<void> {
    if (this.stopping) await this.stopping
    signal?.throwIfAborted()
    if (this.disposed) throw new Error('Search service is shutting down.')
    this.wanted = true
    if (this.starting) return this.starting
    if (this.endpoint && this.child) return
    this.starting = this.launch().catch(error => {
      this.child?.kill(); this.child = undefined; this.endpoint = undefined
      this.state = { ...this.state, state: 'error', message: error instanceof Error && error.message.startsWith('The ') ? error.message : 'Local search could not start. Retry initialization or reinstall Athena if the bundled runtime is damaged.' }
      throw new Error(this.state.message)
    }).finally(() => { this.starting = undefined })
    return this.starting
  }
  private async launch(): Promise<void> {
    const runtime = await this.provision()
    if (!this.wanted) return
    const configDir = join(this.root, 'config'), cache = join(this.root, 'cache')
    await mkdir(configDir, { recursive: true, mode: 0o700 }); await mkdir(cache, { recursive: true, mode: 0o700 })
    const secretPath = join(configDir, 'secret')
    let secret = await readFile(secretPath, 'utf8').catch(() => '')
    if (!/^[a-f0-9]{64}$/.test(secret)) { secret = randomBytes(32).toString('hex'); await writeFile(secretPath, secret, { mode: 0o600 }) }
    if (process.platform !== 'win32') await chmod(secretPath, 0o600)
    const settings = join(configDir, 'settings.yml')
    await writeFile(settings, `use_default_settings:\n  engines:\n    keep_only: [duckduckgo, bing, brave, wikipedia, duckduckgo news, bing news]\nengines:\n  - name: bing\n    disabled: false\n  - name: brave\n    disabled: false\n  - name: wikipedia\n    display_type: [list]\ngeneral:\n  debug: false\n  enable_metrics: false\nserver:\n  secret_key: ${secret}\n  bind_address: 127.0.0.1\n  limiter: false\n  public_instance: false\n  image_proxy: false\nsearch:\n  formats: [json]\n  autocomplete: ''\noutgoing:\n  request_timeout: 8\n  max_request_timeout: 20\n`, { mode: 0o600 })
    this.token = randomBytes(32).toString('hex')
    const python = join(runtime, 'python', process.platform === 'win32' ? 'python.exe' : 'bin/python3')
    const child = spawn(python, ['-I', '-u', join(runtime, 'launcher.py')], {
      cwd: this.root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: dirname(python), SYSTEMROOT: process.env.SYSTEMROOT, WINDIR: process.env.WINDIR, LANG: 'en_US.UTF-8', TMPDIR: cache, TMP: cache, TEMP: cache },
    })
    this.child = child
    child.stderr.resume() // Never log queries, secrets or upstream page content.
    child.stdin.on('error', () => {})
    child.stdin.write(JSON.stringify({ settings, cache, token: this.token }) + '\n')
    child.on('exit', () => {
      if (this.child !== child) return
      this.child = undefined; this.endpoint = undefined
      if (this.wanted) { this.state = { ...this.state, state: 'error', message: 'Local search stopped unexpectedly; recovering…' }; this.recover() }
    })
    const port = await new Promise<number>((resolve, reject) => {
      let pending = ''
      const timer = setTimeout(() => reject(new Error('Startup timeout')), 60000)
      const finish = (error?: Error, port?: number) => { clearTimeout(timer); child.stdout.off('data', data); error ? reject(error) : resolve(port!) }
      const data = (chunk: Buffer) => {
        pending += chunk.toString()
        if (pending.length > 8192) return finish(new Error('Invalid runtime handshake'))
        for (const line of pending.split('\n').slice(0, -1)) {
          try { const value = JSON.parse(line); if (Number.isInteger(value.port) && value.port > 0 && value.port < 65536) return finish(undefined, value.port) } catch { /* ignore upstream startup text */ }
        }
      }
      child.stdout.on('data', data)
      child.once('error', error => finish(error)); child.once('exit', () => finish(new Error('Runtime exited during startup')))
    })
    child.stdout.resume()
    if (!this.wanted) { child.stdin.end(); return }
    this.endpoint = `http://127.0.0.1:${port}`
    await this.health()
    this.state = { ...this.state, state: 'running', message: 'Local SearXNG is running. Searches query external engines over the internet.' }
    this.monitor()
  }
  private async health(): Promise<void> {
    const response = await fetch(`${this.endpoint}/healthz`, { headers: { Authorization: `Bearer ${this.token}` }, signal: AbortSignal.timeout(3000), redirect: 'error' })
    if (!response.ok || !(await response.json()).ready) throw new Error('Health check failed')
  }
  private monitor(): void {
    clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      void this.health().then(() => { this.failures = 0; if (this.wanted) this.monitor() }).catch(() => {
        this.child?.kill(); this.endpoint = undefined
      })
    }, 15000)
    this.timer.unref()
  }
  private recover(): void {
    clearTimeout(this.timer)
    if (!this.wanted || this.disposed) return
    if (++this.failures > 3) { this.state.message = 'Local search repeatedly failed. Use Retry Initialization.'; return }
    this.timer = setTimeout(() => { if (this.wanted) void this.start().catch(() => {}) }, 1000 * 2 ** this.failures)
    this.timer.unref()
  }
  async stop(): Promise<void> {
    if (this.stopping) return this.stopping
    this.stopping = this.stopProcess().finally(() => { this.stopping = undefined })
    return this.stopping
  }
  private async stopProcess(): Promise<void> {
    this.wanted = false; clearTimeout(this.timer)
    this.child?.stdin.end()
    await this.starting?.catch(() => {})
    const child = this.child
    this.child = undefined; this.endpoint = undefined
    if (child && child.exitCode === null && child.signalCode === null) {
      child.stdin.end()
      await Promise.race([new Promise<void>(resolve => child.once('exit', () => resolve())), delay(2000)])
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }
    this.state = { ...this.state, state: 'stopped', message: 'Local search is stopped.' }
  }
  async restart(): Promise<void> { await this.stop(); this.failures = 0; await this.start() }
  async dispose(): Promise<void> { this.disposed = true; await this.stop() }
  async search(query: string, news: boolean, timeout: number, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted()
    try { await this.start(signal) } catch { signal?.throwIfAborted(); throw new SearchError('disconnected', this.state.message) }
    signal?.throwIfAborted()
    const merged = AbortSignal.any([AbortSignal.timeout(timeout), ...(signal ? [signal] : [])])
    const queryId = createHash('sha256').update(query).digest('hex'), started = Date.now()
    let httpStatus = 0
    try {
      const params = new URLSearchParams({ q: query, format: 'json', categories: news ? 'news' : 'general', engines: searxngEngines(news).join(',') })
      const response = await fetch(`${this.endpoint}/search?${params}`, { method: 'GET', headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/json' }, signal: merged, redirect: 'error', cache: 'no-store' })
      httpStatus = response.status
      if (!response.ok) {
        await response.body?.cancel()
        throw new SearchError(response.status === 403 ? 'json-disabled' : 'http-error', response.status === 403 ? 'Local SearXNG denied JSON search (HTTP 403). JSON format must be enabled and the managed runtime accessible. Restart Search Service to restore its configuration.' : `Local SearXNG returned HTTP ${response.status}. Local project work can continue.`, response.status)
      }
      const bytes = await readResponseBytes(response, 2_000_000, merged)
      try { return JSON.parse(Buffer.from(bytes).toString('utf8')) }
      catch { throw new SearchError('invalid-response', 'Local SearXNG returned invalid JSON. Restart Search Service to restore its configuration.') }
    } catch (error) {
      signal?.throwIfAborted()
      if (error instanceof SearchError) throw error
      if (merged.aborted) throw new SearchError('timeout', 'Local SearXNG search timed out. External evidence is unavailable for this query; local project work can continue.')
      throw new SearchError('disconnected', 'Could not connect to the managed SearXNG service. Check its status or restart Search Service.')
    } finally {
      log('web.searxng_request', { provider: 'searxng', queryId, category: news ? 'news' : 'general', serviceStatus: this.state.state, httpStatus, durationMs: Date.now() - started })
    }
  }
}
