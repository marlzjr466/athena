// @vitest-environment node
import {randomUUID} from 'node:crypto'
import {mkdtemp, readFile, realpath, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {expect,it} from 'vitest'
import {z} from 'zod'
import {voiceBrowserActionSchema} from '../shared/voiceBrowser'
import {CodexCLIService} from '../electron/main/ai/codexCLIService'
import {CodexAppServerProvider} from '../electron/main/ai/CodexAppServerProvider'
import type {NativeCodexThread} from '../shared/codex'
import type {ProjectTools} from '../electron/main/ai/AIProvider'

it.skipIf(process.env.ATHENA_CODEX_COMPUTER_LIVE!=='1')('dispatches a real native computer-tool request and resumes with a fresh executor binding',async()=>{
  const root=await realpath(await mkdtemp(join(tmpdir(),'athena-codex-tool-test-')))
  const service=new CodexCLIService('athena-native-computer-test')
  let saved:NativeCodexThread|undefined
  try {
    const status=await service.status(true)
    expect(status.authenticated,status.message).toBe(true)
    const model=status.models.find(m=>m.id==='gpt-6.2-sol')
    expect(model).toBeDefined()
    const provider=new CodexAppServerProvider(service,model!.id,status.identity!)
    let initialThread:string|undefined
    const turns:string[]=[]
    for(let i=0;i<2;i++) {
      const sentinel=randomUUID()
      await writeFile(join(root,'fixture.txt'),sentinel)
      let dispatches=0, output=''
      const {$schema: _dialect,...browserParameters}=z.toJSONSchema(voiceBrowserActionSchema,{io:'input'})
      const tools:ProjectTools={definitions:[{name:'athena_browser_action',description:'Use action inspect to inspect the disposable test page fixture.',parameters:browserParameters},{name:'inspect_fixture',description:'Return the current value of a disposable test fixture.',parameters:{type:'object',properties:{},required:[],additionalProperties:false}}],assertAccess(){},
        execute:async(name,args,signal)=>{
          signal.throwIfAborted()
          expect(name).toBe(i===0?'inspect_fixture':'athena_browser_action')
          if(i===1)expect(voiceBrowserActionSchema.parse(args)).toEqual({action:'inspect'})
          dispatches++
          return JSON.stringify({ok:true,value:await readFile(join(root,'fixture.txt'),'utf8')})
        }}
      const started=Date.now()
      for await(const c of provider.streamMessage([{id:randomUUID(),role:'user',content:i===0 ? 'Call inspect_fixture once to read the fresh current fixture value and reply with the exact value. Do not use any other tool.' : 'Inspect the disposable test page using athena_browser_action with action inspect. Return the exact fresh fixture value from that single result. Do not use other tools.',status:'complete',createdAt:started}],{
        effort:'low',permissionMode:'read-only',signal:AbortSignal.timeout(90000),nativeCodex:{state:saved,cwd:root,writableRoots:[],computerTools:tools,voiceOnly:true,
          persist:s=>{saved=s},requestUserInput:async()=>({}),finalText:text=>{output=text}},
      })) { if(c.type==='activity')expect(c.tool).not.toBe('codex.commandExecution') }
      expect(saved?.submission).toBe('completed');expect(saved?.computerToolsRegistered).toBe(true)
      expect(dispatches).toBe(1);expect(output).toContain(sentinel)
      if(initialThread)expect(saved?.threadId).toBe(initialThread)
      else initialThread=saved!.threadId
      expect(turns).not.toContain(saved!.turnId)
      turns.push(saved!.turnId!)
      console.info(JSON.stringify({test:'native-tool-dispatch',thread:initialThread,turn:saved!.turnId,dispatches,elapsedMs:Date.now()-started}))
      await writeFile(join(root,'native-evidence.json'),JSON.stringify({thread:initialThread,turns,model:model!.id,dispatchesPerTurn:1,outputMatchesFixture:true}))
      if(i===0)await service.shutdown()
    }
  } finally {
    if(saved)await (await service.connection()).rpc.request('thread/archive',{threadId:saved.threadId}).catch(()=>{})
    await service.shutdown()
  }
},210000)

it.skipIf(!process.env.ATHENA_CODEX_HISTORY_VOICE_CWD || !process.env.ATHENA_CODEX_HISTORY_CHAT_THREAD)('hides a persisted native voice thread and still reads the listed chat fixture',async()=>{
  const cwd=process.env.ATHENA_CODEX_HISTORY_VOICE_CWD!
  const chat=process.env.ATHENA_CODEX_HISTORY_CHAT_THREAD!
  const service=new CodexCLIService('athena-history-scope-test',cwd)
  try {
    const session=await service.connection()
    await service.account(session)
    const result=await session.rpc.request('thread/list',{currentAccountOnly:true,cwd,limit:25}) as {data:Array<{id:string;threadSource:string|null}>}
    const voice=result.data.find(t=>t.threadSource===null)
    expect(voice,'No existing source-less production voice thread in the selected workspace').toBeDefined()
    await expect(service.assertChatThread(voice!.id)).rejects.toThrow('voice automation history')
    let cursor:string|null|undefined,foundChat=false
    do {
      const page=await service.listThreads(cursor??undefined)
      expect(page.data.some(t=>t.id===voice!.id)).toBe(false)
      foundChat=page.data.some(t=>t.id===chat)
      cursor=page.nextCursor
    }while(cursor && !foundChat)
    expect(foundChat,'Signed test chat must still be indexed').toBe(true)
    await expect(service.readThread(voice!.id)).rejects.toThrow('Refresh')
    expect((await service.readThread(chat)).thread.id).toBe(chat)
  } finally {await service.shutdown()}
},60000)
