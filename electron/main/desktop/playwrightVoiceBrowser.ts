import { constants } from 'node:fs'
import { copyFile, stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { chromium, type Browser, type BrowserContext, type Page, type CDPSession } from 'playwright-core'
import type { VoiceBrowserAction } from '../../../shared/voiceBrowser'
import { ChatError } from '../ai/AIProvider'
import { browserActionScript, uniqueObservedButton } from './voiceBrowserDOM'

export type BrowserFilePicker = (kind:'upload'|'download',host:string,signal:AbortSignal)=>Promise<string|undefined>

/** Only this visible, disposable context is controlled. Chromium uses a private pipe. */
export class PlaywrightVoiceBrowser {
  private browser?: Browser
  private context?: BrowserContext
  private active?: Page
  private readonly sessions = new Map<Page, CDPSession>()
  private readonly observations = new Map<Page, {url:string; time:number;button?:string}>()
  private approvedDownload?:{page:Page;url:string}
  private disposed = false
  constructor(private allowed:()=>boolean, private confirm:(message:string)=>Promise<boolean>, private publicURL:(url:string)=>Promise<boolean>,private pickFile?:BrowserFilePicker,private feedback?:()=>import('./voiceBrowserDOM').BrowserFeedback) {}
  status() {return this.context ? `${this.context.pages().length} browser tabs open` : 'Dedicated browser closed'}
  private check(signal:AbortSignal) {
    signal.throwIfAborted()
    if (this.disposed || !this.allowed()) throw new ChatError('Browser control is disabled.')
  }
  private async connect(signal:AbortSignal) {
    if(this.context) return this.context
    let launched:Browser|undefined
    for(const channel of ['chrome','msedge',undefined]){
      this.check(signal)
      try {launched=await chromium.launch({channel,headless:false,chromiumSandbox:true,timeout:8000}); break}
      catch { /* Try the next installed Chromium distribution. */ }
    }
    if(!launched) throw new ChatError('Could not start Chrome, Edge, or Playwright Chromium. Choose Athena browser in AI → Computer use or install a supported browser.')
    try {
      this.check(signal)
      const context=await launched.newContext({acceptDownloads:!!this.pickFile,serviceWorkers:'block',permissions:[],viewport:null})
      await context.route('**/*',async route=>{
        const ok=await this.publicURL(route.request().url()).catch(()=>false)
        await (ok && this.allowed() && !this.disposed ? route.continue() : route.abort()).catch(()=>{})
      })
      await context.routeWebSocket('**/*',async socket=>{
        if(!await this.publicURL(socket.url()) || !this.allowed() || this.disposed) return socket.close()
        socket.connectToServer()
      })
      this.check(signal)
      this.browser=launched; this.context=context
      launched.on('disconnected',()=>{if(this.browser===launched){this.context=undefined;this.browser=undefined;this.active=undefined;this.observations.clear();this.sessions.clear()}})
      return context
    } catch(error) {await launched.close();throw error}
  }
  private async dom(page:Page, command:VoiceBrowserAction, url:string, signal:AbortSignal) {
    const cdp=this.sessions.get(page) ?? await this.context!.newCDPSession(page)
    this.sessions.set(page,cdp)
    const {frameTree}=await cdp.send('Page.getFrameTree')
    const {executionContextId}=await cdp.send('Page.createIsolatedWorld',{frameId:frameTree.frame.id,worldName:'Athena voice controls'})
    this.check(signal)
    if(this.active!==page || page.url()!==url) throw new ChatError('The selected page changed. Inspect again.')
    const response=await cdp.send('Runtime.evaluate',{expression:browserActionScript(command,url,this.feedback?.()),contextId:executionContextId,awaitPromise:true,returnByValue:true,userGesture:true})
    const result=response.result.value
    if(response.exceptionDetails || !result?.ok)throw new ChatError(result?.message ?? 'The action outcome could not be verified. Inspect the page before retrying.')
    return result as Record<string,unknown>
  }
  private async transfer(page:Page,command:Extract<VoiceBrowserAction,{action:'upload'|'download'}>,url:string,signal:AbortSignal){
    if(!this.pickFile)throw new ChatError('File transfer is unavailable in this browser integration.')
    const observed=this.observations.get(page)
    const validate=()=>{
      this.check(signal)
      if(!observed || this.observations.get(page)!==observed || Date.now()-observed.time>60000 || this.active!==page || page.url()!==url)throw new ChatError('Inspect the target page again before transferring a file.')
    }
    validate()
    const path=await this.pickFile(command.action,new URL(url).hostname,signal)
    if(!path)throw new ChatError('File selection was cancelled.')
    validate()
    const cdp=this.sessions.get(page)!
    const {frameTree}=await cdp.send('Page.getFrameTree')
    const {executionContextId}=await cdp.send('Page.createIsolatedWorld',{frameId:frameTree.frame.id,worldName:'Athena voice controls'})
    const handle=await cdp.send('Runtime.evaluate',{expression:browserActionScript(command,url,this.feedback?.()),awaitPromise:true,contextId:executionContextId})
    const id=handle.result.objectId
    if(!id || handle.result.subtype!=='node')throw new ChatError('The observed file control changed. Inspect the page again.')
    try{
      validate()
      if(command.action==='upload'){
        const info=await stat(path)
        if(!info.isFile() || info.size>32*1024*1024)throw new ChatError('Choose a regular file under 32 MB.')
        validate()
        await cdp.send('DOM.setFileInputFiles',{objectId:id,files:[path]})
        const state=await cdp.send('Runtime.callFunctionOn',{objectId:id,functionDeclaration:'function(){return this.files?.[0]?.name}',returnByValue:true})
        if(state.result.value!==basename(path))throw new ChatError('File selection could not be verified. Check the site before retrying.')
        return {ok:true,message:'The chosen file is attached to the page.'}
      }
      const href=await cdp.send('Runtime.callFunctionOn',{objectId:id,functionDeclaration:'function(){return this.href}',returnByValue:true})
      if(typeof href.result.value!=='string' || !await this.publicURL(href.result.value))throw new ChatError('The download link is unavailable.')
      validate()
      this.approvedDownload={page,url:href.result.value}
      const [download]=await Promise.all([page.waitForEvent('download',{timeout:10000}),cdp.send('Runtime.callFunctionOn',{objectId:id,functionDeclaration:'function(){this.click()}',userGesture:true})])
      if(download.url()!==href.result.value)throw new ChatError('The download destination changed.')
      const cancel = () => { void download.cancel().catch(()=>{}) }
      signal.addEventListener('abort',cancel,{once:true})
      try{
        if (signal.aborted) cancel()
        const source=await download.path()
        validate()
        if(!source || (await stat(source)).size>32*1024*1024)throw new ChatError('The download failed or exceeded 32 MB.')
        await copyFile(source,path,constants.COPYFILE_EXCL)
        return {ok:true,message:'Saved the downloaded file to the chosen location.'}
      }finally{signal.removeEventListener('abort',cancel);await download.delete().catch(()=>{})}
    }finally{this.approvedDownload=undefined;this.observations.delete(page);await cdp.send('Runtime.releaseObject',{objectId:id}).catch(()=>{})}
  }
  async run(command:VoiceBrowserAction, signal:AbortSignal):Promise<Record<string,unknown>> {
    if(command.action==='submit-search')throw new ChatError('Inspect and activate the search button in the dedicated browser. No Enter key was sent.')
    this.check(signal)
    const pages=this.context?.pages() ?? []
    if(command.action==='tabs')return {ok:true,message:pages.length ? (await Promise.all(pages.map(p=>p.title()))).join(', ').slice(0,1500) : 'No Athena browser tabs are open.'}
    if(command.action==='open' && !await this.publicURL(command.url))throw new ChatError('Choose a public HTTP or HTTPS address.')
    const context=await this.connect(signal)
    this.check(signal)
    let page=this.active
    if(command.action==='open'){
      if(context.pages().length>=8)throw new ChatError('Close a browser tab before opening another.')
      page=await context.newPage();this.active=page
      const current=page
      page.on('download',download=>{
        if(this.approvedDownload?.page!==current || this.approvedDownload.url!==download.url())void download.cancel().catch(()=>{})
      })
      page.on('popup',popup=>{void popup.close().catch(()=>{})})
      page.on('close',()=>{this.sessions.delete(current);this.observations.delete(current);if(this.active===current)this.active=context.pages().filter(p=>p!==current).at(-1)})
      page.on('framenavigated',frame=>{if(frame===current.mainFrame())this.observations.delete(current)})
    }
    if(command.action==='other-tab') {
      const others=pages.filter(p=>p!==page && !p.isClosed())
      if (!page || others.length!==1) throw new ChatError('Which tab? Say its title.')
      this.active=page=others[0]
    }
    if(command.action==='select'){
      const query=command.query.toLowerCase()
      const matches=(await Promise.all(pages.map(async p=>({page:p,title:(await p.title()).toLowerCase(),host:new URL(p.url()).hostname})))).filter(p=>p.title.includes(query)||p.host.includes(query))
      if(matches.length!==1)throw new ChatError('Say the unique title of an open Athena browser tab.')
      this.check(signal);page=matches[0].page;this.active=page
    }
    if(!page || page.isClosed())throw new ChatError('Open a website in Athena’s browser first.')
    const target=page
    const deadline=AbortSignal.any([signal,AbortSignal.timeout(30000)])
    const cancel=()=>{void target.close().catch(()=>{})}
    deadline.addEventListener('abort',cancel,{once:true})
    try{
      this.check(deadline)
      await target.bringToFront()
      if(command.action==='select' || command.action==='other-tab')return {ok:true,message:'Selected '+await target.title()}
      if(command.action==='close-tab'){await target.close();return {ok:target.isClosed(),message:'Closed the selected browser tab.'}}
      if(command.action==='open'){
        const response=await target.goto(command.url,{waitUntil:'domcontentloaded',timeout:20000})
        if(!response?.ok())throw new ChatError('The website did not return a successful response.')
        if(!await this.publicURL(target.url()))throw new ChatError('The destination could not be verified.')
        const destination = new URL(target.url())
        if (destination.hostname.endsWith('youtube.com') && destination.pathname === '/results') {
          const result = target.locator('a#video-title[href^="/watch"]:visible,a#video-title-link[href^="/watch"]:visible').first()
          try { await result.waitFor({state:'visible',timeout:8000}) }
          catch { throw new ChatError('YouTube opened, but video search results could not be verified. Check the page for consent or sign-in.') }
        }
        this.check(deadline);return {ok:true,message:'Opened '+(await target.title() || new URL(target.url()).hostname)}
      }
      const url=target.url()
      if(!await this.publicURL(url))throw new ChatError('This address is outside the authorized public browser.')
      this.check(deadline)
      if(command.action==='back'||command.action==='forward'){
        const result=await (command.action==='back'?target.goBack({waitUntil:'domcontentloaded'}):target.goForward({waitUntil:'domcontentloaded'}))
        if(!result && target.url()===url)throw new ChatError('No navigation in that direction could be verified.')
        return {ok:true,message:'Loaded '+await target.title()}
      }
      if(['media','first-video','video-result'].includes(command.action)&&!/(^|\.)youtube\.com$/.test(new URL(url).hostname))throw new ChatError('Open a YouTube page before using video controls.')
      if(command.action==='first-video'||command.action==='video-result'){
        const n=command.action==='video-result'?command.index:1
        const links=target.locator('a#video-title[href^="/watch"]:visible,a#video-title-link[href^="/watch"]:visible')
        await links.first().waitFor({state:'visible',timeout:6000})
        const results = new Map<string,URL>()
        for (const href of await links.evaluateAll(nodes=>nodes.map(node=>node.getAttribute('href')))) {
          if (!href) continue
          const link = new URL(href,url), video = link.searchParams.get('v')
          if (video && link.origin===new URL(url).origin && link.pathname==='/watch') results.set(video,link)
        }
        const address = Array.from(results.values())[n-1], id=address?.searchParams.get('v')
        if(!id || address.origin!==new URL(url).origin || address.pathname!=='/watch')throw new ChatError('That video result is unavailable.')
        this.check(deadline)
        await target.goto(address.href,{waitUntil:'domcontentloaded'})
        if(new URL(target.url()).searchParams.get('v')!==id)throw new ChatError('The selected video could not be verified.')
        return {ok:true,message:`Opened video result ${n}.`}
      }
      if(command.action==='upload'||command.action==='download')return await this.transfer(target,command,url,deadline)
      if(command.action==='click-observed') {
        const label=this.observations.get(target)?.button
        if (!label) throw new ChatError('Which button? Inspect the page and say the control name.')
        command={action:'click',label}
      }
      if(command.action==='click'||command.action==='type'||command.action==='choose'){
        const observed=this.observations.get(target)
        if(!observed || observed.url!==url || Date.now()-observed.time>60000)throw new ChatError('Inspect the page before operating a control.')
        if(!await this.confirm(`Allow ${command.action} on “${command.label}” at ${new URL(url).hostname}?`))throw new ChatError('Browser action declined.')
      }
      const result=await this.dom(target,command,url,deadline)
      this.check(deadline)
      if(command.action==='inspect')this.observations.set(target,{url,time:Date.now(),button:uniqueObservedButton(result.data)})
      else this.observations.delete(target)
      return result
    }finally{deadline.removeEventListener('abort',cancel)}
  }
  dispose(){this.disposed=true;void this.browser?.close().catch(()=>{});this.active=undefined;this.observations.clear();this.sessions.clear()}
}
