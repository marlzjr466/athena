import type { CodexAppServerProcess } from './codexCLIService'
import { randomUUID } from 'node:crypto'
import { ChatError } from './AIProvider'

export const CUA_PLUGIN = 'unified-computer-use@openai-bundled'
export type CuaBinding = { rpc:CodexAppServerProcess; threadId:string; turnId:string; cwd:string }
export class CuaUnavailable extends ChatError {}
export type CuaCall = (code:string, title:string)=>Promise<string>

type ToolContext = {id:string; rpc:CodexAppServerProcess; environmentId:string|null; handle:string; checkedTurn:string; app?:string}
type ContextEntry = {parent:string; rpc:CodexAppServerProcess; pending:Promise<ToolContext>; timer?:ReturnType<typeof setTimeout>}
type Access = 'allow'|'deny'
type Origins = Record<string,{access?:Access|null}>
type Config = {
  plugins?:Record<string,{enabled?:boolean;mcp_servers?:Record<string,{enabled?:boolean;enabled_tools?:string[];disabled_tools?:string[]}>}>
  features?:Record<string,boolean>; mcp_servers?:Record<string,unknown>
  computer_use?:{default_app_access?:Access;macos?:{bundle_ids?:Record<string,Access>}}
  browser_use?:{default_origin_policy?:{access?:Access};origins?:Origins}
}
type Requirements = {
  computerUse?:{defaultAppAccess?:Access;macos?:{bundleIds?:Record<string,Access>}}
  browserUse?:{defaultOriginPolicy?:{access?:Access};origins?:Origins}
}
function deniedOrigin(url:string, origins:Origins|undefined, defaultAccess?:Access) {
  const {origin}=new URL(url)
  const exact=origins?.[origin]??origins?.[origin+'/']
  if(exact?.access==='deny')return true
  // Only exact origin exceptions are safe to apply locally. Unknown deny patterns
  // are left to the administrator instead of being silently ignored.
  for(const [pattern,policy] of Object.entries(origins??{})){
    if(policy?.access!=='deny')continue
    try{if(new URL(pattern).origin===origin || pattern.includes('*'))return true}catch{return true}
  }
  return (exact?.access??defaultAccess)==='deny'
}
export async function authorizeCua(binding:CuaBinding,app:string,url?:string):Promise<Config> {
  const [configured,required]=await Promise.all([
    binding.rpc.request('config/read',{cwd:binding.cwd}) as Promise<{config:Config}>,
    binding.rpc.request('configRequirements/read',{}) as Promise<{requirements:Requirements|null}>,
  ])
  const {config}=configured, requirements=required.requirements
  const plugin=config.plugins?.[CUA_PLUGIN], server=plugin?.mcp_servers?.cua_repl
  if(plugin?.enabled===false || config.features?.plugins===false || config.features?.computer_use===false ||
    server?.enabled===false || server?.disabled_tools?.includes('js') || server?.enabled_tools && !server.enabled_tools.includes('js'))
    throw new ChatError('Codex computer use is disabled by the current configuration.')
  const apps=config.computer_use, managed=requirements?.computerUse
  if((apps?.macos?.bundle_ids?.[app]??apps?.default_app_access)==='deny' ||
     (managed?.macos?.bundleIds?.[app]??managed?.defaultAppAccess)==='deny' ||
     url && (deniedOrigin(url,config.browser_use?.origins,config.browser_use?.default_origin_policy?.access) ||
       deniedOrigin(url,requirements?.browserUse?.origins,requirements?.browserUse?.defaultOriginPolicy?.access)))
    throw new ChatError('Codex policy denies computer use for this application or website.')
  return config
}

/** App Server 0.171 removes a disabled plugin from the calling thread's MCP transport too.
 * A tool-only, ephemeral registration lets the host call the official plugin without
 * exposing unrestricted JavaScript to the planner. It never receives a model turn. */
export class CodexCua {
  private contexts=new Map<string,ContextEntry>()

  forget(owner:string) {
    const entry=this.contexts.get(owner)
    if(!entry)return
    this.contexts.delete(owner)
    clearTimeout(entry.timer)
    void entry.pending.then(c=>c.rpc.request('thread/unsubscribe',{threadId:c.id})).catch(()=>{})
  }

  private async open(binding:CuaBinding,config:Config):Promise<ToolContext> {
    const {rpc,cwd}=binding
    const {thread}=await rpc.request('thread/start',{cwd,serviceName:'athena-cua-tools',ephemeral:true,environments:[],
      runtimeWorkspaceRoots:[],selectedCapabilityRoots:[],sandbox:'read-only',approvalPolicy:'on-request',modelProvider:'openai',
      config:{features:{shell_tool:false,unified_exec:false,apps:false,hooks:false,multi_agent:false,code_mode:false},
        plugins:Object.fromEntries(Object.keys(config.plugins??{}).filter(id=>id!==CUA_PLUGIN).map(id=>[id,{enabled:false}])),
        mcp_servers:Object.fromEntries(Object.keys(config.mcp_servers??{}).map(id=>[id,{enabled:false}]))}}) as {thread:{id:string}}
    try {
      const environmentId=await this.registration(rpc,thread.id)
      return {rpc,id:thread.id,environmentId,handle:'athenaCua'+randomUUID().replaceAll('-',''),checkedTurn:binding.turnId}
    }catch(error){
      await rpc.request('thread/unsubscribe',{threadId:thread.id}).catch(()=>{})
      if(error instanceof Error && /unknown MCP server ['"]?cua_repl/i.test(error.message))
        throw new CuaUnavailable('Codex did not register cua_repl in this execution environment.')
      throw error
    }
  }

  async application(owner:string,binding:CuaBinding,app:string,signal:AbortSignal,url?:string,
    approve?:(message:string)=>Promise<boolean>):Promise<CuaCall> {
    signal.throwIfAborted()
    const config=await authorizeCua(binding,app,url)
    let entry=this.contexts.get(owner)
    if(entry && (entry.parent!==binding.threadId || entry.rpc!==binding.rpc)){this.forget(owner);entry=undefined}
    if(!entry){
      entry={parent:binding.threadId,rpc:binding.rpc,pending:this.open(binding,config)}
      this.contexts.set(owner,entry)
    }
    const current=entry
    clearTimeout(current.timer)
    current.timer=setTimeout(()=>{if(this.contexts.get(owner)===current)this.forget(owner)},10*60_000)
    current.timer.unref()
    let context:ToolContext
    try{context=await current.pending}catch(error){if(this.contexts.get(owner)===current)this.forget(owner);throw error}
    if(context.checkedTurn!==binding.turnId){
      const environment=await this.registration(context.rpc,context.id)
      if(environment!==context.environmentId){this.forget(owner);throw new ChatError('The native computer-use registration changed. Reinspect the target.')}
      context.checkedTurn=binding.turnId
    }
    const call:CuaCall=async(code,title)=>{
      signal.throwIfAborted()
      if(this.contexts.get(owner)!==current || context.rpc!==binding.rpc || context.rpc.isClosed)
        throw new ChatError('The native computer-use session ended. Check the target before continuing.')
      let active=true
      const detach=context.rpc.onServerRequest(event=>{
        const p=event.params
        if(p?.threadId!==context.id || event.id===undefined)return
        const id=event.id
        if(event.method!=='mcpServer/elicitation/request' || p.serverName!=='cua_repl'){
          context.rpc.rejectRequest(id,'Unsupported request in a computer-use tool session.');return
        }
        const schema=p.requestedSchema as {properties?:object}|undefined
        // Forward simple native consent; credential entry, links, and account
        // verification require their own interactive client.
        const simple=p.mode==='form' && schema?.properties && !Object.keys(schema.properties).length
        void Promise.resolve(simple && !signal.aborted && approve ? approve(String(p.message).slice(0,800)) : false)
          .then(ok=>{if(!context.rpc.isClosed)context.rpc.respond(id,{action:ok && active && !signal.aborted?'accept':'decline',content:ok && active && !signal.aborted?{}:null,_meta:null})})
          .catch(()=>{if(!context.rpc.isClosed)context.rpc.respond(id,{action:'cancel',content:null,_meta:null})})
      })
      const result=await context.rpc.request('mcpServer/tool/call',{threadId:context.id,server:'cua_repl',
        environmentId:context.environmentId,tool:'js',arguments:{code,title}},32_000).finally(()=>{active=false;detach()}) as {isError?:boolean;content:{type:string;text?:string}[]}
      signal.throwIfAborted()
      if(result.isError){
        const diagnostic=result.content.find(b=>b.type==='text')?.text?.split('\n')[0]??''
        // The plugin may include the whole app tree or REPL source in an error. Keep diagnostics categorical.
        if(/denied|not authorized|permission|approval|not allowed/i.test(diagnostic))throw new ChatError('Codex computer use denied access to this application.')
        if(/stale|target changed/i.test(diagnostic))throw new ChatError('The observed control changed. Inspect the target again.')
        throw new ChatError('The native Codex computer-use call failed. Check the target before continuing.')
      }
      return result.content.filter(b=>b.type==='text').map(b=>b.text??'').join('\n')
    }
    if(context.app!==app){
      // getApp emits the complete initial state. Do not send its return value or the tool documentation to the planner.
      await call('var '+context.handle+' = await cua.getApp('+JSON.stringify(app)+');','Connecting to the authorized application')
      context.app=app
    }
    return (code,title)=>call('await (async (athenaApp)=>{'+code+'})('+context.handle+');',title)
  }

  private async registration(rpc:CodexAppServerProcess,threadId:string) {
    const inventory=await rpc.request('mcpServerStatus/list',{threadId,serverName:'cua_repl',limit:100}) as {
      data:{name:string;pluginId:string;runtimeStatus:string;environmentId?:string|null;tools:Record<string,unknown>}[]}
    const matches=inventory.data.filter(s=>s.name==='cua_repl' && s.pluginId===CUA_PLUGIN && s.tools?.js &&
      (s.runtimeStatus==='connected'||s.runtimeStatus==='starting'))
    if(matches.length!==1)throw new CuaUnavailable('The installed Codex computer-use plugin is unavailable for this session.')
    return matches[0].environmentId??null
  }
}
