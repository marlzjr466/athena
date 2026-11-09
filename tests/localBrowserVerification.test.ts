// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'

const fake = vi.hoisted(() => ({
  options: undefined as unknown,
  partition: '',
  requestHandler: undefined as ((details: { url: string }, callback: (result: { cancel: boolean }) => void) => void) | undefined,
  loadedURL: '',
  destroyed: false,
  debuggerCommands: [] as Array<[string, unknown]>,
  clearStorage: vi.fn(async () => {}),
  clearCache: vi.fn(async () => {}),
}))
vi.mock('electron', () => {
  class TestBrowserWindow {
    webContents = {
      debugger: {
        attach: vi.fn(),
        isAttached: vi.fn(() => true), detach: vi.fn(),
        sendCommand: vi.fn(async (command: string, args?: unknown) => { fake.debuggerCommands.push([command, args]) }),
      },
      on: vi.fn(), removeListener: vi.fn(), setWindowOpenHandler: vi.fn(), focus: vi.fn(), sendInputEvent: vi.fn(),
      executeJavaScript: vi.fn(async (script: string) => {
        if (script.includes('const selectors =')) return { title: 'Local fixture', url: 'http://127.0.0.1:43210/', bodyText: 'Fixture page', elements: [{ selector: 'button.primary', found: true, visible: true, rect: { x: 10, y: 10, width: 100, height: 30 }, text: 'Continue' }] }
        if (script.includes("matches(':hover')")) return true
        if (script.includes('.focus()')) return true
        return undefined
      }),
    }
    constructor(options: unknown) { fake.options = options; fake.destroyed = false }
    async loadURL(url: string) { fake.loadedURL = url }
    focus() {}
    isDestroyed() { return fake.destroyed }
    destroy() { fake.destroyed = true }
  }
  return {
    app: { focus: vi.fn() },
    BrowserWindow: TestBrowserWindow,
    session: { fromPartition(partition: string) {
      fake.partition = partition
      return { webRequest: { onBeforeRequest(handler: typeof fake.requestHandler) { fake.requestHandler = handler } }, clearStorageData: fake.clearStorage, clearCache: fake.clearCache }
    } },
  }
})
import { BrowserInspector as LocalBrowserVerificationService, resolveLocalBrowserURL } from '../electron/main/ai/browserInspector'

describe('isolated local browser verification', () => {
  it('requires its independent permission and rejects external URLs and protocols', async () => {
    await expect(new LocalBrowserVerificationService(() => false).inspect('http://127.0.0.1:43210', '/', 'desktop')).rejects.toThrow('not authorized')
    expect(() => resolveLocalBrowserURL('file:///tmp/index.html', '/')).toThrow('loopback')
    expect(() => resolveLocalBrowserURL('http://127.0.0.1:43210', '//example.com')).toThrow('relative route')
  })

  it('uses a temporary hardened Electron window and reports actual page, viewport, hover, focus, and console evidence', async () => {
    fake.requestHandler = undefined; fake.debuggerCommands = []; fake.clearStorage.mockClear(); fake.clearCache.mockClear()
    const verifier = new LocalBrowserVerificationService(() => true)
    const result = await verifier.inspect('http://127.0.0.1:43210', '/', 'mobile', ['button.primary'])
    expect(fake.loadedURL).toBe('http://127.0.0.1:43210/')
    expect(fake.partition).toMatch(/^athena-browser-verification-/)
    expect(fake.partition).not.toContain('persist:')
    expect(fake.options).toMatchObject({ width: 390, height: 844, show: true, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, devTools: false, webSecurity: true } })
    expect(fake.debuggerCommands[0]).toEqual(['Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true }])
    expect(result).toMatchObject({ title: 'Local fixture', viewport: { width: 390, height: 844 }, bodyText: 'Fixture page', selectors: [{ found: true, visible: true, hoverable: true, focusable: true, text: 'Continue' }], consoleErrors: [] })
    let externalRequest = { cancel: false }
    fake.requestHandler!({ url: 'https://example.com/private' }, (result) => { externalRequest = result })
    expect(externalRequest.cancel).toBe(true)
    let localRequest = { cancel: true }
    fake.requestHandler!({ url: 'http://127.0.0.1:43210/assets/app.js' }, (result) => { localRequest = result })
    expect(localRequest.cancel).toBe(false)
    expect(fake.destroyed).toBe(true)
    expect(fake.clearStorage).toHaveBeenCalledOnce()
    expect(fake.clearCache).toHaveBeenCalledOnce()
  })
})
