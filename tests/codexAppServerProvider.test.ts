// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import type { AIChunk, ChatMessage } from '../shared/chat'
import type { NativeCodexThread } from '../shared/codex'
import type { StreamOptions } from '../electron/main/ai/AIProvider'
import { CodexAppServerProvider, nativeCodexPolicy, nativeItemActivity } from '../electron/main/ai/CodexAppServerProvider'
import type { CodexCLIService, RpcReply } from '../electron/main/ai/codexCLIService'
const messages:ChatMessage[]=[{id:'u1',role:'user',content:'Inspect the fixture.',status:'complete',createdAt:1}]
function fixture(state?:NativeCodexThread){
  const listeners=new Set<(e:RpcReply)=>void>(),requests=new Set<(e:RpcReply)=>void>()
  const emit=(e:RpcReply)=>listeners.forEach(l=>l(e))
  const rpc={isClosed:false,request:vi.fn(async(method:string,_params:unknown):Promise<unknown>=>{
    if(method==='thread/read')return {thread:{status:{type:'idle'}}}
    if(method==='thread/start'||method==='thread/resume')return {thread:{id:'thread-1',status:{type:'idle'}},model:'gpt-6-astra',reasoningEffort:'high',modelProvider:'openai',cwd:'/fixture',sandbox:nativeCodexPolicy(options.permissionMode ?? 'ask',['/fixture']).sandboxPolicy,approvalPolicy:nativeCodexPolicy(options.permissionMode ?? 'ask',[]).approvalPolicy,instructionSources:['/fixture/AGENTS.md']}
    if(method==='turn/start'){setTimeout(()=>{emit({method:'item/agentMessage/delta',params:{threadId:'thread-1',turnId:'turn-1',itemId:'msg',delta:'Done'}});emit({method:'turn/completed',params:{threadId:'thread-1',turn:{id:'turn-1',status:'completed'}}})},150);return {turn:{id:'turn-1'}}}
    return {}
  }),respond:vi.fn(),rejectRequest:vi.fn(),onNotification:(l:(e:RpcReply)=>void)=>{listeners.add(l);return()=>listeners.delete(l)},onServerRequest:(l:(e:RpcReply)=>void)=>{requests.add(l);return()=>requests.delete(l)}}
  const connection={rpc,accountEmail:'fixture@example.com',accountId:'fixture',models:[{id:'gpt-6-astra',efforts:['high']}],close:vi.fn()}
  const service={assertChatScope:vi.fn(),connection:vi.fn(async()=>connection),account:vi.fn(async()=>({type:'chatgpt',email:'fixture@example.com'})),claimThread:vi.fn(()=>vi.fn()),items:vi.fn(async()=>[{turnId:'turn-1',item:{id:'msg',type:'agentMessage',text:'Done'}}]),turns:vi.fn(async()=>({data:[{id:'turn-1',status:'completed',items:[]}]}))}
  const persist=vi.fn(),requestUserInput=vi.fn(async()=>({q:{answers:['yes']}}))
  const abort=new AbortController()
  const options:StreamOptions={signal:abort.signal,effort:'high',permissionMode:'workspace-auto',nativeCodex:{state,cwd:'/fixture',writableRoots:['/fixture'],persist,requestUserInput}}
  const provider=new CodexAppServerProvider(service as unknown as CodexCLIService,'gpt-6-astra','fixture@example.com')
  const collect=async()=>{const result:AIChunk[]=[];for await(const c of provider.streamMessage(messages,options))result.push(c);return result}
  return {provider,options,collect,emit,rpc,service,connection,persist,requests,abort,requestUserInput}
}
describe('native Codex execution ownership',()=>{
  it('applies an authorized policy change to a loaded thread and verifies it after turn/start',async()=>{
    const previous=nativeCodexPolicy('ask',['/fixture'])
    const f=fixture({threadId:'thread-1',account:'fixture:fixture@example.com',cwd:'/fixture',model:'gpt-6-astra',sandbox:JSON.stringify(previous.sandboxPolicy),approvalPolicy:JSON.stringify(previous.approvalPolicy)})
    f.options.permissionMode='full-access';f.options.nativeCodex!.fullAccessConfirmed=true
    const original=f.rpc.request.getMockImplementation()!;let reads=0
    f.rpc.request.mockImplementation(async(method,params)=>{
      const result=await original(method,params)
      return method==='thread/resume' && ++reads===1?{...result as object,sandbox:previous.sandboxPolicy,approvalPolicy:previous.approvalPolicy}:result
    })
    await f.collect()
    expect(f.rpc.request).toHaveBeenCalledWith('turn/start',expect.objectContaining({sandboxPolicy:{type:'dangerFullAccess'},approvalPolicy:'never'}),90000)
    expect(f.persist.mock.calls.at(-1)?.[0]).toMatchObject({sandbox:'{"type":"dangerFullAccess"}',approvalPolicy:'"never"',submission:'completed'})
  })
  it('rejects a same-model effort downgrade instead of claiming the requested effort was verified',async()=>{
    const f=fixture(),original=f.rpc.request.getMockImplementation()!
    f.rpc.request.mockImplementation(async(method,params)=>{
      const result=await original(method,params)
      return method==='thread/start'||method==='thread/resume'?{...result as object,reasoningEffort:'medium'}:result
    })
    await expect(f.collect()).rejects.toThrow('did not apply the selected model or effort')
    expect(f.rpc.request).toHaveBeenCalledWith('turn/interrupt',{threadId:'thread-1',turnId:'turn-1'})
    expect(f.persist.mock.calls.at(-1)?.[0].submission).not.toBe('completed')
  })
  it('applies a new model in turn/start when a loaded thread resumes with its previous model',async()=>{
    const f=fixture({threadId:'thread-1',account:'fixture:fixture@example.com',cwd:'/fixture',model:'gpt-6.2-astra',lastMessageId:'previous',turnId:'previous-turn',submission:'interrupted'})
    const original=f.rpc.request.getMockImplementation()!
    let resumes=0
    f.rpc.request.mockImplementation(async(method,params)=>{
      const result=await original(method,params)
      if(method==='thread/resume')return {...result as object,model:++resumes===1?'gpt-6.2-astra':'gpt-6-astra',reasoningEffort:'high'}
      return result
    })
    await f.collect()
    expect(f.rpc.request.mock.calls.filter(c=>c[0]==='turn/start')).toHaveLength(1)
    expect(f.rpc.request).toHaveBeenCalledWith('turn/start',expect.objectContaining({model:'gpt-6-astra',effort:'high',clientUserMessageId:'u1'}),90000)
    expect(f.persist.mock.calls.at(-1)?.[0]).toMatchObject({threadId:'thread-1',model:'gpt-6-astra',effort:'high',submission:'completed'})
  })
  it('reconciles an old turn after composer model changes without replay or permission rejection',async()=>{
    const f=fixture({threadId:'thread-1',account:'fixture:fixture@example.com',cwd:'/fixture',model:'gpt-6.2-astra',lastMessageId:'u1',turnId:'turn-1',submission:'accepted'})
    const original=f.rpc.request.getMockImplementation()!
    f.rpc.request.mockImplementation(async(method,params)=>({...await original(method,params) as object,model:'gpt-6.2-astra'}))
    const status=vi.fn();f.options.nativeCodex!.policyStatus=status
    await f.collect()
    expect(f.rpc.request.mock.calls.map(c=>c[0])).toEqual(['thread/resume'])
    expect(status).not.toHaveBeenCalled()
    expect(f.persist.mock.calls.at(-1)?.[0]).toMatchObject({model:'gpt-6.2-astra',submission:'completed'})
  })
  it.each(['wrong-model','read-failed'])('interrupts a new turn if model verification fails (%s), without blaming access',async failure=>{
    const f=fixture({threadId:'thread-1',account:'fixture:fixture@example.com',cwd:'/fixture',model:'gpt-6.2-astra',lastMessageId:'previous',turnId:'previous-turn',submission:'interrupted'})
    const original=f.rpc.request.getMockImplementation()!
    let resumes=0
    f.rpc.request.mockImplementation(async(method,params)=>{
      const result=await original(method,params)
      if(method==='thread/resume'){
        if(++resumes===2 && failure==='read-failed')throw Error('Verification connection lost')
        return {...result as object,model:'gpt-6.2-astra',reasoningEffort:'high'}
      }
      return result
    })
    const status=vi.fn();f.options.nativeCodex!.policyStatus=status
    await expect(f.collect()).rejects.toThrow(failure==='wrong-model'?'did not apply the selected model':'Verification connection lost')
    expect(f.rpc.request).toHaveBeenCalledWith('turn/interrupt',{threadId:'thread-1',turnId:'turn-1'})
    expect(status.mock.calls.some(c=>c[0].status==='rejected')).toBe(false)
    expect(f.persist.mock.calls.at(-1)?.[0].submission).not.toBe('completed')
  })
  it('starts a persistent thread with no Athena prompt, dynamic tools, or history replay',async()=>{
    const f=fixture();f.options.context={attachments:[],repositoryText:'MUST NOT INJECT',sources:[],projectTools:{definitions:[],assertAccess:vi.fn(),execute:vi.fn()}}
    const result=await f.collect()
    expect(result.at(-1)).toEqual({type:'done'})
    const start=f.rpc.request.mock.calls.find(c=>c[0]==='thread/start')![1] as Record<string,unknown>
    expect(start).toMatchObject({cwd:'/fixture',ephemeral:false,sandbox:'workspace-write',model:'gpt-6-astra'})
    expect(start).not.toHaveProperty('developerInstructions');expect(start).not.toHaveProperty('dynamicTools')
    expect(f.rpc.request.mock.calls.find(c=>c[0]==='turn/start')![1]).toMatchObject({clientUserMessageId:'u1',effort:'high',input:[{type:'text',text:'Inspect the fixture.'}]})
    expect(f.options.context.projectTools!.execute).not.toHaveBeenCalled();expect(f.connection.close).not.toHaveBeenCalled()
    expect(f.persist.mock.calls.at(-1)![0]).toMatchObject({threadId:'thread-1',turnId:'turn-1',submission:'completed'})
  })
  it('resumes native history and never resubmits an accepted message on retry',async()=>{
    const f=fixture({threadId:'thread-1',account:'fixture:fixture@example.com',cwd:'/fixture',lastMessageId:'u1',turnId:'turn-1',submission:'accepted'})
    await f.collect();expect(f.rpc.request.mock.calls.map(c=>c[0])).toEqual(['thread/resume'])
    expect(f.service.items).toHaveBeenCalled()
  })
  it('refuses an uncertain submission with no receipt instead of duplicating effects',async()=>{
    const f=fixture({threadId:'thread-1',account:'fixture:fixture@example.com',cwd:'/fixture',lastMessageId:'u1',submission:'pending'})
    await expect(f.collect()).rejects.toThrow('not replayed');expect(f.rpc.request).not.toHaveBeenCalledWith('turn/start',expect.anything(),expect.anything())
  })
  it('reconciles a lost submission receipt from paginated native items without replay',async()=>{
    const f=fixture({threadId:'thread-1',account:'fixture:fixture@example.com',cwd:'/fixture',lastMessageId:'u1',submission:'pending'})
    f.service.items.mockResolvedValue([{turnId:'turn-1',item:{id:'u',type:'userMessage',clientId:'u1',content:[]}}] as never)
    await f.collect()
    expect(f.rpc.request.mock.calls.map(c=>c[0])).toEqual(['thread/resume'])
    expect(f.persist.mock.calls.at(-1)?.[0]).toMatchObject({turnId:'turn-1',submission:'completed'})
  })
  it('counts native usage once per response and keeps child text out of the parent reply',async()=>{
    const f=fixture();f.options.onModelResponse=vi.fn();const run=f.collect()
    await vi.waitFor(()=>expect(f.persist.mock.calls.some(c=>c[0].turnId==='turn-1')).toBe(true))
    f.emit({method:'thread/started',params:{thread:{id:'child',parentThreadId:'thread-1'}}})
    f.emit({method:'item/agentMessage/delta',params:{threadId:'child',turnId:'child-turn',itemId:'child-msg',delta:'child only'}})
    const usage={method:'thread/tokenUsage/updated',params:{threadId:'thread-1',tokenUsage:{total:{inputTokens:10},last:{inputTokens:10,cachedInputTokens:2,outputTokens:3,reasoningOutputTokens:1}}}}
    f.emit(usage);f.emit(usage)
    f.emit({method:'error',params:{threadId:'child',turnId:'child-turn',error:{message:'Child could not finish'},willRetry:false}})
    expect((await run).filter(c=>c.type==='text').map(c=>c.text).join('')).not.toContain('child only')
    expect(f.options.onModelResponse).toHaveBeenCalledTimes(1)
  })
  it('forwards native approvals once and returns the actual user denial',async()=>{
    const f=fixture();f.options.requestApproval=vi.fn(async()=>false)
    const run=f.collect();await vi.waitFor(()=>expect(f.rpc.request).toHaveBeenCalledWith('turn/start',expect.anything(),90000))
    const req={id:17,method:'item/commandExecution/requestApproval',params:{threadId:'thread-1',turnId:'turn-1',command:'touch fixture.txt',cwd:'/fixture'}}
    f.requests.forEach(l=>{l(req);l(req)})
    await run
    expect(f.options.requestApproval).toHaveBeenCalledTimes(1);expect(f.rpc.respond).toHaveBeenCalledWith(17,{decision:'decline'})
  })
  it('answers user questions using the native callback without adding a new turn',async()=>{
    const f=fixture();const run=f.collect();await vi.waitFor(()=>expect(f.persist).toHaveBeenCalled())
    f.requests.forEach(l=>l({id:22,method:'item/tool/requestUserInput',params:{threadId:'thread-1',questions:[{id:'q',question:'Continue?',isSecret:false,options:null}]}}))
    await run;expect(f.rpc.respond).toHaveBeenCalledWith(22,{answers:{q:{answers:['yes']}}})
  })
  it('serializes simultaneous native questions instead of overwriting a pending answer',async()=>{
    const f=fixture();let first!:(value:Record<string,{answers:string[]}>)=>void
    f.options.nativeCodex!.requestUserInput=vi.fn().mockImplementationOnce(()=>new Promise(resolve=>{first=resolve})).mockResolvedValue({q2:{answers:['second']}})
    const run=f.collect();await vi.waitFor(()=>expect(f.persist).toHaveBeenCalled())
    for (const id of [40,41]) f.requests.forEach(l=>l({id,method:'item/tool/requestUserInput',params:{threadId:'thread-1',questions:[{id:'q',question:'Choose?',isSecret:false,options:null}]}}))
    await vi.waitFor(()=>expect(first).toBeTypeOf('function'))
    expect(f.options.nativeCodex!.requestUserInput).toHaveBeenCalledTimes(1)
    first({q:{answers:['first']}});await run
    expect(f.rpc.respond).toHaveBeenCalledWith(40,{answers:{q:{answers:['first']}}})
    expect(f.rpc.respond).toHaveBeenCalledWith(41,{answers:{q2:{answers:['second']}}})
  })
  it('does not report a failed turn as complete',async()=>{
    const f=fixture();const run=f.collect();const outcome=expect(run).rejects.toThrow('Fixture failed')
    await vi.waitFor(()=>expect(f.persist.mock.calls.some(c=>c[0].turnId==='turn-1')).toBe(true))
    f.emit({method:'turn/completed',params:{threadId:'thread-1',turn:{id:'turn-1',status:'failed',error:{message:'Fixture failed'}}}})
    await outcome
  })
  it('interrupts only the current native turn without shutting down the server',async()=>{
    const f=fixture();const run=f.collect();const outcome=expect(run).rejects.toThrow('interrupted')
    await vi.waitFor(()=>expect(f.persist.mock.calls.some(c=>c[0].turnId==='turn-1')).toBe(true));f.abort.abort();await outcome
    expect(f.rpc.request).toHaveBeenCalledWith('turn/interrupt',{threadId:'thread-1',turnId:'turn-1'});expect(f.connection.close).not.toHaveBeenCalled()
  })
  it('reconciles a disconnected stream without starting a second turn',async()=>{
    const f=fixture();const run=f.collect()
    await vi.waitFor(()=>expect(f.persist.mock.calls.some(c=>c[0].turnId==='turn-1')).toBe(true))
    f.emit({method:'server/closed',params:{}})
    await run
    expect(f.service.connection).toHaveBeenCalledTimes(2)
    expect(f.rpc.request.mock.calls.filter(c=>c[0]==='turn/start')).toHaveLength(1)
    expect(f.rpc.request.mock.calls.filter(c=>c[0]==='thread/resume')).toHaveLength(1)
  })
  it('steers the confirmed native turn and never starts a replacement turn',async()=>{
    const f=fixture();let steer!:(text:string,id:string)=>Promise<void>
    f.options.nativeCodex!.ready=callback=>{steer=callback}
    const run=f.collect();await vi.waitFor(()=>expect(steer).toBeTypeOf('function'))
    await steer('Preserve the sentinel.','followup-1');await run
    expect(f.rpc.request).toHaveBeenCalledWith('turn/steer',expect.objectContaining({threadId:'thread-1',expectedTurnId:'turn-1',clientUserMessageId:'followup-1'}))
    expect(f.rpc.request.mock.calls.filter(c=>c[0]==='turn/start')).toHaveLength(1)
  })
  it('fails closed when account or cwd changes',async()=>{
    const f=fixture({threadId:'thread-1',account:'other',cwd:'/fixture'})
    await expect(f.collect()).rejects.toThrow('different Codex account');expect(f.rpc.request).not.toHaveBeenCalled()
  })
  it.each(['ask','read-only','full-access'] as const)('passes and verifies %s on both resumed threads and every new turn',async mode=>{
    const f=fixture({threadId:'thread-1',account:'fixture:fixture@example.com',cwd:'/fixture'})
    f.options.permissionMode=mode;f.options.nativeCodex!.fullAccessConfirmed=true
    const status=vi.fn();f.options.nativeCodex!.policyStatus=status
    const approvals=vi.fn();f.options.requestApproval=approvals
    await f.collect()
    const expected=nativeCodexPolicy(mode,['/fixture'])
    expect(f.rpc.request).toHaveBeenCalledWith('thread/resume',expect.objectContaining({sandbox:expected.sandbox,approvalPolicy:expected.approvalPolicy}),90000)
    expect(f.rpc.request).toHaveBeenCalledWith('turn/start',expect.objectContaining({sandboxPolicy:expected.sandboxPolicy,approvalPolicy:expected.approvalPolicy}),90000)
    expect(status).toHaveBeenCalledWith(expect.objectContaining({mode,status:'verified'}))
    expect(approvals).not.toHaveBeenCalled()
  })
  it('requires a new unrestricted grant, not the historical project-only grant',async()=>{
    const f=fixture();f.options.permissionMode='full-access'
    await expect(f.collect()).rejects.toThrow('Earlier project-only grants')
    expect(f.rpc.request).not.toHaveBeenCalled()
  })
  it('reports a downgraded server policy and submits no turn',async()=>{
    const f=fixture();f.options.permissionMode='full-access';f.options.nativeCodex!.fullAccessConfirmed=true
    const status=vi.fn();f.options.nativeCodex!.policyStatus=status
    f.rpc.request.mockResolvedValueOnce({thread:{id:'thread-1'},model:'gpt-6-astra',modelProvider:'openai',cwd:'/fixture',sandbox:{type:'readOnly',networkAccess:false},approvalPolicy:'on-request'})
    await expect(f.collect()).rejects.toThrow('returned {"type":"readOnly"')
    expect(f.rpc.request.mock.calls.map(c=>c[0])).toEqual(['thread/start'])
    expect(status.mock.calls.at(-1)?.[0]).toMatchObject({status:'rejected',sandbox:'{"type":"readOnly","networkAccess":false}'})
  })
  it('surfaces native policy rejection without fallback or retries',async()=>{
    const f=fixture();const status=vi.fn();f.options.nativeCodex!.policyStatus=status
    f.rpc.request.mockRejectedValueOnce(new Error('Policy denied by organization'))
    await expect(f.collect()).rejects.toThrow('Policy denied by organization')
    expect(status.mock.calls.at(-1)?.[0]).toMatchObject({status:'rejected',error:'Policy denied by organization'})
    expect(f.rpc.request).toHaveBeenCalledTimes(1)
  })
  it.each(['ask','read-only'] as const)('returns actual accepted native approval in %s mode',async mode=>{
    const f=fixture();f.options.permissionMode=mode;f.options.requestApproval=vi.fn(async()=>true)
    const run=f.collect();await vi.waitFor(()=>expect(f.persist.mock.calls.some(c=>c[0].turnId)).toBe(true))
    f.requests.forEach(l=>l({id:44,method:'item/commandExecution/requestApproval',params:{threadId:'thread-1',command:'fixture'}}))
    await run;expect(f.rpc.respond).toHaveBeenCalledWith(44,{decision:'accept'})
  })
  it('does not change saved thread policies when reconciling previously accepted input',async()=>{
    const f=fixture({threadId:'thread-1',account:'fixture:fixture@example.com',cwd:'/fixture',lastMessageId:'u1',turnId:'turn-1',submission:'accepted'})
    f.options.permissionMode='read-only';await f.collect()
    expect(f.rpc.request).toHaveBeenCalledWith('thread/resume',{threadId:'thread-1',excludeTurns:true},90000)
  })
  it('does not override another active native turn during thread resume',async()=>{
    const f=fixture({threadId:'thread-1',account:'fixture:fixture@example.com',cwd:'/fixture'})
    f.rpc.request.mockResolvedValueOnce({thread:{status:{type:'active'}}})
    await expect(f.collect()).rejects.toThrow('permissions were not changed')
    expect(f.rpc.request.mock.calls.map(c=>c[0])).toEqual(['thread/read'])
  })
  it('stops on a changed server policy during an active turn',async()=>{
    const f=fixture();const status=vi.fn();f.options.nativeCodex!.policyStatus=status
    const run=f.collect();const failure=expect(run).rejects.toThrow('restricted or changed')
    await vi.waitFor(()=>expect(f.persist.mock.calls.some(c=>c[0].turnId)).toBe(true))
    f.emit({method:'thread/settings/updated',params:{threadId:'thread-1',threadSettings:{sandboxPolicy:{type:'readOnly',networkAccess:false},approvalPolicy:'on-request'}}})
    await failure
    expect(status.mock.calls.at(-1)?.[0]).toMatchObject({status:'rejected'})
    expect(f.rpc.request).toHaveBeenCalledWith('turn/interrupt',{threadId:'thread-1',turnId:'turn-1'})
  })
  it('maps permission modes to native sandbox policies and preserves diffs',()=>{
    expect(nativeCodexPolicy('read-only',[])).toMatchObject({sandbox:'read-only',approvalPolicy:'on-request'})
    expect(nativeCodexPolicy('ask',[])).toMatchObject({sandbox:'workspace-write',approvalPolicy:'on-request'})
    expect(nativeCodexPolicy('full-access',[]).sandboxPolicy).toMatchObject({type:'dangerFullAccess'})
    expect(nativeItemActivity({type:'fileChange',id:'f',status:'completed',changes:[{path:'/fixture/a',diff:'+a',kind:{type:'add'}}]},true)?.changes?.[0]).toMatchObject({status:'applied',revertible:false})
  })
})

describe('native computer tool requests',()=>{
  const definitions=[{name:'inspect_window',description:'Inspect window',parameters:{type:'object',properties:{}}}]
  const call={threadId:'thread-1',turnId:'turn-1',callId:'call-1',namespace:null,tool:'inspect_window',arguments:{}}
  it('binds callbacks to the accepted turn, deduplicates repeated dispatch, and preserves structured image blocks',async()=>{
    const f=fixture(), execute=vi.fn(async()=>JSON.stringify({ok:true,window:'fixture'}))
    f.options.nativeCodex!.computerTools={definitions,assertAccess:vi.fn(),execute,formatOutput:()=>[{type:'input_text',text:'observed'},{type:'input_image',image_url:'data:image/png;base64,AA==',detail:'auto'}]}
    const run=f.collect()
    await vi.waitFor(()=>expect(f.persist.mock.calls.some(c=>c[0].turnId==='turn-1')).toBe(true))
    f.requests.forEach(l=>{
      l({id:1,method:'item/tool/call',params:call});l({id:2,method:'item/tool/call',params:call})
      l({id:3,method:'item/tool/call',params:{...call,turnId:'previous-turn'}})
      l({id:4,method:'item/tool/call',params:{...call,namespace:'other'}})
      l({id:5,method:'item/tool/call',params:{...call,arguments:{altered:true}}})
      l({id:6,method:'item/tool/call',params:{...call,threadId:'other-thread'}})
    })
    await run
    expect(f.rpc.request).toHaveBeenCalledWith('thread/start',expect.objectContaining({dynamicTools:[{type:'function',name:'inspect_window',description:'Inspect window',inputSchema:definitions[0].parameters}]}),90000)
    expect(execute).toHaveBeenCalledTimes(1)
    for(const id of [1,2])expect(f.rpc.respond).toHaveBeenCalledWith(id,{success:true,contentItems:[{type:'inputText',text:'observed'},{type:'inputImage',imageUrl:'data:image/png;base64,AA=='}]})
    for(const id of [3,4,5])expect(f.rpc.respond).toHaveBeenCalledWith(id,expect.objectContaining({success:false}))
    expect(f.rpc.respond).not.toHaveBeenCalledWith(6,expect.anything())
  })
  it('cancels an in-flight tool when the transport closes and refuses to replay it',async()=>{
    const f=fixture(), abort=vi.fn()
    f.options.nativeCodex!.computerTools={definitions,assertAccess:vi.fn(),execute:async(_name,_input,signal)=>{
      await new Promise<void>(resolve=>signal.addEventListener('abort',()=>{abort();resolve()},{once:true}))
      return '{"ok":false}'
    }}
    const run=f.collect()
    await vi.waitFor(()=>expect(f.persist.mock.calls.some(c=>c[0].turnId==='turn-1')).toBe(true))
    f.requests.forEach(l=>l({id:1,method:'item/tool/call',params:call}))
    await new Promise(resolve=>setImmediate(resolve));f.emit({method:'server/closed',params:{}})
    await run;expect(abort).toHaveBeenCalledOnce()
  })
  it('rejects a voice planner with an exposed MCP server before submission',async()=>{
    const f=fixture(), original=f.rpc.request.getMockImplementation()!
    f.options.permissionMode='read-only';f.options.nativeCodex!.voiceOnly=true;f.options.nativeCodex!.writableRoots=[]
    f.options.nativeCodex!.computerTools={definitions,execute:vi.fn(),assertAccess:vi.fn()}
    f.rpc.request.mockImplementation(async(method,params)=>{
      if(method==='config/read')return {config:{mcp_servers:{example:{}}}}
      if(method==='mcpServerStatus/list')return {data:[{runtimeStatus:'ready',tools:{}}],nextCursor:null}
      const response=await original(method,params)
      return method==='thread/start'?{...response as object,thread:{id:'thread-1',environments:[],status:{type:'idle'}}}:response
    })
    await expect(f.collect()).rejects.toThrow('additional Codex MCP connection')
    expect(f.rpc.request).not.toHaveBeenCalledWith('turn/start',expect.anything(),90000)
    expect(f.rpc.request).toHaveBeenCalledWith('thread/start',expect.objectContaining({environments:[],config:expect.objectContaining({mcp_servers:{example:{enabled:false}}})}),90000)
  })
})
