import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyAIStatus } from '../shared/ai'
import type { ModelCapability } from '../shared/modelCapabilities'
import { emptyChatSnapshot } from '../shared/chat'
import { defaultSettings } from '../shared/settings'
import { useChat } from '../src/store/chatStore'
import { useAthena } from '../src/store/athenaStore'

const api = vi.hoisted(() => ({ chatSession: vi.fn(), getLocalStatus: vi.fn(), updateSettings: vi.fn() }))
vi.mock('../src/services/desktop', () => ({ desktop: api }))

import { ConversationControls } from '../src/features/chat/ConversationControls'
import { parseCursorConfigurationCatalog } from '../shared/cursor'

describe('Cursor conversation model controls', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    api.chatSession.mockResolvedValue({ ok: true })
    api.getLocalStatus.mockResolvedValue({ connected: true, models: [{ name: 'qwen-coder:7b' }, { name: 'gpt-oss:20b' }] })
    useAthena.setState({ snapshot: null })
    useChat.setState({
      snapshot: { ...emptyChatSnapshot(), phase: 'idle', sessionId: '11111111-1111-4111-8111-111111111111', config: { provider: 'OpenAI', model: 'auto', effort: 'auto' } },
      pending: false, issue: null,
    })
  })

  it('groups all Cursor models, supports mouse and keyboard selection, and hides unsupported reasoning controls', async () => {
    const status = { ...emptyAIStatus(), provider: 'Cursor Subscription' as const, active: true, model: 'auto', modelCatalogAvailable: true, models: ['auto', 'grok-4.7-high', 'kimi-k2', 'claude-opus-5'], modelLabels: { auto: 'Auto', 'grok-4.7-high': 'Grok 4.7 High', 'kimi-k2': 'Kimi K2', 'claude-opus-5': 'Claude Opus 5' }, modelFamilies: { auto: 'Auto', 'grok-4.7-high': 'Grok', 'kimi-k2': 'Kimi', 'claude-opus-5': 'Claude' } }
    render(<ConversationControls config={status} />)

    expect(screen.getByLabelText('Conversation model')).toBeInTheDocument()
    expect(screen.getByLabelText('Conversation model')).toHaveTextContent('Previous default · select model')
    expect(screen.queryByLabelText('Reasoning effort')).not.toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('Conversation model'))
    expect(screen.queryByRole('option', { name: 'Auto' })).not.toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Claude Opus 5' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('option', { name: 'Kimi K2' }))
    await waitFor(() => expect(api.chatSession).toHaveBeenCalledWith({ action: 'configure-model', id: '11111111-1111-4111-8111-111111111111', model: 'kimi-k2' }))
    fireEvent.click(screen.getByLabelText('Conversation model'))
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search Cursor models' }), { target: { value: 'grok' } })
    fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'Enter' })
    await waitFor(() => expect(api.chatSession).toHaveBeenCalledWith({ action: 'configure-model', id: '11111111-1111-4111-8111-111111111111', model: 'grok-4.7-high' }))
  })

  it('offers only Cursor models with verified tool-calling support', async () => {
    const status = { ...emptyAIStatus(), provider: 'Cursor Subscription' as const, active: true, model: 'cursor-grok-4.6-medium', modelCatalogAvailable: true,
      models: ['auto', 'cursor-grok-4.6-medium', 'kimi-k2', 'claude-opus-5'],
      modelLabels: { auto: 'Auto', 'cursor-grok-4.6-medium': 'Grok 4.6 Medium', 'kimi-k2': 'Kimi K2', 'claude-opus-5': 'Claude Opus 5' },
      modelCapabilities: {
        'cursor-grok-4.6-medium': ['text-input', 'tool-calling'],
        'kimi-k2': ['text-input'],
        'claude-opus-5': ['text-input', 'file-input'],
      } as Record<string, ModelCapability[]> }
    render(<ConversationControls config={status} />)
    fireEvent.click(screen.getByLabelText('Conversation model'))
    expect(screen.getByRole('option', { name: 'Grok 4.6 · Medium' })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: 'Kimi K2' })).not.toBeInTheDocument()
    expect(screen.queryByRole('option', { name: 'Claude Opus 5' })).not.toBeInTheDocument()
    expect(screen.queryByRole('option', { name: 'Auto' })).not.toBeInTheDocument()
  })

  it('cannot change the floating local model from online conversation controls', () => {
    useAthena.setState({ snapshot: { settings: { ...defaultSettings, aiMode: 'local', localAI: { ...defaultSettings.localAI, model: null } }, state: 'idle' } as never })
    render(<ConversationControls config={emptyAIStatus()} />)
    expect(api.getLocalStatus).not.toHaveBeenCalled()
    fireEvent.click(screen.getByLabelText('Conversation model'))
    expect(screen.queryByRole('option', { name: 'gpt-oss:20b' })).not.toBeInTheDocument()
    expect(api.updateSettings).not.toHaveBeenCalled()
  })

  it('keeps Cursor model variants selectable without standalone effort or speed selectors', async () => {
    const id = '11111111-1111-4111-8111-111111111111'
    useChat.setState({ snapshot: { ...emptyChatSnapshot(), phase: 'idle', sessionId: id, config: { provider: 'OpenAI', model: 'cursor-grok-4.6-medium', cursorModel: 'cursor-grok-4.6-medium', effort: 'auto' } }, pending: false, issue: null })
    const status = { ...emptyAIStatus(), provider: 'Cursor Subscription' as const, active: true, model: 'cursor-grok-4.6-medium', modelCatalogAvailable: true,
      models: ['cursor-grok-4.6-medium', 'cursor-grok-4.6-medium-fast', 'cursor-grok-4.6-high', 'cursor-grok-4.6-high-fast'],
      modelLabels: { 'cursor-grok-4.6-medium': 'Grok 4.6 Medium', 'cursor-grok-4.6-medium-fast': 'Grok 4.6 Medium Fast', 'cursor-grok-4.6-high': 'Grok 4.6', 'cursor-grok-4.6-high-fast': 'Grok 4.6 Fast' },
      modelFamilies: { 'cursor-grok-4.6-medium': 'Grok', 'cursor-grok-4.6-medium-fast': 'Grok', 'cursor-grok-4.6-high': 'Grok', 'cursor-grok-4.6-high-fast': 'Grok' } }
    render(<ConversationControls config={status} />)
    expect(screen.getByLabelText('Conversation model')).toHaveTextContent('Grok 4.6 · Medium')
    expect(screen.queryByLabelText('Cursor reasoning effort')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Cursor Fast mode')).not.toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('Conversation model'))
    expect(screen.getByRole('option', { name: 'Grok 4.6 · High' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('option', { name: 'Grok 4.6 · High' }))
    await waitFor(() => expect(api.chatSession).toHaveBeenCalledWith({ action: 'configure-model', id, model: 'cursor-grok-4.6-high' }))
  })

  it('shows a model Edit panel with actual context, effort and Fast controls and saves the entire selection', async () => {
    const id = '11111111-1111-4111-8111-111111111111'
    const selected = 'grok-4.7[context=256k,reasoning_effort=medium,fast=false]'
    useChat.setState({ snapshot: { ...emptyChatSnapshot(), phase: 'idle', sessionId: id, config: { provider: 'OpenAI', model: selected, cursorModel: selected, effort: 'auto' } }, pending: false })
    const configurations = parseCursorConfigurationCatalog([{ value: 'grok-4.7', name: 'Grok 4.7', configOptions: [
      { id: 'context', name: 'Context', type: 'select', currentValue: '256k', options: [{ value: '256k', name: '256K' }, { value: '500k', name: '500K' }] },
      { id: 'reasoning_effort', name: 'Effort', category: 'thought_level', type: 'select', currentValue: 'high', options: [{ value: 'medium', name: 'Medium' }, { value: 'high', name: 'High' }] },
      { id: 'fast', name: 'Fast', type: 'select', currentValue: 'true', options: [{ value: 'false', name: 'Off' }, { value: 'true', name: 'On' }] },
    ] }])
    render(<ConversationControls config={{ ...emptyAIStatus(), provider: 'Cursor Subscription', active: true, models: ['grok-4.7-medium'], cursorModelConfigurations: configurations }} />)
    expect(screen.getByLabelText('Conversation model')).toHaveTextContent('Grok 4.7 Medium')
    expect(screen.queryByLabelText('Cursor Fast mode')).not.toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('Conversation model'))
    fireEvent.click(screen.getByLabelText('Edit Grok 4.7 Medium settings'))
    expect(screen.getByRole('button', { name: '256K' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('switch', { name: 'Cursor Fast mode' })).toHaveAttribute('aria-checked', 'false')
    expect(screen.queryByRole('button', { name: '1M' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '500K' }))
    await waitFor(() => expect(api.chatSession).toHaveBeenLastCalledWith({ action: 'configure-model', id, model: 'grok-4.7[context=500k,reasoning_effort=medium,fast=false]' }))
    fireEvent.click(screen.getByRole('button', { name: 'High' }))
    await waitFor(() => expect(api.chatSession).toHaveBeenLastCalledWith({ action: 'configure-model', id, model: 'grok-4.7[context=256k,reasoning_effort=high,fast=false]' }))
    fireEvent.click(screen.getByRole('switch', { name: 'Cursor Fast mode' }))
    await waitFor(() => expect(api.chatSession).toHaveBeenLastCalledWith({ action: 'configure-model', id, model: 'grok-4.7[context=256k,reasoning_effort=medium,fast=true]' }))
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('lists supported effort variants as directly selectable model rows', async () => {
    const id = '11111111-1111-4111-8111-111111111111'
    const configurations = parseCursorConfigurationCatalog([{ value: 'grok-4.6', name: 'Grok 4.6', configOptions: [
      { id: 'effort', name: 'Effort', category: 'thought_level', type: 'select', currentValue: 'high', options: [{ value: 'medium', name: 'Medium' }, { value: 'high', name: 'High' }] },
      { id: 'fast', name: 'Fast', type: 'select', currentValue: 'true', options: [{ value: 'false', name: 'Off' }, { value: 'true', name: 'Fast' }] },
    ] }])
    useChat.setState({ snapshot: { ...emptyChatSnapshot(), phase: 'idle', sessionId: id, config: { provider: 'OpenAI', model: 'grok-4.6[effort=high,fast=false]', cursorModel: 'grok-4.6[effort=high,fast=false]', effort: 'auto' } }, pending: false })
    render(<ConversationControls config={{ ...emptyAIStatus(), provider: 'Cursor Subscription', active: true, models: ['cursor-grok-4.6-high'], cursorModelConfigurations: configurations }} />)

    fireEvent.click(screen.getByLabelText('Conversation model'))
    expect(screen.getByRole('option', { name: 'Grok 4.6 Medium' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Grok 4.6 High' })).toHaveAttribute('aria-selected', 'true')
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search Cursor models' }), { target: { value: 'medium' } })
    expect(screen.getByRole('option', { name: 'Grok 4.6 Medium' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('option', { name: 'Grok 4.6 Medium' }))
    await waitFor(() => expect(api.chatSession).toHaveBeenCalledWith({ action: 'configure-model', id, model: 'grok-4.6[effort=medium,fast=false]' }))
  })

  it('disables Cursor model changes for running and queued conversations', () => {
    const id = '11111111-1111-4111-8111-111111111111'
    const config = { provider: 'OpenAI' as const, model: 'cursor-grok-4.6-medium', cursorModel: 'cursor-grok-4.6-medium', effort: 'auto' as const }
    const session = { id, title: 'Running task', createdAt: 1, updatedAt: 1, config, executionStatus: 'running' as const }
    useChat.setState({ snapshot: { ...emptyChatSnapshot(), phase: 'thinking', sessionId: id, config, sessions: [session] }, pending: false })
    const legacyStatus = { ...emptyAIStatus(), provider: 'Cursor Subscription' as const, active: true, model: config.model, models: [config.model], modelCatalogAvailable: true }
    const legacy = render(<ConversationControls config={legacyStatus} />)
    expect(screen.getByRole('combobox', { name: 'Conversation model' })).toBeDisabled()
    fireEvent.click(screen.getByRole('combobox', { name: 'Conversation model' }))
    expect(api.chatSession).not.toHaveBeenCalled()
    legacy.unmount()

    const configurations = parseCursorConfigurationCatalog([{ value: 'grok-4.6', name: 'Grok 4.6', configOptions: [
      { id: 'effort', name: 'Effort', category: 'thought_level', type: 'select', currentValue: 'medium', options: [{ value: 'medium', name: 'Medium' }] },
    ] }])
    useChat.setState({ snapshot: { ...emptyChatSnapshot(), phase: 'idle', sessionId: id, config, sessions: [{ ...session, executionStatus: 'queued' }] }, pending: false })
    render(<ConversationControls config={{ ...legacyStatus, cursorModelConfigurations: configurations }} />)
    expect(screen.getByRole('combobox', { name: 'Conversation model' })).toBeDisabled()
    fireEvent.click(screen.getByRole('combobox', { name: 'Conversation model' }))
    expect(api.chatSession).not.toHaveBeenCalled()
  })
})
