import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Snapshot } from '../shared/contracts'
import { defaultSettings } from '../shared/settings'
import { useAthena } from '../src/store/athenaStore'

const api = vi.hoisted(() => ({ getLocalStatus: vi.fn(), onLocalProgress: vi.fn(), getAcademy: vi.fn(), academyCommand: vi.fn(), getLocalVoiceStatus: vi.fn(), manageLocalVoice: vi.fn(), onLocalVoiceProgress: vi.fn(), onLocalVoicePlaybackStopped: vi.fn() }))
vi.mock('../src/services/desktop', () => ({ desktop: api, isDesktop: true }))
vi.mock('../src/features/athena/CompanionPage', () => ({ CompanionPage: () => <div>Companion route</div> }))
vi.mock('../src/features/chat/ChatView', () => ({ ChatView: () => <div>Online conversation route</div> }))
vi.mock('../src/features/athena-ai/AthenaChat', () => ({ AthenaChat: () => <div>Private local chat route</div> }))
vi.mock('../src/features/settings/SettingsPage', () => ({ SettingsPage: ({ page }: { page: string }) => <div>Settings route: {page}</div> }))

import { ControlCenter } from '../src/app/ControlCenter'

beforeEach(() => {
  vi.clearAllMocks()
  api.getLocalStatus.mockResolvedValue({ connected: false, message: 'Ollama unavailable', models: [], arch: 'arm64', totalMemoryBytes: 0, freeMemoryBytes: 0, whisperInstalled: false, macSpeechAvailable: false, macVoices: [] })
  api.getAcademy.mockResolvedValue({ profiles: [], sources: [], evaluations: [] })
  api.onLocalProgress.mockReturnValue(() => {})
  api.getLocalVoiceStatus.mockResolvedValue({ runtime: 'ready', engines: { 'sesame-csm': { status: 'installed' }, 'chatterbox-turbo': { status: 'installed' }, 'sesame-csm-official': { status: 'installed' }, 'higgs-tts-3-4b': { status: 'not-installed' } }, profiles: [] })
  api.manageLocalVoice.mockResolvedValue({ ok: true, studio: { examples: [], samples: [] } })
  api.onLocalVoiceProgress.mockReturnValue(() => {}); api.onLocalVoicePlaybackStopped.mockReturnValue(() => {})
  useAthena.setState({ page: 'companion', error: null, snapshot: { settings: defaultSettings, state: 'idle' } as Snapshot })
})

describe('My Athena navigation', () => {
  it('nests Meeting Intelligence under My Athena and applies the shared page spacing',async()=>{
    render(<ControlCenter />)
    fireEvent.click(screen.getByRole('button',{name:'My Athena'}))
    const submenu=screen.getByRole('group',{name:'My Athena pages'})
    fireEvent.click(within(submenu).getByRole('button',{name:'Meeting Intelligence'}))
    const heading=await screen.findByRole('heading',{name:'Meeting Intelligence'})
    expect(heading.closest('.settings-page')).toHaveClass('meeting-page-shell')
    expect(screen.getByRole('button',{name:'My Athena'})).toHaveAttribute('aria-current','page')
    expect(screen.getByText('My Athena / Meeting Intelligence')).toBeInTheDocument()
    expect(screen.getByRole('combobox',{name:'Meeting template'}).tagName).toBe('BUTTON')
  })
  it('removes the neural Local Voice page and retains ordinary Voice settings', async () => {
    render(<ControlCenter />)
    fireEvent.click(screen.getByRole('button', { name: 'My Athena' }))
    expect(screen.queryByRole('button', { name: 'Local Voice' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Voice' }))
    expect(await screen.findByText('Settings route: voice')).toBeInTheDocument()
    expect(useAthena.getState().snapshot?.settings.localVoice.engine).toBe(defaultSettings.localVoice.engine)
  })
  it('opens Athena Chat by default, then switches to Academy and local setup', async () => {
    render(<ControlCenter />)
    fireEvent.click(screen.getByRole('button', { name: 'My Athena' }))
    expect(await screen.findByText('Private local chat route')).toBeInTheDocument()
    expect(useAthena.getState().page).toBe('my-athena')
    expect(screen.getByRole('button', { name: 'My Athena' })).toHaveAttribute('aria-current', 'page')
    fireEvent.click(screen.getByRole('button', { name: 'Athena Academy' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Athena Academy' })).toHaveAttribute('aria-current', 'page'))
    expect(screen.getByRole('button', { name: 'My Athena' })).toHaveAttribute('aria-current', 'page')
    expect(await screen.findByRole('heading', { name: 'Athena Academy' })).toBeInTheDocument()
    expect(await screen.findByText(/Ollama is unavailable/)).toBeInTheDocument()
    expect(useAthena.getState().page).toBe('my-athena-academy')
    fireEvent.click(screen.getByRole('button', { name: 'Local AI setup' }))
    expect(await screen.findByRole('heading', { name: 'Local models' })).toBeInTheDocument()
    expect(useAthena.getState().page).toBe('my-athena-local')
  })
  it('keeps the local chat separate from online Conversation', async () => {
    render(<ControlCenter />)
    fireEvent.click(screen.getByRole('button', { name: 'My Athena' }))
    expect(await screen.findByText('Private local chat route')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'My Athena' })).toHaveAttribute('aria-current', 'page')
    expect(screen.queryByText('Online conversation route')).not.toBeInTheDocument()
    expect(useAthena.getState().page).toBe('my-athena')
  })
})
