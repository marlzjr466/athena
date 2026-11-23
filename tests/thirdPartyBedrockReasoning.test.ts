// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const mock=vi.hoisted(()=>({keys:new Map<string,string>(),send:vi.fn<(_command:unknown)=>Promise<Record<string,unknown>>>(async(_command:unknown)=>({output:{message:{content:[{text:'Bedrock reply'}]}},stopReason:'end_turn'}))}))
vi.mock('electron',()=>({app:{isPackaged:false,getPath:()=>'/tmp/athena-bedrock-test-userdata'}}))
vi.mock('../electron/main/ai/secureCredentialEntry',()=>({credentialEntry:(service:string,account:string)=>({getPassword:async()=>mock.keys.get(`${service}:${account}`)??null,setPassword:async(value:string)=>{mock.keys.set(`${service}:${account}`,value)},deleteCredential:async()=>{mock.keys.delete(`${service}:${account}`)}})}))
vi.mock('@aws-sdk/client-bedrock-runtime',()=>({BedrockRuntimeClient:class{send=mock.send;destroy(){}},ConverseCommand:class{constructor(readonly input:unknown){}},ConverseStreamCommand:class{constructor(readonly input:unknown){}}}))

import { ThirdPartyAIProvider, ThirdPartyInferenceService } from '../electron/main/ai/thirdPartyInference'
import { defaultSettings } from '../shared/settings'

const directories:string[]=[]
afterEach(()=>{mock.keys.clear();mock.send.mockClear();for(const path of directories.splice(0))rmSync(path,{recursive:true,force:true})})

it('sends manual Bedrock effort mapping through Converse additionalModelRequestFields',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'athena-bedrock-reasoning-'));directories.push(directory)
  const service=new ThirdPartyInferenceService(directory),id=randomUUID()
  const saved=await service.command({action:'save',connection:{
    id,version:1,name:'Bedrock test',provider:'bedrock',protocol:'bedrock-converse',auth:'aws-static',enabled:true,isDefault:false,region:'us-east-1',allowPrivateNetwork:false,
    models:[{id:'bedrock-reasoning',enabled:true,source:'manual',configuredCapabilities:{reasoning:true,reasoningEfforts:['low','high'],reasoningParameterPath:'additionalModelRequestFields.output_config.effort',streaming:false}}],defaultModel:'bedrock-reasoning',generation:{timeoutSeconds:20,streaming:false},credentials:{accessKeyId:'test-access',secretAccessKey:'test-secret'},
  }},defaultSettings,vi.fn())
  const chunks=[]
  for await(const chunk of new ThirdPartyAIProvider(service,saved.connections[0],'bedrock-reasoning').streamMessage([{id:'user-1',role:'user',content:'Hello',status:'complete',createdAt:1}],{effort:'high'}))chunks.push(chunk)
  expect(chunks).toContainEqual({type:'text',text:'Bedrock reply'})
  expect(mock.send.mock.calls[0][0]).toMatchObject({input:{additionalModelRequestFields:{output_config:{effort:'high'}}}})
})

it('round-trips Bedrock toolUse blocks through Athena project tools',async()=>{
  mock.send
    .mockResolvedValueOnce({output:{message:{content:[{toolUse:{toolUseId:'bedrock-call-1',name:'read_file',input:{path:'source.ts'}}}]}},stopReason:'tool_use',usage:{inputTokens:2,outputTokens:1}})
    .mockResolvedValueOnce({output:{message:{content:[{text:'The file was read.'}]}},stopReason:'end_turn',usage:{inputTokens:3,outputTokens:4}})
  const directory=mkdtempSync(join(tmpdir(),'athena-bedrock-tools-'));directories.push(directory)
  const service=new ThirdPartyInferenceService(directory),id=randomUUID()
  const saved=await service.command({action:'save',connection:{id,version:1,name:'Bedrock tools',provider:'bedrock',protocol:'bedrock-converse',auth:'aws-static',enabled:true,isDefault:false,region:'us-east-1',allowPrivateNetwork:false,models:[{id:'bedrock-agent',enabled:true,source:'manual',reportedCapabilities:{toolCalling:true},configuredCapabilities:{toolCalling:true,streaming:false}}],defaultModel:'bedrock-agent',generation:{timeoutSeconds:20,streaming:false},credentials:{accessKeyId:'test-access',secretAccessKey:'test-secret'}}},defaultSettings,vi.fn())
  const execute=vi.fn(async()=>'{"ok":true,"content":"fixture"}'),projectTools={definitions:[{name:'read_file',description:'Read a file.',parameters:{type:'object',properties:{path:{type:'string'}},required:['path'],additionalProperties:false}}],assertAccess:vi.fn(),parallelSafe:()=>true,execute}
  const chunks=[]
  for await(const chunk of new ThirdPartyAIProvider(service,saved.connections[0],'bedrock-agent').streamMessage([{id:'u1',role:'user',content:'Read source.ts',status:'complete',createdAt:1}],{context:{attachments:[],repositoryText:'',sources:[],projectName:'fixture',projectTools}}))chunks.push(chunk)
  expect(execute).toHaveBeenCalledWith('read_file',{path:'source.ts'},expect.any(AbortSignal))
  expect(chunks).toContainEqual({type:'text',text:'The file was read.'})
  expect(mock.send).toHaveBeenCalledTimes(2)
  expect(mock.send.mock.calls[0][0]).toMatchObject({input:{toolConfig:{tools:[{toolSpec:{name:'read_file'}}]}}})
  expect(JSON.stringify(mock.send.mock.calls[1][0])).toContain('toolResult')
  expect(JSON.stringify(mock.send.mock.calls[1][0])).toContain('bedrock-call-1')
})

it('handles streamed Bedrock toolUse input and continuation',async()=>{
  const stream=(...items:Record<string,unknown>[])=>({stream:(async function*(){for(const item of items)yield item})()})
  mock.send
    .mockResolvedValueOnce(stream(
      {contentBlockStart:{contentBlockIndex:0,start:{toolUse:{toolUseId:'bedrock-stream-1',name:'read_file'}}}},
      {contentBlockDelta:{contentBlockIndex:0,delta:{toolUse:{input:'{"path":"source.ts"}'}}}},
      {metadata:{usage:{inputTokens:2,outputTokens:1}}},
      {messageStop:{stopReason:'tool_use'}},
    ))
    .mockResolvedValueOnce(stream(
      {contentBlockDelta:{contentBlockIndex:0,delta:{text:'Stream complete.'}}},
      {metadata:{usage:{inputTokens:3,outputTokens:2}}},
      {messageStop:{stopReason:'end_turn'}},
    ))
  const directory=mkdtempSync(join(tmpdir(),'athena-bedrock-stream-tools-'));directories.push(directory)
  const service=new ThirdPartyInferenceService(directory),id=randomUUID()
  const saved=await service.command({action:'save',connection:{id,version:1,name:'Bedrock stream tools',provider:'bedrock',protocol:'bedrock-converse',auth:'aws-static',enabled:true,isDefault:false,region:'us-east-1',allowPrivateNetwork:false,models:[{id:'bedrock-stream-agent',enabled:true,source:'manual',reportedCapabilities:{toolCalling:true,streaming:true,streamingToolCalling:true},configuredCapabilities:{toolCalling:true,streaming:true,streamingToolCalling:true}}],defaultModel:'bedrock-stream-agent',generation:{timeoutSeconds:20,streaming:true},credentials:{accessKeyId:'test-access',secretAccessKey:'test-secret'}}},defaultSettings,vi.fn())
  const execute=vi.fn(async()=>'{"ok":true}'),projectTools={definitions:[{name:'read_file',description:'Read a file.',parameters:{type:'object',properties:{path:{type:'string'}},required:['path'],additionalProperties:false}}],assertAccess:vi.fn(),parallelSafe:()=>true,execute}
  const chunks=[]
  for await(const chunk of new ThirdPartyAIProvider(service,saved.connections[0],'bedrock-stream-agent').streamMessage([{id:'u1',role:'user',content:'Read source.ts',status:'complete',createdAt:1}],{context:{attachments:[],repositoryText:'',sources:[],projectName:'fixture',projectTools}}))chunks.push(chunk)
  expect(execute).toHaveBeenCalledTimes(1)
  expect(execute).toHaveBeenCalledWith('read_file',{path:'source.ts'},expect.any(AbortSignal))
  expect(chunks).toContainEqual({type:'text',text:'Stream complete.'})
})
