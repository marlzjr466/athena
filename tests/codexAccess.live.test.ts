// @vitest-environment node
import {expect,it} from 'vitest'
import {mkdtemp,readFile,writeFile,realpath} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {randomUUID} from 'node:crypto'
import {CodexCLIService} from '../electron/main/ai/codexCLIService'
import {CodexAppServerProvider} from '../electron/main/ai/CodexAppServerProvider'
import type {NativeCodexThread,CodexAccessStatus} from '../shared/codex'
import {observeCodex} from './fixtures/codexIntegrationDiagnostics'

it.skipIf(process.env.ATHENA_CODEX_ACCESS_LIVE!=='1')('verifies installed native policies, real approval, unrestricted execution and resumed read-only history',async()=>{
  const service=new CodexCLIService('athena-access-verification')
  let saved:NativeCodexThread|undefined
  const root=await realpath(await mkdtemp(join(tmpdir(),'athena-native-access-')))
  const evidence:Array<unknown>=[]
  const protocol:unknown[]=[]
  const conversationId=randomUUID()
  try{
    const status=await service.status(true);expect(status.authenticated,status.message).toBe(true)
    expect(status.models.some(m=>m.id==='gpt-6-astra')).toBe(true)
    const provider=new CodexAppServerProvider(service,'gpt-6-astra',status.identity!)
    await writeFile(join(root,'sentinel.txt'),'preserve\n')
    for (const mode of ['ask','full-access','read-only'] as const){
      protocol.push({conversationId,requested:{model:'gpt-6-astra',effort:'high',mode},recovery:mode==='ask'?'new-thread':mode==='full-access'?'loaded-thread':'app-server-restart'})
      const finishDiagnostics=observeCodex(await service.connection(),conversationId,protocol)
      const approvals:string[]=[],policies:CodexAccessStatus[]=[]
      const prompt=mode==='ask'
        ? 'Permission integration test in this disposable directory. Use exec_command with sandbox_permissions="require_escalated" and justification="May I write the disposable permission fixture?" to run exactly: printf "approved\\n" > access.txt . Request approval for this test even if an ordinary sandbox write is possible. Do not use apply_patch. Read access.txt to verify. No other writes, no network.'
        : mode==='full-access' ? 'Append exactly "unrestricted\\n" to access.txt, then read it to verify. Use exec_command. No other writes, no network.'
        : 'Read access.txt and sentinel.txt and report their exact contents. Do not write or run network commands.'
      const started=Date.now()
      const outputs=[]
      for await (const output of provider.streamMessage([{id:randomUUID(),role:'user',content:prompt,status:'complete',createdAt:Date.now()}],{
        signal:new AbortController().signal,permissionMode:mode,effort:'high',nativeCodex:{state:saved,fullAccessConfirmed:true,cwd:root,writableRoots:[root],persist:s=>{saved=s},policyStatus:s=>policies.push(s),requestUserInput:async()=>({})},
        requestApproval:async(title,description)=>{
          approvals.push(title)
          // Test authorization is confined to this disposable fixture command.
          const allowed=mode==='ask' && description.includes('access.txt') && !/curl|wget|rm |sudo|token|password/i.test(description)
          expect(allowed,description).toBe(true);return allowed
        },
      }))outputs.push(output)
      expect(saved?.submission).toBe('completed')
      expect(saved?.model).toBe('gpt-6-astra');expect(saved?.effort).toBe('high')
      expect(policies.at(-1)?.status,JSON.stringify(policies)).toBe('verified')
      expect(JSON.parse(saved!.sandbox!).type).toBe(mode==='ask'?'workspaceWrite':mode==='full-access'?'dangerFullAccess':'readOnly')
      expect(JSON.parse(saved!.approvalPolicy!)).toBe(mode==='full-access'?'never':'on-request')
      if(mode==='ask')expect(approvals.length).toBeGreaterThan(0);else expect(approvals).toHaveLength(0)
      expect(await readFile(join(root,'sentinel.txt'),'utf8')).toBe('preserve\n')
      expect(await readFile(join(root,'access.txt'),'utf8')).toBe(mode==='ask'?'approved\n':'approved\nunrestricted\n')
      evidence.push({mode,ms:Date.now()-started,approvals:approvals.length,policy:policies.at(-1),thread:saved!.threadId,turn:saved!.turnId,commands:outputs.filter(o=>o.type==='activity'&&o.tool==='codex.commandExecution').length})
      finishDiagnostics()
      await writeFile('/private/tmp/athena-codex-protocol-audit.json',JSON.stringify(protocol,null,2))
      if(mode==='full-access')await service.shutdown() // also verify a policy change on an already loaded thread
    }
    expect((await service.turns(saved!.threadId)).data).toHaveLength(3)
    await writeFile('/private/tmp/athena-codex-access-live.json',JSON.stringify({root,evidence},null,2))
    console.info(JSON.stringify(evidence))
  }finally{if(saved)try{await (await service.connection()).rpc.request('thread/archive',{threadId:saved.threadId})}catch{/* keep history if archive fails */}await service.shutdown()}
},240000)
