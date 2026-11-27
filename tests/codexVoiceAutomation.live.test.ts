// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { CodexCLIService } from '../electron/main/ai/codexCLIService'
import { CodexVoiceAutomation, type CodexVoiceProgress } from '../electron/main/ai/codexVoiceAutomation'

it.skipIf(process.env.ATHENA_CODEX_VOICE_LIVE!=='1')('uses the actual subscription voice runner for two turns with fresh fixture evidence',async()=>{
  const cwd=await mkdtemp(join(tmpdir(),'athena-codex-voice-smoke-'))
  const service=new CodexCLIService('athena-voice-verification')
  const progress:CodexVoiceProgress[]=[], owners:string[]=[]
  const lease=randomUUID()
  let calls=0
  let marker=randomUUID() as string
  const runner=new CodexVoiceAutomation({service,cwd,announce:e=>progress.push(e),forget:owner=>owners.push(owner),
    selection:async()=>{
      const status=await service.status(true)
      expect(status.authenticated,status.message).toBe(true)
      return {model:'gpt-6.2-sol',effort:'low',identity:status.identity!}
    },tools:({check})=>{
      const receipts:string[]=[]
      return {assertAccess(){},definitions:[{name:'inspect_fixture',description:'Read the current disposable fixture label. Call once per request to obtain a fresh, verified value.',
        parameters:{type:'object',properties:{},required:[],additionalProperties:false}}],hasObservation:()=>receipts.length>0,verifiedResults:()=>receipts,verifiedActions:()=>[],
        execute:async(name,_arg,signal)=>{
          await check(signal)
          expect(name).toBe('inspect_fixture')
          calls++
          receipts.push('Fixture label '+marker)
          return JSON.stringify({ok:true,verified:true,message:'Fixture label '+marker})
        }}
    }})
  const deadline=setTimeout(()=>runner.end(lease),150000)
  try {
    let thread:string|undefined
    for(let i=0;i<2;i++){
      marker=randomUUID()
      const id=randomUUID()
      const objective=i?'Read the same fixture again. Call inspect_fixture once to get its new label.':'Read the current fixture. Call inspect_fixture once and report its exact label.'
      const answer=await runner.run(lease,id,objective,()=>true)
      expect(answer.ok,answer.message).toBe(true)
      expect(answer.text).toContain(marker)
      expect(calls).toBe(i+1)
      expect(await runner.run(lease,id,objective,()=>true)).toEqual(answer)
      expect(calls).toBe(i+1)
      const event=progress.findLast(e=>e.id===id)
      expect(event).toMatchObject({phase:'complete',verifiedSteps:1,model:'gpt-6.2-sol'})
      expect(event?.threadId).toBeTruthy()
      expect(event?.turnId).toBeTruthy()
      if(thread)expect(event!.threadId).toBe(thread)
      thread=event!.threadId
      console.info(JSON.stringify({test:'native-voice-runner',thread,turn:event!.turnId,calls,ms:Date.now()-event!.started}))
    }
    runner.end(lease)
    expect(owners).toEqual(['voice:'+lease])
  }finally{
    clearTimeout(deadline)
    runner.end(lease)
    const thread=progress.findLast(e=>e.threadId)?.threadId
    if(thread)await (await service.connection()).rpc.request('thread/archive',{threadId:thread}).catch(()=>{})
    await service.shutdown()
    await rm(cwd,{recursive:true,force:true})
  }
},160000)
