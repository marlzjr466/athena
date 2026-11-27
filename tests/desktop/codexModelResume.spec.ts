import {test,expect,_electron as electron} from '@playwright/test'
import {mkdtemp,writeFile,realpath} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

test('composer stops, switches Astra models and continues the same real Codex thread',async()=>{
  test.skip(process.env.ATHENA_CODEX_MODEL_RESUME_E2E!=='1','Uses the authorized Codex subscription in an isolated read-only workspace.')
  test.setTimeout(150000)
  const profile=await mkdtemp(join(tmpdir(),'athena-model-resume-ui-'))
  const root=await realpath(await mkdtemp(join(tmpdir(),'athena-model-resume-project-')))
  await writeFile(join(profile,'settings.json'),JSON.stringify({aiMode:'subscription',voiceEnabled:false,floatingEnabled:false,randomMovement:false,randomActions:false,webAccess:{enabled:false,searxngAutoStart:false}}))
  const binary=process.env.ATHENA_VOICE_TEST_BINARY
  const app=await electron.launch({...(binary?{executablePath:binary}:{}),args:[...(binary?[]:['.']),'--mute-audio','--user-data-dir='+profile],env:{...process.env,ATHENA_TEST_DATA:profile},timeout:40000})
  try{
    expect(await realpath(await app.evaluate(({app})=>app.getPath('userData')))).toBe(await realpath(profile))
    await expect.poll(()=>app.windows().some(p=>p.url().includes('surface=control'))).toBe(true)
    const page=app.windows().find(p=>p.url().includes('surface=control'))!
    await app.evaluate(({dialog},root)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[root]})},root)
    await page.evaluate(async()=>{
      const api=window.athena!,status=await api.getCodexCLIStatus({refresh:true})
      if(!status.authenticated)throw Error(status.message)
      await api.setPermissionEnabled({permission:'personalFiles',enabled:true})
      const c=await api.getChat()
      for(const result of [await api.chatContext({action:'connect',sessionId:c.sessionId!}),await api.chatSession({action:'select-account-model',id:c.sessionId!,route:{provider:'subscription',accountId:'codex-local'},model:'gpt-6.2-astra'}),await api.chatSession({action:'configure-effort',id:c.sessionId!,effort:'high'}),await api.chatSession({action:'agent-mode',id:c.sessionId!,mode:'read-only'})])if(!result.ok)throw Error(result.message)
    })
    await page.getByRole('button',{name:'Conversation',exact:true}).click()
    const composer=page.getByRole('textbox',{name:'Message Athena',exact:true})
    await composer.fill('Run the read-only command sleep 15 with exec_command, then reply ready. This is an interruption test. If interrupted and asked to continue, do not repeat the command: just reply resumed. Do not use other tools, access files, or use the network.')
    await page.getByRole('button',{name:'Send message',exact:true}).click()
    await expect.poll(()=>page.evaluate(()=>window.athena!.getChat().then(c=>c.messages.at(-1)?.execution?.activities.some(a=>a.tool==='codex.commandExecution' && a.status==='running'))),{timeout:45000}).toBe(true)
    await expect(page.getByRole('button',{name:'Send follow-up',exact:true})).toHaveCount(0)
    await expect(page.getByRole('status').filter({hasText:/Codex access|Access changes apply/})).toHaveCount(0)
    const boxes=await Promise.all([page.getByRole('combobox',{name:'Coding agent permissions'}),page.getByRole('button',{name:'Conversation model'}),page.getByRole('combobox',{name:'Reasoning effort'})].map(l=>l.boundingBox()))
    const centers=boxes.map(b=>b!.y+b!.height/2)
    expect(Math.max(...centers)-Math.min(...centers)).toBeLessThan(3)
    await page.screenshot({path:'/private/tmp/athena-model-resume-busy.png'})
    const before=await page.evaluate(()=>window.athena!.getChat())
    await page.getByRole('button',{name:'Stop generation',exact:true}).click()
    await expect(page.getByRole('button',{name:'Conversation model'})).toBeEnabled()
    await page.getByRole('button',{name:'Conversation model'}).click()
    await page.getByRole('textbox',{name:'Search models'}).fill('gpt-6-astra')
    await page.getByRole('option',{name:/^GPT-6-Astra/}).first().click()
    await expect.poll(()=>page.evaluate(()=>window.athena!.getChat().then(c=>c.config?.model))).toBe('gpt-6-astra')
    await page.getByRole('button',{name:'Continue unfinished task',exact:true}).click()
    await expect.poll(()=>page.evaluate(()=>window.athena!.getChat().then(c=>c.messages.at(-1)?.status)),{timeout:60000}).toBe('complete')
    const after=await page.evaluate(()=>window.athena!.getChat())
    expect(after.nativeCodex).toMatchObject({threadId:before.nativeCodex!.threadId,model:'gpt-6-astra',effort:'high',submission:'completed'})
    expect(after.messages.filter(m=>m.role==='user')).toHaveLength(2)
    expect(after.messages.filter(m=>m.role==='assistant' && m.status==='stopped')).toHaveLength(1)
    expect(after.codexAccess?.status).toBe('verified')
    await page.screenshot({path:'/private/tmp/athena-model-resume-complete.png'})
    await writeFile('/private/tmp/athena-model-resume-ui-evidence.json',JSON.stringify({sameThread:true,model:after.nativeCodex!.model,effort:after.nativeCodex!.effort,status:after.messages.at(-1)!.status,stoppedTurnPreserved:true,selectorsInline:true,removedFollowupButton:true,removedAccessStatusLine:true},null,2))
  }finally{await app.close()}
})
