// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CursorCommandServer } from '../electron/main/ai/cursorCommandServer'
import { CursorTerminalBridge } from '../electron/main/ai/cursorTerminal'
import { ChatError } from '../electron/main/ai/AIProvider'

const servers: CursorCommandServer[] = []
afterEach(() => { for (const server of servers.splice(0)) server.close() })
async function fixture() {
  const bridge = new CursorTerminalBridge('/test/project', new AbortController().signal, undefined, async () => {})
  vi.spyOn(bridge, 'create').mockResolvedValue({ terminalId: 'test-terminal' })
  vi.spyOn(bridge, 'waitForExit').mockResolvedValue({ exitCode: 0 })
  vi.spyOn(bridge, 'output').mockReturnValue({ output: 'hello\n', exitStatus: { exitCode: 0 } })
  vi.spyOn(bridge, 'release').mockReturnValue({})
  const server = new CursorCommandServer(bridge, '/test/project')
  servers.push(server)
  const config = await server.start()
  const headers = { 'Content-Type': 'application/json', Authorization: config.headers[0].value }
  const rpc = async (id: number, method: string, params = {}) => (await fetch(config.url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) })).json()
  return { server, bridge, config, headers, rpc }
}
describe('Cursor command MCP transport', () => {
  it('exposes real tools and routes execution to the sandbox bridge with a fixed workspace', async () => {
    const { rpc, bridge } = await fixture()
    expect(await rpc(1, 'initialize')).toMatchObject({ result: { capabilities: { tools: {} } } })
    expect(await rpc(2, 'tools/list')).toMatchObject({ result: { tools: [{ name: 'run_command' }, { name: 'command_status' }] } })
    const result = await rpc(3, 'tools/call', { name: 'run_command', arguments: { command: 'echo', args: ['hello'] } })
    expect(result.result.content[0].text).toContain('hello')
    expect(bridge.create).toHaveBeenCalledWith({ sessionId: expect.any(String), cwd: '/test/project', command: 'echo', args: ['hello'] }, expect.any(String))
    expect(bridge.release).toHaveBeenCalledOnce()
    await rpc(3, 'tools/call', { name: 'run_command', arguments: { command: 'echo', args: ['hello'] } })
    expect(bridge.create).toHaveBeenCalledOnce()
  })
  it('requires the per-execution secret and refuses browser origins and arbitrary tools', async () => {
    const { config, headers, rpc, bridge, server } = await fixture()
    expect((await fetch(config.url, { method: 'POST' })).status).toBe(403)
    expect((await fetch(config.url, { method: 'POST', headers: { ...headers, Origin: 'https://example.test' } })).status).toBe(403)
    expect(await rpc(1, 'tools/call', { name: 'other', arguments: {} })).toMatchObject({ result: { isError: true } })
    expect(await rpc(2, 'tools/call', { name: 'run_command', arguments: { command: 'echo', args: [], cwd: '/escape' } })).toMatchObject({ result: { isError: true } })
    expect(bridge.create).not.toHaveBeenCalled()
    expect(server.ownsPermission({ kind: 'other', title: `${server.name}: run_command` })).toBe(true)
    expect(server.ownsPermission({ kind: 'other', title: `${server.name}-run_command: run_command` })).toBe(true)
    expect(server.ownsPermission({ kind: 'other', title: `${server.name}-other: run_command` })).toBe(false)
    expect(server.ownsPermission({ kind: 'execute', title: `${server.name}: run_command` })).toBe(false)
    expect(server.ownsPermission({ kind: 'other', title: 'other_server: run_command' })).toBe(false)
  })
  it('reports declined approval without native shell fallback', async () => {
    const { bridge, rpc } = await fixture()
    vi.mocked(bridge.create).mockRejectedValue(new ChatError('Command permission was declined.'))
    expect(await rpc(1, 'tools/call', { name: 'run_command', arguments: { command: 'echo', args: ['hello'] } })).toMatchObject({ result: { isError: true, content: [{ text: 'Command permission was declined.' }] } })
    expect(bridge.waitForExit).not.toHaveBeenCalled()
  })
})
