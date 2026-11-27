import { createHash } from 'node:crypto'
import { ChatError, type ProjectTools } from './AIProvider'
import type { CodexAppServerProcess } from './codexCLIService'
import type { JsonValue } from './codexProtocol/serde_json/JsonValue'
import type { DynamicToolFunctionSpec } from './codexProtocol/v2/DynamicToolFunctionSpec'
import type { DynamicToolCallParams } from './codexProtocol/v2/DynamicToolCallParams'
import type { DynamicToolCallResponse } from './codexProtocol/v2/DynamicToolCallResponse'

// Keep the original dynamic tool names dispatchable for threads created by earlier builds.
export const cuaTools:Record<string,string>={
  athena_browser_action:'cua_browser',
  athena_desktop_inspect_accessible_ui:'cua_observe_app',
  athena_desktop_click_accessible_element:'cua_click_control',
  athena_desktop_set_accessible_text:'cua_type_text',
  athena_desktop_scroll:'cua_scroll_app',
}
export const cuaToolNames=new Map(Object.entries(cuaTools).map(([legacy,name])=>[name,legacy]))
export function nativeComputerDefinitions(tools?: ProjectTools): Array<DynamicToolFunctionSpec & {type:'function'}> {
  return (tools?.definitions ?? []).map(({name, description, parameters}) => ({
    type:'function', name:tools?.bindComputerTurn && cuaTools[name] || name,
    description:tools?.bindComputerTurn && cuaTools[name] ? 'Preferred Codex cua_repl interface. Use the observed control label or control number. '+description : description, inputSchema:parameters as JsonValue,
  }))
}

const failed = (text: string): DynamicToolCallResponse => ({success:false, contentItems:[{type:'inputText',text}]})

/** A single native turn owns these receipts. Lost transports never recreate an executor. */
export class NativeComputerCalls {
  private readonly abort = new AbortController()
  private readonly receipts = new Map<string, {signature:string; result:Promise<DynamicToolCallResponse>}>()
  private resolveReady!: (identity?: {threadId:string;turnId:string}) => void
  private readonly ready = new Promise<{threadId:string;turnId:string} | undefined>(resolve => { this.resolveReady = resolve })
  constructor(private readonly tools?: ProjectTools) {}

  accept(threadId:string, turnId:string) { this.resolveReady({threadId,turnId}) }
  stop() { this.abort.abort(); this.resolveReady() }

  async dispatch(call: DynamicToolCallParams): Promise<DynamicToolCallResponse> {
    const owner = await this.ready
    const tools = this.tools
    if (!owner || this.abort.signal.aborted || owner.threadId !== call.threadId || owner.turnId !== call.turnId)
      return failed('This call is outside the current verified automation turn. No action was performed.')
    const name=tools?.bindComputerTurn ? cuaToolNames.get(call.tool)??call.tool : call.tool
    if (!tools || call.namespace != null || typeof call.callId !== 'string' || !call.callId || !tools.definitions.some(d=>d.name===name))
      return failed('This computer tool is unavailable for the authorized turn.')
    if (!call.arguments || typeof call.arguments !== 'object' || Array.isArray(call.arguments)) return failed('Expected an object of tool arguments.')
    const args = JSON.stringify(call.arguments)
    if (Buffer.byteLength(args) > (tools.maxArgumentBytes ?? 64_000)) return failed('The tool arguments exceed the permitted size.')
    const signature = createHash('sha256').update(call.tool).update('\0').update(args).digest('hex')
    const existing = this.receipts.get(call.callId)
    if (existing) return existing.signature === signature ? existing.result : failed('Codex reused a tool call ID for a different action.')
    if (this.receipts.size >= (tools.maxCalls ?? 100)) return failed('This turn reached its computer tool call limit.')
    const result = this.execute(tools, {...call,tool:name})
    this.receipts.set(call.callId,{signature,result})
    return result
  }

  private async execute(tools: ProjectTools, call: DynamicToolCallParams): Promise<DynamicToolCallResponse> {
    try {
      tools.assertAccess()
      this.abort.signal.throwIfAborted()
      const raw = await tools.execute(call.tool,call.arguments,this.abort.signal)
      this.abort.signal.throwIfAborted()
      const receipt:unknown = JSON.parse(raw)
      if (!receipt || typeof receipt !== 'object' || !('ok' in receipt) || typeof receipt.ok !== 'boolean')
        return failed('The executor returned no verified outcome. Check the target before retrying.')
      const formatted = tools.formatOutput?.(raw)
      const contentItems:DynamicToolCallResponse['contentItems'] = []
      for (const item of formatted ?? []) {
        if (item.type === 'input_text') contentItems.push({type:'inputText',text:item.text})
        if (item.type === 'input_image' && item.image_url?.startsWith('data:image/')) contentItems.push({type:'inputImage',imageUrl:item.image_url})
      }
      return {success:receipt.ok,contentItems:contentItems.length ? contentItems : [{type:'inputText',text:raw}]}
    } catch (error) {
      return failed(this.abort.signal.aborted ? 'Computer use was interrupted. Verify the target before retrying.' :
        error instanceof ChatError ? error.userMessage : 'The local computer tool failed. Check automation history before retrying.')
    }
  }
}

export async function voiceProfile(rpc: CodexAppServerProcess, cwd: string) {
  const {config} = await rpc.request('config/read',{cwd}) as {config:{mcp_servers?:Record<string,unknown>}}
  const disabled = ['shell_tool','unified_exec','apps','plugins','hooks','browser_use','browser_use_external','computer_use',
    'code_mode','code_mode_host','multi_agent','multi_agent_v2','view_image','image_generation','skill_search']
  return {features:Object.fromEntries(disabled.map(name => [name,false])), web_search:'disabled',
    mcp_servers:Object.fromEntries(Object.keys(config.mcp_servers ?? {}).map(name=>[name,{enabled:false}]))}
}

export async function verifyVoiceProfile(rpc: CodexAppServerProcess, thread: {id:string;environments?:unknown}, configureIdle = false) {
  // A freshly restarted server may load the default local environment even for
  // a persisted environment-free thread. Correct it before submitting input.
  if (configureIdle && (!Array.isArray(thread.environments) || thread.environments.length)) {
    await rpc.request('thread/settings/update',{threadId:thread.id,environments:[]})
    const read = await rpc.request('thread/read',{threadId:thread.id}) as {thread:{id:string;environments?:unknown}}
    if (read.thread.id !== thread.id) throw new ChatError('Codex returned a different voice thread.')
    thread = read.thread
  }
  if (!Array.isArray(thread.environments) || thread.environments.length)
    throw new ChatError('Codex did not confirm an environment-free voice planning thread.')
  let cursor: string | null = null
  const cursors = new Set<string>()
  do {
    const page = await rpc.request('mcpServerStatus/list',{threadId:thread.id,limit:100,...(cursor ? {cursor} : {})}) as {
      data:Array<{runtimeStatus:string;tools:Record<string,unknown>}>;nextCursor:string|null
    }
    if (!Array.isArray(page.data) || page.data.some(server=>server.runtimeStatus!=='disabled' || Object.keys(server.tools).length))
      throw new ChatError('An additional Codex MCP connection is available to the voice thread. Voice computer use requires only Athena’s authorized tools.')
    cursor = page.nextCursor
    if (cursor && cursors.has(cursor)) throw new ChatError('Codex could not verify the complete voice tool inventory.')
    if (cursor) cursors.add(cursor)
  } while (cursor)
}
