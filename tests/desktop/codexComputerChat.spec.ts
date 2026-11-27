import {expect, test, chromium, _electron as electron, type Page} from '@playwright/test'
import {createServer} from 'node:http'
import {mkdtemp, readFile, realpath, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {dirname,join,resolve} from 'node:path'
import {execFile} from 'node:child_process'
import {randomUUID} from 'node:crypto'
import {promisify} from 'node:util'
import {workspaceStateSchema} from '../../electron/main/desktop/desktopContext'

async function attachChat(page:Page) {
  return page.evaluate(async()=>{
    const api=window.athena!, status=await api.getCodexCLIStatus({refresh:true})
    if(!status.authenticated || !status.models.some(m=>m.id==='gpt-6.2-sol'))throw Error(status.message)
    await api.setPermissionEnabled({permission:'personalFiles',enabled:true})
    const id=(await api.getChat()).sessionId!
    for(const result of [await api.chatContext({action:'connect',sessionId:id}),await api.chatSession({action:'select-account-model',id,route:{provider:'subscription',accountId:'codex-local'},model:'gpt-6.2-sol'}),await api.chatSession({action:'configure-effort',id,effort:'low'}),await api.chatSession({action:'agent-mode',id,mode:'ask'})])if(!result.ok)throw Error(result.message)
    return id
  })
}

function chatSender(page:Page,session:string,timeout=80000) {
  return async(text:string,afterDispatch?:()=>Promise<void>)=>{
    const previous=await page.evaluate(()=>window.athena!.getChat().then(c=>c.messages.at(-1)?.id))
    const result=await page.evaluate(({session,text})=>window.athena!.sendChat({sessionId:session,text}),{session,text})
    expect(result.ok,result.message).toBe(true)
    await afterDispatch?.()
    await expect.poll(()=>page.evaluate(async previous=>{
      const m=(await window.athena!.getChat()).messages.at(-1)
      if(m?.role!=='assistant' || m.id===previous)return 'pending'
      if(m.status==='error')throw Error(m.error??'Native chat turn failed')
      return m.status
    },previous),{timeout}).toBe('complete')
    return page.evaluate(()=>window.athena!.getChat())
  }
}

test('signed Athena chat dispatches its computer tool and continues coding in the same native thread',async()=>{
  test.skip(process.env.ATHENA_CODEX_COMPUTER_CHAT_E2E!=='1','Requires the signed local application and ChatGPT subscription.')
  test.setTimeout(180000)
  const profile=await mkdtemp(join(tmpdir(),'athena-computer-chat-profile-'))
  const project=await realpath(await mkdtemp(join(tmpdir(),'athena-computer-chat-project-')))
  await writeFile(join(profile,'settings.json'),JSON.stringify({
    aiMode:'subscription',voiceEnabled:false,floatingEnabled:false,randomActions:false,randomMovement:false,
    webAccess:{webSearchEnabled:false,searxngAutoStart:false},computerUse:{enabled:true,voice:false,vision:false},
    applicationAutomation:{engine:'codex',model:'gpt-6.2-sol'},
  }))
  await writeFile(join(project,'AGENTS.md'),'Only change index.html in this disposable form project. Do not use the network, observe the desktop, alter browser tabs or touch other files.\n')
  const binary=process.env.ATHENA_VOICE_TEST_BINARY??resolve('release/mac-arm64/Athena.app/Contents/MacOS/Athena')
  const web=createServer(async(_req,res)=>{
    try { res.setHeader('Content-Type','text/html');res.end(await readFile(join(project,'index.html'))) }
    catch { res.writeHead(404);res.end() }
  })
  await new Promise<void>((resolve,reject)=>{web.once('error',reject);web.listen(0,'127.0.0.1',resolve)})
  const address=web.address()
  if(!address || typeof address==='string')throw Error('No local test HTTP listener')
  const preview='http://127.0.0.1:'+address.port+'/'
  let testApp: Awaited<ReturnType<typeof electron.launch>> | undefined
  let testBrowser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  try {
    const browser=testBrowser=await chromium.launch({channel:'chrome',headless:true})
    const formPage=await browser.newPage()
    const app=testApp=await electron.launch({executablePath:binary,args:['--mute-audio','--user-data-dir='+profile],env:{...process.env,ATHENA_TEST_DATA:profile},timeout:40000})
    expect(await realpath(await app.evaluate(({app})=>app.getPath('userData')))).toBe(await realpath(profile))
    await expect.poll(()=>app.windows().some(p=>p.url().includes('surface=control'))).toBe(true)
    const page=app.windows().find(p=>p.url().includes('surface=control'))!
    // Authorize only the newly created fixture via the real existing project-attachment path.
    await app.evaluate(({dialog},dir)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[dir]})},project)
    const session=await attachChat(page)
    const send=chatSender(page,session)
    const first=await send('Implement a minimal English HTML form in index.html with one input named email and one submit button. For this first integration step use input type text with no validation. Verify the saved source. Then call the registered athena_stop_automation tool once to end computer control for this turn. Do not touch other applications, open a browser, or access the network.')
    expect(first.nativeCodex?.computerToolsRegistered).toBe(true)
    expect(first.messages.at(-1)?.execution?.activities.some(a=>a.tool==='codex.dynamicToolCall' && a.label==='athena_stop_automation' && a.status==='complete')).toBe(true)
    expect(await readFile(join(project,'index.html'),'utf8')).toMatch(/<form\b/i)
    // Independent browser evidence for the before/after defect. Cursor/computer-control
    // acceptance still requires the production executor and a specifically shared window.
    await formPage.goto(preview)
    const email=formPage.locator('input[name=email]')
    await email.fill('malformed')
    expect(await email.evaluate(e=>(e as HTMLInputElement).validity.valid)).toBe(true)
    const second=await send('The test browser verified the email field accepts a malformed value. Add built-in HTML email and required validation, verify the form source and report what changed. Only modify index.html.')
    expect(second.nativeCodex?.threadId).toBe(first.nativeCodex?.threadId)
    expect(second.nativeCodex?.turnId).not.toBe(first.nativeCodex?.turnId)
    const form=await readFile(join(project,'index.html'),'utf8')
    expect(form).toMatch(/type\s*=\s*["']?email/i);expect(form).toMatch(/<input[^>]*\brequired\b/i)
    await formPage.reload()
    await email.fill('malformed')
    expect(await email.evaluate(e=>(e as HTMLInputElement).validity.typeMismatch)).toBe(true)
    await formPage.locator('button[type=submit],input[type=submit],button:not([type])').first().click()
    expect(await email.evaluate(e=>(e as HTMLInputElement).matches(':invalid'))).toBe(true)
    await email.fill('fixture@example.test')
    expect(await email.evaluate(e=>(e as HTMLInputElement).checkValidity())).toBe(true)
    console.info(JSON.stringify({test:'signed-native-chat',thread:second.nativeCodex?.threadId,turns:[first.nativeCodex?.turnId,second.nativeCodex?.turnId],tool:'athena_stop_automation',formCorrected:true,independentBrowserValidation:true}))
  } finally {
    await Promise.allSettled([testApp?.close(),testBrowser?.close()])
    web.closeAllConnections()
    await new Promise<void>(resolve=>web.close(()=>resolve()))
  }
})

type FixtureReceipt = {event:'invalid'|'submit';value:string;time:number}
type Paint = {time:number;action:string}

test('visible Codex chat submits and retests a form in its authorized Chrome tab',async()=>{
  test.skip(process.env.ATHENA_CODEX_VISIBLE_CHAT_E2E!=='1'||process.platform!=='darwin','Opt-in signed macOS subscription and native Accessibility test')
  test.setTimeout(420000)
  const directory=await mkdtemp(join(tmpdir(),'athena-visible-codex-'))
  const profile=join(directory,'athena'),project=await realpath(await mkdtemp(join(tmpdir(),'athena-visible-form-')))
  const marker='Athena form '+randomUUID().slice(0,8)
  const path='/form-'+randomUUID()
  const submitPath='/submit-'+randomUUID(),submissions:string[]=[]
  const field='Fixture email',button='Submit fixture',invalid='malformed',valid='fixture@example.test'
  const binary=process.env.ATHENA_VOICE_TEST_BINARY??resolve('release/mac-arm64/Athena.app/Contents/MacOS/Athena')
  const helper=resolve(dirname(binary),'../Resources/native/athena-desktop-accessibility')
  const exec=promisify(execFile)
  await exec('/usr/bin/codesign',['--verify','--deep','--strict',resolve(dirname(binary),'../..')])
  await writeFile(join(project,'AGENTS.md'),'Only edit index.html. Browser input is authorized only through Athena registered browser tools on the exact disposable loopback URL in the user message. Use only its labelled email control and submit button. All other applications, browser targets, shell-driven GUI actions, screenshot sharing and external network access are outside this test.\n')
  const server=createServer(async(req,res)=>{
    if(req.method==='POST' && req.url===submitPath){
      let value=''
      for await(const chunk of req){value+=chunk;if(value.length>100){res.writeHead(413);res.end();return}}
      if(![invalid,valid].includes(value)){res.writeHead(422);res.end();return}
      submissions.push(value);res.writeHead(204);res.end();return
    }
    if(req.method!=='GET' || req.url!==path){res.writeHead(404);res.end();return}
    try{
      const form=await readFile(join(project,'index.html'),'utf8')
      // Serve a static form only. The observer owns the operation receipts.
      if(/<(?:script|iframe|object|embed|meta\s[^>]*http-equiv)|\s(?:on\w+|formaction|target)\s*=/i.test(form))throw Error('Unsupported fixture HTML')
      res.writeHead(200,{'content-type':'text/html','cache-control':'no-store','content-security-policy':"default-src 'none'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; base-uri 'none'"})
      res.end(form)
    }catch{res.writeHead(409);res.end('Fixture unavailable')}
  })
  let chrome:Awaited<ReturnType<typeof chromium.launchPersistentContext>>|undefined
  let app:Awaited<ReturnType<typeof electron.launch>>|undefined
  try{
    await new Promise<void>((done,fail)=>{server.once('error',fail);server.listen(0,'127.0.0.1',done)})
    const address=server.address()
    if(!address || typeof address==='string')throw Error('Missing loopback listener')
    const origin='http://127.0.0.1:'+address.port,url=origin+path
    const application=app=await electron.launch({executablePath:binary,args:['--user-data-dir='+profile,'--mute-audio'],env:{...process.env,ATHENA_TEST_DATA:profile},timeout:40000})
    expect(await realpath(await application.evaluate(({app})=>app.getPath('userData')))).toBe(await realpath(profile))
    await expect.poll(()=>application.windows().some(p=>p.url().includes('surface=control'))).toBe(true)
    await expect.poll(()=>application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().some(w=>w.webContents.getURL().includes('splash.html'))),{timeout:25000}).toBe(false)
    const control=application.windows().find(p=>p.url().includes('surface=control'))!
    const paints:Paint[]=[],receipts:FixtureReceipt[]=[]
    // Send only numeric times, fixture labels and two synthetic values to the test process.
    await application.evaluate(({dialog},dir)=>{
      dialog.showOpenDialog=async(first:Electron.BaseWindow|Electron.OpenDialogOptions,second?:Electron.OpenDialogOptions)=>{
        const opts=second??first as Electron.OpenDialogOptions
        const approved=opts.title==='Authorize a project folder' && opts.properties?.includes('openDirectory')===true
        return {canceled:!approved,filePaths:approved?[dir]:[]}
      }
      dialog.showMessageBox=async()=>({response:0,checkboxChecked:false})
    },project)
    await control.evaluate(async()=>{
      const api=window.athena!,{settings}=await api.getSnapshot()
      await api.updateSettings({aiMode:'subscription',floatingEnabled:false,voiceEnabled:false,randomActions:false,randomMovement:false,
        computerUse:{...settings.computerUse,enabled:true,voice:false,vision:false,input:true,reuseBrowserWindows:true,browserDebugPort:0,visibleCursor:true,highlightTargets:true,clickRipple:true},
        webAccess:{...settings.webAccess,webSearchEnabled:true,automaticSearch:false,automaticStartup:false},
        automationPermissions:{...settings.automationPermissions,browserAccess:true,browserInteraction:true,desktopApplicationControl:true,desktopUIInteraction:true}})
      for(const permission of ['applicationDetection','desktopAutomation','accessibilityControl'] as const){
        await api.setPermissionEnabled({permission,enabled:true})
        if(!await api.isCapabilityAllowed({permission}))throw Error('Native fixture requires '+permission)
      }
    })
    const session=await attachChat(control),send=chatSender(control,session,100000)
    const first=await send('Implement index.html as a static HTML form with title "'+marker+'", one text input named email labelled "'+field+'", and one submit button labelled "'+button+'". For the first test use a plain text input without validation. No scripts, network, or browser work in this turn.')
    const thread=first.nativeCodex?.threadId
    expect(thread).toBeTruthy()
    expect(first.nativeCodex?.computerToolsRegistered).toBe(true)
    const setMode=async(mode:'read-only'|'ask')=>{
      const result=await control.evaluate(({id,mode})=>window.athena!.chatSession({action:'agent-mode',id,mode}),{id:session,mode})
      expect(result.ok,result.message).toBe(true)
    }

    const browser=chrome=await chromium.launchPersistentContext(join(directory,'chrome'),{channel:'chrome',headless:false,viewport:null,args:['--force-renderer-accessibility'],serviceWorkers:'block'})
    await browser.route('**/*',route=>{
      const request=route.request()
      const form=request.method()==='GET' && request.url()===url
      const submit=request.method()==='POST' && request.url()===origin+submitPath && [valid,invalid].includes(request.postData()??'')
      return form||submit?route.continue():route.abort()
    })
    const page=browser.pages()[0]
    await page.exposeBinding('athenaFormReceipt',({frame},receipt:FixtureReceipt)=>{
      if(frame===page.mainFrame() && frame.url()===url && ['invalid','submit'].includes(receipt.event) && [valid,invalid].includes(receipt.value))receipts.push(receipt)
    })
    await page.addInitScript(({url,submitPath})=>{
      if(location.href!==url)return
      for(const name of ['submit','invalid'] as const)document.addEventListener(name,async event=>{
        const time=Date.now()
        if(name==='submit')event.preventDefault()
        const value=document.querySelector<HTMLInputElement>('input[name=email]')?.value
        if(!value || name==='submit' && !(await fetch(submitPath,{method:'POST',body:value})).ok)return
        const result=name==='submit'?'Submitted '+value:'Rejected '+value
        let output=document.querySelector<HTMLElement>('#verified-outcome')
        if(!output){output=document.createElement('p');output.id='verified-outcome';document.body.append(output)}
        output.textContent=result
        void (window as unknown as {athenaFormReceipt(r:FixtureReceipt):Promise<void>}).athenaFormReceipt({event:name,value,time})
      },true)
    },{url,submitPath})
    await page.goto(url)
    await expect(page).toHaveTitle(marker)
    const cdp=await browser.browser()!.newBrowserCDPSession()
    const pid=(await cdp.send('SystemInfo.getProcessInfo')).processInfo.find(p=>p.type==='browser')?.id
    await cdp.detach()
    if(!pid)throw Error('Cannot pin the newly launched Chrome process')
    const workspace=async(operation:'observe'|'activate',only?:{window:string;tab:string;foreground:number})=>JSON.parse((await exec(helper,['com.google.Chrome','workspace',JSON.stringify({operation,pid,details:true,tabs:true,...only})])).stdout)
    const activation=await workspace('activate')
    expect(activation.ok,activation.message).toBe(true)
    const fixtureAppPid=application.process().pid
    let scopeState='Unknown',pinned:{window:string;tab:string}|undefined
    const target=async()=>{
      const state=workspaceStateSchema.parse(await workspace('observe')),win=state.windows[0],tabs=win?.tabs??[]
      const check=(ok:boolean,name:string)=>{if(!ok)scopeState=name;return ok}
      if(!check(state.pid===pid,'Different native Chrome PID') ||
          !check(state.foreground===pid,state.foreground===fixtureAppPid?'Disposable Athena is foreground':'Another process is foreground (PID '+state.foreground+')') ||
          !check(state.focused && state.windows.length===1 && !!win?.focused && !win.minimized && !win.hidden,'The pinned Chrome window is no longer foreground or unique') ||
          !check(tabs.length===1 && !!tabs[0].selected && !!tabs[0].id,'Missing unique selected AX tab') ||
          !check(pinned ? win.id===pinned.window && tabs[0].id===pinned.tab : tabs[0].title===marker,'The native fixture window or selected tab changed') ||
          !check(browser.pages().length===1 && page.url()===url && await page.title()===marker,'Disposable page URL or title changed'))return
      if(win.address && !check(win.address===url || 'http://'+win.address===url,'Reported AX address differs from fixture'))return
      if(!check(await page.evaluate(()=>document.hasFocus() && document.visibilityState==='visible'),'Fixture lost document focus'))return
      scopeState='Pinned'
      return {window:win.id,tab:tabs[0].id}
    }
    await expect.poll(target).toBeTruthy()
    pinned=await target()
    if(!pinned)throw Error('The disposable tab is no longer focused')
    const focusedTarget=async()=>{
      const existing=await target()
      if(existing)return existing
      const state=workspaceStateSchema.parse(await workspace('observe'))
      const win=state.windows[0],tab=win?.tabs?.find(t=>t.selected)
      if(state.pid!==pid || !fixtureAppPid || state.foreground!==fixtureAppPid || state.windows.length!==1 || win.id!==pinned.window || win.minimized || win.hidden ||
          win.tabs?.length!==1 || tab?.id!==pinned.tab || browser.pages().length!==1 || page.url()!==url || await page.title()!==marker)return
      const restored=await workspace('activate',{...pinned,foreground:fixtureAppPid})
      return restored.ok?target():undefined
    }
    let expectedValue=invalid
    const approved:string[]=[],denials:string[]=[]
    await control.exposeFunction('reviewFormFixture',async({title,message,detail}:{title:string;message:string;detail:string})=>{
      const current=await focusedTarget()
      if(current?.window!==pinned.window || current.tab!==pinned.tab){denials.push(scopeState==='Pinned'?'Native window or tab identifier changed':scopeState);return false}
      const share='Google Chrome selected window and tab'
      const firstLine=detail.split('\n')[0]
      let allow=title==='Open this local project preview?' && firstLine===url ||
        title==='Share this context with Codex?' && [share,share+' at '+origin].includes(firstLine)
      if(title==='Allow browser interaction?'){
        const input=page.getByRole('textbox',{name:field,exact:true})
        if(message==='Allow set-text on “'+field+'” at 127.0.0.1?')allow=await input.count()===1
        if(message==='Allow click on “'+button+'” at 127.0.0.1?')allow=await page.getByRole('button',{name:button,exact:true}).count()===1 && await input.inputValue()===expectedValue
      }
      if(allow)approved.push(title)
      else denials.push(['Open this local project preview?','Share this context with Codex?','Allow browser interaction?'].includes(title)?'Mismatched fixture details for '+title:'Unexpected dialog')
      return allow
    })
    await control.exposeFunction('paintedFixtureTarget',(sample:Paint)=>{paints.push(sample)})
    await application.evaluate(({app,BrowserWindow,dialog})=>{
      const web=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('surface=control'))!.webContents
      dialog.showMessageBox=async(first:Electron.BaseWindow|Electron.MessageBoxOptions,second?:Electron.MessageBoxOptions)=>{
        const {title,message,detail}=second??first as Electron.MessageBoxOptions
        const main=globalThis as unknown as {fixtureConsent?:string[]}
        const consent=main.fixtureConsent??=[]
        const allowed=await web.executeJavaScript('window.reviewFormFixture('+JSON.stringify({title,message,detail:detail??''})+')').catch(()=>{consent.push('Fixture reviewer was unavailable');return false})
        consent.push(allowed===true?'approved':'denied')
        return {response:allowed===true?1:0,checkboxChecked:false}
      }
      const timer=setInterval(async()=>{
        const win=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('interactionOverlay.html'))
        if(!win?.isVisible() || win.isFocusable())return
        const sample=await win.webContents.executeJavaScript('document.querySelector("#frame")?.checkVisibility() && document.querySelector("#pointer")?.checkVisibility() && document.querySelector("#pointer span")?.textContent==="Athena" ? {time:Date.now(),action:document.querySelector("#activity")?.textContent} : null').catch(()=>undefined)
        if(sample)await web.executeJavaScript('window.paintedFixtureTarget('+JSON.stringify(sample)+')').catch(()=>{})
      },40)
      app.once('will-quit',()=>clearInterval(timer))
    })

    const exercise=async(value:string,event:FixtureReceipt['event'])=>{
      await setMode('read-only')
      expectedValue=value
      expect(await focusedTarget(),'Exact fixture tab focus before request').toEqual(pinned)
      const count=receipts.length,sent=submissions.length,when=Date.now()
      const chat=await send('Open the reviewed local project preview '+url+' using athena_open_project_preview in the current Chrome tab. Use only athena_browser_action to inspect the page, type "'+value+'" into "'+field+'", inspect again, click "'+button+'" once, and read the resulting page status. Use the registered browser tools for every browser interaction. Leave the active tab selected.',async()=>{expect(await focusedTarget(),scopeState).toEqual(pinned)})
      expect(chat.nativeCodex?.threadId).toBe(thread)
      const activities=chat.messages.at(-1)?.execution?.activities??[]
      const review=await application.evaluate(()=>(globalThis as unknown as {fixtureConsent?:string[]}).fixtureConsent??[])
      const diagnostics=JSON.stringify({review,denials,activities:activities.filter(a=>a.tool==='codex.dynamicToolCall').map(a=>[a.label,a.status])})
      expect(activities.some(a=>a.label==='athena_open_project_preview'&&a.status==='complete'),diagnostics).toBe(true)
      expect(activities.filter(a=>a.label==='athena_browser_action'&&a.status==='complete').length,diagnostics).toBeGreaterThanOrEqual(5)
      expect(receipts.slice(count)).toEqual([{event,value,time:expect.any(Number)}])
      expect(submissions.slice(sent)).toEqual(event==='submit'?[value]:[])
      const receipt=receipts[count]
      await expect(page.locator('#verified-outcome')).toHaveText((event==='submit'?'Submitted ':'Rejected ')+value)
      expect(paints.some(p=>p.time>=when && p.time<=receipt.time && /click/i.test(p.action)),'Native target outline and Athena pointer before the form event').toBe(true)
      expect(await target()).toEqual(pinned)
      return chat.nativeCodex?.turnId
    }
    const before=await exercise(invalid,'submit')
    await setMode('ask')
    const fix=await send('The running form submitted the malformed string. Fix that defect by changing only the existing email field in index.html to required type=email. Preserve its name and both accessible labels. Verify the source. The browser will be retested separately.')
    expect(fix.nativeCodex?.threadId).toBe(thread)
    const afterInvalid=await exercise(invalid,'invalid')
    const afterValid=await exercise(valid,'submit')
    expect(new Set([first.nativeCodex?.turnId,before,fix.nativeCodex?.turnId,afterInvalid,afterValid]).size).toBe(5)
    expect(approved.filter(title=>title==='Allow browser interaction?')).toHaveLength(6)
    console.info(JSON.stringify({test:'visible-native-chat-form',thread,turns:[first.nativeCodex?.turnId,before,fix.nativeCodex?.turnId,afterInvalid,afterValid],receipts:receipts.map(r=>r.event),targetCursorBeforeSubmission:true}))
  }finally{
    await Promise.allSettled([app?.close(),chrome?.close()])
    server.closeAllConnections()
    if(server.listening)await new Promise<void>(done=>server.close(()=>done()))
    for(const ownTemp of [project,directory])await rm(ownTemp,{recursive:true,force:true})
  }
})

test('signed subscription chat uses native CUA in the existing Chrome window',async()=>{
  test.skip(process.env.ATHENA_CUA_CHAT_LIVE!=='1' || process.platform!=='darwin','Requires an authorized real Chrome window and the signed Mac app.')
  test.setTimeout(360000)
  const profile=await mkdtemp(join(tmpdir(),'athena-cua-chat-profile-'))
  const binary=process.env.ATHENA_VOICE_TEST_BINARY??resolve('release/mac-arm64/Athena.app/Contents/MacOS/Athena')
  const jxa=async(source:string,...args:string[])=>(await promisify(execFile)('/usr/bin/osascript',['-l','JavaScript','-e',source,...args],{timeout:6000})).stdout.trim()
  let app:Awaited<ReturnType<typeof electron.launch>>|undefined,ticket:{win:number;tab:number}|undefined
  try{
    await writeFile(join(profile,'settings.json'),JSON.stringify({aiMode:'subscription',floatingEnabled:false,randomMovement:false,voiceEnabled:false,
      computerUse:{enabled:true,input:true,handsFreeBrowserSearches:true},webAccess:{webSearchEnabled:true,automaticStartup:false},localAI:{automaticStartup:false},
      automationPermissions:{browserAccess:true,browserInteraction:true,desktopApplicationControl:true,desktopUIInteraction:true,screenObservation:true}}))
    app=await electron.launch({executablePath:binary,args:['--mute-audio','--user-data-dir='+profile],env:{...process.env,ATHENA_TEST_DATA:profile}})
    expect(await realpath(await app.evaluate(({app})=>app.getPath('userData')))).toBe(await realpath(profile))
    await expect.poll(()=>app!.windows().some(w=>w.url().includes('surface=control'))).toBe(true)
    await expect.poll(()=>app!.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().some(w=>w.webContents.getURL().includes('splash.html'))),{timeout:30000}).toBe(false)
    const page=app.windows().find(w=>w.url().includes('surface=control'))!
    const session=await page.evaluate(async()=>{
      const a=window.athena!,status=await a.getCodexCLIStatus({refresh:true})
      if(!status.authenticated)throw Error('Subscription is unavailable')
      for(const permission of ['applicationDetection','desktopAutomation','accessibilityControl'] as const){
        await a.setPermissionEnabled({permission,enabled:true})
        if(!await a.isCapabilityAllowed({permission}))throw Error(permission+' unavailable in the signed executor')
      }
      const id=(await a.getChat()).sessionId!
      for(const r of [await a.chatSession({action:'select-account-model',id,route:{provider:'subscription',accountId:'codex-local'},model:'gpt-6.2-sol'}),await a.chatSession({action:'configure-effort',id,effort:'low'})])if(!r.ok)throw Error(r.message)
      return id
    })
    await app.evaluate(({dialog})=>{
      const diagnostics:string[]=[]
      Object.assign(globalThis,{athenaCuaTestConsent:diagnostics})
      let granted=false
      dialog.showMessageBox=async(first:Electron.BaseWindow|Electron.MessageBoxOptions,second?:Electron.MessageBoxOptions)=>{
        const cfg=second??first as Electron.MessageBoxOptions
        const tabRequest=cfg.title==='Allow routine control of this browser tab?' || cfg.title==='Share this context with Codex?'
        const matching=cfg.detail?.includes('Google Chrome') && /https:\/\/(?:www\.)?youtube\.com(?:\n|\/| |$)/i.test(cfg.detail)
        const allow=!granted && tabRequest && matching && cfg.buttons?.[0]==='Deny'
        diagnostics.push((cfg.title??'untitled')+' · matched requested site '+!!matching+' · '+(allow?'accepted':'declined'))
        if(allow)granted=true
        console.info('CUA acceptance consent:',cfg.title,allow?'accepted':'declined')
        return {response:allow?1:0,checkboxChecked:false}
      }
    })
    // Use the user's existing browser. Only this newly allocated tab is touched or closed.
    ticket=JSON.parse(await jxa("const c=Application('Google Chrome');if(!c.running()||!c.windows.length)throw Error('Open Chrome');c.activate();const w=c.windows[0];w.tabs.push(c.Tab({url:'https://www.youtube.com/'}));w.activeTabIndex=w.tabs.length;JSON.stringify({win:w.id(),tab:w.activeTab.id()})"))
    const check=async()=>{
      const url=await jxa("function run(a){const c=Application('Google Chrome'),w=c.windows[0];if(String(w.id())!==a[0]||String(w.activeTab.id())!==a[1])throw Error('The authorized tab changed');return w.activeTab.url()}",String(ticket!.win),String(ticket!.tab))
      const address=new URL(url);expect(address.origin).toBe('https://www.youtube.com');return address
    }
    const send=chatSender(page,session,80000)
    let thread:string|undefined,firstVideo:string|undefined
    for(const [text,step] of [
      ['Use Chrome and search YouTube for relaxing piano music','search'],
      ['Play the first video result and verify that it is playing.','first'],
      ['Pause it and verify that playback is paused.','pause'],
      ['Resume playback and verify.','resume'],
      ['Go back to the search results.','back'],
      ['Play the second video result and verify that it is playing.','second'],
      ['Pause the video and verify.','pause'],
    ]){
      await check()
      console.info('Submitting signed CUA chat turn',step)
      const chat=await send(text)
      const turn=chat.messages.at(-1),activities=turn?.execution?.activities??[]
      const native=activities.filter(a=>a.tool==='codex.cua_repl.js' && a.status==='complete')
      const consent=await app.evaluate(()=>(globalThis as unknown as {athenaCuaTestConsent:string[]}).athenaCuaTestConsent)
      const url=await check()
      const pageKind=url.pathname.startsWith('/shorts/')?'shorts':url.pathname
      console.info('CUA acceptance',JSON.stringify({step,pageKind,consent,thread:chat.nativeCodex?.threadId,turn:chat.nativeCodex?.turnId,nativeCalls:native.length,tools:activities.map(a=>[a.tool,a.status]),routing:activities.filter(a=>a.tool.startsWith('codex.computer_use.')).map(a=>a.summary?.slice(0,140))}))
      expect(native.length).toBeGreaterThan(0)
      if(thread)expect(chat.nativeCodex?.threadId).toBe(thread)
      thread=chat.nativeCodex?.threadId;expect(thread).toBeTruthy()
      if(step==='search'||step==='back')expect([...url.searchParams.values()]).toContain('relaxing piano music')
      else{
        expect(url.pathname).toMatch(/^\/(?:watch|shorts\/)/)
        if(step==='first')firstVideo=url.href
        if(step==='second')expect(url.href).not.toBe(firstVideo)
        if(step==='pause'||step==='resume')expect(native.some(a=>a.label.includes(step==='pause'?'paused':'playing'))).toBe(true)
      }
    }
  }finally{
    if(ticket)await jxa("function run(a){const c=Application('Google Chrome');if(!c.running())return;const w=c.windows().find(win=>String(win.id())===a[0]);const t=w?.tabs().find(tab=>String(tab.id())===a[1]);if(t&&t.url().startsWith('https://www.youtube.com/'))t.close()}",String(ticket.win),String(ticket.tab)).catch(()=>{})
    await app?.close()
    await rm(profile,{recursive:true,force:true})
  }
})
