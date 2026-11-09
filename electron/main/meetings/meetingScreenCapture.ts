import { app, desktopCapturer, screen } from 'electron'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { PreparedAttachment } from '../ai/AIProvider'
import { recognizeScreenText } from '../screenCapture/localScreenOCR'
import { ensureMeetingScreenAccess } from './meetingScreenPermission'

export interface MeetingScreenContext {
  attachment: PreparedAttachment
  png: Uint8Array
  name: string
  method: 'vision' | 'local-text'
  capturedAt: number
}

/** Active screen means the display containing the pointer when capture begins. */
export async function captureActiveScreen(vision: boolean, signal: AbortSignal): Promise<MeetingScreenContext> {
  signal.throwIfAborted()
  await ensureMeetingScreenAccess(signal)
  if(!vision && process.platform!=='darwin')throw new Error('Select a vision model to analyze the active screen on this platform. Local screen text recognition is currently available on macOS.')
  const display=screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const sources=await desktopCapturer.getSources({types:['screen'],thumbnailSize:{width:2400,height:1600},fetchWindowIcons:false})
  signal.throwIfAborted()
  // Never assume screen:N equals a Display id, nor silently capture another display.
  const source=sources.find(v=>v.display_id===String(display.id)) || (screen.getAllDisplays().length===1&&sources.length===1?sources[0]:undefined)
  if(!source || source.thumbnail.isEmpty())throw new Error('The active screen could not be captured. Check Athena’s screen recording permission and try again.')
  const png=source.thumbnail.toPNG(),capturedAt=Date.now(),name=`Active screen · ${display.label||source.name}`
  if(png.length>20_000_000)throw new Error('The active screen image exceeds the capture limit.')
  if(vision)return {attachment:{id:randomUUID(),name,kind:'image',data:source.thumbnail.toDataURL()},png,name,method:'vision',capturedAt}
  const binary=app.isPackaged?join(process.resourcesPath,'native','athena-screen-ocr'):join(app.getAppPath(),'build/native/athena-screen-ocr')
  const text=await recognizeScreenText(binary,png,signal)
  signal.throwIfAborted()
  if(!text.trim())throw new Error('No readable text was found on the active screen. Bring code or text into view, or choose a vision model for diagrams and images.')
  return {attachment:{id:randomUUID(),name:`${name} (local text recognition)`,kind:'text',data:`Text extracted locally from the active screen. OCR may misread punctuation, code, or layout. Use only this text; do not claim to see images or infer hidden content.\n\n${text}`},png,name,method:'local-text',capturedAt}
}
