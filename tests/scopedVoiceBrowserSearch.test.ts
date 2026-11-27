import {expect,it,vi} from 'vitest'
import {NativeComputerCalls} from '../electron/main/ai/codexComputerTools'
import {dictatedBrowserText} from '../electron/main/ai/voiceDesktopActions'
import {CodexComputerTools} from '../electron/main/desktop/codexComputerTools'
import {DesktopContext} from '../electron/main/desktop/desktopContext'
import {ExistingBrowser} from '../electron/main/desktop/existingBrowser'
import {voiceBrowserActionSchema} from '../shared/voiceBrowser'
import type {NativePageRequest,NativePageResult} from '../electron/main/desktop/desktopPlatform'

it('identifies a unique existing background tab without activation and runs a scoped search through the shared executor',async()=>{
  const manager=new CodexComputerTools(),owner='voice:initial-background',signal=new AbortController().signal
  const window={id:'w',captureId:'window:7:0',hidden:false,minimized:false,maximized:false,focused:true,tabs:[{id:'tab',title:'Selected page',selected:true}]}
  const state={running:true,focused:false,pid:21,foreground:99,windows:[window]}
  const running=vi.fn(async()=>[{app:'com.athena.companion',active:true},{app:'com.google.Chrome',active:false}])
  const invoke=vi.fn(async(_app:unknown,r:{operation:string})=>{expect(r.operation).toBe('observe');return structuredClone(state)})
  const context=new DesktopContext(invoke,running)
  let url='https://example.org/',document='d1',text=''
  const nativePage=vi.fn(async(_app:unknown,r:NativePageRequest):Promise<NativePageResult>=>{
    const scope=JSON.parse(r.token!)
    expect(scope).toMatchObject({pid:21,capture:'window:7:0',window:'w',tab:'tab'})
    if(r.action==='background-bind'){
      expect(scope.foreground).toBe(99)
      return {ok:true,verified:true,message:'Identified',pageURL:url,pageReference:document,elements:[]}
    }
    expect(scope).toMatchObject({url,document})
    if(r.action==='background-set-text')text=r.text!
    if(r.action==='background-submit-search'){expect(text).toBe('quiet piano');url='https://example.org/?q=quiet+piano';document='d2'}
    return {ok:true,verified:true,message:'Observed the requested action.',pageURL:url,pageReference:document,windowToken:'scope',
      elements:[{label:'Search',role:'AXSearchField',enabled:true,searchField:true}]}
  })
  const confirm=vi.fn(async()=>false),launch=vi.fn(),objective='Search for quiet piano'
  const browser=new ExistingBrowser({context,defaultBrowser:()=> 'chrome',allowed:()=>true,launch,onOtherDisplay:()=>false,publicURL:async()=>true,
    settings:()=>({reuseBrowserWindows:true,browserDebugPort:0,pauseOnConflict:true}),nativePage,confirm,
    backgroundOwner:()=>owner,handsFreeSearch:()=>true,allowSearch:(scope,text)=>manager.allowsVoiceBrowser(owner,scope) && dictatedBrowserText(objective,text,true),
    allowBackground:scope=>manager.allowsVoiceBrowser(owner,scope)})
  const exec=vi.fn(async(_name:string,input:unknown,s:AbortSignal)=>JSON.stringify(await browser.run(voiceBrowserActionSchema.parse(input),s,objective)))
  const turn=manager.forTurn({owner,objective,check:vi.fn(),confirm,handsFreeSearch:()=>true,
    browserTarget:async(s,initial)=>await browser.backgroundTarget(s)??(initial?await browser.initialSearchTarget(initial.browser,initial.destination,s):undefined),
    registry:{definitions:[{name:'athena_browser_action',description:'Browser',parameters:{}}],assertAccess:vi.fn(),execute:exec}})
  const send=(args:Record<string,string>)=>turn.execute('athena_browser_action',args,signal)
  try{
    const current=await send({action:'window',operation:'current',browser:'chrome'})
    expect(JSON.parse(current)).toMatchObject({ok:true,app:'chrome',focused:false,selected:true})
    expect(current).not.toContain('Selected page')
    expect(nativePage.mock.calls.map(([,r])=>r.action)).toEqual(['background-bind'])
    expect(exec).not.toHaveBeenCalled()
    await send({action:'inspect'})
    await send({action:'type',label:'Search',text:'quiet piano'})
    await send({action:'submit-search',label:'Search',text:'quiet piano'})
    expect(turn.verifiedSearchSubmission?.()).toBe(true)
    expect(nativePage.mock.calls.filter(([,r])=>r.action==='background-set-text')).toHaveLength(1)
    expect(nativePage.mock.calls.filter(([,r])=>r.action==='background-submit-search')).toHaveLength(1)
    expect(confirm).not.toHaveBeenCalled()
    expect(launch).not.toHaveBeenCalled()
    expect(state.foreground).toBe(99)
  }finally{await turn.dispose?.();manager.forget(owner);browser.dispose()}
})

it('a standing spoken-search permission is limited to the selected site, active instruction and exact query',async()=>{
  let target={app:'chrome' as const,pid:42,window:'w1',tab:'t1',url:'https://example.org/',focused:false}
  const manager=new CodexComputerTools(), owner='voice:standing', signal=new AbortController().signal
  const confirm=vi.fn(async()=>false), capture=vi.fn(), execute=vi.fn(async()=>JSON.stringify({ok:true,verified:true,message:'Read the selected document.'}))
  let enabled=true
  const start=(objective:string)=>manager.forTurn({owner,objective,handsFreeSearch:()=>enabled,
    check:async s=>s.throwIfAborted(),browserTarget:async()=>({...target}),confirm,openWindow:capture,
    registry:{definitions:[{name:'athena_browser_action',description:'Browser',parameters:{}}],execute,assertAccess:vi.fn()}})
  const turn=start('Hey Athena, search relaxing piano music.')
  const inspect={action:'inspect'},dispatch=(args:Record<string,string>)=>turn.execute('athena_browser_action',args,signal)
  try{
    await expect(dispatch(inspect)).rejects.toThrow(/Focus the browser/)
    target.focused=true
    await dispatch(inspect)
    expect(manager.allowsVoiceBrowser(owner,target)).toBe(true)
    expect(manager.allowsVoiceBrowser('voice:someone-else',target)).toBe(false)
    await expect(dispatch({action:'click',label:'Send'})).rejects.toThrow(/dictated search/)
    await expect(turn.execute('athena_capture_window',{app:'chrome'},signal)).rejects.toThrow(/separate instruction/)
    await expect(dispatch({action:'type',label:'Search',text:'different query'})).rejects.toThrow(/exact query/)
    expect(capture).not.toHaveBeenCalled()
    target.focused=false
    await dispatch({action:'type',label:'Search',text:'relaxing piano music'})
    await dispatch({action:'submit-search',label:'Search',text:'relaxing piano music'})
    target={...target,focused:true,url:'https://other.example/'}
    await expect(dispatch(inspect)).rejects.toThrow(/website changed/)
    expect(manager.allowsVoiceBrowser(owner,target)).toBe(false)
    target={...target,url:'https://example.org/results?q=music'}
    enabled=false
    expect(manager.allowsVoiceBrowser(owner,target)).toBe(false)
    await expect(dispatch(inspect)).rejects.toThrow(/turned off/)
    expect(confirm).not.toHaveBeenCalled()
    expect(execute).toHaveBeenCalledTimes(3)
  }finally{await turn.dispose?.()}
  enabled=true
  expect(manager.allowsVoiceBrowser(owner,target)).toBe(false)
  const other=start('Describe the current website')
  try{
    await expect(other.execute('athena_browser_action',inspect,signal)).rejects.toThrow(/declined/)
    expect(confirm).toHaveBeenCalledOnce()
  }finally{await other.dispose?.();manager.forget(owner)}
})

it('reuses voice consent across dictated searches but requires a new decision for other inputs, origins, tabs and sessions',async()=>{
  const manager=new CodexComputerTools(),owner='voice:scoped-lease'
  const target={app:'chrome' as const,pid:41,window:'test-window',tab:'test-tab',url:'https://example.org/search'}
  const search={role:'AXComboBox',label:'Search',enabled:true,searchField:true,bounds:{x:10,y:40,width:200,height:40}}
  const controls=[search,{role:'AXButton',label:'Search',enabled:true},{role:'AXTextField',label:'Message',enabled:true},{role:'AXButton',label:'Send message',enabled:true}]
  const mutations:string[]=[],scopeDialogs:string[]=[],actionDialogs:string[]=[]
  const context=new DesktopContext(async(_app,request)=>{
    expect(request.operation).toBe('observe')
    return {running:true,focused:true,pid:target.pid,foreground:target.pid,windows:[{id:target.window,address:target.url,captureId:'window:1:0',hidden:false,minimized:false,maximized:false,focused:true,tabs:[{id:target.tab,title:'Search test',selected:true}]}]}
  },async()=>[{app:'com.google.Chrome',active:true}])
  let value='',objective='',next=0,callId=0
  const nativePage=async(_app:unknown,request:NativePageRequest):Promise<NativePageResult>=>{
    const observed={ok:true,verified:true,message:'Observed test page.',pageURL:target.url,windowToken:JSON.stringify({document:target.url}),elements:controls}
    if(request.action==='inspect')return observed
    if(request.action==='prepare-search'){
      expect(value).toBe(request.text)
      return {...observed,elements:[search]}
    }
    if(request.action==='set-text'){value=request.text!;mutations.push('type '+value)}
    else if(request.action==='submit-search'){
      expect(request.text).toBe(value)
      target.url='https://example.org/results?q='+encodeURIComponent(value)
      mutations.push('submit '+value)
    }else throw Error('An unapproved operation reached the native helper.')
    return {...observed,message:'Verified test input.'}
  }
  const browser=new ExistingBrowser({context,settings:()=>({reuseBrowserWindows:true,browserDebugPort:0,pauseOnConflict:true}),
    defaultBrowser:()=> 'chrome',allowed:()=>true,launch:vi.fn(),onOtherDisplay:()=>false,publicURL:async()=>true,
    confirm:async message=>{actionDialogs.push(message);return false},nativePage,backgroundOwner:()=>owner,
    allowBackground:scope=>manager.allowsVoiceBrowser(owner,scope),
    allowSearch:(scope,text)=>manager.allowsVoiceBrowser(owner,scope) && dictatedBrowserText(objective,text,true)})
  const start=(message:string)=>{
    objective=message
    const turn=manager.forTurn({owner,objective,check:async s=>s.throwIfAborted(),browserTarget:async()=>({...target}),
      confirm:async title=>{scopeDialogs.push(title);return title==='Allow routine control of this browser tab?'},
      registry:{definitions:[{name:'athena_browser_action',description:'Browser controls',parameters:{}}],assertAccess:vi.fn(),
        execute:async(_name,input,signal)=>JSON.stringify(await browser.run(voiceBrowserActionSchema.parse(input),signal,objective))}})
    const calls=new NativeComputerCalls(turn),turnId='turn-'+ ++next
    calls.accept('native-thread',turnId)
    return {invoke:(args:Record<string,string>)=>calls.dispatch({threadId:'native-thread',turnId,callId:String(++callId),namespace:null,tool:'athena_browser_action',arguments:args}),end:async()=>{calls.stop();await turn.dispose?.()}}
  }
  try{
    for(const query of ['relaxing piano music','instrumental jazz']){
      const turn=start('Search for '+query)
      try{
        expect((await turn.invoke({action:'inspect'})).success).toBe(true)
        expect((await turn.invoke({action:'type',label:'Search',text:query})).success).toBe(true)
        // No intervening inspect or modal is needed. Native preparation still rechecks the field and exact query.
        expect((await turn.invoke({action:'submit-search',label:'Search',text:query})).success).toBe(true)
        expect((await turn.invoke({action:'inspect'})).success).toBe(true)
      }finally{await turn.end()}
    }
    expect(scopeDialogs).toEqual(['Allow routine control of this browser tab?'])
    expect(actionDialogs).toEqual([])
    expect(mutations).toEqual(['type relaxing piano music','submit relaxing piano music','type instrumental jazz','submit instrumental jazz'])
    const turn=start('Search for instrumental jazz')
    try{
      expect((await turn.invoke({action:'inspect'})).success).toBe(true)
      const unapproved:Record<string,string>[]=[{action:'type',label:'Message',text:'instrumental jazz'},{action:'type',label:'Search',text:'extra content'},{action:'click',label:'Send message'}]
      for(const request of unapproved){
        expect((await turn.invoke(request)).success).toBe(false)
      }
    }finally{await turn.end()}
    expect(actionDialogs).toEqual([expect.stringContaining('“Message”'),expect.stringContaining('“Search”'),expect.stringContaining('“Send message”')])
    expect(mutations).toHaveLength(4)
    for(const change of [()=>{target.url='https://other.example/search'},()=>{target.tab='another-tab'},()=>manager.forget(owner)]){
      change()
      expect(manager.allowsVoiceBrowser(owner,target)).toBe(false)
      const changed=start('Inspect the current browser tab')
      try{expect((await changed.invoke({action:'inspect'})).success).toBe(true)}finally{await changed.end()}
    }
    expect(scopeDialogs).toEqual(Array(4).fill('Allow routine control of this browser tab?'))
  }finally{manager.forget(owner);browser.dispose()}
})
