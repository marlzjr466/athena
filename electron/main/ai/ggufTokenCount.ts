import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

const tokenizeBinary = ['/opt/homebrew/bin/llama-tokenize', '/usr/local/bin/llama-tokenize'].find((path) => existsSync(path))

export function parseTokenCount(output: string): number | null {
  const match = output.match(/Total number of tokens:\s*(\d+)/)
  if (!match) return null
  const value = Number(match[1])
  return Number.isInteger(value) && value >= 0 ? value : null
}

/** Counts text tokens with the GGUF tokenizer. This does not include Ollama's chat-template tokens. */
export function countGgufTokens(modelPath: string, text: string): Promise<number | null> {
  if (!text) return Promise.resolve(0)
  if (!tokenizeBinary || !modelPath.includes('/.ollama/models/blobs/') || modelPath.includes('..') || !existsSync(modelPath)) return Promise.resolve(null)
  return new Promise((resolve) => {
    const child = spawn(tokenizeBinary, ['-m', modelPath, '--stdin', '--show-count', '--no-bos', '--no-parse-special', '--log-disable'], { stdio: ['pipe', 'pipe', 'pipe'] })
    let output = ''
    const finish = (value: number | null) => { clearTimeout(timer); resolve(value) }
    const timer = setTimeout(() => { child.kill(); finish(null) }, 20_000)
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); if (output.length > 8_000_000) output = output.slice(-8_000_000) })
    child.on('error', () => finish(null))
    child.on('close', () => finish(parseTokenCount(output)))
    child.stdin.on('error', () => {})
    child.stdin.end(text)
  })
}
