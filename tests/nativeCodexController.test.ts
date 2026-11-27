// @vitest-environment node
import { expect,it,vi } from 'vitest'
import { ChatController } from '../electron/main/ai/chatController'
import type { AIProvider, StreamOptions } from '../electron/main/ai/AIProvider'
import type { AIChunk } from '../shared/chat'
import { ConversationRepository } from '../electron/main/ai/conversationRepository'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

it('resumes an interrupted native task as new input on its existing thread with the newly selected model',async()=>{
  const calls:Array<{ids:string[];model:string;thread?:string;finish():void}>=[]
  const hooks={provider:async():Promise<AIProvider>=>{
    const model=chat.current().config.model!
    return {nativeAgent:true,nativeCodex:true,modelId:model,testConnection:async()=>true,async *streamMessage(messages,options){
      const host=options!.nativeCodex!,user=messages.findLast(m=>m.role==='user')!
      host.persist({threadId:'same-thread',cwd:'/fixture',account:'fixture',model,turnId:`turn-${calls.length+1}`,lastMessageId:user.id,submission:'accepted'})
      await new Promise<void>(finish=>{
        calls.push({ids:messages.filter(m=>m.role==='user').map(m=>m.id),model,thread:host.state?.threadId,finish})
        options!.signal!.addEventListener('abort',()=>finish(),{once:true})
      })
      options!.signal!.throwIfAborted()
      yield {type:'text',text:'Continued'};yield {type:'done'}
    }} satisfies AIProvider
  },nativeExecution:()=>true,prepareNative:async()=>({cwd:'/fixture',writableRoots:['/fixture'],context:{attachments:[],repositoryText:'',sources:[]}}),phase:()=>{},changed:()=>{}}
  const chat:ChatController=new ChatController(hooks)
  try{
    chat.current().config.model='gpt-6.2-astra'
    chat.send({text:'Complete the fixture task'})
    await vi.waitFor(()=>expect(calls).toHaveLength(1))
    chat.stop()
    await vi.waitFor(()=>expect(chat.current().messages.at(-1)?.status).toBe('stopped'))
    chat.current().config.model='gpt-6-astra'
    expect(chat.retry().ok).toBe(true)
    await vi.waitFor(()=>expect(calls).toHaveLength(2))
    expect(calls[1]).toMatchObject({model:'gpt-6-astra',thread:'same-thread'})
    expect(calls[1].ids).toHaveLength(2)
    expect(calls[1].ids[0]).toBe(calls[0].ids[0])
    expect(calls[1].ids[1]).not.toBe(calls[0].ids[0])
    expect(chat.current().messages.some(m=>m.status==='stopped')).toBe(true)
    calls[1].finish()
    await vi.waitFor(()=>expect(chat.current().messages.at(-1)?.status).toBe('complete'))
  }finally{calls.forEach(c=>c.finish());chat.dispose()}
})

it('bypasses Athena preparation and continuation, keeps concurrent native conversations independent, and persists native identity',async()=>{
  const prepared=vi.fn(),callbacks=new Map<string,{options:StreamOptions;finish():void}>()
  const provider:AIProvider={nativeAgent:true,nativeCodex:true,modelId:'gpt-6-astra',testConnection:async()=>true,async *streamMessage(_m,options):AsyncIterable<AIChunk>{
    const id=options!.conversationId!
    options!.nativeCodex!.persist({threadId:`native-${id}`,cwd:'/fixture',account:'fixture',submission:'accepted'})
    await new Promise<void>(finish=>callbacks.set(id,{options:options!,finish}))
    yield {type:'text',text:`Completed ${id}`};yield {type:'done'}
  }}
  const directory=await mkdtemp(join(tmpdir(),'athena-native-controller-')),storage=new ConversationRepository(directory)
  const chat=new ChatController({provider:async()=>provider,nativeExecution:()=>true,prepare:prepared,prepareNative:async()=>({cwd:'/fixture',writableRoots:['/fixture'],context:{attachments:[],repositoryText:'',sources:[]}}),phase:()=>{},changed:()=>{},maxConcurrent:()=>3},storage)
  const media={recover:vi.fn(),dispose:vi.fn(),intent:vi.fn(()=> 'text-to-image')}
  chat.attachMedia(media as never)
  try{
    const first=chat.current().id;expect(chat.send({text:'one'}).ok).toBe(true)
    await vi.waitFor(()=>expect(callbacks.has(first)).toBe(true))
    chat.command({action:'create'});const second=chat.current().id
    expect(chat.send({text:'two'}).ok).toBe(true);await vi.waitFor(()=>expect(callbacks.has(second)).toBe(true))
    // Invoke from outside the execution's async context, like shared RPC notifications.
    const approval=callbacks.get(first)!.options.requestApproval!('Codex approval','fixture command',new AbortController().signal)
    await vi.waitFor(()=>expect(chat.getSession(first)!.messages.at(-1)!.execution!.approval).toBeTruthy())
    const request=chat.getSession(first)!.messages.at(-1)!.execution!.approval!
    expect(chat.getSession(second)!.messages.at(-1)!.execution!.approval).toBeUndefined()
    expect(chat.command({action:'agent-approval',id:first,approvalId:request.id,allow:false}).ok).toBe(true)
    expect(await approval).toBe(false)
    callbacks.get(first)!.finish();await vi.waitFor(()=>expect(chat.getSession(first)!.messages.at(-1)!.status).toBe('complete'))
    expect(chat.getSession(second)!.messages.at(-1)!.status).toBe('streaming')
    callbacks.get(second)!.finish();await vi.waitFor(()=>expect(chat.getSession(second)!.messages.at(-1)!.status).toBe('complete'))
    expect(prepared).not.toHaveBeenCalled();expect(media.intent).not.toHaveBeenCalled()
    expect(chat.getSession(first)!.messages.at(-1)!.execution?.taskCheckpoint).toBeUndefined()
    expect(callbacks.get(first)!.options.continuation).toBeUndefined()
    expect(callbacks.get(first)!.options.context?.projectTools).toBeUndefined()
    expect(storage.load().sessions.find(s=>s.id===first)?.nativeCodex?.threadId).toBe(`native-${first}`)
  }finally{chat.dispose()}
})

it('freezes native access at submission, preserves active approvals, and isolates next-turn settings across restart',async()=>{
  const calls:Array<{id:string;options:StreamOptions;finish():void}>=[]
  let prepare!:()=>void
  const prepared=new Promise<void>(resolve=>{prepare=resolve})
  const provider:AIProvider={nativeAgent:true,nativeCodex:true,modelId:'gpt-6-astra',testConnection:async()=>true,async *streamMessage(_m,options){
    await new Promise<void>(finish=>calls.push({id:options!.conversationId!,options:options!,finish}))
    yield {type:'done'}
  }}
  const repository=new ConversationRepository(await mkdtemp(join(tmpdir(),'athena-codex-access-')))
  const hooks={provider:async()=>provider,nativeExecution:()=>true,prepareNative:async()=>{await prepared;return {cwd:'/fixture',writableRoots:['/fixture'],context:{attachments:[],repositoryText:'',sources:[]}}},phase:()=>{},changed:()=>{},maxConcurrent:()=>3}
  const chat=new ChatController(hooks,repository)
  try{
    const first=chat.current().id
    chat.command({action:'agent-mode',id:first,mode:'ask'})
    expect(chat.send({text:'first'}).ok).toBe(true)
    // Change while provider setup is pending, before the stream even begins.
    expect(chat.command({action:'agent-mode',id:first,mode:'full-access'}).ok).toBe(false)
    expect(chat.command({action:'agent-mode',id:first,mode:'full-access',confirmed:true}).ok).toBe(true)
    prepare();await vi.waitFor(()=>expect(calls).toHaveLength(1))
    expect(calls[0].options.permissionMode).toBe('ask')
    expect(calls[0].options.signal!.aborted).toBe(false)
    const approval=calls[0].options.requestApproval!('Native approval','fixture',calls[0].options.signal!)
    await vi.waitFor(()=>expect(chat.getSession(first)!.messages.at(-1)?.execution?.approval).toBeTruthy())
    const approvalId=chat.getSession(first)!.messages.at(-1)!.execution!.approval!.id
    chat.command({action:'agent-mode',id:first,mode:'read-only'})
    expect(chat.getSession(first)!.messages.at(-1)!.execution!.approval!.id).toBe(approvalId)
    expect(chat.command({action:'agent-approval',id:first,approvalId,allow:true}).ok).toBe(true)
    expect(await approval).toBe(true)
    chat.command({action:'agent-mode',id:first,mode:'full-access'})
    chat.command({action:'create'});const second=chat.current().id
    expect(chat.current().config.codexFullAccessConfirmed).toBeUndefined()
    expect(chat.current().config.agentMode).toBe('ask')
    chat.command({action:'agent-mode',id:second,mode:'read-only'});chat.send({text:'second'})
    await vi.waitFor(()=>expect(calls).toHaveLength(2))
    expect(calls[1].options.permissionMode).toBe('read-only')
    calls[0].finish();await vi.waitFor(()=>expect(chat.getSession(first)!.messages.at(-1)!.status).toBe('complete'))
    chat.command({action:'switch',id:first});chat.send({text:'next turn'})
    await vi.waitFor(()=>expect(calls).toHaveLength(3))
    expect(calls[2].options.permissionMode).toBe('full-access')
    expect(calls[2].options.nativeCodex!.fullAccessConfirmed).toBe(true)
    expect(calls[1].options.signal!.aborted).toBe(false)
    calls[1].finish();calls[2].finish()
    await vi.waitFor(()=>expect(chat.getSession(first)!.messages.at(-1)!.status).toBe('complete'))
    chat.dispose()
    const restored=new ChatController(hooks,repository)
    try{
      expect(restored.getSession(first)!.config).toMatchObject({agentMode:'full-access',codexFullAccessConfirmed:true})
      expect(restored.getSession(second)!.config.agentMode).toBe('read-only')
      expect(restored.getSession(second)!.config.codexFullAccessConfirmed).toBeUndefined()
    }finally{restored.dispose()}
  }finally{prepare();calls.forEach(c=>c.finish());chat.dispose()}
})
