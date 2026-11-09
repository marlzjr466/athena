// @vitest-environment node
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import { AgentCommands } from '../electron/main/ai/agentCommands'
import { DevelopmentServerService, loopbackCandidates } from '../electron/main/ai/developmentServer'
import { resolveLocalBrowserURL } from '../electron/main/ai/localBrowserVerification'

describe('managed local development servers', () => {
  it('cleans only the sub-agent’s owned servers, including multiple handles', async () => {
    const service = new DevelopmentServerService(new AgentCommands())
    const registry = (service as unknown as { servers: Map<string, unknown> }).servers
    const childA = vi.fn(async () => {}), childB = vi.fn(async () => {}), parent = vi.fn(async () => {})
    registry.set('child-a', { id: 'child-a', sessionId: 'session:child:1', projectId: 'project', dispose: childA })
    registry.set('child-b', { id: 'child-b', sessionId: 'session:child:1', projectId: 'project', dispose: childB })
    registry.set('parent', { id: 'parent', sessionId: 'session', projectId: 'project', dispose: parent })
    await service.stopOwned('session:child:1', 'project')
    expect(childA).toHaveBeenCalledOnce(); expect(childB).toHaveBeenCalledOnce(); expect(parent).not.toHaveBeenCalled()
    expect([...registry.keys()]).toEqual(['parent'])
    await service.stopAll()
  })
  it('prevents browser verification from leaving the managed loopback origin', () => {
    expect(loopbackCandidates('http://localhost:5173/ready')).toEqual(['http://localhost:5173/ready', 'http://127.0.0.1:5173/ready', 'http://[::1]:5173/ready'])
    expect(loopbackCandidates('http://127.0.0.1:5173/ready')).toEqual(['http://127.0.0.1:5173/ready'])
    expect(resolveLocalBrowserURL('http://127.0.0.1:45678', '/settings').href).toBe('http://127.0.0.1:45678/settings')
    expect(() => resolveLocalBrowserURL('http://127.0.0.1:45678', '//example.com')).toThrow('relative route')
    expect(() => resolveLocalBrowserURL('https://127.0.0.1:45678', '/')).toThrow('loopback')
    expect(() => resolveLocalBrowserURL('http://127.0.0.1:45678', 'https://example.com')).toThrow()
  })

  it.runIf(process.env.ATHENA_SANDBOX_TEST === '1')('starts a declared app on an OS-assigned loopback port, checks readiness, and cleans it up', async () => {
    const root = await mkdtemp(join(tmpdir(), 'athena-managed-server-'))
    await mkdir(join(root, 'dist'))
    await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { dev: 'node server.cjs' } }))
    await writeFile(join(root, 'server.cjs'), `const http = require('node:http'); http.createServer((_req, res) => { res.end('<title>Fixture Ready</title>') }).listen(Number(process.env.PORT), '127.0.0.1')`)
    const servers = new DevelopmentServerService(new AgentCommands())
    const controller = new AbortController()
    try {
      const server = await servers.start('test-session', root, undefined, 'project-only', controller.signal)
      expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/)
      expect(await servers.verifyReachable('test-session')).toMatchObject({ status: 200, url: server.url })
      const concurrent = await Promise.all([1, 2].map(() => servers.start('test-session', root, undefined, 'project-only', controller.signal)))
      expect(concurrent.map((item) => item.id)).toEqual([server.id, server.id])
      await expect(servers.start('other-session', root, undefined, 'project-only', controller.signal, undefined, () => true, { readinessUrl: server.url })).rejects.toThrow('already occupied')
      expect(servers.get('other-session')).toBeNull()
      expect(servers.get('test-session', undefined, undefined, undefined, server.id)?.id).toBe(server.id)
      expect(await servers.stop('test-session')).toBe(true)
      expect(servers.get('test-session')).toBeNull()
    } finally {
      await servers.stopAll()
      await rm(root, { recursive: true, force: true })
    }
  }, 45_000)

  it.runIf(process.env.ATHENA_SANDBOX_TEST === '1')('cancels startup and cleans the child without restarting the host', async () => {
    const root = await mkdtemp(join(tmpdir(), 'athena-managed-cancel-'))
    await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { dev: 'node server.cjs' } }))
    await writeFile(join(root, 'server.cjs'), `console.log('WAITING_FOR_READINESS'); setInterval(() => {}, 1000)`)
    const servers = new DevelopmentServerService(new AgentCommands(), 5000), controller = new AbortController(), pid = process.pid
    try {
      await expect(servers.start('cancel', root, undefined, 'project-only', controller.signal, (output) => {
        if (output.includes('WAITING_FOR_READINESS')) controller.abort()
      })).rejects.toThrow()
      expect(servers.get('cancel')).toBeNull()
      expect(process.pid).toBe(pid)
    } finally { await servers.stopAll(); await rm(root, { recursive: true, force: true }) }
  }, 15_000)
})
