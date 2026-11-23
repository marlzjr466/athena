import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { UnifiedModelSelect } from '../src/features/chat/UnifiedModelSelect'
import type { UnifiedAccountCatalog } from '../shared/unifiedAccounts'

const catalog: UnifiedAccountCatalog = { refreshedAt: 1, accounts: [
  { route: { provider: 'subscription', accountId: 'chatgpt-one' }, name: 'ChatGPT', plan: 'Plus', enabled: true, state: 'connected', models: [{ id: 'shared-model', label: 'Claude Shared', available: true }, { id: 'gpt-model', label: 'GPT Model', available: true }] },
  { route: { provider: 'third-party', accountId: 'gateway-one' }, name: 'My OpenRouter', enabled: true, state: 'connected', models: [{ id: 'shared-model', label: 'Claude Shared', available: true }] },
  { route: { provider: 'third-party', accountId: 'gateway-two' }, name: 'My Local Gateway', enabled: true, state: 'unavailable', models: [{ id: 'qwen', label: 'Qwen', available: false }] },
] }

describe('unified model selector', () => {
  it('keeps identical model IDs distinct by account and filters local catalog by account name', () => {
    const choose = vi.fn()
    render(<UnifiedModelSelect catalog={catalog} onChange={choose} />)
    fireEvent.click(screen.getByRole('button', { name: 'Conversation model' }))
    expect(screen.getAllByRole('option', { name: 'Claude Shared' })).toHaveLength(2)
    expect(screen.getByText('ChatGPT (Plus)')).toBeVisible()
    fireEvent.change(screen.getByRole('textbox', { name: 'Search models' }), { target: { value: 'openrouter' } })
    expect(screen.getAllByRole('option', { name: 'Claude Shared' })).toHaveLength(1)
    expect(screen.queryByText('ChatGPT (Plus)')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('option', { name: 'Claude Shared' }))
    expect(choose).toHaveBeenCalledWith({ provider: 'third-party', accountId: 'gateway-one', model: 'shared-model' })
  })
  it('supports keyboard selection, Escape, disabled models, and an empty search state', () => {
    const choose = vi.fn()
    render(<UnifiedModelSelect catalog={catalog} onChange={choose} />)
    fireEvent.click(screen.getByRole('button', { name: 'Conversation model' }))
    const search = screen.getByRole('textbox', { name: 'Search models' })
    expect(search).toHaveFocus()
    fireEvent.change(search, { target: { value: 'qwen' } })
    expect(screen.getByRole('option', { name: /Qwen/ })).toBeDisabled()
    fireEvent.change(search, { target: { value: 'does-not-exist' } })
    expect(screen.getByText('No models match your search.')).toBeVisible()
    fireEvent.change(search, { target: { value: 'gpt-model' } })
    fireEvent.keyDown(search, { key: 'Enter' })
    expect(choose).toHaveBeenCalledWith({ provider: 'subscription', accountId: 'chatgpt-one', model: 'gpt-model' })
    fireEvent.click(screen.getByRole('button', { name: 'Conversation model' }))
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Search models' }), { key: 'Escape' })
    expect(screen.queryByRole('textbox', { name: 'Search models' })).not.toBeInTheDocument()
  })
  it('omits disabled accounts from provider groups and search without affecting other profiles', () => {
    const choose = vi.fn()
    const disabled = { ...catalog, accounts: catalog.accounts.map(account => account.route.accountId === 'gateway-one' ? { ...account, enabled: false } : account) }
    render(<UnifiedModelSelect catalog={disabled} onChange={choose} />)
    fireEvent.click(screen.getByRole('button', { name: 'Conversation model' }))
    expect(screen.queryByText('My OpenRouter')).not.toBeInTheDocument()
    expect(screen.getByText('My Local Gateway')).toBeVisible()
    fireEvent.change(screen.getByRole('textbox', { name: 'Search models' }), { target: { value: 'openrouter' } })
    expect(screen.getByText('No models match your search.')).toBeVisible()
  })
})
