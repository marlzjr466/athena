import { randomUUID } from 'node:crypto'
import { app, BrowserWindow, session as electronSession } from 'electron'
import { ChatError } from './AIProvider'

export type BrowserViewport = 'desktop' | 'mobile'
export interface LocalBrowserReport {
  url: string
  viewport: { width: number; height: number }
  title: string
  bodyText: string
  selectors: Array<{ selector: string; found: boolean; visible: boolean; hoverable: boolean; focusable: boolean; text?: string }>
  consoleErrors: string[]
}
export function resolveLocalBrowserURL(baseUrl: string, path: string): URL {
  const base = new URL(baseUrl)
  if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]', '::1'].includes(base.hostname)) throw new ChatError('Browser verification is restricted to Athena-managed loopback development servers.')
  if (path.startsWith('//') || !path.startsWith('/') || path.length > 1500) throw new ChatError('Provide a relative route beginning with a single slash.')
  const target = new URL(path, base)
  if (target.origin !== base.origin) throw new ChatError('Browser navigation must remain on the managed development server origin.')
  return target
}

export class BrowserInspector {
  constructor(private allowed: () => boolean) {}

  async inspect(baseUrl: string, path: string, viewport: BrowserViewport, selectors: string[] = []): Promise<LocalBrowserReport> {
    if (!this.allowed()) throw new ChatError('Browser verification is not authorized. Enable Browser Automation in Settings → Permissions. This permission is separate from filesystem access.')
    if (selectors.length > 10 || selectors.some((selector) => !selector.trim() || selector.length > 250)) throw new ChatError('Provide at most 10 CSS selectors, each up to 250 characters.')
    const base = new URL(baseUrl), target = resolveLocalBrowserURL(baseUrl, path)

    const size = viewport === 'mobile' ? { width: 390, height: 844 } : { width: 1280, height: 800 }
    const partition = `athena-browser-verification-${randomUUID()}`
    const isolatedSession = electronSession.fromPartition(partition)
    isolatedSession.webRequest.onBeforeRequest((details, callback) => {
      let allow = false
      try { const url = new URL(details.url); allow = url.origin === base.origin || ['data:', 'blob:', 'about:'].includes(url.protocol) } catch { /* Block malformed URLs. */ }
      callback({ cancel: !allow })
    })
    const window = new BrowserWindow({
      title: 'Athena — Local Browser Verification', width: size.width, height: size.height, show: true,
      webPreferences: { partition, contextIsolation: true, nodeIntegration: false, sandbox: true, devTools: false, webSecurity: true },
    })
    const consoleErrors: string[] = []
    const onConsole = (_event: Electron.Event, level: number, message: string) => { if (level >= 3 && consoleErrors.length < 30) consoleErrors.push(message.slice(0, 500)) }
    const onNavigate = (event: Electron.Event, url: string) => { try { if (new URL(url).origin !== base.origin) event.preventDefault() } catch { event.preventDefault() } }
    window.webContents.on('console-message', onConsole)
    window.webContents.on('will-navigate', onNavigate)
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    try {
      await window.loadURL(target.href)
      // Emulation needs a live renderer; a premature call can crash Chromium.
      window.webContents.debugger.attach('1.3')
      await window.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', { ...size, deviceScaleFactor: 1, mobile: viewport === 'mobile' })
      app.focus({ steal: true })
      window.focus()
      window.webContents.focus()
      await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
      const selectorJson = JSON.stringify(selectors)
      const initial = await window.webContents.executeJavaScript(`(() => {
        const selectors = ${selectorJson};
        return { title: document.title || '', url: location.href, bodyText: (document.body?.innerText || '').slice(0, 6000), elements: selectors.map(selector => {
          const element = document.querySelector(selector);
          if (!element) return { selector, found: false, visible: false, hoverable: false, focusable: false };
          const style = getComputedStyle(element), rect = element.getBoundingClientRect();
          return { selector, found: true, visible: style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0,
            rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, text: (element.textContent || '').trim().slice(0, 240) };
        }) };
      })()`, true) as { title: string; url: string; bodyText: string; elements: Array<{ selector: string; found: boolean; visible: boolean; rect?: { x: number; y: number; width: number; height: number }; text?: string }> }
      const states: LocalBrowserReport['selectors'] = []
      for (const element of initial.elements) {
        if (!element.found || !element.rect || element.rect.width <= 0 || element.rect.height <= 0) {
          states.push({ selector: element.selector, found: element.found, visible: element.visible, hoverable: false, focusable: false, text: element.text }); continue
        }
        const x = Math.max(1, Math.min(size.width - 1, element.rect.x + element.rect.width / 2))
        const y = Math.max(1, Math.min(size.height - 1, element.rect.y + element.rect.height / 2))
        await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, pointerType: 'mouse' })
        await window.webContents.executeJavaScript('new Promise(resolve => setTimeout(resolve, 100))')
        const hovered = await window.webContents.executeJavaScript(`(() => { const el = document.querySelector(${JSON.stringify(element.selector)}); return !!el && el.matches(':hover'); })()`, true) as boolean
        const focused = await window.webContents.executeJavaScript(`(() => { const el = document.querySelector(${JSON.stringify(element.selector)}); if (!el) return false; el.focus(); return document.activeElement === el || el.contains(document.activeElement); })()`, true) as boolean
        states.push({ selector: element.selector, found: true, visible: element.visible, hoverable: hovered, focusable: focused, text: element.text })
      }
      return { url: initial.url, viewport: size, title: initial.title, bodyText: initial.bodyText, selectors: states, consoleErrors }
    } catch (error) {
      throw new ChatError(`Browser verification could not inspect ${target.pathname}: ${error instanceof Error ? error.message.slice(0, 300) : 'the isolated Electron browser failed'}`)
    } finally {
      if (!window.isDestroyed()) {
        window.webContents.removeListener('console-message', onConsole)
        window.webContents.removeListener('will-navigate', onNavigate)
        if (window.webContents.debugger.isAttached()) window.webContents.debugger.detach()
        window.destroy()
      }
      await isolatedSession.clearStorageData().catch(() => undefined)
      await isolatedSession.clearCache().catch(() => undefined)
    }
  }
}
