import type { ExistingBrowser } from './existingBrowser'
import type { BrowserApp } from './desktopContext'
import { BrowserWindow, session as electronSession, type WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import { PlaywrightVoiceBrowser, type BrowserFilePicker } from './playwrightVoiceBrowser'
import { browserActionScript, uniqueObservedButton } from './voiceBrowserDOM'
export { browserActionScript } from './voiceBrowserDOM'
import { voiceBrowserActionSchema } from '../../../shared/voiceBrowser'

import { ChatError } from '../ai/AIProvider'

import { lookup } from 'node:dns/promises'
import { isPrivateWebAddress } from '../ai/webSearchService'
export async function isPublicBrowserURL(value: string): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const url = new URL(value)
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) || url.username || url.password || !url.hostname || /^(localhost|.*\.localhost)$/i.test(url.hostname)) return false
    const addresses = await Promise.race([lookup(url.hostname.replace(/^\[|\]$/g, ''), { all: true }), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('DNS timeout')), 5000) })])
    return addresses.length > 0 && addresses.every(item => !isPrivateWebAddress(item.address))
  } catch { return false } finally { if (timer) clearTimeout(timer) }
}

/** Bounded DOM actions for Athena-owned windows. No user-browser debugging, cookies, or Node bridge. */
export class VoiceBrowser {
  private windows = new Map<number, BrowserWindow>()
  private active?: number
  private observed = new Map<number, { url: string; at: number; button?:string }>()
  private busy = false
  private partition = `athena-voice-browser-${randomUUID()}`
  private lifetime = new AbortController()
  private configured = false
  private structured?: PlaywrightVoiceBrowser
  constructor(private allowed: () => boolean, private confirm: (message: string) => Promise<boolean>, private publicURL = isPublicBrowserURL, private engine: () => 'embedded'|'playwright' = () => 'embedded', private pickFile?:BrowserFilePicker, private existing?:ExistingBrowser, private feedback?:()=>import('./voiceBrowserDOM').BrowserFeedback) {}

  private check(signal: AbortSignal) {
    signal.throwIfAborted(); this.lifetime.signal.throwIfAborted()
    if (!this.allowed()) throw new ChatError('Browser interaction or Public internet access is disabled. Enable both in Automation Permissions and enable Internet Access. No browser action was run.')
  }
  private target(): BrowserWindow {
    const window = this.active === undefined ? undefined : this.windows.get(this.active)
    if (!window || window.isDestroyed()) throw new ChatError('Open a page in Athena’s browser first. Personal Chrome, Safari, and Edge tabs are not connected.')
    return window
  }
  private create(): BrowserWindow {
    if (this.windows.size >= 8) throw new ChatError('Close an Athena browser window before opening another; eight windows are already open.')
    const session = electronSession.fromPartition(this.partition)
    if (!this.configured) {
    this.configured = true
    session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    session.setPermissionCheckHandler(() => false)
    session.on('will-download', event => event.preventDefault())
    session.webRequest.onBeforeRequest((details, callback) => {
      if (!this.allowed()) { callback({ cancel: true }); return }
      if (/^(?:data:|blob:|about:blank$)/.test(details.url)) { callback({}); return }
      void this.publicURL(details.url).then(allowed => callback({ cancel: !allowed || !this.allowed() }), () => callback({ cancel: true }))
    })
    }
    const window = new BrowserWindow({ title: 'Athena Browser', width: 1100, height: 800, autoHideMenuBar: true,
      webPreferences: { partition: this.partition, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, devTools: false, safeDialogs: true, navigateOnDragDrop: false, autoplayPolicy: 'user-gesture-required' },
    })
    window.removeMenu()
    this.windows.set(window.id, window); this.active = window.id
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-attach-webview', event => event.preventDefault())
    window.webContents.on('will-navigate', (event, url) => { if (!/^https?:\/\//i.test(url) || !this.allowed()) event.preventDefault() })
    window.webContents.on('did-navigate', () => this.observed.delete(window.id))
    window.webContents.on('did-navigate-in-page', () => this.observed.delete(window.id))
    window.on('focus', () => { this.active = window.id })
    window.on('closed', () => { this.windows.delete(window.id); this.observed.delete(window.id); if (this.active === window.id) this.active = [...this.windows.keys()].at(-1) })
    return window
  }
  private async bounded<T>(work: Promise<T>, contents: WebContents, signal: AbortSignal): Promise<T> {
    const deadline = AbortSignal.any([signal, this.lifetime.signal, AbortSignal.timeout(30_000)])
    return new Promise<T>((resolve, reject) => {
      const abort = () => { if (!contents.isDestroyed()) contents.stop(); reject(new ChatError(signal.aborted ? 'Browser automation cancelled. Inspect before repeating an action.' : 'Browser operation timed out. The page may still be open; inspect before retrying.')) }
      deadline.addEventListener('abort', abort, { once: true })
      work.then(resolve, reject).finally(() => deadline.removeEventListener('abort', abort))
      if (deadline.aborted) abort()
    })
  }
  async run(input: unknown, signal: AbortSignal, utterance=''): Promise<Record<string, unknown>> {
    let command = voiceBrowserActionSchema.parse(input)
    this.check(signal)
    if (this.busy) throw new ChatError('Another browser action is running. Wait for its verified result.')
    this.busy = true
    try {
      const deadline=AbortSignal.any([signal,this.lifetime.signal,AbortSignal.timeout(30000)])
      const existing=await this.existing?.run(command,deadline,utterance)
      if(existing)return existing
      if(command.action==='window')throw new ChatError('The existing browser window is unavailable. Select an authorized window and retry.')
      if(command.action==='submit-search')throw new ChatError('Verified Enter submission requires an existing browser with native search-field support. In the dedicated browser inspect and activate its search button.')
      if (this.engine() === 'playwright') {
        this.structured ??= new PlaywrightVoiceBrowser(this.allowed, this.confirm, this.publicURL,this.pickFile,this.feedback)
        return await this.structured.run(command, signal)
      }
      if(command.action==='upload'||command.action==='download')throw new ChatError('Select the Playwright browser in Computer use settings for file transfers.')
      if (command.action === 'tabs') return { ok: true, data: [...this.windows.values()].map(window => ({ id: window.id, title: window.webContents.getTitle(), active: window.id === this.active })), message: this.windows.size ? `Athena browser pages: ${[...this.windows.values()].map(window => window.webContents.getTitle() || 'Loading page').join('; ')}.` : 'No Athena browser windows are open. Personal browser tabs are not connected.' }
      if (command.action==='other-tab') {
        const others=[...this.windows.values()].filter(w=>!w.isDestroyed() && w.id!==this.active)
        if (!this.active || others.length!==1) throw new ChatError('Which tab? Say its title.')
        const window=others[0];this.active=window.id;window.show();window.focus()
        return {ok:window.isFocused(),message:'Selected '+window.webContents.getTitle()}
      }
      if (command.action === 'select') {
        const query=command.query.toLocaleLowerCase()
        const matches = [...this.windows.values()].filter(window => { const url = URL.canParse(window.webContents.getURL()) ? new URL(window.webContents.getURL()) : undefined; return window.webContents.getTitle().toLocaleLowerCase().includes(query) || url?.hostname.includes(query) })
        if (matches.length !== 1) throw new ChatError(matches.length ? 'Several Athena browser pages match. Say a unique page title.' : 'No Athena browser page matches. Tabs in other browsers are not connected.')
        this.active = matches[0].id; matches[0].show(); matches[0].focus()
        return { ok: true, message: `Selected ${matches[0].webContents.getTitle()}.` }
      }
      if (command.action === 'open') {
        if (!/^https?:\/\//i.test(command.url) || !await this.publicURL(command.url)) throw new ChatError('Only public HTTP or HTTPS pages are available to browser automation.')
        this.check(signal)
        const window = this.create()
        await this.bounded(window.loadURL(command.url), window.webContents, signal)
        this.check(signal)
        return { ok: true, message: `Opened ${window.webContents.getTitle() || new URL(command.url).hostname} in Athena’s browser.` }
      }
      const window = this.target(), contents = window.webContents, url = contents.getURL()
      if (!await this.publicURL(url)) throw new ChatError('This page is not authorized for public browser interaction.')
      this.check(signal)
      if (this.active !== window.id || window.isDestroyed()) throw new ChatError('The browser target changed. Inspect the selected page again.')
      if (command.action === 'close-tab') {
        window.destroy()
        return {ok:window.isDestroyed(),message:'Closed the selected Athena browser page.'}
      }
      if (command.action === 'back' || command.action === 'forward') {
        const history = contents.navigationHistory
        if (command.action === 'back' ? !history.canGoBack() : !history.canGoForward()) throw new ChatError('There is no page in that direction.')
        let cleanup = () => {}
        const completed = new Promise<void>((resolve, reject) => { const failed = () => reject(new ChatError('Browser navigation failed.')); contents.once('did-finish-load', resolve); contents.once('did-fail-load', failed); cleanup = () => { contents.removeListener('did-finish-load', resolve); contents.removeListener('did-fail-load', failed) } })
        if (command.action === 'back') history.goBack(); else history.goForward()
        try { await this.bounded(completed, contents, signal) } finally { cleanup() }
        this.check(signal)
        return { ok: true, message: `Loaded ${contents.getTitle()}.` }
      }
      if(command.action==='click-observed') {
        const label=this.observed.get(window.id)?.button
        if(!label)throw new ChatError('Which button? Inspect the page and say the control name.')
        command={action:'click',label}
      }
      if (command.action === 'click' || command.action === 'type' || command.action === 'choose') {
        const prior = this.observed.get(window.id)
        if (!prior || prior.url !== url || Date.now() - prior.at > 60_000) throw new ChatError('Inspect the active page first. Its observation is missing or stale.')
        // Generic website controls can submit, publish, pay, or delete. Always obtain
        // explicit confirmation rather than interpreting a page label as permission.
        if (!await this.confirm(`${command.action === 'click' ? 'Activate' : command.action==='choose'?'Choose an option in':'Enter dictated text into'} “${command.label}” on ${new URL(url).hostname}? Review the page before allowing this action.`)) throw new ChatError('Browser action declined. Nothing was submitted.')
        this.check(signal)
        if (this.active !== window.id || contents.getURL() !== url) throw new ChatError('The target page changed during confirmation. Inspect again.')
      }
      if (command.action === 'media' || command.action === 'first-video' || command.action === 'video-result') {
        if (!/(^|\.)youtube\.com$/.test(new URL(url).hostname)) throw new ChatError('Video controls currently support YouTube pages in Athena’s browser.')
      }
      const result = await this.bounded(contents.executeJavaScriptInIsolatedWorld(345, [{ code: browserActionScript(command, url,this.feedback?.()) }], true), contents, signal) as { ok: boolean; message: string; data?: unknown }
      this.check(signal)
      if (command.action === 'inspect') this.observed.set(window.id, { url, at: Date.now(), button:uniqueObservedButton(result.data) })
      else this.observed.delete(window.id)
      if (!result?.ok) throw new ChatError(result?.message ?? 'The browser action result could not be verified.')
      return result as Record<string, unknown>
    } catch (error) {
      if (error instanceof ChatError) throw error
      throw new ChatError('The Athena browser could not complete this action. Inspect the page; it may require manual sign-in, consent, or an unsupported control.')
    } finally { this.busy = false }
  }
  status() { return this.existing?.status() ?? (this.engine() === 'playwright' ? this.structured?.status() ?? 'Dedicated browser closed · check status to inspect existing windows' : this.windows.size + ' Athena browser pages open') }
  async refresh(signal:AbortSignal){await this.existing?.refresh(signal)}
  backgroundTarget(signal:AbortSignal){return this.existing?.backgroundTarget(signal)}
  initialSearchTarget(browser:BrowserApp|undefined,destination:string|undefined,signal:AbortSignal){
    return this.existing?.initialSearchTarget(browser,destination,signal)
  }
  forgetBackground(owner:string){this.existing?.forgetBackground(owner)}
  reconcile() {
    this.existing?.reconcile(this.allowed())
    if (!this.allowed() || this.engine() !== 'playwright') { this.structured?.dispose(); this.structured = undefined }
    if (!this.allowed() || this.engine() !== 'embedded') for (const window of this.windows.values()) { if (!window.isDestroyed()) { window.webContents.stop(); window.close() } } }
  dispose() {
    this.existing?.dispose(); this.structured?.dispose(); this.lifetime.abort(); for (const window of this.windows.values()) if (!window.isDestroyed()) window.destroy(); this.windows.clear(); this.observed.clear(); void electronSession.fromPartition(this.partition).clearStorageData().catch(() => {}) }
}

