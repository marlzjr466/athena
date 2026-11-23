// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UsageLedger, UsageRecorder, apiUsageAccount } from '../electron/main/ai/usageLedger'
import { aggregateUsage, periodStart, type UsageRecord } from '../shared/providerUsage'
import { OpenAIProvider } from '../electron/main/ai/OpenAIProvider'
import OpenAI from 'openai'
import { ContextManager } from '../electron/main/ai/contextManager'

const paths: string[] = []
function directory() { const path = mkdtempSync(join(tmpdir(), 'athena-usage-')); paths.push(path); return path }
afterEach(() => { for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true }) })
const now = Date.UTC(2026, 10, 23, 4)
const receipt = (patch: Partial<UsageRecord> = {}): UsageRecord => ({ id: 'r1', provider: 'chatgpt-subscription', accountId: 'a', model: 'model', conversationId: 'c1', executionId: 'e1', responseId: 'resp_1', timestamp: now, updatedAt: now, status: 'completed', source: 'openai-response', requestCount: 1, inputTokens: 100, outputTokens: 20, cachedInputTokens: 40, reasoningTokens: 5, totalTokens: 120, ...patch })
const query = { provider: 'chatgpt-subscription' as const, accountId: 'a', period: 'all' as const }
const usage = { input_tokens: 100, output_tokens: 20, total_tokens: 120, input_tokens_details: { cached_tokens: 40 }, output_tokens_details: { reasoning_tokens: 5 } }
const sse = (...events: unknown[]) => new Response(events.map(e=>`data: ${JSON.stringify(e)}\n\n`).join(''), {headers:{'content-type':'text/event-stream'}})
const response = (id: string, output: unknown[] = []) => ({type:'response.completed',response:{id,status:'completed',model:'gpt-6-sol',usage,output}})

describe('persistent provider usage', () => {
  it('deduplicates stable response IDs across restored executions and isolates accounts/providers', () => {
    const path = directory(), ledger = new UsageLedger(path)
    ledger.record(receipt()); ledger.record(receipt()); ledger.record(receipt({id:'retry-copy'}))
    ledger.record(receipt({id:'other',accountId:'b'})); ledger.record(receipt({id:'api',provider:'openai-api'}))
    const restored = new UsageLedger(path).snapshot(query)
    expect(restored.totals).toMatchObject({ requests:1, completed:1, inputTokens:100, cachedInputTokens:40, outputTokens:20, reasoningTokens:5, totalTokens:120 })
    expect(restored.accounts).toEqual(['a','b'])
  })
  it('aggregates by model, conversation and UTC calendar periods without counting token subsets twice', () => {
    const records = [receipt(),receipt({id:'two',responseId:'resp_2',model:'second',conversationId:'c2',timestamp:now-86400_000}),receipt({id:'last-month',timestamp:Date.UTC(2026,9,10)})]
    const all = aggregateUsage(records,query,now)
    expect(all.totals.totalTokens).toBe(360); expect(all.models).toHaveLength(2); expect(all.conversations).toHaveLength(2); expect(all.days).toHaveLength(3)
    expect(aggregateUsage(records,{...query,period:'day'},now).totals.requests).toBe(1)
    expect(aggregateUsage(records,{...query,period:'week'},now).totals.requests).toBe(1)
    expect(aggregateUsage(records,{...query,period:'month'},now).totals.requests).toBe(2)
    expect(aggregateUsage(records,{...query,conversationId:'c2'},now).totals.requests).toBe(1)
    expect(periodStart('month',now)).toBe(Date.UTC(2026,10,1))
  })
  it('persists starts and recovers interrupted consumption as unknown after restart', () => {
    const path=directory(), ledger=new UsageLedger(path)
    const recorder=new UsageRecorder('model',{executionId:'e',conversationId:'c'},ledger.forAccount('chatgpt-subscription','a'))
    recorder.begin()
    expect(new UsageLedger(path).snapshot(query).totals).toMatchObject({ requests:1,interrupted:1,unknownUsage:1,receipts:0 })
    recorder.finish(undefined,{id:'empty',status:'completed'})
    expect(ledger.snapshot(query).totals).toMatchObject({completed:1,unknownUsage:1,receipts:0})
  })
  it('imports prefixed ChatGPT historical receipts once and never attributes unbound API records to a new key', () => {
    const path=directory()
    writeFileSync(join(path,'conversations.json'), JSON.stringify({sessions:[{id:'c',messages:[{id:'e',createdAt:now,execution:{providerId:'chatgpt-subscription',accountId:'subscription:a',modelId:'gpt-6-sol',providerUsage:{inputTokens:100,outputTokens:20,requestCount:2,estimated:false,updatedAt:now}}},{id:'api',createdAt:now,execution:{providerId:'openai-api',accountId:'cloud:openai-api',providerUsage:{inputTokens:200,outputTokens:30,requestCount:1,estimated:false,updatedAt:now}}}]}]}))
    const ledger=new UsageLedger(path); ledger.importHistory(path); ledger.importHistory(path)
    expect(ledger.snapshot(query).totals).toMatchObject({requests:2,inputTokens:100})
    expect(ledger.snapshot({...query,provider:'openai-api',accountId:apiUsageAccount('fixture-key')}).totals.requests).toBe(0)
    expect(ledger.snapshot({...query,provider:'openai-api',accountId:'historical-unassigned'}).totals.inputTokens).toBe(200)
    expect(apiUsageAccount('key-a')).not.toBe(apiUsageAccount('key-b'))
  })
  it('preserves a damaged ledger instead of overwriting it or stopping the app', () => {
    const path=directory(); writeFileSync(join(path,'provider-usage.json'),'damaged fixture')
    const ledger=new UsageLedger(path);ledger.record(receipt())
    expect(ledger.snapshot(query).error).toContain('original file is preserved')
    expect(readFileSync(join(path,'provider-usage.json'),'utf8')).toBe('damaged fixture')
  })
})

describe('actual OpenAI adapter usage collection with mocked transport', () => {
  it.each([false, true])('records native or summarized context compaction (subscription=%s)', async subscription => {
    const ledger = new UsageLedger(directory())
    const request = vi.fn<typeof fetch>(async url => String(url).endsWith('/compact')
      ? new Response(JSON.stringify({ id: 'cmp_fixture', object: 'response.compaction', usage, output: [{ type: 'compaction', id: 'cmp', encrypted_content: 'fixture' }] }), { headers: { 'content-type': 'application/json' } })
      : sse({ type: 'response.output_text.delta', delta: 'Summary of pending work.' }, response('resp_summary', [{ type: 'message', id: 'msg', role: 'assistant', status: 'completed', content: [{type:'output_text',text:'Summary of pending work.',annotations:[]}] }])))
    const client = new OpenAI({ apiKey: 'fixture', fetch: request })
    const manager = new ContextManager(client, 'gpt-5.6-sol', 'Instructions', undefined, { conversationId:'c', executionId:'e' }, new AbortController().signal, subscription, ledger.forAccount('chatgpt-subscription','a'))
    await manager.fit([{role:'user',content:'Preserve this objective and summarize completed evidence.'}], true)
    expect(ledger.snapshot(query).totals).toMatchObject({requests:1,completed:1,inputTokens:100,outputTokens:20})
  })
  it.each([false,true])('records every tool round with account, response, execution and conversation identities (subscription=%s)', async subscription => {
    const path=directory(), ledger=new UsageLedger(path), providerId=subscription?'chatgpt-subscription':'openai-api'
    const call={type:'function_call',id:'item',call_id:'call',name:'read_file',arguments:'{}',status:'completed'}
    const request=vi.fn<typeof fetch>().mockResolvedValueOnce(sse(response('resp_tool',[call]))).mockResolvedValueOnce(sse({type:'response.output_text.delta',delta:'OK'},response('resp_final')))
    const provider=new OpenAIProvider('fixture','gpt-6-sol',request,undefined,subscription,undefined,{},ledger.forAccount(providerId,'a'))
    const execute=vi.fn(async()=>'{"ok":true}')
    for await (const _ of provider.streamMessage([{id:'u',role:'user',content:'Read the fixture',status:'complete',createdAt:now}],{executionId:'e1',conversationId:'c1',context:{attachments:[],sources:[],repositoryText:'',projectTools:{definitions:[{name:'read_file',description:'Read fixture',parameters:{type:'object'}}],assertAccess:()=>{},execute}}})) { /* consume */ }
    expect(execute).toHaveBeenCalledOnce();expect(request).toHaveBeenCalledTimes(2)
    expect(new UsageLedger(path).snapshot({...query,provider:providerId}).totals).toMatchObject({requests:2,completed:2,inputTokens:200,outputTokens:40,cachedInputTokens:80,reasoningTokens:10,totalTokens:240})
    const saved=JSON.parse(readFileSync(join(path,'provider-usage.json'),'utf8')).records
    expect(saved.map((r: UsageRecord)=>r.responseId)).toEqual(['resp_tool','resp_final'])
    expect(saved.every((r: UsageRecord)=>r.executionId==='e1'&&r.conversationId==='c1')).toBe(true)
    expect(readFileSync(join(path,'provider-usage.json'),'utf8')).not.toContain('Read the fixture')
  })
  it.each(['http','stream','incomplete','eof','cancel'] as const)('records %s outcomes without inventing a zero-token receipt', async kind => {
    const ledger=new UsageLedger(directory()), controller=new AbortController()
    const request=vi.fn<typeof fetch>(async()=>{
      if(kind==='http')return new Response(JSON.stringify({error:{code:'invalid_value',message:'fixture'}}),{status:400})
      if(kind==='cancel'){controller.abort();throw new DOMException('Cancelled','AbortError')}
      if(kind==='stream')return sse({type:'response.failed',response:{id:'failed',status:'failed',error:{code:'invalid_value',message:'fixture'}}})
      if(kind==='incomplete')return sse({type:'response.incomplete',response:{id:'partial',status:'incomplete',usage,incomplete_details:{reason:'content_filter'},output:[]}})
      return sse({type:'response.output_text.delta',delta:'Partial'})
    })
    const provider=new OpenAIProvider('fixture','gpt-6-sol',request,undefined,true,undefined,{},ledger.forAccount('chatgpt-subscription','a'))
    try {for await(const _ of provider.streamMessage([{id:'u',role:'user',content:'Hello',status:'complete',createdAt:now}],{signal:controller.signal,executionId:'e',conversationId:'c',contextSettings:{...((await import('../shared/context')).contextDefaults()),maxStreamRecoveries:0}})) {/* consume */}}catch{/* expected */}
    const t=ledger.snapshot(query).totals
    expect(t.requests).toBeGreaterThan(0)
    expect(t.completed).toBe(0)
    expect(t.unknownUsage).toBe(kind==='incomplete'?0:t.requests)
    if(kind==='incomplete')expect(t.inputTokens).toBe(100)
  })
})
