import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'

test.use({trace:'off'})
test('zero OpenAI budget continues through an installed Ollama planner and the real conversation service',async()=>{
  const executablePath=process.env.ATHENA_VOICE_TEST_BINARY,model=process.env.ATHENA_AUTOMATION_OLLAMA_MODEL
  const development=process.env.ATHENA_AUTOMATION_LOCAL_DEV==='1'
  test.skip((!executablePath && !development) || !model,'Requires a built Athena app and a preinstalled local chat model')
  test.setTimeout(130000)
  const profile=await mkdtemp(join(tmpdir(),'athena-offline-planner-'))
  let app:Awaited<ReturnType<typeof electron.launch>>|undefined
  try{
    await writeFile(join(profile,'settings.json'),JSON.stringify({floatingEnabled:false,voiceEnabled:false,
      computerUse:{enabled:true,planner:'local'},automationPermissions:{conversationManagement:true},
      applicationAutomation:{monthlyRequests:0,maxSteps:4},localAI:{model,contextLength:16384},
      webAccess:{webSearchEnabled:false,automaticStartup:false}}))
    app=await electron.launch({executablePath,args:[...(executablePath?[]:['.']),'--mute-audio','--user-data-dir='+profile],env:{...process.env,ATHENA_TEST_DATA:profile}})
    expect(await realpath(await app.evaluate(({app})=>app.getPath('userData')))).toBe(await realpath(profile))
    await expect.poll(()=>app!.windows().some(p=>p.url().includes('surface=control'))).toBe(true)
    const page=app.windows().find(p=>p.url().includes('surface=control'))!
    const result=await page.evaluate(async()=>{
      const api=window.athena!,snapshot=await api.getChat()
      return api.sendChat({sessionId:snapshot.sessionId,text:'Use my computer to check whether the active Athena conversation has a task running. Read its task status.'})
    })
    expect(result,result.message).toMatchObject({ok:true})
    await expect.poll(()=>page.evaluate(async()=> {
      const last=(await window.athena!.getChat()).messages.at(-1)
      return last?.role==='assistant' && ['error','complete'].includes(last.status)
    }),{timeout:105000}).toBe(true)
    const observed=await page.evaluate(async()=>{
      const snapshot=await window.athena!.getChat(),last=snapshot.messages.at(-1)
      return {status:last?.status,content:last?.content,error:last?.error,engine:snapshot.automationProgress?.engine}
    })
    expect(observed,observed.error).toMatchObject({status:'complete',content:expect.stringMatching(/active conversation is/i),engine:'Athena Native'})
    const status=await page.evaluate(async()=> (await window.athena!.computerUseCheck('activity')).automation)
    expect(status?.requests).toBe(0)
  }finally{await app?.close();await rm(profile,{recursive:true,force:true})}
})

test('signed Athena opens settings from chat and persists the automation engine and budget',async()=>{
  const executablePath=process.env.ATHENA_VOICE_TEST_BINARY
  test.skip(!executablePath,'Requires a signed build')
  test.setTimeout(90000)
  const profile=await mkdtemp(join(tmpdir(),'athena-automation-settings-'))
  let app:Awaited<ReturnType<typeof electron.launch>>|undefined
  async function launch() {
    app=await electron.launch({executablePath,args:['--mute-audio','--user-data-dir='+profile]})
    const child=app.process()
    child.stderr?.on('data',(bytes:Buffer)=>{
      const message=bytes.toString()
      if(/uncaught|fatal|startup failed|unhandled rejection/i.test(message))console.info('Disposable app startup',message.split('\n')[0].slice(0,220))
    })
    expect(await realpath(await app.evaluate(({app})=>app.getPath('userData')))).toBe(await realpath(profile))
    await expect.poll(()=>app!.windows().some(p=>p.url().includes('surface=control'))).toBe(true)
    await expect.poll(()=>app!.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().some(w=>w.webContents.getURL().includes('splash.html'))),{timeout:25000}).toBe(false)
    const page=app.windows().find(p=>p.url().includes('surface=control'))!
    await expect(page.getByRole('button',{name:'AI',exact:true})).toBeVisible()
    return page
  }
  try{
    await writeFile(join(profile,'settings.json'),JSON.stringify({floatingEnabled:false,voiceEnabled:false,strictOffline:true,
      computerUse:{enabled:true},automationPermissions:{internalNavigation:true},webAccess:{webSearchEnabled:false,automaticStartup:false}}))
    let page=await launch()
    const sent=await page.evaluate(async()=>{
      const api=window.athena!,chat=await api.getChat()
      return api.sendChat({text:"Open this app's AI settings",sessionId:chat.sessionId})
    })
    expect(sent,sent.message).toMatchObject({ok:true})
    const selector=page.getByRole('combobox',{name:'Automation engine',exact:true})
    await expect(selector).toHaveText(/OpenAI Automation/,{timeout:12000})
    const answer=await page.evaluate(async()=> (await window.athena!.getChat()).messages.at(-1))
    expect(answer).toMatchObject({role:'assistant',status:'complete'})
    expect(answer?.content).toMatch(/AI|settings/i)
    await page.getByText('Automation limits and usage',{exact:true}).click()
    const budget=page.getByRole('spinbutton',{name:'Monthly OpenAI automation requests'})
    await budget.fill('0')
    await budget.press('Tab')
    await selector.hover()
    await page.getByRole('option',{name:'Athena Native Automation'}).click()
    await expect.poll(()=>page.evaluate(async()=> (await window.athena!.getSnapshot()).settings.applicationAutomation)).toMatchObject({engine:'native',monthlyRequests:0})
    const child=app!.process(),exited=child.exitCode==null?once(child,'exit'):Promise.resolve()
    await app!.close();await exited;app=undefined
    page=await launch()
    await page.getByRole('button',{name:'AI',exact:true}).click()
    await expect(page.getByRole('combobox',{name:'Automation engine',exact:true})).toHaveText(/Athena Native Automation/)
    expect(await page.evaluate(async()=> (await window.athena!.getSnapshot()).settings.applicationAutomation.monthlyRequests)).toBe(0)
  }finally{await app?.close();await rm(profile,{recursive:true,force:true})}
})
