import { BrowserWindow, app, screen } from 'electron'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Surface } from '../../shared/contracts'
import { fitPosition, panelPosition } from '../../shared/geometry'
import type { Settings } from '../../shared/settings'
import { currentArea, getDisplays } from './screenManager'
import { log } from './logger'
import { matchesRendererURL } from './rendererSecurity'
import type { StartupSplash } from './startupSplash'

const directory = fileURLToPath(new URL('.', import.meta.url))
export class WindowManager {
  control!: BrowserWindow
  floating!: BrowserWindow
  panel!: BrowserWindow
  meeting?: BrowserWindow
  quitting = false
  shouldKeepPanelOpen?: () => boolean
  dialogActive = false
  private ready = new Set<number>()
  private rendererURLs = new Map<number, string>()
  private taskBaseBounds?: Electron.Rectangle
  private taskAnchor?: { x: number; y: number }
  private requestedControl = false
  private requestedPage?: string
  constructor(private settings: () => Settings, private startup?: StartupSplash) {}

  create(): void {
    this.control = this.make('control', {
      width: 1240, height: 860, minWidth: 960, minHeight: 680,
      title: 'Athena', titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 22, y: 22 },
      backgroundColor: '#050810',
    })
    this.control.on('close', (event) => {
      if (!this.quitting && this.settings().minimizeToTray) { event.preventDefault(); this.control.hide() }
      else if (!this.quitting) app.quit()
    })
    const size = this.settings().size
    this.floating = this.make('floating', {
      width: size, height: size, transparent: true, backgroundColor: '#00000000',
      frame: false, hasShadow: false, resizable: false, maximizable: false,
      fullscreenable: false, skipTaskbar: true, alwaysOnTop: this.settings().alwaysOnTop,
    })
    this.floating.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false })
    const settings = this.settings()
    const restoredDisplay = settings.position ? screen.getDisplayNearestPoint(settings.position).id : null
    const preferredDisplay = settings.monitorMode === 'selected' ? settings.selectedDisplay : settings.monitorMode === 'primary' ? null : restoredDisplay
    const area = getDisplays().find((display) => display.id === preferredDisplay) ?? getDisplays().find((display) => display.primary)!
    const point = fitPosition(this.settings().position ?? { x: area.x + area.width - size - 80, y: area.y + area.height - size - 90 }, { width: size, height: size }, area, this.settings().edgePadding)
    this.floating.setPosition(point.x, point.y)
    this.panel = this.make('panel', {
      width: 330, height: 390, transparent: true, backgroundColor: '#00000000',
      frame: false, hasShadow: false, resizable: false, maximizable: false,
      fullscreenable: false, skipTaskbar: true, alwaysOnTop: true,
    })
    this.panel.on('blur', () => { if (!this.dialogActive && !this.shouldKeepPanelOpen?.()) this.panel.hide() })
    this.startup?.bindControl(this.control, () => {
      if (!this.quitting && (!this.settings().startHidden || this.requestedControl)) this.control.showInactive()
    }, () => {
      if (this.quitting) return
      if (!this.settings().startHidden || this.requestedControl) this.showControl(this.requestedPage)
      if (this.settings().floatingEnabled && !this.settings().startHidden) this.setFloatingVisible(true)
    })
  }

  make(surface: Surface, options: Electron.BrowserWindowConstructorOptions): BrowserWindow {
    const window = new BrowserWindow({
      ...options, show: false, acceptFirstMouse: true,
      webPreferences: {
        preload: join(directory, '../preload/preload.cjs'),
        sandbox: true, contextIsolation: true, nodeIntegration: false,
        webSecurity: true, backgroundThrottling: true, ...options.webPreferences,
      },
    })
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', (event) => event.preventDefault())
    window.webContents.on('will-attach-webview', (event) => event.preventDefault())
    window.webContents.on('render-process-gone', (_event, details) => log('window.renderer_gone', { surface, reason: details.reason }))
    window.webContents.on('did-fail-load', (_event, code) => log('window.load_failed', { surface, code }))
    window.on('ready-to-show', () => {
      this.ready.add(window.id)
      if (this.startup?.active) return
      if (surface === 'control' && !this.settings().startHidden) window.show()
      if (surface === 'floating' && this.settings().floatingEnabled && !this.settings().startHidden) window.showInactive()
    })
    const developmentURL = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined
    const rendererURL = new URL(developmentURL || 'athena://renderer/index.html')
    rendererURL.searchParams.set('surface', surface)
    const contentsId = window.webContents.id, windowId = window.id
    this.rendererURLs.set(contentsId, rendererURL.href)
    window.once('closed', () => { this.rendererURLs.delete(contentsId); this.ready.delete(windowId) })
    void window.loadURL(rendererURL.href).catch(() => log('window.load_failed', { surface }))
    return window
  }
  all(): BrowserWindow[] { return [this.control, this.floating, this.panel, this.meeting].filter((window): window is BrowserWindow => !!window && !window.isDestroyed()) }
  owns(sender: Electron.WebContents): boolean { return this.all().some((window) => window.webContents.id === sender.id) }
  isTrustedURL(sender: Electron.WebContents, url: string): boolean { return matchesRendererURL(url, this.rendererURLs.get(sender.id)) }
  showControl(page?: string): void {
    // A second-instance/activate event can arrive while macOS is still
    // tearing down a previous process during restart. Never call methods on
    // the destroyed BrowserWindow in that short race window.
    if (this.quitting || !this.control || this.control.isDestroyed()) return
    if (this.startup?.active) {
      this.requestedControl = true
      this.requestedPage = page ?? this.requestedPage
      this.startup.focus()
      return
    }
    this.control.show()
    this.control.focus()
    if (page) this.control.webContents.send('athena:navigate', page)
  }
  setFloatingVisible(visible: boolean): void {
    if (this.startup?.active) return
    if (visible && this.ready.has(this.floating.id)) this.floating.showInactive()
    else { this.floating.hide(); this.panel.hide() }
  }
  setTaskVisualMode(active: boolean, enabled: boolean): { x: number; y: number } | undefined {
    if (active && enabled && !this.floating.isDestroyed()) {
      if (!this.taskBaseBounds) {
        const current = this.floating.getBounds()
        const center = { x: current.x + current.width / 2, y: current.y + current.height / 2 }
        this.taskBaseBounds = current
        const area = screen.getDisplayNearestPoint(center).workArea
        // Transparent canvas margin for the 3D console. The original character
        // center is kept as an explicit anchor; the scene never relocates her.
        const width = Math.min(area.width, Math.max(current.width, 200, Math.round(this.settings().size * 1.6)))
        const height = Math.min(area.height, Math.max(current.height, 200, Math.round(this.settings().size * 1.7)))
        const x = Math.max(area.x, Math.min(area.x + area.width - width, Math.round(center.x - width / 2)))
        const y = Math.max(area.y, Math.min(area.y + area.height - height, Math.round(center.y - height / 2)))
        this.taskAnchor = { x: center.x - x, y: center.y - y }
        // Only the transparent canvas changes. Animating native bounds slides
        // the old frame under the new scene anchor on macOS.
        this.floating.setBounds({ x, y, width, height }, false)
      }
      return this.taskAnchor
    }
    if (this.taskBaseBounds && !this.floating.isDestroyed()) {
      const original = this.taskBaseBounds
      const current = this.floating.getBounds()
      const anchor = this.taskAnchor ?? { x: current.width / 2, y: current.height / 2 }
      const characterCenter = { x: current.x + anchor.x, y: current.y + anchor.y }
      const originalCenter = { x: original.x + original.width / 2, y: original.y + original.height / 2 }
      const preserveMovedPosition = active || Math.hypot(characterCenter.x - originalCenter.x, characterCenter.y - originalCenter.y) > 2
      if (preserveMovedPosition) {
        const area = screen.getDisplayNearestPoint(characterCenter).workArea
        const size = Math.min(this.settings().size, area.width, area.height)
        const point = fitPosition({ x: characterCenter.x - size / 2, y: characterCenter.y - size / 2 }, { width: size, height: size }, area, this.settings().edgePadding)
        this.floating.setBounds({ ...point, width: size, height: size }, false)
      } else {
        this.floating.setBounds(original, false)
      }
    }
    this.taskBaseBounds = undefined
    this.taskAnchor = undefined
    return undefined
  }
  getTaskAnchor(): { x: number; y: number } | undefined { return this.taskAnchor }
  applySettings(): void {
    const settings = this.settings()
    this.floating.setAlwaysOnTop(settings.alwaysOnTop, 'floating')
    const wasInTaskMode = Boolean(this.taskBaseBounds)
    if (wasInTaskMode) this.setTaskVisualMode(false, false)
    const bounds = this.floating.getBounds()
    const area = currentArea(this.floating)
    const size = Math.min(settings.size, area.width, area.height)
    const point = fitPosition({ x: bounds.x + (bounds.width - size) / 2, y: bounds.y + (bounds.height - size) / 2 }, { width: size, height: size }, area, settings.edgePadding)
    this.floating.setBounds({ ...point, width: size, height: size }, true)
    if (wasInTaskMode) this.setTaskVisualMode(true, settings.taskActivityEnabled && settings.taskHologramsEnabled)
    if (this.panel.isVisible()) this.positionPanel()
  }
  showPanel(): void {
    if (this.startup?.active) { this.startup.focus(); return }
    this.positionPanel()
    this.panel.show()
    this.panel.focus()
  }
  closeChat(): void {
    if (!this.panel.isDestroyed()) this.panel.hide()
    if (!this.control.isDestroyed()) this.control.hide()
  }
  positionPanel(): void {
    const area = currentArea(this.floating)
    const size = { width: Math.min(330, area.width), height: Math.min(390, area.height) }
    const point = panelPosition(this.floating.getBounds(), size, area)
    this.panel.setBounds({ ...point, ...size })
  }
  nextMonitor(): void {
    const displays = getDisplays()
    const index = displays.findIndex((display) => display.id === currentArea(this.floating).id)
    const area = displays[(index + 1) % displays.length]
    const bounds = this.floating.getBounds()
    const point = fitPosition({ x: area.x + area.width - bounds.width - 40, y: area.y + area.height - bounds.height - 40 }, bounds, area, this.settings().edgePadding)
    this.floating.setPosition(point.x, point.y)
  }
}
