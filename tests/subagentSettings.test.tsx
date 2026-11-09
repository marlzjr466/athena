import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SubagentSettings } from '../src/features/settings/SubagentSettings'
import { useAthena } from '../src/store/athenaStore'
import { useChat } from '../src/store/chatStore'
import { defaultSettings } from '../shared/settings'
import type { Snapshot } from '../shared/contracts'
import { emptyChatSnapshot } from '../shared/chat'
const api = vi.hoisted(() => ({ getAIStatus: vi.fn(), getLocalStatus: vi.fn(), getChatGPTStatus: vi.fn(), getClaudeStatus: vi.fn(), getChat: vi.fn(), onChat: vi.fn(() => () => {}) }))
vi.mock('../src/services/desktop', () => ({ desktop: api }))
beforeEach(() => {
  useAthena.setState({ snapshot: { settings: { ...defaultSettings } } as Snapshot, update: vi.fn(async () => {}) })
  useChat.setState({ snapshot: emptyChatSnapshot() })
  api.getAIStatus.mockResolvedValue({ status: { active: true, models: ['gpt-5-mini'] } })
  api.getChat.mockResolvedValue({ config: { model: 'grok-4.7', cursorModel: 'grok-4.7' } })
})
describe('sub-agent settings', () => {
  it('configures budgets and models without modifying the conversation model', async () => {
    render(<SubagentSettings />)
    await screen.findByText(/1 model candidates/)
    fireEvent.click(screen.getByRole('combobox', { name: 'Cold-read model' }))
    fireEvent.click(screen.getByRole('option', { name: 'gpt-5-mini' }))
    fireEvent.change(screen.getByLabelText('Maximum concurrent sub-agents'), { target: { value: '3' } })
    fireEvent.change(screen.getByLabelText('Default iteration limit'), { target: { value: '20' } })
    fireEvent.change(screen.getByLabelText('Default tool-call limit'), { target: { value: '60' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save sub-agent settings' }))
    await waitFor(() => expect(useAthena.getState().update).toHaveBeenCalledWith({ subagents: { ...defaultSettings.subagents, coldReadModel: 'gpt-5-mini', maxConcurrent: 3, maxIterations: 20, maxToolCalls: 60 } }))
  })
  it('reports unsupported native-agent providers instead of promising tools', async () => {
    useAthena.setState({ snapshot: { settings: { ...defaultSettings, aiMode: 'cursor' } } as Snapshot })
    render(<SubagentSettings />)
    expect(await screen.findByText(/cannot enforce Athena’s isolated child-tool scopes/)).toBeVisible()
    await screen.findByText(/Effective sub-agent model: grok-4.7/)
    expect(screen.queryByRole('combobox', { name: 'Default sub-agent model' })).not.toBeInTheDocument()
    expect(api.getChatGPTStatus).not.toHaveBeenCalled()
  })
})
