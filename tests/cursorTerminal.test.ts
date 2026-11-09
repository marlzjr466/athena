import { RememberedPermissions } from '../electron/main/permissions/rememberedPermissions'
import { PermissionRepository } from '../electron/main/permissions/permissionRepository'
// @vitest-environment node
import { execFileSync } from 'node:child_process'
import { chmod, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentCommands } from '../electron/main/ai/agentCommands'
import { CursorTerminalBridge } from '../electron/main/ai/cursorTerminal'
import { CursorACPProvider, CursorACPService } from '../electron/main/ai/cursorACP'
import { projectCommandLease } from '../electron/main/ai/projectCommandLease'

const disposable: string[] = []
afterEach(async () => { for (const path of disposable.splice(0)) await rm(path, { recursive: true, force: true }) })

async function repository() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'athena-cursor-terminal-')))
  disposable.push(root)
  execFileSync('git', ['init', '-b', 'main'], { cwd: root })
  execFileSync('git', ['config', 'user.name', 'Athena Test'], { cwd: root })
  execFileSync('git', ['config', 'user.email', 'athena-test@example.invalid'], { cwd: root })
  return root
}

describe('Cursor ACP isolated terminal', () => {
  it('remembers an exact offline npm test through the actual isolated terminal bridge', async () => {
    const root = await repository()
    await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "console.log(123)" --' } }))
    let permissions = new RememberedPermissions(new PermissionRepository(join(root, 'preferences')))
    let prompts = 0
    const bridge = new CursorTerminalBridge(root, new AbortController().signal, async (_title, _description, _signal, _changes, scope) => {
      expect(scope?.operation).toBe('sandbox_check_command')
      if (!permissions.allows(scope)) { prompts++; permissions.grant(scope) }
      return true
    }, async () => {})
    try {
      for (let i = 0; i < 2; i++) {
        const { terminalId } = await bridge.create({ sessionId: 'check', cwd: root, command: 'npm', args: ['test', '--', '--watchman=false', '--coverage=false'] }, 'check')
        expect(await bridge.waitForExit({ sessionId: 'check', terminalId }, 'check')).toMatchObject({ exitCode: 0 })
        expect(bridge.output({ sessionId: 'check', terminalId }, 'check').output).toContain('123')
        bridge.release({ sessionId: 'check', terminalId }, 'check')
        permissions = new RememberedPermissions(new PermissionRepository(join(root, 'preferences')))
      }
      expect(prompts).toBe(1)
    } finally { bridge.dispose() }
  })
  it.runIf(process.env.ATHENA_SANDBOX_TEST === '1')('reaches an approved localhost service through the actual Cursor terminal bridge', async () => {
    const root = await repository()
    const server = createServer((_request, response) => response.end('cursor-local-ok'))
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('No loopback address')
    const approvals: string[] = []
    const bridge = new CursorTerminalBridge(root, new AbortController().signal, async (_title, description) => { approvals.push(description); return true }, async () => {})
    try {
      const { terminalId } = await bridge.create({ sessionId: 'local', cwd: root, command: 'node', args: ['-e', 'fetch(process.argv[1]).then(async r => console.log(await r.text())).catch(e => { console.error(e.cause?.code ?? e.message); process.exitCode=1 })', `http://127.0.0.1:${address.port}/`], local_network: true }, 'local')
      expect(await bridge.waitForExit({ sessionId: 'local', terminalId }, 'local')).toMatchObject({ exitCode: 0 })
      expect(bridge.output({ sessionId: 'local', terminalId }, 'local').output).toContain('cursor-local-ok')
      bridge.release({ sessionId: 'local', terminalId }, 'local')
      const curl = await bridge.create({ sessionId: 'local', cwd: root, command: 'curl', args: ['--fail', '--silent', '--show-error', `http://127.0.0.1:${address.port}/`], local_network: true }, 'local')
      expect(await bridge.waitForExit({ sessionId: 'local', terminalId: curl.terminalId }, 'local')).toMatchObject({ exitCode: 0 })
      expect(bridge.output({ sessionId: 'local', terminalId: curl.terminalId }, 'local').output).toContain('cursor-local-ok')
      bridge.release({ sessionId: 'local', terminalId: curl.terminalId }, 'local')
      expect(approvals).toEqual([expect.stringContaining('outbound loopback only'), expect.stringContaining('outbound loopback only')])
    } finally { bridge.dispose(); await new Promise<void>((resolve) => server.close(() => resolve())) }
  }, 15_000)
  it.each([true, false])('routes real Cursor MCP permission envelopes to user approval (approved=%s)', async (approved) => {
    const root = await repository()
    const mock = join(root, 'mock-cursor-mcp.cjs')
    await writeFile(mock, `#!/usr/bin/env node
const { createInterface } = require('node:readline')
let promptId, server
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n')
createInterface({ input: process.stdin }).on('line', async (line) => {
  const message = JSON.parse(line)
  if (message.method === 'initialize' || message.method === 'authenticate' || message.method === 'session/set_mode') send({ id: message.id, result: {} })
  else if (message.method === 'session/new') {
    server = message.params.mcpServers[0]
    if (!server || server.type !== 'http') process.exit(4)
    send({ id: message.id, result: { sessionId: 'mock-session', currentModelId: 'auto' } })
  } else if (message.method === 'session/prompt') {
    promptId = message.id
    send({ id: 201, method: 'session/request_permission', params: { sessionId: 'mock-session', toolCall: { kind: 'execute', title: 'echo hello' } } })
  } else if (message.id === 201) {
    if (message.result.outcome.optionId !== 'reject-once') process.exit(5)
    send({ id: 202, method: 'session/request_permission', params: { sessionId: 'mock-session', toolCall: { kind: 'other', title: server.name + '-run_command: run_command' } } })
  } else if (message.id === 202) {
    if (message.result.outcome.optionId !== 'allow-once') process.exit(6)
    const response = await fetch(server.url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: server.headers[0].value }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'run_command', arguments: { command: 'echo', args: ['hello'] } } }) })
    const data = await response.json()
    send({ method: 'session/update', params: { sessionId: 'mock-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: data.result.content[0].text } } } })
    send({ id: promptId, result: { stopReason: 'end_turn' } })
  }
})
`)
    await chmod(mock, 0o700)
    const service = new CursorACPService(async (_command, args) => args[0] === 'status'
      ? { stdout: 'Logged in as athena@example.test', stderr: '' }
      : args[0] === 'models' ? { stdout: 'auto - Auto', stderr: '' } : { stdout: '1.0.0', stderr: '' }, async () => mock)
    const provider = new CursorACPProvider(service, root, false, 'athena@example.test', 'auto')
    const approvals: string[] = []
    let output = ''
    for await (const chunk of provider.streamMessage([], { permissionMode: 'ask', signal: AbortSignal.timeout(10_000), requestApproval: async (title) => { approvals.push(title); return approved } })) if (chunk.type === 'text') output += chunk.text
    expect(approvals).toEqual(['Run isolated project command'])
    expect(output).toContain(approved ? 'hello' : 'declined')
  }, 20_000)

  it('advertises ACP terminal support and routes an agent command through approval to sandbox output', async () => {
    const root = await repository()
    const mock = join(root, 'mock-cursor-agent.cjs')
    await writeFile(mock, `#!/usr/bin/env node
const { createInterface } = require('node:readline')
let promptId
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n')
createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line)
  if (message.method === 'initialize') {
    if (message.params.clientCapabilities.terminal !== true) process.exit(4)
    send({ id: message.id, result: {} })
  } else if (message.method === 'authenticate') send({ id: message.id, result: {} })
  else if (message.method === 'session/new') send({ id: message.id, result: { sessionId: 'mock-session', currentModelId: 'auto' } })
  else if (message.method === 'session/set_mode') send({ id: message.id, result: {} })
  else if (message.method === 'session/prompt') {
    promptId = message.id
    send({ id: 101, method: 'terminal/create', params: { sessionId: 'mock-session', cwd: process.cwd(), command: 'echo', args: ['hello'] } })
  } else if (message.id === 101 && message.result?.terminalId) {
    send({ id: 102, method: 'terminal/wait_for_exit', params: { sessionId: 'mock-session', terminalId: message.result.terminalId } })
  } else if (message.id === 102 && message.result?.exitCode === 0) {
    send({ id: 103, method: 'terminal/output', params: { sessionId: 'mock-session', terminalId: globalThis.terminalId || '' } })
  } else if (message.id === 103) {
    send({ method: 'session/update', params: { sessionId: 'mock-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: message.result.output } } } })
    send({ id: promptId, result: { stopReason: 'end_turn' } })
  }
  if (message.id === 101 && message.result?.terminalId) globalThis.terminalId = message.result.terminalId
})
`)
    await chmod(mock, 0o700)
    const service = new CursorACPService(async (_command, args) => args[0] === 'status'
      ? { stdout: 'Logged in as athena@example.test', stderr: '' }
      : args[0] === 'models' ? { stdout: 'auto - Auto', stderr: '' } : { stdout: '1.0.0', stderr: '' }, async () => mock)
    const provider = new CursorACPProvider(service, root, false, 'athena@example.test', 'auto')
    const approvals: string[] = []
    const output: string[] = []
    for await (const chunk of provider.streamMessage([], { permissionMode: 'ask', signal: AbortSignal.timeout(10_000), requestApproval: async (title) => { approvals.push(title); return true } })) {
      if (chunk.type === 'text') output.push(chunk.text)
    }
    expect(output.join('')).toContain('hello')
    expect(approvals).toContain('Run isolated project command')
  }, 20_000)

  it('uses the approved sandbox for echo, Git, and npm and commits only reviewed per-slice files', async () => {
    const root = await repository()
    const commands = new AgentCommands()
    expect(await commands.supported()).toBe(true)
    const approvals: string[] = []
    const bridge = new CursorTerminalBridge(root, new AbortController().signal, async (title) => { approvals.push(title); return true }, async () => {}, commands)
    const execute = async (command: string, args: string[]) => {
      const { terminalId } = await bridge.create({ sessionId: 'session-1', cwd: root, command, args }, 'session-1')
      const status = await bridge.waitForExit({ sessionId: 'session-1', terminalId }, 'session-1')
      const output = bridge.output({ sessionId: 'session-1', terminalId }, 'session-1')
      bridge.release({ sessionId: 'session-1', terminalId }, 'session-1')
      return { status, output }
    }
    expect(await execute('echo', ['hello'])).toMatchObject({ status: { exitCode: 0 }, output: { output: expect.stringContaining('hello') } })
    expect(await execute('git', ['status', '--short'])).toMatchObject({ status: { exitCode: 0 } })
    expect(await execute('npm', ['--version'])).toMatchObject({ status: { exitCode: 0 } })
    await writeFile(join(root, 'slice.txt'), 'verified slice\n')
    await writeFile(join(root, 'unrelated.txt'), 'not part of this slice\n')
    expect(await execute('git', ['add', '--', 'slice.txt'])).toMatchObject({ status: { exitCode: 0 } })
    expect(await execute('git', ['commit', '-m', 'Complete validated slice'])).toMatchObject({ status: { exitCode: 0 } })
    expect(await execute('git', ['log', '-1'])).toMatchObject({ status: { exitCode: 0 }, output: { output: expect.stringContaining('Complete validated slice') } })
    expect(execFileSync('git', ['show', '--format=', '--name-only', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()).toBe('slice.txt')
    expect(execFileSync('git', ['status', '--short'], { cwd: root, encoding: 'utf8' })).toContain('?? unrelated.txt')
    expect(approvals).toContain('Create reviewed Git commit')
    bridge.dispose()
  }, 45_000)

  it('does not run rejected commands, shell interpreters, or commits containing unrelated staged files', async () => {
    const root = await repository()
    const commands = new AgentCommands()
    expect(await commands.supported()).toBe(true)
    const denied = new CursorTerminalBridge(root, new AbortController().signal, async () => false, async () => {}, commands)
    await expect(denied.create({ sessionId: 's', cwd: root, command: 'echo', args: ['hello'] }, 's')).rejects.toThrow('declined')
    await expect(denied.create({ sessionId: 's', cwd: root, command: '/bin/zsh', args: ['-c', 'echo hello'] }, 's')).rejects.toThrow()
    denied.dispose()
    await writeFile(join(root, 'unrelated.txt'), 'other work\n')
    execFileSync('git', ['add', '--', 'unrelated.txt'], { cwd: root })
    await writeFile(join(root, 'slice.txt'), 'slice work\n')
    const bridge = new CursorTerminalBridge(root, new AbortController().signal, async () => true, async () => {}, commands)
    await expect(bridge.create({ sessionId: 's', cwd: root, command: 'git', args: ['add', '--', 'slice.txt'] }, 's')).rejects.toThrow('already contains staged files')
    await expect(bridge.create({ sessionId: 'wrong', cwd: root, command: 'echo', args: ['hello'] }, 's')).rejects.toThrow('different')
    bridge.dispose()
  }, 30_000)

  it('commits while Cursor already owns the project lease without reacquiring it', async () => {
    const root = await repository()
    await writeFile(join(root, 'slice.txt'), 'validated\n')
    const controller = new AbortController()
    const release = await projectCommandLease.acquire(root, controller.signal)
    const bridge = new CursorTerminalBridge(root, controller.signal, async () => true, async () => {}, new AgentCommands(), undefined, true)
    try {
      for (const args of [['add', '--', 'slice.txt'], ['commit', '-m', 'Validated slice']]) {
        const { terminalId } = await bridge.create({ sessionId: 's', cwd: root, command: 'git', args }, 's')
        expect(await bridge.waitForExit({ sessionId: 's', terminalId }, 's')).toMatchObject({ exitCode: 0 })
        bridge.release({ sessionId: 's', terminalId }, 's')
      }
    } finally { bridge.dispose(); release() }
    expect(execFileSync('git', ['log', '-1', '--format=%s'], { cwd: root, encoding: 'utf8' }).trim()).toBe('Validated slice')
  }, 20_000)

  it('cancels pending approval when a session closes and never runs it afterwards', async () => {
    const root = await repository()
    let approve: ((value: boolean) => void) | undefined
    let pending!: Promise<boolean>
    const ready = new Promise<void>((resolve) => { pending = new Promise<boolean>((accept) => { approve = accept }); resolve() })
    await ready
    const bridge = new CursorTerminalBridge(root, new AbortController().signal, async () => { bridge.dispose(); return pending }, async () => {})
    const creation = bridge.create({ sessionId: 's', cwd: root, command: 'echo', args: ['hello'] }, 's')
    approve?.(true)
    await expect(creation).rejects.toThrow()
    await expect(bridge.create({ sessionId: 's', cwd: root, command: 'echo', args: ['hello'] }, 's')).rejects.toThrow()
  })
})
