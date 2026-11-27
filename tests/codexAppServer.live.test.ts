// @vitest-environment node
/** Account-backed native harness parity. Only disposable fixture files are changed. */
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { CodexAppServerProvider, nativeCodexPolicy } from '../electron/main/ai/CodexAppServerProvider'
import { CodexCLIService } from '../electron/main/ai/codexCLIService'
import type { NativeCodexThread } from '../shared/codex'
import type { AIChunk, ChatMessage } from '../shared/chat'
import type { Turn } from '../electron/main/ai/codexProtocol/v2/Turn'
const enabled=process.env.ATHENA_CODEX_LIVE_TEST==='1'
describe.skipIf(!enabled)('native Codex harness parity',()=>{
  it('compares direct app-server and Athena using identical root, model, effort and native tools, then resumes without replay',async()=>{
    const service=new CodexCLIService('athena-native-parity')
    const roots:string[]=[],threadIds:string[]=[]
    try {
      const status=await service.status(true);expect(status.authenticated,status.message).toBe(true)
      const model=status.models.find(m=>m.id==='gpt-6-astra') ?? status.models.find(m=>m.isDefault)!
      expect(model).toBeTruthy()
      const effort=model.efforts.includes('high')?'high' as const:'auto' as const
      const root=await mkdtemp(join(tmpdir(),'athena-native-parity-'));roots.push(root)
      await writeFile(join(root,'AGENTS.md'),'Only edit result.txt for this isolated test. Preserve sentinel.txt. Do not access services or credentials.\n')
      await writeFile(join(root,'sentinel.txt'),'preserve-user-change\n')
      const prompt='Read AGENTS.md. Create result.txt containing exactly native-codex-ok followed by a newline. Read the file to verify it. Do not change any other file. Do not commit. Reply briefly with the verified result.'
      const initial=()=>writeFile(join(root,'result.txt'),'starting-fixture\n')
      const connection=await service.connection(),rpc=connection.rpc
      const policy=nativeCodexPolicy('workspace-auto',[root])
      await initial()
      const direct=await rpc.request('thread/start',{cwd:root,model:model.id,modelProvider:'openai',sandbox:policy.sandbox,approvalPolicy:policy.approvalPolicy,approvalsReviewer:'user',ephemeral:false}) as {thread:{id:string};model:string;cwd:string}
      threadIds.push(direct.thread.id)
      const directEvents:string[]=[]
      let resolve!:(turn:Turn)=>void
      const completed=new Promise<Turn>(done=>{resolve=done})
      const off=rpc.onNotification(e=>{if(e.params?.threadId===direct.thread.id){directEvents.push(e.method??'');if(e.method==='turn/completed')resolve(e.params.turn as Turn)}})
      const deny=rpc.onServerRequest(e=>{if(e.params?.threadId===direct.thread.id && e.id!==undefined)rpc.rejectRequest(e.id,'The fixture does not authorize elevated access.')})
      const directStart=performance.now()
      await rpc.request('turn/start',{threadId:direct.thread.id,clientUserMessageId:randomUUID(),input:[{type:'text',text:prompt,text_elements:[]}],model:model.id,effort:effort==='auto'?null:effort,cwd:root,sandboxPolicy:policy.sandboxPolicy,approvalPolicy:policy.approvalPolicy,approvalsReviewer:'user'})
      const directTurn=await completed;off();deny()
      expect(directTurn.status,JSON.stringify(directTurn.error)).toBe('completed')
      const directMs=Math.round(performance.now()-directStart),directResult=await readFile(join(root,'result.txt'),'utf8')
      expect(directResult).toBe('native-codex-ok\n');expect(await readFile(join(root,'sentinel.txt'),'utf8')).toBe('preserve-user-change\n')
      await initial()
      let saved:NativeCodexThread|undefined
      const provider=new CodexAppServerProvider(service,model.id,status.identity!)
      const user:ChatMessage={id:randomUUID(),role:'user',content:prompt,status:'complete',createdAt:Date.now()}
      const chunks:AIChunk[]=[],abort=new AbortController(),athenaStart=performance.now()
      const options=()=>({signal:abort.signal,effort,permissionMode:'workspace-auto' as const,nativeCodex:{state:saved,cwd:root,writableRoots:[root],persist:(s:NativeCodexThread)=>{saved=s},requestUserInput:async()=>({})},requestApproval:async()=>false})
      for await(const chunk of provider.streamMessage([user],options()))chunks.push(chunk)
      const athenaMs=Math.round(performance.now()-athenaStart)
      expect(saved?.submission).toBe('completed');threadIds.push(saved!.threadId)
      expect(await readFile(join(root,'result.txt'),'utf8')).toBe(directResult)
      expect(await readFile(join(root,'sentinel.txt'),'utf8')).toBe('preserve-user-change\n')
      expect(chunks.some(c=>c.type==='activity' && c.tool==='codex.commandExecution')).toBe(true)
      const before=(await service.turns(saved!.threadId)).data.length
      for await(const _chunk of provider.streamMessage([user],options())) { /* same user ID: only reconcile */ }
      expect((await service.turns(saved!.threadId)).data).toHaveLength(before)
      await service.shutdown()
      const followup={...user,id:randomUUID(),content:'Read result.txt without changing it and report its contents. Use the existing thread history.'}
      for await(const _chunk of provider.streamMessage([followup],options())) { /* native resume after process restart */ }
      expect(saved?.submission).toBe('completed');expect((await service.turns(saved!.threadId)).data).toHaveLength(before+1)
      const report={model:model.id,effort,root,directMs,athenaMs,nativeCommandSeen:chunks.some(c=>c.type==='activity'&&c.tool==='codex.commandExecution'),directEvents:[...new Set(directEvents)],sameAccount:true,noReplay:true,restartResume:true,threadIds}
      await writeFile('/private/tmp/athena-native-live-evidence.json',JSON.stringify(report,null,2))
      console.log(JSON.stringify(report))
    } finally {
      for(const threadId of threadIds)try{await (await service.connection()).rpc.request('thread/archive',{threadId})}catch{/* preserve evidence if archive unavailable */}
      await service.shutdown()
    }
  },240_000)
})
