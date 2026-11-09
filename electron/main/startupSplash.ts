import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { splashDurationMs, STARTUP_IPC, type StartupPresentation } from '../../shared/startup'
import { StartupGate } from './startupGate'
import { log } from './logger'

const directory = fileURLToPath(new URL('.', import.meta.url))

export class StartupSplash {
  active = true
  private window?: BrowserWindow
  private control?: BrowserWindow
  private nativeReady = false
  private appReady = false
  private initialized = false
  private fade?: ReturnType<typeof setInterval>
  private cleanups: Array<() => void> = []
  private reveal = () => {}
  private finished = () => {}
  private state: StartupPresentation
  private gate: StartupGate

  constructor(duration: string | undefined, private fail: (message: string) => void) {
    this.state = { stage: 'intro', durationMs: splashDurationMs(duration), startedAt: 0 }
    this.gate = new StartupGate(this.state.durationMs, {
      waiting: () => this.stage('waiting'),
      transition: fade => this.transition(fade),
      complete: () => { this.dispose(); this.finished() },
      timeout: () => this.fatal('Athena’s workspace did not become ready. Please restart the app.'),
    })
  }

  create(): void {
    if (this.window || !this.active) return
    const window = this.window = new BrowserWindow({
      width: 1240, height: 860, show: false, frame: false, resizable: false,
      title: 'Athena — Starting', backgroundColor: '#050810',
      webPreferences: { preload: join(directory, '../preload/splash.cjs'), sandbox: true,
        contextIsolation: true, nodeIntegration: false, webSecurity: true, backgroundThrottling: false },
    })
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', event => event.preventDefault())
    window.webContents.on('will-attach-webview', event => event.preventDefault())
    const url = new URL('splash.html', !app.isPackaged && process.env.ELECTRON_RENDERER_URL || 'athena://renderer/')
    const trusted = (event: Electron.IpcMainInvokeEvent) => event.sender === window.webContents
      && event.senderFrame === window.webContents.mainFrame && event.senderFrame.url === url.href
    ipcMain.handle(STARTUP_IPC.state, event => {
      if (!trusted(event)) throw new Error('Untrusted splash request')
      return this.state
    })
    this.cleanups.push(() => ipcMain.removeHandler(STARTUP_IPC.state))
    window.once('ready-to-show', () => {
      if (!this.active || window.isDestroyed()) return
      window.show()
      this.state.startedAt = Date.now()
      this.stage('intro')
      this.gate.present()
    })
    window.on('close', () => { if (this.active) app.quit() })
    window.webContents.on('render-process-gone', () => this.unavailable())
    window.webContents.on('did-fail-load', (_event, code, _description, _url, isMainFrame) => {
      if (isMainFrame && code !== -3) this.unavailable()
    })
    void window.loadURL(url.href).catch(() => this.unavailable())
  }

  bindControl(control: BrowserWindow, reveal: () => void, finished: () => void): void {
    this.control = control; this.reveal = reveal; this.finished = finished
    if (this.window && !this.window.isDestroyed()) this.window.setBounds(control.getBounds())
    const ready = () => { this.nativeReady = true; this.reconcile() }
    const painted = (event: Electron.IpcMainEvent) => {
      if (event.sender !== control.webContents || event.senderFrame !== control.webContents.mainFrame
        || event.senderFrame?.url !== control.webContents.getURL()) return
      this.appReady = true; this.reconcile()
    }
    const failed = (_event: Electron.Event, code: number, _description: string, _url: string, isMainFrame: boolean) => {
      if (isMainFrame && code !== -3) this.fatal('Athena’s workspace could not load. Please restart the app.')
    }
    const crashed = () => this.fatal('Athena’s workspace stopped during startup. Please restart the app.')
    control.once('ready-to-show', ready)
    control.webContents.on('did-fail-load', failed)
    control.webContents.on('render-process-gone', crashed)
    ipcMain.on(STARTUP_IPC.ready, painted)
    this.cleanups.push(() => {
      control.removeListener('ready-to-show', ready)
      control.webContents.removeListener('did-fail-load', failed)
      control.webContents.removeListener('render-process-gone', crashed)
      ipcMain.removeListener(STARTUP_IPC.ready, painted)
    })
  }

  servicesReady(): void { this.initialized = true; this.reconcile() }
  private reconcile(): void { if (this.nativeReady && this.appReady && this.initialized) this.gate.mainReady() }
  focus(): void { if (this.active && this.window && !this.window.isDestroyed()) { this.window.show(); this.window.focus() } }
  private stage(stage: StartupPresentation['stage']): void {
    this.state.stage = stage
    if (this.window && !this.window.isDestroyed()) this.window.webContents.send(STARTUP_IPC.stage, this.state)
  }
  private transition(duration: number): void {
    if (!this.active || this.control?.isDestroyed()) return
    if (this.window && !this.window.isDestroyed()) this.control?.setBounds(this.window.getBounds())
    // Show the already-painted workspace underneath the splash before reducing opacity.
    this.reveal()
    this.stage('exiting')
    const window = this.window
    if (!window || window.isDestroyed() || !duration) return
    window.moveTop()
    window.setIgnoreMouseEvents(true)
    const started = Date.now()
    this.fade = setInterval(() => {
      if (window.isDestroyed()) { clearInterval(this.fade); return }
      const t = Math.min(1, (Date.now() - started) / duration)
      window.setOpacity(1 - t * t * (3 - 2 * t))
    }, 16)
  }
  private unavailable(): void {
    if (!this.active) return
    log('startup.splash_unavailable')
    if (this.window && !this.window.isDestroyed()) this.window.destroy()
    this.gate.skipUnavailableSplash()
  }
  private fatal(message: string): void {
    if (!this.active) return
    this.dispose(); this.fail(message)
  }
  dispose(): void {
    if (!this.active) return
    this.active = false
    this.gate.dispose(); clearInterval(this.fade)
    this.cleanups.splice(0).forEach(cleanup => cleanup())
    if (this.window && !this.window.isDestroyed()) this.window.close()
  }
}
