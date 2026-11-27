// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { WindowsDesktopPlatform } from '../electron/main/desktop/windowsDesktopPlatform'
vi.mock('electron', () => ({ shell: {}, Notification: class {} }))
describe('Windows UI Automation adapter (mocked runner)', () => {
  it('encodes user data separately and preserves the observed window identity', async () => {
    const calls: Array<{ args: string[]; data: Record<string, unknown>; code: string }> = []
    const adapter = new WindowsDesktopPlatform(async (_file, args) => {
      const code = Buffer.from(args.at(-1)!, 'base64').toString('utf16le')
      const data = JSON.parse(Buffer.from(code.match(/FromBase64String\('([^']+)'\)/)![1], 'base64').toString())
      calls.push({ args, data, code })
      return { stdout: JSON.stringify(data.action === 'inspect' ? { app: 'vscode', window: 'Fixture', windowToken: '123:456', elements: [] } : { ok: true, verified: true, message: 'Changed' }), stderr: '' }
    })
    const signal = new AbortController().signal
    await adapter.inspectAccessibility('vscode', signal)
    await adapter.setAccessibleText('vscode', 'Editor', "'; Stop-Process -Name anything; #", signal)
    expect(calls[1].data).toMatchObject({ token: '123:456', text: "'; Stop-Process -Name anything; #" })
    expect(calls[1].code).not.toContain('Stop-Process -Name anything')
    expect(calls[1].args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-EncodedCommand'])
    await adapter.pressShortcut('vscode', 'enter', signal)
    expect(calls[2].data.token).toBe('')
    adapter.dispose()
  })
  it('reports OS/integrity failures without claiming success or elevating', async () => {
    const runner = vi.fn(async () => { throw new Error('Access denied') })
    const adapter = new WindowsDesktopPlatform(runner)
    await expect(adapter.inspectAccessibility('vscode', new AbortController().signal)).rejects.toThrow(/same integrity level/)
    expect(JSON.stringify(runner.mock.calls)).not.toMatch(/RunAs|ExecutionPolicy|Bypass/)
    adapter.dispose()
  })
})
