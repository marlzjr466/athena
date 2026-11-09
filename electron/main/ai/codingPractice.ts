import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CodingChallengeId, CodingAttempt } from '../../../shared/academyStudio'
import { AgentCommands, commandProfile, developmentEnvironment } from './agentCommands'

export type Case = { name: string; args: unknown[]; expected: unknown }
export const codingChallenges: Record<CodingChallengeId, Case[]> = {
  'sum-pairs': [{ name: 'mixed numbers', args: [[1, 2, 3, 4]], expected: 6 }, { name: 'negative and zero', args: [[-4, -3, 0, 5]], expected: -4 }, { name: 'empty input', args: [[]], expected: 0 }],
  palindrome: [{ name: 'mixed case and punctuation', args: ['A man, a plan, a canal: Panama'], expected: true }, { name: 'not a palindrome', args: ['Athena'], expected: false }, { name: 'empty after normalization', args: ['...'], expected: true }],
  'binary-search': [{ name: 'middle', args: [[1, 3, 5, 7, 9], 5], expected: 2 }, { name: 'missing', args: [[1, 3, 5, 7], 4], expected: -1 }, { name: 'single item', args: [[8], 8], expected: 0 }, { name: 'empty array', args: [[], 2], expected: -1 }],
}

/** A separate macOS-sandboxed Node process, not an in-process vm security boundary. */
export class CodingPracticeRunner {
  constructor(private commands = new AgentCommands()) {}
  async run(model: string, challenge: CodingChallengeId, code: string, signal: AbortSignal): Promise<CodingAttempt> {
    const results = await this.runCases(code, codingChallenges[challenge], signal)
    return { id: randomUUID(), model, challenge, createdAt: new Date().toISOString(), passed: results.filter(item => item.passed).length, total: results.length, results }
  }
  async runCases(code: string, cases: Case[], signal: AbortSignal): Promise<CodingAttempt['results']> {
    if (!await this.commands.supported()) throw new Error('Isolated coding practice is unavailable: the macOS command sandbox did not pass its safety probe.')
    if (code.length > 12_000 || !code.trim()) throw new Error('Enter up to 12,000 characters of JavaScript solution code.')
    if (!cases.length || cases.length > 20 || JSON.stringify(cases).length > 20_000) throw new Error('Isolated evaluation requires 1–20 bounded JSON test cases.')
    const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'athena-practice-')))
    const request = { executable: 'node', args: [] as string[], network: false, install: false, gitWrite: false }
    try {
      const executable = this.commands.executable('node')
      const file = join(scratch, 'exercise.cjs')
      const nonce = randomUUID()
      // Input is JavaScript source. It executes only in the child subject to the
      // same no-network, scratch-write macOS sandbox used by coding-agent tools.
      const harness = `const cases = ${JSON.stringify(cases)};\nconst source = ${JSON.stringify(code)};\nlet solve;\ntry { solve = new Function(source + '\\nreturn solve;')(); if (typeof solve !== 'function') throw Error('Define function solve.'); } catch (error) { process.stdout.write(${JSON.stringify(nonce)} + JSON.stringify({error:String(error).slice(0,300)}) + '\\n'); process.exit(0) }\nconst results=[];\nfor (const test of cases) { try { const actual=solve(...structuredClone(test.args)); results.push({name:test.name,passed:JSON.stringify(actual)===JSON.stringify(test.expected),detail:JSON.stringify(actual)?.slice(0,300) ?? 'undefined'}); } catch(error) { results.push({name:test.name,passed:false,detail:String(error).slice(0,300)}); } }\nprocess.stdout.write(${JSON.stringify(nonce)}+JSON.stringify({results})+'\\n');\n`
      writeFileSync(file, harness, { mode: 0o600 })
      const profile = commandProfile(scratch, scratch, request)
      const output = await new Promise<string>((resolve, reject) => {
        const child = spawn('/usr/bin/sandbox-exec', ['-p', profile, executable, '--max-old-space-size=64', file], {
          cwd: scratch, env: { ...developmentEnvironment(scratch, request), NODE_OPTIONS: '', UV_THREADPOOL_SIZE: '1' },
          detached: true, stdio: ['ignore', 'pipe', 'pipe'],
        })
        let text = '', stderr = '', done = false
        const kill = () => { try { if (child.pid) process.kill(-child.pid, 'SIGKILL') } catch { /* exited */ } }
        const timer = setTimeout(() => { kill(); finish(new Error('Practice execution exceeded its 3-second limit.')) }, 3000)
        const onAbort = () => { kill(); finish(new Error('Practice execution cancelled.')) }
        function finish(error?: Error) { if (done) return; done = true; clearTimeout(timer); signal.removeEventListener('abort', onAbort); kill(); if (error) reject(error); else resolve(text) }
        child.stdout.on('data', (chunk: Buffer) => { text += chunk.toString(); if (text.length > 8000) finish(new Error('Practice output exceeded its limit.')) })
        child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); if (stderr.length > 8000) finish(new Error('Practice error output exceeded its limit.')) })
        child.on('error', () => finish(new Error('Could not start isolated practice.')))
        child.on('close', code => { if (code !== 0) finish(new Error('Isolated practice process failed. Check your solution or runtime.')); else finish() })
        signal.addEventListener('abort', onAbort, { once: true }); if (signal.aborted) onAbort()
      })
      signal.throwIfAborted()
      const line = output.split('\n').find(item => item.startsWith(nonce))
      if (!line) throw new Error('Isolated practice returned no verifiable result.')
      const parsed = JSON.parse(line.slice(nonce.length)) as { error?: string; results?: CodingAttempt['results'] }
      if (parsed.error) throw new Error(`Solution could not start: ${parsed.error}`)
      if (!Array.isArray(parsed.results) || parsed.results.length !== cases.length) throw new Error('Practice result was incomplete.')
      const results = parsed.results.map((item, index) => ({ name: cases[index].name, passed: item.passed === true, detail: String(item.detail).slice(0, 300) }))
      return results
    } finally { rmSync(scratch, { recursive: true, force: true }) }
  }
}
