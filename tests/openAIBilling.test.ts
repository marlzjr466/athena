import { describe, expect, it } from 'vitest'
import { billingPresentation, remainingAllowance, type BillingScope } from '../shared/openAIBilling'
const start=Date.UTC(2026,10,1),end=Date.UTC(2026,10,23)
const scope=():BillingScope=>({id:'organization',label:'Organization',errors:{},cost:{usd:25,start,end,refreshedAt:end,sampleId:'snapshot'},limit:{thresholdAmount:10000,currency:'USD',interval:'month',enforcement:'enforcing',refreshedAt:end,sampleId:'snapshot'}})
describe('remaining monthly spending allowance',()=>{
  it('uses authoritative cents and USD costs without confusing them with credits',()=>{
    const s=scope(),view=billingPresentation({start,end,scopes:[s]})
    expect(remainingAllowance(s,start)).toEqual({total:100,remaining:75,percentage:75})
    expect(view.quotaGroups?.[0].quotas[0]).toEqual(expect.objectContaining({label:'Remaining monthly spending allowance',remainingPercentage:75,usedLabel:'$75.00 of $100.00'}))
    expect(view.metrics?.some(m=>m.label.includes('credits'))).toBe(false)
  })
  it.each(['inactive','unknown'])('never interprets %s enforcement as a hard cap',enforcement=>{
    const s=scope();s.limit!.enforcement=enforcement;expect(remainingAllowance(s,start)).toBeNull()
  })
  it('does not combine currencies, reporting periods, or refresh attempts',()=>{
    const currency=scope();currency.limit!.currency='EUR'
    const period=scope();period.cost!.start=Date.UTC(2026,9,1)
    const attempt=scope();attempt.limit!.sampleId='previous'
    for(const s of [currency,period,attempt])expect(remainingAllowance(s,start)).toBeNull()
  })
  it('never invents 100 percent for a zero cap, missing cost or missing limit',()=>{
    const zero=scope();zero.limit!.thresholdAmount=0
    const missingCost=scope();delete missingCost.cost
    const missingLimit=scope();delete missingLimit.limit
    expect(remainingAllowance(zero,start)).toEqual({total:0,remaining:0,percentage:null})
    for(const s of [missingCost,missingLimit])expect(remainingAllowance(s,start)).toBeNull()
  })
  it('clamps exhausted allowance without hiding reported overspend',()=>{
    const s=scope();s.cost!.usd=105
    expect(remainingAllowance(s,start)?.remaining).toBe(0)
    expect(billingPresentation({start,end,scopes:[s]}).metrics?.find(m=>m.id.endsWith(':cost'))?.value).toBe(105)
  })
})
