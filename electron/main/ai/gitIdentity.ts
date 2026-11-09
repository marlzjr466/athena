import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

export type GitIdentityField = { status: 'found'; value: string; scope: 'local' | 'global' | 'system' | 'command' | 'worktree' | 'unknown' }
  | { status: 'missing' | 'permission-denied' | 'tool-failure' | 'timeout'; message: string }
export interface GitIdentity { name: GitIdentityField; email: GitIdentityField; complete: boolean }
export interface GitConfigResult { code: number | null; stdout: string; stderr: string; error?: string; timedOut?: boolean }
export type GitConfigRunner = (key: 'user.name' | 'user.email', cwd: string, environment: NodeJS.ProcessEnv, signal: AbortSignal) => Promise<GitConfigResult>

// Deliberately construct a small environment instead of inheriting the agent
// sandbox's temporary HOME or GIT_CONFIG_GLOBAL=/dev/null. No token/config
// contents other than these two requested Git keys are returned to the model.
export function gitIdentityEnvironment(home = homedir(), inherited: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const xdg = inherited.XDG_CONFIG_HOME
  return {
    HOME: home,
    XDG_CONFIG_HOME: xdg && isAbsolute(xdg) && xdg !== '/dev/null' ? xdg : join(home, '.config'),
    PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin',
    LANG: 'en_US.UTF-8',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
  }
}

export function parseGitIdentityField(result: GitConfigResult): GitIdentityField {
  if (result.timedOut) return { status: 'timeout', message: 'Git identity check timed out.' }
  if (result.error === 'EACCES' || result.error === 'EPERM' || /(?:permission denied|operation not permitted|\bEACCES\b|\bEPERM\b)/i.test(result.stderr)) return { status: 'permission-denied', message: 'macOS denied access to Git configuration. Review file permissions and macOS Privacy & Security settings.' }
  if (result.error) return { status: 'tool-failure', message: 'Git could not be started for the identity check.' }
  if (result.code === 1 && !result.stdout.trim() && !result.stderr.trim()) return { status: 'missing', message: 'No value is configured in this repository or the user’s global Git configuration.' }
  if (result.code !== 0) return { status: 'tool-failure', message: 'Git could not read its configuration. Check that Git and the configuration file are valid.' }
  const line = result.stdout.replace(/\r?\n$/, '')
  const separator = line.indexOf('\t')
  if (separator < 0 || line.includes('\n')) return { status: 'tool-failure', message: 'Git returned an unexpected identity format.' }
  if (!line.slice(separator + 1).trim()) return { status: 'missing', message: 'The configured Git identity value is empty.' }
  const scope = line.slice(0, separator)
  const value = line.slice(separator + 1).trim()
  if (value.length > 320 || /[\r\n\0]/.test(value)) return { status: 'tool-failure', message: 'Git returned an unsupported identity value.' }
  return { status: 'found', value, scope: ['local', 'global', 'system', 'command', 'worktree'].includes(scope) ? scope as Extract<GitIdentityField, { status: 'found' }>['scope'] : 'unknown' }
}

const runGitConfig: GitConfigRunner = (key, cwd, environment, signal) => new Promise((resolve) => {
  const child = spawn('/usr/bin/git', ['config', '--show-scope', '--get', key], { cwd, env: environment, stdio: ['ignore', 'pipe', 'pipe'], signal })
  let stdout = '', stderr = '', timedOut = false, settled = false
  const done = (result: GitConfigResult) => { if (!settled) { settled = true; clearTimeout(timer); resolve(result) } }
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, 5000)
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString().slice(0, Math.max(0, 1024 - stdout.length)); if (stdout.length >= 1024) child.kill('SIGKILL') })
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString().slice(0, Math.max(0, 1024 - stderr.length)); if (stderr.length >= 1024) child.kill('SIGKILL') })
  child.on('error', (error: NodeJS.ErrnoException) => done({ code: null, stdout, stderr, error: error.code ?? 'spawn-failed', timedOut }))
  child.on('close', (code) => done({ code, stdout, stderr, timedOut }))
})

export class GitIdentityService {
  constructor(private runner: GitConfigRunner = runGitConfig, private home = homedir(), private inherited: NodeJS.ProcessEnv = process.env) {}
  async read(cwd: string, signal: AbortSignal): Promise<GitIdentity> {
    const environment = gitIdentityEnvironment(this.home, this.inherited)
    const [name, email] = await Promise.all(['user.name', 'user.email'].map(async (key) => {
      try { return parseGitIdentityField(await this.runner(key as 'user.name' | 'user.email', cwd, environment, signal)) }
      catch (error) { return { status: signal.aborted ? 'timeout' : 'tool-failure', message: signal.aborted ? 'Git identity check was cancelled.' : 'Git identity check failed.' } as GitIdentityField }
    }))
    signal.throwIfAborted()
    return { name, email, complete: name.status === 'found' && email.status === 'found' }
  }
}
