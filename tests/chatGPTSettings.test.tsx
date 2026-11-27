import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyChatGPTStatus } from '../shared/chatgpt'
import { emptyChatSnapshot } from '../shared/chat'
import { useChat } from '../src/store/chatStore'

const api = vi.hoisted(() => ({ getChatGPTStatus: vi.fn(), getCodexCLIStatus: vi.fn(), chatSession: vi.fn(), selectChatGPTAccount: vi.fn(), openChatGPTUsage: vi.fn(), refreshChatGPTModels: vi.fn() }))
vi.mock('../src/services/desktop', () => ({ desktop: api }))

import { ChatGPTSettings } from '../src/features/settings/ChatGPTSettings'

const sessionId = '11111111-1111-4111-8111-111111111111'
const longLabel = 'A deliberately long ChatGPT account name that should wrap without being cut off'

beforeEach(() => {
  vi.clearAllMocks()
  api.chatSession.mockResolvedValue({ ok: true })
  api.getCodexCLIStatus.mockResolvedValue({ installed: false, authenticated: false, version: null, identity: null, models: [{id:'gpt-5.6-luna',displayName:'GPT',efforts:['low','medium','high','xhigh'],defaultEffort:'medium',isDefault:true}], defaultModel: null, checkedAt: null, message: 'Codex CLI was not found.' })
  api.getChatGPTStatus.mockResolvedValue({
    ...emptyChatGPTStatus(),
    connected: true,
    planEnabled: true,
    model: 'account-model-with-unrecognized-capability-name',
    accounts: [{
      id: '22222222-2222-4222-8222-222222222222', label: longLabel, email: 'athena@example.test',
      connected: true, planEnabled: true, enabled: true, active: true,
      model: 'account-model-with-unrecognized-capability-name', models: [], message: 'Connected.',
    }],
    activeAccountId: '22222222-2222-4222-8222-222222222222',
  })
  useChat.setState({
    snapshot: {
      ...emptyChatSnapshot(), sessionId, phase: 'idle',
      config: { provider: 'OpenAI', model: 'gpt-5.6-luna', effort: 'medium' },
    },
    pending: false,
    issue: null,
  })
})

describe('ChatGPT subscription settings', () => {
  it('identifies the request account and distinguishes the conversation model from the account default', async () => {
    render(<ChatGPTSettings />)
    expect(await screen.findByText(/Request account reference: 22222222/)).toHaveTextContent('Conversation model: gpt-5.6-luna; account default: account-model-with-unrecognized-capability-name')
    expect(screen.getByRole('link', { name: 'Open ChatGPT Usage' })).toHaveAttribute('href', 'https://chatgpt.com/settings/usage')
    expect(api.selectChatGPTAccount).not.toHaveBeenCalled()
  })
  it('offers the same reasoning choices as the active conversation model', async () => {
    render(<ChatGPTSettings />)
    const selector = await screen.findByLabelText('ChatGPT Subscription reasoning effort')
    fireEvent.click(selector)
    expect(screen.getByRole('option', { name: 'Low' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Medium' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'High' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Extra High' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Auto' })).toHaveAttribute('aria-selected', 'false')
    fireEvent.click(screen.getByRole('option', { name: 'High' }))
    await waitFor(() => expect(api.chatSession).toHaveBeenCalledWith({ action: 'configure-effort', id: sessionId, effort: 'high' }))
  })

  it('renders long account names in a wrapping multiline label field', async () => {
    render(<ChatGPTSettings />)
    const label = await screen.findByLabelText(`${longLabel} account label`)
    expect(label.tagName).toBe('TEXTAREA')
    expect(label).toHaveValue(longLabel)
    await waitFor(() => expect(api.getChatGPTStatus).toHaveBeenCalled())
  })

  it('shows persisted reconnect state after a rejected refresh without retrying OAuth', async () => {
    const connected = await api.getChatGPTStatus()
    api.getChatGPTStatus.mockResolvedValueOnce(connected).mockResolvedValue({
      ...connected, connected: false,
      accounts: connected.accounts.map((account: { id: string }) => ({ ...account, connected: false })),
    })
    api.refreshChatGPTModels.mockRejectedValue(new Error('ChatGPT authorization expired (HTTP 400 (invalid_grant)). Reconnect the same account.'))
    const onAccountsChanged = vi.fn()
    render(<ChatGPTSettings onAccountsChanged={onAccountsChanged} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Refresh models' }))
    expect(await screen.findByText(/ChatGPT authorization expired/)).toHaveTextContent('invalid_grant')
    await waitFor(() => expect(screen.getAllByText('○ Reconnect required')).toHaveLength(2))
    expect(screen.queryByText('● Active account')).not.toBeInTheDocument()
    expect(api.refreshChatGPTModels).toHaveBeenCalledTimes(1)
    expect(onAccountsChanged).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'Reconnect' })).toBeEnabled()
  })

})
