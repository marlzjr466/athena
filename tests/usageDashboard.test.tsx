import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ChatMessage } from '../shared/chat'
import type { UsageDashboardData } from '../shared/usage'
import { UsageDashboard } from '../src/features/settings/UsageDashboard'
import { observedConversationUsage } from '../src/features/settings/observedUsage'

describe('unified usage dashboard', () => {
  it('renders provider quota cards, local metrics, refresh, and official link together', () => {
    const refresh = vi.fn()
    const data: UsageDashboardData = {
      provider: 'GitHub Copilot Subscription', account: 'octocat', usageType: 'Subscription quota',
      availability: 'available', source: 'official SDK', refreshedAt: 1,
      quotaGroups: [{ id: 'account', label: 'Account quotas', quotas: [{ id: 'premium', label: 'Premium requests', remainingPercentage: 70, usedLabel: '90 / 300 used', resetAt: null }] }],
      metrics: [{ id: 'responses', label: 'Responses in this conversation', value: 2, unit: 'count' }],
      officialUrl: 'https://github.com/settings/copilot', officialLabel: 'Open GitHub Copilot settings',
    }
    render(<UsageDashboard data={data} onRefresh={refresh} />)
    expect(screen.getByText('70% remaining')).toBeInTheDocument()
    expect(screen.getByText('90 / 300 used')).toBeInTheDocument()
    expect(screen.getByText('2')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Usage' }))
    expect(refresh).toHaveBeenCalledOnce()
    expect(screen.getByRole('link', { name: 'Open GitHub Copilot settings' })).toHaveAttribute('href', 'https://github.com/settings/copilot')
  })

  it('keeps unavailable quotas empty instead of inventing progress', () => {
    render(<UsageDashboard data={{ provider: 'ChatGPT Subscription', account: 'connected account', usageType: 'Subscription allowance', availability: 'unavailable', source: 'No supported quota feed' }} />)
    expect(screen.getByText(/No usage metrics are available/)).toBeInTheDocument()
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
  })

  it('disables duplicate refreshes and preserves metrics when a refresh fails', async () => {
    const refresh = vi.fn().mockResolvedValue(false)
    render(<UsageDashboard data={{ provider: 'OpenAI API', account: 'API account', usageType: 'Local response metrics', availability: 'partial', source: 'Persisted response metadata', metrics: [{ id: 'tokens', label: 'Input tokens', value: 24, unit: 'tokens' }] }} onRefresh={refresh} />)
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Usage' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Usage refresh failed.'))
    expect(screen.getByText('24 tokens')).toBeVisible()
    expect(refresh).toHaveBeenCalledOnce()
  })
})

describe('conversation usage attribution', () => {
  const message = (providerId: string, accountId: string, inputTokens: number): ChatMessage => ({
    id: `${providerId}-${accountId}-${inputTokens}`, role: 'assistant', content: '', status: 'complete', createdAt: 1,
    execution: { startedAt: 1, updatedAt: 2, status: 'complete', providerId, accountId, modelId: 'model-a', activities: [], providerUsage: { inputTokens, outputTokens: 10, requestCount: 1, estimated: false, updatedAt: 2 } },
  })

  it('keeps provider and account totals separate and retains unresolved request counts', () => {
    const messages = [message('chatgpt-subscription', 'account-a', 12), message('chatgpt-subscription', 'account-b', 80), message('openai-api', 'api-key', 40)]
    messages[0].execution!.providerUsage!.incompleteRequests = 1
    const usage = observedConversationUsage(messages, ['chatgpt-subscription'], 'account-a')
    expect(usage.metrics).toContainEqual(expect.objectContaining({ id: 'input-tokens', value: 12 }))
    expect(usage.metrics).toContainEqual(expect.objectContaining({ id: 'unresolved-requests', value: 1 }))
    expect(usage.metrics).not.toContainEqual(expect.objectContaining({ value: 80 }))
    expect(usage.metrics).not.toContainEqual(expect.objectContaining({ value: 40 }))
  })
})
