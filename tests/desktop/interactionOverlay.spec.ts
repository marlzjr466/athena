import {test,expect,_electron as electron,chromium} from '@playwright/test'
import {mkdtemp,realpath,rm,writeFile} from 'node:fs/promises'
import {tmpdir,homedir} from 'node:os'
import {join,resolve} from 'node:path'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'

test('signed floating voice highlights a real external control without taking focus',async()=>{
  test.skip(process.env.ATHENA_WINDOW_LIVE!=='1' || !process.env.ATHENA_VOICE_TEST_BINARY || process.platform!=='darwin','Requires a signed build and macOS Accessibility')
  test.setTimeout(75000)
  const profile=await mkdtemp(join(tmpdir(),'athena-overlay-test-'))
  const chromeDir=join(profile,'chrome'),data=join(profile,'athena')
  const launched=await electron.launch({executablePath:process.env.ATHENA_VOICE_TEST_BINARY,args:['--use-fake-device-for-media-stream','--mute-audio','--user-data-dir='+data]})
  const browser=await chromium.launchPersistentContext(chromeDir,{channel:'chrome',headless:false,viewport:null})
  try{
    expect(await realpath(await launched.evaluate(({app})=>app.getPath('userData')))).toBe(await realpath(data))
    await expect.poll(()=>launched.windows().filter(p=>/surface=(floating|control)/.test(p.url())).length).toBe(2)
    // Normal startup intentionally brings the main window forward when its splash closes.
    // Begin the external-window test after that one-time handoff.
    await expect.poll(()=>launched.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().some(w=>w.webContents.getURL().includes('splash.html'))),{timeout:25000}).toBe(false)
    const floating=launched.windows().find(p=>p.url().includes('surface=floating'))!,control=launched.windows().find(p=>p.url().includes('surface=control'))!
    await control.evaluate(async whisper=>{
      const api=window.athena!,{settings}=await api.getSnapshot()
      await api.updateSettings({floatingEnabled:false,randomActions:false,randomMovement:false,
        voiceInteraction:{...settings.voiceInteraction,handsFreeEnabled:true},liveVoice:{...settings.liveVoice,cloudAllowed:false},
        localAI:{...settings.localAI,speechEngine:'whisper-cli',speechModelPath:whisper},
        automationPermissions:{...settings.automationPermissions,desktopUIInteraction:true,desktopApplicationControl:true,conversationManagement:true,internalNavigation:true}})
      for(const permission of ['microphone','applicationDetection','desktopAutomation','accessibilityControl'] as const) {
        await api.setPermissionEnabled({permission,enabled:true})
        if(!await api.isCapabilityAllowed({permission}))throw new Error(permission+' is unavailable on this signed build')
      }
    },join(homedir(),'.athena/models/whisper/ggml-small.bin'))
    type Recordings={samples:Array<{time:number;visible:boolean;focusable:boolean;target:boolean;text:string;ripple:boolean}>;errors:string[]}
    await launched.evaluate(({app,dialog,BrowserWindow})=>{
      const log=globalThis as unknown as Recordings;log.samples=[];log.errors=[]
      // Only the disposable fixture's approval is stubbed. Real OS grants are required.
      dialog.showMessageBox=async(first:Electron.BaseWindow|Electron.MessageBoxOptions,second?:Electron.MessageBoxOptions)=>{
        const options=second??first as Electron.MessageBoxOptions
        return {response:options.detail?.includes('Athena fixture button')?1:0,checkboxChecked:false}
      }
      const capture=()=>{const win=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('interactionOverlay.html'))
        if(!win?.isVisible())return
        const time=Date.now(),focusable=win.isFocusable(),visible=win.isVisible()
        void win.webContents.executeJavaScript('({target:document.getElementById("frame").checkVisibility(),text:document.getElementById("pointer").textContent+" "+document.getElementById("activity").textContent,ripple:!document.getElementById("pulse").hidden})')
          .then(info=>log.samples.push({time,visible,focusable,...info})).catch(()=>{})
      }
      app.on('browser-window-created',(_event,win)=>{
        win.on('show',capture)
        win.webContents.on('did-fail-load',(_event,code,_msg,url)=>{if(url.endsWith('interactionOverlay.html'))log.errors.push('Overlay load '+code)})
      })
      const timer=setInterval(capture,35)
      app.once('will-quit',()=>clearInterval(timer))
    })
    const lease=await floating.evaluate(async()=>window.athena!.enableHandsFree((await window.athena!.getChat()).sessionId))
    expect(lease.ok,lease.message).toBe(true)
    const page=browser.pages()[0]
    await browser.route('https://example.com/athena-ax-fixture',r=>r.fulfill({contentType:'text/html',body:'<title>Athena control fixture</title><button onclick="this.dataset.clickedAt=Date.now();this.textContent=\'Verified fixture click\';document.title=\'Athena verified\'">Athena fixture button</button>'}))
    await page.goto('https://example.com/athena-ax-fixture')
    const cdp=await browser.browser()!.newBrowserCDPSession()
    const pid=(await cdp.send('SystemInfo.getProcessInfo')).processInfo.find(p=>p.type==='browser')!.id
    const helper=resolve('build/native/athena-desktop-accessibility')
    const chromeWorkspace=async(operation:string)=>JSON.parse((await promisify(execFile)(helper,['com.google.Chrome','workspace',JSON.stringify({operation,pid,details:true})])).stdout)
    const activated=await chromeWorkspace('activate')
    expect(activated.ok,activated.message??activated.error).toBe(true)
    await expect.poll(async()=>(await chromeWorkspace('observe')).focused).toBe(true)
    const when=Date.now()
    const result=await floating.evaluate(async owner=>window.athena!.answerHandsFree({text:'Click "Athena fixture button" in Chrome',ownership:owner}),lease.ownership)
    expect(result.ok,result.message??result.text).toBe(true)
    await expect(page.getByRole('button',{name:'Verified fixture click'})).toBeVisible()
    const clickedAt=Number(await page.getByRole('button',{name:'Verified fixture click'}).getAttribute('data-clicked-at'))
    await expect.poll(()=>launched.evaluate(()=>(globalThis as unknown as Recordings).samples.some(s=>s.ripple))).toBe(true)
    const evidence=await launched.evaluate(({BrowserWindow})=>({samples:(globalThis as unknown as Recordings).samples,errors:(globalThis as unknown as Recordings).errors,windows:BrowserWindow.getAllWindows().map(w=>({page:w.webContents.getURL().split('/').pop()?.split('?')[0],visible:w.isVisible()}))}))
    const samples=evidence.samples
    const painted=samples.find(s=>s.target && s.visible && s.text.includes('click'))
    expect(painted,JSON.stringify({...evidence,samples:samples.slice(-6)})).toBeTruthy()
    expect(painted?.focusable).toBe(false)
    expect(painted!.time).toBeLessThanOrEqual(clickedAt)
    expect(samples.find(s=>s.ripple)!.time).toBeGreaterThanOrEqual(clickedAt)
    const inspected=await promisify(execFile)(helper,['com.google.Chrome','workspace',JSON.stringify({operation:'observe',pid,details:true})])
    expect(JSON.parse(inspected.stdout).focused).toBe(true)
    await expect.poll(()=>launched.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('interactionOverlay.html'))?.isVisible())).toBe(false)
    console.info('Packaged external AX action, ms',{instructionToHighlight:painted!.time-when,highlightToClick:clickedAt-painted!.time,clickToRipple:samples.find(s=>s.ripple)!.time-clickedAt})

    // A separate stock macOS application follows the same trusted-installed-app path as other apps.
    const editor=await control.evaluate(async()=>{
      const api=window.athena!,target=(await api.computerUseCheck('status')).installed?.find(a=>a.name==='TextEdit')
      if(!target)return false
      const {settings}=await api.getSnapshot()
      await api.updateSettings({computerUse:{...settings.computerUse,trustedInstalled:[target.key]}})
      return true
    })
    expect(editor).toBe(true)
    const file=join(profile,'Athena interaction fixture.txt'),exec=promisify(execFile)
    const workspace=async()=>JSON.parse((await exec(helper,['com.apple.TextEdit','workspace',JSON.stringify({operation:'observe',details:true})])).stdout)
    const original=await workspace()
    await writeFile(file,'Disposable accessibility test')
    await exec('/usr/bin/open',['-n','-a','TextEdit',file,'--args','-ApplePersistenceIgnoreState','YES'])
    await expect.poll(async()=>(await workspace()).focused).toBe(true)
    const fresh=await workspace()
    expect(fresh.pid).not.toBe(original.pid)
    try{
      const voice=(text:string)=>floating.evaluate(async ({text,ownership})=>window.athena!.answerHandsFree({text,ownership}),{text,ownership:lease.ownership})
      const opened=await voice('Open TextEdit')
      expect(opened.ok,opened.message??opened.text).toBe(true)
      expect(opened.text).toMatch(/already.*foreground/i)
      const inspected=await voice('Inspect TextEdit')
      expect(inspected.ok,inspected.message??inspected.text).toBe(true)
      const observed=await workspace()
      expect(observed.focused,`Expected TextEdit PID ${fresh.pid} to retain focus after inspection. Foreground PID ${observed.foreground}.`).toBe(true)
      const inventory=JSON.parse((await exec(helper,['','workspace',JSON.stringify({operation:'running'})])).stdout)
      expect(inventory.apps.find((a:{active:boolean})=>a.active)?.app).toBe('com.apple.TextEdit')
      const current=await voice('Use the current window')
      expect(current.ok,current.message??current.text).toBe(true)
      expect((await workspace()).pid).toBe(fresh.pid)
      console.info('Verified the existing foreground TextEdit instance and inspected its disposable document.')
    }finally{
      // Only the newly launched, separately verified fixture instance belongs to this test.
      if(fresh.pid!==original.pid && fresh.pid>0)process.kill(fresh.pid,'SIGTERM')
    }
  }finally{await browser.close();await launched.close();await rm(profile,{recursive:true,force:true})}
})
