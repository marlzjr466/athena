// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { VSCodeApplication, VSCODE_DETECTION_TTL } from '../electron/main/desktop/vscodeApplication'

const mac = { path: '/Applications/Visual Studio Code.app', executable: '/Applications/Visual Studio Code.app/Contents/MacOS/Electron' }
const product = JSON.stringify({ applicationName: 'code', win32AppUserModelId: 'Microsoft.VisualStudioCode' })
describe('installed VS Code detection and shell-free launching', () => {
  it.runIf(process.env.ATHENA_VSCODE_LIVE === '1' && process.platform === 'darwin')('detects the real macOS installation with no code CLI in PATH', async () => {
    expect(await new VSCodeApplication({ env: { ...process.env, PATH: '' } }).available()).toBe(true)
  })
  it('uses macOS applications and Launch Services without a code CLI in PATH', async () => {
    const run = vi.fn(async () => ({ stdout: JSON.stringify(mac) }))
    const app = new VSCodeApplication({ platform: 'darwin', env: { PATH: '' }, home: '/Users/test', run, fileAvailable: async () => true })
    expect(await app.available()).toBe(true)
    expect(run.mock.calls[0]).toEqual(['/usr/bin/osascript', expect.arrayContaining(['/Applications/Visual Studio Code.app', '/Users/test/Applications/Visual Studio Code.app', 'com.microsoft.VSCode']), expect.objectContaining({ timeout: 5000 })])
    const validate = vi.fn(async () => {})
    await app.openFolder('/projects/a folder; $(not-a-command)', validate)
    expect(validate).toHaveBeenCalledOnce()
    expect(run).toHaveBeenLastCalledWith('/usr/bin/open', ['-a', mac.path, '--', '/projects/a folder; $(not-a-command)'], expect.objectContaining({ timeout: 5000 }))
  })
  it('accepts valid system discovery outside standard macOS locations', async () => {
    const path = '/Volumes/Tools/Visual Studio Code.app'
    const run = vi.fn(async () => ({ stdout: JSON.stringify({ path, executable: `${path}/Contents/MacOS/Electron` }) }))
    expect(await new VSCodeApplication({ platform: 'darwin', run, fileAvailable: async () => true }).available()).toBe(true)
  })
  it('caches positive and negative detection, deduplicates checks, and discovers installation changes', async () => {
    let now = 0
    const run = vi.fn(async () => ({ stdout: 'null' }))
    const app = new VSCodeApplication({ platform: 'darwin', run, fileAvailable: async () => true, now: () => now })
    expect(await Promise.all([app.available(), app.available()])).toEqual([false, false])
    await app.available(); expect(run).toHaveBeenCalledTimes(1)
    now += VSCODE_DETECTION_TTL
    run.mockResolvedValue({ stdout: JSON.stringify(mac) }); expect(await app.available()).toBe(true)
    await app.available(); expect(run).toHaveBeenCalledTimes(2)
    now += VSCODE_DETECTION_TTL
    run.mockResolvedValue({ stdout: 'null' }); expect(await app.available()).toBe(false)
  })
  it('revalidates before launch and does not launch a removed or unlaunchable installation', async () => {
    const run = vi.fn(async () => ({ stdout: JSON.stringify(mac) })), fileAvailable = vi.fn(async () => true)
    const app = new VSCodeApplication({ platform: 'darwin', run, fileAvailable })
    expect(await app.available()).toBe(true)
    fileAvailable.mockResolvedValue(false)
    await expect(app.openFolder('/project', async () => {})).rejects.toThrow('vscode-unavailable')
    expect(run.mock.calls.every(call => (call as unknown[])[0] === '/usr/bin/osascript')).toBe(true)
  })
  it('does not launch after project authorization is revoked during detection', async () => {
    const run = vi.fn(async () => ({ stdout: JSON.stringify(mac) }))
    const app = new VSCodeApplication({ platform: 'darwin', run, fileAvailable: async () => true })
    await expect(app.openFolder('/project', async () => { throw new Error('Project changed') })).rejects.toThrow('Project changed')
    expect(run).toHaveBeenCalledOnce()
  })
  it.each(['C:\\Users\\Test\\AppData\\Local\\Programs\\Microsoft VS Code', 'C:\\Program Files\\Microsoft VS Code'])('launches a Windows installation using its bundled CLI: %s', async root => {
    const run = vi.fn(async () => ({ stdout: '' }))
    const app = new VSCodeApplication({ platform: 'win32', home: 'C:\\Users\\Test', env: { PATH: '', ProgramFiles: 'C:\\Program Files', NODE_OPTIONS: '--require bad.js', VSCODE_DEV: '1' }, run, fileAvailable: async path => path.startsWith(`${root}\\`), readText: async () => product })
    expect(await app.available()).toBe(true)
    await app.openFolder('C:\\projects\\a & b', async () => {})
    expect(run).toHaveBeenCalledExactlyOnceWith(`${root}\\Code.exe`, [`${root}\\resources\\app\\out\\cli.js`, '--new-window', '--', 'C:\\projects\\a & b'], expect.objectContaining({ windowsHide: true, timeout: 15000, env: { PATH: '', ProgramFiles: 'C:\\Program Files', ELECTRON_RUN_AS_NODE: '1' } }))
  })
  it.each(['HKCU', 'HKLM'])('discovers custom registered Windows installations in %s', async hive => {
    const root = 'D:\\Apps\\VSCode'
    const run = vi.fn(async (_file: string, args: string[]) => ({ stdout: args[1]?.startsWith(`${hive}\\`) && args.includes('/reg:32') ? `    (Default)    REG_EXPAND_SZ    "%TOOLS%\\Code.exe"\r\n` : '' }))
    const app = new VSCodeApplication({ platform: 'win32', env: { TOOLS: root }, home: 'C:\\Users\\Test', run, fileAvailable: async path => path.startsWith(root), readText: async () => product })
    expect(await app.available()).toBe(true)
    expect(run).toHaveBeenCalledWith('C:\\Windows\\System32\\reg.exe', ['query', `${hive}\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Code.exe`, '/ve', '/reg:32'], expect.objectContaining({ timeout: 2000 }))
  })
  it('rejects registry shell strings, missing CLI resources, and a different product', async () => {
    const run = vi.fn(async () => ({ stdout: '    (Default)    REG_SZ    C:\\Tools\\Code.exe & calc.exe' }))
    expect(await new VSCodeApplication({ platform: 'win32', env: {}, run, fileAvailable: async () => false }).available()).toBe(false)
    expect(await new VSCodeApplication({ platform: 'win32', env: {}, run, fileAvailable: async () => true, readText: async () => '{"applicationName":"other"}' }).available()).toBe(false)
    expect(run.mock.calls.every(call => String((call as unknown[])[0]).endsWith('reg.exe'))).toBe(true)
  })
  it('reads Applications registrations without forwarding their stored command arguments', async () => {
    const root = 'D:\\Custom VS Code'
    const run = vi.fn(async (_file: string, args: string[]) => ({ stdout: args[1]?.includes('Classes\\Applications') ? ` (Default) REG_SZ "${root}\\Code.exe" "%1"` : '' }))
    const app = new VSCodeApplication({ platform: 'win32', env: {}, home: 'C:\\Users\\Test', run, fileAvailable: async path => path.startsWith(root), readText: async () => product })
    expect(await app.available()).toBe(true)
    await app.openFolder('C:\\project', async () => {})
    expect(run).toHaveBeenLastCalledWith(`${root}\\Code.exe`, [`${root}\\resources\\app\\out\\cli.js`, '--new-window', '--', 'C:\\project'], expect.any(Object))
  })
  it('does not expose a button on unsupported operating systems', async () => {
    const run = vi.fn()
    expect(await new VSCodeApplication({ platform: 'linux', run }).available()).toBe(false)
    expect(run).not.toHaveBeenCalled()
  })
})
