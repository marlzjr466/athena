// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const mock = vi.hoisted(() => ({ keychain: new Map<string, string>(), logs: vi.fn() }))
vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => '/tmp/athena-third-party-test-userdata' } }))
vi.mock('../electron/main/logger',()=>({log:mock.logs}))
vi.mock('../electron/main/ai/secureCredentialEntry', () => ({ credentialEntry: (service: string, account: string) => new class {
  private key: string
  constructor(service: string, account: string) { this.key = `${service}\0${account}` }
  async getPassword() { return mock.keychain.get(this.key) ?? null }
  async setPassword(value: string) { mock.keychain.set(this.key, value) }
  async deleteCredential() { mock.keychain.delete(this.key) }
}(service, account) }))

import { ThirdPartyAIProvider, ThirdPartyInferenceService, assertSafeInferenceUrl } from '../electron/main/ai/thirdPartyInference'
import { defaultSettings } from '../shared/settings'

let directories: string[] = []
const makeService = () => { const directory = mkdtempSync(join(tmpdir(), 'athena-inference-test-')); directories.push(directory); return new ThirdPartyInferenceService(directory) }
const connectionInput = (id = randomUUID()) => ({
  id, version: 1 as const, name: 'Local test gateway', provider: 'custom' as const, protocol: 'openai-chat-completions' as const,
  enabled: true, isDefault: false, baseUrl: 'http://127.0.0.1:43123/v1', auth: 'x-api-key' as const,
  allowPrivateNetwork: true, models: [], defaultModel: null, generation: { timeoutSeconds: 20, streaming: false },
  credentials: { apiKey: 'secret-gateway-key' },
})

beforeEach(() => { mock.keychain.clear(); mock.logs.mockClear(); directories = [] })
afterEach(() => { vi.unstubAllGlobals(); for (const directory of directories) rmSync(directory, { recursive: true, force: true }) })

describe('third-party inference configuration', () => {
  it.each(['openai-chat-completions','openai-responses'] as const)('continues truncated %s responses without executing partial tools', async protocol => {
    const requests: Record<string, unknown>[] = [], execute = vi.fn()
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init)
      const body = await request.json() as Record<string, unknown>; requests.push(body)
      const partial = requests.length === 1
      return new Response(JSON.stringify(protocol === 'openai-chat-completions'
        ? { id: `response-${requests.length}`, choices: [{ index: 0, finish_reason: partial ? 'length' : 'stop', message: { role: 'assistant', content: partial ? 'Still working' : 'Finished', ...(partial ? { tool_calls: [{ id: 'partial', type: 'function', function: { name: 'edit_file', arguments: '{' } }] } : {}) } }] }
        : { id: `response-${requests.length}`, status: partial ? 'incomplete' : 'completed', incomplete_details: partial ? { reason: 'max_output_tokens' } : null, output_text: partial ? 'Still working' : 'Finished', output: partial ? [{ type: 'function_call', call_id: 'partial', name: 'edit_file', arguments: '{', status: 'incomplete' }] : [] }), { headers: { 'content-type': 'application/json' } })
    }))
    const service = makeService()
    const saved = await service.command({ action: 'save', connection: { ...connectionInput(), protocol, models: [{ id: 'gateway-model', source: 'manual', enabled: true }], defaultModel: 'gateway-model' } }, defaultSettings, vi.fn())
    const chunks = []
    for await (const chunk of new ThirdPartyAIProvider(service, saved.connections[0], 'gateway-model').streamMessage([{ id: 'request', role: 'user', content: 'Continue the authorized task', status: 'complete', createdAt: 1 }], { context: { attachments: [], sources: [], repositoryText: '', projectTools: { definitions: [], execute, assertAccess() {} } } })) chunks.push(chunk)
    expect(requests).toHaveLength(2); expect(execute).not.toHaveBeenCalled()
    expect(chunks.filter(chunk => chunk.type === 'done')).toHaveLength(1)
    expect(requests.every(request => request.model === 'gateway-model')).toBe(true)
    expect(JSON.stringify(requests[1])).toContain('Incomplete tool calls were not executed')
  })
  it.each(['openai-chat-completions', 'openai-responses', 'anthropic-messages'] as const)('enforces child output allocation and counts complete %s payloads', async protocol => {
    let sent: Record<string, any> = {}
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init)
      sent = await request.json()
      return new Response(JSON.stringify(protocol === 'openai-chat-completions'
        ? { id: 'fixture', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Done' } }], usage: { prompt_tokens: 1000, completion_tokens: 10, total_tokens: 1010 } }
        : protocol === 'openai-responses' ? { id: 'fixture', status: 'completed', output_text: 'Done', output: [], usage: { input_tokens: 1000, output_tokens: 10, total_tokens: 1010 } }
        : { id: 'fixture', content: [{ type: 'text', text: 'Done' }], stop_reason: 'end_turn', usage: { input_tokens: 1000, output_tokens: 10 } }), { headers: { 'content-type': 'application/json' } })
    }))
    const service = makeService(), before = vi.fn(), usage = vi.fn()
    const saved = await service.command({ action: 'save', connection: { ...connectionInput(), protocol, generation: { streaming: false, timeoutSeconds: 20, maxOutputTokens: 16000 }, models: [{ id: 'child-model', source: 'manual', enabled: true, configuredCapabilities: { contextWindow: 256000, maxOutputTokens: 16000 } }], defaultModel: 'child-model' } }, defaultSettings, vi.fn())
    for await (const _chunk of new ThirdPartyAIProvider(service, saved.connections[0], 'child-model').streamMessage([{ id: 'fixture', role: 'user', content: 'Read supplied evidence', status: 'complete', createdAt: 1 }], { requestContextBudget: 128000, generationSettings: { outputTokens: 4096, maxOutputContinuations: 0 }, beforeModelRequest: before, onModelResponse: usage })) { /* Exhaust actual adapter. */ }
    expect(sent[protocol === 'openai-chat-completions' || protocol === 'anthropic-messages' ? 'max_tokens' : 'max_output_tokens']).toBe(4096)
    expect(before).toHaveBeenCalledTimes(1)
    expect(before.mock.calls[0][1]).toBe(4096)
    expect(before.mock.calls[0][0]).toBeGreaterThan(1000) // Includes system instructions, not just the short user text.
    expect(before.mock.calls[0][2].inputTokens).toBeGreaterThan(100)
    expect(usage).toHaveBeenCalledWith(expect.objectContaining({ inputTokens: 1000, outputTokens: 10 }))
  })
  it('toggles profiles independently, persists the state and catalog, and leaves running-task callbacks alone', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'athena-inference-toggle-')); directories.push(directory)
    const changed = vi.fn(), service = new ThirdPartyInferenceService(directory, changed), updateSettings = vi.fn()
    const firstId = randomUUID(), secondId = randomUUID()
    const first = await service.command({ action: 'save', connection: { ...connectionInput(firstId), models: [{ id: 'model-one', enabled: true, source: 'manual' }], defaultModel: 'model-one' } }, defaultSettings, updateSettings)
    await service.command({ action: 'save', connection: { ...connectionInput(secondId), name: 'Second gateway', models: [{ id: 'model-two', enabled: true, source: 'manual' }], defaultModel: 'model-two' } }, defaultSettings, updateSettings)
    changed.mockClear()
    await service.command({ action: 'set-enabled', id: firstId, enabled: false }, defaultSettings, updateSettings)
    expect(changed).not.toHaveBeenCalled()
    const restarted = new ThirdPartyInferenceService(directory)
    const profiles = await restarted.list()
    expect(profiles.find(profile => profile.id === firstId)).toMatchObject({ enabled: false, models: [{ id: 'model-one', enabled: true }], credentialConfigured: true })
    expect(profiles.find(profile => profile.id === secondId)).toMatchObject({ enabled: true, models: [{ id: 'model-two', enabled: true }] })
    await restarted.command({ action: 'set-enabled', id: firstId, enabled: true }, defaultSettings, updateSettings)
    expect((await restarted.list()).find(profile => profile.id === firstId)?.enabled).toBe(true)
    expect(first.connections).toHaveLength(1)
  })
  it('discovers exact model IDs, tests real inference, keeps profile credentials isolated, and exports redacted configuration', async () => {
    const requests: { url: string; headers: Headers; body: string }[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init)
      const url = new URL(request.url)
      const headers = new Headers(request.headers), body = await request.clone().text()
      requests.push({ url: url.toString(), headers, body })
      if (url.pathname === '/v1/models') return new Response(JSON.stringify({ data: [{ id: 'gateway/model-exact' }] }), { status: 200, headers: { 'content-type': 'application/json' } })
      if (url.pathname === '/v1/chat/completions') return new Response(JSON.stringify({ id: 'request-1', object: 'chat.completion', created: 1, model: 'gateway/model-exact', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Athena reply' } }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }), { status: 200, headers: { 'content-type': 'application/json', 'x-request-id': 'request-1' } })
      return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } })
    }))

    const service = makeService(), updateSettings = vi.fn()
    const saved = await service.command({ action: 'save', connection: connectionInput() }, defaultSettings, updateSettings)
    const profileId = saved.connections[0].id
    expect(saved.connections[0].credentialConfigured).toBe(true)
    expect(JSON.stringify(saved.connections)).not.toContain('secret-gateway-key')

    const discovered = await service.command({ action: 'discover', id: profileId }, defaultSettings, updateSettings)
    expect(discovered.connections[0].models.map(model => model.id)).toEqual(['gateway/model-exact'])
    expect(discovered.connections[0].defaultModel).toBe('gateway/model-exact')
    const tested = await service.command({ action: 'test', id: profileId }, defaultSettings, updateSettings)
    expect(tested).toMatchObject({ ok: true, connections: [{ status: 'connected', lastSuccessfulTestAt: expect.any(Number) }] })
    expect(requests.some(request => request.url.endsWith('/v1/chat/completions'))).toBe(true)
    expect(requests.every(request => request.headers.get('x-api-key') === 'secret-gateway-key')).toBe(true)
    expect(requests.every(request => request.headers.get('authorization') === null)).toBe(true)
    expect(requests.some(request => request.body.includes('Reply with the single word OK.'))).toBe(true)

    const active = (await service.active(profileId))!
    const provider = new ThirdPartyAIProvider(service, active, 'gateway/model-exact')
    const chunks = []
    for await (const chunk of provider.streamMessage([{ id: 'user-1', role: 'user', content: 'Hello', status: 'complete', createdAt: 1 }])) chunks.push(chunk)
    expect(chunks).toEqual([{ type: 'text', text: 'Athena reply' }, { type: 'done' }])
    const used = (await service.command({ action: 'list' }, { ...defaultSettings, thirdPartyConnectionId: profileId }, updateSettings)).connections[0]
    expect(used.usage).toMatchObject({ requests: 1, inputTokens: 3, outputTokens: 2, source: 'provider-reported' })

    const duplicate = await service.command({ action: 'duplicate', id: profileId }, defaultSettings, updateSettings)
    const duplicateId = duplicate.connections.find(profile => profile.id !== profileId)!.id
    const secretEntryFor = (id: string) => [...mock.keychain.entries()].find(([key]) => key.endsWith(`\0${id}`))
    expect(secretEntryFor(profileId)?.[1]).toContain('secret-gateway-key')
    expect(secretEntryFor(duplicateId)?.[1]).toContain('secret-gateway-key')
    expect(secretEntryFor(duplicateId)?.[0]).not.toBe(secretEntryFor(profileId)?.[0])

    const copied = duplicate.connections.find(profile => profile.id === duplicateId)!
    const { credentialConfigured: _credentialConfigured, customHeaders: _customHeaders, createdAt: _createdAt, updatedAt: _updatedAt, status: _status, statusMessage: _statusMessage, lastTestedAt: _lastTestedAt, lastSuccessfulTestAt: _lastSuccessfulTestAt, lastDiscoveryAt: _lastDiscoveryAt, usage: _usage, ...input } = copied
    const replaced = await service.command({ action: 'save', connection: { ...input, credentials: { apiKey: 'independent-secret' } } }, defaultSettings, updateSettings)
    expect(replaced.connections.find(profile => profile.id === duplicateId)?.status).toBe('not-tested')
    expect(secretEntryFor(profileId)?.[1]).toContain('secret-gateway-key')
    expect(secretEntryFor(duplicateId)?.[1]).toContain('independent-secret')

    const exported = await service.command({ action: 'export' }, defaultSettings, updateSettings)
    expect(JSON.stringify(exported.export)).not.toMatch(/secret-gateway-key|independent-secret/)
    expect(JSON.stringify(exported.export)).toContain('gateway/model-exact')
    const persisted = readFileSync(join(directories[0], 'connections.json'), 'utf8')
    expect(persisted).not.toMatch(/secret-gateway-key|independent-secret/)
  })

  it('rejects reserved authentication headers and unsafe metadata endpoints', async () => {
    const service = makeService()
    await expect(service.command({ action: 'save', connection: { ...connectionInput(), customHeaders: [{ name: 'Authorization', value: 'override', sensitive: true }] } }, defaultSettings, vi.fn())).rejects.toThrow('protocol-managed')
    await expect(assertSafeInferenceUrl('http://169.254.169.254/latest/meta-data', true)).rejects.toThrow('metadata')
    await expect(assertSafeInferenceUrl('file:///etc/passwd', true)).rejects.toThrow('HTTPS')
    await expect(assertSafeInferenceUrl('http://127.0.0.1:43123/v1', true)).resolves.toBeInstanceOf(URL)
  })

  it('keeps per-model manual reasoning configuration after catalog discovery', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: [{ id: 'reasoning-model' }] }), { status: 200, headers: { 'content-type': 'application/json' } })))
    const service=makeService(), id=randomUUID()
    const saved=await service.command({action:'save',connection:{...connectionInput(id),models:[{id:'reasoning-model',enabled:true,source:'provider' as const,configuredCapabilities:{reasoning:true,reasoningEfforts:['low','high'] as const,reasoningDefault:'low' as const}}],defaultModel:'reasoning-model'}},defaultSettings,vi.fn())
    expect(saved.ok).toBe(true)
    const discovered=await service.command({action:'discover',id},defaultSettings,vi.fn())
    expect(discovered.connections[0].models[0].configuredCapabilities).toMatchObject({reasoning:true,reasoningEfforts:['low','high'],reasoningDefault:'low'})
    const restarted=new ThirdPartyInferenceService(directories[0])
    expect((await restarted.list())[0].models[0].configuredCapabilities?.reasoningDefault).toBe('low')
  })

  it('probes declared streaming plus regular and streaming tool calling without executing the probe function', async () => {
    const requests: Record<string, unknown>[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init), body = JSON.parse(await request.clone().text()) as Record<string, unknown>
      requests.push(body)
      if (body.stream === true && body.tools) return new Response('data: {"id":"stream-tool","object":"chat.completion.chunk","created":1,"model":"gateway-probe","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"probe-call","type":"function","function":{"name":"athena_inference_probe","arguments":"{}"}}]},"finish_reason":null}]}\n\ndata: {"id":"stream-tool","object":"chat.completion.chunk","created":1,"model":"gateway-probe","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } })
      if (body.stream === true) return new Response('data: {"id":"stream-1","object":"chat.completion.chunk","created":1,"model":"gateway-probe","choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":null}]}\n\ndata: {"id":"stream-1","object":"chat.completion.chunk","created":1,"model":"gateway-probe","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } })
      if (body.tools) return new Response(JSON.stringify({ id: 'tool-1', object: 'chat.completion', created: 1, model: 'gateway-probe', choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'athena_inference_probe', arguments: '{}' } }] } }] }), { status: 200, headers: { 'content-type': 'application/json' } })
      return new Response(JSON.stringify({ id: 'basic-1', object: 'chat.completion', created: 1, model: 'gateway-probe', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'OK' } }] }), { status: 200, headers: { 'content-type': 'application/json' } })
    }))
    const service = makeService(), input = { ...connectionInput(), models: [{ id: 'gateway-probe', enabled: true, source: 'manual' as const, configuredCapabilities: { streaming: true, toolCalling: true } }], defaultModel: 'gateway-probe' }
    const saved = await service.command({ action: 'save', connection: input }, defaultSettings, vi.fn())
    const result = await service.command({ action: 'test', id: saved.connections[0].id }, defaultSettings, vi.fn())
    expect(result).toMatchObject({ ok: true, connections: [{ status: 'connected' }] })
    expect(result.message).toContain('streaming, tool calling and streaming tool calling verified')
    expect(requests).toHaveLength(4)
    expect(requests.filter(request => request.stream === true)).toHaveLength(2)
    expect(requests.filter(request => request.tools !== undefined)).toHaveLength(2)
    expect(JSON.stringify(requests)).toContain('athena_inference_probe')
  })

  it('requires a fresh connection test after changing the selected model tool capability', async () => {
    vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
      const request=input instanceof Request?input:new Request(input,init),body=JSON.parse(await request.clone().text()) as Record<string,unknown>
      if(body.tools)return new Response(JSON.stringify({id:'tool-1',object:'chat.completion',created:1,model:'gateway-probe',choices:[{index:0,finish_reason:'tool_calls',message:{role:'assistant',content:null,tool_calls:[{id:'probe-call',type:'function',function:{name:'athena_inference_probe',arguments:'{}'}}]}}]}),{status:200,headers:{'content-type':'application/json'}})
      return new Response(JSON.stringify({id:'basic-1',object:'chat.completion',created:1,model:'gateway-probe',choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content:'OK'}}]}),{status:200,headers:{'content-type':'application/json'}})
    }))
    const service=makeService(),id=randomUUID(),input={...connectionInput(id),models:[{id:'gateway-probe',enabled:true,source:'manual' as const,configuredCapabilities:{toolCalling:false}}],defaultModel:'gateway-probe'}
    const {credentials,...withoutCredentials}=input
    const saved=await service.command({action:'save',connection:input},defaultSettings,vi.fn())
    expect((await service.command({action:'test',id:saved.connections[0].id},defaultSettings,vi.fn())).ok).toBe(true)
    const changed=await service.command({action:'save',connection:{...withoutCredentials,models:[{...input.models[0],configuredCapabilities:{toolCalling:true}}]}},defaultSettings,vi.fn())
    expect(changed.connections[0]).toMatchObject({status:'not-tested',lastSuccessfulTestAt:null})
    const tested=await service.command({action:'test',id},defaultSettings,vi.fn())
    expect(tested).toMatchObject({ok:true,connections:[{status:'connected'}]})
    expect(tested.message).toContain('tool calling verified')
  })

  it('invalidates connection verification when a model tool capability changes', async () => {
    vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
      const request=input instanceof Request?input:new Request(input,init),body=JSON.parse(await request.clone().text()) as Record<string,unknown>
      if(body.tools)return new Response(JSON.stringify({id:'tool-1',object:'chat.completion',created:1,model:'gateway-probe',choices:[{index:0,finish_reason:'tool_calls',message:{role:'assistant',content:null,tool_calls:[{id:'probe-call',type:'function',function:{name:'athena_inference_probe',arguments:'{}'}}]}}]}),{status:200,headers:{'content-type':'application/json'}})
      return new Response(JSON.stringify({id:'basic-1',object:'chat.completion',created:1,model:'gateway-probe',choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content:'OK'}}]}),{status:200,headers:{'content-type':'application/json'}})
    }))
    const service=makeService(),id=randomUUID(),input={...connectionInput(id),models:[{id:'gateway-probe',enabled:true,source:'manual' as const,configuredCapabilities:{toolCalling:false}}],defaultModel:'gateway-probe'}
    const {credentials,...withoutCredentials}=input
    const first=await service.command({action:'save',connection:input},defaultSettings,vi.fn())
    expect((await service.command({action:'test',id:first.connections[0].id},defaultSettings,vi.fn())).ok).toBe(true)
    const updated=await service.command({action:'save',connection:{...withoutCredentials,models:[{...input.models[0],configuredCapabilities:{toolCalling:true}}]}},defaultSettings,vi.fn())
    expect(updated.connections[0]).toMatchObject({status:'not-tested',lastSuccessfulTestAt:null})
    const tested=await service.command({action:'test',id},defaultSettings,vi.fn())
    expect(tested).toMatchObject({ok:true,connections:[{status:'connected'}]})
    expect(tested.message).toContain('tool calling verified')
  })

  it('requires and verifies streaming tool calls as a separate model capability', async () => {
    const requests:Record<string,unknown>[]=[]
    vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
      const request=input instanceof Request?input:new Request(input,init),body=JSON.parse(await request.clone().text()) as Record<string,unknown>;requests.push(body)
      if(body.stream===true&&body.tools)return new Response('data: {"id":"stream-tool","object":"chat.completion.chunk","created":1,"model":"gateway-probe","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"probe-call","type":"function","function":{"name":"athena_inference_probe","arguments":"{}"}}]},"finish_reason":null}]}\n\ndata: {"id":"stream-tool","object":"chat.completion.chunk","created":1,"model":"gateway-probe","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n',{status:200,headers:{'content-type':'text/event-stream'}})
      if(body.stream===true)return new Response('data: {"id":"stream-1","object":"chat.completion.chunk","created":1,"model":"gateway-probe","choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":null}]}\n\ndata: {"id":"stream-1","object":"chat.completion.chunk","created":1,"model":"gateway-probe","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',{status:200,headers:{'content-type':'text/event-stream'}})
      if(body.tools)return new Response(JSON.stringify({id:'tool-1',object:'chat.completion',created:1,model:'gateway-probe',choices:[{index:0,finish_reason:'tool_calls',message:{role:'assistant',content:null,tool_calls:[{id:'probe-call',type:'function',function:{name:'athena_inference_probe',arguments:'{}'}}]}}]}),{status:200,headers:{'content-type':'application/json'}})
      return new Response(JSON.stringify({id:'basic-1',object:'chat.completion',created:1,model:'gateway-probe',choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content:'OK'}}]}),{status:200,headers:{'content-type':'application/json'}})
    }))
    const service=makeService(),input={...connectionInput(),models:[{id:'gateway-probe',enabled:true,source:'manual' as const,configuredCapabilities:{streaming:true,toolCalling:true,streamingToolCalling:true}}],defaultModel:'gateway-probe',generation:{timeoutSeconds:20,streaming:true}}
    const saved=await service.command({action:'save',connection:input},defaultSettings,vi.fn()),result=await service.command({action:'test',id:saved.connections[0].id},defaultSettings,vi.fn())
    expect(result).toMatchObject({ok:true,connections:[{status:'connected'}]})
    expect(result.message).toContain('streaming, tool calling and streaming tool calling verified')
    expect(requests.filter(body=>body.stream===true&&body.tools!==undefined)).toHaveLength(1)
  })

  it('verifies tool calling for the exact requested non-default model without changing the default model',async()=>{
    vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
      const request=input instanceof Request?input:new Request(input,init),body=JSON.parse(await request.clone().text()) as {model?:string;tools?:unknown}
      if(body.tools)return new Response(JSON.stringify({id:'tool-1',object:'chat.completion',created:1,model:body.model,choices:[{index:0,finish_reason:'tool_calls',message:{role:'assistant',content:null,tool_calls:[{id:'probe-call',type:'function',function:{name:'athena_inference_probe',arguments:'{}'}}]}}]}),{status:200,headers:{'content-type':'application/json'}})
      return new Response(JSON.stringify({id:'basic-1',object:'chat.completion',created:1,model:body.model,choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content:'OK'}}]}),{status:200,headers:{'content-type':'application/json'}})
    }))
    const service=makeService(),id=randomUUID(),saved=await service.command({action:'save',connection:{...connectionInput(id),models:[{id:'default-chat',enabled:true,source:'manual' as const,configuredCapabilities:{toolCalling:false}},{id:'agent-model',enabled:true,source:'manual' as const}],defaultModel:'default-chat'}},defaultSettings,vi.fn())
    const result=await service.command({action:'test',id:saved.connections[0].id,model:'agent-model'},defaultSettings,vi.fn())
    expect(result).toMatchObject({ok:true,connections:[{defaultModel:'default-chat',models:[{id:'default-chat'},{id:'agent-model',reportedCapabilities:{toolCalling:true}}]}]})
    expect(result.message).toContain('Inference test succeeded for agent-model; tool calling verified')
    const profile=result.connections[0]
    expect(service.runtimeCapabilities(profile,'agent-model').toolCalling).toBe(true)
    expect(service.runtimeCapabilities(profile,'default-chat').toolCalling).toBe(false)
  })

  it('keeps a gateway model connected as chat-only when its configured no-op tool probe is rejected',async()=>{
    vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
      const request=input instanceof Request?input:new Request(input,init),body=JSON.parse(await request.clone().text()) as {model?:string}
      return new Response(JSON.stringify({id:'basic-1',object:'chat.completion',created:1,model:body.model,choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content:'OK'}}]}),{status:200,headers:{'content-type':'application/json'}})
    }))
    const service=makeService(),id=randomUUID(),saved=await service.command({action:'save',connection:{...connectionInput(id),models:[{id:'chat-only-model',enabled:true,source:'manual' as const,configuredCapabilities:{toolCalling:true}}],defaultModel:'chat-only-model'}},defaultSettings,vi.fn())
    const result=await service.command({action:'test',id:saved.connections[0].id,model:'chat-only-model'},defaultSettings,vi.fn())
    expect(result).toMatchObject({ok:true,connections:[{status:'connected',models:[{reportedCapabilities:{toolCalling:false}}]}]})
    expect(result.message).toContain('configured tool calling was not accepted')
    expect(service.runtimeCapabilities(result.connections[0],'chat-only-model').toolCalling).toBe(false)
  })

  it('retries an explicitly enabled tool capability after a previous negative provider report',async()=>{
    let acceptsTools=false
    vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
      const request=input instanceof Request?input:new Request(input,init),body=JSON.parse(await request.clone().text()) as {model?:string;tools?:unknown}
      if(body.tools&&acceptsTools)return new Response(JSON.stringify({id:'tool-1',object:'chat.completion',created:1,model:body.model,choices:[{index:0,finish_reason:'tool_calls',message:{role:'assistant',content:null,tool_calls:[{id:'probe-call',type:'function',function:{name:'athena_inference_probe',arguments:'{}'}}]}}]}),{status:200,headers:{'content-type':'application/json'}})
      return new Response(JSON.stringify({id:'basic-1',object:'chat.completion',created:1,model:body.model,choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content:'OK'}}]}),{status:200,headers:{'content-type':'application/json'}})
    }))
    const service=makeService(),id=randomUUID(),saved=await service.command({action:'save',connection:{...connectionInput(id),models:[{id:'recovering-model',enabled:true,source:'manual' as const,configuredCapabilities:{toolCalling:true}}],defaultModel:'recovering-model'}},defaultSettings,vi.fn())
    const first=await service.command({action:'test',id:saved.connections[0].id,model:'recovering-model'},defaultSettings,vi.fn())
    expect(first.connections[0].models[0].reportedCapabilities?.toolCalling).toBe(false)
    acceptsTools=true
    const retried=await service.command({action:'test',id:saved.connections[0].id,model:'recovering-model'},defaultSettings,vi.fn())
    expect(retried).toMatchObject({ok:true,connections:[{models:[{reportedCapabilities:{toolCalling:true}}]}]})
    expect(retried.message).toContain('tool calling verified')
  })

  it.each(['openai-chat-completions', 'anthropic-messages'] as const)('runs a real read-only project tool round trip through %s', async protocol => {
    const root=mkdtempSync(join(tmpdir(),'athena-inference-tool-project-'));directories.push(root)
    writeFileSync(join(root,'source.ts'),'export const sourceValue = 7\n')
    const requests:Record<string,unknown>[]=[]
    vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
      const request=input instanceof Request?input:new Request(input,init),body=JSON.parse(await request.clone().text()) as Record<string,unknown>
      requests.push(body)
      if(protocol==='anthropic-messages'){
        const messages=body.messages as {role:string;content:unknown}[],hasResult=messages.some(message=>message.role==='user'&&JSON.stringify(message.content).includes('tool_result'))
        const result=hasResult
          ?{id:'msg-final',type:'message',role:'assistant',model:'claude-opus-5-5',content:[{type:'text',text:'The file exports sourceValue.'}],stop_reason:'end_turn',usage:{input_tokens:10,output_tokens:6}}
          :{id:'msg-tool',type:'message',role:'assistant',model:'claude-opus-5-5',content:[{type:'tool_use',id:'read-call-1',name:'read_file',input:{path:'source.ts'}}],stop_reason:'tool_use',usage:{input_tokens:12,output_tokens:4}}
        return new Response(JSON.stringify(result),{status:200,headers:{'content-type':'application/json'}})
      }
      const messages=body.messages as {role:string;content:unknown;tool_call_id?:string}[],hasResult=messages.some(message=>message.role==='tool')
      const result=hasResult
        ?{id:'chat-final',object:'chat.completion',created:1,model:'claude-opus-5-5',choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content:'The file exports sourceValue.'}}],usage:{prompt_tokens:10,completion_tokens:6,total_tokens:16}}
        :{id:'chat-tool',object:'chat.completion',created:1,model:'claude-opus-5-5',choices:[{index:0,finish_reason:'tool_calls',message:{role:'assistant',content:null,tool_calls:[{id:'read-call-1',type:'function',function:{name:'read_file',arguments:'{"path":"source.ts"}'}}]}}],usage:{prompt_tokens:12,completion_tokens:4,total_tokens:16}}
      return new Response(JSON.stringify(result),{status:200,headers:{'content-type':'application/json'}})
    }))
    const id=randomUUID(),service=makeService(),input={...connectionInput(id),name:'Selora test',provider:protocol==='anthropic-messages'?'anthropic-compatible' as const:'openai-compatible' as const,protocol,auth:protocol==='anthropic-messages'?'api-key' as const:'bearer' as const,baseUrl:'http://127.0.0.1:43123/v1',models:[{id:'claude-opus-5-5',enabled:true,source:'manual' as const,reportedCapabilities:{toolCalling:true},configuredCapabilities:{toolCalling:true,streaming:false,parallelToolCalling:true}}],defaultModel:'claude-opus-5-5',generation:{timeoutSeconds:20,streaming:false},credentials:{apiKey:'selora-test-key',bearerToken:'selora-test-key'}}
    const saved=await service.command({action:'save',connection:input},defaultSettings,vi.fn()),profile=(await service.active(id))!
    expect(saved.ok).toBe(true)
    const execute=vi.fn(async(_name:string,args:{path:string})=>readFileSync(join(root,args.path),'utf8'))
    const projectTools={definitions:[{name:'read_file',description:'Read a file in the authorized project.',parameters:{type:'object',properties:{path:{type:'string'}},required:['path'],additionalProperties:false}}],assertAccess:vi.fn(),parallelSafe:()=>true,execute}
    const chunks=[]
    for await(const chunk of new ThirdPartyAIProvider(service,profile,'claude-opus-5-5').streamMessage([{id:'user-1',role:'user',content:'Read source.ts',status:'complete',createdAt:1}],{context:{attachments:[],repositoryText:'',sources:[],projectName:'isolated fixture',projectTools}}))chunks.push(chunk)
    expect(execute).toHaveBeenCalledWith('read_file',{path:'source.ts'},expect.any(AbortSignal))
    expect(chunks).toContainEqual({type:'text',text:'The file exports sourceValue.'})
    expect(requests).toHaveLength(2)
    expect(mock.logs).toHaveBeenCalledWith('ai.third_party_tools.request',expect.objectContaining({registeredToolCount:1,sentToolCount:1,sentToolNames:'read_file'}))
    expect(mock.logs).toHaveBeenCalledWith('ai.third_party_tools.execution',expect.objectContaining({executedToolCount:1,toolResultsReturned:1,toolNames:'read_file'}))
    expect(mock.logs).toHaveBeenCalledWith('ai.third_party_tools.complete',expect.objectContaining({finalStatus:'complete',executedToolCount:1,toolResultsReturned:1}))
    expect(JSON.stringify(mock.logs.mock.calls)).not.toMatch(/selora-test-key|export const sourceValue|source\.ts/)
    if(protocol==='anthropic-messages'){
      expect((requests[0].tools as {name:string}[]).map(tool=>tool.name)).toContain('read_file')
      const transcript=requests[1].messages as {role:string;content:unknown}[]
      expect(transcript.at(-2)).toMatchObject({role:'assistant'})
      expect(JSON.stringify(transcript.at(-2)?.content)).toContain('read-call-1')
      expect(JSON.stringify(transcript.at(-1)?.content)).toContain('tool_result')
      expect(JSON.stringify(transcript.at(-1)?.content)).toContain('export const sourceValue = 7')
    }else{
      expect((requests[0].tools as {function:{name:string}}[]).map(tool=>tool.function.name)).toContain('read_file')
      const transcript=requests[1].messages as {role:string;content:unknown;tool_call_id?:string}[]
      expect(transcript.at(-2)?.role).toBe('assistant')
      expect(transcript.at(-1)).toMatchObject({role:'tool',tool_call_id:'read-call-1'})
      expect(transcript.at(-1)?.content).toContain('export const sourceValue = 7')
    }
  })

  it('runs a read-only project tool round trip through the OpenAI Responses API',async()=>{
    const requests:Record<string,unknown>[]=[]
    vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
      const request=input instanceof Request?input:new Request(input,init),body=JSON.parse(await request.clone().text()) as Record<string,unknown>;requests.push(body)
      const hasResult=JSON.stringify(body.input).includes('function_call_output')
      const result=hasResult
        ?{id:'resp-final',object:'response',status:'completed',model:'agent-model',output:[{id:'message-1',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'Read completed.',annotations:[]}]}],usage:{input_tokens:10,output_tokens:4,total_tokens:14}}
        :{id:'resp-tool',object:'response',status:'completed',model:'agent-model',output:[{id:'fc-1',type:'function_call',status:'completed',call_id:'read-call-1',name:'read_file',arguments:'{"path":"source.ts"}'}],usage:{input_tokens:8,output_tokens:2,total_tokens:10}}
      return new Response(JSON.stringify(result),{status:200,headers:{'content-type':'application/json'}})
    }))
    const service=makeService(),id=randomUUID(),saved=await service.command({action:'save',connection:{...connectionInput(id),provider:'openai-compatible',protocol:'openai-responses',auth:'bearer',models:[{id:'agent-model',enabled:true,source:'manual',reportedCapabilities:{toolCalling:true},configuredCapabilities:{toolCalling:true,streaming:false}}],defaultModel:'agent-model',credentials:{bearerToken:'responses-key'}}},defaultSettings,vi.fn())
    const execute=vi.fn(async()=>'{"ok":true,"content":"fixture"}'),projectTools={definitions:[{name:'read_file',description:'Read a file.',parameters:{type:'object',properties:{path:{type:'string'}},required:['path'],additionalProperties:false}}],assertAccess:vi.fn(),parallelSafe:()=>true,execute}
    const chunks=[]
    for await(const chunk of new ThirdPartyAIProvider(service,saved.connections[0],'agent-model').streamMessage([{id:'u1',role:'user',content:'Read source.ts',status:'complete',createdAt:1}],{context:{attachments:[],repositoryText:'',sources:[],projectName:'fixture',projectTools}}))chunks.push(chunk)
    expect(execute).toHaveBeenCalledWith('read_file',{path:'source.ts'},expect.any(AbortSignal))
    expect(chunks).toContainEqual({type:'text',text:'Read completed.'})
    expect(requests).toHaveLength(2)
    expect((requests[0].tools as {name:string}[]).map(tool=>tool.name)).toEqual(['read_file'])
    expect(JSON.stringify(requests[1].input)).toContain('function_call_output')
    expect(JSON.stringify(requests[1].input)).toContain('read-call-1')
  })

  it('accumulates streamed OpenAI-compatible tool arguments and executes the call once',async()=>{
    const requests:Record<string,unknown>[]=[]
    vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
      const request=input instanceof Request?input:new Request(input,init),body=JSON.parse(await request.clone().text()) as Record<string,unknown>;requests.push(body)
      const hasResult=JSON.stringify(body.messages).includes('tool_call_id')
      const sse=hasResult
        ?'data: {"id":"final","object":"chat.completion.chunk","created":1,"model":"agent-model","choices":[{"index":0,"delta":{"content":"Read completed."},"finish_reason":null}]}\n\ndata: {"id":"final","object":"chat.completion.chunk","created":1,"model":"agent-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
        :'data: {"id":"tool","object":"chat.completion.chunk","created":1,"model":"agent-model","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"stream-call-1","type":"function","function":{"name":"read_file","arguments":"{\\"path\\":"}}]},"finish_reason":null}]}\n\ndata: {"id":"tool","object":"chat.completion.chunk","created":1,"model":"agent-model","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"source.ts\\"}"}}]},"finish_reason":null}]}\n\ndata: {"id":"tool","object":"chat.completion.chunk","created":1,"model":"agent-model","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n'
      return new Response(sse,{status:200,headers:{'content-type':'text/event-stream'}})
    }))
    const service=makeService(),id=randomUUID(),saved=await service.command({action:'save',connection:{...connectionInput(id),provider:'openai-compatible',auth:'bearer',models:[{id:'agent-model',enabled:true,source:'manual',reportedCapabilities:{toolCalling:true,streaming:true,streamingToolCalling:true},configuredCapabilities:{toolCalling:true,streaming:true,streamingToolCalling:true}}],defaultModel:'agent-model',generation:{timeoutSeconds:20,streaming:true},credentials:{bearerToken:'stream-key'}}},defaultSettings,vi.fn())
    const execute=vi.fn(async()=>'{"ok":true}'),projectTools={definitions:[{name:'read_file',description:'Read a file.',parameters:{type:'object',properties:{path:{type:'string'}},required:['path'],additionalProperties:false}}],assertAccess:vi.fn(),parallelSafe:()=>true,execute}
    const chunks=[]
    for await(const chunk of new ThirdPartyAIProvider(service,saved.connections[0],'agent-model').streamMessage([{id:'u1',role:'user',content:'Read source.ts',status:'complete',createdAt:1}],{context:{attachments:[],repositoryText:'',sources:[],projectName:'fixture',projectTools}}))chunks.push(chunk)
    expect(execute).toHaveBeenCalledTimes(1)
    expect(execute).toHaveBeenCalledWith('read_file',{path:'source.ts'},expect.any(AbortSignal))
    expect(chunks).toContainEqual({type:'text',text:'Read completed.'})
    expect(requests).toHaveLength(2)
  })

  it('reports an exhausted gateway account as HTTP 402 without exposing its response body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'private provider diagnostic' }), { status: 402, headers: { 'content-type': 'application/json' } })))
    const service = makeService()
    const input = { ...connectionInput(), models: [{ id: 'gateway-probe', enabled: true, source: 'manual' as const }], defaultModel: 'gateway-probe' }
    const saved = await service.command({ action: 'save', connection: input }, defaultSettings, vi.fn())
    const result = await service.command({ action: 'test', id: saved.connections[0].id }, defaultSettings, vi.fn())
    expect(result).toMatchObject({ ok: false, connections: [{ status: 'payment-required' }] })
    expect(result.message).toContain('HTTP 402')
    expect(result.message).toContain('allowance or balance')
    expect(JSON.stringify(result)).not.toContain('private provider diagnostic')
    const status = await service.status(saved.connections[0].id)
    expect(status.status).toMatchObject({ active: true, connection: 'failed', models: ['gateway-probe'] })
  })

  it('uses the Anthropic Messages route and converts non-stream replies into Athena chat chunks', async () => {
    const requests: { url: string; headers: Headers; body: Record<string, unknown> }[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init), body = JSON.parse(await request.clone().text()) as Record<string, unknown>
      requests.push({ url: request.url, headers: new Headers(request.headers), body })
      return new Response(JSON.stringify({ id: 'msg-1', type: 'message', role: 'assistant', model: 'claude-gateway-model', content: [{ type: 'text', text: 'Anthropic reply' }], stop_reason: 'end_turn', usage: { input_tokens: 4, output_tokens: 3, cache_read_input_tokens: 0 } }), { status: 200, headers: { 'content-type': 'application/json' } })
    }))
    const service = makeService(), input = { ...connectionInput(), provider: 'anthropic-compatible' as const, protocol: 'anthropic-messages' as const, auth: 'api-key' as const, baseUrl: 'http://127.0.0.1:43123/v1', models: [{ id: 'claude-gateway-model', enabled: true, source: 'manual' as const, configuredCapabilities: { streaming: false } }], defaultModel: 'claude-gateway-model', credentials: { apiKey: 'anthropic-gateway-key' } }
    const saved = await service.command({ action: 'save', connection: input }, defaultSettings, vi.fn())
    const tested = await service.command({ action: 'test', id: saved.connections[0].id }, defaultSettings, vi.fn())
    expect(tested.ok).toBe(true)
    const active = (await service.active(saved.connections[0].id))!
    const chunks = []
    for await (const chunk of new ThirdPartyAIProvider(service, active, 'claude-gateway-model').streamMessage([{ id: 'user-1', role: 'user', content: 'Hello', status: 'complete', createdAt: 1 }])) chunks.push(chunk)
    expect(chunks).toEqual([{ type: 'text', text: 'Anthropic reply' }, { type: 'done' }])
    expect(requests.every(request => new URL(request.url).pathname === '/v1/messages')).toBe(true)
    expect(requests.every(request => request.headers.get('x-api-key') === 'anthropic-gateway-key')).toBe(true)
    expect(requests.every(request => request.headers.get('anthropic-version') === '2023-06-01')).toBe(true)
    expect(requests.every(request => new URL(request.url).pathname !== '/v1/v1/messages')).toBe(true)
  })

  it.each(['openai-chat-completions', 'openai-responses', 'anthropic-messages'] as const)('sends configured effort through the %s protocol', async protocol => {
    const requests: Record<string, unknown>[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init)
      requests.push(JSON.parse(await request.clone().text()) as Record<string, unknown>)
      const body = protocol === 'openai-chat-completions'
        ? { id: 'chat-1', object: 'chat.completion', created: 1, model: 'reasoning-model', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'OK' } }] }
        : protocol === 'openai-responses'
          ? { id: 'resp-1', object: 'response', status: 'completed', model: 'reasoning-model', reasoning: { effort: 'high' }, output: [{ id: 'message-1', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'OK', annotations: [] }] }] }
          : { id: 'msg-1', type: 'message', role: 'assistant', model: 'reasoning-model', content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    }))
    const service = makeService(), id = randomUUID()
    const saved = await service.command({ action: 'save', connection: { ...connectionInput(id), protocol, provider: protocol === 'anthropic-messages' ? 'anthropic-compatible' as const : 'custom' as const, models: [{ id: 'reasoning-model', enabled: true, source: 'manual' as const, configuredCapabilities: { streaming: false, reasoning: true, reasoningEfforts: ['low', 'high'] as const, thinkingMode: protocol === 'anthropic-messages' ? 'adaptive' as const : undefined } }], defaultModel: 'reasoning-model' } }, defaultSettings, vi.fn())
    const profile = saved.connections[0]
    const chunks = []
    for await (const chunk of new ThirdPartyAIProvider(service, profile, 'reasoning-model').streamMessage([{ id: 'user-1', role: 'user', content: 'Hello', status: 'complete', createdAt: 1 }], { effort: 'high' })) chunks.push(chunk)
    expect(chunks).toContainEqual({ type: 'text', text: 'OK' })
    const payload = requests[0]
    if (protocol === 'openai-chat-completions') expect(payload.reasoning_effort).toBe('high')
    else if (protocol === 'openai-responses') expect(payload.reasoning).toEqual({ effort: 'high' })
    else { expect(payload.output_config).toEqual({ effort: 'high' }); expect(payload.thinking).toEqual({ type: 'adaptive' }) }
    expect((await service.list())[0].lastReasoning).toMatchObject({model:'reasoning-model',requested:'high',effective:protocol==='openai-responses'?'high':null})
  })
})
