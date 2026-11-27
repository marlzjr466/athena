import {test,expect,chromium} from '@playwright/test'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {resolve,join} from 'node:path'
import {mkdtemp,rm,readFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {ExistingBrowser} from '../../electron/main/desktop/existingBrowser'
import {DesktopContext,chooseWindow,windowRequest,type WorkspaceRequest, type WorkspaceState} from '../../electron/main/desktop/desktopContext'

const exec=promisify(execFile)
const signal=()=>new AbortController().signal
test('macOS focuses and restores the same real Chrome window and verifies its selected tab',async()=>{
  test.skip(process.platform!=='darwin' || process.env.ATHENA_WINDOW_LIVE!=='1','Requires an interactive authorized Mac')
  test.setTimeout(90000)
  const profile=await mkdtemp(join(tmpdir(),'athena-window-fixture-'))
  const context=await chromium.launchPersistentContext(profile,{channel:'chrome',headless:false,viewport:null,args:['--remote-debugging-address=127.0.0.1','--remote-debugging-port=0']})
  const browser=context.browser()!
  const cdp=await browser.newBrowserCDPSession()
  const pid=(await cdp.send('SystemInfo.getProcessInfo')).processInfo.find(p=>p.type==='browser')!.id
  const helper=process.env.ATHENA_WINDOW_HELPER??resolve('build/native/athena-desktop-accessibility')
  const timings:Record<string,number>={}
  const call=async(request:WorkspaceRequest)=>{
    const start=performance.now()
    const {stdout}=await exec(helper,['com.google.Chrome','workspace',JSON.stringify({...request,pid,details:true})],{timeout:10000})
    const result=JSON.parse(stdout)
    if(result.error)throw new Error(result.error)
    timings[request.operation]=Math.round(performance.now()-start)
    return result
  }
  const observe=async():Promise<WorkspaceState>=>call({operation:'observe',tabs:true})
  try{
    const page=context.pages()[0]??await context.newPage()
    await page.goto('about:blank')
    let state=await observe(),win=chooseWindow(state)!
    await call({operation:'activate',...windowRequest(state,win)})
    state=await observe();expect(state.focused).toBe(true)
    const original=chooseWindow(state)!
    const {targetId}=await cdp.send('Target.createTarget',{url:'about:blank',newWindow:true})
    const {windowId}=await cdp.send('Browser.getWindowForTarget',{targetId})
    await expect.poll(async()=>(await observe()).windows.length).toBe(2)
    state=await observe();win=chooseWindow(state)!
    const firstCount=win.tabs!.length
    await call({operation:'new-tab',...windowRequest(state,win)})
    state=await observe();expect(state.windows).toHaveLength(2);expect(chooseWindow(state)).toMatchObject({id:win.id})
    expect(chooseWindow(state)!.tabs!.length).toBe(firstCount+1)
    await cdp.send('Browser.setWindowBounds',{windowId,bounds:{windowState:'minimized'}})
    await expect.poll(async()=>(await observe()).windows.filter(w=>w.minimized).length).toBe(1)
    state=await observe();const minimized=state.windows.find(w=>w.minimized)!
    await call({operation:'activate',...windowRequest(state,minimized)})
    state=await observe();expect(chooseWindow(state)).toMatchObject({id:minimized.id,minimized:false})
    const stale=windowRequest(state,chooseWindow(state))
    await page.bringToFront()
    await expect.poll(async()=>chooseWindow(await observe())?.id).toBe(original.id)
    // A stale foreground request to a different window must not send a shortcut there.
    const visible=chooseWindow(await observe())!
    expect(visible.id).not.toBe(stale.window)
    const n=state.windows.map(w=>w.tabs?.length)
    await expect(call({operation:'new-tab',...stale})).rejects.toThrow(/changed/i)
    expect((await observe()).windows.map(w=>w.tabs?.length).sort()).toEqual(n.sort())
    const port=Number((await readFile(join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0])
    let debugPort=port
    const service=new ExistingBrowser({
      context:new DesktopContext((_id,r)=>call(r),async()=>[{app:'com.google.Chrome',active:true}]),
      launch:async()=>{throw new Error('Unexpected browser launch')},allowed:()=>true,defaultBrowser:()=>'chrome',settings:()=>({reuseBrowserWindows:true,pauseOnConflict:true,browserDebugPort:debugPort}),
      onOtherDisplay:()=>false,confirm:async()=>true,publicURL:async url=>['example.com','www.example.com'].includes(new URL(url).hostname),
      nativePage:async(_app,r)=>{
        expect(debugPort).toBe(0)
        const value=JSON.parse((await exec(helper,['com.google.Chrome','web-'+r.action,r.label??'',r.text??'',r.token??''])).stdout)
        if(value.error)throw new Error(value.error)
        return {...value,ok:value.verified}
      },
    })
    try{
      await context.route('https://example.com/athena-window-test',route=>route.fulfill({contentType:'text/html',body:'<title>Window fixture</title><button onclick="this.textContent=&#39;Verified&#39;">Run fixture</button>'}))
      const countBefore=(await observe()).windows.map(w=>w.tabs?.length).sort()
      const currentPage=page.waitForURL('https://example.com/athena-window-test',{timeout:5000}).catch(()=>{})
      const navigation=await service.run({action:'window',operation:'navigate',browser:'chrome',url:'https://example.com/athena-window-test'},signal(),'use the current Chrome tab')
      expect(navigation?.ok).toBe(true)
      await currentPage
      expect(page.url()).toBe('https://example.com/athena-window-test')
      expect((await observe()).windows.map(w=>w.tabs?.length).sort()).toEqual(countBefore)
      // A full document URL must verify even when Chrome elides https/www in
      // its address bar. This is a native navigation check, not a CDP action.
      await context.route('https://www.example.com/athena-window-test',route=>route.fulfill({contentType:'text/html',body:'<title>Elided address fixture</title><button>Run fixture</button>'}))
      expect((await service.run({action:'window',operation:'navigate',browser:'chrome',url:'https://www.example.com/athena-window-test'},signal(),'navigate in the current Chrome tab'))?.ok).toBe(true)
      expect((await observe()).windows.map(w=>w.tabs?.length).sort()).toEqual(countBefore)
      expect((await service.run({action:'window',operation:'navigate',browser:'chrome',url:'https://example.com/athena-window-test'},signal(),'return to the fixture in the current Chrome tab'))?.ok).toBe(true)
      await page.getByRole('button',{name:'Run fixture'}).focus()
      expect((await service.run({action:'inspect'},signal(),'inspect this page'))?.ok).toBe(true)
      expect((await service.run({action:'click',label:'Run fixture'},signal(),'click “Run fixture”'))?.ok).toBe(true)
      await expect(page.getByRole('button',{name:'Verified'})).toBeVisible()
      debugPort=0
      service.reconcile(true)
      await page.reload()
      const accessible=await service.run({action:'inspect'},signal(),'inspect this page')
      expect(accessible?.data).toMatchObject({controls:expect.arrayContaining([expect.objectContaining({label:'Run fixture',role:'AXButton'})])})
      expect((await service.run({action:'click-observed'},signal(),'click that button'))?.ok).toBe(true)
      await expect(page.getByRole('button',{name:'Verified'})).toBeVisible()
    }finally{service.dispose()}
    expect(await page.title()).toBe('Window fixture')
    const staleApp=await observe()
    const finder=async (request:WorkspaceRequest)=>JSON.parse((await exec(helper,['com.apple.finder','workspace',JSON.stringify({...request,details:false})])).stdout)
    const background=await finder({operation:'observe'})
    expect(background.running).toBe(true)
    expect((await finder({operation:'activate',pid:background.pid,foreground:background.foreground})).ok).toBe(true)
    const front=await finder({operation:'observe'})
    expect(front.focused).toBe(true)
    expect((await finder({operation:'activate',pid:front.pid,foreground:front.foreground})).message).toContain('already')
    await expect(call({operation:'new-tab',...windowRequest(staleApp,chooseWindow(staleApp))})).rejects.toThrow(/changed/i)
    expect((await observe()).windows.map(w=>w.tabs?.length).sort()).toEqual(staleApp.windows.map(w=>w.tabs?.length).sort())
    console.info('Real Chrome window timings (ms)',timings)
  }finally{await cdp.detach().catch(()=>{});await context.close();await rm(profile,{recursive:true,force:true})}
})
