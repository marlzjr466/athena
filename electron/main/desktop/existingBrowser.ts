import { chromium, type Browser, type Page, type CDPSession } from 'playwright-core'
import { createHash, randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { APPLICATIONS, type AccessibleElement, type DesktopRect } from '../../../shared/desktopActions'
import type { NativePageRequest, NativePageResult } from './desktopPlatform'
import type { VoiceBrowserAction } from '../../../shared/voiceBrowser'
import { ChatError } from '../ai/AIProvider'
import { ObservationRequired } from './observationRequired'
import { browserActionScript, uniqueObservedButton } from './voiceBrowserDOM'
import { backgroundSearchScript, observeBackgroundSearchScript } from './backgroundBrowserDOM'
import { BrowserFocusRequired,chooseWindow, windowRequest, workspaceResultSchema, type BrowserApp, type DesktopContext, type WorkspaceState, type WorkspaceWindow } from './desktopContext'

type Settings = { reuseBrowserWindows:boolean; browserDebugPort:number; pauseOnConflict:boolean }
type BackgroundScope={app:BrowserApp;pid:number;window:string;capture:string;tab:string;url:string;document?:string}
type BackgroundPin=BackgroundScope & {pending?:boolean;cdp?:{page:Page;target:string;window:number;port:number}}
interface BrowserServices {
  backgroundOwner?():string|undefined
  expectedSelection?():{app:BrowserApp;pid:number;window:string;tab:string}|undefined
  allowBackground?(scope:BackgroundScope):boolean
  handsFreeSearch?():boolean
  context: DesktopContext
  athenaPid?:number
  consumeFocusGrant?(scope:{app:BrowserApp;pid:number;window:string;tab:string}):boolean
  mark?(target:import('./interactionOverlay').InteractionTarget,signal:AbortSignal):Promise<import('./interactionOverlay').InteractionHandle>
  feedback?():import('./voiceBrowserDOM').BrowserFeedback
  settings():Settings
  canDiscover?():boolean
  requireExisting?():boolean
  defaultBrowser():BrowserApp|undefined
  allowed(app:BrowserApp, input:boolean):boolean
  launch(app:BrowserApp,signal:AbortSignal):Promise<{ok:boolean;message:string}>
  onOtherDisplay(current:WorkspaceWindow, candidate:WorkspaceWindow):boolean
  confirm(message:string):Promise<boolean>
  publicURL(url:string):Promise<boolean>
  nativePage?(app:BrowserApp,request:NativePageRequest,signal:AbortSignal):Promise<NativePageResult>
  allowSearch?(scope:{app:BrowserApp;pid:number;window:string;tab:string;url:string},text:string):boolean
}
function sameAddress(href:string,display:string) {
  const value=new URL(href)
  return display===href || display===value.host+value.pathname+value.search+value.hash ||
    value.pathname==='/' && !value.search && !value.hash && (display===value.host || display+'/'===href)
}
type PageControl=DesktopRect & {viewWidth:number;viewHeight:number;key:string}
/** Keep browser chrome, page zoom and per-monitor scaling out of CSS guesses.
 * A native document that reports a full scroll extent isn't a usable viewport. */
export function pageControlBounds(page:DesktopRect,win:DesktopRect,control:PageControl):DesktopRect|undefined {
  const {x,y,width,height,viewWidth,viewHeight}=control
  if(![x,y,width,height,viewWidth,viewHeight].every(Number.isFinite) || width<=0 || height<=0 || viewWidth<=0 || viewHeight<=0)return
  if(x<0 || y<0 || x+width>viewWidth+1 || y+height>viewHeight+1)return
  if(page.x<win.x-2 || page.y<win.y-2 || page.x+page.width>win.x+win.width+2 || page.y+page.height>win.y+win.height+2)return
  const scale=page.width/viewWidth
  if(scale<=0 || Math.abs(page.height-viewHeight*scale)>2)return
  return {x:page.x+x*scale,y:page.y+y*scale,width:width*scale,height:height*scale}
}
export class ExistingBrowser {
  private pins=new Map<string,BackgroundPin>()
  private attached?:Browser
  private port=0
  private observations=new Map<Page,{url:string;at:number;button?:string}>()
  private lastNative?:{app:BrowserApp;pid:number;window:string;tab:string;token:string;at:number;button?:string}
  private idle?:ReturnType<typeof setTimeout>
  private isolated=false
  private nativeStatus?:string
  private uncertainSearches=new Map<string,string>()
  // A voice lease may reuse its own most recent, verified native field edit.
  // Keep only a digest of the query; the opaque field identity stays local.
  private searchEdits=new Map<string,{scope:string;digest:string;token:string;at:number}>()
  private searchFields=new Map<string,{app:BrowserApp;pid:number;window:string;tab:string;document:string;stamps:Map<string,string>;at:number}>()
  constructor(private service:BrowserServices){}
  forgetBackground(owner:string){this.pins.delete(owner);this.searchEdits.delete(owner);this.searchFields.delete(owner);this.armIdleDisconnect()}
  private armIdleDisconnect(){
    clearTimeout(this.idle)
    if(this.attached && ![...this.pins.values()].some(pin=>pin.cdp)){
      this.idle=setTimeout(()=>this.disconnect(),60000)
      this.idle.unref?.()
    }
  }
  private savePin(app:BrowserApp,pid:number,win:WorkspaceWindow,url:string,cdp?:BackgroundPin['cdp'],document?:string){
    const owner=this.service.backgroundOwner?.(),tab=win.tabs?.filter(item=>item.selected)
    if(!owner)return
    this.pins.delete(owner)
    if(tab?.length!==1 || !win.captureId || win.address && !sameAddress(url,win.address))return
    if(!win.address && !cdp && !document)return
    const pin={app,pid,window:win.id,capture:win.captureId,tab:tab[0].id,url,cdp,document}
    if(this.service.allowBackground?.(pin))this.pins.set(owner,pin)
  }
  private async pinnedWindow(pin:BackgroundPin,signal:AbortSignal,observed?:WorkspaceState){
    this.check(pin.app,false,signal)
    const owner=this.service.backgroundOwner?.()
    if(!owner || !this.service.settings().reuseBrowserWindows || this.pins.get(owner)!==pin || !this.service.allowBackground?.(pin))
      throw new ChatError('Background access to the selected window has ended. Select and authorize it again.')
    const state=observed??await this.service.context.observe(pin.app,signal)
    const win=state.windows.find(w=>w.id===pin.window && w.captureId===pin.capture && !w.minimized && !w.hidden)
    const tabs=win?.tabs?.filter(t=>t.selected)
    if(state.pid!==pin.pid || !win || tabs?.length!==1 || tabs[0].id!==pin.tab){
      this.pins.delete(owner)
      throw new ChatError('The authorized browser window or selected tab changed. Select the intended tab again.')
    }
    return {state,win}
  }
  async initialSearchTarget(named:BrowserApp|undefined,destination:string|undefined,signal:AbortSignal){
    const s=this.service,owner=s.backgroundOwner?.()
    if(!owner || !s.handsFreeSearch?.() || !s.nativePage || !s.settings().reuseBrowserWindows || s.canDiscover?.()===false)return
    const previous=this.pins.get(owner)
    if(previous && !previous.pending)return
    const app=await s.context.uniqueBackgroundBrowser(named,signal)
    if(!app)return
    this.check(app,false,signal)
    const state=await s.context.observe(app,signal)
    const visible=(state:WorkspaceState)=>state.windows.filter(w=>!w.hidden && !w.minimized)
    const wins=visible(state)
    if(state.focused || !state.running || !state.foreground || state.foreground===state.pid)return
    if(wins.length!==1)throw new BrowserFocusRequired('The background browser does not have one unambiguous visible window. Select the intended window.')
    const win=wins[0],tabs=win.tabs?.filter(t=>t.selected)
    if(!win.captureId || tabs?.length!==1)throw new BrowserFocusRequired('The visible browser window or its selected tab could not be identified. Select the intended window.')
    const scope={app,pid:state.pid,foreground:state.foreground,window:win.id,capture:win.captureId,tab:tabs[0].id}
    // Only committed metadata is returned by bind. The first actual page read
    // goes through the existing scope/owner checks in background-inspect.
    const bound=await s.nativePage(app,{action:'background-bind',token:JSON.stringify(scope)},signal)
    if(!bound.ok || !bound.verified || !bound.pageURL || !bound.pageReference || !/^https?:\/\//i.test(bound.pageURL) ||
      !URL.canParse(bound.pageURL) || new URL(bound.pageURL).username || new URL(bound.pageURL).password || !(await s.publicURL(bound.pageURL)))
      throw new ChatError('The selected tab did not expose a verified public web document for this search.')
    if(destination && new URL(bound.pageURL).origin!==new URL(destination).origin)
      throw new ChatError('The selected background tab is on a different site. Select the requested site or ask to open it.')
    const again=await s.context.observe(app,signal),windows=visible(again),current=windows[0],selected=current?.tabs?.filter(t=>t.selected)
    if(again.focused || again.foreground!==state.foreground || again.pid!==scope.pid || windows.length!==1 ||
      current.id!==scope.window || current.captureId!==scope.capture || selected?.length!==1 || selected[0].id!==scope.tab ||
      await s.context.uniqueBackgroundBrowser(named,signal)!==app)
      throw new ChatError('The initial browser, window or selected tab changed. Inspect the intended browser again.')
    this.check(app,false,signal)
    if(!s.handsFreeSearch?.() || s.backgroundOwner?.()!==owner)throw new ChatError('Browser search permission changed before the selected tab was identified.')
    const pin:BackgroundPin={app,pid:scope.pid,window:scope.window,capture:scope.capture,tab:scope.tab,url:bound.pageURL,document:bound.pageReference,pending:true}
    this.pins.set(owner,pin)
    return {...pin,focused:false,backgroundVerified:true as const}
  }
  async backgroundTarget(signal:AbortSignal){
    const owner=this.service.backgroundOwner?.(),pin=owner && this.pins.get(owner)
    if(!pin || !this.service.allowBackground?.(pin))return
    this.check(pin.app,false,signal)
    const state=await this.service.context.observe(pin.app,signal)
    if(state.focused)return
    const foreground=await this.service.context.foregroundBrowser(signal)
    if(foreground && foreground!==pin.app)return
    await this.pinnedWindow(pin,signal,state)
    pin.pending=false
    if(pin.cdp && (pin.cdp.page.isClosed() || pin.cdp.page.url()!==pin.url || this.service.settings().browserDebugPort!==pin.cdp.port))
      throw new ChatError('The pinned browser page or connection changed. Select the intended page again.')
    return {app:pin.app,pid:pin.pid,window:pin.window,tab:pin.tab,url:pin.url,capture:pin.capture,document:pin.document,focused:false}
  }
  private check(app:BrowserApp,input:boolean,signal:AbortSignal) {
    signal.throwIfAborted()
    if(!this.service.allowed(app,input))throw new ChatError('Existing browser control requires an authorized browser, application detection, desktop control and Accessibility. Enable keyboard and mouse control for input, or explicitly request Athena’s dedicated browser.')
  }
  private async restoreAfterApproval(app:BrowserApp,pid:number,win:WorkspaceWindow,tab:string,input:boolean,signal:AbortSignal) {
    const s=this.service
    this.check(app,input,signal)
    const state=await s.context.observe(app,signal)
    const current=state.windows.find(w=>w.id===win.id && !w.hidden && !w.minimized && w.tabs?.some(t=>t.selected && t.id===tab))
    if(state.pid!==pid || !current)throw new ChatError('The approved browser window or tab changed. Select the intended target again.')
    if(state.focused && current.focused)return state
    if(!s.athenaPid || state.foreground!==s.athenaPid)throw new ChatError('The foreground application changed. Focus the approved browser tab to continue.')
    this.check(app,input,signal)
    const activation=workspaceResultSchema.parse(await s.context.invoke(app,{operation:'activate',...windowRequest(state,current),details:true},signal))
    if(!activation.ok)throw new ChatError(activation.message)
    const after=await s.context.observe(app,signal)
    if(after.pid!==pid || !after.focused || !after.windows.some(w=>w.id===win.id && w.focused && w.tabs?.some(t=>t.id===tab && t.selected)))throw new ChatError('The approved browser tab did not regain focus. Focus it before continuing.')
    return after
  }
  async run(command:VoiceBrowserAction,signal:AbortSignal,utterance:string):Promise<Record<string,unknown>|undefined> {
    const s=this.service
    if (/\b(?:Athena['’]s|Athena|dedicated|isolated) browser\b/i.test(utterance)) this.isolated=true
    const explicit=command.action==='window' || /\b(?:existing|personal|running|current) browser\b/i.test(utterance)
    const existingOnly=explicit || s.requireExisting?.()===true
    if(explicit)this.isolated=false
    if(!existingOnly && (this.isolated || !s.settings().reuseBrowserWindows))return
    const named=command.action==='window'?command.browser:undefined
    const input=!['inspect','tabs','read'].includes(command.action)
    // Do not inspect other apps before the user's application-detection authorization.
    if(s.canDiscover?.()===false){
      if(existingOnly)throw new ChatError('Enable application detection and desktop interaction to use an existing browser window.')
      return
    }
    const handsFreeSearch=s.handsFreeSearch?.()===true
    if(handsFreeSearch && ['click','click-observed','choose'].includes(command.action))
      throw new ChatError('This voice request authorizes a search. Inspect the page, use its search field and submit-search with the dictated query. A different control needs its own instruction.')
    const owner=s.backgroundOwner?.(),pin=owner?this.pins.get(owner):undefined
    if(owner && !['inspect','read','tabs','submit-search'].includes(command.action))this.searchEdits.delete(owner)
    const routine=['inspect','read','type','submit-search'].includes(command.action)
    if(pin && !routine && !['open','window','tabs','select','other-tab'].includes(command.action) && await this.backgroundTarget(signal))
      throw new ChatError('This action needs the authorized browser in the foreground. Background control supports reading and scoped searches.')
    if(pin && routine && await this.backgroundTarget(signal)){
      const {win}=await this.pinnedWindow(pin,signal)
      if(!await s.publicURL(pin.url))throw new ChatError('The pinned page is outside authorized browser access.')
      this.check(pin.app,input,signal)
      if(pin.cdp)return this.pinnedPageAction(pin,command,signal)
      if(!pin.document)throw new ChatError('Focus the authorized browser for this action. Its background document identity is unavailable.')
      const result:Record<string,unknown>=await this.nativePageAction(command,pin.app,pin.pid,win,signal,pin)
      const {pageURL,pageReference,...receipt}=result
      if(command.action==='submit-search' && receipt.verified===true && typeof pageURL==='string' && new URL(pageURL).origin===new URL(pin.url).origin && typeof pageReference==='string'){
        pin.url=pageURL;pin.document=pageReference
      }
      return receipt
    }
    let app=await s.context.browser(named,signal)
    if(!app && !existingOnly && command.action!=='open')return
    app??=s.defaultBrowser()
    if(!app)throw new ChatError('Name the browser whose window you want to use.')
    this.check(app,input,signal)
    let state=await s.context.observe(app,signal)
    this.nativeStatus=state.running ? APPLICATIONS[app].name+' · native window controls (DOM connection '+(this.attached?.isConnected()?'connected':'not attached')+')' : undefined
    if(!state.running) {
      if(!['window','open'].includes(command.action))throw new ChatError('The requested browser is closed. Open it before continuing.')
      const started=await s.launch(app,signal)
      if(!started.ok)throw new ChatError(started.message)
      this.check(app,input,signal)
      state=await s.context.observe(app,signal)
      if(!state.running)throw new ChatError('Browser launch was submitted. Its running instance could not be verified.')
    }
    const active=chooseWindow(state)
    let win=command.action==='window' && command.operation==='other-display' && active ?
      chooseWindow(state,candidate=>s.onOtherDisplay(active,candidate)) : active
    const chosen=app
    const invoke=async(operation:Parameters<DesktopContext['invoke']>[1]['operation'],extra:{url?:string;query?:string}={})=>{
      this.check(chosen,input,signal)
      const response=await s.context.invoke(chosen,{operation,...windowRequest(state,win),...extra,details:true},signal)
      this.check(chosen,input,signal)
      s.context.remember(chosen)
      const checked=workspaceResultSchema.parse(response)
      return {...checked,verified:checked.ok}
    }
    if(command.action==='tabs') {
      const titles=state.windows.flatMap(w=>w.tabs?.map(t=>t.title)??[])
      return {ok:true,message:titles.length ? titles.join(', ').slice(0,1500) : 'No accessible browser tabs were found.'}
    }
    if(command.action==='select'||command.action==='other-tab'){
      const matches=state.windows.flatMap(w=>(w.tabs??[]).filter(t=>command.action==='select'?t.title.toLowerCase().includes(command.query.toLowerCase()):w.id===win?.id && !t.selected).map(t=>({w,t})))
      if(matches.length!==1)throw new ChatError('Say the unique title of the tab you want.')
      win=matches[0].w
      const tabId=matches[0].t.id,windowId=win.id,pid=state.pid
      const expected=s.expectedSelection?.()
      if(expected && (expected.app!==app || expected.pid!==pid || expected.window!==windowId || expected.tab!==tabId))
        throw new ChatError('The requested browser tab changed before selection. Inspect the matching tab again.')
      if(!state.focused || !win.focused){
        // Selection explicitly targets this verified window. Activate it first
        // so any following AXPress can be painted at its real on-screen bounds.
        const activated=await invoke('activate')
        if(!activated.ok)throw new ChatError(activated.message)
        state=await s.context.observe(chosen,signal)
        win=state.windows.find(w=>w.id===windowId && w.focused && !w.hidden && !w.minimized)
      }
      const tab=win?.tabs?.find(t=>t.id===tabId)
      if(state.pid!==pid || !state.focused || !win || !tab)throw new ChatError('The requested browser tab changed before selection.')
      if(tab.selected)return {ok:true,verified:true,message:'The requested tab is already selected in the focused browser window.'}
      const mark=await s.mark?.({label:'select tab',bounds:tab.bounds,displayBounds:win.bounds,nativePixels:true,click:true},signal)
      let verified=false
      try{
        const fresh=await s.context.observe(chosen,signal),same=fresh.windows.find(w=>w.id===windowId && w.focused)
        const current=same?.tabs?.find(t=>t.id===tabId)
        if(!fresh.focused || fresh.pid!==pid || !current || current.selected || same?.tabs?.find(t=>t.selected)?.id!==win.tabs?.find(t=>t.selected)?.id || JSON.stringify(current.bounds)!==JSON.stringify(tab.bounds))
          throw new ChatError('The tab changed while becoming ready. Inspect it again before selecting.')
        const result=await invoke('select',{query:tab.id});verified=result.ok;return result
      }finally{mark?.finish(verified)}
    }
    if(command.action==='open'||command.action==='window'){
      const url=command.url
      if(url && !await s.publicURL(url))throw new ChatError('Choose a public HTTP or HTTPS address.')
      const op=command.action==='open'?'navigate':command.operation
      return invoke(op==='other-display'?'current':op,url?{url}:{})
    }
    if(command.action==='back'||command.action==='forward'||command.action==='close-tab') {
      if(command.action==='close-tab' && !await s.confirm('Close the selected tab in your existing browser? It may contain unsaved work.'))throw new ChatError('Closing the browser tab was declined.')
      return invoke(command.action)
    }
    if(win && (!state.focused || !win.focused) && s.athenaPid && state.foreground===s.athenaPid){
      const tab=win.tabs?.find(t=>t.selected)
      if(tab && s.consumeFocusGrant?.({app,pid:state.pid,window:win.id,tab:tab.id})){
        const id=win.id
        state=await this.restoreAfterApproval(app,state.pid,win,tab.id,input,signal)
        win=state.windows.find(w=>w.id===id && w.focused)
      }
    }
    if(!win || !state.focused || !win.focused)throw new ChatError('Focus the browser window to use its page controls.')
    const port=s.settings().browserDebugPort
    // Use the same native inventory for inspection, entry and submission so
    // labels/field identities agree and the desktop cursor paints the actual target.
    const nativeSearch=handsFreeSearch && !!s.nativePage && process.platform==='darwin' && routine
    if(!nativeSearch && handsFreeSearch && (command.action==='type' || command.action==='submit-search')){
      const selected=win.tabs?.filter(item=>item.selected)
      if(pin?.cdp && pin.app===app && pin.pid===state.pid && pin.window===win.id && pin.capture===win.captureId && selected?.length===1 && pin.tab===selected[0].id)
        return this.pinnedPageAction(pin,command,signal)
      if(!s.nativePage)throw new ChatError('Inspect the authorized browser tab and identify its verified search field before entering the dictated query.')
    }
    if(!nativeSearch && !(handsFreeSearch && command.action==='type') && port && command.action!=='submit-search' && ['chrome','edge'].includes(app)) {
      let connection:Browser|undefined
      try {connection=await this.connect(port,signal)}catch { /* Native inspection remains available before any page action was submitted. */ }
      if(connection){
        clearTimeout(this.idle)
        try{return await this.pageAction(connection,command,app,state.pid,win,signal)}
        finally{this.armIdleDisconnect()}
      }
    }
    const result:Record<string,unknown>=await this.nativePageAction(command,app,state.pid,win,signal)
    const {pageURL,pageReference,...receipt}=result
    if(command.action==='inspect' && receipt.ok===true && typeof pageURL==='string' && typeof pageReference==='string')
      this.savePin(app,state.pid,win,pageURL,undefined,pageReference)
    return receipt
  }
  private async nativePageAction(command:VoiceBrowserAction,app:BrowserApp,pid:number,win:WorkspaceWindow,signal:AbortSignal,pinned?:BackgroundScope) {
    const service=this.service,perform=service.nativePage,tab=win.tabs?.find(t=>t.selected)
    const scopedSearch=service.handsFreeSearch?.()===true
    const supported=['inspect','read','click','click-observed','type','submit-search','scroll','media']
    if(command.action==='media' && !['play','pause'].includes(command.operation))throw new ObservationRequired(app,'This media operation needs a fresh visual observation. No input was issued.')
    if(!perform || !supported.includes(command.action))throw new ObservationRequired(app,'Native accessibility does not implement this page operation. No input was issued; inspect the current window with the authorized visual executor.')
    if(!tab)throw new ChatError('The browser did not expose its active tab. Focus the tab you want to use.')
    const input=!['inspect','read'].includes(command.action)
    const checkPin=()=>{
      if(pinned && (!pinned.document || pinned.app!==app || pinned.pid!==pid || pinned.window!==win.id || pinned.tab!==tab.id || pinned.capture!==win.captureId || !service.allowBackground?.(pinned)))
        throw new ChatError('The authorized background browser document is unavailable. Inspect the intended tab in the foreground again.')
    }
    if(pinned && !['inspect','read','type','submit-search'].includes(command.action))
      throw new ChatError('This native action requires the selected browser window in the foreground. No input was sent.')
    const inspect=async()=>{
      this.check(app,input,signal)
      checkPin()
      const state=await service.context.observe(app,signal)
      if(state.pid!==pid || !state.windows.some(w=>w.id===win.id && (pinned ? w.captureId===pinned.capture && !w.hidden && !w.minimized : state.focused && w.focused) && w.tabs?.some(t=>t.selected && t.id===tab.id)))throw new ChatError('The authorized browser window or selected tab changed. Inspect the page again.')
      let view:NativePageResult
      try{view=await perform(app,pinned ? {action:'background-inspect',token:JSON.stringify(pinned)} : {action:'inspect'},signal)}catch(error){
        if(error instanceof ChatError && /^The browser did not expose a single focused HTTP or HTTPS document\./.test(error.userMessage)){
          if(scopedSearch)throw new ChatError('The browser did not expose its page for this voice search. Select the intended tab and inspect its search field.')
          throw new ObservationRequired(app,'The native helper could not expose the page document. No input was issued; approved window observation is required.')
        }
        throw error
      }
      if(!view.ok || !view.pageURL || !view.windowToken || !await service.publicURL(view.pageURL))throw new ChatError('The browser did not expose an authorized public page.')
      if(pinned && (view.pageURL!==pinned.url || view.pageReference!==pinned.document))throw new ChatError('The pinned background page changed. Its contents were withheld.')
      this.check(app,input,signal)
      checkPin()
      return {token:view.windowToken,url:view.pageURL,document:view.pageReference,controls:(view.elements??[]).filter(e=>!/(?:password|credential|secret|token)/i.test(e.label))}
    }
    const view=await inspect()
    const owner=service.backgroundOwner?.()
    service.context.remember(app)
    if(command.action==='inspect'){
      // AX often supplies the visible heading or text in AXValue and calls the
      // node simply “text”. Only expose values from non-editable text roles.
      const controls=view.controls.filter(e=>!/^(?:AX(?:WebArea|Document|HTMLContent|Group|ScrollArea)|ControlType\.(?:Document|Group|Pane))$/i.test(e.role))
        .map(({label,role,enabled,value,searchField})=>{
          const text=/(?:StaticText|\.Text|Heading)$/i.test(role) ? value?.trim().slice(0,500) : undefined
          return {label,role,enabled,...(searchField?{searchField:true}:{}),...(text && text!==label ? {text} : {})}
        })
      if(!controls.length){
        this.lastNative=undefined
        if(scopedSearch)throw new ChatError('The selected browser page exposed no readable controls for this search. Select the intended page and inspect its search field.')
        throw new ObservationRequired(app,'The current page exposed no readable content or controls through accessibility. A scoped window observation is needed.')
      }
      const buttons=view.controls.filter(e=>e.enabled && /button$/i.test(e.role))
      if(owner && scopedSearch && !pinned && view.document){
        const stamps=new Map<string,string>()
        for(const e of view.controls)if(e.enabled && e.searchField && e.searchFieldId && e.searchValueStamp)stamps.set(e.searchFieldId,e.searchValueStamp)
        this.searchFields.set(owner,{app,pid,window:win.id,tab:tab.id,document:view.document,stamps,at:Date.now()})
      }
      this.lastNative={app,pid,window:win.id,tab:tab.id,token:view.token,at:Date.now(),button:buttons.length===1?buttons[0].label:undefined}
      return {ok:true,message:'Active page: '+tab.title.slice(0,200),data:{controls},pageURL:view.url,pageReference:view.document}
    }
    if(command.action==='read'){
      const excerpt=view.controls.filter(e=>/(?:StaticText|\.Text|Heading)$/i.test(e.role)).map(e=>e.value??e.label).filter(t=>t && !/^(?:text|heading)$/i.test(t)).slice(0,12).join(' ').slice(0,780)
      return {ok:!!excerpt,message:excerpt?'Page excerpt: '+excerpt:'No accessible page text was available.'}
    }
    const last=this.lastNative
    this.lastNative=undefined
    let match:(element:AccessibleElement)=>boolean
    const mediaButton=(label:string,operation:string)=>new RegExp('^(?:'+(operation==='pause'?'pause':'play|resume')+')(?:\\s*\\([^)]*\\))?$','i').test(label)
    if(command.action==='media'){
      match=e=>/button$/i.test(e.role) && mediaButton(e.label,command.operation)
      const opposite=view.controls.filter(e=>e.enabled && /button$/i.test(e.role) && mediaButton(e.label,command.operation==='pause'?'play':'pause'))
      if(!view.controls.some(e=>e.enabled && match(e)) && opposite.length===1)return {ok:true,verified:true,message:'The current page already exposes the '+opposite[0].label+' control; playback is '+(command.operation==='pause'?'paused.':'active.')}
    }else if(command.action==='click-observed'){
      if(!last?.button || last.app!==app || last.pid!==pid || last.window!==win.id || last.tab!==tab.id || last.token!==view.token || Date.now()-last.at>60_000)throw new ChatError('Which button? Say its accessible name.')
      match=e=>e.label===last.button && /button$/i.test(e.role)
    }else if(command.action==='scroll'){
      match=e=>/ScrollBar$/i.test(e.role)
    }else if(command.action==='click' || command.action==='type' || command.action==='submit-search'){
      match=e=>e.label===command.label && (command.action==='click'?/button|link|menuitem|checkbox|radio/i.test(e.role):/^(?:AX(?:TextField|TextArea|SearchField|ComboBox)|ControlType\.(?:Edit|ComboBox))$/i.test(e.role))
    }else throw new ChatError('Unsupported native page action.')
    const targets=view.controls.filter(e=>e.enabled && match(e))
    if(targets.length!==1){
      if(scopedSearch)throw new ChatError('The browser did not expose one matching search field. Inspect the page and use the exact label of its semantic search field.')
      throw new ObservationRequired(app,'The page did not expose one matching accessible control. No input was issued; a fresh visual observation is needed.')
    }
    const scope={app,pid,window:win.id,tab:tab.id,url:view.url}
    const routineSearch=(command.action==='type' || command.action==='submit-search') && targets[0].searchField===true && service.allowSearch?.(scope,command.text)===true
    if(scopedSearch && (command.action==='type' || command.action==='submit-search') && !routineSearch)
      throw new ChatError('The selected control or query does not match this authorized voice search. Inspect the page for a semantic search field and use the exact dictated query.')
    const uncertainKey=JSON.stringify([app,pid,win.id,tab.id])
    const searchAttempt=(document:string|undefined,label:string,text:string)=>createHash('sha256').update(JSON.stringify([view.url,document,label,text])).digest('hex')
    if(pinned && (command.action==='type' || command.action==='submit-search')){
      if(!routineSearch)throw new ChatError('Background entry requires an authorized search field and the exact query from this voice instruction. Focus the browser for other input.')
      const submission=command.action==='submit-search',attempt=searchAttempt(view.document,command.label,command.text)
      if(submission && this.uncertainSearches.get(uncertainKey)===attempt)throw new ChatError('This search was already submitted or its outcome is uncertain. Inspect the current results. No additional action was sent.')
      checkPin()
      this.check(app,true,signal)
      if(submission)this.uncertainSearches.set(uncertainKey,attempt)
      const result=await perform(app,{action:submission?'background-submit-search':'background-set-text',label:command.label,text:command.text,token:JSON.stringify(pinned)},signal)
      const verified=result.ok && result.verified
      if(submission && (verified || result.inputIssued===false))this.uncertainSearches.delete(uncertainKey)
      this.check(app,true,signal)
      checkPin()
      return {ok:verified,verified,message:result.message,...(verified && submission ? {pageURL:result.pageURL,pageReference:result.pageReference} : {})}
    }
    if(command.action==='submit-search'){
      const {label,text}=command
      const prepare=async(token:string)=>{
        this.check(app,true,signal)
        const prepared=await perform(app,{action:'prepare-search',label,text,token},signal)
        this.check(app,true,signal)
        if(!prepared.ok || !prepared.verified)throw new ChatError(prepared.message)
        if(prepared.pageURL!==view.url || !prepared.windowToken || prepared.elements?.length!==1)throw new ChatError('The search helper could not identify the approved page and its unique field. No Enter key was sent.')
        const target=prepared.elements[0]
        return {token:prepared.windowToken,bounds:target.bounds,click:target.role==='AXButton'}
      }
      const edit=owner?this.searchEdits.get(owner):undefined
      if(owner)this.searchEdits.delete(owner)
      const editedField=routineSearch && edit && edit.scope===uncertainKey && Date.now()-edit.at<60000
        && edit.digest===searchAttempt(view.document,label,text) ? edit.token:undefined
      const first=await prepare(editedField??JSON.stringify(scope))
      const attempt=searchAttempt(view.document??JSON.parse(first.token).document,label,text)
      if(this.uncertainSearches.get(uncertainKey)===attempt)throw new ChatError('This search was already submitted or its outcome is uncertain. Inspect the current results. No additional Enter key was sent.')
      if(!routineSearch){
        if(!await service.confirm('Submit the search “'+text+'” using “'+label+'” at '+new URL(view.url).hostname+'?'))throw new ChatError('Browser action declined.')
        await this.restoreAfterApproval(app,pid,win,tab.id,true,signal)
      }
      // Re-resolve the exact field after the dialog. Layout can legitimately
      // change while permissions are being reviewed. Paint its current bounds.
      const current=await prepare(first.token)
      if(current.token!==first.token)throw new ChatError('The observed search field or document changed during approval. No Enter key was sent.')
      const marker=await service.mark?.({label:'submit-search',bounds:current.bounds,nativePixels:true,click:current.click},signal)
      let verified=false
      try{
        this.check(app,true,signal)
        if(routineSearch && !service.allowSearch?.(scope,text))throw new ChatError('Authorization for this search expired before submission. No Enter key was sent.')
        const token=JSON.stringify({...JSON.parse(current.token),paintedBounds:current.bounds})
        this.uncertainSearches.set(uncertainKey,attempt)
        const result=await perform(app,{action:'submit-search',label,text,token},signal)
        verified=result.ok && result.verified
        if(verified || result.inputIssued===false)this.uncertainSearches.delete(uncertainKey)
        this.check(app,true,signal)
        return {ok:verified,verified,message:result.message}
      }finally{marker?.finish(verified)}
    }
    const target=targets[0], semanticEdit=command.action==='type' && routineSearch && scopedSearch
    if(semanticEdit && (!target.searchFieldId || !target.searchValueStamp || !view.document || !target.bounds))
      throw new ChatError('The native browser did not expose a stable search field and document. Inspect the field again before entering this search.')
    if(semanticEdit){
      const seen=owner && this.searchFields.get(owner)
      if(owner)this.searchFields.delete(owner)
      if(!seen || seen.app!==app || seen.pid!==pid || seen.window!==win.id || seen.tab!==tab.id || seen.document!==view.document ||
        Date.now()-seen.at>60000 || seen.stamps.get(target.searchFieldId!)!==target.searchValueStamp)
        throw new ChatError('The search field or its text changed since inspection. Inspect the current field before entering this search.')
    }
    const action=command.action==='type'?(semanticEdit?'set-search-text':'set-text'):command.action==='scroll'?'scroll':'click'
    if(action!=='scroll' && command.action!=='media' && !routineSearch){
      const detail='Allow '+action+' on “'+target.label+'”'
      if(!await service.confirm(detail+' at '+new URL(view.url).hostname+'?'))throw new ChatError('Browser action declined.')
      await this.restoreAfterApproval(app,pid,win,tab.id,input,signal)
    }
    const recheck=async()=>{
      const now=await inspect(),matches=now.controls.filter(e=>e.enabled && match(e))
      if(now.url!==view.url || !semanticEdit && now.token!==view.token || matches.length!==1 || matches[0].role!==target.role || JSON.stringify(matches[0].bounds)!==JSON.stringify(target.bounds) ||
        semanticEdit && (matches[0].searchFieldId!==target.searchFieldId || matches[0].searchValueStamp!==target.searchValueStamp || !matches[0].searchField || now.document!==view.document))throw new ChatError('The accessible page or target moved. Inspect it again.')
    }
    await recheck()
    const marker=await service.mark?.({label:semanticEdit?'set-text':action,bounds:target.bounds,nativePixels:true,click:action==='click'},signal)
    let verified=false
    try{
      await recheck()
      if(routineSearch && command.action==='type' && !service.allowSearch?.(scope,command.text))throw new ChatError('Authorization for this search expired before typing.')
      const token=semanticEdit?JSON.stringify({...scope,document:view.document,field:target.searchFieldId,searchValueStamp:target.searchValueStamp,paintedBounds:target.bounds}):view.token
      const result=await perform(app,{action,label:target.label,text:command.action==='type'?command.text:command.action==='scroll'?command.direction:undefined,token},signal)
      this.check(app,input,signal)
      verified=result.ok && result.verified
      if(verified && owner && routineSearch && command.action==='type' && result.windowToken && view.document){
        // Older helpers return a generic window token. Only the helper that
        // observed the exact edited field can authorize recovery of its focus.
        let identity
        try{identity=JSON.parse(result.windowToken)}catch{/* Generic native result. */}
        if(identity?.pid===pid && identity.window===win.id && identity.tab===tab.id && identity.url===view.url &&
            identity.document===view.document && typeof identity.field==='string' && identity.field.length>0){
          const token=JSON.stringify({...scope,document:view.document,field:identity.field,
            ...(typeof identity.passiveFocus==='string'?{passiveFocus:identity.passiveFocus}:{})})
          this.searchEdits.set(owner,{scope:uncertainKey,digest:searchAttempt(view.document,command.label,command.text),token,at:Date.now()})
        }
      }
      if(command.action==='media'){
        const after=await inspect()
        verified=after.controls.filter(e=>e.enabled && /button$/i.test(e.role) && mediaButton(e.label,command.operation==='pause'?'play':'pause')).length===1
        return {ok:verified,verified,message:verified?'Observed the playback control change: '+(command.operation==='pause'?'paused.':'playing.'):'The playback action was submitted but its state could not be verified. Inspect before retrying.'}
      }
      const verifiedDestination=verified && action==='click' && /link$/i.test(target.role)
        && !!result.pageURL && result.pageURL!==view.url
      return {ok:verified,verified,...(verifiedDestination?{verifiedDestination:true}:{}),message:result.message}
    }finally{marker?.finish(verified)}
  }
  private async connect(port:number, signal:AbortSignal) {
    if(this.attached?.isConnected() && this.port===port)return this.attached
    this.disconnect()
    const endpoint=new URL('http://127.0.0.1:'+port+'/json/version')
    const response=await fetch(endpoint,{signal:AbortSignal.any([signal,AbortSignal.timeout(1500)]),redirect:'error'})
    if(!response.ok)throw new Error('Browser endpoint unavailable')
    const value=await response.json() as {webSocketDebuggerUrl?:string}
    const ws=new URL(value.webSocketDebuggerUrl??'')
    if(ws.protocol!=='ws:' || ws.host!==endpoint.host || ws.username || ws.password || !/^\/devtools\/browser\/[a-z0-9-]+$/i.test(ws.pathname))throw new Error('Unexpected browser endpoint')
    signal.throwIfAborted()
    const attached=await chromium.connectOverCDP(ws.href,{noDefaults:true,timeout:2500})
    if(signal.aborted || this.service.settings().browserDebugPort!==port){await attached.close();throw new Error('Browser connection changed')}
    this.attached=attached;this.port=port
    return attached
  }
  private async protocolTarget(session:CDPSession){
    const {targetInfo}=await session.send('Target.getTargetInfo')
    if(targetInfo.type!=='page')throw new ChatError('The authorized Chromium target is no longer a browser page.')
    const {windowId}=await session.send('Browser.getWindowForTarget',{targetId:targetInfo.targetId})
    return {target:targetInfo.targetId,window:windowId}
  }
  private async pinnedPageAction(pin:BackgroundPin,command:VoiceBrowserAction,signal:AbortSignal) {
    const cdp=pin.cdp!
    if(cdp.page.isClosed() || this.port!==cdp.port || !this.attached?.isConnected())
      throw new ChatError('The authorized browser connection ended. Select the intended tab again.')
    const session=await cdp.page.context().newCDPSession(cdp.page)
    let submitted=false
    const owner=this.service.backgroundOwner?.()
    try{
      const validate=async(url:string)=>{
        await this.pinnedWindow(pin,signal)
        const identity=await this.protocolTarget(session)
        if(identity.target!==cdp.target || identity.window!==cdp.window || cdp.page.url()!==url)
          throw new ChatError('The browser document or window changed. Select the intended tab again.')
        this.check(pin.app,!['read','inspect'].includes(command.action),signal)
      }
      await validate(pin.url)
      const {frameTree}=await session.send('Page.getFrameTree')
      if(frameTree.frame.url!==pin.url)throw new ChatError('The tab navigated before the requested action.')
      const {executionContextId}=await session.send('Page.createIsolatedWorld',{frameId:frameTree.frame.id,worldName:'Athena voice controls'})
      const evaluate=async(expression:string)=>{
        const output=await session.send('Runtime.evaluate',{expression,contextId:executionContextId,returnByValue:true,awaitPromise:true,userGesture:false})
        if(output.exceptionDetails)throw new ChatError('The pinned document changed or could not complete the background operation.')
        return output.result.value
      }
      if(command.action==='read' || command.action==='inspect'){
        const result=await evaluate(browserActionScript(command,pin.url))
        if(command.action==='inspect' && !await evaluate(observeBackgroundSearchScript(pin.url)))throw new ChatError('The background document changed during inspection.')
        await validate(pin.url)
        if(!result?.ok)throw new ChatError('The pinned browser page did not expose the requested content.')
        if(command.action==='inspect')this.observations.set(cdp.page,{url:pin.url,at:Date.now(),button:uniqueObservedButton(result.data)})
        return {...result,verified:true} as Record<string,unknown>
      }
      if(command.action!=='type' && command.action!=='submit-search')throw new ChatError('This action requires the authorized browser to be in the foreground.')
      const observed=this.observations.get(cdp.page)
      const authorize=()=>{
        signal.throwIfAborted()
        if(!observed || observed.url!==pin.url || Date.now()-observed.at>60000)throw new ChatError('Inspect the pinned page before using its search field.')
        if(!this.service.allowBackground?.(pin) || !this.service.allowSearch?.(pin,command.text))
          throw new ChatError('Background search requires authorization for this window, site and requested query.')
      }
      await validate(pin.url)
      authorize()
      const ready=await evaluate(backgroundSearchScript(pin.url,command.label,command.text,command.action))
      if(!ready?.ok)throw new ChatError('The page did not expose the same verified search field and same-site GET search form. Use the foreground browser for this control.')
      if(command.action==='type'){
        await validate(pin.url)
        return {ok:true,verified:true,message:'The pinned search field contains the requested text. Nothing was submitted.'}
      }
      const destination=typeof ready.destination==='string' && URL.canParse(ready.destination)?new URL(ready.destination):undefined
      if(!destination || destination.origin!==new URL(pin.url).origin || !await this.service.publicURL(destination.href))
        throw new ChatError('The search form destination is outside the authorized site.')
      await validate(pin.url)
      authorize()
      if(destination.href===pin.url)return {ok:true,verified:true,message:'The pinned tab is already at the requested search address.'}
      submitted=true
      const result=await evaluate(backgroundSearchScript(pin.url,command.label,command.text,command.action,destination.href))
      if(!result?.ok)throw new ChatError('The search field changed immediately before submission. Inspect it again.')
      await cdp.page.waitForURL(destination.href,{waitUntil:'commit',timeout:5000}).catch(()=>{
        throw new ChatError('The search navigation was requested, but its destination could not be verified. Inspect the tab before trying again.')
      })
      await validate(destination.href)
      if(!this.service.allowBackground?.({...pin,url:destination.href}))throw new ChatError('Background access ended during navigation.')
      pin.url=destination.href
      this.observations.delete(cdp.page)
      submitted=false
      return {ok:true,verified:true,message:'Verified the requested search address in the same background tab.'}
    }finally{
      // Never issue a second navigation after an uncertain result.
      if(submitted && owner)this.pins.delete(owner)
      await session.detach().catch(()=>{})
    }
  }
  private async pageAction(browser:Browser,command:VoiceBrowserAction,app:BrowserApp,pid:number,win:WorkspaceWindow,signal:AbortSignal) {
    const input=!['inspect','read'].includes(command.action)
    const root=await browser.newBrowserCDPSession()
    try{
      const processes=await root.send('SystemInfo.getProcessInfo')
      if(!processes.processInfo.some(p=>p.type==='browser' && p.id===pid))throw new ChatError('The authorized Chromium connection belongs to a different browser process. Select the matching browser window.')
    }finally{await root.detach().catch(()=>{})}
    const tab=win.tabs?.find(t=>t.selected)
    if(!tab)throw new ChatError('Select a browser tab before using its page controls.')
    let page:Page|undefined,observedWindow=win
    // The native tab name and Chromium focus events can settle in a different order after navigation.
    // Reconcile observations only. A different focused window or selected tab ends the instruction.
    for(let attempt=0;attempt<5;attempt++){
      this.check(app,input,signal)
      const title=observedWindow.tabs?.find(t=>t.selected)?.title,address=observedWindow.address
      const pages=browser.contexts().flatMap(c=>c.pages()).filter(p=>/^https?:/.test(p.url()) && (!address || sameAddress(p.url(),address)))
      const matches=(await Promise.all(pages.map(async p=>{
        const active=await p.evaluate(()=>document.hasFocus() && document.visibilityState==='visible').catch(()=>false)
        return active && (address || await p.title().catch(()=>undefined)===title)?p:undefined
      }))).filter((p):p is Page=>!!p)
      if(matches.length===1){page=matches[0];break}
      if(attempt===4)break
      await delay(75,undefined,{signal})
      const native=await this.service.context.observe(app,signal)
      const current=native.windows.find(w=>w.focused && w.id===win.id)
      if(!native.focused || native.pid!==pid || !current?.tabs?.some(t=>t.selected && t.id===tab.id))throw new ChatError('The focused browser tab changed. Inspect the target again.')
      observedWindow=current
    }
    if(!page)throw new ChatError('The authorized connection does not match the focused browser tab. Select the intended page.')
    const url=page.url()
    if(!await this.service.publicURL(url))throw new ChatError('This page is outside authorized public browser access.')
    if(['video-result','first-video'].includes(command.action) && !/(^|\.)youtube\.com$/.test(new URL(url).hostname))throw new ChatError('Select a YouTube page for video controls.')
    if(command.action==='upload'||command.action==='download')throw new ChatError('File transfer is available in Athena’s dedicated browser with an approved file picker.')
    const observed=this.observations.get(page)
    if(command.action==='click-observed'){
      if(!observed?.button)throw new ChatError('Inspect the page and name the button.')
      command={action:'click',label:observed.button}
    }
    if(['click','type','choose'].includes(command.action)){
      if(!observed || observed.url!==url || Date.now()-observed.at>60000)throw new ChatError('Inspect the current page before operating a control.')
      if(!await this.service.confirm('Allow '+command.action+' on the selected control at '+new URL(url).hostname+'?'))throw new ChatError('Browser action declined.')
      await this.restoreAfterApproval(app,pid,win,tab.id,input,signal)
    }
    this.check(app,input,signal)
    const state=await this.service.context.observe(app,signal)
    if(!state.focused || !state.windows.some(w=>w.id===win.id && w.focused && w.tabs?.some(t=>t.id===tab.id && t.selected)))throw new ChatError('The browser window or tab changed. Inspect the target again.')
    let session:CDPSession|undefined,stop:(()=>void)|undefined,marker:Awaited<ReturnType<NonNullable<BrowserServices['mark']>>>|undefined,verified=false
    try{
      session=await page.context().newCDPSession(page)
      const {frameTree}=await session.send('Page.getFrameTree')
      const {executionContextId}=await session.send('Page.createIsolatedWorld',{frameId:frameTree.frame.id,worldName:'Athena voice controls'})
      this.check(app,input,signal)
      if(page.url()!==url)throw new ChatError('The selected page changed.')
      const actionId=randomUUID()
      stop=()=>{void session?.send('Runtime.evaluate',{expression:'if(globalThis.athenaActiveAction==='+JSON.stringify(actionId)+')globalThis.athenaActiveAction=undefined',contextId:executionContextId}).catch(()=>{})}
      signal.addEventListener('abort',stop,{once:true})
      const feedback=this.service.feedback?.()
      let targetKey:string|undefined
      if(this.service.mark && this.service.nativePage && observedWindow.bounds && (feedback?.visibleCursor || feedback?.highlightTargets)
          && ['click','choose','type','first-video','video-result'].includes(command.action)){
        const preview=await session.send('Runtime.evaluate',{expression:browserActionScript(command,url,undefined,actionId,true),contextId:executionContextId,returnByValue:true,awaitPromise:true})
        const target=preview.result.value as PageControl|undefined
        if(typeof target?.key==='string'){
          const nativeViewport=async()=>{
            this.check(app,input,signal)
            const current=await this.service.context.observe(app,signal)
            const currentWindow=current.windows.find(w=>w.focused && w.id===win.id && w.tabs?.some(t=>t.selected && t.id===tab.id))
            if(!current.focused || current.pid!==pid || !currentWindow)throw new ChatError('The browser target changed while locating the control.')
            // A missing document frame only affects the desktop cursor. DOM
            // feedback can still follow the exact live element inside the page.
            const native=await this.service.nativePage!(app,{action:'inspect'},signal).catch(()=>undefined)
            this.check(app,input,signal)
            return currentWindow.bounds && native?.ok && native.pageURL===url && native.pageBounds
              ? pageControlBounds(native.pageBounds,currentWindow.bounds,target) : undefined
          }
          const bounds=await nativeViewport()
          if(bounds){
            marker=await this.service.mark({bounds,nativePixels:true,click:['click','first-video','video-result'].includes(command.action),label:command.action},signal)
            if(JSON.stringify(await nativeViewport())!==JSON.stringify(bounds))throw new ChatError('The browser window or viewport moved. Inspect it again before input.')
            targetKey=target.key
          }
        }
      }
      this.check(app,input,signal)
      const output=await session.send('Runtime.evaluate',{expression:'document.hasFocus() && document.visibilityState==="visible" ? '+browserActionScript(command,url,marker?undefined:feedback,actionId,false,targetKey)+' : null',contextId:executionContextId,returnByValue:true,awaitPromise:true,userGesture:true})
      const result=output.result.value
      if(!result?.ok || output.exceptionDetails)throw new ChatError(result?.message??'The selected page changed or the result could not be verified.')
      this.check(app,input,signal)
      verified=result.ok===true
      if(command.action==='inspect'){
        this.observations.set(page,{url,at:Date.now(),button:uniqueObservedButton(result.data)})
        if(this.service.backgroundOwner?.() && win.captureId && this.service.allowBackground?.({app,pid,window:win.id,capture:win.captureId,tab:tab.id,url})){
          const identity=await this.protocolTarget(session)
          const recorded=await session.send('Runtime.evaluate',{expression:observeBackgroundSearchScript(url),contextId:executionContextId,returnByValue:true})
          const now=await this.service.context.observe(app,signal)
          const exact=now.windows.find(w=>w.focused && w.id===win.id && w.captureId===win.captureId && w.tabs?.some(t=>t.selected && t.id===tab.id))
          if(recorded.result.value===true && now.focused && now.pid===pid && exact && page.url()===url)
            this.savePin(app,pid,exact,url,{page,...identity,port:this.port})
        }
      }
      else this.observations.delete(page)
      return {...result,verified:result.ok===true} as Record<string,unknown>
    }finally{marker?.finish(verified);if(stop)signal.removeEventListener('abort',stop);await session?.detach().catch(()=>{})}
  }
  private disconnect(){clearTimeout(this.idle);void this.attached?.close().catch(()=>{});this.attached=undefined;this.observations.clear();this.pins.clear();this.searchEdits.clear();this.searchFields.clear();this.lastNative=undefined}
  reconcile(allowed:boolean){if(!allowed || this.service.canDiscover?.()===false || this.service.settings().browserDebugPort!==this.port)this.disconnect();if(!allowed){this.service.context.clear();this.isolated=false}}
  status(){return this.attached?.isConnected()?'Connected to authorized Chromium':this.nativeStatus}
  async refresh(signal:AbortSignal){
    if(this.service.canDiscover?.()===false){this.nativeStatus=undefined;return}
    const app=await this.service.context.browser(undefined,signal)
    if(!app){this.nativeStatus=undefined;return}
    const state=await this.service.context.observe(app,signal)
    this.nativeStatus=state.running?APPLICATIONS[app].name+' · native window controls · '+state.windows.length+' window(s); DOM '+(this.attached?.isConnected()?'attached':'not attached'):undefined
  }
  dispose(){this.disconnect();this.service.context.clear();this.isolated=false}
}
