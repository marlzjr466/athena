// @vitest-environment node
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const mock = vi.hoisted(() => ({ trusted: vi.fn(() => true), notification: undefined as unknown, mode: 'show' }))
vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => process.cwd() }, systemPreferences: { isTrustedAccessibilityClient: mock.trusted }, Notification: class extends EventEmitter {
  static isSupported() { return true }
  constructor(public options: unknown) { super(); mock.notification = this }
  show() { if (mock.mode !== 'silent') this.emit(mock.mode) }
  close() { this.emit('close') }
} }))
import { MacOSDesktopPlatform } from '../electron/main/desktop/macOSDesktopPlatform'

beforeEach(() => { vi.clearAllMocks(); mock.mode = 'show'; mock.trusted.mockReturnValue(true) })
afterEach(() => vi.useRealTimers())
describe('macOS desktop action adapters', () => {
  it('gets the foreground app from the same native workspace that resolves windows', async () => {
    const apps = [{ app: 'com.apple.TextEdit', name: 'TextEdit', active: true }, { app: 'com.apple.finder', name: 'Finder', active: false }]
    const run = vi.fn().mockResolvedValue({ stdout: JSON.stringify({ apps }) })
    const platform = new MacOSDesktopPlatform('darwin', run)
    expect(await platform.runningApplications(new AbortController().signal)).toEqual(apps)
    expect(run.mock.calls[0][1]).toEqual(['', 'workspace', JSON.stringify({ operation: 'running' })])
    platform.dispose()
  })
  it('observes first, launches only a stopped app and verifies the foreground', async () => {
    const state=(running:boolean,focused:boolean)=>JSON.stringify({running,focused,pid:running?40:0,foreground:29,windows:[]})
    const run=vi.fn().mockResolvedValueOnce({stdout:state(false,false)}).mockResolvedValueOnce({stdout:''})
      .mockResolvedValueOnce({stdout:state(true,false)}).mockResolvedValueOnce({stdout:JSON.stringify({ok:true,message:'Focused'})})
    const platform=new MacOSDesktopPlatform('darwin',run)
    expect(await platform.openApplication('vscode',new AbortController().signal)).toMatchObject({ok:true,status:'completed'})
    expect(run.mock.calls[0][1]).toEqual(['com.microsoft.VSCode','workspace',expect.stringContaining('observe')])
    expect(run.mock.calls[1][0]).toBe('/usr/bin/open')
    expect(run.mock.calls[3][1][2]).toContain('activate')
    run.mockReset().mockResolvedValue({stdout:state(true,true)})
    expect((await platform.openApplication('vscode',new AbortController().signal)).message).toContain('already')
    expect(run).toHaveBeenCalledOnce()
    platform.dispose()
  })
  it('does not report a launch before a running process is observed',async()=>{
    const run=vi.fn(async()=>({stdout:JSON.stringify({running:false,focused:false,pid:0,foreground:10,windows:[]})}))
    const platform=new MacOSDesktopPlatform('darwin',run)
    expect((await platform.openApplication('slack',new AbortController().signal)).ok).toBe(false)
    run.mockClear()
    expect(await platform.focusApplication('slack',new AbortController().signal)).toMatchObject({ok:false,message:expect.stringContaining('not running')})
    expect(run).toHaveBeenCalledOnce()
    platform.dispose()
  })
  it('blocks custom URL schemes before Electron sees them and accurately reports accepted web links', async () => {
    const run = vi.fn(async () => ({ stdout: '' }))
    const platform = new MacOSDesktopPlatform('darwin', run)
    await expect(platform.openURL('file:///etc/passwd', new AbortController().signal)).rejects.toThrow()
    expect(await platform.openURL('https://example.com', new AbortController().signal)).toMatchObject({ ok: true, status: 'submitted' })
    expect(run).toHaveBeenCalledWith('/usr/bin/open', ['https://example.com/'], expect.objectContaining({ timeout: 8000 }))
    platform.dispose()
  })
  it('records notification delivery events, rate limits, and does not claim suppressed notifications were shown', async () => {
    vi.useFakeTimers()
    const platform = new MacOSDesktopPlatform('darwin')
    expect(await platform.showNotification('Done', 'Finished.', new AbortController().signal)).toMatchObject({ status: 'completed' })
    expect(await platform.showNotification('Again', 'Finished.', new AbortController().signal)).toMatchObject({ status: 'denied' })
    vi.advanceTimersByTime(5000); mock.mode = 'silent'
    const pending = platform.showNotification('Done', 'Finished.', new AbortController().signal)
    await vi.advanceTimersByTimeAsync(2000)
    expect(await pending).toMatchObject({ status: 'submitted' })
    platform.dispose()
  })
  it('aborts pending notifications on disposal and refuses new operations', async () => {
    mock.mode = 'silent'
    const run = vi.fn(async () => ({ stdout: '' }))
    const platform = new MacOSDesktopPlatform('darwin', run)
    const pending = platform.showNotification('Done', 'Finished.', new AbortController().signal)
    platform.dispose()
    expect(await pending).toMatchObject({ status: 'cancelled' })
    await expect(platform.openURL('https://example.com', new AbortController().signal)).rejects.toThrow()
    expect(run).not.toHaveBeenCalled()
  })
  it('inspects named accessibility controls without using screen coordinates and requires macOS trust', async () => {
    const run = vi.fn(async (_file: string, _args: string[], _options: { timeout: number; maxBuffer: number; signal: AbortSignal; encoding?: 'utf8' }) => ({ stdout: JSON.stringify({ app: 'com.microsoft.VSCode', window: 'Untitled', elements: [{ label: 'Search', role: 'AXTextField', enabled: true, value: '' }], verified: true, changed: false, message: 'Accessible controls were read.' }) }))
    const platform = new MacOSDesktopPlatform('darwin', run)
    const result = await platform.inspectAccessibility('vscode', new AbortController().signal)
    expect(result).toMatchObject({ app: 'Visual Studio Code', window: 'Untitled', elements: [{ label: 'Search', role: 'AXTextField' }] })
    expect(run.mock.calls[0]?.[0]).toMatch(/build\/native\/athena-desktop-accessibility$/)
    expect(run.mock.calls[0]?.[1]).toEqual(['com.microsoft.VSCode', 'inspect', '', '', ''])
    mock.trusted.mockReturnValue(false)
    const denied = new MacOSDesktopPlatform('darwin', vi.fn())
    await expect(denied.inspectAccessibility('vscode', new AbortController().signal)).rejects.toThrow('Enable Accessibility UI Control')
    denied.dispose(); platform.dispose()
  })
  it('does not claim an accessible click succeeded without an observed state change', async () => {
    const run = vi.fn(async (_file: string, _args: string[], _options: { timeout: number; maxBuffer: number; signal: AbortSignal; encoding?: 'utf8' }) => ({ stdout: JSON.stringify({ app: 'com.microsoft.VSCode', window: 'Untitled', elements: [{ label: 'Run', role: 'AXButton', enabled: true }], verified: false, changed: false, message: 'The action was invoked, but Athena could not verify a visible state change.' }) }))
    const platform = new MacOSDesktopPlatform('darwin', run)
    expect(await platform.clickAccessibleElement('vscode', 'Run', new AbortController().signal)).toMatchObject({ ok: false, verified: false })
    expect(run.mock.calls[0]?.[1]?.at(-3)).toBe('Run')
    platform.dispose()
  })
})
