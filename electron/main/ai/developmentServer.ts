import { randomUUID } from 'node:crypto'
import { createServer } from 'node:net'
import { realpath, readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import type { FilesystemAccessMode } from '../../../shared/permissions'
import { ChatError } from './AIProvider'
import { AgentCommands, redactOutput } from './agentCommands'
import { log } from '../logger'

export type DevelopmentServerFailureKind = 'port-conflict' | 'bind-permission' | 'filesystem-permission' | 'invalid-host' | 'startup-exit' | 'readiness-timeout' | 'cancelled'
export function classifyDevelopmentServerFailure(text: string, exitCode?: number | null): DevelopmentServerFailureKind {
  if (/EADDRINUSE|address already in use/i.test(text)) return 'port-conflict'
  if (/EPERM|EACCES|Operation not permitted|Permission denied/i.test(text)) return /listen|bind/i.test(text) ? 'bind-permission' : 'filesystem-permission'
  if (/EADDRNOTAVAIL|invalid host|bad address/i.test(text)) return 'invalid-host'
  if (/cancelled|canceled|aborted/i.test(text)) return 'cancelled'
  if (exitCode !== undefined && exitCode !== null) return 'startup-exit'
  return 'readiness-timeout'
}
// Wrapper scripts need not accept framework-specific flags.
export function developmentScriptArguments(manager: string, script: string, args: string[] = []): string[] {
  if (manager === 'npm') return ['run', script, ...(args.length ? ['--', ...args] : [])]
  if (manager === 'pnpm') return ['run', script, ...args]
  if (manager === 'yarn') return [script, ...args]
  throw new ChatError('Unsupported package manager: ' + manager)
}
export function loopbackURL(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password) throw new ChatError('Use an HTTP loopback readiness URL without credentials.')
  return url.href
}
/** Probe only alternate loopback addresses at the same port and path. */
export function loopbackCandidates(value: string): string[] {
  const original = new URL(loopbackURL(value))
  const hosts = original.hostname === 'localhost' ? ['localhost', '127.0.0.1', '[::1]'] : [original.hostname]
  return hosts.map((host) => { const candidate = new URL(original.href); candidate.hostname = host; return candidate.href })
}
export function advertisedLoopbackURL(text: string): string | undefined {
  const matches = [...text.matchAll(/http:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):\d+(?:\/[^\s\x1b"'<>]*)?/gi)]
  for (const match of matches.reverse()) { try { return loopbackURL(match[0]) } catch { /* Ignore invalid output. */ } }
}
export function advertisedLoopbackPort(text: string): number | undefined {
  const url = advertisedLoopbackURL(text)
  return url ? Number(new URL(url).port) : undefined
}
export async function reserveLoopbackPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, resolve) })
  const address = server.address()
  if (!address || typeof address === 'string') { server.close(); throw new ChatError('OS did not return a loopback port.') }
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return address.port
}
export interface DevelopmentServerInfo { id: string; projectId: string; url: string; root: string; script: string; pid: number | null; startedAt: string }
interface RunningServer extends DevelopmentServerInfo {
  sessionId: string; child: ChildProcess; dispose(): Promise<void>; output: string; ready: boolean; scope: FilesystemAccessMode
  authorized(): boolean; permissionTimer?: ReturnType<typeof setInterval>; argsKey: string
}
export interface ServerOptions { projectId?: string; serverId?: string; restart?: boolean; readinessUrl?: string; scriptArgs?: string[] }

export class DevelopmentServerService {
  private servers = new Map<string, RunningServer>()
  private queues = new Map<string, Promise<unknown>>()
  private shutdown = new AbortController()
  constructor(private commands: AgentCommands, private readinessMs = 35_000) {}

  async start(sessionId: string, directory: string, script: string | undefined, scope: FilesystemAccessMode, signal: AbortSignal, onOutput?: (output: string) => void, authorized: () => boolean = () => true, options: ServerOptions = {}): Promise<DevelopmentServerInfo> {
    signal = AbortSignal.any([signal, this.shutdown.signal])
    signal.throwIfAborted()
    const root = await realpath(directory), projectId = options.projectId ?? root
    const key = JSON.stringify([sessionId, projectId, root])
    const operation = (this.queues.get(key) ?? Promise.resolve()).catch(() => undefined).then(() => this.launch(sessionId, root, projectId, script, scope, signal, onOutput, authorized, options))
    this.queues.set(key, operation)
    try { return await operation } finally { if (this.queues.get(key) === operation) this.queues.delete(key) }
  }
  private async launch(sessionId: string, root: string, projectId: string, script: string | undefined, scope: FilesystemAccessMode, signal: AbortSignal, onOutput: ((output: string) => void) | undefined, authorized: () => boolean, options: ServerOptions): Promise<DevelopmentServerInfo> {
    signal.throwIfAborted()
    if (!authorized()) throw new ChatError('Project or command access was revoked before server startup.')
    let manifest: { scripts?: Record<string, unknown> }
    try { manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) } catch { throw new ChatError('No readable package.json in ' + root) }
    const scripts = manifest.scripts ?? {}, selected = script ?? ['dev', 'start', 'serve', 'preview'].find((name) => typeof scripts[name] === 'string')
    if (!selected || !/^[A-Za-z0-9][A-Za-z0-9:_-]{0,79}$/.test(selected) || typeof scripts[selected] !== 'string') throw new ChatError('Choose an existing script in ' + basename(root) + '/package.json.')
    const explicitURL = options.readinessUrl ? loopbackURL(options.readinessUrl) : undefined
    const argsKey = JSON.stringify([selected, options.scriptArgs ?? [], explicitURL])
    const existing = [...this.servers.values()].find((item) => item.sessionId === sessionId && item.projectId === projectId && item.root === root)
    if (options.serverId && existing?.id !== options.serverId) throw new ChatError('The server handle is missing or belongs to another project. Start the project script explicitly; Athena remains running.')
    if (existing) {
      if (!options.restart && existing.ready && existing.scope === scope && existing.argsKey === argsKey && this.live(existing)) return this.info(existing)
      await this.stop(sessionId, existing.id, projectId)
    }
    signal.throwIfAborted()
    const port = explicitURL ? Number(new URL(explicitURL).port || 80) : await reserveLoopbackPort()
    if (explicitURL && await this.reachable(explicitURL)) throw new ChatError('Readiness address ' + explicitURL + ' is already occupied. No project process was started.')
    const executable = this.commands.packageManager(root), args = developmentScriptArguments(executable, selected, options.scriptArgs)
    let output = '', pending = '', candidate: RunningServer | undefined
    const emit = (part: string) => {
      const combined = pending + part, end = combined.lastIndexOf('\n')
      pending = (end < 0 ? combined : combined.slice(end + 1)).slice(-4000)
      if (end >= 0) { output = (output + redactOutput(combined.slice(0, end + 1))).slice(-32_000); if (candidate) candidate.output = output; onOutput?.(output) }
    }
    const managed = await this.commands.spawnManaged(root, { executable, args, network: false, install: false, gitWrite: false, filesystemMode: scope, localServer: true, port }, emit)
    candidate = { id: randomUUID(), projectId, sessionId, url: explicitURL ?? 'http://127.0.0.1:' + port + '/', root, script: selected, pid: managed.child.pid ?? null, startedAt: new Date().toISOString(), child: managed.child, dispose: managed.dispose, output, ready: false, scope, authorized, argsKey }
    const server = candidate
    this.servers.set(server.id, server)
    let spawnError: Error | undefined
    managed.child.once('error', (error) => { spawnError = error })
    managed.child.once('close', () => { server.ready = false; this.remove(server); log('project.server_exited', { serverId: server.id, pid: server.pid ?? 0 }) })
    server.permissionTimer = setInterval(() => { if (!authorized()) void this.stop(sessionId, server.id, projectId).catch(() => log('project.server_cleanup_failed', { serverId: server.id })) }, 1000)
    server.permissionTimer.unref()
    const abort = () => { void managed.dispose().catch(() => undefined) }
    signal.addEventListener('abort', abort, { once: true })
    try {
      const deadline = Date.now() + this.readinessMs
      while (Date.now() < deadline) {
        signal.throwIfAborted()
        if (!authorized()) throw new ChatError('Project command permission was revoked during startup.')
        if (spawnError || !this.live(server)) throw new ChatError(this.diagnostic(classifyDevelopmentServerFailure(output, server.child.exitCode ?? 1), server, executable, args, spawnError?.message ?? output))
        if (!explicitURL) server.url = advertisedLoopbackURL(output + pending) ?? server.url
        const reachable = await this.reachable(server.url)
        if (reachable && this.live(server) && authorized()) {
          server.url = reachable.url
          server.ready = true
          log('project.server_ready', { serverId: server.id, projectId, pid: server.pid ?? 0 })
          return this.info(server)
        }
        await new Promise((resolve) => setTimeout(resolve, 200))
      }
      throw new ChatError(this.diagnostic(classifyDevelopmentServerFailure(output), server, executable, args, output))
    } catch (error) { this.remove(server); await managed.dispose(); throw error }
    finally { signal.removeEventListener('abort', abort) }
  }
  private live(server: RunningServer): boolean { return !!server.pid && server.child.exitCode === null && server.child.signalCode === null && !server.child.killed }
  private remove(server: RunningServer): void { clearInterval(server.permissionTimer); if (this.servers.get(server.id) === server) this.servers.delete(server.id) }
  private async probe(url: string): Promise<number | null> {
    try { const response = await fetch(url, { signal: AbortSignal.timeout(1000), redirect: 'manual' }); await response.body?.cancel(); return response.status } catch { return null }
  }
  private async reachable(url: string): Promise<{ url: string; status: number } | null> {
    for (const candidate of loopbackCandidates(url)) {
      const status = await this.probe(candidate)
      if (status !== null) return { url: candidate, status }
    }
    return null
  }
  get(sessionId: string, scope?: FilesystemAccessMode, authorized: () => boolean = () => true, projectId?: string, serverId?: string): DevelopmentServerInfo | null {
    const candidates = [...this.servers.values()].filter((item) => item.sessionId === sessionId && (!projectId || item.projectId === projectId) && (!serverId || item.id === serverId))
    if (candidates.length > 1) throw new ChatError('Multiple project servers are running. Supply the server_id returned by start_dev_server.')
    const server = candidates[0]
    if (!server) return null
    if (!authorized() || !server.authorized() || scope && server.scope !== scope || !this.live(server)) {
      void this.stop(sessionId, server.id, server.projectId).catch(() => undefined); return null
    }
    return server.ready ? this.info(server) : null
  }
  async verifyReachable(sessionId: string, path = '/', scope?: FilesystemAccessMode, authorized: () => boolean = () => true, projectId?: string, serverId?: string): Promise<{ url: string; status: number }> {
    const server = this.get(sessionId, scope, authorized, projectId, serverId)
    if (!server) throw new ChatError('Browser verification blocked: managed server handle is missing, stale, or belongs to another project. Start the authorized project script, then use its server_id. Athena and the task remain running.')
    const url = new URL(path, server.url)
    if (url.origin !== new URL(server.url).origin || path.startsWith('//')) throw new ChatError('Browser verification is limited to the managed server origin.')
    const reachable = await this.reachable(url.href)
    if (!reachable) throw new ChatError(`Could not connect to ${url.host}. The managed project server is no longer listening on its authorized loopback address. Review its process output before restarting it.`)
    return reachable
  }
  async stop(sessionId: string, serverId?: string, projectId?: string): Promise<boolean> {
    const candidates = [...this.servers.values()].filter((server) => server.sessionId === sessionId && (!serverId || server.id === serverId) && (!projectId || server.projectId === projectId))
    if (candidates.length > 1) throw new ChatError('Choose the server_id to stop; multiple project servers are running.')
    const server = candidates[0]
    if (!server) return false
    server.ready = false
    await server.dispose()
    this.remove(server)
    return true
  }
  async stopAll(): Promise<void> {
    this.shutdown.abort()
    await Promise.allSettled([...this.queues.values()])
    await Promise.all([...this.servers.values()].map((server) => this.stop(server.sessionId, server.id, server.projectId)))
  }
  async stopOwned(sessionId: string, projectId: string): Promise<void> {
    await Promise.all([...this.servers.values()].filter((server) => server.sessionId === sessionId && server.projectId === projectId).map((server) => this.stop(sessionId, server.id, projectId)))
  }
  private info(server: RunningServer): DevelopmentServerInfo { return { id: server.id, projectId: server.projectId, url: server.url, root: server.root, script: server.script, pid: server.pid, startedAt: server.startedAt } }
  private diagnostic(kind: DevelopmentServerFailureKind, server: RunningServer, executable: string, args: string[], output: string): string {
    return 'Project server ' + kind + '. Directory: ' + server.root + '. Command: ' + executable + ' ' + args.join(' ') + '. Address: ' + server.url + '. Scope: ' + server.scope + '. Exit: ' + (server.child.exitCode ?? server.child.signalCode ?? 'still running') + '. ' + (redactOutput(output).slice(-1800) || 'No output; provide readiness_url if the script does not advertise an address or honor PORT.') + ' Athena was not restarted.'
  }
}
