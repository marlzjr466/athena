// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const mock = vi.hoisted(() => ({
  keys: new Map<string,string>(),
  generate: vi.fn<(input:Record<string,unknown>)=>Promise<Record<string,unknown>>>(async () => ({ text: 'Gemini reply', candidates: [{ finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2 } })),
  generateStream: vi.fn<(input:Record<string,unknown>)=>Promise<AsyncIterableIterator<Record<string,unknown>>>>(),
}))
vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => '/tmp/athena-gemini-test-userdata' } }))
vi.mock('../electron/main/ai/secureCredentialEntry', () => ({ credentialEntry: (service: string, account: string) => ({
  getPassword: async () => mock.keys.get(`${service}:${account}`) ?? null,
  setPassword: async (value: string) => { mock.keys.set(`${service}:${account}`, value) },
  deleteCredential: async () => { mock.keys.delete(`${service}:${account}`) },
}) }))
vi.mock('@google/genai', () => ({ GoogleGenAI: class { models = { generateContent: mock.generate, generateContentStream: mock.generateStream } } }))

import { ThirdPartyAIProvider, ThirdPartyInferenceService } from '../electron/main/ai/thirdPartyInference'
import { defaultSettings } from '../shared/settings'

const directories: string[] = []
afterEach(() => { mock.keys.clear(); mock.generate.mockClear(); mock.generateStream.mockClear(); for (const path of directories.splice(0)) rmSync(path,{recursive:true,force:true}) })

it('passes selected Gemini thinking level to the SDK request configuration', async () => {
  const directory = mkdtempSync(join(tmpdir(),'athena-gemini-reasoning-')); directories.push(directory)
  const service = new ThirdPartyInferenceService(directory), id = randomUUID()
  const saved = await service.command({ action:'save', connection: {
    id, version:1, name:'Gemini test', provider:'gemini', protocol:'gemini-native', auth:'api-key',
    enabled:true, isDefault:false, baseUrl:'http://127.0.0.1:43123', allowPrivateNetwork:true,
    models:[{id:'gemini-reasoning',enabled:true,source:'manual',configuredCapabilities:{reasoning:true,reasoningEfforts:['low','high'],streaming:false}}],
    defaultModel:'gemini-reasoning', generation:{timeoutSeconds:20,streaming:false}, credentials:{apiKey:'test-key'},
  } },defaultSettings,vi.fn())
  const chunks=[]
  for await(const chunk of new ThirdPartyAIProvider(service,saved.connections[0],'gemini-reasoning').streamMessage([{id:'user-1',role:'user',content:'Hello',status:'complete',createdAt:1}],{effort:'high'}))chunks.push(chunk)
  expect(chunks).toContainEqual({type:'text',text:'Gemini reply'})
  expect(mock.generate).toHaveBeenCalledWith(expect.objectContaining({model:'gemini-reasoning',config:expect.objectContaining({thinkingConfig:{thinkingLevel:'HIGH'}})}))
})

it('round-trips Gemini function calls through Athena project tools',async()=>{
  mock.generate
    .mockResolvedValueOnce({functionCalls:[{id:'gemini-call-1',name:'read_file',args:{path:'source.ts'}}],candidates:[{finishReason:'STOP'}],usageMetadata:{promptTokenCount:2,candidatesTokenCount:1}})
    .mockResolvedValueOnce({text:'The file was read.',candidates:[{finishReason:'STOP'}],usageMetadata:{promptTokenCount:3,candidatesTokenCount:4}})
  const directory=mkdtempSync(join(tmpdir(),'athena-gemini-tools-'));directories.push(directory)
  const service=new ThirdPartyInferenceService(directory),id=randomUUID()
  const saved=await service.command({action:'save',connection:{id,version:1,name:'Gemini tools',provider:'gemini',protocol:'gemini-native',auth:'api-key',enabled:true,isDefault:false,baseUrl:'http://127.0.0.1:43123',allowPrivateNetwork:true,models:[{id:'gemini-agent',enabled:true,source:'manual',reportedCapabilities:{toolCalling:true},configuredCapabilities:{toolCalling:true,streaming:false}}],defaultModel:'gemini-agent',generation:{timeoutSeconds:20,streaming:false},credentials:{apiKey:'test-key'}}},defaultSettings,vi.fn())
  const execute=vi.fn(async()=>'{"ok":true,"content":"fixture"}'),projectTools={definitions:[{name:'read_file',description:'Read a file.',parameters:{type:'object',properties:{path:{type:'string'}},required:['path'],additionalProperties:false}}],assertAccess:vi.fn(),parallelSafe:()=>true,execute}
  const chunks=[]
  for await(const chunk of new ThirdPartyAIProvider(service,saved.connections[0],'gemini-agent').streamMessage([{id:'u1',role:'user',content:'Read source.ts',status:'complete',createdAt:1}],{context:{attachments:[],repositoryText:'',sources:[],projectName:'fixture',projectTools}}))chunks.push(chunk)
  expect(execute).toHaveBeenCalledWith('read_file',{path:'source.ts'},expect.any(AbortSignal))
  expect(chunks).toContainEqual({type:'text',text:'The file was read.'})
  expect(mock.generate).toHaveBeenCalledTimes(2)
  const continuation=mock.generate.mock.calls[1]?.[0]
  expect(JSON.stringify(continuation?.contents)).toContain('functionCall')
  expect(JSON.stringify(continuation?.contents)).toContain('functionResponse')
  expect(JSON.stringify(continuation?.contents)).toContain('gemini-call-1')
})

it('handles streamed Gemini function calls without duplicate execution',async()=>{
  const stream=(...items:Record<string,unknown>[])=>(async function*(){for(const item of items)yield item})()
  mock.generateStream
    .mockResolvedValueOnce(stream({functionCalls:[{id:'gemini-stream-1',name:'read_file',args:{path:'source.ts'}}],candidates:[{finishReason:'STOP'}],usageMetadata:{promptTokenCount:2,candidatesTokenCount:1}}))
    .mockResolvedValueOnce(stream({text:'Stream complete.',candidates:[{finishReason:'STOP'}],usageMetadata:{promptTokenCount:3,candidatesTokenCount:2}}))
  const directory=mkdtempSync(join(tmpdir(),'athena-gemini-stream-tools-'));directories.push(directory)
  const service=new ThirdPartyInferenceService(directory),id=randomUUID()
  const saved=await service.command({action:'save',connection:{id,version:1,name:'Gemini stream tools',provider:'gemini',protocol:'gemini-native',auth:'api-key',enabled:true,isDefault:false,baseUrl:'http://127.0.0.1:43123',allowPrivateNetwork:true,models:[{id:'gemini-stream-agent',enabled:true,source:'manual',reportedCapabilities:{toolCalling:true,streaming:true,streamingToolCalling:true},configuredCapabilities:{toolCalling:true,streaming:true,streamingToolCalling:true}}],defaultModel:'gemini-stream-agent',generation:{timeoutSeconds:20,streaming:true},credentials:{apiKey:'test-key'}}},defaultSettings,vi.fn())
  const execute=vi.fn(async()=>'{"ok":true}'),projectTools={definitions:[{name:'read_file',description:'Read a file.',parameters:{type:'object',properties:{path:{type:'string'}},required:['path'],additionalProperties:false}}],assertAccess:vi.fn(),parallelSafe:()=>true,execute}
  const chunks=[]
  for await(const chunk of new ThirdPartyAIProvider(service,saved.connections[0],'gemini-stream-agent').streamMessage([{id:'u1',role:'user',content:'Read source.ts',status:'complete',createdAt:1}],{context:{attachments:[],repositoryText:'',sources:[],projectName:'fixture',projectTools}}))chunks.push(chunk)
  expect(execute).toHaveBeenCalledTimes(1)
  expect(execute).toHaveBeenCalledWith('read_file',{path:'source.ts'},expect.any(AbortSignal))
  expect(chunks).toContainEqual({type:'text',text:'Stream complete.'})
})
