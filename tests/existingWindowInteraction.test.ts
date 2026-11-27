// @vitest-environment node
import {describe,it,expect,vi} from 'vitest'
import {DesktopContext,chooseWindow,type WorkspaceState} from '../electron/main/desktop/desktopContext'
import {ExistingBrowser,pageControlBounds} from '../electron/main/desktop/existingBrowser'
import {ObservationRequired} from '../electron/main/desktop/observationRequired'
import {resolveVoiceActionPlan} from '../electron/main/ai/voiceActionPlan'
import {settingsSchema} from '../shared/settings'
import {voiceDesktopActions} from '../electron/main/ai/voiceDesktopActions'
const voice=(text:string)=>resolveVoiceActionPlan(text,{} as never)?.steps[0].input
const win={id:'right',focused:true,minimized:false,hidden:false,maximized:false,tabs:[{id:'tab1',title:'Example',selected:true}]}
const before:WorkspaceState={running:true,pid:8,focused:true,foreground:8,windows:[{...win,id:'left',focused:false},win]}
const signal=new AbortController().signal
function setup(state:WorkspaceState=before,overrides:Partial<ConstructorParameters<typeof ExistingBrowser>[0]>={}){
  const invoke=vi.fn(async(_app:unknown,request:{operation:string})=>request.operation==='observe'?state:{ok:true,message:'Verified'})
  const running=vi.fn(async()=>[{app:'com.google.Chrome',active:true}])
  const context=new DesktopContext(invoke,running)
  const allowed=vi.fn(()=>true), launch=vi.fn(async()=>({ok:true,message:'opened'}))
  const target={label:'Run',enabled:true,role:'AXButton',bounds:{x:10,y:10,width:100,height:24}}
  const page={ok:true,verified:true,message:'Inspected',pageURL:'https://example.com/',windowToken:'page',elements:[target]}
  const nativePage=vi.fn(async()=>structuredClone(page)),confirm=vi.fn(async()=>true),publicURL=vi.fn(async()=>true)
  const api=new ExistingBrowser({context,allowed,launch,defaultBrowser:()=>'chrome',settings:()=>({reuseBrowserWindows:true,pauseOnConflict:true,browserDebugPort:0}),onOtherDisplay:()=>false,confirm,publicURL,nativePage,...overrides})
  return {api,invoke,allowed,launch,running,page,nativePage,confirm,publicURL}
}
describe('existing browser window routing',()=>{
  it.each(['two browsers','two windows','mismatched foreground browser','changed capture','wrong site','setting disabled'])('rejects unverified initial background search scope: %s',async scenario=>{
    const state:WorkspaceState={...structuredClone(before),focused:false,foreground:77,windows:[{...structuredClone(win),captureId:'window:5:0'}]}
    if(scenario==='two windows')state.windows.push({...structuredClone(win),id:'other',captureId:'window:6:0'})
    const nativePage=vi.fn(async()=>{
      if(scenario==='changed capture')state.windows[0].captureId='window:9:0'
      return {ok:true,verified:true,message:'Bound',pageURL:'https://example.org/',pageReference:'doc'}
    })
    const f=setup(state,{nativePage,handsFreeSearch:()=>scenario!=='setting disabled',backgroundOwner:()=>'voice:bind',allowBackground:()=>false})
    f.running.mockResolvedValue([{app:'com.athena.companion',active:false},{app:'com.google.Chrome',active:false},
      ...(scenario==='two browsers' || scenario==='mismatched foreground browser'?[{app:'com.apple.Safari',active:scenario==='mismatched foreground browser'}]:[]),
      {app:'com.apple.Finder',active:scenario!=='mismatched foreground browser'}])
    const bound=f.api.initialSearchTarget(scenario==='mismatched foreground browser'?'chrome':undefined,scenario==='wrong site'?'https://different.example/':undefined,signal)
    if(scenario==='setting disabled')await expect(bound).resolves.toBeUndefined()
    else await expect(bound).rejects.toThrow()
    expect(nativePage).toHaveBeenCalledTimes(['changed capture','wrong site'].includes(scenario)?1:0)
    expect(f.invoke.mock.calls.every(([,r])=>r.operation==='observe')).toBe(true)
    expect(f.launch).not.toHaveBeenCalled()
  })
  it('refuses to select a same-title replacement after the requested native tab was pinned',async()=>{
    const state=structuredClone(before),window=state.windows.find(w=>w.focused)!
    window.tabs=[...window.tabs!,{id:'replacement',title:'Music tab',selected:false}]
    const f=setup(state,{expectedSelection:()=>({app:'chrome',pid:state.pid,window:window.id,tab:'original'})})
    await expect(f.api.run({action:'select',query:'Music'},signal,'Switch to the Music tab')).rejects.toThrow(/changed before selection/)
    expect(f.invoke.mock.calls.map(([,request])=>request.operation)).toEqual(['observe'])
    expect(f.confirm).not.toHaveBeenCalled()
  })
  it('reports native browser availability without pretending a DOM connection exists',async()=>{
    const f=setup();await f.api.refresh(signal)
    expect(f.api.status()).toMatch(/native window controls.*DOM not attached/)
    expect(f.launch).not.toHaveBeenCalled()
  })
  it('verifies native playback by the observed control transition without another browser',async()=>{
    const f=setup();f.page.elements[0].label='Pause (k)'
    f.nativePage.mockImplementation(async(_app?:unknown,request?:{action:string})=>{
      if(request?.action==='click')f.page.elements[0].label='Play (k)'
      return structuredClone(f.page)
    })
    expect(await f.api.run({action:'media',operation:'pause'},signal,'Pause it')).toMatchObject({ok:true,verified:true})
    expect(f.confirm).not.toHaveBeenCalled();expect(f.launch).not.toHaveBeenCalled()
    expect(f.nativePage.mock.calls.filter(call=>(call as unknown[])[1] && ((call as unknown[])[1] as {action:string}).action==='click')).toHaveLength(1)
  })
  it('marks unsupported page operations recoverable only before input is attempted',async()=>{
    const f=setup()
    await expect(f.api.run({action:'media',operation:'seek',value:10},signal,'Skip forward')).rejects.toMatchObject({app:'chrome'})
    expect(f.nativePage).not.toHaveBeenCalled();expect(f.launch).not.toHaveBeenCalled()
  })
  it.each(['Play the first result','Pause it','Resume','Play the second result'])('allows the resolved explicit browser instruction: %s',text=>{
    const input=voice(text) as Record<string,unknown>
    const action=voiceDesktopActions({} as never,{} as never).find(a=>a.id==='athena.browser.action')!
    expect(input).toBeDefined();expect(action.intent!(text,input)).toBe(true)
    expect(action.intent!('Do not play the video',input)).toBe(false)
  })
  it('allows a spoken search query without requiring spoken quotation marks',()=>{
    const action=voiceDesktopActions({} as never,{} as never).find(a=>a.id==='athena.browser.action')!
    for(const verb of ['type','submit-search']){
      const input={action:verb,label:'Search',text:'relaxing piano music'}
      for(const request of ['Search relaxing piano music.','Could you search for relaxing piano music?','Search this page for relaxing piano music','Look up relaxing piano music']){
        expect(action.intent!(request,input)).toBe(true)
      }
      expect(action.intent!('Search relaxing piano music',{...input,text:'different query'})).toBe(false)
      expect(action.intent!('Do not search for relaxing piano music',input)).toBe(false)
    }
    expect(action.intent!('Type relaxing piano music into the field',{action:'type',text:'relaxing piano music'})).toBe(true)
    expect(action.intent!('Type relaxing piano music into the field',{action:'submit-search',text:'relaxing piano music'})).toBe(false)
  })
  it.each([
    ['Open a new tab',{action:'window',operation:'new-tab'}],
    ['Open a new tab in my existing Chrome window',{action:'window',operation:'new-tab',browser:'chrome'}],
    ['Open a new tab in Google Chrome',{action:'window',operation:'new-tab',browser:'chrome'}],
    ['Please open another tab in my existing Google Chrome window',{action:'window',operation:'new-tab',browser:'chrome'}],
    ['Open a new tab in Microsoft Edge',{action:'window',operation:'new-tab',browser:'edge'}],
    ['Open YouTube in the current tab',{action:'window',operation:'navigate',url:'https://www.youtube.com/'}],
    ['Open a new Edge window',{action:'window',operation:'new-window',browser:'edge'}],
    ['Use the Chrome window on my other monitor',{action:'window',operation:'other-display',browser:'chrome'}],
    ['Use the current window',{selection:'current'}],
    ['Switch to the other TextEdit window',{selection:'other',name:'TextEdit'}],
  ])('resolves %s', (text,input)=>expect(voice(String(text))).toEqual(input))
  it('uses the focused window, sending exactly one native mutation pinned to process, window and tab',async()=>{
    const {api,invoke,launch}=setup()
    await api.run({action:'window',operation:'new-tab'},signal,'Open a new tab')
    expect(invoke).toHaveBeenCalledTimes(2)
    expect(invoke.mock.calls[1]).toMatchObject(['chrome',{operation:'new-tab',pid:8,window:'right',tab:'tab1',foreground:8},signal])
    expect(launch).not.toHaveBeenCalled()
  })
  it('activates the explicitly selected window and marks its real tab only when a tab press is necessary',async()=>{
    const state=structuredClone(before),mark=vi.fn(async()=>({finish:vi.fn()}))
    state.focused=false;state.foreground=27;state.windows[0].tabs=[]
    const tabs=state.windows[1].tabs!,bounds={x:-500,y:25,width:133,height:30}
    tabs.push({id:'tab2',title:'New fixture',selected:false,bounds})
    const f=setup(state,{mark})
    f.invoke.mockImplementation(async(_app,request)=>{
      if(request.operation==='observe')return structuredClone(state)
      if(request.operation==='activate'){state.focused=true;state.foreground=state.pid}
      if(request.operation==='select'){tabs[0].selected=false;tabs[1].selected=true}
      return {ok:true,message:'Verified'}
    })
    await f.api.run({action:'select',query:'New fixture'},signal,'Use the fixture tab')
    expect(mark).toHaveBeenCalledWith(expect.objectContaining({bounds,click:true}),signal)
    expect(f.invoke.mock.calls.map(call=>call[1].operation).filter(op=>op!=='observe')).toEqual(['activate','select'])
    await f.api.run({action:'select',query:'New fixture'},signal,'Use the fixture tab')
    expect(mark).toHaveBeenCalledTimes(1)
    expect(f.invoke.mock.calls.filter(call=>call[1].operation==='select')).toHaveLength(1)
  })
  it('suppresses select and ripple if the user switches foreground while the real tab is highlighted',async()=>{
    const state=structuredClone(before),finish=vi.fn()
    state.windows[0].tabs=[]
    const bounds={x:420,y:30,width:130,height:22}
    state.windows[1].tabs!.push({id:'second',title:'Unique target',selected:false,bounds})
    const mark=vi.fn(async()=>{state.focused=false;state.foreground=42;return {finish}})
    const f=setup(state,{mark})
    await expect(f.api.run({action:'select',query:'Unique target'},signal,'Select Unique target')).rejects.toThrow('tab changed')
    expect(mark).toHaveBeenCalledWith(expect.objectContaining({bounds,click:true}),signal)
    expect(f.invoke.mock.calls.filter(call=>call[1].operation!=='observe')).toHaveLength(0)
    expect(finish).toHaveBeenCalledWith(false)
  })
  it('marks an AX click target and revalidates its actual bounds after paint before submitting input',async()=>{
    const finish=vi.fn()
    const mark=vi.fn(async()=>({finish}))
    const f=setup(structuredClone(before),{mark})
    const bounds={...f.page.elements[0].bounds}
    mark.mockImplementationOnce(async()=>{f.page.elements[0].bounds={...bounds,x:bounds.x+6};return {finish}})
    await expect(f.api.run({action:'click',label:'Run'},signal,'Click Run')).rejects.toThrow('moved')
    expect(mark).toHaveBeenCalledWith(expect.objectContaining({bounds,click:true}),signal)
    expect(finish).toHaveBeenCalledWith(false)
    expect(f.nativePage.mock.calls.some(call=>(call as unknown[])[1] && ((call as unknown[])[1] as {action:string}).action==='click')).toBe(false)
  })
  it('can restore only the exact approved tab when an Athena-owned dialog displaced it',async()=>{
    const state=structuredClone(before),consume=vi.fn(()=>true)
    state.focused=false;state.foreground=27
    const f=setup(state,{athenaPid:27,consumeFocusGrant:consume})
    f.invoke.mockImplementation(async(_app,request)=>{
      if(request.operation==='observe')return structuredClone(state)
      if(request.operation==='activate'){state.focused=true;state.foreground=state.pid}
      return {ok:true,message:'Verified'}
    })
    expect(await f.api.run({action:'inspect'},signal,'Inspect the existing browser')).toMatchObject({ok:true})
    expect(consume).toHaveBeenCalledWith({app:'chrome',pid:8,window:'right',tab:'tab1'})
    expect(f.invoke.mock.calls.filter(call=>call[1].operation==='activate')).toHaveLength(1)
    state.foreground=64;state.focused=false
    await expect(f.api.run({action:'inspect'},signal,'Inspect the existing browser')).rejects.toThrow('Focus the browser')
    expect(consume).toHaveBeenCalledTimes(1)
    state.foreground=27;consume.mockReturnValueOnce(false)
    await expect(f.api.run({action:'inspect'},signal,'Inspect the existing browser')).rejects.toThrow('Focus the browser')
    expect(f.invoke.mock.calls.filter(call=>call[1].operation==='activate')).toHaveLength(1)
  })
  it('uses measured document geometry on an extended display and rejects a whole-document extent',()=>{
    const control={x:10,y:20,width:50,height:25,viewWidth:1000,viewHeight:600,key:'target'}
    const win={x:-2050,y:20,width:2030,height:1320}
    const viewport={x:-2040,y:120,width:2000,height:1200}
    expect(pageControlBounds(viewport,win,control)).toEqual({x:-2020,y:160,width:100,height:50})
    expect(pageControlBounds({...viewport,height:2400},win,control)).toBeUndefined()
    expect(pageControlBounds(viewport,win,{...control,x:-25})).toBeUndefined()
  })
  it('preserves an uncertain result without retrying or switching to an isolated browser',async()=>{
    const {api,invoke}=setup()
    invoke.mockResolvedValueOnce(before).mockRejectedValueOnce(new Error('changed before input'))
    await expect(api.run({action:'window',operation:'new-tab'},signal,'open a new tab')).rejects.toThrow('changed')
    expect(invoke).toHaveBeenCalledTimes(2)
  })
  it('requires existing-window authorization even if the dedicated browser would be available',async()=>{
    const {api,allowed,launch,invoke}=setup();allowed.mockReturnValue(false)
    await expect(api.run({action:'window',operation:'new-tab',browser:'chrome'},signal,'new Chrome tab')).rejects.toThrow(/authorized/)
    expect(launch).not.toHaveBeenCalled();expect(invoke).not.toHaveBeenCalled()
  })
  it('asks for clarification when window/display selection is ambiguous',()=>{
    expect(()=>chooseWindow({...before,windows:before.windows.map(w=>({...w,focused:false}))})).toThrow(/Several/)
    expect(()=>chooseWindow(before,()=>false)).toThrow(/display/)
    expect(chooseWindow(before,w=>w.id==='left')?.id).toBe('left')
  })
  it('blocks a native webpage control if its document changes during approval',async()=>{
    const {api,page,nativePage,confirm}=setup()
    confirm.mockImplementationOnce(async()=>{nativePage.mockResolvedValue({...page,windowToken:'different'});return true})
    await expect(api.run({action:'click',label:'Run'},signal,'click Run')).rejects.toThrow(/moved/)
    expect(nativePage.mock.calls).toHaveLength(2)
  })
  it('checks the public page before reporting controls from the native adapter',async()=>{
    const {api,publicURL,confirm}=setup();publicURL.mockResolvedValue(false)
    await expect(api.run({action:'inspect'},signal,'inspect this page')).rejects.toThrow(/authorized public page/)
    expect(confirm).not.toHaveBeenCalled()
  })
  it('keeps static page text and actionable names in native inspection while withholding field values',async()=>{
    const actual=[
      {role:'AXWebArea',label:'web area',enabled:true}, {role:'AXGroup',label:'group',enabled:true},
      {role:'AXHeading',label:'heading',value:'Example search results',enabled:true},
      {role:'AXStaticText',label:'text',value:'Result description',enabled:true},
      {role:'AXLink',label:'First result',enabled:true}, {role:'AXTextField',label:'Search',value:'private query',enabled:true},
      {role:'AXTextField',label:'Password',value:'private field content',enabled:true},
    ]
    const {api}=setup(before,{nativePage:async()=>({ok:true,verified:true,message:'Inspected',pageURL:'https://example.com/',windowToken:'page',elements:actual})})
    const result=await api.run({action:'inspect'},signal,'inspect this page')
    expect(result?.data).toEqual({controls:[
      {role:'AXHeading',label:'heading',text:'Example search results',enabled:true},
      {role:'AXStaticText',label:'text',text:'Result description',enabled:true},
      {role:'AXLink',label:'First result',enabled:true}, {role:'AXTextField',label:'Search',enabled:true},
    ]})
  })
  it('requests a scoped observation when native inspection exposes only the page shell',async()=>{
    const {api}=setup(before,{nativePage:async()=>({ok:true,verified:true,message:'Inspected',pageURL:'https://example.com/',windowToken:'page',elements:[{role:'AXWebArea',label:'web area',enabled:true}]})})
    await expect(api.run({action:'inspect'},signal,'inspect this page')).rejects.toBeInstanceOf(ObservationRequired)
  })
  it.each(['AXComboBox','AXSearchField','ControlType.ComboBox'])('edits one observed %s even if its submit button shares the label',async role=>{
    const f=setup(),field={...f.page.elements[0],role,label:'Search'},button={...f.page.elements[0],label:'Search'}
    f.page.elements=[button,field]
    expect(await f.api.run({action:'type',label:'Search',text:'sample query'},signal,'search for sample query')).toMatchObject({ok:true})
    expect(f.nativePage).toHaveBeenCalledWith('chrome',{action:'set-text',label:'Search',text:'sample query',token:'page'},signal)
    expect(f.nativePage.mock.calls.some(call=>(call as unknown as [string,{action:string}])[1].action==='submit-search')).toBe(false)
  })
  it('keeps a hands-free search scoped to its semantic field without prompting on a mistaken control or query',async()=>{
    const controls=[
      {label:'Find',role:'AXComboBox',enabled:true,searchField:true},
      {label:'Message',role:'AXTextField',enabled:true},
      {label:'Send',role:'AXButton',enabled:true},
    ]
    const nativePage=vi.fn(async()=>({ok:true,verified:true,message:'Observed',pageURL:'https://example.com/',windowToken:'native',elements:controls}))
    const f=setup(before,{nativePage,handsFreeSearch:()=>true,allowSearch:(_scope,query)=>query==='quiet music'})
    const view=await f.api.run({action:'inspect'},signal,'search quiet music')
    expect(view?.data).toMatchObject({controls:[{label:'Find',searchField:true},{label:'Message'},{label:'Send'}]})
    for(const label of ['Message','Missing'])await expect(f.api.run({action:'type',label,text:'quiet music'},signal,'search quiet music')).rejects.toThrow(/search field/)
    await expect(f.api.run({action:'submit-search',label:'Find',text:'different'},signal,'search quiet music')).rejects.toThrow(/dictated query/)
    await expect(f.api.run({action:'click',label:'Send'},signal,'search quiet music')).rejects.toThrow(/own instruction/)
    expect(f.confirm).not.toHaveBeenCalled()
    expect(nativePage.mock.calls.every(call=>(call as unknown as [string,{action:string}])[1].action==='inspect')).toBe(true)
  })
  it.each(['stable','changed draft','replaced field'])('directs hands-free entry to the originally observed AX field even when passive focus changes (%s)',async scenario=>{
    const field={label:'Search',role:'AXComboBox',enabled:true,searchField:true,searchFieldId:'native-field',searchValueStamp:'private-draft-stamp',
      bounds:{x:12,y:5,width:200,height:25}}
    let generation=0
    const nativePage=vi.fn<NonNullable<ConstructorParameters<typeof ExistingBrowser>[0]['nativePage']>>(async(_app,request)=>{
      if(request.action==='set-search-text'){
        expect(JSON.parse(request.token!)).toMatchObject({pid:8,window:'right',tab:'tab1',url:'https://example.com/',document:'document',field:'native-field',
          searchValueStamp:'private-draft-stamp',paintedBounds:field.bounds})
        return {ok:true,verified:true,message:'Verified AX field value.'}
      }
      expect(request.action).toBe('inspect')
      return {ok:true,verified:true,message:'Observed',pageURL:'https://example.com/',pageReference:'document',windowToken:'focus-'+ ++generation,elements:[{...field}]}
    })
    const f=setup(before,{nativePage,handsFreeSearch:()=>true,allowSearch:()=>true,backgroundOwner:()=>'voice:field'})
    const snapshot=await f.api.run({action:'inspect'},signal,'search quiet music')
    expect(JSON.stringify(snapshot)).not.toMatch(/native-field|private-draft-stamp/)
    if(scenario==='changed draft')field.searchValueStamp='changed'
    if(scenario==='replaced field')field.searchFieldId='replacement'
    const typed=f.api.run({action:'type',label:'Search',text:'quiet music'},signal,'search quiet music')
    if(scenario==='stable')await expect(typed).resolves.toMatchObject({ok:true,verified:true})
    else await expect(typed).rejects.toThrow(/changed since inspection/)
    expect(nativePage.mock.calls.filter(([,r])=>r.action==='set-search-text')).toHaveLength(scenario==='stable'?1:0)
    expect(f.confirm).not.toHaveBeenCalled()
  })
  it('confirms a separate search submission, including the exact query, and preserves a failed verification',async()=>{
    const f=setup()
    f.page.elements=[{...f.page.elements[0],role:'AXComboBox',label:'Search'}]
    f.nativePage.mockImplementation(async(_app?:unknown,request?:{action:string})=>request?.action==='submit-search'
      ? {...f.page,ok:false,verified:false,inputIssued:true,message:'A results address was not observed.'}
      : {...structuredClone(f.page),windowToken:request?.action==='prepare-search'?'{"document":"1","field":"2"}':'volatile'})
    const command={action:'submit-search',label:'Search',text:'sample query'} as const
    f.confirm.mockResolvedValueOnce(false)
    await expect(f.api.run(command,signal,'search for sample query')).rejects.toThrow(/declined/)
    expect(f.confirm).toHaveBeenCalledWith('Submit the search “sample query” using “Search” at example.com?')
    expect(await f.api.run(command,signal,'search for sample query')).toMatchObject({ok:false,verified:false})
    await expect(f.api.run(command,signal,'search for sample query')).rejects.toThrow(/already submitted/)
    expect(f.nativePage.mock.calls.filter(call=>(call as unknown as [string,{action:string}])[1].action==='submit-search')).toHaveLength(1)
  })
  it('resolves fresh field bounds after consent and passes the painted position and stable field to the native guard',async()=>{
    let shifted=false
    const mark=vi.fn(async()=>({finish:vi.fn()})),f=setup(before,{mark})
    f.page.elements=[{...f.page.elements[0],role:'AXSearchField',label:'Search'}]
    f.confirm.mockImplementation(async()=>{shifted=true;return true})
    f.nativePage.mockImplementation(async(_app?:unknown,r?:{action:string,token?:string})=>{
      const view=structuredClone(f.page)
      view.elements[0].bounds.x=shifted?43:18
      view.windowToken=r?.action==='prepare-search'?'{"document":"D","field":"F"}':shifted?'new-title/other-focus':'before'
      if(r?.action==='submit-search')expect(JSON.parse(r.token!)).toMatchObject({document:'D',field:'F',paintedBounds:{x:43}})
      return view
    })
    expect(await f.api.run({action:'submit-search',label:'Search',text:'query'},signal,'search query')).toMatchObject({ok:true})
    expect(mark).toHaveBeenCalledWith(expect.objectContaining({bounds:expect.objectContaining({x:43})}),signal)
  })
  it('never submits on a replacement field with the same label or after a focused query mismatch',async()=>{
    const f=setup()
    f.page.elements=[{...f.page.elements[0],role:'AXSearchField',label:'Search'}]
    let first=true
    f.nativePage.mockImplementation(async(_app?:unknown,r?:{action:string})=>{
      const view=structuredClone(f.page)
      if(r?.action==='prepare-search'){view.windowToken=first?'{"field":"A"}':'{"field":"B"}';first=false}
      return view
    })
    await expect(f.api.run({action:'submit-search',label:'Search',text:'query'},signal,'search query')).rejects.toThrow(/field or document changed/)
    expect(f.nativePage.mock.calls.some(call=>(call as unknown as [string,{action:string}])[1].action==='submit-search')).toBe(false)
  })
  it.each(['same','different query','different owner','new document','unbound helper','revoked'])('uses only a matching recent native edit to bind a search submission: %s',async scenario=>{
    let owner='voice:first',doc='doc1'
    const field={label:'Search',role:'AXSearchField',enabled:true,searchField:true,bounds:{x:5,y:5,width:90,height:30}}
    const button={...field,label:'Submit',role:'AXButton',bounds:{x:95,y:5,width:40,height:30}}
    const identity=()=>({pid:8,window:'right',tab:'tab1',url:'https://example.com/',document:doc,field:'field1'})
    const mark=vi.fn(async()=>({finish:vi.fn()}))
    const nativePage=vi.fn(async(_app:unknown,r:{action:string;token?:string})=>{
      const common={ok:true,verified:true,message:'Verified',elements:[field],windowToken:'volatile',pageURL:'https://example.com/',pageReference:doc}
      if(r.action==='set-text')return {...common,windowToken:scenario==='unbound helper'?'volatile':JSON.stringify(identity())}
      if(r.action==='prepare-search'){
        const prior=JSON.parse(r.token!)
        return prior.field==='field1' && prior.document===doc
          ? {...common,elements:[button],windowToken:JSON.stringify(identity())}
          : {...common,ok:false,verified:false,message:'No Enter key was sent. The previously edited field is unavailable.'}
      }
      return common
    })
    const f=setup(before,{nativePage,backgroundOwner:()=>owner,allowSearch:()=>true,mark})
    const typed=await f.api.run({action:'type',label:'Search',text:'quiet music'},signal,'search for quiet music')
    expect(typed).toMatchObject({ok:true})
    expect(typed).not.toHaveProperty('windowToken')
    if(scenario==='different owner')owner='voice:other'
    if(scenario==='new document')doc='doc2'
    if(scenario==='revoked')f.api.forgetBackground(owner)
    const query=scenario==='different query'?'other music':'quiet music'
    const submitted=f.api.run({action:'submit-search',label:'Search',text:query},signal,'search for '+query)
    if(scenario==='same'){
      await expect(submitted).resolves.toMatchObject({ok:true,verified:true})
      expect(mark).toHaveBeenLastCalledWith(expect.objectContaining({click:true,bounds:button.bounds}),signal)
      expect(nativePage.mock.calls.filter(([,r])=>r.action==='submit-search')).toHaveLength(1)
    }else{
      await expect(submitted).rejects.toThrow(/No Enter key was sent/)
      expect(nativePage.mock.calls.some(([,r])=>r.action==='submit-search')).toBe(false)
    }
    expect(nativePage.mock.calls.filter(([,r])=>r.action==='set-text')).toHaveLength(1)
    expect(f.confirm).not.toHaveBeenCalled()
  })
  it('keeps a foreground-authorized native document scoped during background editing and only advances it on verified search navigation',async()=>{
    const state=structuredClone(before)
    const target=state.windows.find(w=>w.focused)!
    target.captureId='window:33:0';target.address='https://example.com/'
    const field={role:'AXSearchField',label:'Search',searchField:true,enabled:true}
    let url=target.address,document='AXdoc.1'
    const nativePage=vi.fn<NonNullable<ConstructorParameters<typeof ExistingBrowser>[0]['nativePage']>>(async (_app,request)=>{
      if(request.action.startsWith('background-')){
        expect(JSON.parse(request.token!)).toMatchObject({pid:8,window:'right',capture:'window:33:0',tab:'tab1',url,document})
      }
      if(request.action==='background-submit-search'){url='https://example.com/results?q=query';document='AXdoc.2'}
      return {ok:true,verified:true,message:'Fixture receipt',pageReference:document,pageURL:url,windowToken:'opaque',elements:[field]}
    })
    const f=setup(state,{nativePage,backgroundOwner:()=>'voice:owner',allowBackground:()=>true,allowSearch:(_scope,query)=>query==='query'})
    expect(await f.api.run({action:'inspect'},signal,'inspect')).not.toHaveProperty('pageReference')
    state.focused=false;state.foreground=24
    target.focused=false
    f.running.mockResolvedValue([{app:'test.editor',active:true}])
    await f.api.run({action:'type',label:'Search',text:'query'},signal,'search for query')
    await expect(f.api.run({action:'type',label:'Search',text:'other'},signal,'search for query')).rejects.toThrow(/exact query/)
    expect(await f.api.run({action:'submit-search',label:'Search',text:'query'},signal,'search for query')).not.toHaveProperty('pageURL')
    await f.api.run({action:'inspect'},signal,'inspect')
    expect(f.confirm).not.toHaveBeenCalled()
    expect(f.invoke.mock.calls.every(([,r])=>r.operation==='observe')).toBe(true)
    expect(nativePage.mock.calls.filter(([,r])=>r.action==='background-submit-search')).toHaveLength(1)
  })
  it('migrates interaction preferences without changing the existing browser choice',()=>{
    const prefs=settingsSchema.parse({computerUse:{browser:'embedded',visibleCursor:false}}).computerUse
    expect(prefs).toMatchObject({browser:'embedded',visibleCursor:false,highlightTargets:true,reuseBrowserWindows:true,applicationAwareness:true,animationSpeed:1,browserDebugPort:0})
  })
  it('returns valid voice receipts for trusted apps and keeps native window tokens private',async()=>{
    const app={key:'a'.repeat(64),name:'TextEdit',path:'/System/Applications/TextEdit.app'}
    const control={label:'Document',role:'AXTextArea',enabled:true}
    const installedAction=vi.fn(async(_app:unknown,kind:string)=>kind==='inspect'?
      {ok:true,message:'Inspected',elements:[control],windowToken:'native-window'}:
      {ok:true,status:'completed',message:'Already in the foreground'})
    const actions=voiceDesktopActions({installedAction} as never,{} as never,()=>true,{
      catalog:{resolve:async()=>app} as never,trusted:()=>true,confirm:async()=>true,
    })
    for(const kind of ['open','inspect','set_text']){
      const action=actions.find(a=>a.toolName==='athena_installed_'+kind)!
      expect(action.id).toMatch(/^athena\.[A-Za-z0-9.]+$/)
      const receipt=await action.run!({name:app.name,label:'Document',text:'Fixture'},{} as never,signal,async()=>{})
      expect(action.resultSchema.parse(receipt)).toEqual(kind==='inspect'?{ok:true,message:'Inspected',elements:[control]}:{ok:true,message:'Already in the foreground'})
    }
  })
})
