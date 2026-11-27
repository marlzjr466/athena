import { _electron as electron, chromium, expect, test } from '@playwright/test'
import { build } from 'esbuild'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
test.use({trace:'off'})
for(const kind of ['pointer','visual','environment'] as const)test(({pointer:'local desktop fixture verifies real pointer input',visual:'the live OpenAI computer tool operates a disposable desktop window and reads its changed state',environment:'managed environment capability check without starting inference'})[kind],async()=>{
  const paid=kind==='visual'
  const enabled=kind==='environment'?process.env.ATHENA_OPENAI_ENV_TEST==='1':paid?process.env.ATHENA_OPENAI_COMPUTER_TEST==='authorized':process.env.ATHENA_WINDOW_LIVE==='1'
  test.skip(!enabled || process.platform!=='darwin','Requires the signed Mac fixture and separate authorization for paid requests.')
  test.setTimeout(115000)
  const profile=await mkdtemp(join(tmpdir(),'athena-computer-probe-'))
  let application:Awaited<ReturnType<typeof electron.launch>>|undefined
  try {
    await writeFile(join(profile,'settings.json'),JSON.stringify({floatingEnabled:false,voiceEnabled:false,randomMovement:false,randomActions:false}))
    const file=join(profile,'probe.cjs')
    await build({entryPoints:['tests/desktop/fixtures/applicationAutomationProbe.ts'],outfile:file,bundle:true,format:'cjs',platform:'node',external:['electron','@napi-rs/keyring'],logLevel:'silent'})
    application=await electron.launch({executablePath:process.env.ATHENA_VOICE_TEST_BINARY ?? resolve('release/mac-arm64/Athena.app/Contents/MacOS/Athena'),args:['--mute-audio','--user-data-dir='+profile]})
    const result=await application.evaluate(async({app},{file,paid,kind})=>{
      await app.whenReady()
      const fs=process.getBuiltinModule('fs'),path=process.getBuiltinModule('path')
      if(!app.isPackaged || fs.realpathSync(path.dirname(file))!==fs.realpathSync(app.getPath('userData')))throw new Error('Unexpected test profile.')
      const probe=process.getBuiltinModule('module').createRequire(file)(file)
      return kind==='environment'?probe.checkEnvironment():probe.runProbe(paid)
    },{file,paid,kind})
    console.info('Live computer use measurements',result)
    if(kind==='environment'){expect(result.some((r:{issued?:boolean})=>r.issued)).toBe(true);return}
    expect(result.inputs).toBe(1);expect(result.actual).toBe('Locker 47');if(!paid)return
    expect(result.message).toContain('47')
    expect(result.requests).toBeLessThanOrEqual(4);expect(result.estimatedUSD).toBeLessThan(0.20)
  } finally {await application?.close();await rm(profile,{recursive:true,force:true})}
})

test('the approved-window driver clicks a verified Chrome control using macOS pointer input',async()=>{
  const executablePath=process.env.ATHENA_VOICE_TEST_BINARY
  test.skip(!executablePath || process.platform!=='darwin' || process.env.ATHENA_WINDOW_LIVE!=='1','Requires the signed Mac app and a visible test browser.')
  test.setTimeout(65000)
  const profile=await mkdtemp(join(tmpdir(),'athena-native-pointer-'))
  let application:Awaited<ReturnType<typeof electron.launch>>|undefined
  let browser:Awaited<ReturnType<typeof chromium.launchPersistentContext>>|undefined
  try{
    const file=join(profile,'native-probe.cjs')
    await build({entryPoints:['tests/desktop/fixtures/applicationAutomationProbe.ts'],outfile:file,bundle:true,format:'cjs',platform:'node',external:['electron','@napi-rs/keyring'],logLevel:'silent'})
    application=await electron.launch({executablePath,args:['--mute-audio','--user-data-dir='+profile]})
    await expect.poll(()=>application!.windows().some(p=>p.url().includes('surface=control'))).toBe(true)
    await expect.poll(()=>application!.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().some(w=>w.webContents.getURL().includes('splash.html'))),{timeout:25000}).toBe(false)
    const access=await application.evaluate(({systemPreferences})=>({screen:systemPreferences.getMediaAccessStatus('screen'),ax:systemPreferences.isTrustedAccessibilityClient(false)}))
    console.info('Signed Mac permissions',access)
    test.skip(access.screen!=='granted' || !access.ax,'The signed app requires macOS Screen Recording and Accessibility to test native visual input.')
    browser=await chromium.launchPersistentContext(join(profile,'chrome'),{channel:'chrome',headless:false,viewport:null})
    const page=browser.pages()[0]
    await page.setContent('<title>Athena isolated pointer test</title><button aria-label="Marker" style="margin:60px;width:280px;height:100px;background:lime" onclick="this.style.background=\'blue\';this.textContent=\'Verified native click\'">Marker</button>')
    await page.bringToFront()
    const cdp=await browser.browser()!.newBrowserCDPSession()
    const pid=(await cdp.send('SystemInfo.getProcessInfo')).processInfo.find(p=>p.type==='browser')!.id
    const result=await application.evaluate(async({app},{file,pid})=>{
      const fs=process.getBuiltinModule('fs'),path=process.getBuiltinModule('path')
      if(!app.isPackaged || fs.realpathSync(path.dirname(file))!==fs.realpathSync(app.getPath('userData')))throw new Error('Expected an isolated packaged app.')
      return process.getBuiltinModule('module').createRequire(file)(file).nativePointer(pid)
    },{file,pid})
    expect(result).toMatchObject({applied:true})
    await expect(page.getByRole('button',{name:'Marker'})).toHaveText('Verified native click')
  }finally{await browser?.close();await application?.close();await rm(profile,{recursive:true,force:true})}
})
