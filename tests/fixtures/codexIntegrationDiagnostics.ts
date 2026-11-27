import type { CodexAppServerSession } from '../../electron/main/ai/codexCLIService'

// Development-only protocol evidence. Deliberately exclude input, output,
// command arguments, environment, authentication identity and error text.
export function observeCodex(session:CodexAppServerSession, conversationId:string, rows:unknown[]) {
  const started=Date.now(), counts:Record<string,number>={}
  const request=session.rpc.request.bind(session.rpc)
  session.rpc.request=async(method,params,timeout)=>{
    const p=(params??{}) as Record<string,unknown>
    const transmitted=Object.fromEntries(['threadId','model','effort','cwd','sandbox','sandboxPolicy','approvalPolicy'].filter(k=>p[k]!==undefined).map(k=>[k,p[k]]))
    if(p.config && typeof p.config==='object')transmitted.threadEffort=(p.config as Record<string,unknown>).model_reasoning_effort
    const begin=Date.now()
    try{
      const result=await request(method,params,timeout)
      if(['thread/start','thread/resume','turn/start','turn/interrupt'].includes(method)){
        const r=result as Record<string,any>
        rows.push({conversationId,executable:session.executable,version:session.version,authentication:'chatgpt',transport:'stdio',method,transmitted,confirmed:{threadId:r.thread?.id,turnId:r.turn?.id,model:r.model,effort:r.reasoningEffort,cwd:r.cwd,sandbox:r.sandbox,approvalPolicy:r.approvalPolicy,status:r.turn?.status},durationMs:Date.now()-begin})
      }
      return result
    }catch(error){rows.push({conversationId,method,outcome:'rpc-error',durationMs:Date.now()-begin});throw error}
  }
  const off=session.rpc.onNotification(event=>{
    const method=event.method??'unknown';counts[method]=(counts[method]??0)+1
    if(method==='turn/completed')rows.push({conversationId,threadId:event.params?.threadId,turnId:(event.params?.turn as {id?:string})?.id,nativeStatus:(event.params?.turn as {status?:string})?.status})
  })
  return ()=>{off();session.rpc.request=request;rows.push({conversationId,eventCounts:counts,durationMs:Date.now()-started})}
}
