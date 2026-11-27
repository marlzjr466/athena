import { describe, expect, it, vi } from 'vitest'
import { browserSetupRequest,CodexComputerTools, type CodexBrowserTarget } from '../electron/main/desktop/codexComputerTools'
import type { ProjectTools } from '../electron/main/ai/AIProvider'
import { NativeComputerCalls } from '../electron/main/ai/codexComputerTools'
import { nativeActionResultSchema } from '../electron/main/ai/nativeActionRegistry'
import type { VisualDriver } from '../electron/main/ai/openAIAutomation'

const signal = new AbortController().signal
function setup(target?:Partial<CodexBrowserTarget>) {
  const manager = new CodexComputerTools()
  const registry = {
    definitions: ['athena_browser_action', 'athena_desktop_open_url', 'run_shell'].map(name => ({ name, description: name, parameters: {} })),
    assertAccess: vi.fn(), execute: vi.fn(async () => JSON.stringify({ ok: true, message: 'Observed playing state.', verified: true })),
  } satisfies ProjectTools
  let current: CodexBrowserTarget = { app: 'chrome', pid: 430, window: 'one', tab: 'piano', url: 'https://example.com', ...target }
  const confirm = vi.fn(async () => true)
  const driver: VisualDriver = {
    dispose: vi.fn(), capture: vi.fn(async () => 'data:image/png;base64,cGl4ZWxz'), approveChecks: vi.fn(),
    run: vi.fn(async () => ({ applied: false, evidence: 'Input was delivered but the page did not visibly change.' })),
  }
  const openProjectPreview = vi.fn(async () => ({ ok: true, verified: true, message: 'Selected the development preview.' }))
  const turn = (owner: string, objective = 'Play it') => manager.forTurn({
    owner, objective, registry, check: async active => active.throwIfAborted(), confirm,
    browserTarget: async () => current, openWindow: vi.fn(async () => driver), openProjectPreview,
  })
  return { turn, registry, manager, confirm, driver, openProjectPreview, switchTab: () => { current = { ...current, tab: 'another' } }, navigate: (url='https://different.test') => { current = { ...current, url } } }
}
describe('Codex computer-use tools', () => {
  it('checks the current tab under its existing grant without dispatching input or asking again', async () => {
    const { manager, registry, confirm } = setup()
    let target: CodexBrowserTarget = { app: 'chrome', pid: 1, window: 'w', tab: 't', url: 'https://example.org/watch', focused: false }
    let uncertain = false
    const authorizeBrowserObservation = vi.fn(async (_target: CodexBrowserTarget, _signal: AbortSignal) => {})
    const turn = manager.forTurn({
      owner: 'chat:current', chatSession: 'chat:current', objective: 'Play the first result.',
      registry, confirm, check: vi.fn(), browserTarget: async () => ({ ...target }),
      hasUnverifiedInput: () => uncertain, authorizeBrowserObservation,
    })
    const current = { action: 'window', operation: 'current', browser: 'chrome' }
    try {
      await turn.execute('athena_browser_action', { action: 'inspect' }, signal)
      uncertain = true
      const status = JSON.parse(await turn.execute('athena_browser_action', current, signal))
      expect(status).toMatchObject({ verified: true, app: 'chrome', selected: true, focused: false })
      expect(turn.verifiedActions()).toEqual([])
      expect(confirm).toHaveBeenCalledTimes(1)
      expect(registry.execute).toHaveBeenCalledTimes(1)
      await expect(turn.execute('athena_browser_action', { ...current, url: 'https://other.test' }, signal)).rejects.toThrow(/cannot navigate/)
      await expect(turn.execute('athena_browser_action', { action: 'window', operation: 'new-tab' }, signal)).rejects.toThrow(/unverified/)
      authorizeBrowserObservation.mockRejectedValueOnce(new Error('Application access revoked'))
      await expect(turn.execute('athena_browser_action', current, signal)).rejects.toThrow(/revoked/)
      target = { ...target, tab: 'unrelated' }
      await expect(turn.execute('athena_browser_action', current, signal)).rejects.toThrow(/tab changed/)
      expect(registry.execute).toHaveBeenCalledTimes(1)
    } finally { await turn.dispose?.() }
  })
  it('verifies a history destination only for the owner and selected tab that observed it', async()=>{
    const f=setup(), owner='voice:history', turn=f.turn(owner)
    await turn.execute('athena_browser_action',{action:'inspect'},signal)
    f.navigate('https://example.com/second')
    await turn.execute('athena_browser_action',{action:'inspect'},signal)
    const tab=f.manager.previousBrowser(owner)!
    expect(f.manager.historyDestination(owner,tab,'back')).toBe('https://example.com')
    expect(f.manager.historyDestination('chat:other',tab,'back')).toBeUndefined()
    expect(f.manager.historyDestination(owner,{...tab,tab:'another'},'back')).toBeUndefined()
    f.navigate()
    await turn.execute('athena_browser_action',{action:'inspect'},signal)
    expect(f.manager.historyDestination(owner,f.manager.previousBrowser(owner)!,'back')).toBeUndefined()
    f.manager.forget(owner)
    expect(f.manager.historyDestination(owner,tab,'back')).toBeUndefined()
  })
  it('recognizes exact browser setup without converting unrequested follow-up actions into navigation',()=>{
    expect(browserSetupRequest('Switch to my Chrome browser and open YouTube')).toMatchObject({browser:'chrome',destination:'https://www.youtube.com/',newTab:false})
    expect(browserSetupRequest('Switch to my Google Chrome browser')).toMatchObject({browser:'chrome',newTab:false})
    expect(browserSetupRequest('open YouTube in my current uh browser, Chrome browser')).toMatchObject({browser:'chrome',destination:'https://www.youtube.com/',tabQuery:'YouTube',newTab:false})
    expect(browserSetupRequest('Create a new tab in my Google Chrome')).toMatchObject({browser:'chrome',newTab:true})
    expect(browserSetupRequest('Open YouTube and delete the account')).toBeUndefined()
    expect(browserSetupRequest('Find a video about the mountains')).toEqual({query:'a video about the mountains',newTab:false})
    expect(browserSetupRequest('Do not open Google')).toBeUndefined()
    expect(browserSetupRequest('Open https://example.org/account/remove')).toBeUndefined()
    expect(browserSetupRequest('Open https://example.org/sign-in?token=example')).toBeUndefined()
  })
  it.each(['voice:setup','chat:setup:turn-1'])('limits standing setup and search approval to the requested browser, tab, destination and turn (%s)',async owner=>{
    const manager=new CodexComputerTools()
    let target:CodexBrowserTarget={app:'chrome',pid:1,window:'only',tab:'blank',url:undefined,focused:true}
    const confirm=vi.fn(async()=>false)
    const registry:ProjectTools={
      definitions:['athena_browser_action','athena_desktop_open_application'].map(name=>({name,description:name,parameters:{}})),
      assertAccess:vi.fn(),execute:vi.fn(async(_name,unknownInput)=>{
        const input=unknownInput as Record<string,string>
        if(input.operation==='navigate')target={...target,url:input.url}
        return JSON.stringify({ok:true,verified:true,message:'Verified selected control.',data:'Unknown tab titles never leave setup'})
      }),
    }
    const options={owner,objective:'Switch to my Chrome browser and open YouTube and search for piano',check:vi.fn(),registry,confirm,
      browserTarget:async()=>({...target}),handsFreeSearch:()=>true,listWindows:vi.fn(async()=>({running:true,focused:true,pid:1,foreground:1,
        windows:[{id:'only',focused:true,minimized:false,hidden:false,maximized:false,tabs:[{id:'blank',selected:true,title:'Private unrelated title'}]}]}))}
    const turn=manager.forTurn(options)
    const browser=(input:Record<string,string>)=>turn.execute('athena_browser_action',input,signal)
    try{
      await expect(turn.execute('athena_list_windows',{app:'safari'},signal)).rejects.toThrow(/named or selected/)
      const preflight=await turn.execute('athena_list_windows',{app:'chrome'},signal)
      expect(JSON.parse(preflight)).toMatchObject({focused:true,windowCount:1,selectedTab:true})
      expect(preflight).not.toContain('Private')
      await expect(browser({action:'inspect'})).rejects.toThrow(/requested site/)
      await expect(browser({action:'window',operation:'new-tab'})).rejects.toThrow(/requested browser setup/)
      await expect(browser({action:'window',operation:'navigate',url:'https://www.youtube.com.evil.example/'})).rejects.toThrow(/requested browser setup/)
      expect(registry.execute).not.toHaveBeenCalled()
      const opened=await browser({action:'window',operation:'navigate',url:'https://www.youtube.com'})
      expect(JSON.parse(opened)).toMatchObject({ok:true,verified:true})
      expect(opened).not.toContain('Unknown')
      await expect(browser({action:'open',url:'https://www.youtube.com/'})).rejects.toThrow(/already been attempted/)
      await browser({action:'inspect'})
      expect(manager.allowsVoiceBrowser(owner,target)).toBe(true)
      expect(manager.allowsVoiceBrowser('another:owner',target)).toBe(false)
      await browser({action:'type',label:'Search',text:'piano'})
      await browser({action:'submit-search',label:'Search',text:'piano'})
      await expect(browser({action:'click',label:'Buy'})).rejects.toThrow(/separate instruction/)
      expect(registry.execute).toHaveBeenCalledTimes(4)
      expect(confirm).not.toHaveBeenCalled()
    }finally{await turn.dispose?.()}
    expect(manager.allowsVoiceBrowser(owner,target)).toBe(false)
  })
  it('requires the verified new tab, never sends a second new-tab request and withholds unexpected destinations',async()=>{
    const manager=new CodexComputerTools(),confirm=vi.fn(async()=>false)
    let target:CodexBrowserTarget={app:'chrome',pid:1,window:'one',tab:'first',url:'https://example.org/',focused:true}
    const execute=vi.fn(async(_name:string,unknownInput:unknown)=>{
      const input=unknownInput as Record<string,string>
      target=input.operation==='new-tab'?{...target,tab:'second',url:'chrome://newtab/'}:{...target,url:'https://accounts.example.org/'}
      return JSON.stringify({ok:true,verified:true,message:'The handler ran.'})
    })
    const turn=manager.forTurn({owner:'chat:turn',objective:'Open a new Chrome tab, open YouTube and search for piano',handsFreeSearch:()=>true,
      registry:{definitions:[{name:'athena_browser_action',description:'Browser',parameters:{}}],assertAccess:vi.fn(),execute},check:vi.fn(),confirm,browserTarget:async()=>({...target})})
    const browser=(input:Record<string,string>)=>turn.execute('athena_browser_action',input,signal)
    try{
      await expect(browser({action:'window',operation:'navigate',url:'https://www.youtube.com/'})).rejects.toThrow(/new tab before/)
      await browser({action:'window',operation:'new-tab',browser:'chrome'})
      await expect(browser({action:'window',operation:'new-tab'})).rejects.toThrow(/already been attempted/)
      await expect(browser({action:'window',operation:'navigate',url:'https://www.youtube.com/'})).rejects.toThrow(/could not be verified/)
      await expect(browser({action:'inspect'})).rejects.toThrow(/requested site/)
      expect(execute).toHaveBeenCalledTimes(2)
      expect(turn.verifiedActions()).toEqual(['Verified the requested new browser tab.'])
      expect(confirm).not.toHaveBeenCalled()
    }finally{await turn.dispose?.()}
  })
  it('withholds redirected search receipts and clears each chat turn’s standing permission',async()=>{
    const manager=new CodexComputerTools(),confirm=vi.fn(async()=>false)
    const target:CodexBrowserTarget={app:'chrome',pid:5,window:'one',tab:'tab',url:'https://www.youtube.com/',focused:true}
    const execute=vi.fn(async(_name:string,input:unknown)=>{
      if((input as {action:string}).action==='submit-search')target.url='https://third-party.example/'
      return JSON.stringify({ok:true,verified:true,message:'Executor feedback.'})
    })
    const options={owner:'chat:turn-a',objective:'Search YouTube for music',handsFreeSearch:()=>true,browserTarget:async()=>({...target}),check:vi.fn(),confirm,
      registry:{definitions:[{name:'athena_browser_action',description:'Browser',parameters:{}}],assertAccess:vi.fn(),execute}}
    const turn=manager.forTurn(options)
    try{
      await turn.execute('athena_browser_action',{action:'inspect'},signal)
      await turn.execute('athena_browser_action',{action:'type',label:'Search',text:'music'},signal)
      await expect(turn.execute('athena_browser_action',{action:'submit-search',label:'Search',text:'music'},signal)).rejects.toThrow(/withheld/)
      expect(turn.verifiedActions()).toHaveLength(1)
    }finally{await turn.dispose?.()}
    target.url='https://www.youtube.com/'
    target.focused=false
    const next=manager.forTurn(options)
    try{await expect(next.execute('athena_browser_action',{action:'inspect'},signal)).rejects.toThrow(/Focus the browser/)}
    finally{await next.dispose?.()}
    expect(confirm).not.toHaveBeenCalled()
  })
  it('withholds page contents when the standing preference is revoked during an authorized read',async()=>{
    let enabled=true
    const target:CodexBrowserTarget={app:'chrome',pid:32,window:'current',tab:'website',focused:true,url:'https://example.org/'}
    const manager=new CodexComputerTools(), execute=vi.fn(async()=>JSON.stringify({ok:true,verified:true,message:'Private page text'}))
    const options={owner:'voice:read-revoked',check:vi.fn(),confirm:vi.fn(async()=>false),handsFreeSearch:()=>enabled,browserTarget:async()=>({...target}),
      registry:{definitions:[{name:'athena_browser_action',description:'Browser',parameters:{}}],assertAccess:vi.fn(),execute}}
    const search=manager.forTurn({...options,objective:'Search for piano'})
    try{await search.execute('athena_browser_action',{action:'inspect'},signal)}finally{await search.dispose?.()}
    const read=manager.forTurn({...options,objective:'I can see the page now'})
    execute.mockImplementationOnce(async()=>{enabled=false;return JSON.stringify({ok:true,verified:true,message:'Private page text'})})
    try{
      await expect(read.execute('athena_browser_action',{action:'inspect'},signal)).rejects.toThrow(/turned off.*withheld/)
      expect(read.hasObservation()).toBe(false)
      expect(read.verifiedResults()).toEqual([])
      enabled=true
      expect(manager.allowsVoiceBrowser(options.owner,target)).toBe(false)
    }finally{await read.dispose?.()}
  })
  it('binds an explicit retry to the original tab and never offers to replay a search after attempted input',async()=>{
    const manager=new CodexComputerTools(),signal=new AbortController().signal
    let target:CodexBrowserTarget={app:'chrome',pid:23,window:'one',tab:'t',url:'https://example.org/',focused:false}
    const execute=vi.fn(async()=>JSON.stringify({ok:true,verified:true,message:'Native receipt.'}))
    const options={owner:'voice:retry',objective:'Search for piano',check:vi.fn(),confirm:vi.fn(async()=>false),browserTarget:async()=>({...target}),
      handsFreeSearch:()=>true,registry:{definitions:[{name:'athena_browser_action',description:'Browser',parameters:{}}],assertAccess:vi.fn(),execute}}
    const first=manager.forTurn(options)
    await expect(first.execute('athena_browser_action',{action:'inspect'},signal)).rejects.toThrow(/Focus the browser/)
    const scope=first.searchRetryScope?.()
    expect(scope?.target).toMatchObject({pid:23,tab:'t',url:'https://example.org/'})
    await first.dispose?.()
    target={...target,focused:true,tab:'different'}
    const changed=manager.forTurn(options)
    try{
      changed.restrictSearchRetry!(scope!)
      await expect(changed.execute('athena_browser_action',{action:'inspect'},signal)).rejects.toThrow(/target changed/)
      expect(execute).not.toHaveBeenCalled()
    }finally{await changed.dispose?.()}
    target={...target,tab:'t'}
    const next=manager.forTurn(options)
    try{
      next.restrictSearchRetry!(scope!)
      await next.execute('athena_browser_action',{action:'inspect'},signal)
      execute.mockRejectedValueOnce(new Error('Connection lost after native dispatch'))
      await expect(next.execute('athena_browser_action',{action:'type',label:'Search',text:'piano'},signal)).rejects.toThrow(/Connection lost/)
      expect(next.searchRetryScope?.()).toBeUndefined()
    }finally{await next.dispose?.()}
  })
  it('requires real foreground selection before a retry when no original tab could be identified',async()=>{
    const manager=new CodexComputerTools(),signal=new AbortController().signal
    let target:CodexBrowserTarget|undefined
    const options={owner:'voice:retry-empty',objective:'Search for piano',check:vi.fn(),confirm:vi.fn(async()=>false),browserTarget:vi.fn(async()=>target),
      handsFreeSearch:()=>true,registry:{definitions:[{name:'athena_browser_action',description:'Browser',parameters:{}}],assertAccess:vi.fn(),
        execute:vi.fn(async()=>JSON.stringify({ok:true,message:'Observed tab.'}))}}
    const first=manager.forTurn(options)
    await expect(first.execute('athena_browser_action',{action:'inspect'},signal)).rejects.toThrow(/Focus the browser/)
    const scope=first.searchRetryScope?.()
    expect(scope).toBeDefined()
    await first.dispose?.()
    const second=manager.forTurn(options)
    try{
      second.restrictSearchRetry!(scope!)
      target={app:'chrome',pid:22,window:'w',tab:'t',url:'https://example.org/',focused:false}
      await expect(second.execute('athena_browser_action',{action:'inspect'},signal)).rejects.toThrow(/target changed/)
      expect(options.registry.execute).not.toHaveBeenCalled()
      target.focused=true
      await second.execute('athena_browser_action',{action:'inspect'},signal)
      expect(options.registry.execute).toHaveBeenCalledTimes(1)
    }finally{await second.dispose?.()}
  })
  it('finds a uniquely named tab locally, verifies selection and reuses only that tab for follow-up observation and playback',async()=>{
    const manager=new CodexComputerTools(),confirm=vi.fn(async()=>false)
    const state={running:true,focused:true,pid:33,foreground:33,windows:[{id:'one',focused:true,minimized:false,hidden:false,maximized:false,
      tabs:[{id:'start',title:'Private unrelated page',selected:true},{id:'music',title:'YouTube – Quiet music',selected:false}]}]}
    let target:CodexBrowserTarget={app:'chrome',pid:33,window:'one',tab:'start',url:'https://other.example/',focused:true}
    let pin:unknown
    const execute=vi.fn(async(_name:string,input:unknown)=>{
      if((input as {action:string}).action==='select'){
        expect(pin).toEqual({app:'chrome',pid:33,window:'one',tab:'music'})
        target={...target,tab:'music',url:'https://www.youtube.com/watch?v=demo'}
        state.windows[0].tabs.forEach(t=>{t.selected=t.id==='music'})
      }
      return JSON.stringify({ok:true,verified:true,message:'Verified selected page operation.'})
    })
    let enabled=true
    const options={owner:'voice:reuse',check:vi.fn(),confirm,browserTarget:async()=>({...target}),listWindows:async()=>state,handsFreeSearch:()=>enabled,
      withTabSelection:async<T>(expected:unknown,run:()=>Promise<T>)=>{pin=expected;try{return await run()}finally{pin=undefined}},
      registry:{definitions:[{name:'athena_browser_action',description:'Browser',parameters:{}}],assertAccess:vi.fn(),execute}}
    const setup=manager.forTurn({...options,objective:'Switch to my YouTube tab in my Chrome browser'})
    try{
      const raw=await setup.execute('athena_list_windows',{app:'chrome'},signal)
      expect(JSON.parse(raw)).toMatchObject({matchingTabCount:1})
      expect(raw).not.toMatch(/Private|Quiet music/)
      await expect(setup.execute('athena_browser_action',{action:'select',query:'Private'},signal)).rejects.toThrow(/existing tab/)
      await setup.execute('athena_browser_action',{action:'select',query:'YouTube'},signal)
      expect(setup.verifiedActions()).toHaveLength(1)
    }finally{await setup.dispose?.()}
    for(const [objective,input] of [['I can see the search bar now',{action:'inspect'}],['Pause it',{action:'media',operation:'pause'}]] as const){
      const next=manager.forTurn({...options,objective})
      try{await next.execute('athena_browser_action',input,signal)}finally{await next.dispose?.()}
    }
    expect(confirm).not.toHaveBeenCalled()
    enabled=false
    const revoked=manager.forTurn({...options,objective:'Read the current tab'})
    try{await expect(revoked.execute('athena_browser_action',{action:'read'},signal)).rejects.toThrow(/declined/)}
    finally{await revoked.dispose?.()}
    expect(execute).toHaveBeenCalledTimes(3)
  })
  it.each([undefined,'example.com/path','chrome://newtab/'])('obtains single-use consent for each page observation without a confirmed HTTP origin (%s)',async url=>{
    const f=setup({url}),turn=f.turn('voice:origin')
    await turn.execute('athena_browser_action',{action:'tabs'},signal)
    await turn.execute('athena_browser_action',{action:'inspect'},signal)
    f.confirm.mockResolvedValueOnce(false)
    await expect(turn.execute('athena_browser_action',{action:'read'},signal)).rejects.toThrow(/declined/)
    expect(f.confirm).toHaveBeenCalledTimes(3)
    expect(f.confirm).toHaveBeenNthCalledWith(2,'Share this browser tab with Codex once?',expect.stringContaining('single inspect'),expect.any(AbortSignal))
    expect(f.registry.execute).toHaveBeenCalledTimes(2)
  })
  it('allows a new tab from a blank window but withholds contents without a stable selected tab',async()=>{
    const f=setup({tab:undefined,url:undefined}),turn=f.turn('voice:blank')
    await turn.execute('athena_browser_action',{action:'window',operation:'new-tab'},signal)
    await expect(turn.execute('athena_browser_action',{action:'inspect'},signal)).rejects.toThrow(/selected browser tab/)
    expect(f.registry.execute).toHaveBeenCalledOnce()
  })
  it('passes structured page evidence to the native Codex tool call while keeping the speech receipt concise', async () => {
    const f = setup(), turn = f.turn('voice:fixture')
    const result = nativeActionResultSchema.parse({ ok: true, message: 'Active page: Fixture', data: { controls: [
      {role:'AXHeading',label:'heading',text:'Fixture results',enabled:true},
      {role:'AXLink',label:'First fixture result',enabled:true},
    ] } })
    f.registry.execute.mockResolvedValueOnce(JSON.stringify(result))
    const calls = new NativeComputerCalls(turn)
    calls.accept('thread', 'turn')
    try {
      const reply = await calls.dispatch({threadId:'thread',turnId:'turn',callId:'inspect',namespace:null,tool:'athena_browser_action',arguments:{action:'inspect'}})
      expect(reply).toEqual({success:true,contentItems:[{type:'inputText',text:JSON.stringify(result)}]})
      expect(turn.verifiedResults()).toEqual(['Active page: Fixture'])
    } finally {
      calls.stop()
      await turn.dispose?.()
    }
  })
  it('records only a successful verified submit-search for this turn’s exact parsed query',async()=>{
    const f=setup(),turn=f.turn('voice:search','Please search for piano music')
    const inspect=()=>turn.execute('athena_browser_action',{action:'inspect'},signal)
    const submit=(text:string)=>turn.execute('athena_browser_action',{action:'submit-search',label:'Search',text},signal)
    try{
      await inspect()
      await turn.execute('athena_browser_action',{action:'type',label:'Search',text:'piano music'},signal)
      expect(turn.verifiedSearchSubmission?.()).toBe(false)
      await inspect()
      await submit('different query')
      expect(turn.verifiedSearchSubmission?.()).toBe(false)
      for(const receipt of [{ok:false,verified:true},{ok:true,verified:false}]){
        await inspect()
        f.registry.execute.mockResolvedValueOnce(JSON.stringify({...receipt,message:'Unconfirmed submission.'}))
        await submit('piano music')
        expect(turn.verifiedSearchSubmission?.()).toBe(false)
      }
      await inspect()
      await submit('piano music')
      expect(turn.verifiedSearchSubmission?.()).toBe(true)
    }finally{await turn.dispose?.()}
  })
  it('uses registered tools and accepts evidence only from a successful verification', async () => {
    const f = setup(), t = f.turn('voice:1')
    expect(t.definitions.map(d => d.name)).not.toContain('run_shell')
    expect(t.definitions.map(d => d.name)).not.toContain('athena_desktop_open_url')
    await t.execute('athena_browser_action', { action: 'media', operation: 'play' }, signal)
    f.registry.execute.mockResolvedValueOnce(JSON.stringify({ ok: true, message: 'Sent navigation request.' }))
    await t.execute('athena_browser_action', { action: 'open', url: 'https://example.com' }, signal)
    expect(t.verifiedResults()).toEqual(['Observed playing state.'])
    expect(f.confirm).toHaveBeenCalledTimes(1)
    await t.dispose?.()
  })
  it('carries native tab identity across turns, reobserves a changed target and isolates owner cancellation', async () => {
    const f = setup(), first = f.turn('voice:1'), chat = f.turn('chat:2')
    await first.execute('athena_browser_action', { action: 'inspect' }, signal)
    await expect(chat.execute('athena_browser_action', { action: 'inspect' }, signal)).rejects.toThrow('Another automation')
    await first.dispose?.()
    f.switchTab()
    const next = f.turn('voice:1')
    await expect(next.execute('athena_browser_action', { action: 'back' }, signal)).rejects.toThrow('tab changed')
    f.manager.forget('voice:1')
    await expect(next.execute('athena_browser_action', { action: 'inspect' }, signal)).rejects.toThrow('ended')
    await chat.execute('athena_browser_action', { action: 'inspect' }, signal)
    expect(f.registry.execute).toHaveBeenCalledTimes(2)
    await chat.dispose?.()
  })
  it('withholds a browser read if the document changes in the same tab during approval or capture', async () => {
    const f = setup(), t = f.turn('chat:1')
    f.confirm.mockImplementationOnce(async () => { f.navigate(); return true })
    await expect(t.execute('athena_browser_action', { action: 'read' }, signal)).rejects.toThrow('target changed')
    expect(f.registry.execute).not.toHaveBeenCalled()
    expect(t.hasObservation()).toBe(false)
    await t.dispose?.()
    const second = setup(), read = second.turn('chat:2')
    second.registry.execute.mockImplementationOnce(async () => {
      second.navigate()
      return JSON.stringify({ ok: true, message: 'Contents from another website' })
    })
    await expect(read.execute('athena_browser_action', { action: 'read' }, signal)).rejects.toThrow('withheld')
    expect(read.verifiedResults()).toEqual([])
    await read.dispose?.()
  })
  it('requires current, single-use visual references and clears the image after transport', async () => {
    const f = setup(), t = f.turn('chat:1')
    const raw = await t.execute('athena_capture_window', { app: 'chrome' }, signal)
    expect(t.formatOutput?.(raw)).toEqual([expect.objectContaining({ type: 'input_text' }), expect.objectContaining({ type: 'input_image' })])
    expect(t.formatOutput?.(raw)).toBeUndefined()
    const input = { observation: JSON.parse(raw).observation, action: { type: 'click', button: 'left', x: 12, y: 21 } }
    const result = JSON.parse(await t.execute('athena_window_input', input, signal))
    expect(result.ok).toBe(false)
    await expect(t.execute('athena_window_input', input, signal)).rejects.toThrow('again')
    expect(f.driver.run).toHaveBeenCalledTimes(1)
    expect(t.verifiedResults()).toEqual(['Observed the approved Google Chrome window.'])
    f.manager.forget('chat:1')
    expect(f.driver.dispose).toHaveBeenCalledOnce()
  })
  it('treats changed pixels or a generic UI delta as input evidence, never a verified objective', async () => {
    const f = setup(), t = f.turn('voice:1')
    vi.mocked(f.driver.run).mockResolvedValue({ applied: true, evidence: 'The approved window visibly changed.' })
    const read = JSON.parse(await t.execute('athena_capture_window', { app: 'chrome' }, signal))
    const input = { observation: read.observation, action: { type: 'click', button: 'left', x: 5, y: 5 } }
    expect(JSON.parse(await t.execute('athena_window_input', input, signal))).toMatchObject({ ok: true, verified: false })
    await t.execute('athena_browser_action', { action: 'inspect' }, signal)
    f.registry.execute.mockResolvedValueOnce(JSON.stringify({ ok: true, verified: true, message: 'The page changed after activating that control.' }))
    await t.execute('athena_browser_action', { action: 'click', label: 'Play' }, signal)
    expect(t.hasObservation()).toBe(true)
    expect(t.verifiedActions()).toEqual([])
    await t.execute('athena_browser_action', { action: 'media', operation: 'play' }, signal)
    expect(t.verifiedActions()).toEqual(['Observed playing state.'])
    await t.dispose?.()
  })
  it('stops a denied scope before sending application information', async () => {
    const f = setup(), t = f.turn('voice:1')
    f.confirm.mockResolvedValue(false)
    await expect(t.execute('athena_browser_action', { action: 'inspect' }, signal)).rejects.toThrow('declined')
    await expect(t.execute('athena_capture_window', { app: 'chrome' }, signal)).rejects.toThrow('ended')
    expect(f.registry.execute).not.toHaveBeenCalled()
    expect(f.driver.capture).not.toHaveBeenCalled()
  })
  it('retains scoped voice consent across follow-up turns and clears it when the voice session ends', async () => {
    const f = setup()
    const first = f.turn('voice:1')
    await first.execute('athena_browser_action', { action: 'inspect' }, signal)
    expect(first.hasObservation()).toBe(true)
    await first.dispose?.()
    const next = f.turn('voice:1')
    await next.execute('athena_browser_action', { action: 'media', operation: 'play' }, signal)
    expect(next.hasObservation()).toBe(false)
    expect(f.confirm).toHaveBeenCalledOnce()
    f.manager.forget('voice:1')
    const restarted = f.turn('voice:1')
    await restarted.execute('athena_browser_action', { action: 'inspect' }, signal)
    expect(f.confirm).toHaveBeenCalledTimes(2)
    await restarted.dispose?.()
  })
  it('serializes physical input across isolated targets without sharing their grants or stopping both sessions', async () => {
    const manager = new CodexComputerTools()
    let entered!: () => void
    let finish!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const reading = new Promise<void>(resolve => { finish = resolve })
    const registry: ProjectTools = {
      definitions: [{ name: 'athena_desktop_open_application', parameters: {}, description: 'Focus the application.' }],
      assertAccess: vi.fn(),
      execute: vi.fn(async (_name, input) => {
        if ((input as { app: string }).app === 'chrome') { entered(); await reading }
        return JSON.stringify({ ok: true, verified: true, message: 'Observed active.' })
      }),
    }
    const turn = (owner: string) => manager.forTurn({ owner, objective: 'Focus the application.', registry, check: vi.fn(), confirm: vi.fn(async () => true) })
    const voice = turn('voice:1'), chat = turn('chat:1')
    const first = voice.execute('athena_desktop_open_application', { app: 'chrome' }, signal)
    await started
    const second = chat.execute('athena_desktop_open_application', { app: 'vscode' }, signal)
    expect(registry.execute).toHaveBeenCalledTimes(1)
    manager.forget('voice:1')
    finish()
    await expect(first).rejects.toThrow()
    expect(JSON.parse(await second)).toMatchObject({ ok: true })
    expect(registry.execute).toHaveBeenCalledTimes(2)
    expect(voice.verifiedResults()).toEqual([])
    expect(chat.verifiedResults()).toEqual(['Observed active.'])
    await chat.dispose?.()
  })
  it('opens only a user-reviewed loopback preview in a project-enabled toolset', async () => {
    const f = setup(), t = f.turn('chat:1')
    await expect(t.execute('athena_open_project_preview', { url: 'http://10.0.0.3:4000' }, signal)).rejects.toThrow('loopback')
    expect(f.openProjectPreview).not.toHaveBeenCalled()
    await t.execute('athena_open_project_preview', { url: 'http://127.0.0.1:4000/form' }, signal)
    expect(f.confirm).toHaveBeenCalledOnce()
    expect(f.openProjectPreview).toHaveBeenCalledOnce()
    await t.dispose?.()
  })
})
