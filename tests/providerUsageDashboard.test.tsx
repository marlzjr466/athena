import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { aggregateUsage, type ProviderUsageResult, type UsageRecord } from '../shared/providerUsage'
const api=vi.hoisted(()=>({getProviderUsage:vi.fn(),configureOpenAIUsage:vi.fn(),removeOpenAIUsage:vi.fn()}))
vi.mock('../src/services/desktop',()=>({desktop:api}))
import { ProviderUsageDashboard } from '../src/features/settings/ProviderUsageDashboard'
function data(accountId='a',count=100):ProviderUsageResult {
  const record:UsageRecord={id:'r',provider:'chatgpt-subscription',accountId,model:'gpt-fixture',conversationId:'other-conversation',executionId:'e',responseId:'response',timestamp:Date.now(),updatedAt:Date.now(),inputTokens:count,cachedInputTokens:20,outputTokens:10,reasoningTokens:3,totalTokens:count+10,requestCount:1,status:'completed',source:'openai-response'}
  return {local:aggregateUsage(count?[record]:[],{provider:'chatgpt-subscription',accountId,period:'month'}),adminConfigured:false}
}
beforeEach(()=>{vi.resetAllMocks();api.getProviderUsage.mockResolvedValue(data())})
describe('account-wide usage dashboard',()=>{
  it('displays cross-conversation local usage without claiming subscription quota and only explicitly refreshes',async()=>{
    render(<ProviderUsageDashboard provider="chatgpt-subscription" account="Account A" accountId="a" connected />)
    expect(await screen.findByText('100 tokens')).toBeInTheDocument()
    expect(screen.getByText('Local usage available')).toBeInTheDocument()
    expect(screen.getByText(/Official subscription quota unavailable/)).toBeInTheDocument()
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
    expect(api.getProviderUsage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({refresh:false,accountId:'a'}))
    fireEvent.click(screen.getByRole('button',{name:'Refresh Usage'}))
    await waitFor(()=>expect(api.getProviderUsage).toHaveBeenCalledTimes(2))
    expect(api.getProviderUsage.mock.calls[1][0].refresh).toBe(true)
  })
  it('shows No usage recorded for a connected unused account',async()=>{
    api.getProviderUsage.mockResolvedValue(data('unused',0))
    render(<ProviderUsageDashboard provider="chatgpt-subscription" account="Unused" accountId="unused" connected />)
    await waitFor(()=>expect(screen.getByText('No usage recorded')).toBeInTheDocument())
    expect(screen.queryByText('Unavailable')).not.toBeInTheDocument()
  })
  it('keeps the cached receipt when manual refresh fails',async()=>{
    render(<ProviderUsageDashboard provider="chatgpt-subscription" account="A" accountId="a" connected />)
    await screen.findByText('100 tokens');api.getProviderUsage.mockRejectedValue(new Error('offline'))
    fireEvent.click(screen.getByRole('button',{name:'Refresh Usage'}))
    expect(await screen.findByRole('alert')).toHaveTextContent('Usage refresh failed')
    expect(screen.getByText('100 tokens')).toBeInTheDocument()
  })
  it('ignores a stale account response after switching accounts',async()=>{
    let resolve!:(value:ProviderUsageResult)=>void
    api.getProviderUsage.mockImplementationOnce(()=>new Promise(r=>{resolve=r})).mockResolvedValue(data('b',200))
    const view=render(<ProviderUsageDashboard provider="chatgpt-subscription" account="A" accountId="race-a" connected />)
    view.rerender(<ProviderUsageDashboard provider="chatgpt-subscription" account="B" accountId="b" connected />)
    await screen.findByText('200 tokens');resolve(data('race-a',999))
    await waitFor(()=>expect(screen.queryByText('999 tokens')).not.toBeInTheDocument())
  })
})

it('prioritizes official allowance availability above a separate local section without fake percentages',async()=>{
  render(<ProviderUsageDashboard provider="chatgpt-subscription" account="A" accountId="a" connected />)
  await screen.findByText('100 tokens')
  const headings=screen.getAllByRole('heading').map(h=>h.textContent)
  expect(headings.indexOf('ChatGPT Subscription · Plan allowance')).toBeLessThan(headings.indexOf('ChatGPT Subscription · Locally observed usage'))
  expect(screen.getByText('Five-hour limit remaining:')).toBeInTheDocument()
  expect(screen.getByText('Weekly and app-specific limits:')).toBeInTheDocument()
  expect(screen.getByRole('link',{name:'Open ChatGPT Usage'})).toHaveAttribute('href','https://chatgpt.com/settings/usage')
  expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
})
it('shows the exact prepaid fallback and separates local-only refresh from authorized billing refresh',async()=>{
  render(<ProviderUsageDashboard provider="openai-api" account="API" accountId="api-ui" connected />)
  await screen.findByText('100 tokens')
  expect(screen.getByText('Prepaid credit balance:').parentElement).toHaveTextContent('Prepaid credit balance: View in OpenAI Billing.')
  expect(screen.getByRole('link',{name:'Open OpenAI Billing'})).toHaveAttribute('href','https://platform.openai.com/settings/organization/billing/overview')
  expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button',{name:'Refresh Local Usage'}))
  await waitFor(()=>expect(api.getProviderUsage).toHaveBeenCalledTimes(2))
  expect(api.getProviderUsage.mock.calls[1][0].refresh).toBe(false)
  await waitFor(()=>expect(screen.getByRole('button',{name:'Refresh Usage'})).toBeEnabled())
  fireEvent.click(screen.getByRole('button',{name:'Refresh Usage'}))
  await waitFor(()=>expect(api.getProviderUsage).toHaveBeenCalledTimes(3))
  expect(api.getProviderUsage.mock.calls[2][0].refresh).toBe(true)
})
it('renders authoritative spending allowance with existing progress styling and keeps token totals separate',async()=>{
  const now=Date.now(),start=new Date(now);start.setUTCDate(1);start.setUTCHours(0,0,0,0)
  api.getProviderUsage.mockResolvedValue({...data(),adminConfigured:true,organization:{scope:'Authorized organization',start:start.getTime(),end:now,refreshedAt:now,metrics:[],billing:{start:start.getTime(),end:now,scopes:[{id:'org',label:'Organization',errors:{},cost:{usd:25,start:start.getTime(),end:now,refreshedAt:now,sampleId:'one'},limit:{thresholdAmount:10000,currency:'USD',interval:'month',enforcement:'enforcing',refreshedAt:now,sampleId:'one'}}]}}})
  render(<ProviderUsageDashboard provider="openai-api" account="API" accountId="api-budget" connected />)
  expect(await screen.findByRole('progressbar')).toHaveAttribute('aria-valuenow','75')
  expect(screen.getByText('Remaining monthly spending allowance')).toBeInTheDocument()
  expect(screen.getByText('100 tokens')).toBeInTheDocument()
  expect(screen.queryByText('Remaining API credits')).not.toBeInTheDocument()
  expect(screen.queryByText(/Resets /)).not.toBeInTheDocument()
})
