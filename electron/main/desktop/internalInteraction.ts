import type { BrowserWindow } from 'electron'
import type { DesktopRect } from '../../../shared/desktopActions'
export function internalTarget(action:string,input:Record<string,unknown>):string|undefined {
  const id=String(input.sessionId??'')
  if(action==='athena.chat.openSession' && /^[a-z\d-]{1,80}$/i.test(id))return '[data-conversation-id="'+id+'"] .conversation-select'
  if(action==='athena.navigate' && /^[a-z-]+$/.test(String(input.page)))return '[data-nav-page="'+input.page+'"]'
  if(action==='athena.project.open' && typeof input.query==='string' && /^[\w .-]{1,120}$/.test(input.query))return '.conversation-project[aria-label="'+input.query+' project"] .conversation-project-toggle'
  const selector:Record<string,string>={
    'athena.chat.setComposerText':'textarea[aria-label="Message Athena"]','athena.chat.sendMessage':'button[aria-label="Send message"]',
    'athena.chat.stopGeneration':'button[aria-label="Stop generation"]','athena.chat.createSession':'button[aria-label="New conversation"]',
    'athena.chat.chooseModel':'[aria-label="Conversation model"]','athena.chat.changeEffort':'[aria-label="Reasoning effort"]',
  }
  return selector[action]
}
export async function internalBounds(window:BrowserWindow,selector:string):Promise<DesktopRect|undefined> {
  if(window.isDestroyed() || !window.isFocused() || !window.isVisible() || window.isMinimized())return
  const rect=await window.webContents.executeJavaScript('('+visibleRect.toString()+')('+JSON.stringify(selector)+')')
  if(!rect || window.isDestroyed() || !window.isFocused())return
  const origin=window.getContentBounds(),z=window.webContents.getZoomFactor()
  return {x:origin.x+rect.x*z,y:origin.y+rect.y*z,width:rect.width*z,height:rect.height*z}
}
function visibleRect(selector:string){
  const e=document.querySelector(selector)
  if(!e || !e.checkVisibility())return
  const {x,y,width,height}=e.getBoundingClientRect()
  const hit=document.elementFromPoint(x+width/2,y+height/2)
  if(!hit || !e.contains(hit))return
  return {x,y,width,height}
}
