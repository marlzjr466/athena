import { z } from 'zod'
import { APPLICATIONS, desktopRectSchema, type AppIdentifier } from '../../../shared/desktopActions'
import { ChatError } from '../ai/AIProvider'

export const windowStateSchema = z.object({
  id: z.string(), captureId: z.string().optional(), focused: z.boolean(), minimized: z.boolean(), hidden: z.boolean(), maximized: z.boolean().nullable(),
  bounds: desktopRectSchema.optional(), address:z.string().max(2048).optional(), documentTitle:z.string().max(512).optional(), uniqueWindowTitle:z.string().max(1024).optional(), linkDestination:z.string().max(4096).optional(), tabs: z.array(z.object({id:z.string(), title:z.string(), selected:z.boolean(), bounds:desktopRectSchema.optional()})).optional(),
})
export const workspaceStateSchema = z.object({
  running:z.boolean(), focused:z.boolean(), pid:z.number(), foreground:z.number(), windows:z.array(windowStateSchema), focusRole:z.string().optional(),
})
export type WorkspaceState = z.infer<typeof workspaceStateSchema>
export type WorkspaceWindow = z.infer<typeof windowStateSchema>
export type BrowserApp = 'chrome'|'edge'|'safari'|'firefox'
export class BrowserFocusRequired extends ChatError {}
export interface WorkspaceRequest {
  operation:'observe'|'running'|'activate'|'current'|'new-tab'|'new-window'|'navigate'|'select'|'back'|'forward'|'close-tab'
  pid?:number; foregroundWindow?:string; window?:string; foreground?:number; tab?:string; query?:string; url?:string; tabs?:boolean; path?:string; details?:boolean
  linkLabel?:string
}
export type WorkspaceInvoke = (app:AppIdentifier, request:WorkspaceRequest, signal:AbortSignal)=>Promise<unknown>
export const workspaceResultSchema=z.object({ok:z.boolean(),message:z.string()})
export function chooseWindow(state:WorkspaceState, otherDisplay?: (w:WorkspaceWindow)=>boolean):WorkspaceWindow|undefined {
  const visible=otherDisplay ? state.windows.filter(otherDisplay) : state.windows
  if (otherDisplay && visible.length!==1) throw new ChatError('Select the intended window on the other display, then say “use the current window”.')
  const selected=visible.find(w=>w.focused) ?? (visible.length===1?visible[0]:undefined)
  if (!selected && visible.length) throw new ChatError('Several windows are open. Focus the one you want to use.')
  return selected
}
export function windowRequest(state:WorkspaceState, win:WorkspaceWindow|undefined):Pick<WorkspaceRequest,'pid'|'foreground'|'foregroundWindow'|'window'|'tab'> {
  return {pid:state.pid,foreground:state.foreground,foregroundWindow:state.windows.find(w=>w.focused)?.id,window:win?.id,tab:win?.tabs?.find(t=>t.selected)?.id}
}
export function otherWindow(state:WorkspaceState,current:WorkspaceWindow) {
  const others=state.windows.filter(w=>w.id!==current.id)
  if(others.length!==1)throw new ChatError(others.length?'Several other windows are open. Focus the intended one.':'This application has no other window.')
  return others[0]
}
export const browserApps:BrowserApp[]=['chrome','edge','safari','firefox']
const windowsNames:Partial<Record<AppIdentifier,string>>={chrome:'chrome',edge:'msedge',vscode:'Code',finder:'explorer',terminal:'powershell',calculator:'CalculatorApp',teams:'ms-teams',word:'WINWORD',excel:'EXCEL'}
export function knownApplication(app:{app:string;name:string}|undefined):AppIdentifier|undefined {
  if(!app)return
  return (Object.keys(APPLICATIONS) as AppIdentifier[]).find(id=>[id,APPLICATIONS[id].name,APPLICATIONS[id].bundleId,windowsNames[id]].some(n=>n && [app.app.toLowerCase(),app.name.toLowerCase()].includes(n.toLowerCase())))
}
export function browserIdentifier(app:string) {
  return browserApps.find(id=>APPLICATIONS[id].bundleId===app || (id==='edge'?'msedge':id)===app.toLowerCase())
}
/** State is scoped to the current voice interaction. Only an app identity survives between commands.
 * Every selection, including an existing selection, obtains fresh native window and tab state. */
export class DesktopContext {
  private lastBrowser?:{app:BrowserApp;at:number}
  constructor(readonly invoke:WorkspaceInvoke, private running:(s:AbortSignal)=>Promise<Array<{app:string;active:boolean}>>) {}
  async foregroundBrowser(signal:AbortSignal):Promise<BrowserApp|undefined>{
    const active=(await this.running(signal)).find(app=>app.active)
    return active?browserIdentifier(active.app):undefined
  }
  /** Resolve an initial background search without consulting a remembered browser. */
  async uniqueBackgroundBrowser(named:BrowserApp|undefined,signal:AbortSignal){
    const apps=await this.running(signal)
    const front=apps.find(a=>a.active)
    if(!front)return
    const foreground=browserIdentifier(front.app)
    if(foreground){
      if(named && foreground!==named)throw new ChatError('A different browser is in front. Select the browser you intend to search.')
      return
    }
    const choices=apps.map(a=>browserIdentifier(a.app)).filter((app):app is BrowserApp=>!!app && (!named || named===app))
    if(choices.length>1)throw new ChatError('More than one browser or browser instance is running. Name the intended browser or select its window.')
    return choices[0]
  }
  async browser(named:BrowserApp|undefined,signal:AbortSignal):Promise<BrowserApp|undefined> {
    if(named)return named
    const apps=await this.running(signal)
    const active=apps.find(a=>a.active)
    const focused=active && browserIdentifier(active.app)
    if(focused)return focused
    const available=[...new Set(apps.map(a=>browserIdentifier(a.app)).filter((a):a is BrowserApp=>!!a))]
    if(this.lastBrowser && Date.now()-this.lastBrowser.at<5*60_000 && available.includes(this.lastBrowser.app))return this.lastBrowser.app
    if(available.length>1)throw new ChatError('Which browser window should I use? Say Chrome, Edge, Safari, or Firefox.')
    return available[0]
  }
  async observe(app:BrowserApp, signal:AbortSignal) {
    return workspaceStateSchema.parse(await this.invoke(app,{operation:'observe',tabs:true,details:true},signal))
  }
  remember(app:BrowserApp){this.lastBrowser={app,at:Date.now()}}
  clear(){this.lastBrowser=undefined}
}
