import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const mock = vi.hoisted(()=>({ stored: null as string|null, clients: [] as Record<string, unknown>[], login:'alice', model:{id:'official-model',name:'Official model',policy:{state:'enabled'},capabilities:{supports:{vision:false,reasoningEffort:true},limits:{max_prompt_tokens:100000,max_context_window_tokens:100000}},supportedReasoningEfforts:['low','high']} }))
vi.mock('../electron/main/ai/copilotCLIAuth',()=>({CopilotCLIAuth:class {status={installed:true,version:'1.0.0',phase:'idle'}; running=false;async discover(){return '/bin/copilot'};async cancel(){} }}))
vi.mock('electron',()=>({app:{isPackaged:false}}))
vi.mock('@napi-rs/keyring',()=>({AsyncEntry:class {async getPassword(){return mock.stored} async setPassword(s:string){mock.stored=s}}}))
vi.mock('@github/copilot-sdk',()=>({CopilotClient:class {
  constructor(options:Record<string,unknown>){mock.clients.push(options)}
  async start(){} async stop(){return []}
  async getAuthStatus(){return {isAuthenticated:true,login:mock.login,authType:'user'}}
  async listModels(){return [mock.model,{...mock.model,id:'disabled',policy:{state:'disabled'}}]}
}}))
import { CopilotService, copilotEnvironment } from '../electron/main/ai/copilotService'
import { copilotCommandSchema } from '../shared/copilot'
import { CopilotProvider } from '../electron/main/ai/CopilotProvider'

beforeEach(()=>{mock.stored=null;mock.clients=[];mock.login='alice';vi.unstubAllGlobals()})
const service = async()=>new CopilotService(await mkdtemp(join(tmpdir(),'athena-copilot-test-')))
const saved = (kind='oauth')=>JSON.stringify({activeId:`${kind}:alice`,accounts:[{id:`${kind}:alice`,login:'alice',kind,enabled:true,...(kind==='oauth'?{token:'gho_test'}:{})}]})
describe('Copilot authentication boundaries',()=>{
  it('removes BYOK, runtime overrides, and unrelated credentials while preserving supported CLI token priority',()=>{
    expect(copilotEnvironment({PATH:'/bin',GH_TOKEN:'github',OPENAI_API_KEY:'secret',COPILOT_PROVIDER_API_KEY:'secret',COPILOT_OFFLINE:'true',NODE_OPTIONS:'--require /tmp/code',HTTPS_PROXY:'proxy'})).toEqual({PATH:'/bin',GH_TOKEN:'github',HTTPS_PROXY:'proxy'})
  })
  it('does not use ambient credentials until a user connects',async()=>{const s=await service();expect((await s.aiStatus()).ok).toBe(false);expect(mock.clients).toHaveLength(0)})
  it('persists and restores an explicitly connected CLI identity without extracting tokens',async()=>{const s=await service();const state=await s.command({action:'connect-cli'});expect(state.activeId).toBe('cli:alice');expect(mock.stored).not.toContain('token');expect(mock.clients[0]).toMatchObject({mode:'copilot-cli',useLoggedInUser:true});expect(mock.clients[0].gitHubToken).toBeUndefined();expect((await (await service()).command({action:'status'})).accounts[0].login).toBe('alice')})
  it('fails closed when the CLI changes users',async()=>{mock.stored=saved('cli');mock.login='bob';expect((await (await service()).aiStatus()).ok).toBe(false)})
  it('uses explicit OAuth credentials without CLI fallback and filters unavailable models',async()=>{mock.stored=saved();const result=await (await service()).aiStatus();expect(result.status.models).toEqual(['official-model']);expect(mock.clients[0]).toMatchObject({gitHubToken:'gho_test',useLoggedInUser:false,mode:'empty'});expect(JSON.stringify(result)).not.toContain('gho_test')})
  it('does not duplicate clients during concurrent requests',async()=>{mock.stored=saved();const s=await service();await Promise.all([s.active(),s.active()]);expect(mock.clients).toHaveLength(1)})
  it('rejects malformed OAuth records rather than falling back to CLI',async()=>{mock.stored=saved().replace(',"token":"gho_test"','');expect((await (await service()).aiStatus()).ok).toBe(false);expect(mock.clients).toHaveLength(0)})
  it('disable prevents requests; removal clears selected identity',async()=>{mock.stored=saved();const s=await service();await s.command({action:'enable',id:'oauth:alice',enabled:false});expect((await s.aiStatus()).ok).toBe(false);expect((await s.command({action:'remove',id:'oauth:alice'})).activeId).toBeNull()})
  it('OAuth device flow validates identity and never returns token to renderer',async()=>{
    const fetch=vi.fn().mockResolvedValueOnce({ok:true,json:async()=>({device_code:'private-code',user_code:'PUBLIC',verification_uri:'https://github.com/login/device',expires_in:900,interval:5})}).mockResolvedValueOnce({ok:true,json:async()=>({access_token:'gho_test'})}).mockResolvedValueOnce({ok:true,json:async()=>({login:'alice'})})
    vi.stubGlobal('fetch',fetch);const s=await service();const start=await s.command({action:'login',clientId:'testclient'});expect(start.device?.code).toBe('PUBLIC');const connected=await s.command({action:'poll'});expect(connected.accounts[0].login).toBe('alice');expect(JSON.stringify(connected)).not.toMatch(/gho_test|private-code/);expect(fetch).toHaveBeenCalledTimes(3)
  })
  it('cancellation discards device authorization',async()=>{const s=await service();await s.command({action:'cancel'});await expect(s.command({action:'poll'})).rejects.toThrow('expired')})
  it('blocks authentication changes while generation holds its lease',async()=>{mock.stored=saved();const s=await service();const release=s.beginRequest();await expect(s.command({action:'select',id:'oauth:alice'})).rejects.toThrow('active Copilot requests');release();await expect(s.command({action:'select',id:'oauth:alice'})).resolves.toMatchObject({activeId:'oauth:alice'})})
  it('validates IPC commands',()=>{expect(copilotCommandSchema.safeParse({action:'select',id:'x',token:'secret'}).success).toBe(false)})
})

describe('Copilot provider uses Athena tools',()=>{
  const fixture=()=>{
    let listener: (event: {type:string;data:Record<string,unknown>})=>void=()=>{}
    const session={on:vi.fn(fn=>{listener=fn;return ()=>{}}),sendAndWait:vi.fn(async()=>{listener({type:'assistant.message_delta',data:{deltaContent:'Hello'}})}),abort:vi.fn(async()=>{}),disconnect:vi.fn(async()=>{})}
    const createSession=vi.fn(async(_config:Record<string,unknown>)=>session)
    const service={beginRequest:()=>()=>{},active:async()=>({client:{createSession},account:{id:'oauth:alice'},models:[mock.model]} )} as unknown as CopilotService
    return {provider:new CopilotProvider(service,'official-model','oauth:alice'),session,createSession}
  }
  it('streams once, disables native/MCP tools, and disposes session',async()=>{const f=fixture();const chunks=[];for await(const c of f.provider.streamMessage([]))chunks.push(c);expect(chunks).toEqual([{type:'text',text:'Hello'},{type:'done'}]);expect(f.createSession.mock.calls[0][0]).toMatchObject({availableTools:[],excludedTools:['builtin:*','mcp:*'],enableSkills:false,enableFileHooks:false,enableConfigDiscovery:false,includedBuiltinSkills:[]});expect(f.session.disconnect).toHaveBeenCalledOnce()})
  it('keeps tool access in existing executor',async()=>{const f=fixture();const execute=vi.fn(async()=> 'authorized result');const assertAccess=vi.fn();for await(const _ of f.provider.streamMessage([],{context:{attachments:[],repositoryText:'',sources:[],projectTools:{definitions:[{name:'read_file',description:'read',parameters:{type:'object'}}],assertAccess,execute}}})){};const config=f.createSession.mock.calls[0][0] as {tools:{handler:(a:unknown)=>Promise<unknown>}[];onPermissionRequest:()=>unknown};await config.tools[0].handler({path:'file'});expect(assertAccess).toHaveBeenCalledOnce();expect(execute).toHaveBeenCalledWith('read_file',{path:'file'},expect.any(AbortSignal));expect(config.onPermissionRequest()).toEqual({kind:'denied-interactively-by-user'})})
  it('rejects unsupported effort before sending',async()=>{const f=fixture();await expect(async()=>{for await(const _ of f.provider.streamMessage([],{effort:'xhigh'})){} }).rejects.toThrow('reasoning effort');expect(f.createSession).not.toHaveBeenCalled()})
  it('cancellation never sends a prompt',async()=>{const f=fixture();const abort=new AbortController();abort.abort();await expect(async()=>{for await(const _ of f.provider.streamMessage([],{signal:abort.signal})){} }).rejects.toThrow();expect(f.session.sendAndWait).not.toHaveBeenCalled()})
  it('usage failure does not produce done or switch providers',async()=>{const f=fixture();f.session.sendAndWait.mockRejectedValue(new Error('quota'));await expect(async()=>{for await(const _ of f.provider.streamMessage([])){} }).rejects.toThrow('usage/time limit');expect(f.session.sendAndWait).toHaveBeenCalledOnce();expect(f.session.disconnect).toHaveBeenCalledOnce()})
  it('sends a short message when Copilot Auto reports no context window',async()=>{const limits=mock.model.capabilities.limits;mock.model.capabilities.limits={max_prompt_tokens:0,max_context_window_tokens:0};try{const f=fixture();const chunks=[];for await(const c of f.provider.streamMessage([{id:'1',role:'user',content:'Hello there!',status:'complete',createdAt:1}]))chunks.push(c);expect(chunks).toEqual([{type:'text',text:'Hello'},{type:'done'}]);expect(f.session.sendAndWait).toHaveBeenCalledOnce()}finally{mock.model.capabilities.limits=limits}})
  it('still rejects a prompt larger than a reported Copilot window',async()=>{const limits=mock.model.capabilities.limits;mock.model.capabilities.limits={max_prompt_tokens:20,max_context_window_tokens:100000};try{const f=fixture();await expect(async()=>{for await(const _ of f.provider.streamMessage([{id:'1',role:'user',content:'x'.repeat(80),status:'complete',createdAt:1}])){}}).rejects.toThrow('context bound');expect(f.session.sendAndWait).not.toHaveBeenCalled()}finally{mock.model.capabilities.limits=limits}})
})
