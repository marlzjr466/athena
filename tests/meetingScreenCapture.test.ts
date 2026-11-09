// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest'
const fixture=vi.hoisted(()=>({sources:vi.fn(),ocr:vi.fn(),permission:vi.fn(),displays:vi.fn()}))
vi.mock('electron',()=>({app:{isPackaged:false,getAppPath:()=>'/app'},desktopCapturer:{getSources:fixture.sources},screen:{getCursorScreenPoint:()=>({x:2000,y:100}),getDisplayNearestPoint:()=>({id:42,label:'External display'}),getAllDisplays:fixture.displays},systemPreferences:{getMediaAccessStatus:fixture.permission}}))
vi.mock('../electron/main/screenCapture/localScreenOCR',()=>({recognizeScreenText:fixture.ocr}))
import { captureActiveScreen } from '../electron/main/meetings/meetingScreenCapture'
const thumbnail=(text:string)=>({isEmpty:()=>false,toPNG:()=>Buffer.from(text),toDataURL:()=>`data:image/png;base64,${text}`})
beforeEach(()=>{vi.clearAllMocks();fixture.permission.mockReturnValue('granted');fixture.displays.mockReturnValue([{id:10},{id:42}]);fixture.ocr.mockResolvedValue('const Counter = 1');fixture.sources.mockResolvedValue([{id:'screen:0:0',display_id:'10',name:'Primary',thumbnail:thumbnail('other')},{id:'screen:7:0',display_id:'42',name:'External',thumbnail:thumbnail('active')}])})
it('maps the pointer display by display_id and sends only that screen to vision',async()=>{
  const result=await captureActiveScreen(true,new AbortController().signal)
  expect(result.attachment).toMatchObject({kind:'image',data:'data:image/png;base64,active'})
  expect(fixture.ocr).not.toHaveBeenCalled();expect(fixture.sources).toHaveBeenCalledWith(expect.objectContaining({types:['screen'],fetchWindowIcons:false}))
})
it('uses native local OCR and supplies text rather than images to a text-only model',async()=>{
  const result=await captureActiveScreen(false,new AbortController().signal)
  expect(fixture.ocr).toHaveBeenCalledWith('/app/build/native/athena-screen-ocr',Buffer.from('active'),expect.any(AbortSignal))
  expect(result.attachment.kind).toBe('text');expect(result.attachment.data).toContain('const Counter = 1');expect(result.method).toBe('local-text')
})
it('fails instead of silently capturing the wrong screen when display mapping is unavailable',async()=>{
  fixture.sources.mockResolvedValue([{id:'screen:0:0',display_id:'10',name:'Other',thumbnail:thumbnail('other')}])
  await expect(captureActiveScreen(true,new AbortController().signal)).rejects.toThrow('active screen could not be captured')
})
it('does not read screen text after capture has been cancelled',async()=>{
  const abort=new AbortController();fixture.sources.mockImplementation(async()=>{abort.abort();return []})
  await expect(captureActiveScreen(false,abort.signal)).rejects.toThrow();expect(fixture.ocr).not.toHaveBeenCalled()
})
it('reports empty OCR content without fabricating a screen explanation',async()=>{
  fixture.ocr.mockResolvedValue(' ')
  await expect(captureActiveScreen(false,new AbortController().signal)).rejects.toThrow('No readable text')
})
it.runIf(process.platform==='darwin')('registers the current app without images when access is denied, then refuses capture',async()=>{
  fixture.permission.mockReturnValue('denied')
  await expect(captureActiveScreen(false,new AbortController().signal)).rejects.toThrow('this running copy of Athena')
  expect(fixture.sources).toHaveBeenCalledExactlyOnceWith({types:['screen'],thumbnailSize:{width:0,height:0},fetchWindowIcons:false})
  expect(fixture.ocr).not.toHaveBeenCalled()
})
it.runIf(process.platform==='darwin')('rechecks consent after registration and captures only if macOS now grants it',async()=>{
  fixture.permission.mockReturnValueOnce('not-determined').mockReturnValue('granted')
  const result=await captureActiveScreen(false,new AbortController().signal)
  expect(fixture.sources).toHaveBeenNthCalledWith(1,{types:['screen'],thumbnailSize:{width:0,height:0},fetchWindowIcons:false})
  expect(fixture.sources).toHaveBeenNthCalledWith(2,expect.objectContaining({thumbnailSize:{width:2400,height:1600}}))
  expect(result.method).toBe('local-text')
})
it.runIf(process.platform==='darwin')('does not request access or capture when macOS restricts it',async()=>{
  fixture.permission.mockReturnValue('restricted')
  await expect(captureActiveScreen(true,new AbortController().signal)).rejects.toThrow('restricted by macOS policy')
  expect(fixture.sources).not.toHaveBeenCalled();expect(fixture.ocr).not.toHaveBeenCalled()
})
it.runIf(process.platform==='darwin')('honors cancellation while registering consent before taking an image',async()=>{
  const abort=new AbortController();fixture.permission.mockReturnValue('denied')
  fixture.sources.mockImplementation(async()=>{abort.abort();return []})
  await expect(captureActiveScreen(true,abort.signal)).rejects.toThrow()
  expect(fixture.sources).toHaveBeenCalledTimes(1);expect(fixture.ocr).not.toHaveBeenCalled()
})
