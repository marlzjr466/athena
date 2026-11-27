import {chromium, _electron as electron, expect, test} from '@playwright/test'
import {execFile, spawn} from 'node:child_process'
import {AsyncLocalStorage} from 'node:async_hooks'
import {randomUUID} from 'node:crypto'
import {mkdtemp, mkdir, readFile, realpath, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {dirname, join, resolve} from 'node:path'
import {promisify} from 'node:util'
import {CodexComputerTools} from '../../electron/main/desktop/codexComputerTools'
import type {CodexComputerTurnOptions} from '../../electron/main/desktop/codexComputerTools'
import {NativeComputerCalls} from '../../electron/main/ai/codexComputerTools'
import {CodexCLIService} from '../../electron/main/ai/codexCLIService'
import {codexDisplay} from '../../electron/main/ai/CodexAppServerProvider'
import {CodexVoiceAutomation,type CodexVoiceProgress} from '../../electron/main/ai/codexVoiceAutomation'
import {NativeActionRegistry} from '../../electron/main/ai/nativeActionRegistry'
import {ChatController} from '../../electron/main/ai/chatController'
import {AutomationAuditLog} from '../../electron/main/ai/automationAudit'
import {DesktopContext, workspaceStateSchema, type WorkspaceRequest} from '../../electron/main/desktop/desktopContext'
import {ExistingBrowser} from '../../electron/main/desktop/existingBrowser'
import type {VoiceBrowser} from '../../electron/main/desktop/voiceBrowser'
import {dictatedBrowserText, voiceDesktopActions} from '../../electron/main/ai/voiceDesktopActions'
import {ChatError} from '../../electron/main/ai/AIProvider'
import type {NativePageRequest, NativePageResult} from '../../electron/main/desktop/desktopPlatform'
import {voiceBrowserActionSchema} from '../../shared/voiceBrowser'

test.use({trace:'off',screenshot:'off',video:'off'})
for(const variant of ['foreground','background','replace previous search','subscription planner'] as const)test('public YouTube native search with '+variant,async()=>{
  const livePlanner=variant==='subscription planner',background=variant==='background',replacing=variant==='replace previous search'
  test.skip(process.platform!=='darwin' || process.env[livePlanner?'ATHENA_PUBLIC_YOUTUBE_CODEX_E2E':'ATHENA_PUBLIC_YOUTUBE_SEARCH_E2E']!=='1','Opt-in signed Chrome integration with the real YouTube website')
  test.setTimeout(livePlanner?220000:120000)
  const exec=promisify(execFile), profile=await mkdtemp(join(tmpdir(),'athena-youtube-'))
  const appProfile=join(profile,'athena'),chromeProfile=join(profile,'chrome')
  const binary=process.env.ATHENA_VOICE_TEST_BINARY??resolve('release/mac-arm64/Athena.app/Contents/MacOS/Athena')
  const helper=resolve(dirname(binary),'../Resources/native/athena-desktop-accessibility')
  const origin='https://www.youtube.com',query='relaxing piano music'
  let expectedQuery=query
  let objective=livePlanner?'Okay, got it now. Um, search relaxing piano music':'Search for '+query
  const checkURL=(url:string)=>{const u=new URL(url);return u.origin===origin && !u.username && !u.password && ['/', '/results'].includes(u.pathname)}
  let requestedDialogs=0
  const noDialog=async()=>{requestedDialogs++;throw new ChatError('An unexpected permission dialog was requested during the authorized search.')}
  let app:Awaited<ReturnType<typeof electron.launch>>|undefined,chrome:Awaited<ReturnType<typeof chromium.connectOverCDP>>|undefined
  let child:ReturnType<typeof spawn>|undefined,existing:ExistingBrowser|undefined
  let plannerService:CodexCLIService|undefined,plannerIdentity:string|undefined
  const plannerCwd=join(profile,'voice-workspace')
  const lease=randomUUID(),owner='voice:'+lease,manager=new CodexComputerTools(),helperCalls:string[]=[]
  try{
    await exec('/usr/bin/codesign',['--verify','--strict','--deep',resolve(dirname(binary),'../..')])
    await Promise.all([mkdir(appProfile),mkdir(chromeProfile)])
    await writeFile(join(appProfile,'settings.json'),JSON.stringify({voiceEnabled:false,floatingEnabled:false,automationPermissions:{browserAccess:true,browserInteraction:true},computerUse:{enabled:true,voice:true,browser:'playwright',input:true,handsFreeBrowserSearches:true},localAI:{automaticStartup:false},webAccess:{automaticStartup:false}}))
    const signed=app=await electron.launch({executablePath:binary,args:['--mute-audio','--user-data-dir='+appProfile],env:{...process.env,ATHENA_TEST_DATA:appProfile}})
    expect(await realpath(await signed.evaluate(({app})=>app.getPath('userData')))).toBe(await realpath(appProfile))
    await expect.poll(()=>signed.windows().some(w=>w.url().includes('surface=control'))).toBe(true)
    await expect.poll(()=>signed.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().some(w=>w.webContents.getURL().includes('splash.html'))),{timeout:25000}).toBe(false)
    // Finish subscription discovery before the disposable Chrome is brought to
    // the foreground. Once the turn starts, any focus conflict stops input.
    if(livePlanner){
      plannerService=new CodexCLIService('athena-public-search-test',plannerCwd)
      const status=await plannerService.status(true)
      if(!status.authenticated || !status.identity || !status.models.some(item=>item.id==='gpt-6.2-sol'))throw new ChatError(status.message)
      plannerIdentity=status.identity
      await plannerService.connection()
    }
    child=spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',['--user-data-dir='+chromeProfile,'--remote-debugging-address=127.0.0.1','--remote-debugging-port=0','--force-renderer-accessibility','--no-first-run','--no-default-browser-check','--mute-audio','about:blank'],{stdio:'ignore'})
    const pid=child.pid
    if(!pid)throw Error('The disposable Chrome process did not start.')
    const port=async()=>Number((await readFile(join(chromeProfile,'DevToolsActivePort'),'utf8').catch(()=>'')).split('\n')[0])
    await expect.poll(port,{timeout:15000}).toBeGreaterThan(0)
    chrome=await chromium.connectOverCDP('http://127.0.0.1:'+await port())
    const cd=await chrome.newBrowserCDPSession()
    expect((await cd.send('SystemInfo.getProcessInfo')).processInfo.find(p=>p.type==='browser')?.id).toBe(pid)
    await cd.detach()
    // CDP sets up the target and checks independent postconditions. Athena is
    // configured with browserDebugPort 0 and uses only its signed native helper.
    const context=chrome.contexts()[0],page=context.pages()[0]
    await page.goto(origin+(replacing?'/':'/?hl=en'),{waitUntil:'domcontentloaded'})
    await expect(page.getByRole('combobox',{name:/search/i}),'A consent page or challenge may be blocking the real YouTube search field.').toBeVisible({timeout:18000})
    const workspace=async(operation:WorkspaceRequest['operation'])=>JSON.parse((await exec(helper,['com.google.Chrome','workspace',JSON.stringify({operation,pid,tabs:true,details:true})])).stdout)
    expect((await workspace('activate')).ok).toBe(true)
    const state=async()=>workspaceStateSchema.parse(await workspace('observe'))
    await expect.poll(async()=>{const s=await state();return s.foreground===pid && s.windows[0]?.address===page.url()}).toBe(true)
    const initial=await state(),win=initial.windows[0],tab=win?.tabs?.filter(t=>t.selected)
    if(initial.windows.length!==1 || !win.captureId || tab?.length!==1)throw Error('The disposable Chrome target is ambiguous.')
    let behind=false
    async function guard(stage:'execute'|'completed'='execute'){
      const s=await state(),w=s.windows.find(x=>x.id===win.id),tabs=w?.tabs?.filter(t=>t.selected)??[]
      const foreground=s.foreground===pid?'fixture-chrome':s.foreground===signed.process().pid?'fixture-athena':'other'
      const pages=context.pages(),address=page.url()
      const checks={
        process:s.pid===pid && s.running,
        oneWindow:s.windows.length===1,
        windowIdentity:!!w,captureIdentity:w?.captureId===win.captureId,
        windowVisible:!!w && !w.hidden && !w.minimized,
        selectedTab:tabs.length===1 && tabs[0].id===tab![0].id,
        onePage:pages.length===1 && pages[0]===page,
        site:checkURL(address),
        destination:stage==='execute' || (new URL(address).pathname==='/results' && new URL(address).searchParams.get('search_query')===expectedQuery),
        // Only an active executor owns foreground input. A later read-only
        // result assertion is bound to the same Chrome window, tab and page.
        foregroundForInput:stage==='completed' || foreground===(behind?'fixture-athena':'fixture-chrome'),
      }
      const failed=Object.entries(checks).filter(([,pass])=>!pass).map(([name])=>name)
      if(failed.length)throw new ChatError('Public Chrome test '+stage+' target check failed: '+JSON.stringify({
        failed,foreground,windows:s.windows.length,selectedTabs:tabs.length,pages:pages.length
      }))
      if(stage==='completed')console.info(JSON.stringify({test:'public-search-postcondition',foreground,pinnedTargetVerified:true}))
      return s
    }
    const desktop=new DesktopContext(async(_app,r)=>{if(r.operation!=='observe')throw new ChatError('Unexpected workspace input.');return guard()},async()=>[{app:'com.google.Chrome',active:!behind}])
    async function nativePage(_app:unknown,request:NativePageRequest):Promise<NativePageResult>{
      await guard()
      const out=await signed.evaluate(async({systemPreferences},{helper,request})=>{
        if(!systemPreferences.isTrustedAccessibilityClient(false))throw Error('The signed executor lacks macOS Accessibility permission.')
        const cp=process.getBuiltinModule('node:child_process') as typeof import('node:child_process')
        return new Promise<string>((resolve,reject)=>cp.execFile(helper,['com.google.Chrome','web-'+request.action,request.label??'',request.text??'',request.token??''],{timeout:10000,maxBuffer:1024*1024},(err,out)=>err?reject(Error('Native helper error '+err.code)):resolve(out)))
      },{helper,request})
      const result=JSON.parse(out)
      helperCalls.push(request.action)
      if(result.error)throw new ChatError(result.error)
      return {...result,ok:result.verified}
    }
    const selections=new AsyncLocalStorage<Parameters<NonNullable<CodexComputerTurnOptions['withTabSelection']>>[0]>()
    const browser=existing=new ExistingBrowser({context:desktop,allowed:()=>true,requireExisting:()=>true,defaultBrowser:()=>'chrome',settings:()=>({reuseBrowserWindows:true,pauseOnConflict:true,browserDebugPort:0}),
      publicURL:async url=>checkURL(url),launch:async()=>{throw new ChatError('Unexpected browser launch.')},onOtherDisplay:()=>false,nativePage,
      expectedSelection:()=>selections.getStore(),
      confirm:noDialog,backgroundOwner:()=>owner,handsFreeSearch:()=>true,allowBackground:s=>manager.allowsVoiceBrowser(owner,s),
      allowSearch:(s,text)=>manager.allowsVoiceBrowser(owner,s)&&dictatedBrowserText(objective,text,true)})
    // Keep Electron-only dedicated-browser routing out of the Node test worker.
    // The registered handler may call only the authorized existing-browser executor.
    const router={run:async(command,signal,instruction)=>{
      const result=await browser.run(voiceBrowserActionSchema.parse(command),signal,instruction??'')
      if(!result)throw new ChatError('The existing Chrome window could not be targeted.')
      return result
    }} satisfies Pick<VoiceBrowser,'run'>
    const action=voiceDesktopActions({} as never,router as VoiceBrowser).find(a=>a.toolName==='athena_browser_action')!
    const turnScope={
      owner,objective,handsFreeSearch:()=>true,check:async signal=>{signal.throwIfAborted();await guard()},confirm:noDialog,
      listWindows:async(app,signal)=>{signal.throwIfAborted();if(app!=='chrome')throw new ChatError('The test targets the disposable Chrome process only.');return guard()},
      withTabSelection:(selection,run)=>selections.run(selection,run),
      browserTarget:async signal=>behind?browser.backgroundTarget(signal):{app:'chrome',pid,window:win.id,tab:tab[0].id,url:(await guard()).windows[0].address,focused:true}
    } satisfies Omit<CodexComputerTurnOptions,'registry'>
    if(livePlanner){
      const control=signed.windows().find(w=>w.url().includes('surface=control'))!
      const settings=await control.evaluate(()=>window.athena!.getSnapshot().then(s=>s.settings))
      expect(settings.computerUse.handsFreeBrowserSearches).toBe(true)
      const localChat=new ChatController({provider:async()=>{throw Error('Unexpected secondary chat provider')},phase:()=>{},changed:()=>{}})
      const audit=new AutomationAuditLog(join(profile,'audit'))
      const registry=new NativeActionRegistry({controller:{settings,setAutomationActivity:()=>{}} as never,onlineChat:localChat,localAthenaChat:localChat,
        permissions:{isCapabilityAllowed:()=>false} as never,chatGPT:{} as never,validateLocalModel:async()=>false,confirmDelete:noDialog,audit})
      registry.register([action])
      const service=plannerService!
      const events:CodexVoiceProgress[]=[],requests:{tool:string;action:string;turn:string;thread:string;id:string}[]=[]
      const failures:{action:string;code:string;reason:string}[]=[]
      const recordFailure=(action:string,code:unknown,message:unknown)=>{
        const reason=codexDisplay(typeof message==='string'?message:'No diagnostic message was supplied.')
          .replace(/https?:\/\/[^\s"']+/gi,'[URL]').replace(/\/(?:Users|private\/tmp|tmp)\/[^\s"']+/g,'[local path]')
          .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g,'[email]').slice(0,360)
        failures.push({action,code:typeof code==='string' && /^[a-z0-9_-]{1,50}$/i.test(code)?code:'tool-error',reason})
      }
      let captures=0,active=true,unsubscribe:(()=>void)|undefined
      const runner=new CodexVoiceAutomation({service,cwd:plannerCwd,forget:key=>manager.forget(key),announce:event=>events.push(event),
        selection:async()=>({model:'gpt-6.2-sol',identity:plannerIdentity}),
        tools:ctx=>{
          const catalog=registry.createTools({userText:ctx.objective,requestId:ctx.owner+':'+ctx.requestId,localChat,voiceOnly:true,reviewComputerStep:noDialog})
          const tools=manager.forTurn({...turnScope,owner:ctx.owner,objective:ctx.objective,registry:catalog,
            check:async signal=>{await ctx.check(signal);await turnScope.check(signal)},
            openWindow:async()=>{captures++;throw new ChatError('Screenshot sharing is outside this search test.')}})
          return {...tools,lastFailure:()=>failures.at(-1)?.reason??tools.lastFailure?.(),execute:async(name,input,signal)=>{
            const op=name==='athena_browser_action' && input && typeof input==='object' && 'action' in input?String(input.action):name
            try{
              const raw=await tools.execute(name,input,signal)
              const receipt=JSON.parse(raw)
              if(receipt.ok===false)recordFailure(op,receipt.code,receipt.message)
              return raw
            }catch(error){
              const message=error instanceof ChatError?error.userMessage:'Unexpected executor failure'
              recordFailure(op,message.startsWith('Public Chrome test')?'fixture-target-check':'executor-error',message)
              throw error
            }
          }}
        }})
      const deadline=setTimeout(()=>{active=false;runner.end(lease)},160000)
      try{
        const {rpc}=await service.connection()
        unsubscribe=rpc.onServerRequest(({method,params})=>{
          if(method!=='item/tool/call' || !params)return
          const input=params.arguments as {action?:unknown}|undefined
          requests.push({tool:String(params.tool),action:String(input?.action??''),turn:String(params.turnId),thread:String(params.threadId),id:String(params.callId)})
        })
        await guard()
        const answer=await runner.run(lease,randomUUID(),objective,()=>active)
        const last=events.at(-1)
        const safeEvidence={site:'youtube.com',model:last?.model,thread:last?.threadId,turn:last?.turnId,
          nativeRequests:requests.map(r=>r.tool==='athena_browser_action'?r.action:r.tool),failures,helperCalls,requestedDialogs,captures}
        console.info(JSON.stringify(safeEvidence))
        expect(answer.ok,answer.message??'No verified response from planner').toBe(true)
        expect(last).toMatchObject({phase:'complete',model:'gpt-6.2-sol'})
        expect(last?.threadId).toBeTruthy()
        expect(last?.turnId).toBeTruthy()
        expect(requests.every(r=>r.thread===last?.threadId && r.turn===last?.turnId && r.tool==='athena_browser_action')).toBe(true)
        expect(new Set(requests.map(r=>r.id)).size).toBe(requests.length)
        expect(requests.filter(r=>r.action==='submit-search')).toHaveLength(1)
        expect(helperCalls.filter(action=>action==='set-search-text')).toHaveLength(1)
        expect(helperCalls.filter(action=>action==='submit-search')).toHaveLength(1)
        expect((await audit.recent()).filter(row=>row.status==='completed' && row.diagnostics?.browserOperation==='submit-search')).toHaveLength(1)
        expect(requestedDialogs).toBe(0)
        expect(captures).toBe(0)
        expect(new URL(page.url()).searchParams.get('search_query')).toBe(query)
        await expect(page.locator('ytd-search a[href*="/watch?v="]:visible').first()).toBeVisible({timeout:18000})
        await guard('completed')
      }finally{
        clearTimeout(deadline);active=false;runner.end(lease);unsubscribe?.()
        const thread=events.findLast(e=>e.threadId)?.threadId
        if(thread)await (await service.connection()).rpc.request('thread/archive',{threadId:thread}).catch(()=>{})
        localChat.dispose()
      }
      return
    }
    let seq=0,turnNumber=0
    const start=(text:string)=>{
      objective=text
      const turnId='disposable-turn-'+ ++turnNumber
      const options={userText:text,voiceOnly:true,requestId:owner+':'+turnId} as Parameters<NonNullable<typeof action.run>>[1]
      const tools=manager.forTurn({...turnScope,objective:text,
        registry:{definitions:[{name:action.toolName,description:action.description,parameters:{}}],assertAccess:()=>{},execute:async(_name,args,signal)=>{
          const input=action.inputSchema.parse(args) as Record<string,unknown>
          const result=await action.run!(input,options,signal,async()=>{await guard()})
          return JSON.stringify(action.resultSchema.parse(result))
        }}})
      const calls=new NativeComputerCalls(tools)
      calls.accept('disposable-thread',turnId)
      const run=async(args:Record<string,string>)=>{
        const response=await calls.dispatch({threadId:'disposable-thread',turnId,callId:String(++seq),namespace:null,tool:action.toolName,arguments:args})
        const raw=response.contentItems.find(i=>i.type==='inputText')
        if(!raw || raw.type!=='inputText')throw Error('The native tool returned no text receipt.')
        if(!response.success)throw Error(args.action+' failed: '+raw.text.slice(0,460))
        return JSON.parse(raw.text)
      }
      return {run,end:async()=>{calls.stop();await tools.dispose?.()}}
    }
    if(replacing){
      const setup=start('Open YouTube in my current uh browser, Chrome browser.')
      try{
        await setup.run({action:'select',query:'YouTube'})
        await guard()
        expect(context.pages()).toHaveLength(1)
      }finally{await setup.end()}
    }
    const first=start(replacing?'Okay, got it now. Um, search '+query:objective)
    const run=first.run
    try{
      const snapshot=await run({action:'inspect'})
      const fields=snapshot.data.controls.filter((e:{enabled:boolean;role:string;label:string})=>e.enabled && /AX(TextField|ComboBox|SearchField)/.test(e.role) && /search/i.test(e.label))
      expect(fields.length,'YouTube AX did not expose exactly one English search field.').toBe(1)
      if(background){
        await signed.evaluate(({app,BrowserWindow})=>{const w=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('surface=control'))!;app.focus({steal:true});w.show();w.focus()})
        behind=true
        await expect.poll(async()=>(await state()).foreground).toBe(signed.process().pid)
      }
      const field=fields[0].label
      expect((await run({action:'type',label:field,text:query})).verified).toBe(true)
      expect(await page.getByRole('combobox',{name:/search/i}).inputValue()).toBe(query)
      expect((await run({action:'submit-search',label:field,text:query})).verified).toBe(true)
      expect(new URL(page.url()).searchParams.get('search_query')).toBe(query)
      await expect(page.locator('ytd-search a[href*="/watch?v="]:visible').first()).toBeVisible({timeout:18000})
      const observed=await run({action:'inspect'})
      expect(observed.ok).toBe(true)
      await guard()
      expect(requestedDialogs).toBe(0)
      console.info(JSON.stringify({site:'youtube.com',background,visibleVideoResults:await page.locator('ytd-search a[href*="/watch?v="]:visible').count(),nativeCalls:helperCalls,requestedDialogs}))
    }finally{await first.end()}
    if(replacing){
      const field=page.getByRole('combobox',{name:/search/i})
      await guard()
      expect(await field.inputValue()).toBe(query)
      const beforeResults=await page.locator('ytd-search a[href*="/watch?v="]:visible').first().getAttribute('href')
      const key='athena-no-misdirected-enter-'+randomUUID()
      // Exercise real focus drift on the isolated public page. Only the witness
      // changes focus. Athena performs all text edits and submissions through AX.
      await field.evaluate((node,key)=>{
        node.focus();node.blur()
        sessionStorage.setItem(key,'0')
        document.addEventListener('keydown',e=>{
          if(e.isTrusted && e.key==='Enter' && !(e.target instanceof HTMLInputElement && (e.target.type==='search' || e.target.getAttribute('role')==='combobox' || e.target.name==='search_query')))
            sessionStorage.setItem(key,String(Number(sessionStorage.getItem(key))+1))
        },true)
      },key)
      await expect(field).not.toBeFocused()
      expectedQuery='instrumental jazz guitar lessons'
      const second=start('Search for '+expectedQuery)
      try{
        const read=await second.run({action:'inspect'})
        const controls=(read.data?.controls??[]) as {role:string;label:string;enabled:boolean}[]
        const fields=controls.filter(e=>e.enabled && /AX(TextField|ComboBox|SearchField)/.test(e.role) && /search/i.test(e.label))
        expect(fields).toHaveLength(1)
        const label=fields[0].label
        expect((await second.run({action:'type',label,text:expectedQuery})).verified).toBe(true)
        expect(await field.inputValue()).toBe(expectedQuery)
        await field.evaluate(node=>node.blur())
        await expect(field).not.toBeFocused()
        expect((await second.run({action:'submit-search',label,text:expectedQuery})).verified).toBe(true)
        expect(new URL(page.url()).searchParams.get('search_query')).toBe(expectedQuery)
        const result=page.locator('ytd-search a[href*="/watch?v="]:visible').first()
        await expect(result).toBeVisible({timeout:18000})
        await expect.poll(()=>result.getAttribute('href'),{timeout:18000}).not.toBe(beforeResults)
        expect(await page.evaluate(key=>sessionStorage.getItem(key),key)).toBe('0')
        expect((await second.run({action:'inspect'})).ok).toBe(true)
        expect(helperCalls.filter(c=>c==='set-search-text')).toHaveLength(2)
        expect(helperCalls.filter(c=>c==='submit-search')).toHaveLength(2)
        expect(requestedDialogs).toBe(0)
        await guard('completed')
        console.info(JSON.stringify({test:'signed-public-search-replacement',searches:2,verifiedChangedResults:true,zeroDialogs:true,misdirectedEnter:0}))
      }finally{await second.end()}
    }
  }finally{
    manager.forget(owner);existing?.dispose()
    await Promise.allSettled([chrome?.close(),app?.close(),plannerService?.shutdown()])
    if(child && child.exitCode===null && child.signalCode===null)child.kill('SIGTERM')
    await rm(profile,{recursive:true,force:true,maxRetries:5,retryDelay:150})
  }
})
