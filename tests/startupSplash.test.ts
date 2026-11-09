// @vitest-environment node
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrowserWindow, ipcMain } from 'electron'
import { StartupSplash } from '../electron/main/startupSplash'
import { STARTUP_IPC } from '../shared/startup'

const mock = vi.hoisted(() => ({ windows: [] as any[], handlers: new Map<string, Function>(), quit: vi.fn() }))
vi.mock('../electron/main/logger', () => ({ log: vi.fn() }))
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  class Window extends EventEmitter {
    destroyed = false
    visible = false
    url = ''
    webContents = Object.assign(new EventEmitter(), {
      mainFrame: { url: '' }, setWindowOpenHandler: vi.fn(), send: vi.fn(), getURL: () => this.url,
    })
    constructor(public options: unknown) { super(); mock.windows.push(this) }
    loadURL = vi.fn(async (url: string) => { this.url = url; this.webContents.mainFrame.url = url })
    isDestroyed = () => this.destroyed
    destroy = vi.fn(() => { this.destroyed = true; this.emit('closed') })
    close = vi.fn(() => { this.emit('close'); this.destroyed = true; this.emit('closed') })
    show = vi.fn(() => { this.visible = true })
    focus = vi.fn()
    moveTop = vi.fn()
    setOpacity = vi.fn()
    setIgnoreMouseEvents = vi.fn()
    setBounds = vi.fn()
    getBounds = () => ({ x: 100, y: 100, width: 1240, height: 860 })
  }
  return { BrowserWindow: Window, app: { isPackaged: true, quit: mock.quit },
    ipcMain: Object.assign(new EventEmitter(), {
      handle: (channel: string, handler: Function) => mock.handlers.set(channel, handler),
      removeHandler: (channel: string) => mock.handlers.delete(channel),
    }) }
})

beforeEach(() => { vi.useFakeTimers(); mock.windows.length = 0; mock.handlers.clear(); mock.quit.mockClear() })
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); (ipcMain as unknown as EventEmitter).removeAllListeners() })
function fixture() {
  const fail = vi.fn(), reveal = vi.fn(), finished = vi.fn()
  const startup = new StartupSplash(undefined, fail)
  startup.create()
  const splash = mock.windows[0]
  const control = new BrowserWindow({})
  void control.loadURL('athena://renderer/index.html?surface=control')
  startup.bindControl(control, reveal, finished)
  const paint = () => ipcMain.emit(STARTUP_IPC.ready, { sender: control.webContents, senderFrame: control.webContents.mainFrame })
  return { startup, splash, control, fail, reveal, finished, paint }
}

describe('native splash lifecycle', () => {
  it('creates one sandboxed splash and waits for native paint, connected UI, and services', () => {
    const f = fixture(); f.startup.create()
    expect(mock.windows).toHaveLength(2)
    expect(f.splash.options.webPreferences).toMatchObject({ sandbox: true, contextIsolation: true, nodeIntegration: false })
    f.splash.emit('ready-to-show')
    expect(f.splash.show).toHaveBeenCalledOnce()
    f.paint(); f.startup.servicesReady()
    vi.advanceTimersByTime(6000)
    expect(f.reveal).not.toHaveBeenCalled()
    f.control.emit('ready-to-show')
    expect(f.reveal).toHaveBeenCalledOnce()
    vi.advanceTimersByTime(500)
    expect(f.splash.setOpacity.mock.lastCall[0]).toBeGreaterThan(0)
    expect(f.splash.setOpacity.mock.lastCall[0]).toBeLessThan(1)
    expect(f.splash.destroyed).toBe(false)
    vi.advanceTimersByTime(500)
    expect(f.finished).toHaveBeenCalledOnce()
    expect(f.splash.destroyed).toBe(true)
    expect(f.startup.active).toBe(false)
    expect(ipcMain.listenerCount(STARTUP_IPC.ready)).toBe(0)
    expect(mock.handlers.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('rejects readiness messages from other windows and child frames', () => {
    const f = fixture(); f.splash.emit('ready-to-show'); f.control.emit('ready-to-show'); f.startup.servicesReady()
    ipcMain.emit(STARTUP_IPC.ready, { sender: f.splash.webContents, senderFrame: f.splash.webContents.mainFrame })
    ipcMain.emit(STARTUP_IPC.ready, { sender: f.control.webContents, senderFrame: { url: f.control.webContents.getURL() } })
    vi.advanceTimersByTime(6000)
    expect(f.reveal).not.toHaveBeenCalled()
    f.paint(); vi.advanceTimersByTime(1000)
    expect(f.finished).toHaveBeenCalledOnce()
  })
  it('rejects splash state requests from the application renderer', () => {
    const f = fixture()
    const handler = mock.handlers.get(STARTUP_IPC.state)!
    expect(() => handler({ sender: f.control.webContents, senderFrame: f.control.webContents.mainFrame })).toThrow('Untrusted')
    expect(handler({ sender: f.splash.webContents, senderFrame: f.splash.webContents.mainFrame }).durationMs).toBe(6000)
    f.startup.dispose()
  })
  it('continues after a splash crash without revealing an unready application', () => {
    const f = fixture()
    f.splash.webContents.emit('render-process-gone')
    expect(f.splash.destroyed).toBe(true)
    expect(f.reveal).not.toHaveBeenCalled()
    f.paint(); f.control.emit('ready-to-show'); f.startup.servicesReady()
    vi.advanceTimersByTime(0)
    expect(f.finished).toHaveBeenCalledOnce()
    expect(f.fail).not.toHaveBeenCalled()
  })
  it('reports main-frame load errors and releases all splash resources', () => {
    const f = fixture()
    f.control.webContents.emit('did-fail-load', {}, -105, 'failed', 'athena://renderer/', true)
    expect(f.fail).toHaveBeenCalledOnce()
    expect(f.splash.destroyed).toBe(true)
    expect(f.reveal).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('cleans up while quitting during the crossfade', () => {
    const f = fixture(); f.splash.emit('ready-to-show'); f.paint(); f.control.emit('ready-to-show'); f.startup.servicesReady()
    vi.advanceTimersByTime(5200)
    f.startup.dispose(); vi.advanceTimersByTime(60000)
    expect(f.finished).not.toHaveBeenCalled()
    expect(f.splash.close).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
    expect(ipcMain.listenerCount(STARTUP_IPC.ready)).toBe(0)
  })
})
