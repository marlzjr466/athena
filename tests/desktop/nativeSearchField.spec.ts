import {chromium,_electron as electron,expect,test} from '@playwright/test'
import {execFile} from 'node:child_process'
import {createServer} from 'node:http'
import {randomUUID} from 'node:crypto'
import {mkdir,mkdtemp,realpath,rm,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {dirname,join,resolve} from 'node:path'
import {promisify} from 'node:util'
import {workspaceStateSchema} from '../../electron/main/desktop/desktopContext'

test.use({trace:'off'})
test('signed native browser search types into a same-name combobox, paints its target, and submits the real input state',async()=>{
  test.skip(process.platform!=='darwin'||process.env.ATHENA_NATIVE_SEARCH_E2E!=='1','Opt-in signed macOS Accessibility test')
  test.setTimeout(120000)
  const binary=process.env.ATHENA_VOICE_TEST_BINARY??resolve('release/mac-arm64/Athena.app/Contents/MacOS/Athena')
  const helper=resolve(dirname(binary),'../Resources/native/athena-desktop-accessibility')
  const exec=promisify(execFile)
  await exec('/usr/bin/codesign',['--verify','--strict','--deep',resolve(dirname(binary),'../..')])
  const directory=await mkdtemp(join(tmpdir(),'athena-native-search-')),profile=join(directory,'athena')
  const label='Search',query='relaxing piano music',objective='Search this page for '+query
  const initialURL='https://example.com/athena-search-'+randomUUID(),title='Athena fixture '+randomUUID().slice(0,8)
  const resultsURL=new URL(initialURL+'/results')
  resultsURL.searchParams.set('q',query)
  // Script only the proposed tool arguments. Every inspect, keystroke and receipt
  // follows the signed app's ordinary browser executor, permission gates and AX helper.
  const steps=[{action:'inspect'},{action:'type',label,text:query},{action:'submit-search',label,text:query}]
  let decisions=0
  const model='qwen2.5-coder:3b'
  const planner=createServer(async(req,res)=>{
    res.setHeader('Content-Type','application/json')
    if(req.url==='/api/tags'){res.end(JSON.stringify({models:[{name:model,size:1}]}));return}
    if(req.url==='/api/show'){res.end(JSON.stringify({capabilities:['completion','tools'],model_info:{'general.architecture':'qwen2','qwen2.context_length':32768}}));return}
    if(req.url==='/api/ps'){res.end('{"models":[]}');return}
    if(req.url!=='/api/chat'){res.writeHead(404);res.end();return}
    let raw=''
    for await(const chunk of req){raw+=chunk;if(raw.length>300000){res.writeHead(413);res.end();return}}
    const payload=JSON.parse(raw) as {model:string;messages:{role:string;content:string}[]}
    const content=payload.messages?.findLast(m=>m.role==='user')?.content??''
    if(payload.model!==model || !content.includes(objective) || !content.includes('registeredTools') || !content.includes('athena_browser_action') || decisions>steps.length){
      res.writeHead(422);res.end('Unexpected planning request');return
    }
    const step=steps[decisions++]
    const decision=step?{decision:'act',tool:'athena_browser_action',arguments:JSON.stringify(step),message:''}:{decision:'complete',tool:'',arguments:'{}',message:''}
    res.end(JSON.stringify({model,message:{role:'assistant',content:JSON.stringify(decision)},done:true,done_reason:'stop'})+'\n')
  })
  let application:Awaited<ReturnType<typeof electron.launch>>|undefined
  let browser:Awaited<ReturnType<typeof chromium.launchPersistentContext>>|undefined
  try{
    await new Promise<void>((done,fail)=>{planner.once('error',fail);planner.listen(0,'127.0.0.1',done)})
    const address=planner.address()
    if(!address || typeof address==='string')throw Error('No local scripted planner')
    await mkdir(profile)
    await writeFile(join(profile,'settings.json'),JSON.stringify({aiMode:'local',voiceEnabled:false,floatingEnabled:false,randomMovement:false,randomActions:false,
      computerUse:{enabled:true,planner:'local',browserDebugPort:0,visibleCursor:true,highlightTargets:true,animationSpeed:1},
      applicationAutomation:{engine:'native',monthlyRequests:0,maxSteps:5},automationPermissions:{browserAccess:true,browserInteraction:true,desktopApplicationControl:true,desktopUIInteraction:true},
      webAccess:{webSearchEnabled:true,automaticSearch:false,automaticStartup:false},localAI:{model,endpoint:'http://127.0.0.1:'+address.port,contextLength:16384}}))
    const app=application=await electron.launch({executablePath:binary,args:['--mute-audio','--user-data-dir='+profile],env:{...process.env,ATHENA_TEST_DATA:profile}})
    expect(await realpath(await app.evaluate(({app})=>app.getPath('userData')))).toBe(await realpath(profile))
    await expect.poll(()=>app.windows().some(p=>p.url().includes('surface=control'))).toBe(true)
    await expect.poll(()=>app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().some(w=>w.webContents.getURL().includes('splash.html'))),{timeout:25000}).toBe(false)
    const control=app.windows().find(p=>p.url().includes('surface=control'))!
    await control.evaluate(async()=>{
      const api=window.athena!
      for(const permission of ['applicationDetection','accessibilityControl','desktopAutomation'] as const){
        await api.setPermissionEnabled({permission,enabled:true})
        if(!await api.isCapabilityAllowed({permission}))throw Error('The signed executor lacks '+permission)
      }
    })
    const chrome=browser=await chromium.launchPersistentContext(join(directory,'chrome'),{channel:'chrome',headless:false,viewport:null,serviceWorkers:'block',args:['--force-renderer-accessibility']})
    let resultRequests=0
    // Serve only these two documents in this new profile. No fixture traffic leaves Chrome.
    await chrome.route('**/*',route=>{
      if(route.request().method()!=='GET')return route.abort()
      if(route.request().url()===resultsURL.href){resultRequests++;return route.fulfill({contentType:'text/html',body:'<title>'+title+'</title><main><h1>Search results</h1><p>Result for '+query+'</p></main>'})}
      if(route.request().url()!==initialURL)return route.abort()
      return route.fulfill({contentType:'text/html',body:`<title>${title}</title>
        <form role="search" style="margin:60px"><input aria-label="Search" type="search" role="combobox" aria-autocomplete="list" aria-controls="suggestions" aria-expanded="false" style="width:320px;height:48px">
        <ul id="suggestions" role="listbox" hidden><li id="suggestion" role="option" tabindex="-1">Suggested result</li></ul>
        <button type="submit" aria-label="Search" style="width:82px">Search</button></form>
        <label>Unrelated notes <input id="unrelated" value="untouched"></label>
        <script>const field=document.querySelector('input[type=search]'),button=document.querySelector('button'),unrelated=document.querySelector('#unrelated');
        let modelValue='',firstInput=0,lastInput=0,enter=0,pressed=0,buttonClicks=0,unrelatedEdits=0,otherEnter=0;
        unrelated.addEventListener('input',()=>unrelatedEdits++);
        document.addEventListener('keydown',e=>{if(e.key==='Enter' && e.target!==field)otherEnter++},true);
        button.addEventListener('click',e=>{if(e.isTrusted){pressed=Date.now();buttonClicks++}});
        field.addEventListener('input',()=>{firstInput ||= Date.now();lastInput=Date.now();modelValue=field.value;document.querySelector('#suggestions').hidden=false;field.setAttribute('aria-expanded','true')});
        field.addEventListener('keydown',e=>{if(e.key==='Enter')enter=Date.now()});
        window.fixtureSearchState=()=>({firstInput,lastInput,enter,pressed,buttonClicks,unrelatedEdits,unrelatedValue:unrelated.value,otherEnter,modelValue,fieldValue:field.value});
        document.querySelector('form').onsubmit=e=>{e.preventDefault();
          sessionStorage.setItem('events',JSON.stringify(window.fixtureSearchState()));
          if((enter||pressed) && modelValue)location.assign(location.pathname+'/results?'+new URLSearchParams({q:modelValue}));
        };</script>`})
    })
    const page=chrome.pages()[0]
    await page.goto(initialURL)
    await expect(page.getByRole('combobox',{name:label,exact:true})).toBeVisible()
    await expect(page.getByRole('button',{name:label,exact:true})).toBeVisible()
    const cdp=await chrome.browser()!.newBrowserCDPSession()
    const pid=(await cdp.send('SystemInfo.getProcessInfo')).processInfo.find(p=>p.type==='browser')?.id
    await cdp.detach()
    if(!pid)throw Error('Missing disposable Chrome PID')
    const workspace=async(operation:'observe'|'activate')=>JSON.parse((await exec(helper,['com.google.Chrome','workspace',JSON.stringify({operation,pid,details:true,tabs:true})])).stdout)
    expect((await workspace('activate')).ok).toBe(true)
    const target=async(expected:string)=>{
      const state=workspaceStateSchema.parse(await workspace('observe')),win=state.windows[0],tabs=win?.tabs
      if(state.pid!==pid || state.foreground!==pid || !state.focused || state.windows.length!==1 || !win.focused || win.hidden || win.minimized || tabs?.length!==1 || !tabs[0].selected || !tabs[0].id || tabs[0].title!==title)return
      // The address is optional in macOS AX. The sole CDP page is independently bound to this process and native tab.
      if(chrome.pages().length!==1 || page.url()!==expected || await page.title()!==title)return
      if(win.address && win.address!==expected && 'https://'+win.address!==expected)return
      if(!await page.evaluate(()=>document.hasFocus() && document.visibilityState==='visible'))return
      return {window:win.id,tab:tabs[0].id}
    }
    await expect.poll(()=>target(initialURL)).toBeTruthy()
    const pinned=await target(initialURL)
    if(!pinned)throw Error('The disposable search tab lost focus')
    const prompts=['Allow set-text on “Search” at example.com?','Submit the search “'+query+'” using “Search” at example.com?']
    const approved:string[]=[]
    await control.exposeFunction('approveSearchFixture',async(title:string,message:string)=>{
      const scope=await target(initialURL)
      if(scope?.window!==pinned.window || scope.tab!==pinned.tab || title!=='Allow browser interaction?' || message!==prompts[approved.length])return false
      if(approved.length===1 && await page.getByRole('combobox',{name:label}).inputValue()!==query)return false
      approved.push(message)
      return true
    })
    type Sample={time:number;target:string;width:number}
    const samples:Sample[]=[]
    await control.exposeFunction('searchPaint',(s:Sample)=>{samples.push(s)})
    await app.evaluate(({app,BrowserWindow,dialog})=>{
      const web=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('surface=control'))!.webContents
      dialog.showMessageBox=async(first:Electron.BaseWindow|Electron.MessageBoxOptions,second?:Electron.MessageBoxOptions)=>{
        const {title,message}=second??first as Electron.MessageBoxOptions
        const allowed=await web.executeJavaScript('window.approveSearchFixture('+JSON.stringify(title)+','+JSON.stringify(message)+')').catch(()=>false)
        return {response:allowed===true?1:0,checkboxChecked:false}
      }
      const timer=setInterval(async()=>{
        const win=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('interactionOverlay.html'))
        if(!win?.isVisible() || win.isFocusable())return
        const sample=await win.webContents.executeJavaScript('(()=>{const f=document.querySelector("#frame"),p=document.querySelector("#pointer");return f?.checkVisibility() && p?.checkVisibility() && p.querySelector("span")?.textContent==="Athena"?{time:Date.now(),width:f.getBoundingClientRect().width,target:p.dataset.target}:null})()').catch(()=>undefined)
        if(sample)await web.executeJavaScript('window.searchPaint('+JSON.stringify(sample)+')').catch(()=>{})
      },20)
      app.once('will-quit',()=>clearInterval(timer))
    })
    const reply=await control.evaluate(async(text)=>window.athena!.sendAthenaChat({sessionId:(await window.athena!.getAthenaChat()).sessionId,text}),objective)
    expect(reply.ok,reply.message).toBe(true)
    await expect.poll(async()=>{
      const last=await control.evaluate(()=>window.athena!.getAthenaChat().then(chat=>chat.messages.at(-1)))
      if(last?.status==='error')throw Error(last.error??'Local automation failed')
      return last?.role==='assistant' && ['complete','error'].includes(last.status)
    },{timeout:55000}).toBe(true)
    expect(decisions,'All scripted steps were routed through production native planning').toBe(4)
    expect(approved).toEqual(prompts)
    await expect(page).toHaveURL(resultsURL.href)
    await expect(page.getByText('Result for '+query,{exact:true})).toBeVisible()
    expect(resultRequests).toBe(1)
    expect(await target(resultsURL.href)).toEqual(pinned)
    const events=await page.evaluate(()=>JSON.parse(sessionStorage.getItem('events')??'null')) as {firstInput:number;lastInput:number;enter:number;pressed:number;buttonClicks:number;unrelatedEdits:number;unrelatedValue:string;otherEnter:number;modelValue:string;fieldValue:string}
    expect(events).toMatchObject({modelValue:query,fieldValue:query,unrelatedEdits:0,unrelatedValue:'untouched',otherEnter:0})
    expect(events.firstInput).toBeGreaterThan(0)
    const submittedAt=events.enter||events.pressed
    expect(submittedAt).toBeGreaterThanOrEqual(events.lastInput)
    const dwell=(moment:number,after:number,width:number)=>{
      const before=samples.filter(s=>s.time>=after && s.time<=moment && Math.abs(s.width-width)<12)
      const target=before.at(-1)?.target
      expect(target,'Visible non-focusable Athena pointer and outline over the actual input target').toBeTruthy()
      const painted=before.filter(s=>s.target===target)
      expect(painted.length).toBeGreaterThan(2)
      const duration=painted.at(-1)!.time-painted[0].time
      expect(duration,'The resolved target must remain visibly highlighted before input').toBeGreaterThanOrEqual(350)
      return {duration,target}
    }
    const typed=dwell(events.firstInput,0,320),submitted=dwell(submittedAt,events.lastInput,events.enter?320:82)
    expect(submitted.target).not.toBe(typed.target)
    const status=await control.evaluate(()=>window.athena!.computerUseCheck('activity'))
    expect(status.automation?.requests).toBe(0)
    console.info(JSON.stringify({test:'signed-native-search',submission:events.enter?'field-enter':'search-button',unrelatedEdits:events.unrelatedEdits,otherEnter:events.otherEnter,typeDwellMs:typed.duration,submitDwellMs:submitted.duration,verifiedInput:true,resultNavigations:resultRequests,planner:'scripted loopback'}))
  }finally{
    await Promise.allSettled([application?.close(),browser?.close()])
    planner.closeAllConnections()
    if(planner.listening)await new Promise<void>(done=>planner.close(()=>done()))
    await rm(directory,{recursive:true,force:true})
  }
})
