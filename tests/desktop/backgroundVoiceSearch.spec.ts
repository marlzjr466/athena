import {chromium,_electron as electron,expect,test} from '@playwright/test'
import {execFile,spawn} from 'node:child_process'
import {mkdtemp,mkdir,readFile,realpath,rm,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {dirname,join,resolve} from 'node:path'
import {randomUUID} from 'node:crypto'
import {promisify} from 'node:util'
import type {NativePageRequest,NativePageResult} from '../../electron/main/desktop/desktopPlatform'
import {DesktopContext,workspaceStateSchema,type WorkspaceRequest} from '../../electron/main/desktop/desktopContext'
import {ExistingBrowser} from '../../electron/main/desktop/existingBrowser'
import {CodexComputerTools} from '../../electron/main/desktop/codexComputerTools'
import {ChatError} from '../../electron/main/ai/AIProvider'
import {NativeComputerCalls} from '../../electron/main/ai/codexComputerTools'
import {dictatedBrowserText} from '../../electron/main/ai/voiceDesktopActions'
import {voiceBrowserActionSchema} from '../../shared/voiceBrowser'
import {isPageSearchRequest} from '../../shared/applicationAutomation'

test.use({trace:'off'})
const cases=[
  {transport:'native',standing:false,focus:'background'},{transport:'cdp',standing:false,focus:'background'},
  {transport:'native',standing:true,focus:'background'},{transport:'cdp',standing:true,focus:'background'},
  {transport:'native',standing:true,focus:'suggestion'},{transport:'native',standing:true,focus:'unrelated'},
] as const
for(const {transport,standing,focus} of cases)test('scoped '+transport+' search with '+(standing?'standing authorization':'one session consent')+' and '+focus+' focus',async()=>{
  test.skip(process.platform!=='darwin'||process.env.ATHENA_BACKGROUND_SEARCH_E2E!=='1','Opt-in macOS physical background search')
  test.setTimeout(120000)
  const binary=process.env.ATHENA_VOICE_TEST_BINARY??resolve('release/mac-arm64/Athena.app/Contents/MacOS/Athena')
  const helper=resolve(dirname(binary),'../Resources/native/athena-desktop-accessibility')
  const execute=promisify(execFile),profile=await mkdtemp(join(tmpdir(),'athena-background-search-'))
  const appProfile=join(profile,'athena'),chromeProfile=join(profile,'chrome')
  const owner='voice:'+randomUUID(),manager=new CodexComputerTools()
  const path='/athena-'+randomUUID(),origin='https://example.com',title='Athena '+randomUUID().slice(0,8)
  const form='<form role="search" method="get" action="'+path+'/results"><input type="search" role="combobox" aria-label="Search" aria-controls="suggestions" aria-expanded="true" name="q"><ul id="suggestions" role="listbox"><li id="suggestion" role="option" tabindex="-1">Suggested result</li></ul><button type="submit" aria-label="Search">Search</button></form><input id="unrelated" aria-label="Unrelated notes" value="untouched">'
  const witness=`<script>
    function record(key){sessionStorage.setItem(key,String(Number(sessionStorage.getItem(key))+1))}
    const field=document.querySelector('input[name=q]'),notes=document.querySelector('#unrelated');
    field.addEventListener('input',()=>sessionStorage.setItem('input',field.value));
    notes.addEventListener('input',()=>record('unrelatedEdits'));
    document.addEventListener('keydown',e=>{if(e.key==='Enter')record(e.target===field?'searchEnter':'otherEnter')},true);
    document.querySelector('button').addEventListener('click',e=>{if(e.isTrusted)record('buttonPress')})
  </script>`
  const requests:string[]=[],dialogs:string[]=[]
  let app:Awaited<ReturnType<typeof electron.launch>>|undefined
  let chrome:Awaited<ReturnType<typeof chromium.connectOverCDP>>|undefined
  let child:ReturnType<typeof spawn>|undefined,service:ExistingBrowser|undefined
  try{
    await execute('/usr/bin/codesign',['--verify','--strict','--deep',resolve(dirname(binary),'../..')])
    await Promise.all([mkdir(appProfile),mkdir(chromeProfile)])
    await writeFile(join(appProfile,'settings.json'),JSON.stringify({voiceEnabled:false,floatingEnabled:false,randomMovement:false,randomActions:false,computerUse:{handsFreeBrowserSearches:standing},localAI:{automaticStartup:false},webAccess:{automaticStartup:false}}))
    const testApp=app=await electron.launch({executablePath:binary,args:['--mute-audio','--user-data-dir='+appProfile],env:{...process.env,ATHENA_TEST_DATA:appProfile}})
    expect(await realpath(await testApp.evaluate(({app})=>app.getPath('userData')))).toBe(await realpath(appProfile))
    await expect.poll(()=>testApp.windows().some(w=>w.url().includes('surface=control'))).toBe(true)
    await expect.poll(()=>testApp.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().some(w=>w.webContents.getURL().includes('splash.html'))),{timeout:25000}).toBe(false)
    const control=testApp.windows().find(w=>w.url().includes('surface=control'))!
    const preference=await control.evaluate(()=>window.athena!.getSnapshot().then(s=>s.settings.computerUse.handsFreeBrowserSearches))
    expect(preference).toBe(standing)
    const frontPid=testApp.process().pid
    const chromeExe='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    child=spawn(chromeExe,['--user-data-dir='+chromeProfile,'--remote-debugging-address=127.0.0.1','--remote-debugging-port=0','--no-first-run','--no-default-browser-check','--disable-background-networking','--force-renderer-accessibility','about:blank'],{stdio:'ignore'})
    const pid=child.pid
    expect(pid).toBeTruthy()
    const listenPort=async()=>Number((await readFile(join(chromeProfile,'DevToolsActivePort'),'utf8').catch(()=>'' )).split('\n')[0])
    await expect.poll(listenPort,{timeout:15000}).toBeGreaterThan(0)
    const port=await listenPort()
    chrome=await chromium.connectOverCDP('http://127.0.0.1:'+port)
    const root=await chrome.newBrowserCDPSession()
    expect((await root.send('SystemInfo.getProcessInfo')).processInfo.find(p=>p.type==='browser')?.id).toBe(pid)
    await root.detach()
    const ctx=chrome.contexts()[0],page=ctx.pages()[0]
    expect(ctx.pages()).toHaveLength(1)
    const knownURL=(address:string)=>{
      const url=new URL(address)
      return url.origin===origin && [path,path+'/results'].includes(url.pathname)
    }
    await ctx.route('**/*',route=>{
      const url=new URL(route.request().url())
      if(!knownURL(url.href))return route.abort()
      const q=url.searchParams.get('q')??''
      if(q && !['relaxing piano music','instrumental jazz'].includes(q))return route.abort()
      if(q)requests.push(q)
      return route.fulfill({contentType:'text/html',body:'<title>'+title+'</title><h1>Fixture '+q+'</h1>'+form+witness})
    })
    await page.goto(origin+path)
    const workspace=async(request:WorkspaceRequest)=>JSON.parse((await execute(helper,['com.google.Chrome','workspace',JSON.stringify({...request,pid,details:true,tabs:true})])).stdout)
    expect((await workspace({operation:'activate'})).ok).toBe(true)
    const state=()=>workspace({operation:'observe'}).then(value=>workspaceStateSchema.parse(value))
    await expect.poll(async()=>(await state()).foreground).toBe(pid)
    const first=await state(),win=first.windows[0],tab=win?.tabs?.find(t=>t.selected)
    if(first.pid!==pid || first.windows.length!==1 || !win?.focused || !win.captureId || !tab || tab.title!==title)throw Error('Cannot identify the disposable Chrome window and selected tab.')
    let background=false,objective='',turnNo=0,call=0,lastNative='none'
    const actualState=async()=>{
      const current=await state(),currentWindow=current.windows.find(w=>w.id===win.id && w.captureId===win.captureId)
      const selected=currentWindow?.tabs?.filter(t=>t.selected)??[]
      if(current.pid!==pid)throw new ChatError('The fixture Chrome PID changed.')
      if(current.windows.length!==1 || !currentWindow)throw new ChatError('The pinned native window or its capture ID changed.')
      if(selected.length!==1 || selected[0].id!==tab.id)throw new ChatError('The pinned native selected tab ID changed.')
      if(ctx.pages().length!==1 || !knownURL(page.url()) || await page.title()!==title)throw new ChatError('The disposable CDP document URL, title or page count changed.')
      if(current.foreground!==(background?frontPid:pid))throw new ChatError('Foreground changed to '+(current.foreground===pid?'fixture Chrome':current.foreground===frontPid?'fixture Athena':'another application (PID '+current.foreground+')')+'. Test input stopped.')
      return current
    }
    const context=new DesktopContext(async(_app,request)=>{
      if(request.operation!=='observe')throw new ChatError('Unexpected focus or native input request: '+request.operation)
      return actualState()
    },async()=>[{app:'com.google.Chrome',active:!background}])
    const nativePage=async(_app:unknown,request:NativePageRequest):Promise<NativePageResult>=>{
      await actualState()
      const allowed=background?['background-inspect','background-set-text','background-submit-search']:focus==='background'?['inspect']:['inspect','set-search-text','prepare-search','submit-search']
      if(transport!=='native' || !allowed.includes(request.action))
        throw new ChatError('Unexpected '+request.action+' for the '+transport+' fixture scope.')
      if(background){
        const pin=JSON.parse(request.token??'{}')
        if(pin.pid!==pid || pin.window!==win.id || pin.capture!==win.captureId || pin.tab!==tab.id || !knownURL(pin.url))throw new ChatError('Unbound '+request.action+' refused.')
      }
      lastNative=request.action+' requested'
      const raw=await testApp.evaluate(async({systemPreferences},{helper,request})=>{
        if(!systemPreferences.isTrustedAccessibilityClient(false))throw Error('The signed test app lacks Accessibility permission.')
        const childProcess=process.getBuiltinModule('node:child_process') as typeof import('node:child_process')
        const args=['com.google.Chrome','web-'+request.action,request.label??'',request.text??'',request.token??'']
        return new Promise<string>((resolve,reject)=>childProcess.execFile(helper,args,{timeout:10000,maxBuffer:1024*1024},(error,out)=>error?reject(Error('Signed browser helper failed: '+(error.code??'unknown'))):resolve(out)))
      },{helper,request})
      const result=JSON.parse(raw)
      if(result.error){lastNative=request.action+' refused by helper';throw new ChatError(result.error)}
      lastNative=request.action+' '+(result.verified?'verified':'unverified')+(typeof result.inputIssued==='boolean'?', inputIssued='+result.inputIssued:'')
      if(!result.verified)lastNative+=': '+result.message
      return {...result,ok:result.verified}
    }
    const existing=service=new ExistingBrowser({context,settings:()=>({reuseBrowserWindows:true,pauseOnConflict:true,browserDebugPort:transport==='cdp'?port:0}),
      defaultBrowser:()=> 'chrome',allowed:()=>true,requireExisting:()=>true,launch:async()=>{throw Error('Unexpected browser launch')},
      nativePage:transport==='native'?nativePage:undefined,handsFreeSearch:()=>preference && isPageSearchRequest(objective),
      publicURL:async url=>knownURL(url),onOtherDisplay:()=>false,backgroundOwner:()=>owner,
      allowBackground:scope=>manager.allowsVoiceBrowser(owner,scope),allowSearch:(scope,text)=>manager.allowsVoiceBrowser(owner,scope)&&dictatedBrowserText(objective,text,true),
      confirm:async message=>{dialogs.push(message);return false}})
    const browserTarget=async(signal:AbortSignal)=>{
      await actualState()
      if(background)return existing.backgroundTarget(signal)
      const current=await state(),currentWindow=current.windows.find(w=>w.id===win.id)!
      const url=currentWindow.address
      if(!url || !knownURL(url) || url!==page.url() || !await page.evaluate(()=>document.hasFocus()))throw Error('Cannot verify the foreground test page.')
      return {app:'chrome' as const,pid:current.pid,window:win.id,tab:tab.id,url,focused:current.focused && currentWindow.focused}
    }
    const start=(instruction:string)=>{
      objective=instruction
      const tools=manager.forTurn({owner,objective,handsFreeSearch:()=>preference,check:async s=>{s.throwIfAborted();await actualState()},browserTarget,
        confirm:async(t,d)=>{dialogs.push(t);return !preference && !background && dialogs.length===1 && t==='Allow routine control of this browser tab?' && d.includes(origin)},
        registry:{definitions:[{name:'athena_browser_action',description:'Browser actions',parameters:{}}],assertAccess:async()=>{},
          execute:async(_tool,input,signal)=>JSON.stringify(await existing.run(voiceBrowserActionSchema.parse(input),signal,objective))}})
      const calls=new NativeComputerCalls(tools),turn='turn-'+ ++turnNo
      calls.accept('fixture-voice-thread',turn)
      return {run:async(args:Record<string,string>,success=true)=>{
        const reply=await calls.dispatch({threadId:'fixture-voice-thread',turnId:turn,callId:String(++call),namespace:null,tool:'athena_browser_action',arguments:args})
        expect(reply.success,JSON.stringify({action:args.action,background,helper:lastNative,searches:requests.length,dialogs:dialogs.length,result:reply.contentItems})).toBe(success)
        await actualState()
        return reply
      },end:async()=>{calls.stop();await tools.dispose?.()}}
    }
    const expectedDialogs=standing?[]:['Allow routine control of this browser tab?']
    if(focus!=='background'){
      const query='relaxing piano music',turn=start(focus==='suggestion'?'Okay, got it now. Um, search '+query+'.':'Search '+query)
      try{
        await turn.run({action:'inspect'})
        await turn.run({action:'type',label:'Search',text:query})
        expect(await page.getByRole('combobox',{name:'Search'}).inputValue()).toBe(query)
        expect(await page.evaluate(()=>sessionStorage.getItem('input'))).toBe(query)
        await actualState()
        const newFocus=page.locator('#'+focus)
        await newFocus.focus()
        await expect(newFocus).toBeFocused()
        if(focus==='unrelated'){
          const focusEvidence=async()=>{
            const dom=await newFocus.evaluate(field=>({documentFocused:document.hasFocus(),activeField:document.activeElement===field}))
            const native=await nativePage('chrome',{action:'inspect'})
            const matches=native.elements?.filter(e=>e.role==='AXTextField' && e.label==='Unrelated notes')??[]
            return {...dom,nativeFieldFound:matches.length===1,nativeFieldFocused:matches.length===1 && matches[0].focused===true}
          }
          console.info(JSON.stringify({test:'unrelated-field-focus',stage:'after-dom-focus',...await focusEvidence()}))
          await actualState()
          await newFocus.click()
          await expect.poll(focusEvidence,{message:'The disposable notes field must have both keyboard and Accessibility focus before testing the conflict.'}).toEqual({
            documentFocused:true,activeField:true,nativeFieldFound:true,nativeFieldFocused:true
          })
          console.info(JSON.stringify({test:'unrelated-field-focus',stage:'after-user-click',nativeFieldFocused:true,documentFocused:true,activeField:true}))
        }
        const response=await turn.run({action:'submit-search',label:'Search',text:query},focus==='suggestion')
        const counts=await page.evaluate(()=>Object.fromEntries(['buttonPress','searchEnter','otherEnter','unrelatedEdits'].map(key=>[key,Number(sessionStorage.getItem(key))])))
        expect(counts).toMatchObject({otherEnter:0,unrelatedEdits:0,searchEnter:0,buttonPress:focus==='suggestion'?1:0})
        expect(await page.getByRole('textbox',{name:'Unrelated notes'}).inputValue()).toBe('untouched')
        if(focus==='suggestion'){
          await expect(page.getByRole('heading',{name:'Fixture '+query})).toBeVisible()
          expect(new URL(page.url()).searchParams.get('q')).toBe(query)
          expect(requests).toEqual([query])
          await turn.run({action:'inspect'})
        }else{
          expect(JSON.stringify(response.contentItems)).toMatch(/focus|editable/i)
          await expect(newFocus).toBeFocused()
          expect(requests).toEqual([])
          expect(page.url()).toBe(origin+path)
        }
        expect(dialogs).toEqual([])
        console.info(JSON.stringify({test:'foreground-native-voice-search',focus,verifiedSearches:requests.length,consents:dialogs.length,...counts}))
      }finally{await turn.end()}
      return
    }
    const observe=start(standing?'Search for relaxing piano music':'Inspect the current Chrome tab')
    try{await observe.run({action:'inspect'})}finally{await observe.end()}
    expect(dialogs).toEqual(expectedDialogs)
    // Explicit foreground handoff to the isolated Athena instance only.
    await actualState()
    await testApp.evaluate(({app,BrowserWindow})=>{
      const window=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('surface=control'))
      if(!window)throw Error('Isolated control window is missing.')
      app.focus({steal:true});window.show();window.focus()
    })
    background=true
    await expect.poll(async()=>(await state()).foreground).toBe(frontPid)
    let focusEvents=0
    await ctx.exposeBinding('fixtureRegainedFocus',()=>{focusEvents++})
    const listen=()=>window.addEventListener('focus',()=>void (window as unknown as {fixtureRegainedFocus():Promise<void>}).fixtureRegainedFocus())
    await page.evaluate(listen)
    await ctx.addInitScript(listen)
    for(const query of ['relaxing piano music','instrumental jazz']){
      const turn=start('Search for '+query)
      try{
        await turn.run({action:'inspect'})
        if(standing){
          await turn.run({action:'type',label:'Search',text:'different words'},false)
          await turn.run({action:'click',label:'Send message'},false)
        }
        await turn.run({action:'type',label:'Search',text:query})
        expect(await page.getByRole('combobox',{name:'Search'}).inputValue()).toBe(query)
        expect(await page.evaluate(()=>sessionStorage.getItem('input'))).toBe(query)
        await turn.run({action:'submit-search',label:'Search',text:query})
        await expect(page.getByRole('heading',{name:'Fixture '+query})).toBeVisible()
        expect(new URL(page.url()).searchParams.get('q')).toBe(query)
        await turn.run({action:'inspect'})
      }finally{await turn.end()}
    }
    expect(focusEvents,'Chrome received window focus during a background action').toBe(0)
    expect(requests).toEqual(['relaxing piano music','instrumental jazz'])
    expect(dialogs).toEqual(expectedDialogs)
    await actualState()
    manager.forget(owner);existing.forgetBackground(owner)
    expect(await existing.backgroundTarget(new AbortController().signal)).toBeUndefined()
    console.info(JSON.stringify({test:'scoped-background-search',transport,standing,searches:requests.length,consents:dialogs.length,foregroundMaintained:true,actualInputEvents:true}))
  }finally{
    manager.forget(owner);service?.dispose()
    await Promise.allSettled([chrome?.close(),app?.close()])
    if(child && child.exitCode===null && child.signalCode===null)child.kill('SIGTERM')
    await rm(profile,{recursive:true,force:true,maxRetries:5,retryDelay:150})
  }
})
