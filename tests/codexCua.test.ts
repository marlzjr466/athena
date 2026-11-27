import {describe, expect, it, vi} from 'vitest'
import {runInNewContext} from 'node:vm'
import {authorizeCua, CodexCua, CUA_PLUGIN, type CuaBinding} from '../electron/main/ai/codexCua'
import {CodexCuaControls} from '../electron/main/desktop/codexCuaControls'
import {nativeItemActivity} from '../electron/main/ai/CodexAppServerProvider'
import type {ThreadItem} from '../electron/main/ai/codexProtocol/v2/ThreadItem'

const signal=new AbortController().signal
function transport(config:object={}, requirements:object|null=null) {
  let contexts=0
  const registration={name:'cua_repl',pluginId:CUA_PLUGIN,environmentId:null,runtimeStatus:'connected',tools:{js:{}}}
  const request=vi.fn(async(method:string,_params?:unknown):Promise<unknown>=>{
    if(method==='config/read')return {config}
    if(method==='configRequirements/read')return {requirements}
    if(method==='thread/start')return {thread:{id:'tools-'+ ++contexts}}
    if(method==='mcpServerStatus/list')return {data:[registration]}
    if(method==='mcpServer/tool/call')return {content:[{type:'text',text:'ok'}]}
    if(method==='thread/unsubscribe')return {}
    throw Error(method)
  })
  const rpc={request,onServerRequest:()=>()=>{},isClosed:false}
  const binding={rpc,threadId:'planning',turnId:'one',cwd:'/fixture'} as unknown as CuaBinding
  return {request,binding,registration}
}
describe('scoped native Codex computer use',()=>{
  it('uses one registration per owner, checks each turn, and never starts a second model turn',async()=>{
    const t=transport(), manager=new CodexCua()
    try{
      const first=await manager.application('voice:1',t.binding,'com.google.Chrome',signal)
      await first('nodeRepl.write(true)','Check')
      await manager.application('voice:1',{...t.binding,turnId:'two'},'com.google.Chrome',signal)
      await manager.application('chat:2',{...t.binding,threadId:'other'},'com.microsoft.VSCode',signal)
      expect(t.request.mock.calls.filter(([m])=>m==='thread/start')).toHaveLength(2)
      expect(t.request.mock.calls.filter(([m])=>m==='mcpServerStatus/list')).toHaveLength(3)
      expect(t.request.mock.calls.some(([m])=>m==='turn/start')).toBe(false)
      manager.forget('chat:2')
      await expect(first('nodeRepl.write(true)','Check')).resolves.toBe('ok')
      manager.forget('voice:1')
      await expect(first('nodeRepl.write(true)','Check')).rejects.toThrow(/ended/)
    }finally{manager.forget('chat:2');manager.forget('voice:1')}
  })
  it('honors user and managed policy before any access or fallback',async()=>{
    for(const t of [
      transport({plugins:{[CUA_PLUGIN]:{enabled:false}}}),
      transport({computer_use:{macos:{bundle_ids:{'com.google.Chrome':'deny'}}}}),
      transport({}, {computerUse:{defaultAppAccess:'deny'}}),
      transport({browser_use:{default_origin_policy:{access:'allow'}}},{browserUse:{origins:{'https://site.test':{access:'deny'}}}}),
    ]){
      await expect(authorizeCua(t.binding,'com.google.Chrome','https://site.test/')).rejects.toThrow(/denies|disabled/)
      expect(t.request.mock.calls.map(([m])=>m)).toEqual(['config/read','configRequirements/read'])
    }
  })
  it('does not accept another plugin under the same server name',async()=>{
    const t=transport();t.registration.pluginId='other'
    await expect(new CodexCua().application('voice:1',t.binding,'com.google.Chrome',signal)).rejects.toThrow(/unavailable/)
    expect(t.request.mock.calls.some(([m])=>m==='mcpServer/tool/call')).toBe(false)
  })
  it('re-resolves Chrome autocomplete focus IDs and verifies the value, submit, and resulting tab',async()=>{
    const target={app:'chrome' as const,pid:1,window:'w',tab:'t',url:'https://site.test/'}
    let active=false,value='',submits=0,stolen=false,externalTab=false,settling=false
    const tree=()=>{
      const id=active?31:18,display=target.url.replace('https://','')
      return '0 standard window Search, URL: '+display+'\n\t10 HTML content Search, URL: '+display+'\n\t\t'+id+' combo box (settable) '+(value?'Value: '+value+', Placeholder: Search, Description: Suggestions expanded':'Search')+
        '\n\t\t32 button Search\nThe focused UI element is '+(stolen?'32 button Search':id+' combo box Search')
    }
    const app={getAXState:async()=>{
      const current=tree()
      if(!settling)return current
      settling=false
      return current.replace(/The focused UI element is .*/, 'The focused UI element is 32 button Search')
    },click:async()=>{active=true;settling=true},pressKey:async(key:string)=>{if(key==='Return'){submits++;target.url='https://site.test/?q=two+words'}},typeText:async(v:string)=>{value=v}}
    const controls=new CodexCuaControls()
    const run=(args:Record<string,unknown>)=>controls.run({name:'athena_browser_action',args},{target:{...target},signal,
      current:async()=>({...target,tab:externalTab?'other':target.tab}),confirm:async()=>false,
      call:async code=>{let output='';await runInNewContext('(async()=>{'+code+'})()',{athenaApp:app,nodeRepl:{write:(s:string)=>{output=s}}});return output}})
    await run({action:'inspect'})
    await expect(run({action:'type',label:'control 18',text:'two words'})).resolves.toMatchObject({verified:true})
    await expect(run({action:'submit-search',label:'control 18',text:'two words'})).resolves.toMatchObject({verified:true})
    expect(submits).toBe(1)
    externalTab=true
    await expect(run({action:'inspect'})).rejects.toThrow(/changed/)
    externalTab=false;stolen=true
    await run({action:'inspect'})
    await expect(run({action:'type',label:'Search',text:'different'})).rejects.toThrow(/focus/)
    expect(value).toBe('two words')
    await expect(run({action:'type',label:'Search',text:'different'})).rejects.toThrow(/uncertain/)
  })
  it('labels native events using the recorded method without logging input or inventing a result',()=>{
    const item={type:'mcpToolCall',id:'one',server:'cua_repl',pluginId:CUA_PLUGIN,tool:'js',arguments:{code:'await app.typeText("private phrase")'},status:'completed',durationMs:60,environmentId:null,appContext:null,mcpAppUi:null,readOnlyHint:null,result:null,error:null} satisfies ThreadItem
    const event=nativeItemActivity(item,true)
    expect(event).toMatchObject({tool:'codex.cua_repl.js',label:'Entering text',status:'complete'})
    expect(JSON.stringify(event)).not.toContain('private phrase')
  })
  it('navigates with the enabled browser toolbar button and ignores page buttons with the same name',async()=>{
    const target={app:'chrome' as const,pid:1,window:'w',tab:'t',url:'https://site.test/second'}
    let enabled=false
    const clicks:number[]=[]
    const app={
      getAXState:async()=>['0 standard window Site','  3 toolbar','    4 button '+(enabled?'':'(disabled) ')+'Back',
        '  8 HTML content Site, URL: https://site.test/second','    9 toolbar','      10 button Back'].join('\n'),
      click:async(id:number)=>{clicks.push(id);target.url='https://site.test/first'},
    }
    const control=new CodexCuaControls()
    const back=()=>control.run({name:'athena_browser_action',args:{action:'back'}},{target:{...target},current:async()=>({...target}),historyDestination:()=>'https://site.test/first',signal,confirm:async()=>false,
      call:async code=>{let output='';await runInNewContext('(async()=>{'+code+'})()',{athenaApp:app,nodeRepl:{write:(s:string)=>{output=s}}});return output}})
    await expect(back()).rejects.toThrow(/No navigation input/)
    expect(clicks).toEqual([])
    enabled=true
    await expect(back()).resolves.toMatchObject({verified:true})
    expect(clicks).toEqual([4])
  })
  it.each(['…','site.test/video?id=4'])('resolves the actual destination when the browser displays %s',async shown=>{
    const target={app:'chrome' as const,pid:4,window:'w',tab:'t',url:'https://www.site.test/results'}
    const destination='https://www.site.test/video?id=4'
    const click=vi.fn(async()=>{target.url=destination})
    const confirm=vi.fn(async()=>false)
    const resolveLink=vi.fn(async()=>destination)
    const control=new CodexCuaControls()
    const app={getAXState:async()=>['0 standard window Site',' 8 HTML content Site, URL: '+target.url,
      '  9 link First recording, Value: '+shown].join('\n'),click}
    const run=(action:string)=>control.run({name:'athena_browser_action',args:{action,label:'control 9'}},
      {target:{...target},current:async()=>({...target}),signal,confirm,resolveLink,
       call:async code=>{let output='';await runInNewContext('(async()=>{'+code+'})()',{athenaApp:app,nodeRepl:{write:(s:string)=>{output=s}}});return output}})
    await run('inspect')
    resolveLink.mockResolvedValueOnce(destination).mockResolvedValueOnce('https://elsewhere.test/')
    await expect(run('click')).rejects.toThrow(/destination changed/)
    expect(click).not.toHaveBeenCalled()
    await expect(run('click')).resolves.toMatchObject({verified:true,verifiedDestination:true})
    expect(confirm).not.toHaveBeenCalled()
    expect(click).toHaveBeenCalledOnce()
  })
  it('uses accessible descriptions as control names and verifies a changed native display',async()=>{
    const target={app:'calculator' as const,pid:1,window:'w'}
    let display='7'
    const app={getAXState:async()=>['0 standard window Calculator','  4 text '+display,'  9 button Description: 4, ID: Four'].join('\n'),click:async()=>{display='4'}}
    const control=new CodexCuaControls()
    const run=(name:string)=>control.run({name,args:{label:'4'}},{target,current:async()=>target,signal,confirm:async()=>false,
       call:async code=>{let out='';await runInNewContext('(async()=>{'+code+'})()',{athenaApp:app,nodeRepl:{write:(s:string)=>{out=s}}});return out}})
    await run('athena_desktop_inspect_accessible_ui')
    await expect(run('athena_desktop_click_accessible_element')).resolves.toMatchObject({verified:true})
  })
  it('compares the actual window and document titles separately after Back and rejects a different window',async()=>{
    const target={app:'chrome' as const,pid:1,window:'w',tab:'t',url:'https://site.test/results?q=music',
      uniqueTitle:'Earlier video',uniqueWindowTitle:'Music results - Browser'}
    const reply={root:'0 standard window Music results - Browser, URL: …, Secondary Actions: Raise',
      document:' 21 HTML content URL: …, Earlier video',lines:[' 22 heading Results']}
    const inspect=()=>new CodexCuaControls().run({name:'inspect',args:{}},{target,current:async()=>target,signal,
      confirm:async()=>false,call:async()=>JSON.stringify(reply)})
    await expect(inspect()).resolves.toMatchObject({verified:true})
    reply.root='0 standard window Another tab - Browser, URL: …, Secondary Actions: Raise'
    await expect(inspect()).rejects.toThrow(/differs/)
  })
})

it.each([false,true])('selects the actual titled result when a sidebar link matches a separate heading, URL-first metadata %s',async urlFirst=>{
  const target={app:'chrome' as const,pid:71,window:'w1',tab:'t1',url:'https://site.test/results?q=music',uniqueTitle:'Music results'}
  const controls=new CodexCuaControls()
  const input:number[]=[]
  const before={root:urlFirst?'0 standard window URL: …, Secondary Actions: Raise, Music results - Browser':'0 standard window Music results - Browser, URL: …',
    document:urlFirst?' 8 HTML content URL: site.test/results, Music results':' 8 HTML content Music results, URL: site.test/results',lines:[
    '  9 link Spotlight','  10 heading Spotlight, Value: 2',
    '  11 heading Value: 3, First recording','   12 group','    13 link First recording, Value: site.test/media'+(urlFirst?'':'?item=1'),
    '  14 link Second recording, Value: site.test/media'+(urlFirst?'':'?item=2'),'   15 heading Value: 3, Second recording']}
  const after={root:'0 standard window Second recording - Browser, URL: …',document:' 8 HTML content URL: site.test/media?item=2&time=10, Second recording',lines:['  15 heading Second recording','  16 button Pause keyboard shortcut k']}
  const app={
    getAXState:async()=>{const f=input.length?after:before;return [f.root,f.document,...f.lines].join('\n')},
    click:async(id:number)=>{input.push(id);target.url='https://site.test/media?item=2&time=10';target.uniqueTitle='Second recording'},
  }
  const run=(args:Record<string,unknown>)=>controls.run({name:'athena_browser_action',args},{target:{...target},current:async()=>({...target}),signal,confirm:async()=>false,
    call:async code=>{
      let output=''
      await runInNewContext('(async()=>{'+code+'})()',{athenaApp:app,nodeRepl:{write:(s:string)=>{output=s}}})
      return output
    }})
  target.uniqueTitle='Unrelated document'
  await expect(run({action:'inspect'})).rejects.toThrow(/differs/)
  target.uniqueTitle='Music results'
  await expect(run({action:'video-result',index:2})).resolves.toMatchObject({ok:true,verified:true})
  expect(input).toEqual([14])
})
