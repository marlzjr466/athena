import type { VoiceBrowserAction } from '../../../shared/voiceBrowser'
/** Resolve an implicit reference only when the previous observation had one enabled button. */
export function uniqueObservedButton(data:unknown):string|undefined {
  const controls = (data as {controls?:Array<{role:string;label:string;enabled:boolean}>}|undefined)?.controls
  const buttons = controls?.filter(control=>control.enabled && control.role==='button' && control.label)
  return buttons?.length===1 ? buttons[0].label : undefined
}
export type BrowserFeedback = {visibleCursor:boolean;highlightTargets:boolean;smoothCursor:boolean;clickRipple:boolean;animationSpeed:number}
function decorate(element:Element, action:string, settings?:BrowserFeedback) {
  if(!settings || !settings.visibleCursor && !settings.highlightTargets)return {stop:()=>{},clicked:()=>{}}
  const host=document.createElement('div')
  host.setAttribute('aria-hidden','true')
  host.style.cssText='all:initial;position:fixed;inset:0;pointer-events:none!important;z-index:2147483647'
  const root=host.attachShadow({mode:'closed'}), box=document.createElement('div'), cursor=document.createElement('div'),pulse=document.createElement('div')
  box.style.cssText='position:fixed;border:2px solid #78deeb;background:#71dbea10;border-radius:6px;box-sizing:border-box'
  cursor.textContent='➤  Athena · '+action
  cursor.style.cssText='position:fixed;top:0;left:0;border-radius:8px;padding:3px 8px;background:#122430;color:#c5f6fb;font:600 12px system-ui;white-space:nowrap;'
  pulse.style.cssText='position:fixed;width:25px;height:25px;border:2px solid #89e5f0;border-radius:100%;display:none'
  if(settings.highlightTargets)root.append(box)
  if(settings.visibleCursor)root.append(cursor,pulse)
  document.documentElement.append(host)
  let frame=0
  const track=()=>{
    if(!element.isConnected || !host.isConnected){host.remove();return}
    const r=element.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2
    Object.assign(box.style,{left:r.x+'px',top:r.y+'px',width:r.width+'px',height:r.height+'px'})
    cursor.style.transform='translate('+x+'px,'+y+'px)'
    pulse.style.left=(x-12)+'px';pulse.style.top=(y-12)+'px'
    frame=requestAnimationFrame(track)
  }
  track()
  if(settings.smoothCursor)cursor.style.transition='transform '+Math.round(140/settings.animationSpeed)+'ms ease-out'
  const stop=()=>{cancelAnimationFrame(frame);host.remove()}
  const timer=setTimeout(stop,1200)
  return {stop:()=>{clearTimeout(timer);stop()},clicked:()=>{if(settings.visibleCursor && settings.clickRipple){pulse.style.display='block';pulse.animate([{opacity:1,transform:'scale(.3)'},{opacity:0,transform:'scale(1.4)'}],{duration:180})}}}
}
/** Static allowlisted DOM operations; arguments are JSON data, never model-generated JavaScript. */
export function browserActionScript(command: VoiceBrowserAction, expectedURL: string, feedback?:BrowserFeedback, actionId?:string, targetOnly=false, expectedTarget?:string): string {
  return `(${browserDOMAction.toString()})(${JSON.stringify(command)},${JSON.stringify(expectedURL)},${decorate.toString()},${JSON.stringify(feedback)},${JSON.stringify(actionId)},${targetOnly},${JSON.stringify(expectedTarget)})`
}
async function browserDOMAction(command: VoiceBrowserAction, expectedURL: string, mark:typeof decorate,feedback?:BrowserFeedback,actionId?:string,targetOnly=false,expectedTarget?:string) {
  if (location.href !== expectedURL) return { ok: false, message: 'The page changed before the action. Inspect it again.' }
  if(targetOnly && !['click','choose','type','first-video','video-result'].includes(command.action))return null
  const isolated = globalThis as unknown as {
    athenaActiveAction?:string; athenaObservedControls?: Array<{ element: Element; signature: string }>
    athenaFieldRefs?:WeakMap<Element,string>; athenaFieldSequence?:number
  }
  const editable=(e:Element)=>e instanceof HTMLTextAreaElement || e instanceof HTMLInputElement && ['text','search','email','url','tel'].includes(e.type)
  const label = (element: Element) => {
    const labelledBy=element.getAttribute('aria-labelledby')?.trim().split(/\s+/).map(id=>document.getElementById(id)?.textContent??'').join(' ').trim()
    const name=(labelledBy || element.getAttribute('aria-label') || element.getAttribute('placeholder') || (element as HTMLInputElement).labels?.[0]?.textContent || element.textContent || '').trim().slice(0,160)
    if(name || !editable(element))return name
    const refs=isolated.athenaFieldRefs??=new WeakMap()
    let ref=refs.get(element)
    if(!ref){isolated.athenaFieldSequence=(isolated.athenaFieldSequence??0)+1;ref='Unlabeled field · '+isolated.athenaFieldSequence;refs.set(element,ref)}
    return ref
  }
  const controls = () => [...document.querySelectorAll('button,a[href],input:not([type=password]):not([type=hidden]),textarea,select,[role=button],[role=menuitem]')].filter(element => { const rect = element.getBoundingClientRect(); return rect.width > 0 && rect.height > 0 && !/password|secret|token|credential/i.test(label(element)) }).slice(0, 150)
  const snapshot = () => ({ title: document.title.slice(0, 200), controls: controls().map(element => ({ label: label(element), role: element.getAttribute('role') || element.tagName.toLowerCase(), enabled: !(element as HTMLButtonElement).disabled })) })
  const signature = (element: Element) => JSON.stringify([element.tagName, label(element), ...['role', 'type', 'href', 'formaction'].map(name => element.getAttribute(name)), element.closest('form')?.getAttribute('action')])
  if(actionId)isolated.athenaActiveAction=actionId
  const stillActive=()=>!actionId || isolated.athenaActiveAction===actionId && document.hasFocus() && !document.hidden
  const geometry=(e:Element)=>{const r=e.getBoundingClientRect();return [r.x,r.y,r.width,r.height].join(',')}
  const target=(e:Element)=>{
    const {x,y,width,height}=e.getBoundingClientRect()
    const hit=document.elementFromPoint(x+width/2,y+height/2)
    if(!document.hasFocus() || document.hidden || !hit || !e.contains(hit) || window.visualViewport && (window.visualViewport.scale!==1 || window.visualViewport.offsetLeft || window.visualViewport.offsetTop))return null
    return {x,y,width,height,viewWidth:window.innerWidth,viewHeight:window.innerHeight,key:JSON.stringify([signature(e),geometry(e)])}
  }
  if (command.action === 'read') {
    const blocks = Array.from(document.querySelectorAll<HTMLElement>('main p,article p,[role=main] p,h1,h2'))
    const text = blocks.filter(node => node.checkVisibility() && !node.closest('form,[contenteditable=true],[aria-hidden=true]'))
      .slice(0,12).map(node => node.innerText.trim()).filter(Boolean).join(' ').slice(0,780)
    return {ok:!!text, message:text ? 'Page excerpt: ' + text : 'No readable article text was found.'}
  }
  if (command.action === 'inspect') { isolated.athenaObservedControls = controls().map(element => ({ element, signature: signature(element) })); return { ok: true, message: `Active page: ${document.title.slice(0, 200)}.`, data: snapshot() } }
  if(command.action==='upload' || command.action==='download'){
    const matches=controls().filter(e=>label(e)===command.label)
    const element=matches[0],previous=isolated.athenaObservedControls?.find(item=>item.element===element)
    if(matches.length!==1 || !previous || previous.signature!==signature(element)) return null
    if(command.action==='upload')return element instanceof HTMLInputElement && element.type==='file' && !element.disabled ? element : null
    return element instanceof HTMLAnchorElement && new URL(element.href).origin===location.origin && element.hasAttribute('download') ? element : null
  }
  if (command.action === 'scroll') { const before = scrollY; scrollBy(0, (command.direction === 'down' ? 1 : -1) * innerHeight * 0.7); await new Promise(resolve => requestAnimationFrame(resolve)); const verified=command.direction==='down' ? scrollY>before : scrollY<before; return { ok: verified, message: verified ? 'The page scrolled.' : 'The page did not scroll; it may be at its boundary.' } }
  if (command.action === 'first-video' || command.action === 'video-result') {
    const links = [...document.querySelectorAll<HTMLAnchorElement>('a#video-title[href^="/watch"],a#video-title-link[href^="/watch"]')].filter(a => a.getBoundingClientRect().width > 0)
    const index = command.action === 'video-result' ? command.index : 1
    const video = [...new Map(links.map(a => [a.href,a])).values()][index-1]
    if (!video) return { ok: false, message: 'No supported video result is visible. Search YouTube first.' }
    const id = new URL(video.href).searchParams.get('v')
    if (!id) return {ok:false,message:'The selected result has no video identifier.'}
    if(targetOnly)return target(video)
    if(expectedTarget && target(video)?.key!==expectedTarget)return {ok:false,message:'The highlighted link moved or changed before activation.'}
    const prepared=geometry(video),indicator=mark(video,'select',feedback)
    await new Promise<void>(resolve=>{const deadline=setTimeout(resolve,70);requestAnimationFrame(()=>{clearTimeout(deadline);resolve()})})
    if(!stillActive() || !video.isConnected || geometry(video)!==prepared || location.href!==expectedURL){indicator.stop();return {ok:false,message:'The video result changed.'}}
    video.click();indicator.clicked()
    await new Promise(resolve => setTimeout(resolve, 700))
    const opened = location.pathname === '/watch' && new URL(location.href).searchParams.get('v') === id
    return { ok: opened, message: opened ? `Opened video result ${index}. Playback may require your consent.` : 'The video navigation was requested but could not be verified.' }
  }
  if (command.action === 'media') {
    const video = document.querySelector<HTMLVideoElement>('video')
    if (!video) return { ok: false, message: 'No video is available on this page.' }
    if (command.operation === 'pause') { video.pause(); return { ok: video.paused, message: 'Video paused.' } }
    if (command.operation === 'play') { try { await video.play() } catch { return { ok: false, message: 'Playback requires a manual interaction or website consent.' } }; return { ok: !video.paused, message: 'Video playing.' } }
    if (command.operation === 'seek') { const target = Math.max(0, Math.min(Number.isFinite(video.duration) ? video.duration : video.currentTime + 120, video.currentTime + (command.value ?? 10))); video.currentTime = target; return { ok: Math.abs(video.currentTime - target) < 1, message: 'Adjusted the playback position.' } }
    if (command.operation === 'volume') { const target = command.value === 0 ? 0 : Math.max(0, Math.min(1, video.volume + Math.max(-1, Math.min(1, command.value ?? -0.1)))); video.volume = target; return { ok: Math.abs(video.volume - target) < 0.01, message: `Video volume: ${Math.round(target * 100)} percent.` } }
    try { if (command.operation === 'fullscreen') await video.requestFullscreen(); else if (document.fullscreenElement) await document.exitFullscreen() } catch { return { ok: false, message: 'The browser requires a manual interaction for fullscreen.' } }
    return { ok: command.operation === 'fullscreen' ? !!document.fullscreenElement : !document.fullscreenElement, message: 'Fullscreen state verified.' }
  }
  if (command.action === 'click' || command.action === 'type' || command.action === 'choose') {
    const candidates = controls().filter(element => label(element) === command.label && !(element as HTMLButtonElement).disabled)
    const matches=command.action==='type' ? candidates.filter(editable) : command.action==='choose' ? candidates.filter(e=>e instanceof HTMLSelectElement)
      : candidates.length>1 ? candidates.filter(e=>!editable(e)) : candidates
    if (matches.length !== 1) return { ok: false, message: 'No unique enabled control has that label. Inspect the page again.' }
    const element = matches[0], before = JSON.stringify(snapshot())
    const observed = isolated.athenaObservedControls?.find(item => item.element === element)
    if (!observed || observed.signature !== signature(element)) return { ok: false, message: 'The observed control changed. Inspect the page again before acting.' }
    if(targetOnly)return target(element)
    if(expectedTarget && target(element)?.key!==expectedTarget)return {ok:false,message:'The highlighted control moved or changed before input.'}
    isolated.athenaObservedControls = undefined
    const prepared=geometry(element),indicator=mark(element,command.action,feedback)
    await new Promise<void>(resolve=>{const deadline=setTimeout(resolve,70);requestAnimationFrame(()=>{clearTimeout(deadline);resolve()})})
    const rect=element.getBoundingClientRect(),hit=document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2)
    if(!stillActive() || document.hidden || !element.isConnected || !hit || !element.contains(hit) || geometry(element)!==prepared || location.href!==expectedURL || signature(element)!==observed.signature || (element as HTMLButtonElement).disabled) {indicator.stop();return {ok:false,message:'The control moved, became obscured, or changed before execution. Inspect it again.'}}
    try {
    if (command.action === 'choose') {
      if (!(element instanceof HTMLSelectElement)) return {ok:false,message:'This control is not a dropdown.'}
      const options = [...element.options].filter(o=>o.label === command.option && !o.disabled)
      if (options.length !== 1) return {ok:false,message:'No unique enabled option matches.'}
      element.selectedIndex = options[0].index; element.dispatchEvent(new Event('change',{bubbles:true}))
      return {ok:element.selectedOptions[0]===options[0],message:'Checked the selected option.'}
    }
    if (command.action === 'type') {
      if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) || element.type === 'password' || element.readOnly) return { ok: false, message: 'This control is not an editable, non-sensitive text field.' }
      element.focus({preventScroll:true})
      if (document.activeElement!==element || !element.isConnected || !stillActive())return {ok:false,message:'The observed field could not retain focus. No text was entered.'}
      const setter = Object.getOwnPropertyDescriptor(element instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype, 'value')?.set
      setter?.call(element, command.text); element.dispatchEvent(new Event('input', { bubbles: true })); element.dispatchEvent(new Event('change', { bubbles: true }))
      return { ok: element.value === command.text, message: element.value === command.text ? 'Entered the dictated text. No submit action was performed.' : 'The requested text could not be verified.' }
    }
    ;(element as HTMLElement).click();indicator.clicked()
    await new Promise(resolve => setTimeout(resolve, 400))
    const changed = location.href !== expectedURL || JSON.stringify(snapshot()) !== before
    return { ok: changed, message: changed ? 'The page changed after activating that control.' : 'The control was activated but the result is unverified. Inspect before repeating it.' }
    } finally {indicator.stop()}
  }
  return { ok: false, message: 'Unsupported browser action.' }
}
