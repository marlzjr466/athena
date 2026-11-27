import { app, BrowserWindow } from 'electron'
import { KeychainCredentialStore } from '../../../electron/main/ai/credentialStore'
import { AutomationJournal } from '../../../electron/main/ai/automationJournal'
import { OpenAIAutomation } from '../../../electron/main/ai/openAIAutomation'
import { applicationAutomationDefaults } from '../../../shared/applicationAutomation'
import OpenAI from 'openai'

// Executed exclusively by the signed main process in an isolated Playwright profile.
// This fixture is never packaged. Only measurements and pass/fail evidence leave it.
async function retire(client:OpenAI,id:string) {
  const sessions=client.beta.agents.sessions
  await sessions.events.create(id,{events:[{type:'agent.session.input.cancel'}]}).catch(()=>{})
  for(let attempt=0;attempt<6;attempt++){
    try {await sessions.delete(id);return}
    catch(error){if(!(error instanceof OpenAI.APIError) || error.status!==409 || attempt===5)throw error}
    await new Promise(r=>setTimeout(r,300*(attempt+1)))
  }
}
export async function runProbe(paid:boolean) {
  if(!app.isPackaged)throw new Error('A signed packaged test process is required.')
  const credential=paid?await new KeychainCredentialStore().read():null
  if(paid && !credential?.verifiedAt)throw new Error('No verified OpenAI API account in the test process.')
  const journal=new AutomationJournal(app.getPath('userData')+'/probe')
  const api=credential?new OpenAIAutomation(credential.apiKey,journal):undefined
  const window=new BrowserWindow({width:380,height:260,useContentSize:true,show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}})
  try {
    const html='<html><body style="background:white;color:black;font:22px Arial;text-align:center"><h3>Delivery details</h3><button style="width:240px;height:72px;font-size:24px">Show locker</button><p id="verified"></p><script>document.querySelector("button").onclick=e=>{e.target.disabled=true;document.getElementById("verified").textContent="Locker 47"}</script></body></html>'
    await window.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(html))
    window.show();window.focus()
    let inputs=0
    const started=Date.now(), signal=AbortSignal.timeout(65000)
    const verify=()=>window.webContents.executeJavaScript('document.getElementById("verified")?.textContent')
    const click=async(x:number,y:number)=>{
      window.webContents.sendInputEvent({type:'mouseMove',x,y})
      window.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,x,y})
      window.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,x,y})
      const end=Date.now()+1200
      while(Date.now()<end){if(await verify()==='Locker 47')return true;await new Promise(r=>setTimeout(r,25))}
      return false
    }
    if(!api)return {actual:await click(190,100)?await verify():'No click',inputs:1}
    const message=await api.visual({...applicationAutomationDefaults,maxSteps:3,monthlyRequests:3},
      'Click Show locker once. After the locker number is visible, state the locker number. Use a single left click and verify from the screenshot.',{
      capture:async()=>{
        const bytes=(await window.webContents.capturePage()).resize({width:380,height:260}).toPNG({scaleFactor:1})
        if(bytes.readUInt32BE(16)!==380 || bytes.readUInt32BE(20)!==260)throw new Error('Unexpected fixture pixel dimensions.')
        return 'data:image/png;base64,'+bytes.toString('base64')
      },
      approveChecks:async()=>false,
      run:async a=>{
        if(a.type!=='click'||a.button!=='left'||inputs || a.x<0||a.x>=380||a.y<0||a.y>=260)throw new Error('Unexpected fixture action.')
        inputs++
        const applied=await click(a.x,a.y)
        return {applied,evidence:applied?'Locker 47':'The proposed point did not activate the fixture control.'}
      },
    },signal,async()=>signal.throwIfAborted(),()=>()=>{})
    return {message,inputs,actual:await verify(),ms:Date.now()-started,...journal.usage()}
  } catch(error) {
    throw new Error((error instanceof Error?error.message:'Failed')+'; '+JSON.stringify(journal.usage()))
  } finally {window.destroy()}
}

export async function checkEnvironment() {
  const entry=await new KeychainCredentialStore().read()
  if(!entry?.verifiedAt)throw new Error('Verified credential unavailable.')
  const client=new OpenAI({apiKey:entry.apiKey,maxRetries:0,timeout:15000})
  const journal=new AutomationJournal(app.getPath('userData')+'/probe-env'), api=new OpenAIAutomation(entry.apiKey,journal)
  const results=[]
  for(const model of ['gpt-6.2-sol','gpt-6-astra']) {
    try {
      // An empty environment allocation contains no input and starts no inference.
      const env=await api.environment('probe',model,true,AbortSignal.timeout(15000))
      if(env){
        api.dispose()
        await retire(client,env.session)
        results.push({model,issued:true,connected:env.connected,deleted:true})
      }
    }catch(error){
      const cause=error instanceof Error && error.cause instanceof OpenAI.APIError?error.cause:error
      if(cause instanceof OpenAI.APIError)results.push({model,status:cause.status,code:cause.code,param:cause.param,detail:String(cause.error?.message??'').slice(0,300)})
      else results.push({model,error:String(error).slice(0,300)})
    }finally{api.dispose()}
  }
  return results
}

/** Operate only the disposable Chrome instance created by the caller. Its window images never leave the process. */
export async function nativePointer(pid:number) {
  const {nativeImage,systemPreferences}=await import('electron')
  const screen=systemPreferences.getMediaAccessStatus('screen')
  if(screen!=='granted' || !systemPreferences.isTrustedAccessibilityClient(false))
    return {blocked:'Screen Recording '+screen+', Accessibility '+systemPreferences.isTrustedAccessibilityClient(false)}
  const {MacOSScreenCapture}=await import('../../../electron/main/screenCapture/macOSScreenCapture')
  const {MacOSDesktopPlatform}=await import('../../../electron/main/desktop/macOSDesktopPlatform')
  const {DesktopTools}=await import('../../../electron/main/desktop/desktopTools')
  const {approvedWindowDriver}=await import('../../../electron/main/desktop/approvedWindowDriver')
  const {join}=await import('node:path')
  const native=new MacOSDesktopPlatform('darwin',undefined,join(process.resourcesPath,'native','athena-desktop-accessibility'),()=>true)
  const capture=new MacOSScreenCapture(),desktop=new DesktopTools(native,()=>true,()=>false)
  const signal=AbortSignal.timeout(18000)
  try{
    const driver=await approvedWindowDriver({platform:capture,desktop,athenaPid:process.pid,
      workspace:(app,request,s)=>native.workspace(app,{...request,pid},s),allowed:app=>app==='chrome',
      confirm:async(_title,detail)=>detail.includes('Athena isolated pointer test'),
    },'chrome','Click the marker in the Chrome test window',async()=>signal.throwIfAborted(),signal)
    const shot=nativeImage.createFromDataURL(await driver.capture(signal))
    const {width,height}=shot.getSize(),pixels=shot.toBitmap()
    let x1=width,x2=0,y1=height,y2=0
    for(let y=0;y<height;y++)for(let x=0;x<width;x++){
      const p=(y*width+x)*4
      if(pixels[p]<55 && pixels[p+1]>195 && pixels[p+2]<55){x1=Math.min(x1,x);x2=Math.max(x2,x);y1=Math.min(y1,y);y2=Math.max(y2,y)}
    }
    if(x2-x1<100 || y2-y1<40)throw new Error('Could not identify the test-only green control.')
    return await driver.run({type:'click',button:'left',x:Math.round((x1+x2)/2),y:Math.round((y1+y2)/2)},signal)
  }finally{capture.dispose();desktop.dispose()}
}
