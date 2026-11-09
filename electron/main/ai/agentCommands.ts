import { spawn, spawnSync } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { FilesystemAccessMode } from '../../../shared/permissions'
import { ChatError } from './AIProvider'
import { managedProcessLifecycle, ownsDetachedProcess } from './ownedProcess'
import { commandFilesystemDenial, validateCommandReadPaths, type CommandFilesystemDenial } from './commandFileAccess'
import { projectCommandLease } from './projectCommandLease'

export interface CommandRequest { executable: string; args: string[]; network: boolean; install: boolean; gitWrite: boolean; filesystemMode?: FilesystemAccessMode; localServer?: boolean; loopback?: boolean; port?: number; approvedReadPaths?: string[]; /** Trusted index-review callers stream bounded output rather than retaining it in a normal command result. */ streamOutput?: boolean; /** Only a trusted caller already holding projectCommandLease may set this. */ projectLeaseHeld?: boolean }
export interface CommandResult { command: string; exitCode: number | null; output: string; stdout?: string; stderr?: string; truncated: boolean; timedOut: boolean; filesystemDenial?: CommandFilesystemDenial; localNetworkFailure?: { kind: 'refused' | 'timeout' | 'dns' | 'policy' | 'tls' | 'proxy' | 'unknown'; message: string }; approvedReadPaths?: string[]; environment?: { workingDirectory: string; executablePath: string; nodeExecutable: string | null; nodeVersion: string | null } }
export interface ManagedCommand { child: ReturnType<typeof spawn>; dispose(): Promise<void> }
export function developmentEnvironment(scratch: string, request: CommandRequest): NodeJS.ProcessEnv {
  const java = [process.env.JAVA_HOME, join(homedir(), '.sdkman/candidates/java/current'), '/opt/homebrew/opt/openjdk/libexec/openjdk.jdk/Contents/Home'].find((path) => path?.startsWith('/') && existsSync(join(path, 'bin/java')))
  const paths = ['/opt/homebrew/bin', '/usr/local/bin', ...(process.env.PATH ?? '').split(':'), '/usr/bin', '/bin', join(homedir(), '.volta/bin'), ...(java ? [join(java, 'bin')] : [])].filter((path) => path.startsWith('/') && existsSync(path))
  return { PATH: [...new Set(paths)].join(':'), HOME: request.filesystemMode && request.filesystemMode !== 'project-only' ? homedir() : scratch, TMPDIR: scratch, LANG: 'en_US.UTF-8', CI: '1', ...(java ? { JAVA_HOME: realpathSync(java) } : {}), ...(request.localServer ? { HOST: '127.0.0.1', PORT: String(request.port ?? 0) } : {}), npm_config_cache: join(scratch, 'npm'), npm_config_userconfig: '/dev/null', npm_config_audit: 'false', npm_config_fund: 'false', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' }
}
export function redactOutput(text: string): string {
  return text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/\b(sk-[\w-]{12,}|AKIA[0-9A-Z]{16})\b/g, '[REDACTED]')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [REDACTED]')
    .replace(/((?:password|secret|token|api[_-]?key|authorization)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,}]+)/gi, '$1[REDACTED]')
    .replace(/(https?:\/\/)[^/\s:@]+:[^/\s@]+@/g, '$1[REDACTED]@')
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, '[REDACTED PRIVATE KEY]')
}
export function localNetworkFailure(output: string, requested: boolean, timedOut: boolean): CommandResult['localNetworkFailure'] {
  const code = timedOut ? 'timeout' : /ECONNREFUSED|Connection refused/i.test(output) ? 'refused'
    : /ETIMEDOUT|Connection timed out/i.test(output) ? 'timeout'
      : /ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(output) ? 'dns'
        : /EPERM|EACCES|Operation not permitted/i.test(output) ? 'policy'
          : /CERT_|SSL_|TLS|certificate verify/i.test(output) ? 'tls'
            : /proxy|407 Proxy/i.test(output) ? 'proxy' : 'unknown'
  const messages = {
    refused: 'The local service refused the connection. Check its port and whether it listens on the requested IPv4 or IPv6 address.',
    timeout: 'The local service did not respond before the command timeout.',
    dns: 'The local hostname could not be resolved in the isolated command environment.',
    policy: requested ? 'The OS denied the loopback connection in the isolated command. Inspect the sandbox policy and requested address.' : 'Localhost access was blocked because this command did not request local_network permission.',
    tls: 'The local TLS connection or certificate verification failed.',
    proxy: 'A proxy interfered with the local connection. Check this command’s proxy configuration.',
    unknown: requested ? 'The local request failed; inspect the command output for the underlying error.' : 'This command has no local_network permission. Request it explicitly if the command needs localhost.',
  } as const
  return { kind: code, message: messages[code] }
}
const quote = (value: string) => JSON.stringify(value)
export function commandProfile(root: string, scratch: string, request: CommandRequest): string {
  // Full Mac Access is an explicit filesystem authorization for the active
  // provider. The sandbox still blocks secrets and macOS TCC/SIP still apply.
  const read = request.filesystemMode && request.filesystemMode !== 'project-only'
    ? ['/']
    : ['/System', '/usr', '/bin', '/sbin', '/Library/Apple', '/Library/Developer/CommandLineTools', '/Applications/Xcode.app/Contents/Developer', '/opt/homebrew', '/private/var/db/dyld', '/private/var/select', '/private/preboot', root, scratch]
  const java = developmentEnvironment(scratch, request).JAVA_HOME
  if (java) read.push(java, join(homedir(), '.sdkman/candidates/java'))
  const ancestors = new Set<string>()
  for (const path of read) { let parent = dirname(path); while (parent !== '/') { ancestors.add(parent); parent = dirname(parent) } }
  // TypeScript build-mode checks write incremental metadata here even when
  // emitting no source. Authorize only this cache, not dependency/source edits.
  const writes = [scratch, ...['dist', 'build', 'out', 'coverage', 'node_modules/.tmp'].map((path) => join(root, path))]
  if (request.localServer) writes.push(...['.next', '.turbo', '.vite', '.rspack-cache', 'node_modules/.cache', 'node_modules/.vite'].map((path) => join(root, path)))
  if (request.install) writes.push(join(root, 'node_modules'))
  if (request.gitWrite) writes.push(join(root, '.git'))
  const denyDeveloperConfig = request.filesystemMode === undefined || request.filesystemMode === 'project-only' ? '|\\.claude|\\.codex' : ''
  const approvedReads = request.approvedReadPaths?.length ? validateCommandReadPaths(root, request.approvedReadPaths) : []
  const credentialRule = '(regex #"(^|/)[^/]*[Cc][Rr][Ee][Dd][Ee][Nn][Tt][Ii][Aa][Ll][^/]*(/|$)")'
  // Exclude only literal approved files from the credential READ denial.
  // All other deny rules, and every source/credential write restriction, apply.
  const credentialReadRule = approvedReads.length ? `(require-all ${credentialRule} ${approvedReads.map((path) => `(require-not (literal ${quote(path)}))`).join(' ')})` : credentialRule
  return `(version 1)(deny default)
    (allow process-exec process-fork sysctl-read file-map-executable)
    ${request.loopback || request.localServer ? '(allow mach-lookup (global-name "com.apple.SystemConfiguration.DNSConfiguration")) (allow mach-lookup (global-name "com.apple.dnssd.service")) (allow mach-lookup (global-name "com.apple.system.opendirectoryd.libinfo"))' : ''}
    (allow signal (target self))
    (allow file-read-metadata ${[...ancestors].map((path) => `(literal ${quote(path)})`).join(' ')} (literal "/private/etc") (literal "/private/etc/ssl") ${request.loopback || request.localServer ? '(literal "/etc") (literal "/var") (literal "/private/var") (literal "/private/var/run") (literal "/private/var/run/mDNSResponder")' : ''})
    (allow file-read* ${read.map((path) => `(subpath ${quote(path)})`).join(' ')} (literal "/") (literal "/private") (literal "/dev/null") (literal "/dev/urandom") (literal "/dev/random") (literal "/private/etc/ssl/openssl.cnf") ${request.loopback || request.localServer ? '(literal "/private/etc/hosts") (literal "/etc/hosts") (literal "/private/var/run/mDNSResponder")' : ''})
    (allow file-write* ${writes.map((path) => `(subpath ${quote(path)})`).join(' ')} (literal "/dev/null"))
    ${request.install ? `(allow file-write* ${['package.json', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml'].map((path) => `(literal ${quote(join(root, path))})`).join(' ')})` : ''}
    (deny file-read* ${credentialReadRule})
    (deny file-write* ${credentialRule})
    (deny file-read* file-write* (regex #"(^|/)(\\.env([^/]*|)|[^/]*[Ss]ecrets?[^/]*|id_rsa|id_ed25519)(/|$)"))
    (deny file-read* (regex #"\\.(pem|p12|pfx|key|keystore)$"))
    (deny file-read* file-write* (regex #"(^|/)(\\.aws|\\.azure|\\.kube|\\.docker|\\.ssh|\\.npmrc|\\.netrc|\\.yarnrc|\\.config${denyDeveloperConfig}|\\.gnupg|Keychains|auth\\.json|Login Data)(/|$)"))
    (deny file-read* file-write* (regex #"/Library/(Application Support|Cookies)/.*[Cc]ookies(\\.binarycookies|\\.sqlite)?(/|$)"))
    ${request.executable !== 'git' ? `(deny file-read* file-write* (subpath ${quote(join(root, '.git'))}))` : ''}
    ${request.network ? '(allow network-outbound)' : ''}
    ${request.localServer ? '(allow network-bind (local ip "localhost:*")) (allow network-inbound (local ip "localhost:*"))' : ''}
    ${request.loopback || request.localServer ? '(allow network-outbound (literal "/private/var/run/mDNSResponder") (literal "/var/run/mDNSResponder"))' : ''}
    ${request.localServer || request.loopback ? '(allow network-outbound (remote ip "localhost:*"))' : ''}`
}

export class AgentCommands {
  private available?: Promise<boolean>
  private nodeVersions = new Map<string, string | null>()
  constructor(private strictOffline: () => boolean = () => false) {}
  private async probe(): Promise<boolean> {
    if (process.platform !== 'darwin' || !existsSync('/usr/bin/sandbox-exec')) return false
    const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'athena-isolation-')))
    const allowed = join(scratch, 'allowed'), forbidden = join(scratch, 'forbidden')
    writeFileSync(allowed, 'allowed'); writeFileSync(forbidden, 'forbidden')
    // macOS's dyld ignition opens / to locate its cache; the literal rule does
    // not authorize descendants. Exercise the production policy, not a mock.
    const profile = commandProfile(scratch, scratch, { executable: 'node', args: [], network: false, install: false, gitWrite: false }) + `(deny file-read* (literal ${quote(forbidden)}))`
    const run = (file: string) => new Promise<number | null>((resolve) => {
      const child = spawn('/usr/bin/sandbox-exec', ['-p', profile, '/bin/cat', file], { stdio: 'ignore', env: {} })
      const timer = setTimeout(() => child.kill('SIGKILL'), 3000)
      child.on('error', () => { clearTimeout(timer); resolve(null) }); child.on('close', (code) => { clearTimeout(timer); resolve(code) })
    })
    try { const yes = await run(allowed), no = await run(forbidden); return yes === 0 && no !== null && no !== 0 }
    finally { rmSync(scratch, { recursive: true, force: true }) }
  }
  async supported(): Promise<boolean> { return this.available ??= this.probe() }
  executable(name: string): string {
    if (!['echo', 'npm', 'pnpm', 'yarn', 'node', 'git', 'python3', 'go', 'cargo', 'curl'].includes(name)) throw new ChatError('Only supported development executables are allowed; shell interpreters and command strings are not accepted.')
    if (name === 'echo') return '/bin/echo'
    if (name === 'git') {
      for (const candidate of ['/Applications/Xcode.app/Contents/Developer/usr/bin/git', '/Library/Developer/CommandLineTools/usr/bin/git']) {
        if (existsSync(candidate)) return realpathSync(candidate)
      }
    }
    for (const directory of (developmentEnvironment('/tmp', { executable: name, args: [], network: false, install: false, gitWrite: false }).PATH ?? '').split(':')) {
      const candidate = join(directory, name)
      if (existsSync(candidate)) return realpathSync(candidate)
    }
    throw new ChatError(`${name} is not installed in a supported system location.`)
  }
  packageManager(root: string): string {
    try { const specified = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).packageManager; if (typeof specified === 'string' && /^(npm|pnpm|yarn)@/.test(specified)) return specified.split('@')[0] } catch { /* Fall back to lockfile. */ }
    return existsSync(join(root, 'pnpm-lock.yaml')) ? 'pnpm' : existsSync(join(root, 'yarn.lock')) ? 'yarn' : 'npm'
  }
  private environmentDetails(root: string, executablePath: string, env: NodeJS.ProcessEnv): NonNullable<CommandResult['environment']> {
    let nodeExecutable: string | null = null, nodeVersion: string | null = null
    try {
      nodeExecutable = this.executable('node')
      if (!this.nodeVersions.has(nodeExecutable)) {
        const version = spawnSync(nodeExecutable, ['--version'], { cwd: root, env, encoding: 'utf8', timeout: 2000 })
        this.nodeVersions.set(nodeExecutable, version.status === 0 ? version.stdout.trim() : null)
      }
      nodeVersion = this.nodeVersions.get(nodeExecutable) ?? null
    } catch { /* Non-Node projects remain executable without Node. */ }
    return { workingDirectory: root, executablePath, nodeExecutable, nodeVersion }
  }
  async spawnManaged(root: string, request: CommandRequest, onOutput?: (redactedOutput: string) => void): Promise<ManagedCommand> {
    if (request.approvedReadPaths?.length) throw new ChatError('Exact file read grants are limited to one command, not long-running development servers.')
    if (request.network || request.install) throw new ChatError('Managed development servers do not receive general internet access or dependency-install permission.')
    if (!await this.supported()) throw new ChatError('Secure command isolation is unavailable. Athena cannot start a managed development server in this runtime.')
    const executable = this.executable(request.executable)
    root = realpathSync(root)
    const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'athena-dev-server-')))
    const profile = commandProfile(root, scratch, { ...request, localServer: true })
    try {
      const child = spawn('/usr/bin/sandbox-exec', ['-p', profile, executable, ...request.args], {
        cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: developmentEnvironment(scratch, request),
      })
      // The consumer assembles complete lines before redaction so chunk
      // boundaries cannot leak half of a credential.
      child.stdout.on('data', (chunk: Buffer) => onOutput?.(chunk.toString()))
      child.stderr.on('data', (chunk: Buffer) => onOutput?.(chunk.toString()))
      const { dispose } = managedProcessLifecycle(child, () => rmSync(scratch, { recursive: true, force: true }))
      return { child, dispose }
    } catch (error) {
      rmSync(scratch, { recursive: true, force: true })
      throw error
    }
  }
  async execute(root: string, request: CommandRequest, signal: AbortSignal, onOutput?: (redactedOutput: string) => void): Promise<CommandResult> {
    if (this.strictOffline() && (request.network || request.install)) throw new ChatError('Strict Offline Mode blocks network commands and dependency installation. Disable it in My Athena → Local AI setup before approving this operation.')
    if (!await this.supported()) throw new ChatError('Command execution is disabled: a verified macOS sandbox is unavailable. File tools still work; run validation manually.')
    signal.throwIfAborted()
    const executable = this.executable(request.executable)
    root = realpathSync(root)
    // Validate before allocating resources and again at profile generation.
    request = { ...request, approvedReadPaths: request.approvedReadPaths?.length ? validateCommandReadPaths(root, request.approvedReadPaths) : undefined }
    const release = request.projectLeaseHeld ? () => {} : await projectCommandLease.acquire(root, signal)
    try {
    const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'athena-command-')))
    let profile: string
    try { profile = commandProfile(root, scratch, request) }
    catch (error) { rmSync(scratch, { recursive: true, force: true }); throw error }
    const env: NodeJS.ProcessEnv = { ...developmentEnvironment(scratch, request), GIT_OPTIONAL_LOCKS: request.gitWrite ? '1' : '0' }
    const environment = this.environmentDetails(root, executable, env)
    if (request.executable === 'git' && request.network && existsSync('/etc/ssl/cert.pem')) {
      // The sandbox blocks arbitrary .pem files to protect private keys. Git's
      // system CA bundle is public trust material, so copy only that known file
      // to this command's private scratch area under a non-PEM filename.
      try {
        const bundle = join(scratch, 'system-ca-bundle.crt')
        writeFileSync(bundle, readFileSync('/etc/ssl/cert.pem'), { mode: 0o600 })
        env.GIT_SSL_CAINFO = bundle
      } catch (error) { rmSync(scratch, { recursive: true, force: true }); throw error }
    }
    return await new Promise((resolve, reject) => {
      const child = spawn('/usr/bin/sandbox-exec', ['-p', profile, executable, ...request.args], {
        cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
        env,
      })
      let output = '', stdout = '', stderr = '', streamedBytes = 0, truncated = false, timedOut = false, killTimer: ReturnType<typeof setTimeout> | undefined
      // stdout and stderr are separate byte streams. Keep decoding and line
      // buffers separate so interleaved chunks cannot corrupt UTF-8 or append
      // diagnostics to a streamed Git diff.
      const streamDecoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') }
      const streamLineBuffers = { stdout: '', stderr: '' }
      const kill = (force = false) => { try { if (ownsDetachedProcess(child)) process.kill(-child.pid!, force ? 'SIGKILL' : 'SIGTERM') } catch { /* Already exited. */ } }
      const stop = () => { kill(); killTimer ??= setTimeout(() => kill(true), 500) }
      const timer = setTimeout(() => { timedOut = true; stop() }, 120_000)
      const append = (chunk: Buffer, stream: 'stdout' | 'stderr') => {
        const text = request.streamOutput ? streamDecoders[stream].write(chunk) : chunk.toString()
        if (request.streamOutput) {
          streamedBytes += chunk.byteLength
          const diagnostic = stream === 'stderr' ? stderr : stdout
          if (stream === 'stderr') stderr = (diagnostic + text).slice(-4_000)
          else stdout = (diagnostic + text).slice(-1_000)
          if (streamedBytes > 16 * 1024 * 1024) { truncated = true; stop(); return }
          streamLineBuffers[stream] += text
          let newline = streamLineBuffers[stream].indexOf('\n')
          while (newline >= 0) {
            const line = streamLineBuffers[stream].slice(0, newline + 1)
            if (stream === 'stdout') onOutput?.(redactOutput(line))
            streamLineBuffers[stream] = streamLineBuffers[stream].slice(newline + 1)
            newline = streamLineBuffers[stream].indexOf('\n')
          }
          return
        }
        const remaining = 64_000 - output.length
        if (remaining > 0) {
          const part = text.slice(0, remaining)
          output += part
          if (stream === 'stdout') stdout += part
          else stderr += part
        }
        if (text.length > remaining) { truncated = true; stop() }
        // Hold the incomplete line so a credential split across data chunks
        // cannot be rendered before the complete line is redacted.
        const completeThrough = output.lastIndexOf('\n')
        if (completeThrough >= 0) onOutput?.(redactOutput(output.slice(0, completeThrough + 1)))
      }
      child.stdout.on('data', (chunk: Buffer) => append(chunk, 'stdout'))
      child.stderr.on('data', (chunk: Buffer) => append(chunk, 'stderr'))
      signal.addEventListener('abort', stop, { once: true }); if (signal.aborted) stop()
      const clean = () => { clearTimeout(timer); clearTimeout(killTimer); kill(true); signal.removeEventListener('abort', stop); rmSync(scratch, { recursive: true, force: true }) }
      child.on('error', () => { clean(); reject(new ChatError('Could not start the isolated command.')) })
      child.on('close', (exitCode) => {
        if (request.streamOutput) {
          for (const stream of ['stdout', 'stderr'] as const) {
            streamLineBuffers[stream] += streamDecoders[stream].end()
            if (stream === 'stdout' && streamLineBuffers.stdout) onOutput?.(redactOutput(streamLineBuffers.stdout))
          }
          output = stderr || stdout
        }
        else onOutput?.(redactOutput(output))
        clean()
        const result: CommandResult = { command: [request.executable, ...request.args].join(' '), exitCode, output: redactOutput(output), truncated, timedOut, environment }
        if ((exitCode !== 0 || timedOut) && (request.loopback || /\b(?:localhost|127\.0\.0\.1|::1)\b/i.test(request.args.join(' ')) && /(?:connect|fetch|ECONN|ETIMEDOUT|ENOTFOUND|EPERM|EACCES|proxy|TLS)/i.test(output))) result.localNetworkFailure = localNetworkFailure(output, Boolean(request.loopback || request.network), timedOut)
        const denial = commandFilesystemDenial(root, result.output, request.approvedReadPaths)
        if (denial) result.filesystemDenial = denial
        if (request.approvedReadPaths?.length) result.approvedReadPaths = request.approvedReadPaths
        // Keep channel data available to index-only Git validation without
        // tripling normal tool-result, activity, and conversation payloads.
        Object.defineProperties(result, { stdout: { value: redactOutput(stdout) }, stderr: { value: redactOutput(stderr) } })
        resolve(result)
      })
    })
    } finally { release() }
  }
}
