import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import {URL as FileURL} from 'node:url'
import {defaultSettings} from '../shared/settings'
import {InteractionOverlay} from '../electron/main/desktop/interactionOverlay'

const surface=vi.hoisted(()=>({visible:false,paintedAt:0,hiddenAt:0}))
vi.mock('electron',()=>{
  const display={id:1,bounds:{x:0,y:0,width:1200,height:900}}
  return {
    screen:{getDisplayMatching:()=>display,getDisplayNearestPoint:()=>display,getCursorScreenPoint:()=>({x:5,y:5}),on:vi.fn(),removeListener:vi.fn()},
    BrowserWindow:class{
      webContents={setWindowOpenHandler:vi.fn(),on:vi.fn(),executeJavaScript:async (js:string)=>{
        if(js.includes('requestAnimationFrame(resolve)')){surface.paintedAt=performance.now();return}
        return window.eval(js)
      }}
      setIgnoreMouseEvents(){} setAlwaysOnTop(){} setVisibleOnAllWorkspaces(){} setContentProtection(){}
      removeMenu(){} once(){} setBounds(){} async loadFile(){} isDestroyed(){return false}
      hide(){surface.visible=false;surface.hiddenAt=performance.now()}
      isVisible(){return surface.visible}
      showInactive(){surface.visible=true}
      destroy(){}
    }
  }
})
let overlay:InteractionOverlay
const rect={x:60,y:100,width:100,height:56}
const el=(id:string)=>document.getElementById(id)!
const flush=()=>new Promise<void>(resolve=>setTimeout(resolve,0))
beforeEach(()=>{
  surface.visible=false
  // jsdom serves bundled assets over HTTP; Electron loads this one from its package.
  vi.stubGlobal('URL',class extends FileURL {constructor(){super('file:///fixture/interactionOverlay.html')}})
  document.body.innerHTML='<div hidden id="frame"></div><div hidden id="pointer"><span></span></div><div hidden id="pulse"></div><div hidden id="activity"></div>'
  el('pulse').animate=vi.fn()
  overlay=new InteractionOverlay(()=>defaultSettings.computerUse)
})
afterEach(()=>{overlay.dispose();vi.unstubAllGlobals()})

it('holds a real target before input and through subsequent status-only verification, then returns to a cursor-free task indicator',async()=>{
  const signal=new AbortController().signal
  overlay.setTaskStatus('voice','Checking requested action')
  await flush()
  expect(surface.visible).toBe(true)
  expect(el('pointer').hidden).toBe(true)
  await overlay.reportTo(vi.fn(),async()=>{
    const mark=await overlay.begin({bounds:rect,label:'Select result',click:true},signal)
    expect(performance.now()-surface.paintedAt).toBeGreaterThanOrEqual(390)
    expect(el('pointer').hidden).toBe(false)
    expect(el('pulse').hidden).toBe(true)
    const confirmed=performance.now()
    mark.finish(true)
    const observation=await overlay.begin({label:'Observing Chrome'},signal)
    expect(el('pointer').hidden).toBe(false)
    expect(el('pulse').hidden).toBe(false)
    expect(el('activity').textContent).toContain('Observing Chrome')
    observation.finish(false)
    expect(surface.visible).toBe(true)
    await new Promise(resolve=>setTimeout(resolve,750))
    expect(el('pointer').hidden).toBe(false)
    await vi.waitFor(()=>expect(el('pointer').hidden).toBe(true),{timeout:900})
    expect(performance.now()-confirmed).toBeGreaterThanOrEqual(1000)
    expect(el('activity').textContent).toContain('Checking requested action')
  },'voice')
  overlay.endTask('voice')
  expect(surface.visible).toBe(false)
})

it('keeps cancellation and verified cursor feedback isolated between owners',async()=>{
  const stop=new AbortController()
  const other=new AbortController()
  overlay.setTaskStatus('voice','Checking voice request')
  const target=await overlay.reportTo(vi.fn(),()=>overlay.begin({bounds:rect,label:'Fill field',click:false},stop.signal),'chat')
  const status=await overlay.reportTo(vi.fn(),()=>overlay.begin({label:'Voice observation'},other.signal),'voice')
  expect(status.status).toBe('Another target is visible')
  expect(el('activity').textContent).toContain('Fill field')
  overlay.endTask('voice',true)
  await flush()
  expect(el('pointer').hidden).toBe(false)
  target.finish(true)
  stop.abort()
  expect(surface.visible).toBe(false)
  expect(el('pulse').hidden).toBe(true)
})

it('removes target feedback immediately on a failed recheck without emitting a ripple',async()=>{
  const mark=await overlay.begin({bounds:rect,label:'Click',click:true},new AbortController().signal)
  mark.finish(false)
  expect(surface.visible).toBe(false)
  expect(el('pulse').hidden).toBe(true)
})
