import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SubagentSettings } from '../src/features/settings/SubagentSettings'
import { useAthena } from '../src/store/athenaStore'
import { useChat } from '../src/store/chatStore'
import { defaultSettings } from '../shared/settings'
import { subagentSettingsSchema } from '../shared/subagents'
import type { Snapshot } from '../shared/contracts'
import type { UnifiedAccountCatalog } from '../shared/unifiedAccounts'
import { emptyChatSnapshot } from '../shared/chat'
const api = vi.hoisted(() => ({ getChat: vi.fn(), onChat: vi.fn(() => () => {}) }))
vi.mock('../src/services/desktop', () => ({ desktop: api }))
const catalog: UnifiedAccountCatalog = { refreshedAt: 1, accounts: [
  { route: { provider: 'subscription', accountId: 'account-a' }, name: 'Account A', enabled: true, state: 'connected', models: [{ id: 'shared-model', label: 'Reasoner', available: true, efforts: ['low', 'high'], contextLimits: { contextWindow: 1_050_000, maxOutputTokens: 128000, source: 'reported' } }] },
  { route: { provider: 'third-party', accountId: 'gateway-b' }, name: 'Gateway B', enabled: false, state: 'disconnected', models: [{ id: 'shared-model', label: 'Reasoner', available: false, efforts: ['none', 'max'], contextLimits: { contextWindow: 128000, source: 'configured' } }] },
] }
beforeEach(() => {
  useAthena.setState({ snapshot: { settings: structuredClone(defaultSettings) } as Snapshot, error: null, update: vi.fn(async patch => {
    const state = useAthena.getState(); useAthena.setState({ snapshot: { ...state.snapshot!, settings: { ...state.snapshot!.settings, ...patch } } })
  }) })
  useChat.setState({ snapshot: { ...emptyChatSnapshot(), phase: 'thinking' } })
  api.getChat.mockImplementation(async () => useChat.getState().snapshot)
})
function choose(label: string, option: string) { fireEvent.click(screen.getByRole('combobox', { name: label })); fireEvent.click(screen.getByRole('option', { name: option })) }
function save() { fireEvent.click(screen.getByRole('button', { name: 'Save sub-agent settings' })) }
describe('Unified Models sub-agent preferences', () => {
  it('loads the saved parent before Conversation has been opened and keeps newer snapshot revisions', async () => {
    api.getChat.mockResolvedValueOnce({ ...emptyChatSnapshot(), revision: 2, config: { model: 'shared-model', accountRoute: { provider: 'subscription', accountId: 'account-a' }, effort: 'high', provider: 'OpenAI' } })
    render(<SubagentSettings catalog={catalog}/> )
    await waitFor(() => expect(screen.getByText(/Default sub-agent model: shared-model.*Model context window: 1,050,000/)).toBeVisible())
    expect(screen.getByRole('combobox', { name: 'Default reasoning effort' })).toHaveTextContent('Inherit parent')
    expect(api.onChat).toHaveBeenCalled()
  })
  it('remains editable during active chat and with disconnected accounts, saving independent identities', async () => {
    render(<SubagentSettings catalog={catalog}/> )
    expect(screen.getByLabelText('Enable sub-agents')).toBeEnabled()
    choose('Default sub-agent model', 'Reasoner · Account A')
    choose('Default reasoning effort', 'High')
    choose('Cold-read model', 'Reasoner · Gateway B · unavailable at launch')
    choose('Cold-read reasoning effort', 'Max')
    fireEvent.change(screen.getByLabelText('Per-request context budget (tokens, including output)'), { target: { value: '512000' } })
    save(); await screen.findByText(/Sub-agent settings saved/)
    const saved = useAthena.getState().snapshot!.settings.subagents
    expect(saved).toMatchObject({ defaultSelection: { provider: 'subscription', accountId: 'account-a', model: 'shared-model' }, coldReadSelection: { provider: 'third-party', accountId: 'gateway-b', model: 'shared-model' }, defaultEffort: 'high', coldReadEffort: 'max', contextTokens: 512000 })
    expect(screen.getByText(/Default sub-agent model:.*Effective context budget: 512,000/)).toBeVisible()
    expect(screen.getByText(/Cold-read model:.*Effective context budget: 108,800/)).toBeVisible()
  })
  it('restores saved selections and custom budgets after remount and serialization', async () => {
    const view = render(<SubagentSettings catalog={catalog}/> )
    choose('Cold-read model', 'Reasoner · Account A'); choose('Cold-read reasoning effort', 'Low')
    fireEvent.change(screen.getByLabelText('Per-request context budget (tokens, including output)'), { target: { value: '256123' } })
    save(); await screen.findByText(/Sub-agent settings saved/)
    const saved = subagentSettingsSchema.parse(JSON.parse(JSON.stringify(useAthena.getState().snapshot!.settings.subagents)))
    view.unmount(); act(() => useAthena.setState({ snapshot: { settings: { ...defaultSettings, subagents: saved } } as Snapshot }))
    render(<SubagentSettings catalog={catalog}/> )
    expect(screen.getByRole('combobox', { name: 'Cold-read model' })).toHaveTextContent('Reasoner · Account A')
    expect(screen.getByRole('combobox', { name: 'Cold-read reasoning effort' })).toHaveTextContent('Low')
    expect(screen.getByLabelText('Per-request context budget (tokens, including output)')).toHaveValue(256123)
  })
  it('catalog refresh retains drafts, saved unavailable selections and legacy values', () => {
    act(() => useAthena.setState({ snapshot: { settings: { ...defaultSettings, subagents: { ...defaultSettings.subagents, defaultModel: 'legacy-model', defaultEffort: 'xhigh' } } } as Snapshot }))
    const view = render(<SubagentSettings catalog={catalog}/> )
    expect(screen.getByRole('combobox', { name: 'Default sub-agent model' })).toHaveTextContent('legacy-model')
    fireEvent.change(screen.getByLabelText('Maximum concurrent sub-agents'), { target: { value: '3' } })
    view.rerender(<SubagentSettings catalog={{ accounts: [], refreshedAt: 2 }}/> )
    expect(screen.getByLabelText('Maximum concurrent sub-agents')).toHaveValue(3)
    expect(screen.getByRole('combobox', { name: 'Default reasoning effort' })).toHaveTextContent('Extra High')
  })
  it('updates model-specific efforts and retains inheritance without changing the parent', async () => {
    render(<SubagentSettings catalog={catalog}/> )
    choose('Default sub-agent model', 'Reasoner · Account A'); choose('Default reasoning effort', 'High')
    choose('Default sub-agent model', 'Reasoner · Gateway B · unavailable at launch')
    expect(screen.getByRole('combobox', { name: 'Default reasoning effort' })).toHaveTextContent('Auto')
    fireEvent.click(screen.getByRole('combobox', { name: 'Default reasoning effort' }))
    expect(screen.queryByRole('option', { name: 'High' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('option', { name: 'Inherit parent reasoning effort' }))
    choose('Default sub-agent model', 'Inherit parent model')
    save(); await screen.findByText(/Sub-agent settings saved/)
    expect(useAthena.getState().snapshot!.settings.subagents.defaultSelection).toBeNull()
    expect(useChat.getState().snapshot.phase).toBe('thinking')
  })
  it('surfaces validation and persistence failures without disabling preferences', async () => {
    render(<SubagentSettings catalog={catalog}/> )
    fireEvent.change(screen.getByLabelText('Per-request context budget (tokens, including output)'), { target: { value: '-1' } })
    fireEvent.submit(screen.getByRole('button', { name: 'Save sub-agent settings' }).closest('form')!)
    expect(await screen.findByRole('alert')).toHaveTextContent('contextTokens')
    fireEvent.change(screen.getByLabelText('Per-request context budget (tokens, including output)'), { target: { value: '128000' } })
    act(() => useAthena.setState({ update: vi.fn(async () => { useAthena.setState({ error: 'Storage unavailable' }) }) }))
    save(); await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Storage unavailable'))
    expect(screen.getByLabelText('Maximum concurrent sub-agents')).toBeEnabled()
  })
})
