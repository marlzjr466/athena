import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { ComputerAction } from 'openai/resources/responses/responses'
import { APPLICATIONS, visualPointSchema, type AppIdentifier } from '../../../shared/desktopActions'
import { ChatError } from '../ai/AIProvider'
import type { VisualDriver } from '../ai/openAIAutomation'
import type { ScreenCapturePlatform, ScreenImage, WindowInput } from '../screenCapture/screenCapturePlatform'
import type { DesktopTools } from './desktopTools'
import { browserApps, workspaceStateSchema, windowRequest, type WorkspaceInvoke, type WorkspaceWindow } from './desktopContext'

export interface WindowDriverServices {
  recipient?: 'codex'
  /** Main-process grant set scoped to one live voice session. */
  codexWindowGrants?: Set<string>
  platform: ScreenCapturePlatform
  workspace: WorkspaceInvoke
  desktop: Pick<DesktopTools,'inspectAccessibleUI'|'setAccessibleText'|'pressShortcut'>
  allowed(app:AppIdentifier,input:boolean,clipboard:boolean):boolean
  confirm(title:string,detail:string,signal:AbortSignal):Promise<boolean>
  athenaPid:number
  sameTarget?(before:ScreenImage,after:ScreenImage,point:{x:number;y:number}):boolean
  observing?(app:AppIdentifier,signal:AbortSignal):Promise<void>
  stopObserving?():void
}
const normalizedKeys:Record<string,string>={'ctrl+a':'select-all','cmd+a':'select-all','ctrl+c':'copy','cmd+c':'copy','ctrl+v':'paste','cmd+v':'paste','ctrl+s':'save','cmd+s':'save','ctrl+z':'undo','cmd+z':'undo','ctrl+y':'redo','cmd+shift+z':'redo','enter':'enter','esc':'escape','escape':'escape','tab':'tab'}
function selectedTab(win:WorkspaceWindow) {
  const tabs=win.tabs ?? [], matches=tabs.filter(tab=>tab.selected)
  if(matches.length!==1 || !matches[0].id || tabs.filter(tab=>tab.id===matches[0].id).length!==1)return
  return matches[0].id
}
export async function approvedWindowDriver(s:WindowDriverServices,app:AppIdentifier,objective:string,gate:()=>Promise<void>,signal:AbortSignal,observedWindow:Record<string,unknown>={}):Promise<VisualDriver> {
  const application=APPLICATIONS[app], platform=s.platform
  if (app==='terminal' || !s.allowed(app,false,false) || !platform.captureWindow || !platform.windows)throw new ChatError('Enable vision, Screen observation, authorized application detection and OS screen access to share an application window.')
  const text=objective.toLowerCase()
  if(!text.includes(app) && !text.includes(application.name.toLowerCase()) && !/\b(?:current|active|focused|this|my) (?:app|window|screen)\b/i.test(text) && observedWindow.application!==application.name)throw new ChatError('Name the application or explicitly select the current window for visual control.')
  const browser=browserApps.some(id=>id===app)
  const observe=async(active=signal)=>workspaceStateSchema.parse(await s.workspace(app,{operation:'observe',details:true,tabs:browser},active))
  await gate()
  let initial=await observe()
  if(!initial.focused && initial.foreground===s.athenaPid && initial.pid===observedWindow.pid && application.name===observedWindow.application){
    const prior=initial.windows.find(w=>w.id===observedWindow.window && w.captureId && w.captureId===observedWindow.capture && !w.hidden && !w.minimized)
    if(prior && (!browser || selectedTab(prior) && (observedWindow.tab===undefined || observedWindow.tab===selectedTab(prior)))){
      await gate()
      await s.workspace(app,{operation:'activate',...windowRequest(initial,prior),details:true},signal)
      initial=await observe()
      if(initial.pid!==observedWindow.pid || !initial.windows.some(w=>w.focused && w.id===prior.id && w.captureId===prior.captureId && (!browser || selectedTab(w)===selectedTab(prior))))
        throw new ChatError('The window changed while automation was awaiting approval.')
    }
  }
  const target=initial.windows.find(w=>w.focused && !w.minimized && !w.hidden)
  if(!initial.focused || initial.pid<=0 || !target?.id || !target.captureId)throw new ChatError('Focus the target window. Athena needs an unambiguous visible window before sharing it.')
  const tab=selectedTab(target)
  if(browser && !tab)throw new ChatError('The browser does not expose a unique selected tab. Focus an identifiable tab before sharing this window.')
  if((observedWindow.pid!==undefined && observedWindow.pid!==initial.pid) || (observedWindow.window!==undefined && observedWindow.window!==target.id)
     || (observedWindow.capture!==undefined && observedWindow.capture!==target.captureId) || (observedWindow.tab!==undefined && observedWindow.tab!==tab))
    throw new ChatError('The observed window or tab changed. Select the intended target again.')
  const display=(await platform.windows(signal)).find(w=>w.id===target.captureId)
  if(!display)throw new ChatError('The selected window cannot be captured. Check Screen Recording permission.')
  const grants=s.recipient==='codex'?s.codexWindowGrants:undefined
  const grant=JSON.stringify([app,initial.pid,target.id,display.id,tab])
  if(browser && grants){
    const prefix=JSON.stringify([app,initial.pid,target.id,display.id]).slice(0,-1)+','
    for(const existing of grants)if(existing.startsWith(prefix) && existing!==grant)grants.delete(existing)
  }
  let revoked=false
  const scopeChanged=(message:string):never=>{
    revoked=true
    grants?.delete(grant)
    throw new ChatError(message)
  }
  const same=async(input=false,clipboard=false,active=signal)=>{
    active.throwIfAborted()
    if(revoked)throw new ChatError('The approved window or tab changed. Share the intended target again.')
    await gate()
    if(!s.allowed(app,input,clipboard))throw new ChatError('Automation or operating-system permission changed.')
    const state=await observe(active)
    const current=state.windows.find(w=>w.id===target.id && w.captureId===display.id)
    if(state.pid!==initial.pid || !current)return scopeChanged('The authorized window was replaced or closed. Share the intended window again.')
    if(browser && selectedTab(current)!==tab)return scopeChanged('The selected browser tab changed. Share the intended tab again.')
    if(!state.focused || !current.focused || current.hidden || current.minimized)throw new ChatError('The focused window changed. Refocus the intended target before continuing.')
    return state
  }
  const approve=async(title:string,detail:string,active=signal)=>{
    await same(false,false,active)
    if(!await s.confirm(title,detail,active))throw new ChatError('The window operation was declined.')
    active.throwIfAborted()
    await gate()
    const now=await observe(active)
    // Only restore focus taken by Athena's approval sheet, to the exact original window.
    if(now.foreground===s.athenaPid && now.pid===initial.pid){
      const restore=now.windows.find(w=>w.id===target.id && w.captureId===display.id)
      if(!restore || (browser && selectedTab(restore)!==tab))return scopeChanged('The approved window or tab changed during confirmation. Share the intended target again.')
      await s.workspace(app,{operation:'activate',...windowRequest(now,restore),details:true},active)
    }
    await same(false,false,active)
    return true
  }
  const retention=s.recipient==='codex'
    ? 'Window images are sent to your ChatGPT subscription and may be retained in this native Codex thread.'
    : 'Window images stay out of local history.'
  if(!grants?.has(grant)){
    const scope=grants?'when needed for commands during this voice session':'while performing this task'
    await approve(s.recipient==='codex'?'Share this window with Codex?':'Share this window with OpenAI?',application.name+' — '+display.name+'\nAthena will send snapshots of this window '+scope+'. Visible messages or private fields may be included. Each proposed input is shown for approval. '+retention)
    grants?.add(grant)
  }
  let observing=false
  const stopObserving=()=>{if(observing){observing=false;s.stopObserving?.()}}
  const capture=async(active:AbortSignal)=>{
    await same(false,false,active)
    await s.observing?.(app,active)
    observing=true
    // Titles change during navigation. Bind a fresh native capture descriptor to
    // the independently checked AX/UIA window and selected tab before every image.
    const liveDisplay=(await platform.windows!(active)).find(w=>w.id===display.id)
    if(!liveDisplay)return scopeChanged('The authorized capture window closed. Share the intended window again.')
    await same(false,false,active)
    const [image]=await platform.captureWindow!(liveDisplay,active)
    await same(false,false,active)
    if(!image?.dataURL || image.display.id!==display.id)throw new ChatError('The selected window returned no valid image.')
    return image
  }
  let observed:ScreenImage|undefined
  const fresh=(a:ScreenImage,b:ScreenImage)=>a.width===b.width && a.height===b.height && a.dataURL===b.dataURL
  return {
    dispose:stopObserving,
    stopObserving,
    target:{pid:initial.pid,window:target.id,capture:display.id},
    capture:async current=>{observed=await capture(AbortSignal.any([signal,current]));return observed.dataURL},
    approveChecks:(details,current)=>approve('Review OpenAI computer safety checks',details.join('\n').slice(0,1800),AbortSignal.any([signal,current])),
    run:async(action:ComputerAction,current:AbortSignal)=>{
      const active=AbortSignal.any([signal,current])
      active.throwIfAborted()
      const previous=observed
      if(!previous || !s.allowed(app,true,false))throw new ChatError('Authorize keyboard and mouse control before issuing input.')
      if('keys' in action && action.keys?.length && action.type!=='keypress')throw new ChatError('Modified pointer input is unsupported. Inspect the control using Accessibility.')
      let operation:WindowInput|undefined,shortcut='',typed:string|undefined
      if(action.type==='type') {
        if(!action.text.length || action.text.length>4000 || !objective.includes(action.text))throw new ChatError('Text entry requires the exact text in the user’s instruction.')
        typed=action.text
      } else if(action.type==='keypress') {
        const keys=action.keys.map(k=>k.toLowerCase().replace(/^(control|command|super|return)$/,(v)=>({control:'ctrl',command:'cmd',super:'cmd',return:'enter'})[v]!))
        shortcut=normalizedKeys[keys.join('+')]
        if(!shortcut)throw new ChatError('That key combination is outside the allowed desktop shortcuts.')
      } else if(action.type==='click'||action.type==='double_click'||action.type==='move'||action.type==='scroll'||action.type==='drag') {
        if(action.type==='click' && action.button!=='left')throw new ChatError('This window driver supports the primary mouse button.')
        const path=action.type==='drag'? z.array(visualPointSchema).min(2).max(100).parse(action.path):undefined
        const from=visualPointSchema.parse(action.type==='drag'?path![0]:{x:action.x,y:action.y})
        if([from,...path??[]].some(p=>p.x>=previous.width || p.y>=previous.height))throw new ChatError('The requested point is outside the approved window.')
        operation={app,captureId:randomUUID(),label:action.type,operation:action.type,from,to:path?.at(-1),path}
        if(action.type==='scroll'){
          const delta=z.number().int().min(-2400).max(2400)
          operation.scrollX=delta.parse(action.scroll_x);operation.scrollY=delta.parse(action.scroll_y)
        }
      } else throw new ChatError('Unsupported visual input.')
      await approve('Allow this action in '+application.name+'?',previous.display.name+'\n'+JSON.stringify(action).slice(0,650)+'\nReview the target and its effects before approving.',active)
      const clipboard=['copy','paste'].includes(shortcut)
      await same(true,clipboard,active)
      const before=await capture(active)
      const stable=operation && operation.operation!=='drag' && s.sameTarget?s.sameTarget(previous,before,operation.from):fresh(previous,before)
      if(!stable)throw new ChatError('The interaction target changed since the model observed it. No input was issued.')
      if(operation) {
        if(!platform.point)throw new ChatError('Pointer control is unavailable on this platform.')
        await same(true,clipboard,active);await platform.point(before,operation,active)
      } else {
        const view=await s.desktop.inspectAccessibleUI(app,active)
        const field=view.elements.filter(e=>e.focused && e.enabled)
        await same(true,clipboard,active)
        if(typed!==undefined && (field.length!==1 || !field[0].label))throw new ChatError('Focus one accessible, labelled text field before dictating.')
        const result=typed===undefined?await s.desktop.pressShortcut(app,shortcut,active):await s.desktop.setAccessibleText(app,field[0].label,typed,active)
        if(!result.ok)throw new ChatError(result.message)
      }
      await same(true,clipboard,active)
      const after=await capture(active)
      observed=after
      const changed=!fresh(before,after)
      return {applied:changed || action.type==='move',evidence:changed?'The approved window visibly changed.':action.type==='move'?'Pointer moved to the verified window position.':'Input was delivered, but its effect was not verified. Inspect before retrying.'}
    },
  }
}
