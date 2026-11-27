import { AsyncLocalStorage } from 'node:async_hooks'
import { BrowserWindow, screen, type Display } from 'electron'
import { fileURLToPath } from 'node:url'
import type { Settings } from '../../../shared/settings'
import type { DesktopRect } from '../../../shared/desktopActions'
import { setTimeout as delay } from 'node:timers/promises'

type Options=Settings['computerUse']
type Mark={id:number;owner?:string;label:string;rect?:DesktopRect;display:Display;release:()=>void;timer?:ReturnType<typeof setTimeout>;suspended?:boolean}
const TARGET_APPROACH_MS=400
const VERIFIED_TARGET_MS=1100
export interface InteractionTarget { bounds?:DesktopRect; displayBounds?:DesktopRect; nativePixels?:boolean; label:string; click?:boolean }
export interface InteractionHandle { status?:string; suspend?():void; finish(verified:boolean):void }
export function screenRect(bounds:DesktopRect,nativePixels=false):DesktopRect {
  if(!nativePixels || process.platform!=='win32')return bounds
  return screen.screenToDipRect(null,bounds)
}
/** This window has no preload, IPC privileges, pointer handling, keyboard focus or screen input. */
export class InteractionOverlay {
  private window?:BrowserWindow
  private ready?:Promise<void>
  private sequence=0
  private revision=0
  private target?:Mark
  private activity?:Mark
  private task?:{id:string;label:string;display:Display}
  private painting:Promise<void>=Promise.resolve()
  private display?:number
  private readonly reporter=new AsyncLocalStorage<{report:(status:string)=>void;owner?:string}>()
  reportTo<T>(report:(status:string)=>void,run:()=>Promise<T>,owner?:string):Promise<T>{return this.reporter.run({report,owner},run)}
  constructor(private settings:()=>Options){}
  private readonly moved=()=>this.hide()
  private create(display:Display) {
    if(!this.window || this.window.isDestroyed()){
      const win=new BrowserWindow({...display.bounds,show:false,transparent:true,frame:false,hasShadow:false,focusable:false,skipTaskbar:true,
        resizable:false,movable:false,fullscreenable:false,acceptFirstMouse:false,roundedCorners:false,enableLargerThanScreen:true,
        webPreferences:{sandbox:true,nodeIntegration:false,contextIsolation:true,devTools:false,backgroundThrottling:false}})
      win.setIgnoreMouseEvents(true)
      win.setAlwaysOnTop(true,'screen-saver')
      if(process.platform==='darwin')win.setVisibleOnAllWorkspaces(true,{visibleOnFullScreen:true,skipTransformProcessType:true})
      win.setContentProtection(true)
      win.removeMenu()
      win.webContents.setWindowOpenHandler(()=>({action:'deny'}))
      win.webContents.on('will-navigate',event=>event.preventDefault())
      this.window=win
      this.ready=win.loadFile(fileURLToPath(new URL('./interactionOverlay.html',import.meta.url)))
      screen.on('display-metrics-changed',this.moved);screen.on('display-removed',this.moved)
      win.once('closed',()=>{screen.removeListener('display-metrics-changed',this.moved);screen.removeListener('display-removed',this.moved)})
    }
    if(this.display!==display.id){this.window.setBounds(display.bounds);this.display=display.id}
    return this.window
  }
  private drop(layer:'target'|'activity'){
    const mark=this[layer]
    if(mark){mark.release();clearTimeout(mark.timer);this[layer]=undefined}
  }
  private async update(){
    const revision=++this.revision,settings=this.settings()
    const target=this.target,activity=this.activity,task=this.task
    const display=target?.display??activity?.display??task?.display
    if(!display || target?.suspended || !settings.enabled || !(settings.visibleCursor || (settings.highlightTargets && target))){
      if(this.window&&!this.window.isDestroyed())this.window.hide()
      this.painting=Promise.resolve()
      return this.painting
    }
    const win=this.create(display)
    // Activity may change while a confirmed click is still visible. Only show
    // concurrent feedback together when ownership and monitor match.
    const sameOwner=activity && (!target || (target.owner===activity.owner && display.id===activity.display.id && activity.id>target.id))
    const label=(sameOwner?activity?.label:undefined)??target?.label??task?.label??''
    const r=target?.rect
    const data={id:target?.id??0,r:r&&{...r,x:r.x-display.bounds.x,y:r.y-display.bounds.y},
      label,cursor:settings.visibleCursor,highlight:settings.highlightTargets,
      speed:settings.smoothCursor?Math.round(140/settings.animationSpeed):0}
    this.painting=(async()=>{
      await this.ready
      if(revision!==this.revision||win.isDestroyed())return
      await win.webContents.executeJavaScript('('+draw.toString()+')('+JSON.stringify(data)+')')
      if(revision===this.revision&&!win.isDestroyed()&&!win.isVisible())win.showInactive()
    })()
    return this.painting
  }
  setTaskStatus(id:string,label:string){
    if(!this.settings().enabled || !this.settings().visibleCursor)return
    const display=this.task?.id===id?this.task.display:screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    this.task={id,label:label.slice(0,100),display}
    void this.update().catch(()=>{})
  }
  endTask(id:string,immediate=false){
    if(this.task?.id===id)this.task=undefined
    if(immediate){
      if(this.target?.owner===id)this.drop('target')
      if(this.activity?.owner===id)this.drop('activity')
    }
    void this.update().catch(()=>{})
  }
  async begin(target:InteractionTarget,signal:AbortSignal):Promise<InteractionHandle> {
    const settings=this.settings(),context=this.reporter.getStore()
    const noop={status:'Disabled or superseded',finish:()=>{}}
    if(signal.aborted || !settings.enabled || !settings.visibleCursor && !(target.bounds && settings.highlightTargets))return noop
    const rect=target.bounds && screenRect(target.bounds,target.nativePixels)
    const placement=rect??(target.displayBounds && screenRect(target.displayBounds,target.nativePixels))
    const owner=context?.owner
    const active=owner && this.task?.id===owner?this.task:undefined
    const display=placement?screen.getDisplayMatching(placement):active?.display??screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    if(active)active.display=display
    const layer=rect?'target':'activity'
    this.drop(layer)
    const abort=()=>{
      if(this[layer]!==mark)return
      this.drop(layer)
      void this.update().catch(()=>{})
    }
    const mark:Mark={id:++this.sequence,owner,label:target.label.slice(0,64),rect,display,release:()=>signal.removeEventListener('abort',abort)}
    this[layer]=mark
    signal.addEventListener('abort',abort,{once:true})
    try{
      await this.update()
      // A task update racing the new draw may have superseded the renderer call.
      await this.painting
      const win=this.window
      if(this[layer]!==mark || signal.aborted || !win || win.isDestroyed())return noop
      const visible=!!rect || !this.target || this.target.owner===owner && this.target.display.id===display.id
      if(visible){
        await win.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
        if(rect)await delay(Math.max(TARGET_APPROACH_MS,settings.smoothCursor?140/settings.animationSpeed:0),undefined,{signal})
        if(this[layer]!==mark || signal.aborted || win.isDestroyed())return noop
        if(win.isVisible())context?.report(rect?'Target cursor / outline painted':'Activity indicator painted')
      }
      let ended=false
      return {status:visible?(rect?'Painted target feedback':'Painted activity status (API action; no pointer target)'):'Another target is visible',suspend:()=>{
        if(this.target===mark && !ended){mark.suspended=true;void this.update().catch(()=>{})}
      },finish:verified=>{
        if(ended || this[layer]!==mark || win.isDestroyed())return
        ended=true
        if(!verified){abort();return}
        const resume=mark.suspended
        mark.suspended=false
        const settled=resume?this.update():Promise.resolve()
        void settled.then(()=>{
          if(this.target===mark && target.click && settings.clickRipple && settings.visibleCursor && !win.isDestroyed())
            return win.webContents.executeJavaScript('('+ripple.toString()+')('+mark.id+')')
        }).catch(()=>{})
        if(!rect){mark.label='Completed '+mark.label;void this.update().catch(()=>{})}
        mark.timer=setTimeout(abort,rect?VERIFIED_TARGET_MS:900)
      }}
    }catch(error){abort();throw error}
  }
  nativeWindowId(){
    if(!this.window || this.window.isDestroyed() || !this.window.isVisible())return undefined
    const match=/^window:(\d+):/.exec(this.window.getMediaSourceId())
    return match?Number(match[1]):undefined
  }
  status(){return {visible:!!this.window && !this.window.isDestroyed() && this.window.isVisible(),created:!!this.window && !this.window.isDestroyed()}}
  hide(){this.revision++;this.drop('target');this.drop('activity');this.task=undefined;if(!this.window?.isDestroyed())this.window?.hide()}
  dispose(){this.hide();this.window?.destroy();this.window=undefined}
}
function draw({id,r,label,cursor,highlight,speed}:{id:number;r?:DesktopRect;label:string;cursor:boolean;highlight:boolean;speed:number}) {
  const frame=document.getElementById('frame')!, pointer=document.getElementById('pointer')!, activity=document.getElementById('activity')!,pulse=document.getElementById('pulse')!
  activity.hidden=!cursor
  activity.textContent='Athena · '+label
  // A status-only repaint must not restart a pointer approach or a live ripple.
  const key=String(id)+':'+cursor+':'+highlight
  if(pointer.dataset.target===key)return
  pointer.dataset.target=key
  frame.hidden=!r || !highlight;pointer.hidden=!r || !cursor;pointer.style.display=r && cursor?'flex':'none';pulse.hidden=true
  if(!r)return
  Object.assign(frame.style,{left:r.x+'px',top:r.y+'px',width:r.width+'px',height:r.height+'px'})
  const x=Math.max(0,Math.min(innerWidth-1,r.x+r.width/2)),y=Math.max(0,Math.min(innerHeight-1,r.y+r.height/2))
  pointer.style.transition=pointer.style.transform?'transform '+speed+'ms ease-out':'none'
  pointer.style.transform='translate('+x+'px,'+y+'px)'
  const tag=pointer.querySelector('span')!
  tag.textContent='Athena'
  tag.style.left=x+108>innerWidth?'auto':'17px'
  tag.style.right=x+108>innerWidth?'6px':'auto'
  tag.style.top=y+48>innerHeight?'-22px':'18px'
  pulse.style.left=(x-14)+'px';pulse.style.top=(y-14)+'px'
}
function ripple(id:number){if(document.getElementById('pointer')?.dataset.target?.split(':')[0]!==String(id))return;const pulse=document.getElementById('pulse')!;pulse.hidden=false;pulse.animate([{opacity:1,transform:'scale(.3)'},{opacity:0,transform:'scale(1.4)'}],{duration:450})}
