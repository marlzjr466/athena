import { beforeEach, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { emptyAIStatus } from '../shared/ai'
import { emptyChatSnapshot } from '../shared/chat'
import type { ReasoningEffort } from '../shared/conversations'
import type { UnifiedAccountCatalog } from '../shared/unifiedAccounts'
import { useChat } from '../src/store/chatStore'

vi.mock('../src/services/desktop', () => ({ desktop: { chatSession: vi.fn(async () => ({ ok: true })) } }))
import { ConversationControls } from '../src/features/chat/ConversationControls'

const sessionId = '11111111-1111-4111-8111-111111111111'
const providers = [
  ['subscription', 'ChatGPT', 'gpt-5.6-codex'],
  ['cloud', 'OpenAI API', 'gpt-5.6-sol'],
  ['claude-api', 'Claude API', 'claude-opus-4-6'],
  ['cursor', 'Cursor', 'reasoning-model'],
  ['copilot', 'GitHub Copilot', 'reasoning-model'],
  ['antigravity', 'Google Antigravity', 'reasoning-model'],
  ['third-party', 'Third-party gateway', 'reasoning-model'],
] as const

beforeEach(() => {
  useChat.setState({ snapshot: { ...emptyChatSnapshot(), phase: 'idle', sessionId, config: { provider: 'OpenAI', model: 'reasoning-model', effort: 'high', accountRoute: { provider: 'third-party', accountId: 'test-account' } } }, pending: false, issue: null })
})

it.each(providers)('uses the same composer reasoning selector for the %s account route', (provider, name, model) => {
  const route = { provider, accountId: 'test-account' }
  useChat.setState({ snapshot: { ...useChat.getState().snapshot, config: { provider: 'OpenAI', model, effort: 'high', accountRoute: route } } })
  const catalog: UnifiedAccountCatalog = { refreshedAt: 1, accounts: [{ route, name, enabled: true, state: 'connected', models: [{ id: model, label: 'Reasoning model', available: true, efforts: ['auto', 'low', 'high'] as ReasoningEffort[] }] }] }
  render(<ConversationControls config={{ ...emptyAIStatus(), active: true, models: [model] }} catalog={catalog} />)
  expect(screen.getByRole('combobox', { name: 'Reasoning effort' })).toHaveTextContent('High')
})

it('restores Claude effort choices from trusted model metadata when the unified catalog omitted them', () => {
  const route = { provider: 'claude-api' as const, accountId: 'claude-api' }
  useChat.setState({ snapshot: { ...useChat.getState().snapshot, config: { provider: 'OpenAI', model: 'claude-opus-4-6', effort: 'high', accountRoute: route } } })
  const catalog: UnifiedAccountCatalog = { refreshedAt: 1, accounts: [{ route, name: 'Claude API', enabled: true, state: 'connected', models: [{ id: 'claude-opus-4-6', label: 'Claude Opus 4.6', available: true }] }] }
  render(<ConversationControls config={{ ...emptyAIStatus(), active: true, models: ['claude-opus-4-6'] }} catalog={catalog} />)
  expect(screen.getByRole('combobox', { name: 'Reasoning effort' })).toHaveTextContent('High')
})

it('does not show selectable effort levels for an explicitly unsupported routed model', () => {
  const route = { provider: 'third-party' as const, accountId: 'plain-account' }
  useChat.setState({ snapshot: { ...useChat.getState().snapshot, config: { provider: 'OpenAI', model: 'plain-model', effort: 'auto', accountRoute: route } } })
  const catalog: UnifiedAccountCatalog = { refreshedAt: 1, accounts: [{ route, name: 'Plain gateway', enabled: true, state: 'connected', models: [{ id: 'plain-model', label: 'Plain model', available: true, efforts: [] }] }] }
  render(<ConversationControls config={{ ...emptyAIStatus(), active: true, models: ['plain-model'] }} catalog={catalog} />)
  expect(screen.queryByRole('combobox', { name: 'Reasoning effort' })).not.toBeInTheDocument()
})

it('keeps OpenAI API reasoning visible when Settings shows a different provider and the catalog loads later', () => {
  const route = { provider: 'cloud' as const, accountId: 'openai-api' }
  useChat.setState({ snapshot: { ...useChat.getState().snapshot, config: { provider: 'OpenAI', model: 'gpt-6.2-astra', effort: 'high', accountRoute: route } } })
  const status = { ...emptyAIStatus(), provider: 'Google Antigravity Subscription' as const, active: true, models: ['gemini-4-argon'], modelEfforts: { 'gemini-4-argon': ['auto', 'low'] as ReasoningEffort[] } }
  const view = render(<ConversationControls config={status} catalog={{ accounts: [], refreshedAt: 0 }} />)
  expect(screen.getByRole('combobox', { name: 'Reasoning effort' })).toHaveTextContent('High')
  const catalog: UnifiedAccountCatalog = { refreshedAt: 1, accounts: [{ route, name: 'OpenAI API', enabled: true, state: 'connected', models: [
    { id: 'gpt-6.2-astra', label: 'GPT-6.2 Astra', available: true, efforts: ['auto', 'low', 'medium', 'high', 'xhigh', 'max'] },
    { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', available: true, efforts: ['auto', 'none', 'low', 'medium', 'high', 'xhigh', 'max'] },
  ] }] }
  view.rerender(<ConversationControls config={status} catalog={catalog} />)
  const selector = screen.getByRole('combobox', { name: 'Reasoning effort' })
  expect(selector).toHaveTextContent('High')
  fireEvent.click(selector)
  expect(screen.getByRole('option', { name: 'Max' })).toBeInTheDocument()
  expect(screen.queryByRole('option', { name: 'None' })).not.toBeInTheDocument()
  fireEvent.click(selector)
  useChat.setState({ snapshot: { ...useChat.getState().snapshot, config: { provider: 'OpenAI', model: 'gpt-5.6-sol', effort: 'high', accountRoute: route } } })
  expect(screen.getByRole('combobox', { name: 'Reasoning effort' })).toHaveTextContent('High')
  fireEvent.click(screen.getByRole('combobox', { name: 'Reasoning effort' }))
  expect(screen.getByRole('option', { name: 'None' })).toBeInTheDocument()
})
