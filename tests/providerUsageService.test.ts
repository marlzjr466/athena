// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
vi.mock('electron',()=>({app:{isPackaged:false,getPath:()=>'/fixture'}}))
import { ProviderUsageService } from '../electron/main/ai/providerUsageService'
import { billingPresentation, remainingAllowance } from '../shared/openAIBilling'
import { periodStart } from '../shared/providerUsage'
import { UsageLedger } from '../electron/main/ai/usageLedger'
const paths:string[]=[]
afterEach(()=>{for(const path of paths.splice(0))rmSync(path,{recursive:true,force:true})})
function fixture(request=vi.fn<typeof fetch>()) {
  const directory=mkdtempSync(join(tmpdir(),'athena-org-usage-'));paths.push(directory)
  let secret:string|null=null
  const vault={getPassword:vi.fn(async()=>secret),setPassword:vi.fn(async(v:string)=>{secret=v}),deleteCredential:vi.fn(async()=>{secret=null})}
  const ledger=new UsageLedger(directory)
  const service=new ProviderUsageService(ledger,directory,request,()=>vault)
  return {service,request,directory,vault}
}
const controls=(target:URL)=>target.pathname.endsWith('/spend_limit') ? new Response(JSON.stringify({object:target.pathname.includes('/projects/')?'project.spend_limit':'organization.spend_limit',threshold_amount:10000,currency:'USD',interval:'month',enforcement:{status:'enforcing'}})) : target.pathname.endsWith('/spend_alerts') ? new Response(JSON.stringify({data:[],has_more:false,last_id:null})) : undefined
const query={provider:'openai-api' as const,accountId:'fixture-inference',period:'month' as const,refresh:false}
const page=(results:unknown[],next:string|null=null)=>new Response(JSON.stringify({data:[{start_time:1,end_time:2,results}],has_more:!!next,next_page:next}))

describe('separately authorized OpenAI organization analytics',()=>{
  it('never calls organization APIs without Admin credentials or merely when Settings opens',async()=>{
    const f=fixture()
    expect((await f.service.snapshot({...query,refresh:true})).adminConfigured).toBe(false)
    await f.service.configure('sk-admin-test-credential','proj_fixture')
    expect((await f.service.snapshot(query)).adminConfigured).toBe(true)
    expect(f.request).not.toHaveBeenCalled()
    expect(f.vault.setPassword).toHaveBeenCalledOnce()
  })
  it('paginates authorized usage, preserves units and scopes, caches across restarts, and does not mix local totals',async()=>{
    const request=vi.fn<typeof fetch>(async(url,options)=>{
      const target=new URL(String(url))
      expect(options?.headers).toEqual({Authorization:'Bearer sk-admin-test-credential'})
      const control=controls(target); if(control)return control
      if(target.pathname.endsWith('/usage/completions'))expect(target.searchParams.get('project_ids[]')).toBe('proj_fixture')
      if(target.pathname.endsWith('/costs'))return page([{amount:{value:0.75,currency:'usd'},project_id:'proj_fixture'}])
      return page([{input_tokens:100,output_tokens:30,input_cached_tokens:20,num_model_requests:2,model:'model',project_id:'proj_fixture'}],target.searchParams.has('page')?null:'next')
    })
    const f=fixture(request);await f.service.configure('sk-admin-test-credential','proj_fixture')
    const data=await f.service.snapshot({...query,refresh:true})
    expect(data.local.totals.requests).toBe(0)
    expect(data.organization?.metrics).toContainEqual(expect.objectContaining({id:'org-input',value:200,unit:'tokens'}))
    expect(data.organization?.metrics).toContainEqual(expect.objectContaining({id:'org-cost:usd',value:0.75,unit:'USD'}))
    expect(data.organization?.metrics).toContainEqual(expect.objectContaining({id:'org-cost:usd',label:'Reported project cost'}))
    expect(request).toHaveBeenCalledTimes(8)
    const restored=new ProviderUsageService(new UsageLedger(f.directory),f.directory,request,()=>f.vault)
    expect((await restored.snapshot(query)).organization?.metrics).toEqual(data.organization?.metrics)
    expect(request).toHaveBeenCalledTimes(8)
  })
  it.each([401,403,429,500])('retains cached totals and local usage on HTTP %s',async status=>{
    const f=fixture(vi.fn<typeof fetch>().mockImplementation(async()=>page([{input_tokens:10,output_tokens:2,num_model_requests:1}])))
    await f.service.configure('sk-admin-test-credential','')
    const before=await f.service.snapshot({...query,refresh:true})
    f.request.mockImplementation(async()=>new Response('private response',{status}))
    const after=await f.service.snapshot({...query,refresh:true})
    expect(after.organization?.metrics).toEqual(before.organization?.metrics)
    expect(after.organization?.stale).toBe(true);expect(after.organizationError).toBeTruthy()
    expect(after.organizationError).not.toContain('private response')
    expect(after.local.totals).toEqual(before.local.totals)
  })
  it('isolates caches by Admin credential and never uses the old report after replacement',async()=>{
    const f=fixture(vi.fn<typeof fetch>().mockImplementation(async()=>page([])))
    await f.service.configure('sk-admin-test-account-one','');await f.service.snapshot({...query,refresh:true})
    await f.service.configure('sk-admin-test-account-two','')
    expect((await f.service.snapshot(query)).organization).toBeUndefined()
    await f.service.remove();expect((await f.service.snapshot(query)).adminConfigured).toBe(false)
  })
  it('deduplicates concurrent manual refreshes',async()=>{
    const f=fixture(vi.fn<typeof fetch>().mockImplementation(async(url)=>{await new Promise(r=>setTimeout(r,10));return controls(new URL(String(url))) ?? page([])}))
    await f.service.configure('sk-admin-test-credential','')
    await Promise.all([f.service.snapshot({...query,refresh:true}),f.service.snapshot({...query,refresh:true})])
    expect(f.request).toHaveBeenCalledTimes(4)
  })
})

describe('authoritative monthly spend controls',()=>{
  const requestForCosts=(usd=25)=>vi.fn<typeof fetch>(async input=>{
    const url=new URL(String(input))
    return controls(url) ?? (url.pathname.endsWith('/costs') ? page([{amount:{value:usd,currency:'usd'},project_id:url.searchParams.get('project_ids[]')}]) : page([{input_tokens:10,output_tokens:2,num_model_requests:1}]))
  })
  it('uses documented read-only endpoints and matching monthly organization/project totals independent of local period',async()=>{
    const request=requestForCosts(),f=fixture(request); await f.service.configure('sk-admin-test-credential','proj_one')
    const result=await f.service.snapshot({...query,period:'day',refresh:true})
    const billing=result.organization!.billing!,start=periodStart('month',Date.now())
    expect(billing.start).toBe(start);expect(billing.scopes).toHaveLength(2)
    for(const scope of billing.scopes)expect(remainingAllowance(scope,start)).toEqual({total:100,remaining:75,percentage:75})
    const urls=request.mock.calls.map(([url])=>new URL(String(url)))
    expect(urls.map(u=>u.pathname)).toEqual(expect.arrayContaining(['/v1/organization/spend_limit','/v1/organization/projects/proj_one/spend_limit','/v1/organization/spend_alerts','/v1/organization/projects/proj_one/spend_alerts']))
    expect(urls.filter(u=>u.pathname.endsWith('/costs')&&u.searchParams.get('start_time')===String(start/1000)).map(u=>u.searchParams.get('project_ids[]'))).toEqual(expect.arrayContaining([null,'proj_one']))
    expect(request.mock.calls.every(([,options])=>!options?.method||options.method==='GET')).toBe(true)
    expect(result.local.totals.receipts).toBe(0)
  })
  it('does not compare project spending to an organization-wide limit',async()=>{
    const request=vi.fn<typeof fetch>(async input=>{
      const url=new URL(String(input));const control=controls(url);if(control)return control
      return url.pathname.endsWith('/costs')?page([{amount:{value:url.searchParams.has('project_ids[]')?5:90,currency:'usd'}}]):page([])
    })
    const f=fixture(request);await f.service.configure('sk-admin-test-credential','proj_one')
    const billing=(await f.service.snapshot({...query,refresh:true})).organization!.billing!
    expect(remainingAllowance(billing.scopes[0],billing.start)?.remaining).toBe(10)
    expect(remainingAllowance(billing.scopes[1],billing.start)?.remaining).toBe(95)
  })
  it('isolates project caches and keeps them restored across restarts',async()=>{
    const f=fixture(requestForCosts());await f.service.configure('sk-admin-test-credential','proj_one')
    const before=await f.service.snapshot({...query,refresh:true})
    const restored=new ProviderUsageService(new UsageLedger(f.directory),f.directory,f.request,()=>f.vault)
    expect((await restored.snapshot(query)).organization?.billing).toEqual(before.organization?.billing)
    await restored.configure('sk-admin-test-credential','proj_two')
    expect((await restored.snapshot(query)).organization).toBeUndefined()
    expect((await restored.snapshot({...query,refresh:true})).organization?.billing?.scopes[1].id).toBe('proj_two')
  })
  it('retains previous values on failure without combining old limits and new costs',async()=>{
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-23T10:00:00Z'))
    try {
      const f=fixture(requestForCosts());await f.service.configure('sk-admin-test-credential','')
      const before=await f.service.snapshot({...query,refresh:true})
      vi.setSystemTime(new Date('2026-11-23T11:00:00Z'))
      f.request.mockImplementation(async input=>{
        const url=new URL(String(input));if(url.pathname.endsWith('/spend_limit'))return new Response('',{status:403})
        return controls(url)??(url.pathname.endsWith('/costs')?page([{amount:{value:40,currency:'usd'}}]):page([]))
      })
      const billing=(await f.service.snapshot({...query,refresh:true})).organization!.billing!
      expect(billing.scopes[0].cost?.usd).toBe(40)
      expect(billing.scopes[0].limit).toEqual(before.organization?.billing?.scopes[0].limit)
      expect(remainingAllowance(billing.scopes[0],billing.start)).toBeNull()
      expect(billingPresentation(billing).error).toMatch(/Permission required/)
      expect(billingPresentation(billing).stale).toBe(true)
    } finally {vi.useRealTimers()}
  })
  it.each([401,403,404,500])('never turns failed limit retrieval HTTP %s into zero or unlimited allowance',async status=>{
    const request=requestForCosts();request.mockImplementation(async input=>{
      const url=new URL(String(input));return url.pathname.endsWith('/spend_limit')?new Response('sensitive detail',{status}):controls(url)??page([{amount:{value:25,currency:'usd'}}])
    })
    const f=fixture(request);await f.service.configure('sk-admin-test-credential','')
    const billing=(await f.service.snapshot({...query,refresh:true})).organization!.billing!
    expect(billing.scopes[0].limit).toBeUndefined();expect(billing.scopes[0].cost?.usd).toBe(25)
    expect(remainingAllowance(billing.scopes[0],billing.start)).toBeNull()
    expect(JSON.stringify(billing)).not.toContain('sensitive detail')
  })
  it('paginates spending alerts and discards private recipients from saved snapshots',async()=>{
    const request=requestForCosts();request.mockImplementation(async input=>{
      const url=new URL(String(input))
      if(url.pathname.endsWith('/spend_alerts'))return new Response(JSON.stringify({data:[{id:url.searchParams.has('after')?'two':'one',threshold_amount:5000,currency:'USD',interval:'month',notification_channel:{recipients:['private@example.test']}}],has_more:!url.searchParams.has('after'),last_id:'one'}))
      return controls(url)??page([])
    })
    const f=fixture(request);await f.service.configure('sk-admin-test-credential','')
    const billing=(await f.service.snapshot({...query,refresh:true})).organization!.billing!
    expect(billing.scopes[0].alerts?.values).toHaveLength(2)
    expect(JSON.stringify(billing)).not.toContain('private@')
    expect(billingPresentation(billing).metrics?.filter(m=>m.label.includes('Spend alert'))).toHaveLength(2)
  })
  it('does not fetch an invented ChatGPT quota or credit grant endpoint',async()=>{
    const f=fixture(requestForCosts());await f.service.configure('sk-admin-test-credential','')
    await f.service.snapshot({...query,provider:'chatgpt-subscription',refresh:true})
    expect(f.request).not.toHaveBeenCalled()
  })
  it('rejects unsupported currencies, malformed limits and costs rather than estimating',async()=>{
    const request=vi.fn<typeof fetch>(async input=>{
      const url=new URL(String(input))
      if(url.pathname.endsWith('/spend_limit'))return new Response(JSON.stringify({threshold_amount:'10000'}))
      return controls(url)??page([{amount:{value:2,currency:'eur'}}])
    })
    const f=fixture(request);await f.service.configure('sk-admin-test-credential','')
    const billing=(await f.service.snapshot({...query,refresh:true})).organization!.billing!
    expect(billing.scopes[0].cost).toBeUndefined();expect(billing.scopes[0].limit).toBeUndefined()
    expect(remainingAllowance(billing.scopes[0],billing.start)).toBeNull()
  })
})
