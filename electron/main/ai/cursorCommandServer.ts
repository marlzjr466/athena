import { randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { ChatError } from './AIProvider'
import type { CursorTerminalBridge } from './cursorTerminal'

const tools = [
  {
    name: 'run_command',
    description: 'Run an authorized project command through Athena approval and the OS sandbox. Supply a direct executable and arguments. Set local_network=true for approved outbound localhost access; it does not grant internet or socket binding. Git add accepts explicit files only; git commit -m reviews staged files and configured author. Long commands return a terminalId; inspect with command_status.',
    inputSchema: { type: 'object', properties: { command: { type: 'string', enum: ['echo', 'git', 'npm', 'pnpm', 'yarn', 'node', 'python3', 'go', 'cargo', 'curl'] }, args: { type: 'array', items: { type: 'string' } }, local_network: { type: 'boolean' } }, required: ['command', 'args'], additionalProperties: false },
  },
  {
    name: 'command_status',
    description: 'Wait briefly for an Athena project command and return its output and exit status. Do not resubmit an already running command.',
    inputSchema: { type: 'object', properties: { terminalId: { type: 'string' } }, required: ['terminalId'], additionalProperties: false },
  },
] as const

/** Per-execution, authenticated loopback MCP transport. Never exposes a native shell. */
export class CursorCommandServer {
  readonly name = `athena_commands_${randomBytes(8).toString('hex')}`
  private readonly token = randomBytes(32).toString('hex')
  private server?: Server
  private queue: Promise<unknown> = Promise.resolve()
  private requests = new Map<string, Promise<unknown>>()
  private readonly session = randomBytes(16).toString('hex')

  constructor(private readonly terminals: CursorTerminalBridge, private readonly root: string) {}

  ownsPermission(tool: Record<string, unknown>): boolean {
    // Cursor includes the tool name in the provider identifier in its ACP title.
    // This authorizes only transport dispatch. The command still requires its
    // own reviewed user approval inside CursorTerminalBridge.
    return tool.kind === 'other' && tools.some(({ name }) => tool.title === `${this.name}-${name}: ${name}` || tool.title === `${this.name}: ${name}`)
  }

  async start(): Promise<{ type: 'http'; name: string; url: string; headers: { name: string; value: string }[] }> {
    const server = createServer((req, res) => {
      const reply = (status: number, value?: unknown) => {
        if (res.destroyed) return
        res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
        res.end(value === undefined ? undefined : JSON.stringify(value))
      }
      if (req.headers.authorization !== `Bearer ${this.token}` || req.headers.origin || req.url !== '/mcp' || req.headers.host !== `127.0.0.1:${(server.address() as { port: number }).port}`) { reply(403); return }
      if (req.method !== 'POST') { reply(405); return }
      let body = '', size = 0
      req.setEncoding('utf8')
      req.on('data', (chunk: string) => { size += Buffer.byteLength(chunk); if (size > 32_768) { reply(413); req.destroy() } else body += chunk })
      req.on('error', () => {})
      req.on('end', () => {
        void (async () => {
          let message: { jsonrpc?: string; id?: string | number; method?: string; params?: Record<string, unknown> }
          try { message = JSON.parse(body) } catch { reply(400); return }
          if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string' || (message.id !== undefined && typeof message.id !== 'string' && typeof message.id !== 'number')) { reply(400); return }
          if (message.id === undefined) { reply(202); return }
          const { id, method, params = {} } = message
          let result: unknown
          if (method === 'initialize') result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'Athena authorized project commands', version: '1.0.0' } }
          else if (method === 'ping') result = {}
          else if (method === 'tools/list') result = { tools }
          else if (method === 'tools/call') {
            const key = `${typeof id}:${id}`
            let pending = this.requests.get(key)
            if (!pending) {
              if (this.requests.size >= 512) { reply(429); return }
              pending = this.queue.then(() => this.call(params))
              this.queue = pending.catch(() => {})
              this.requests.set(key, pending)
            }
            result = await pending
          } else { reply(200, { jsonrpc: '2.0', id, error: { code: -32601, message: 'Unsupported method' } }); return }
          reply(200, { jsonrpc: '2.0', id, result })
        })().catch(() => reply(500))
      })
    })
    this.server = server
    server.requestTimeout = 30_000
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    const address = server.address() as { port: number }
    return { type: 'http', name: this.name, url: `http://127.0.0.1:${address.port}/mcp`, headers: [{ name: 'Authorization', value: `Bearer ${this.token}` }] }
  }

  private async call(params: Record<string, unknown>): Promise<unknown> {
    try {
      const args = params.arguments
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw new ChatError('Command arguments must be an object.')
      const input = args as Record<string, unknown>
      let terminalId: string
      if (params.name === 'run_command') {
        if (Object.keys(input).some((key) => key !== 'command' && key !== 'args' && key !== 'local_network')) throw new ChatError('Only a direct executable, argument array and local_network flag are accepted.')
        ;({ terminalId } = await this.terminals.create({ ...input, cwd: this.root, sessionId: this.session }, this.session))
      } else if (params.name === 'command_status' && typeof input.terminalId === 'string') terminalId = input.terminalId
      else throw new ChatError('Unknown Athena command tool.')
      const request = { sessionId: this.session, terminalId }
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([this.terminals.waitForExit(request, this.session), new Promise<void>((resolve) => { timer = setTimeout(resolve, params.name === 'run_command' ? 1000 : 10_000) })])
      } finally { clearTimeout(timer) }
      const output = this.terminals.output(request, this.session)
      if (output.exitStatus) this.terminals.release(request, this.session)
      return { content: [{ type: 'text', text: JSON.stringify({ ...output, ...(output.exitStatus ? {} : { terminalId, running: true }) }) }] }
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: error instanceof ChatError ? error.userMessage : 'Command failed. No unsandboxed fallback was attempted.' }] }
    }
  }

  close(): void {
    this.terminals.dispose()
    this.server?.close()
    this.server?.closeAllConnections()
    this.requests.clear()
  }
}
