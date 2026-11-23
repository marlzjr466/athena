import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyAIStatus } from '../shared/ai'
import { emptyChatSnapshot } from '../shared/chat'
import { defaultSettings } from '../shared/settings'
import { useAthena } from '../src/store/athenaStore'
import type { Snapshot } from '../shared/contracts'
const api = vi.hoisted(() => ({ getAIStatus: vi.fn(), getOpenAIAccountStatus: vi.fn(), getUnifiedAccounts: vi.fn(), testAIConnection: vi.fn(), activateAI: vi.fn(), selectAIModel: vi.fn(), removeAIKey: vi.fn(), getWebSearchStatus: vi.fn(), testWebSearch: vi.fn(), saveWebSearchKey: vi.fn(), removeWebSearchKey: vi.fn(), openExternalLink: vi.fn(), getSnapshot: vi.fn(), updateSettings: vi.fn(), getChat: vi.fn(), onChat: vi.fn(), getLocalStatus: vi.fn(), onLocalProgress: vi.fn(), getAcademy: vi.fn(), academyCommand: vi.fn(), antigravity: vi.fn() }))
vi.mock('../src/services/desktop', () => ({ desktop: { ...api, getCursorStatus: async () => ({ installed: false, authenticated: false, authenticationStatus: 'unknown', identity: null, version: null, message: 'Not checked.', models: [], modelCatalogAvailable: false }) }, isDesktop: true }))
import { AISettings } from '../src/features/settings/AISettings'
import { AntigravitySettings } from '../src/features/settings/AntigravitySettings'
import { WebToolsSettings } from '../src/features/settings/WebToolsSettings'
import { MyAthenaPage } from '../src/features/athena-ai/MyAthenaPage'
const active = { ...emptyAIStatus(), active: true, hasKey: true, models: ['model-a'], lastVerifiedAt: 1 }
beforeEach(() => { vi.resetAllMocks(); useAthena.setState({ snapshot: { settings: { ...defaultSettings }, state: 'idle' } as Snapshot }); api.getAIStatus.mockResolvedValue({ ok: true, status: emptyAIStatus(), message: '' }); api.getOpenAIAccountStatus.mockResolvedValue({ ok: true, status: emptyAIStatus(), message: '' }); api.getUnifiedAccounts.mockResolvedValue({ accounts: [], refreshedAt: Date.now() }); api.getWebSearchStatus.mockResolvedValue({ hasKey: false, provider: 'Brave Search API', active: false, model: null, availableModels: [], validated: false, strictOffline: false, note: '' }); api.testWebSearch.mockResolvedValue({ ok: false, message: 'No key.' }); api.saveWebSearchKey.mockResolvedValue({ ok: false, message: 'No key.' }); api.removeWebSearchKey.mockResolvedValue({ ok: true, message: '' }); api.getChat.mockResolvedValue(emptyChatSnapshot()); api.onChat.mockReturnValue(() => {}); api.getLocalStatus.mockResolvedValue({ connected: false, message: 'Unavailable', models: [], arch: 'arm64', totalMemoryBytes: 0, freeMemoryBytes: 0, whisperInstalled: false, macSpeechAvailable: false, macVoices: [] }); api.onLocalProgress.mockReturnValue(() => {}); api.getAcademy.mockResolvedValue({ profiles: [], sources: [], evaluations: [] }) })
describe('AI settings controls', () => {
  it('renders quota groups and refreshes them through the Antigravity usage action', async () => {
    const connected = { installed: true, version: '1.5.5', authState: 'authenticated', identity: null, models: [{ id: 'gemini-4-argon', name: 'Gemini 4 Argon' }], modelEfforts: {}, modelEffortDefaults: {}, modelCatalogAvailable: true, usageError: null, message: 'Connected.', usage: { fetchedAt: Date.now(), groups: [
      { id: 'gemini', name: 'Gemini Models', buckets: [{ id: 'weekly', name: 'Weekly Limit', window: 'weekly', remainingFraction: 0.8, resetAt: '2026-11-18T14:07:38Z' }] },
      { id: 'gemini-4-argon', name: 'Gemini 4 Argon', buckets: [{ id: 'argon', name: 'Weekly Limit', window: 'weekly', remainingFraction: 1, resetAt: null }] },
    ], creditsRemaining: 0, useG1Credits: false } }
    api.antigravity.mockResolvedValue(connected)
    render(<AntigravitySettings selectedModel="gemini-4-argon" />)
    expect(await screen.findByText('80% remaining')).toBeVisible()
    expect(api.antigravity).toHaveBeenCalledWith({ action: 'status' })
    expect(api.antigravity).not.toHaveBeenCalledWith({ action: 'usage' })
    expect(screen.getByRole('heading', { name: 'Gemini 4 Argon' })).toBeVisible()
    expect(screen.getByText('AI credit balance')).toBeVisible()
    expect(screen.getByText(/Overages: Never/)).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Usage' }))
    await waitFor(() => expect(api.antigravity).toHaveBeenCalledWith({ action: 'usage' }))
  })
  it.each(['copilot', 'antigravity'] as const)('does not run the generic provider check when %s settings mount', async (aiMode) => {
    useAthena.setState({ snapshot: { settings: { ...defaultSettings, aiMode }, state: 'idle' } as Snapshot })
    render(<AISettings />)
    await waitFor(() => expect(api.getChat).toHaveBeenCalled())
    expect(api.getAIStatus).not.toHaveBeenCalled()
  })
  it('mounts local setup before settings arrive and discovers compatible models without changing online AI', async () => {
    useAthena.setState({ snapshot: null })
    api.getLocalStatus.mockResolvedValue({ connected: true, message: 'Ollama ready', models: [
      { name: 'qwen2.5:3b', capabilities: ['completion', 'tools'], size: 1000, family: 'qwen2', contextLength: 32768 },
      { name: 'nomic-embed-text:latest', capabilities: ['embedding'], size: 1000 },
    ], macVoices: [], totalMemoryBytes: 24 * 1024 ** 3 })
    render(<MyAthenaPage tab="local" />)
    act(() => useAthena.setState({ snapshot: { settings: { ...defaultSettings, aiMode: 'subscription' }, state: 'idle' } as Snapshot }))
    expect(await screen.findByText('Chat ready')).toBeInTheDocument()
    expect(screen.getByText('No chat completion')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('combobox', { name: 'Active companion model' }))
    expect(screen.getByRole('option', { name: 'nomic-embed-text:latest · Ollama · no chat support' })).toBeDisabled()
    expect(useAthena.getState().snapshot?.settings.aiMode).toBe('subscription')
  })
  it('does not present the local offline preference as blocking online search', async () => {
    useAthena.setState({ snapshot: { settings: { ...defaultSettings, strictOffline: true, webAccess: { ...defaultSettings.webAccess, searchProvider: 'openai-built-in' } }, state: 'idle' } as Snapshot })
    api.getWebSearchStatus.mockResolvedValue({ hasKey: true, provider: 'OpenAI built-in web search', active: true, model: 'gpt-5.5', validated: true, strictOffline: false, note: 'Online search verified.' })
    render(<AISettings />)
    expect(await screen.findByText('● Search verified')).toBeInTheDocument()
    expect(screen.queryByText(/all public web requests are blocked before networking/i)).not.toBeInTheDocument()
  })
  it('selects a local companion model without changing the online provider', async () => {
    api.getLocalStatus.mockResolvedValue({ connected: true, models: [{ name: 'qwen2.5:3b', capabilities: ['completion'], size: 1000 }], macVoices: [], totalMemoryBytes: 24 * 1024 ** 3 })
    api.updateSettings.mockResolvedValue({ settings: { ...defaultSettings, localAI: { ...defaultSettings.localAI, model: 'qwen2.5:3b' } }, state: 'idle' })
    render(<MyAthenaPage tab="local" />)
    expect(screen.queryByRole('group', { name: 'AI execution mode' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('combobox', { name: 'Active companion model' }))
    fireEvent.click(await screen.findByRole('option', { name: 'qwen2.5:3b · Ollama' }))
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledWith({ localAI: { ...defaultSettings.localAI, model: 'qwen2.5:3b' } }))
    expect(screen.queryByRole('tablist', { name: 'My Athena sections' })).not.toBeInTheDocument()
  })
  it('offers account management without changing the global provider', async () => {
    render(<AISettings />)
    expect(await screen.findByRole('heading', { name: 'Connected Accounts' })).toBeInTheDocument()
    expect(screen.queryByRole('group', { name: 'AI execution mode' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Add Account' }))
    expect(screen.getByRole('group', { name: 'Add AI account' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Local models' })).not.toBeInTheDocument()
    expect(screen.queryByRole('combobox', { name: 'Active companion model' })).not.toBeInTheDocument()
    expect(screen.queryByRole('combobox', { name: 'Model' })).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Automatic Continuation & Context Management' })).toBeInTheDocument()
  })
  it('shows an independent accessible switch for connected accounts and persists its preference', async () => {
    const account = { route: { provider: 'cloud' as const, accountId: 'openai-api' }, name: 'OpenAI API', enabled: true, state: 'connected' as const, lastVerifiedAt: Date.parse('2026-11-23T00:00:00Z'), models: [{ id: 'gpt-6.1-pro', label: 'gpt-6.1-pro', available: true }, { id: 'gpt-4.1', label: 'gpt-4.1', available: false }] }
    api.getUnifiedAccounts.mockResolvedValue({ accounts: [account], refreshedAt: Date.now() })
    api.updateSettings.mockImplementation(async (patch: Record<string, unknown>) => ({ settings: { ...defaultSettings, ...patch }, state: 'idle' }))
    render(<AISettings />)
    // The account catalog is intentionally cached across Settings mounts.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh accounts and models' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Refresh accounts and models' }))
    const toggle = await screen.findByRole('switch', { name: 'Enable OpenAI API' })
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByText(/1 GPT model available · Verified/)).toBeVisible()
    fireEvent.click(toggle)
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledWith({ unifiedAccountEnabled: { [JSON.stringify(['cloud', 'openai-api'])]: false } }))
    expect(screen.getByText('connected')).toBeVisible()
  })
  it('renders Academy without in-page section tabs or unsupported feature claims', () => {
    render(<MyAthenaPage tab="academy" />)
    expect(screen.getByRole('heading', { name: 'Athena Academy' })).toBeVisible()
    expect(screen.queryByRole('tablist', { name: 'My Athena sections' })).not.toBeInTheDocument()
    expect(screen.queryByRole('group', { name: 'AI execution mode' })).not.toBeInTheDocument()
  })
  it('opens account configuration without changing the global provider', async () => {
    render(<AISettings />)
    fireEvent.click(screen.getByRole('button', { name: 'Add Account' }))
    fireEvent.click(screen.getByRole('button', { name: /Cursor Subscription/ }))
    expect(await screen.findByRole('heading', { name: 'Cursor Subscription · Cursor CLI' })).toBeVisible()
    expect(api.updateSettings).not.toHaveBeenCalledWith({ aiMode: 'cursor' })
  })
  it('does not render the removed Cursor capabilities panel', async () => {
    useAthena.setState({ snapshot: { settings: { ...defaultSettings, aiMode: 'cursor' }, state: 'idle' } as Snapshot })
    api.getAIStatus.mockResolvedValue({ ok: true, status: { ...emptyAIStatus(), provider: 'Cursor Subscription', active: true, models: ['cursor-grok-4.6-medium'], modelCapabilities: { 'cursor-grok-4.6-medium': ['text-input', 'tool-calling'] } }, message: '' })
    render(<AISettings />)
    fireEvent.click(screen.getByRole('button', { name: 'Add Account' }))
    fireEvent.click(screen.getByRole('button', { name: /Cursor Subscription/ }))
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Cursor Subscription · Cursor CLI' })).toBeInTheDocument())
    expect(screen.queryByText('Verified Cursor capabilities')).not.toBeInTheDocument()
    expect(screen.queryByText('Tools supported')).not.toBeInTheDocument()
  })
  it('keeps OpenAI Responses search selectable outside Cloud mode and presents a real search test', async () => {
    useAthena.setState({ snapshot: { settings: { ...defaultSettings, aiMode: 'local', webAccess: { ...defaultSettings.webAccess, searchProvider: 'openai-built-in' } }, state: 'idle' } as Snapshot })
    api.getWebSearchStatus.mockResolvedValue({ hasKey: true, provider: 'OpenAI built-in web search', active: false, model: 'gpt-5.5', availableModels: ['gpt-5.5'], validated: false, strictOffline: false, note: 'Search is independent of the active chat provider.' })
    api.testWebSearch.mockResolvedValue({ ok: true, message: 'Live search completed.', model: 'gpt-5.5', resultCount: 1 })
    render(<AISettings />)
    const testButton = await screen.findByRole('button', { name: 'Test Search Connection' })
    expect(testButton).toBeEnabled()
    expect(screen.getByLabelText('Web search provider')).toHaveTextContent('OpenAI Responses web search')
    expect(screen.queryByLabelText('Brave Search API key')).toBeNull()
    expect(screen.getByText('gpt-5.5')).toBeVisible()
    fireEvent.click(testButton)
    expect(await screen.findByText(/Live search completed/)).toBeVisible()
    expect(api.testWebSearch).toHaveBeenCalledWith({ model: 'gpt-5.5' })
  })
  it('shows the separate automation permission categories in AI settings', async () => {
    render(<AISettings />)
    expect(await screen.findByRole('heading', { name: 'Automation permissions' })).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: 'Public internet access' })).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByRole('switch', { name: 'External message submission' })).toHaveAttribute('aria-checked', 'false')
  })
  it('lets a subscription user select a separate API search model when the key has no conversation model', async () => {
    const settings = { ...defaultSettings, aiMode: 'subscription' as const, webAccess: { ...defaultSettings.webAccess, webSearchEnabled: true, searchProvider: 'openai-built-in' as const } }
    useAthena.setState({ snapshot: { settings, state: 'idle' } as Snapshot })
    api.getWebSearchStatus.mockResolvedValue({ hasKey: true, provider: 'OpenAI built-in web search', active: false, model: null, availableModels: ['gpt-5.5', 'gpt-4.1-mini'], validated: false, strictOffline: false, note: 'Choose a search model.' })
    api.updateSettings.mockImplementation(async ({ webAccess }: { webAccess: typeof settings.webAccess }) => ({ settings: { ...settings, webAccess }, state: 'idle' }))
    api.testWebSearch.mockResolvedValue({ ok: true, message: 'Live search completed.', model: 'gpt-4.1-mini', resultCount: 1 })
    render(<WebToolsSettings />)
    const selector = await screen.findByRole('combobox', { name: 'OpenAI search model' })
    fireEvent.click(selector)
    fireEvent.click(screen.getByRole('option', { name: 'gpt-4.1-mini' }))
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledWith({ webAccess: expect.objectContaining({ openAIModel: 'gpt-4.1-mini' }) }))
    fireEvent.click(screen.getByRole('button', { name: 'Test Search Connection' }))
    await waitFor(() => expect(api.testWebSearch).toHaveBeenCalledWith({ model: 'gpt-4.1-mini' }))
    expect(useAthena.getState().snapshot?.settings.aiMode).toBe('subscription')
  })
  it('uses a password field, shows testing and never activates on test alone', async () => {
    render(<AISettings />)
    const input = await screen.findByLabelText('API Key')
    await waitFor(() => expect(input).toBeEnabled())
    expect(input).toHaveAttribute('type', 'password')
    fireEvent.change(input, { target: { value: 'sk-test-only-not-a-real-api-key' } })
    let finish!: (value: unknown) => void
    api.testAIConnection.mockReturnValue(new Promise((resolve) => { finish = resolve }))
    fireEvent.click(screen.getByRole('button', { name: 'Test Connection' }))
    expect(await screen.findByText('Testing…')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Save & Activate' })).toBeDisabled()
    finish({ ok: true, status: emptyAIStatus(), message: 'Connection successful.' })
    expect(await screen.findByText('Connection successful.')).toBeVisible()
    expect(api.activateAI).not.toHaveBeenCalled()
  })
  it('clears the draft after activation and shows only a fixed mask', async () => {
    api.activateAI.mockResolvedValue({ ok: true, status: active, message: 'Connection successful.' })
    render(<AISettings />)
    const input = await screen.findByLabelText('API Key')
    await waitFor(() => expect(input).toBeEnabled())
    fireEvent.change(input, { target: { value: 'sk-test-only-not-a-real-api-key' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save & Activate' }))
    expect(await screen.findByLabelText('Saved API key, masked')).toHaveTextContent('sk-••••••••••••••')
    expect(screen.queryByLabelText('API Key')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Replace API Key' }))
    expect(screen.getByLabelText(/API Key/)).toHaveValue('')
  })
  it('tests stored credentials without returning them and requires removal confirmation', async () => {
    api.getOpenAIAccountStatus.mockResolvedValue({ ok: true, status: active, message: '' })
    api.testAIConnection.mockResolvedValue({ ok: true, status: active, message: 'Connection successful.' })
    api.removeAIKey.mockResolvedValue({ ok: true, status: emptyAIStatus(), message: 'Removed.' })
    render(<AISettings />)
    await screen.findByLabelText('Saved API key, masked')
    fireEvent.click(screen.getByRole('button', { name: 'Test Connection' }))
    await screen.findByText('Connection successful.')
    expect(api.testAIConnection).toHaveBeenCalledWith(undefined)
    fireEvent.click(screen.getByRole('button', { name: 'Remove API Key' }))
    expect(api.removeAIKey).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Confirm removal' }))
    await screen.findByText('Removed.')
    expect(screen.getByLabelText('API Key')).toHaveValue('')
  })
})
