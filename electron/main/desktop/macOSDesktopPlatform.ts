import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { app as electronApp, Notification, systemPreferences } from 'electron'
import { join } from 'node:path'
import { z } from 'zod'
import { APPLICATIONS, appIdentifierSchema, webURLSchema, notificationActionSchema, type AccessibilityActionResult, type AccessibilityInspection, type AppIdentifier, type DesktopActionResult } from '../../../shared/desktopActions'
import type { DesktopPlatform, NativePageRequest } from './desktopPlatform'
import type { BrowserApp } from './desktopContext'
import { chooseWindow, windowRequest, workspaceResultSchema, workspaceStateSchema, type WorkspaceRequest } from './desktopContext'
import { desktopRectSchema } from '../../../shared/desktopActions'
import { ChatError } from '../ai/AIProvider'
import { openMacApplicationFolder } from './vscodeApplication'

const executeFile = promisify(execFile)
type CommandRunner = (file: string, args: string[], options: { timeout: number; maxBuffer: number; signal: AbortSignal; encoding?: 'utf8' }) => Promise<{ stdout: string }>
// Arguments are data passed through argv to fixed AppKit code, never source code.
const APP_ACTION = `ObjC.import('AppKit');
function run(argv) {
  var bundle = argv[0], focus = argv[1] === 'focus';
  for (var attempt = 0; attempt < 30; attempt++) {
    var apps = $.NSRunningApplication.runningApplicationsWithBundleIdentifier(bundle);
    if (apps.count > 0) {
      if (!focus) return JSON.stringify({ running: true, focused: false });
      if (attempt === 0) apps.objectAtIndex(0).activateWithOptions(3);
      var front = $.NSWorkspace.sharedWorkspace.frontmostApplication;
      if (front && ObjC.unwrap(front.bundleIdentifier) === bundle) return JSON.stringify({ running: true, focused: true });
    } else if (focus) return JSON.stringify({ running: false, focused: false });
    $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.1));
  }
  return JSON.stringify({ running: $.NSRunningApplication.runningApplicationsWithBundleIdentifier(bundle).count > 0, focused: false });
}`
const appResult = z.object({ running: z.boolean(), focused: z.boolean() }).strict()
export const accessibilityResult = z.union([
  z.object({ app: z.string(), window: z.string(), pageURL:z.string().optional(), pageReference:z.string().optional(), pageBounds:desktopRectSchema.optional(), windowToken: z.string().optional(), inputIssued:z.boolean().optional(), elements: z.array(z.object({ label: z.string(), role: z.string(), enabled: z.boolean(), focused:z.boolean().optional(), searchField:z.boolean().optional(), searchFieldId:z.string().max(128).optional(), searchValueStamp:z.string().max(128).optional(), bounds: desktopRectSchema.optional(), value: z.string().optional() }).strict()).max(120), verified: z.boolean(), changed: z.boolean(), message: z.string() }).strict(),
  z.object({ error: z.string() }).strict(),
])


export class MacOSDesktopPlatform implements DesktopPlatform {
  private observed = new Map<string, { token: string; at: number }>()
  private notifications = new Set<Notification>()
  private abort = new AbortController()
  private lastNotification = -Infinity
  constructor(private platform = process.platform, private run: CommandRunner = async (file, args, options) => executeFile(file, args, { ...options, encoding: 'utf8' }), private accessibilityHelper?: string, private windowAccess:()=>boolean=()=>false) {}

  private signal(signal: AbortSignal, timeoutMs=8_000): AbortSignal {
    if (this.platform !== 'darwin') throw new ChatError('Desktop actions currently support macOS only.')
    const combined = AbortSignal.any([signal, this.abort.signal, AbortSignal.timeout(timeoutMs)])
    combined.throwIfAborted()
    return combined
  }
  private async inspect(app: AppIdentifier, focus: boolean, signal: AbortSignal) {
    const { stdout } = await this.run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', APP_ACTION, APPLICATIONS[app].bundleId, focus ? 'focus' : 'inspect'], {
      encoding: 'utf8', timeout: 5_000, maxBuffer: 16 * 1024, signal,
    })
    return appResult.parse(JSON.parse(stdout))
  }
  private helperPath() {
    return this.accessibilityHelper ?? (electronApp?.isPackaged ? join(process.resourcesPath,'native','athena-desktop-accessibility') : join(electronApp?.getAppPath() ?? process.cwd(),'build','native','athena-desktop-accessibility'))
  }
  private async nativeWorkspace(bundle:string, request:WorkspaceRequest, signal:AbortSignal) {
    // Allow the helper's bounded navigation observation to finish and report an
    // uncertain result, rather than killing it at the same eight-second mark.
    const timeout=request.url?15_000:8_000
    const {stdout}=await this.run(this.helperPath(),[bundle,'workspace',JSON.stringify(request)],{encoding:'utf8',timeout,maxBuffer:512*1024,signal:this.signal(signal,timeout)})
    const value=JSON.parse(stdout)
    if(typeof value?.error==='string')throw new ChatError(value.error)
    return value as unknown
  }
  workspace(app:AppIdentifier, request:WorkspaceRequest, signal:AbortSignal) {
    return this.nativeWorkspace(APPLICATIONS[appIdentifierSchema.parse(app)].bundleId,request,signal)
  }
  private async activate(bundle:string, name:string, signal:AbortSignal, launch:boolean, path?:string):Promise<DesktopActionResult> {
    const observe={operation:'observe' as const,details:this.windowAccess(),path}
    let state=workspaceStateSchema.parse(await this.nativeWorkspace(bundle,observe,signal))
    if (!state.running) {
      if(!launch)return {ok:false,status:'failed',message:name+' is not running.'}
      await this.run('/usr/bin/open',path?[path]:['-b',bundle],{timeout:5000,maxBuffer:4096,signal})
      state=workspaceStateSchema.parse(await this.nativeWorkspace(bundle,observe,signal))
      if(!state.running)return {ok:false,status:'failed',message:'macOS accepted the launch. The running application could not be verified.'}
    }
    const win=chooseWindow(state)
    if(state.focused && !win?.minimized && !win?.hidden)return {ok:true,status:'completed',message:name+' is already in the foreground.'}
    const result=workspaceResultSchema.parse(await this.nativeWorkspace(bundle,{operation:'activate',...windowRequest(state,win),details:observe.details,path},signal))
    return {...result,status:result.ok?'completed':'failed',message:result.ok?name+' is in the foreground.':result.message}
  }
  openApplication(input:AppIdentifier,signal:AbortSignal) {
    const app=APPLICATIONS[appIdentifierSchema.parse(input)]
    return this.activate(app.bundleId,app.name,this.signal(signal),true)
  }
  focusApplication(input:AppIdentifier,signal:AbortSignal) {
    const app=APPLICATIONS[appIdentifierSchema.parse(input)]
    return this.activate(app.bundleId,app.name,this.signal(signal),false)
  }
  async openWorkspace(path: string, app: 'vscode' | 'finder', signal: AbortSignal): Promise<DesktopActionResult> {
    const deadline = this.signal(signal)
    if (app === 'vscode') await openMacApplicationFolder({ bundleId: APPLICATIONS.vscode.bundleId }, path, deadline, (file, args, options) => this.run(file, args, { ...options, signal: deadline }))
    else await this.run('/usr/bin/open', [path], { timeout: 5_000, maxBuffer: 16 * 1024, signal: deadline })
    const result = await this.inspect(app, false, deadline)
    return result.running
      ? { ok: true, status: 'completed', message: `${app === 'vscode' ? 'Visual Studio Code' : 'Finder'} is running and macOS accepted the project folder. The folder view itself was not inspected.` }
      : { ok: false, status: 'failed', message: 'macOS accepted the folder request, but the application could not be confirmed running.' }
  }
  private async installedBundle(target:import('./installedApplications').InstalledApplication,deadline:AbortSignal){
    const info=await this.run('/usr/bin/plutil',['-extract','CFBundleIdentifier','raw','-o','-',join(target.path,'Contents','Info.plist')],{signal:deadline,timeout:3000,maxBuffer:2048})
    const bundle=info.stdout.trim()
    if (!/^[a-z\d][a-z\d.-]+$/i.test(bundle) || Object.values(APPLICATIONS).some(app=>app.bundleId===bundle)) throw new ChatError('Use the registered target for this application.')
    return bundle
  }
  async workspaceInstalled(target:import('./installedApplications').InstalledApplication,request:WorkspaceRequest,signal:AbortSignal){
    const bundle=await this.installedBundle(target,signal)
    return this.nativeWorkspace(bundle,{...request,path:target.path},signal)
  }
  async installedAction(target:import('./installedApplications').InstalledApplication,operation:import('./installedApplications').InstalledOperation,label:string,signal:AbortSignal,text='') {
    const deadline=this.signal(signal)
    const bundle=await this.installedBundle(target,deadline)
    if (operation==='open') return this.activate(bundle,target.name,deadline,true,target.path)
    const path=await this.run('/usr/bin/osascript',['-l','JavaScript','-e', "ObjC.import('AppKit');function run(argv){var a=$.NSWorkspace.sharedWorkspace.frontmostApplication; return String(ObjC.unwrap(a.bundleURL.path))}",bundle],{signal:deadline,timeout:3000,maxBuffer:4096})
    if (path.stdout.trim()!==target.path) throw new ChatError('The target application could not be verified in the foreground. Focus it before continuing.')
    const result=await this.accessibleTarget(target.key,bundle,operation,label,text,deadline,target.path)
    return {ok:result.verified,message:result.message,...(operation==='inspect'?{elements:result.elements,windowToken:result.windowToken}:{})}
  }
  private async accessibility(app: AppIdentifier, action: string, selector: string, text: string, signal: AbortSignal) {
    const target = appIdentifierSchema.parse(app)
    return this.accessibleTarget(target,APPLICATIONS[target].bundleId,action,selector,text,this.signal(signal))
  }
  async browserPage(app:BrowserApp,request:NativePageRequest,signal:AbortSignal) {
    const result=await this.accessibleTarget(app+':page',APPLICATIONS[app].bundleId,'web-'+request.action,request.label??'',request.text??'',this.signal(signal),undefined,request.token??'')
    return {ok:result.verified,verified:result.verified,message:result.message,pageURL:result.pageURL,pageReference:result.pageReference,pageBounds:result.pageBounds,windowToken:result.windowToken,elements:result.elements,inputIssued:result.inputIssued}
  }
  private async accessibleTarget(target:string,bundle:string,action:string,selector:string,text:string,deadline:AbortSignal,path?:string,explicitToken?:string) {
    if (!systemPreferences.isTrustedAccessibilityClient(false)) throw new ChatError('Enable Accessibility UI Control in Settings → Privacy, then allow Athena in macOS Accessibility settings.')
    const observation=this.observed.get(target)
    const token=explicitToken ?? (action!=='inspect' && observation && Date.now()-observation.at<60_000 ? observation.token : '')
    const { stdout } = await this.run(this.helperPath(), [bundle,action,selector,text,token,...(path?[path]:[])], { timeout: 8_000, maxBuffer: 96 * 1024, signal: deadline }).catch(error => {
      this.observed.delete(target)
      if (deadline.aborted) throw new ChatError(deadline.aborted ? 'Desktop action cancelled. Inspect the target before retrying.' : 'The application did not respond within the desktop action deadline. Inspect it before retrying.')
      if (/-1743|not authorized.*apple events/i.test(String(error?.stderr ?? ''))) throw new ChatError('macOS Automation permission is missing. Allow Athena to control System Events under System Settings → Privacy & Security → Automation. Accessibility permission is separate.')
      throw new ChatError('macOS could not inspect or control this application. Check Accessibility and Automation permissions separately, select the target window, then inspect again.')
    })
    const result = accessibilityResult.parse(JSON.parse(stdout))
    if ('error' in result) throw new ChatError(result.error)
    if (action === 'inspect' && result.windowToken) this.observed.set(target, { token: result.windowToken, at: Date.now() })
    else if (action !== 'inspect') this.observed.delete(target)
    return result
  }
  async inspectAccessibility(app: AppIdentifier, signal: AbortSignal): Promise<AccessibilityInspection> {
    const result = await this.accessibility(app, 'inspect', '', '', signal)
    return { app: APPLICATIONS[appIdentifierSchema.parse(app)].name, window: result.window, elements: result.elements, windowToken: result.windowToken }
  }
  async clickAccessibleElement(app: AppIdentifier, label: string, signal: AbortSignal): Promise<AccessibilityActionResult> {
    const result = await this.accessibility(app, 'click', label, '', signal)
    return { ok: result.verified, verified: result.verified, message: result.message }
  }
  async setAccessibleText(app: AppIdentifier, label: string, text: string, signal: AbortSignal): Promise<AccessibilityActionResult> {
    const result = await this.accessibility(app, 'set-text', label, text, signal)
    return { ok: result.verified, verified: result.verified, message: result.message }
  }
  async pressShortcut(app: AppIdentifier, shortcut: string, signal: AbortSignal): Promise<AccessibilityActionResult> {
    const result = await this.accessibility(app, 'shortcut', shortcut, '', signal)
    return { ok: result.verified, verified: result.verified, message: result.message }
  }
  async manageWindow(app:AppIdentifier, operation:import('../../../shared/desktopActions').WindowOperation, point:string, signal:AbortSignal) {
    const result=await this.accessibility(app,'window',operation,point,signal)
    return {ok:result.verified,verified:result.verified,message:result.message}
  }
  async scrollAccessible(app: AppIdentifier, label: string, direction: 'up' | 'down', signal: AbortSignal): Promise<AccessibilityActionResult> {
    const result = await this.accessibility(app, 'scroll', label, direction, signal)
    return { ok: result.verified, verified: result.verified, message: result.message }
  }
  async runningApplications(signal: AbortSignal) {
    const response=await this.nativeWorkspace('',{operation:'running'},signal)
    return z.object({apps:z.array(z.object({app:z.string(),name:z.string(),active:z.boolean()})).max(200)}).parse(response).apps
  }
  async openURL(input: string, signal: AbortSignal): Promise<DesktopActionResult> {
    const url = webURLSchema.parse(input), deadline = this.signal(signal)
    deadline.throwIfAborted()
    await this.run('/usr/bin/open', [url], { timeout: 8_000, maxBuffer: 16 * 1024, signal: deadline, encoding: 'utf8' })
    deadline.throwIfAborted()
    return { ok: true, status: 'submitted', message: 'macOS accepted the URL for opening in the default browser. Page loading and page contents were not verified.' }
  }
  async showNotification(title: string, body: string, signal: AbortSignal): Promise<DesktopActionResult> {
    const data = notificationActionSchema.parse({ title, body }), deadline = this.signal(signal)
    if (!Notification.isSupported()) return { ok: false, status: 'failed', message: 'Desktop notifications are unavailable on this system.' }
    if (Date.now() - this.lastNotification < 5_000) return { ok: false, status: 'denied', message: 'Notification rate limit reached. Wait a few seconds before requesting another.' }
    this.lastNotification = Date.now()
    if (this.notifications.size >= 20) {
      const oldest = this.notifications.values().next().value!
      oldest.close(); this.notifications.delete(oldest)
    }
    const notification = new Notification({ title: `Athena · ${data.title}`, body: data.body, silent: true })
    this.notifications.add(notification)
    notification.once('close', () => this.notifications.delete(notification))
    return new Promise((resolve) => {
      let finished = false
      const finish = (result: DesktopActionResult) => {
        if (finished) return
        finished = true
        clearTimeout(timer); deadline.removeEventListener('abort', cancelled)
        notification.removeListener('show', shown); notification.removeListener('failed', failed)
        resolve(result)
      }
      const shown = () => finish({ ok: true, status: 'completed', message: 'macOS reported the Athena notification was shown.' })
      const failed = () => { this.notifications.delete(notification); finish({ ok: false, status: 'failed', message: 'macOS could not display the notification. Check notification settings for Athena.' }) }
      const cancelled = () => { notification.close(); this.notifications.delete(notification); finish({ ok: false, status: 'cancelled', message: 'Notification request stopped; it may already have appeared.' }) }
      const timer = setTimeout(() => finish({ ok: true, status: 'submitted', message: 'Notification submitted. macOS did not confirm display; Focus mode or notification settings may suppress it.' }), 2_000)
      notification.once('show', shown); notification.once('failed', failed)
      deadline.addEventListener('abort', cancelled, { once: true })
      if (deadline.aborted) cancelled()
      else { try { notification.show() } catch { failed() } }
    })
  }
  dispose(): void {
    this.abort.abort()
    for (const notification of this.notifications) notification.close()
    this.notifications.clear()
  }
}
