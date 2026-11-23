import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { access, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'
import { promisify } from 'node:util'
import { APPLICATIONS } from '../../../shared/desktopActions'

const executeFile = promisify(execFile)
export type ApplicationCommandRunner = (file: string, args: string[], options: { timeout: number; maxBuffer: number; signal?: AbortSignal; env?: NodeJS.ProcessEnv; windowsHide?: boolean; encoding?: 'utf8' }) => Promise<{ stdout: string }>
const runCommand: ApplicationCommandRunner = (file, args, options) => executeFile(file, args, { ...options, encoding: 'utf8' })
const fileAvailable = async (path: string, executable: boolean) => {
  try { if (!(await stat(path)).isFile()) return false; await access(path, executable ? constants.R_OK | constants.X_OK : constants.R_OK); return true } catch { return false }
}
const defaults = { platform: process.platform, env: process.env, home: homedir(), run: runCommand, fileAvailable, readText: (path: string) => readFile(path, 'utf8'), now: Date.now }
interface Installation { path: string; executable: string; cli?: string }
export const VSCODE_DETECTION_TTL = 60_000

// The same AppKit discovery convention used by Athena's desktop integrations.
// Query one fixed application, not the user's running application inventory.
const MAC_VSCODE_QUERY = `ObjC.import('AppKit');
function run(argv) {
  var paths = [argv[0], argv[1]], workspace = $.NSWorkspace.sharedWorkspace;
  var registered = workspace.URLForApplicationWithBundleIdentifier(argv[2]);
  if (registered) paths.push(ObjC.unwrap(registered.path));
  for (var i = 0; i < paths.length; i++) {
    var bundle = $.NSBundle.bundleWithPath(paths[i]);
    if (!bundle || ObjC.unwrap(bundle.bundleIdentifier) !== argv[2]) continue;
    var executable = bundle.executableURL;
    if (executable && $.NSFileManager.defaultManager.isExecutableFileAtPath(executable.path))
      return JSON.stringify({ path: paths[i], executable: ObjC.unwrap(executable.path) });
  }
  return 'null';
}`

/** The shared, shell-free macOS folder launch used by desktop tools and the header. */
export function openMacApplicationFolder(target: { bundleId: string } | { path: string }, folder: string, signal?: AbortSignal, run: ApplicationCommandRunner = runCommand) {
  return run('/usr/bin/open', [...('bundleId' in target ? ['-b', target.bundleId] : ['-a', target.path]), '--', folder], { timeout: 5_000, maxBuffer: 16 * 1024, signal })
}

/** Installed editor capability. Paths/executables are never accepted from IPC. */
export class VSCodeApplication {
  private deps: typeof defaults
  private cached?: { installation: Installation | null; at: number }
  private pending?: Promise<Installation | null>
  constructor(dependencies: Partial<typeof defaults> = {}) { this.deps = { ...defaults, ...dependencies } }

  private async valid(installation: Installation): Promise<boolean> {
    if (!await this.deps.fileAvailable(installation.executable, true)) return false
    if (this.deps.platform === 'win32') {
      if (!installation.cli || !await this.deps.fileAvailable(installation.cli, false)) return false
      try {
        const product = JSON.parse(await this.deps.readText(win32.join(win32.dirname(installation.executable), 'resources', 'app', 'product.json')))
        return product.applicationName === 'code' && product.win32AppUserModelId === 'Microsoft.VisualStudioCode'
      } catch { return false }
    }
    return true
  }
  private async discover(): Promise<Installation | null> {
    const { platform, run, home, env } = this.deps
    if (platform === 'darwin') {
      try {
        const { stdout } = await run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', MAC_VSCODE_QUERY, '/Applications/Visual Studio Code.app', posix.join(home, 'Applications', 'Visual Studio Code.app'), APPLICATIONS.vscode.bundleId], { timeout: 5_000, maxBuffer: 16 * 1024, env })
        const value = JSON.parse(stdout)
        if (!value || typeof value.path !== 'string' || typeof value.executable !== 'string' || !posix.isAbsolute(value.path) || !value.path.endsWith('.app') || !value.executable.startsWith(`${value.path}/Contents/MacOS/`) || value.executable.includes('/../')) return null
        return await this.valid(value) ? { path: value.path, executable: value.executable } : null
      } catch { return null }
    }
    if (platform !== 'win32') return null
    const candidates = [
      win32.join(env.LOCALAPPDATA || win32.join(home, 'AppData', 'Local'), 'Programs', 'Microsoft VS Code', 'Code.exe'),
      ...[env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramW6432, 'C:\\Program Files'].filter((path): path is string => !!path).map(path => win32.join(path, 'Microsoft VS Code', 'Code.exe')),
    ]
    const inspect = async (path: string): Promise<Installation | null> => {
      if (!/^[a-z]:\\/i.test(path) || win32.basename(path).toLowerCase() !== 'code.exe' || path.includes('\0')) return null
      const installation = { path, executable: path, cli: win32.join(win32.dirname(path), 'resources', 'app', 'out', 'cli.js') }
      return await this.valid(installation) ? installation : null
    }
    for (const path of new Set(candidates)) { const found = await inspect(path); if (found) return found }
    // App Paths and Applications registrations support custom installation folders.
    const registry = win32.join(env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe')
    for (const registration of ['Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Code.exe', 'Software\\Classes\\Applications\\Code.exe\\shell\\open\\command']) for (const hive of ['HKCU', 'HKLM']) for (const view of ['64', '32']) {
      try {
        const { stdout } = await run(registry, ['query', `${hive}\\${registration}`, '/ve', `/reg:${view}`], { timeout: 2_000, maxBuffer: 16 * 1024, windowsHide: true, env })
        const raw = stdout.match(/REG_(?:EXPAND_)?SZ\s+([^\r\n]+)/i)?.[1]?.trim()
        if (!raw) continue
        // Extract only the registered executable. Never execute a registry command
        // string, its shell operators, placeholders or saved arguments.
        const executable = registration.endsWith('command') ? raw.match(/^"([^"\r\n]+\\Code\.exe)"(?:\s|$)/i)?.[1] : raw.replace(/^"(.*)"$/, '$1')
        if (!executable) continue
        const path = executable.replace(/%([^%]+)%/g, (match, key: string) => Object.entries(env).find(([name]) => name.toLowerCase() === key.toLowerCase())?.[1] ?? match)
        const found = await inspect(path); if (found) return found
      } catch { /* Missing registry entries are normal. */ }
    }
    return null
  }
  private resolve(force = false): Promise<Installation | null> {
    if (this.pending) return this.pending
    if (!force && this.cached && this.deps.now() - this.cached.at < VSCODE_DETECTION_TTL) return Promise.resolve(this.cached.installation)
    this.pending = this.discover().then(installation => { this.cached = { installation, at: this.deps.now() }; return installation }).finally(() => { this.pending = undefined })
    return this.pending
  }
  async available(): Promise<boolean> { return !!await this.resolve() }
  async openFolder(folder: string, authorize: () => Promise<void>): Promise<void> {
    // Recheck even a cached installation immediately before launch.
    const installation = await this.resolve(true)
    if (!installation) throw new Error('vscode-unavailable')
    await authorize()
    try {
      if (this.deps.platform === 'darwin') await openMacApplicationFolder({ path: installation.path }, folder, undefined, this.deps.run)
      else {
        // Use VS Code's bundled CLI exactly as code.cmd does, without cmd.exe or PATH.
        // The CLI exits after dispatch; the editor process is not timed out/killed.
        const env: NodeJS.ProcessEnv = { ...this.deps.env, ELECTRON_RUN_AS_NODE: '1' }; delete env.VSCODE_DEV; delete env.NODE_OPTIONS
        await this.deps.run(installation.executable, [installation.cli!, '--new-window', '--', folder], { timeout: 15_000, maxBuffer: 64 * 1024, windowsHide: true, env })
      }
    } catch (error) { this.cached = undefined; throw error }
  }
}
