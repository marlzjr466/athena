import { nativeImage } from 'electron'
import type { ScreenImage } from '../screenCapture/screenCapturePlatform'

/** Unrelated animations must not invalidate a stationary observed control. Compare
 * the actual target pixels and a surrounding margin; window identity is checked separately. */
export function sameTargetImage(before:ScreenImage,after:ScreenImage,point:{x:number;y:number}):boolean {
  if(before.width!==after.width || before.height!==after.height)return false
  const a=nativeImage.createFromDataURL(before.dataURL),b=nativeImage.createFromDataURL(after.dataURL)
  if(a.isEmpty() || b.isEmpty())return false
  const x=Math.max(0,Math.floor(point.x)-48),y=Math.max(0,Math.floor(point.y)-48)
  const rect={x,y,width:Math.min(96,before.width-x),height:Math.min(96,before.height-y)}
  if(rect.width<=0 || rect.height<=0)return false
  return a.crop(rect).toBitmap().equals(b.crop(rect).toBitmap())
}
