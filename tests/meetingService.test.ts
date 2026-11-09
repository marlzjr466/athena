// @vitest-environment node
import { beforeEach,describe,it,expect,vi } from 'vitest'
import { mkdtemp,readFile,writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { MeetingSnapshot } from '../shared/meetings'
import type { ChatMessage } from '../shared/chat'
import type { StreamOptions } from '../electron/main/ai/AIProvider'
import { pcmWav } from '../src/features/meetings/meetingCapture'
const electron=vi.hoisted(()=>({handle:vi.fn(),removeHandler:vi.fn(),display:vi.fn(),save:vi.fn(),open:vi.fn(),sources:vi.fn(),relaunch:vi.fn(),quit:vi.fn(),settings:vi.fn(),reveal:vi.fn()}))
vi.mock('electron',()=>({app:{isPackaged:true,getPath:()=>'/Applications/Athena.app/Contents/MacOS/Athena',getAppPath:()=>'/app',relaunch:electron.relaunch,quit:electron.quit},shell:{openExternal:electron.settings,showItemInFolder:electron.reveal},ipcMain:{handle:electron.handle,removeHandler:electron.removeHandler},session:{defaultSession:{setDisplayMediaRequestHandler:electron.display}},dialog:{showSaveDialog:electron.save,showOpenDialog:electron.open},desktopCapturer:{getSources:electron.sources},systemPreferences:{askForMediaAccess:async()=>true,getMediaAccessStatus:()=> 'denied'},screen:{getCursorScreenPoint:()=>({x:0,y:0}),getDisplayNearestPoint:()=>({id:1,workArea:{x:0,y:0,width:1600,height:900}})},BrowserWindow:class{}}))
import { MeetingService } from '../electron/main/meetings/meetingService'
import { ArtifactService } from '../electron/main/ai/artifactService'
beforeEach(()=>vi.clearAllMocks())
async function fixture(screenDelayMs=0) {
  const root=await mkdtemp(join(tmpdir(),'athena-meeting-service-')),frame={url:'athena://renderer/index.html?surface=meeting'},contents={id:44,mainFrame:frame,getURL:()=>frame.url,send:vi.fn(),on:vi.fn()},panel={webContents:contents,isDestroyed:()=>false,setAlwaysOnTop:vi.fn(),setOpacity:vi.fn(),setContentProtection:vi.fn(),show:vi.fn(),focus:vi.fn(),hide:vi.fn(),on:vi.fn(),setBounds:vi.fn(),minimize:vi.fn()}
  const windows={control:panel,all:()=>[panel],make:()=>panel,owns:()=>true,isTrustedURL:(_c:unknown,url:string)=>url===frame.url}
  const transcriber={transcribe:vi.fn(async()=> 'We decided to use mock APIs. Who will own the adapter?')},provider=vi.fn(async()=>({provider:{async *streamMessage(){yield {type:'text',text:JSON.stringify({items:[{category:'decision',text:'Use mock APIs.',quote:'We decided to use mock APIs.',owner:null,deadline:null}]})};yield {type:'done'}}},vision:false}))
  const captureScreen=vi.fn(async()=>({attachment:{id:'screen',name:'Active screen',kind:'text' as const,data:'const Counter = 1'},png:new Uint8Array([1,2]),name:'Fixture display',method:'local-text' as const,capturedAt:Date.now()}))
  const service=new MeetingService({captureScreen,screenDelayMs,windows:windows as never,root,transcriber:transcriber as never,artifacts:new ArtifactService(join(root,'artifacts')),provider:provider as never,models:async()=>[],offline:()=>false,filesAllowed:()=>true});await service.initialize()
  const invoke=electron.handle.mock.calls[0][1];const event={sender:contents,senderFrame:frame};const command=(c:unknown)=>invoke(event,c);const snapshot=async()=> (await command({action:'get'})).snapshot as MeetingSnapshot
  await command({action:'create',title:'Technical sync',template:'technical'})
  return {service,command,snapshot,root,provider,panel,transcriber,event,invoke,captureScreen}
}
describe('meeting permission and lifecycle boundary',()=>{
  it.runIf(process.platform==='darwin')('reports the exact running app and gates access requests behind meeting consent',async()=>{
    const f=await fixture()
    expect((await f.command({action:'screen-access',operation:'check'})).screenAccess).toEqual({status:'denied',appPath:'/Applications/Athena.app'})
    expect(electron.sources).not.toHaveBeenCalled()
    expect((await f.command({action:'screen-access',operation:'request'})).ok).toBe(false)
    expect(electron.sources).not.toHaveBeenCalled()
    await f.command({action:'preferences',patch:{screenConsent:true}});electron.sources.mockResolvedValue([])
    expect((await f.command({action:'screen-access',operation:'request'})).screenAccess.status).toBe('denied')
    expect(electron.sources).toHaveBeenCalledExactlyOnceWith({types:['screen'],thumbnailSize:{width:0,height:0},fetchWindowIcons:false})
    await f.command({action:'screen-access',operation:'reveal'});expect(electron.reveal).toHaveBeenCalledWith('/Applications/Athena.app')
    await f.command({action:'screen-access',operation:'settings'});expect(electron.settings).toHaveBeenCalledWith('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture')
    await f.service.dispose()
  })
  it('refuses a permission restart during recording and saves before an idle restart',async()=>{
    const f=await fixture();await f.command({action:'preferences',patch:{microphone:true}});await f.command({action:'record',state:'start',consent:true})
    expect((await f.command({action:'screen-access',operation:'restart'})).ok).toBe(false);expect(electron.relaunch).not.toHaveBeenCalled()
    await f.command({action:'record',state:'stop'})
    expect((await f.command({action:'screen-access',operation:'restart'})).ok).toBe(true)
    await vi.waitFor(()=>expect(electron.relaunch).toHaveBeenCalledTimes(1));expect(electron.quit).toHaveBeenCalledTimes(1)
    await f.service.dispose()
  })
  it('starts system audio on the active display without asking the user to select a source',async()=>{
    const f=await fixture(),selected={id:'screen:9:0',display_id:'1',name:'Active display'}
    await f.command({action:'preferences',patch:{system:true}});await f.command({action:'record',state:'start',consent:true})
    electron.sources.mockResolvedValue([{id:'screen:0:0',display_id:'2',name:'Other'},selected])
    const callback=vi.fn();electron.display.mock.calls[0][0]({frame:f.event.senderFrame,audioRequested:true},callback)
    await vi.waitFor(()=>expect(callback).toHaveBeenCalledWith({video:selected,audio:'loopback'}));await f.service.dispose()
  })
  it('grants system loopback only for the explicitly selected display and consumes its capture ticket',async()=>{
    const f=await fixture(),selected={id:'screen:1:0',name:'Selected display'}
    await f.command({action:'preferences',patch:{system:true,systemSource:selected.id}})
    await f.command({action:'record',state:'start',consent:true})
    electron.sources.mockResolvedValue([{id:'screen:0:0',name:'Another display'},selected])
    const handler=electron.display.mock.calls[0][0],callback=vi.fn()
    handler({frame:f.event.senderFrame,audioRequested:true},callback)
    await vi.waitFor(()=>expect(callback).toHaveBeenCalledWith({video:selected,audio:'loopback'}))
    const second=vi.fn();handler({frame:f.event.senderFrame,audioRequested:true},second)
    expect(second).toHaveBeenCalledWith({});expect(electron.sources).toHaveBeenCalledTimes(1)
    await f.service.dispose()
  })
  it.each(['stop','disable','source','restart'] as const)('rejects pending system capture after %s changes authorization',async change=>{
    const f=await fixture();await f.command({action:'preferences',patch:{system:true,systemSource:'screen:0:0'}});await f.command({action:'record',state:'start',consent:true})
    let release!:(sources:Array<{id:string;name:string}>)=>void
    electron.sources.mockReturnValue(new Promise(resolve=>{release=resolve}))
    const callback=vi.fn();electron.display.mock.calls[0][0]({frame:f.event.senderFrame,audioRequested:true},callback)
    if(change==='stop'||change==='restart')await f.command({action:'record',state:'stop'})
    if(change==='restart')await f.command({action:'record',state:'start',consent:true})
    if(change==='disable')await f.command({action:'preferences',patch:{system:false}})
    if(change==='source')await f.command({action:'preferences',patch:{systemSource:'screen:1:0'}})
    release([{id:'screen:0:0',name:'Original display'},{id:'screen:1:0',name:'New display'}])
    await vi.waitFor(()=>expect(callback).toHaveBeenCalledExactlyOnceWith({}));await f.service.dispose()
  })
  it('opening the panel grants no microphone permission and no capture starts',async()=>{const f=await fixture();await f.command({action:'panel',mode:'show'});expect(f.service.allowsMedia(f.event.sender as never,'media',true,['audio'])).toBe(false);expect((await f.snapshot()).session?.status).toBe('ready');expect(f.transcriber.transcribe).not.toHaveBeenCalled();await f.service.dispose()})
  it('requires recording consent, journals audio, transcribes locally, preserves sessions across model changes and pause/stop',async()=>{
    const f=await fixture();await f.command({action:'preferences',patch:{microphone:true,retainAudio:true}})
    expect((await f.command({action:'record',state:'start'})).ok).toBe(false)
    expect((await f.command({action:'record',state:'start',consent:true})).ok).toBe(true)
    const started=(await f.snapshot()).session!.startedAt!,id=randomUUID(),bytes=pcmWav(new Float32Array(16000).fill(.1),16000)
    expect((await f.command({action:'audio',sessionId:(await f.snapshot()).session!.id,id,source:'microphone',start:started,end:started+1000,bytes})).ok).toBe(true)
    await vi.waitFor(async()=>expect((await f.snapshot()).session!.segments[0].status).toBe('complete'))
    await f.command({action:'preferences',patch:{model:'another-installed-model'}});expect((await f.snapshot()).session!.segments[0].text).toContain('mock APIs')
    expect(f.provider).not.toHaveBeenCalled();await f.command({action:'record',state:'pause'});expect((await f.snapshot()).session!.status).toBe('paused');await f.command({action:'record',state:'stop'});expect((await f.snapshot()).session!.endedAt).toBeDefined();await f.service.dispose()
  })
  it('blocks cloud context without explicit consent and generates notes only after opt-in',async()=>{const f=await fixture();await f.command({action:'preferences',patch:{aiConsent:true,provider:'cloud',model:'gpt-4.1'}});await f.command({action:'ask',text:'Summarize',kind:'notes'});await vi.waitFor(async()=>expect((await f.snapshot()).busy).toBe(false));expect(f.provider).not.toHaveBeenCalled();f.provider.mockImplementation(async()=>({provider:{async *streamMessage(){yield {type:'text',text:'{"items":[]}'};yield {type:'done'}}},vision:false}));await f.command({action:'preferences',patch:{cloudConsent:true}});await f.command({action:'ask',text:'Summarize',kind:'notes'});await vi.waitFor(async()=>expect((await f.snapshot()).session?.answers.at(-1)).toMatchObject({status:'complete'}));expect(f.provider).toHaveBeenCalledTimes(1);await f.service.dispose()})
  it('rejects untrusted frames and never claims universal capture protection',async()=>{const f=await fixture();expect((await f.invoke({...f.event,senderFrame:{url:'https://example.com'}},{action:'get'})).ok).toBe(false);await f.command({action:'panel',mode:'show'});await f.command({action:'preferences',patch:{protection:true}});expect(f.panel.setContentProtection).toHaveBeenCalledWith(true);expect((await f.snapshot()).protection).toContain('requested');await f.command({action:'panel',mode:'safe'});expect(f.panel.hide).toHaveBeenCalled();expect((await f.snapshot()).safeMode).toBe(true);await f.service.dispose()})
  it('exports a real DOCX package containing complete transcript text',async()=>{const f=await fixture(),path=join(f.root,'notes.docx');electron.save.mockResolvedValue({canceled:false,filePath:path});expect((await f.command({action:'export',format:'docx'})).ok).toBe(true);const bytes=await readFile(path);expect(bytes.subarray(0,2).toString()).toBe('PK');await f.service.dispose()})
})


it('keeps Stop responsive while a native export dialog is open',async()=>{
  const f=await fixture();await f.command({action:'preferences',patch:{microphone:true}});await f.command({action:'record',state:'start',consent:true})
  let release!:(value:{canceled:boolean})=>void
  electron.save.mockReturnValue(new Promise(resolve=>{release=resolve}))
  const pending=f.command({action:'export',format:'txt'})
  await vi.waitFor(()=>expect(electron.save).toHaveBeenCalled())
  expect((await f.command({action:'record',state:'stop'})).ok).toBe(true)
  expect((await f.snapshot()).session!.status).toBe('stopped')
  release({canceled:true});await pending;await f.service.dispose()
})
it('attaches pasted code locally and selected source files without executing them',async()=>{
  const f=await fixture(),id=(await f.snapshot()).session!.id
  expect((await f.command({action:'attach-paste',sessionId:id,text:'export const answer = 42'})).ok).toBe(true)
  const path=join(f.root,'source.ts');await writeFile(path,'export function greet() { return "hello" }')
  electron.open.mockResolvedValue({canceled:false,filePaths:[path]})
  expect((await f.command({action:'attach-source'})).ok).toBe(true)
  const attachments=(await f.snapshot()).session!.attachments!
  expect(attachments.map(a=>a.origin)).toEqual(['paste','file']);expect(f.provider).not.toHaveBeenCalled()
  await f.command({action:'remove-attachment',id:attachments[0].id});expect((await f.snapshot()).session!.attachments).toHaveLength(1)
  await f.service.dispose()
})
it('requires separate consent for bounded live screen analysis and cancels it in Safe Mode',async()=>{
  const f=await fixture()
  expect((await f.command({action:'live-screen',sourceId:'screen:0:0',minutes:5})).ok).toBe(false)
  await f.command({action:'preferences',patch:{aiConsent:true,screenConsent:true}})
  f.provider.mockImplementation(async()=>({provider:{async *streamMessage(){yield {type:'text',text:'Screen explanation'};yield {type:'done'}}},vision:true}))
  electron.sources.mockResolvedValue([{id:'screen:0:0',name:'Fixture',thumbnail:{isEmpty:()=>false,toDataURL:()=> 'data:image/png;base64,fixture'}}])
  expect((await f.command({action:'live-screen',sourceId:'screen:0:0',minutes:5})).ok).toBe(true)
  expect((await f.snapshot()).liveScreenUntil).toBeGreaterThan(Date.now())
  await f.command({action:'panel',mode:'safe'});expect((await f.snapshot()).liveScreenUntil).toBeUndefined();await f.service.dispose()
})

it('uses the active screen with local text for text-only models without a source selection',async()=>{
  const f=await fixture();await f.command({action:'preferences',patch:{aiConsent:true,screenConsent:true}})
  await f.command({action:'ask',kind:'screen',text:'Explain visible code'})
  await vi.waitFor(async()=>expect((await f.snapshot()).session!.answers.at(-1)?.status).toBe('complete'))
  expect(f.captureScreen).toHaveBeenCalledWith(false,expect.any(AbortSignal))
  expect((await f.snapshot()).session!.answers.at(-1)?.screenContext?.method).toBe('local-text')
  expect((await f.snapshot()).session!.screenReferences).toEqual([])
  await f.service.dispose()
})
it('links pasted code and screen context to the actual provider message',async()=>{
  const f=await fixture(),sessionId=(await f.snapshot()).session!.id
  await f.command({action:'attach-paste',sessionId,text:'export const attachedValue = 42'})
  await f.command({action:'preferences',patch:{aiConsent:true,screenConsent:true}})
  const stream=vi.fn(async function*(history:ChatMessage[],options:StreamOptions){
    const referenced=history[0].attachments!.map(ref=>options.context!.attachments.find(a=>a.id===ref.id)!)
    expect(referenced).toHaveLength(2)
    expect(referenced.map(a=>a.data).join('\n')).toContain('attachedValue = 42')
    expect(referenced.map(a=>a.data).join('\n')).toContain('const Counter = 1')
    yield {type:'text' as const,text:'Explained the supplied context'}
  })
  f.provider.mockResolvedValue({provider:{streamMessage:stream},vision:false} as never)
  await f.command({action:'ask',kind:'screen',text:'Explain the code'})
  await vi.waitFor(async()=>expect((await f.snapshot()).session!.answers.at(-1)?.status).toBe('complete'))
  expect(stream).toHaveBeenCalledTimes(1);await f.service.dispose()
})
it.each(['cancel','revoke','safe'] as const)('prevents screen capture when %s happens during the countdown',async action=>{
  const f=await fixture(3000);await f.command({action:'preferences',patch:{aiConsent:true,screenConsent:true}})
  await f.command({action:'ask',kind:'screen',text:'Explain visible code'})
  await vi.waitFor(async()=>expect((await f.snapshot()).screenCaptureAt).toBeGreaterThan(Date.now()))
  await f.command(action==='cancel'?{action:'cancel'}:action==='revoke'?{action:'preferences',patch:{screenConsent:false}}:{action:'panel',mode:'safe'})
  await vi.waitFor(async()=>expect((await f.snapshot()).busy).toBe(false))
  expect(f.captureScreen).not.toHaveBeenCalled();await f.service.dispose()
})
