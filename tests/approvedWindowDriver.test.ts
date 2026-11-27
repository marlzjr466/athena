import { describe, expect, it, vi } from 'vitest'
import { approvedWindowDriver } from '../electron/main/desktop/approvedWindowDriver'
import { APPLICATIONS } from '../shared/desktopActions'

function fixture(codexWindowGrants?:Set<string>) {
  const signal=new AbortController().signal
  const display={id:'window:11:0',name:'Disposable window',width:300,height:200}
  const win={id:'front',captureId:display.id,focused:true,minimized:false,hidden:false,maximized:false,tabs:[{id:'tab-1',title:'First tab',selected:true}]}
  const state={running:true,focused:true,pid:40,foreground:40,windows:[win]}
  let pixels='before'
  const point=vi.fn(async()=>{pixels='after'})
  const allowed=vi.fn(()=>true),confirm=vi.fn(async()=>true)
  const captureWindow=vi.fn(async(descriptor:typeof display)=>{
    if(descriptor.name!==display.name || descriptor.id!==display.id)throw Error('The authorized window changed or closed.')
    return [{display:{...display},dataURL:pixels,width:300,height:200,capturedAt:Date.now()}]
  })
  const workspace=vi.fn(async(_app:unknown,request:{operation:string})=>{
    if(request.operation==='activate'){state.foreground=40;state.focused=true}
    return structuredClone(state)
  })
  const services={athenaPid:70,allowed,confirm,workspace,...(codexWindowGrants?{recipient:'codex' as const,codexWindowGrants}:{}),
    desktop:{inspectAccessibleUI:vi.fn(),setAccessibleText:vi.fn(),pressShortcut:vi.fn()},
    platform:{captureWindow,point,windows:async()=>[{...display}],capture:vi.fn(),displays:()=>[],dispose:vi.fn()}}
  return {display,state,point,allowed,confirm,captureWindow,workspace,signal,
    changePixels:()=>{pixels='changed outside Athena'},
    open:(observed?:Record<string,unknown>)=>approvedWindowDriver(services,'chrome','Click the button in Chrome',async()=>{},signal,observed)}
}
const click={type:'click',button:'left',x:110,y:60} as const
describe('authorized window driver',()=>{
  it('captures an updated title in the same native window and tab after input',async()=>{
    const f=fixture(),driver=await f.open()
    await driver.capture(f.signal)
    f.point.mockImplementationOnce(async()=>{f.display.name='Updated page title';f.state.windows[0].tabs[0].title='Updated page title';f.changePixels()})
    expect(await driver.run(click,f.signal)).toMatchObject({applied:true})
    expect(f.captureWindow.mock.calls.at(-1)?.[0].name).toBe('Updated page title')
    await driver.run(click,f.signal)
    expect(f.point).toHaveBeenCalledTimes(2)
    expect(f.workspace.mock.calls[0][1]).toMatchObject({operation:'observe',tabs:true})
  })
  it('revokes the previous tab on a switch even with an identical window title',async()=>{
    const grants=new Set<string>(),f=fixture(grants),driver=await f.open()
    await driver.capture(f.signal)
    f.state.windows[0].tabs[0].id='different-tab'
    await expect(driver.run(click,f.signal)).rejects.toThrow(/tab changed/)
    expect(f.point).not.toHaveBeenCalled()
    expect(grants.size).toBe(0)
    await (await f.open()).capture(f.signal)
    expect(f.confirm).toHaveBeenCalledTimes(2)
    f.state.windows[0].tabs[0].id='tab-1'
    await expect(driver.capture(f.signal)).rejects.toThrow(/Share the intended/)
    await (await f.open()).capture(f.signal)
    expect(f.confirm).toHaveBeenCalledTimes(3)
  })
  it('withholds images if the tab changes during capture',async()=>{
    const f=fixture(),driver=await f.open()
    const capture=f.captureWindow.getMockImplementation()!
    f.captureWindow.mockImplementationOnce(async descriptor=>{
      const result=await capture(descriptor)
      f.state.windows[0].tabs[0].id='replacement'
      return result
    })
    await expect(driver.capture(f.signal)).rejects.toThrow(/tab changed/)
    expect(f.point).not.toHaveBeenCalled()
  })
  it('rejects a replaced native window and a stale preselected tab',async()=>{
    const f=fixture()
    await expect(f.open({application:APPLICATIONS.chrome.name,pid:40,window:'front',capture:f.display.id,tab:'previous-tab'})).rejects.toThrow(/observed window or tab changed/)
    const driver=await f.open()
    await driver.capture(f.signal)
    f.state.windows[0].id='another-window'
    await expect(driver.run(click,f.signal)).rejects.toThrow(/replaced or closed/)
    expect(f.point).not.toHaveBeenCalled()
  })
  it('requires a unique selected browser tab before sharing',async()=>{
    const f=fixture()
    f.state.windows[0].tabs=[]
    await expect(f.open()).rejects.toThrow(/unique selected tab/)
    f.state.windows[0].tabs=[{id:'1',title:'A',selected:true},{id:'2',title:'B',selected:true}]
    await expect(f.open()).rejects.toThrow(/unique selected tab/)
    expect(f.captureWindow).not.toHaveBeenCalled()
    expect(f.confirm).not.toHaveBeenCalled()
  })
  it('shares the exact window during one consented Codex voice session and requires a new grant after the window or session changes',async()=>{
    const grants=new Set<string>(),f=fixture(grants)
    const first=await f.open()
    await first.capture(f.signal);first.dispose?.()
    expect(f.confirm).toHaveBeenCalledOnce()
    await (await f.open()).capture(f.signal)
    expect(f.confirm).toHaveBeenCalledOnce()
    f.state.windows[0].id='replacement'
    await (await f.open()).capture(f.signal)
    expect(f.confirm).toHaveBeenCalledTimes(2)
    grants.clear()
    await f.open()
    expect(f.confirm).toHaveBeenCalledTimes(3)
  })
  it('honors per-operation cancellation on an already approved scope',async()=>{
    const f=fixture(),driver=await f.open(),cancelled=new AbortController()
    await driver.capture(f.signal)
    cancelled.abort()
    await expect(driver.run(click,cancelled.signal)).rejects.toThrow()
    expect(f.point).not.toHaveBeenCalled()
    expect(f.confirm).toHaveBeenCalledOnce()
  })
  it('requires a current image and verifies the post-action change',async()=>{
    const f=fixture(),driver=await f.open()
    await expect(driver.run(click,f.signal)).rejects.toThrow()
    await driver.capture(f.signal)
    expect(await driver.run(click,f.signal)).toMatchObject({applied:true})
    expect(f.point).toHaveBeenCalledOnce()
    expect(f.confirm).toHaveBeenCalledTimes(2)
  })
  it('rejects changed pixels and revoked permissions before issuing input',async()=>{
    const f=fixture(),driver=await f.open()
    await driver.capture(f.signal);f.changePixels()
    await expect(driver.run(click,f.signal)).rejects.toThrow(/changed/)
    f.allowed.mockReturnValue(false)
    await expect(driver.capture(f.signal)).rejects.toThrow(/permission/)
    expect(f.point).not.toHaveBeenCalled()
  })
  it('restores only the previously verified window after an Athena approval takes focus',async()=>{
    const f=fixture()
    f.state.focused=false;f.state.foreground=70
    const prior={application:APPLICATIONS.chrome.name,pid:40,window:'front',capture:'window:11:0'}
    await expect(f.open({...prior,window:'another'})).rejects.toThrow(/Focus/)
    expect(f.workspace.mock.calls.some(([,query])=>query.operation==='activate')).toBe(false)
    const driver=await f.open(prior)
    expect(driver.target).toEqual({pid:40,window:'front',capture:'window:11:0'})
    f.state.focused=false;f.state.foreground=91
    await expect(driver.capture(f.signal)).rejects.toThrow(/focused window changed/)
    expect(f.point).not.toHaveBeenCalled()
  })
})
