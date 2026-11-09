import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, openSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { llamaLongGguf } from '../../../shared/llamaLongContext'
import { ChatError } from './AIProvider'

const binary = ['/opt/homebrew/bin/llama-server', '/usr/local/bin/llama-server'].find((path) => existsSync(path))
const host = '127.0.0.1'
const port = 18081

let child: ChildProcess | null = null
let running: { tokens: number; factor: number | null } | null = null
let inflight = 0

export function llamaServerEndpoint(): string {
  return `http://${host}:${port}`
}

export function llamaRequestStarted(): void { inflight++ }
export function llamaRequestFinished(): void { inflight = Math.max(0, inflight - 1) }

export async function ensureLlamaServer(tokens: number, factor: number | null): Promise<void> {
  if (!binary) throw new ChatError('llama-server is not installed. The Ollama model is unchanged.')
  if (!existsSync(llamaLongGguf)) throw new ChatError('The Qwen2.5-Coder GGUF is not available. The Ollama model was not modified.')
  if (running && child && running.tokens === tokens && running.factor === factor) { inflight++; return }
  if (inflight > 0) throw new ChatError('A llama.cpp response is already running. Athena will not change the context window until it finishes.')
  stopLlamaServer()
  const args = ['-m', llamaLongGguf, '--host', host, '--port', String(port), '-c', String(tokens), '-ngl', 'all', '-fa', 'on', '-ctk', 'q8_0', '-ctv', 'q8_0', '-np', '1', '--jinja', '-n', '8192']
  if (factor && factor > 1) args.push('--rope-scaling', 'yarn', '--rope-scale', String(factor), '--yarn-orig-ctx', '32768')
  const log = openSync(join(tmpdir(), 'athena-llama-server.log'), 'w')
  child = spawn(binary, args, { stdio: ['ignore', log, log] })
  running = { tokens, factor }
  const started = Date.now()
  while (Date.now() - started < 180_000) {
    if (child.exitCode != null) { running = null; child = null; throw new ChatError('llama.cpp stopped while loading the long-context model. The Ollama model was not modified.') }
    try {
      const response = await fetch(`http://${host}:${port}/health`)
      if (response.ok) { inflight++; return }
    } catch { /* still loading */ }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  stopLlamaServer()
  throw new ChatError('llama.cpp did not finish loading. The Ollama model was not modified.')
}

export function stopLlamaServer(): void {
  const current = child
  child = null
  running = null
  if (!current || current.killed) return
  try { current.kill('SIGTERM') } catch { /* already stopped */ }
}
