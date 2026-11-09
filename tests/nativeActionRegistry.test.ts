import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChatController } from '../electron/main/ai/chatController'
import { NativeActionRegistry } from '../electron/main/ai/nativeActionRegistry'
import type { AIProvider } from '../electron/main/ai/AIProvider'
import { defaultSettings } from '../shared/settings'
import { automationPermissionDefaults, type AutomationPermission } from '../shared/automation'

vi.mock('../electron/main/logger', () => ({ log: vi.fn() }))

const requestId = '00000000-0000-4000-a000-000000000099'

function setup(models = [{ slug: 'gpt-6', displayName: 'GPT-6' }], userText = "Create a new ChatGPT conversation, select an available GPT-6 model, type 'Hello, explain React hooks', and send it.", permissionOverrides: Partial<Record<AutomationPermission, boolean>> = {}, approvePermissions = true) {
  const onlineResponse = 'private online response must stay in the online conversation'
  const provider: AIProvider = {
    testConnection: async () => true,
    async *streamMessage() { yield { type: 'text', text: onlineResponse }; yield { type: 'done' } },
  }
  const onlineChat = new ChatController({ provider: async () => provider, changed: vi.fn(), phase: vi.fn() })
  const localChat = new ChatController({ provider: async () => provider, changed: vi.fn(), phase: vi.fn(), resource: 'local' })
  const localAthenaChat = new ChatController({ provider: async () => provider, changed: vi.fn(), phase: vi.fn(), resource: 'local' })
  const settings = {
    ...defaultSettings,
    aiMode: 'cloud' as const,
    automationPermissions: { ...automationPermissionDefaults, conversationManagement: true, internalNavigation: true, externalMessageSubmission: true, destructiveOperations: true, desktopApplicationControl: true, browserAccess: true, ...permissionOverrides },
  }
  const controller = {
    settings,
    windows: { showControl: vi.fn() },
    setAutomationActivity: vi.fn(),
    updateSettings: vi.fn((patch: { aiMode?: typeof settings.aiMode }) => { Object.assign(settings, patch); return {} }),
  }
  const chatGPT = { status: vi.fn(async () => ({ connected: true, planEnabled: true, model: models[0]?.slug ?? null, models, message: 'ready' })) }
  const permissions = { isCapabilityAllowed: vi.fn(() => true) }
  const desktop = { openApplicationByVoice: vi.fn(async () => ({ ok: true, status: 'completed', message: 'The application is running.' })), openURLByVoice: vi.fn(async () => ({ ok: true, status: 'submitted', message: 'URL submitted.' })) }
  const audit = { record: vi.fn(async () => {}) }
  const confirmDelete = vi.fn(async () => false)
  const requestAutomationPermission = vi.fn(async (permission: AutomationPermission) => {
    if (approvePermissions) settings.automationPermissions[permission] = true
    return approvePermissions
  })
  const openExternalURL = vi.fn(async (url: string) => ({ ok: true, message: `macOS accepted ${new URL(url).host} for opening in the current default browser. Page loading was not verified.` }))
  const registry = new NativeActionRegistry({ controller: controller as never, onlineChat, localAthenaChat, validateLocalModel: async model => model === 'qwen3:8b', chatGPT: chatGPT as never, permissions: permissions as never, desktop: desktop as never, openExternalURL, requestAutomationPermission, audit: audit as never, confirmDelete })
  const tools = registry.createTools({ localChat, userText, requestId, voiceOnly: true })
  const call = async (name: string, input: unknown, signal = new AbortController().signal) => JSON.parse(await tools.execute(name, input, signal)) as { ok: boolean; message?: string; sessionId?: string; model?: string; sentMessageId?: string; duplicate?: boolean }
  return { onlineChat, localChat, localAthenaChat, controller, chatGPT, permissions, desktop, audit, confirmDelete, requestAutomationPermission, openExternalURL, registry, tools, call, onlineResponse }
}

afterEach(() => vi.restoreAllMocks())

describe('local Athena native action registry', () => {
  it('creates a private local chat, validates its Ollama model, and sends only to Athena Chat', async () => {
    const app = setup(undefined, "Create a new local Athena Chat conversation, select local model qwen3:8b, and ask Athena Chat 'Explain React hooks'.")
    try {
      const created = await app.call('athena_local_chat_create_session', {})
      expect(created.ok).toBe(true)
      const sessionId = created.sessionId!
      expect(await app.call('athena_local_chat_select_model', { sessionId, model: 'qwen3:8b' })).toMatchObject({ ok: true, model: 'qwen3:8b' })
      expect(await app.call('athena_local_chat_set_composer_text', { sessionId, text: 'Explain React hooks' })).toMatchObject({ ok: true })
      const sent = await app.call('athena_local_chat_send_message', { sessionId })
      expect(sent).toMatchObject({ ok: true, sessionId, sentMessageId: expect.any(String) })
      const session = app.localAthenaChat.getSession(sessionId)!
      expect(session.config.model).toBe('qwen3:8b')
      expect(session.messages.find(message => message.role === 'user')?.content).toBe('Explain React hooks')
      expect(app.onlineChat.snapshot().sessions?.flatMap(item => app.onlineChat.getSession(item.id)?.messages ?? [])).toHaveLength(0)
      expect(JSON.stringify(sent)).not.toContain(app.onlineResponse)
      await vi.waitFor(() => expect(app.localAthenaChat.snapshot().phase).toBe('idle'))
    } finally { app.onlineChat.dispose(); app.localChat.dispose(); app.localAthenaChat.dispose() }
  })

  it('does not substitute an unavailable local model or send unquoted text', async () => {
    const app = setup(undefined, 'Create a new local Athena Chat conversation and ask it to explain React hooks.')
    try {
      const created = await app.call('athena_local_chat_create_session', {})
      const sessionId = created.sessionId!
      const unavailable = await app.call('athena_local_chat_select_model', { sessionId, model: 'missing-model' })
      expect(unavailable).toMatchObject({ ok: false })
      expect(app.localAthenaChat.getSession(sessionId)?.config.model).not.toBe('missing-model')
      expect(await app.call('athena_local_chat_set_composer_text', { sessionId, text: 'Explain React hooks' })).toMatchObject({ ok: false })
      expect(await app.call('athena_local_chat_send_message', { sessionId })).toMatchObject({ ok: false })
      expect(app.localAthenaChat.getSession(sessionId)?.messages).toHaveLength(0)
    } finally { app.onlineChat.dispose(); app.localChat.dispose(); app.localAthenaChat.dispose() }
  })

  it('creates a ChatGPT conversation, selects a verified model, and submits exact dictated text through the existing chat controller', async () => {
    const app = setup()
    try {
      const provider = await app.call('athena_chat_select_provider', {})
      expect(provider.ok).toBe(true)
      const created = await app.call('athena_chat_create_session', {})
      expect(created.ok).toBe(true)
      const sessionId = created.sessionId!
      const selected = await app.call('athena_chat_select_model', { sessionId, requestedModel: 'GPT-6' })
      expect(selected).toMatchObject({ ok: true, model: 'gpt-6' })
      expect(await app.call('athena_chat_set_composer_text', { sessionId, text: 'Hello, explain React hooks' })).toMatchObject({ ok: true })
      const sent = await app.call('athena_chat_send_message', { sessionId })
      expect(sent).toMatchObject({ ok: true, sessionId, sentMessageId: expect.any(String) })
      await vi.waitFor(() => expect(app.onlineChat.snapshot().phase).toBe('idle'))
      const conversation = app.onlineChat.getSession(sessionId)!
      expect(conversation.config.model).toBe('gpt-6')
      expect(conversation.messages.filter(message => message.role === 'user').map(message => message.content)).toEqual(['Hello, explain React hooks'])
      expect(conversation.messages.filter(message => message.role === 'user' && message.requestId === requestId)).toHaveLength(1)
      expect(JSON.stringify(sent)).not.toContain(app.onlineResponse)
      expect(app.localChat.snapshot().messages).toHaveLength(0)
      expect(app.localChat.snapshot().automationProgress).toMatchObject({ phase: 'complete', steps: expect.arrayContaining([expect.objectContaining({ status: 'complete' })]) })
      expect(app.audit.record).toHaveBeenCalledWith(expect.objectContaining({ actionId: 'athena.chat.sendMessage', permission: 'externalMessageSubmission', status: 'completed' }))
    } finally { app.onlineChat.dispose(); app.localChat.dispose(); app.localAthenaChat.dispose() }
  })

  it('refuses an unavailable model and does not silently substitute or submit', async () => {
    const app = setup([{ slug: 'gpt-5.6', displayName: 'GPT-5.6' }])
    try {
      await app.call('athena_chat_select_provider', {})
      const created = await app.call('athena_chat_create_session', {})
      const result = await app.call('athena_chat_select_model', { sessionId: created.sessionId, requestedModel: 'GPT-6' })
      expect(result).toMatchObject({ ok: false })
      expect(result.message).toContain('unavailable')
      expect(app.onlineChat.getSession(created.sessionId!)?.messages).toHaveLength(0)
    } finally { app.onlineChat.dispose(); app.localChat.dispose(); app.localAthenaChat.dispose() }
  })

  it('allows a GPT-6 family request only when the account has exactly one matching model', async () => {
    const app = setup([{ slug: 'gpt-6-fast', displayName: 'GPT-6 Fast' }, { slug: 'gpt-5.6', displayName: 'GPT-5.6' }])
    try {
      await app.call('athena_chat_select_provider', {})
      const created = await app.call('athena_chat_create_session', {})
      expect(await app.call('athena_chat_select_model', { sessionId: created.sessionId, requestedModel: 'GPT-6' })).toMatchObject({ ok: true, model: 'gpt-6-fast' })
    } finally { app.onlineChat.dispose(); app.localChat.dispose(); app.localAthenaChat.dispose() }
    const ambiguous = setup([{ slug: 'gpt-6-fast', displayName: 'GPT-6 Fast' }, { slug: 'gpt-6-pro', displayName: 'GPT-6 Pro' }])
    try {
      await ambiguous.call('athena_chat_select_provider', {})
      const created = await ambiguous.call('athena_chat_create_session', {})
      const result = await ambiguous.call('athena_chat_select_model', { sessionId: created.sessionId, requestedModel: 'GPT-6' })
      expect(result).toMatchObject({ ok: false })
      expect(result.message).toContain('Several GPT-6 models')
    } finally { ambiguous.onlineChat.dispose(); ambiguous.localChat.dispose(); ambiguous.localAthenaChat.dispose() }
  })

  it('requires an explicit positive send instruction and exact quoted text', async () => {
    const app = setup(undefined, "Create a new ChatGPT conversation using GPT-6, type 'Hello, explain React hooks', but do not send it.")
    try {
      await app.call('athena_chat_select_provider', {})
      const created = await app.call('athena_chat_create_session', {})
      const sessionId = created.sessionId!
      await app.call('athena_chat_select_model', { sessionId, requestedModel: 'gpt-6' })
      await app.call('athena_chat_set_composer_text', { sessionId, text: 'Hello, explain React hooks' })
      const blocked = await app.call('athena_chat_send_message', { sessionId })
      expect(blocked).toMatchObject({ ok: false })
      expect(app.onlineChat.getSession(sessionId)?.messages).toHaveLength(0)
    } finally { app.onlineChat.dispose(); app.localChat.dispose(); app.localAthenaChat.dispose() }

    const mismatch = setup(undefined, "Create a new ChatGPT conversation using GPT-6 and send the exact text 'A different phrase'.")
    try {
      await mismatch.call('athena_chat_select_provider', {})
      const created = await mismatch.call('athena_chat_create_session', {})
      const sessionId = created.sessionId!
      await mismatch.call('athena_chat_select_model', { sessionId, requestedModel: 'gpt-6' })
      expect(await mismatch.call('athena_chat_set_composer_text', { sessionId, text: 'Hello, explain React hooks' })).toMatchObject({ ok: false })
      expect(await mismatch.call('athena_chat_send_message', { sessionId })).toMatchObject({ ok: false })
      expect(mismatch.onlineChat.getSession(sessionId)?.messages).toHaveLength(0)
    } finally { mismatch.onlineChat.dispose(); mismatch.localChat.dispose(); mismatch.localAthenaChat.dispose() }
  })

  it('rejects conversation creation when the user did not ask for it', async () => {
    const app = setup(undefined, 'Summarize this React page.')
    try {
      const before = app.onlineChat.snapshot().sessions?.length ?? 0
      expect(await app.call('athena_chat_create_session', {})).toMatchObject({ ok: false })
      expect(app.onlineChat.snapshot().sessions).toHaveLength(before)
    } finally { app.onlineChat.dispose(); app.localChat.dispose(); app.localAthenaChat.dispose() }
  })

  it('deduplicates repeated submission calls in one plan and refuses stale session results', async () => {
    const app = setup()
    try {
      await app.call('athena_chat_select_provider', {})
      const created = await app.call('athena_chat_create_session', {})
      const sessionId = created.sessionId!
      await app.call('athena_chat_select_model', { sessionId, requestedModel: 'gpt-6' })
      await app.call('athena_chat_set_composer_text', { sessionId, text: 'Hello, explain React hooks' })
      const first = await app.call('athena_chat_send_message', { sessionId })
      const second = await app.call('athena_chat_send_message', { sessionId })
      expect(second).toMatchObject({ ok: true, duplicate: true, sentMessageId: first.sentMessageId })
      expect(app.onlineChat.getSession(sessionId)?.messages.filter(message => message.role === 'user' && message.requestId === requestId)).toHaveLength(1)
      const other = app.onlineChat.snapshot().sessions?.find(session => session.id !== sessionId)!
      app.onlineChat.command({ action: 'switch', id: other.id })
      const stale = await app.call('athena_chat_select_model', { sessionId, requestedModel: 'gpt-6' })
      expect(stale).toMatchObject({ ok: false })
      expect(stale.message).toContain('changed or is stale')
    } finally { app.onlineChat.dispose(); app.localChat.dispose(); app.localAthenaChat.dispose() }
  })

  it('stops on cancellation, blocks denied desktop access, and requires confirmation before deletion', async () => {
    const app = setup(undefined, 'Open VS Code and delete this conversation.')
    try {
      const aborted = new AbortController(); aborted.abort()
      expect(await app.call('athena_navigate', { page: 'academy' }, aborted.signal)).toMatchObject({ ok: false })
      expect(app.localChat.snapshot().automationProgress).toMatchObject({ phase: 'cancelled', steps: [expect.objectContaining({ status: 'cancelled' })] })
      expect(app.controller.windows.showControl).not.toHaveBeenCalled()
      app.permissions.isCapabilityAllowed.mockReturnValue(false)
      expect(await app.call('athena_desktop_open_application', { app: 'vscode' })).toMatchObject({ ok: false })
      expect(app.desktop.openApplicationByVoice).not.toHaveBeenCalled()
      const sessionId = app.onlineChat.snapshot().sessionId!
      expect(await app.call('athena_chat_delete_session', { sessionId })).toMatchObject({ ok: false })
      expect(app.onlineChat.getSession(sessionId)).toBeTruthy()
      expect(app.confirmDelete).toHaveBeenCalledTimes(1)
    } finally { app.onlineChat.dispose(); app.localChat.dispose(); app.localAthenaChat.dispose() }
  })

  it('resolves YouTube directly, requests Browser Access, and opens via the OS URL handler without Brave Search', async () => {
    const app = setup(undefined, 'Open YouTube in my current browser.', { browserAccess: false })
    try {
      app.controller.settings.webAccess.webSearchEnabled = false
      const names = app.tools.definitions.map(definition => definition.name)
      expect(names).toContain('browser_open_url')
      const action = await app.tools.resolveDeterministicAction!('Open YouTube in my current browser.', new AbortController().signal)
      expect(action).toMatchObject({ handled: true, action: 'browser-open-url' })
      expect(app.openExternalURL).toHaveBeenCalledWith('https://www.youtube.com/', expect.any(AbortSignal))
      expect(app.requestAutomationPermission).toHaveBeenCalledWith('browserAccess', 'browser.openUrl')
      expect(action.text).toContain('macOS accepted www.youtube.com')
      expect(action.text).not.toMatch(/loaded successfully/i)
      expect(app.audit.record).toHaveBeenCalledWith(expect.objectContaining({ actionId: 'browser.openUrl', permission: 'browserAccess', status: 'completed' }))
    } finally { app.onlineChat.dispose(); app.localChat.dispose(); app.localAthenaChat.dispose() }
  })

  it('creates and selects a new online chat from a voice command after Conversation Management approval', async () => {
    const app = setup(undefined, 'Open a new chat in Online AI Chat.', { conversationManagement: false })
    try {
      const action = await app.tools.resolveDeterministicAction!('Open a new chat in Online AI Chat.', new AbortController().signal)
      const sessionId = app.onlineChat.snapshot().sessionId!
      expect(action).toMatchObject({ handled: true, action: 'online-conversation-create' })
      expect(app.onlineChat.getSession(sessionId)).toBeTruthy()
      expect(app.controller.windows.showControl).toHaveBeenCalledWith('conversation')
      expect(app.requestAutomationPermission).toHaveBeenCalledWith('conversationManagement', 'athena.chat.createSession')
      expect(action.text).toContain('Created an online conversation')
    } finally { app.onlineChat.dispose(); app.localChat.dispose(); app.localAthenaChat.dispose() }
  })

  it('keeps ChatGPT submission on the selected online model and submits exact quoted text once', async () => {
    const app = setup(undefined, "Create a new ChatGPT conversation, type 'Hello', and send it.")
    try {
      const action = await app.tools.resolveDeterministicAction!("Create a new ChatGPT conversation, type 'Hello', and send it.", new AbortController().signal)
      const sessionId = app.onlineChat.snapshot().sessionId!
      const conversation = app.onlineChat.getSession(sessionId)!
      const submitted = conversation.messages.filter(message => message.role === 'user')
      expect(action).toMatchObject({ handled: true, action: 'online-conversation-submit' })
      expect(conversation.config.model).toBe('gpt-6')
      expect(submitted.map(message => message.content)).toEqual(['Hello'])
      expect(submitted).toHaveLength(1)
      expect(action.text).toContain('submitted')
      expect(action.text).not.toContain(app.onlineResponse)
    } finally { app.onlineChat.dispose(); app.localChat.dispose(); app.localAthenaChat.dispose() }
  })

  it('creates a local chat and navigates to Academy with the existing application services', async () => {
    const local = setup(undefined, 'Create a new local Athena Chat conversation.')
    try {
      const action = await local.tools.resolveDeterministicAction!('Create a new local Athena Chat conversation.', new AbortController().signal)
      expect(action).toMatchObject({ handled: true, action: 'local-conversation-create' })
      expect(local.localAthenaChat.snapshot().sessions?.length).toBeGreaterThan(0)
    } finally { local.onlineChat.dispose(); local.localChat.dispose(); local.localAthenaChat.dispose() }

    const academy = setup(undefined, 'Open Athena Academy.')
    try {
      const action = await academy.tools.resolveDeterministicAction!('Open Athena Academy.', new AbortController().signal)
      expect(action).toMatchObject({ handled: true, action: 'navigate-academy' })
      expect(academy.controller.windows.showControl).toHaveBeenCalledWith('my-athena-academy')
    } finally { academy.onlineChat.dispose(); academy.localChat.dispose(); academy.localAthenaChat.dispose() }
  })

  it('does not run a denied permission request and keeps the action registered for clear execution feedback', async () => {
    const app = setup(undefined, 'Open YouTube.', { browserAccess: false }, false)
    try {
      const names = app.tools.definitions.map(definition => definition.name)
      expect(names).toContain('browser_open_url')
      const action = await app.tools.resolveDeterministicAction!('Open YouTube.', new AbortController().signal)
      expect(action).toMatchObject({ handled: true })
      expect(action.text).toContain('was not approved')
      expect(app.openExternalURL).not.toHaveBeenCalled()
    } finally { app.onlineChat.dispose(); app.localChat.dispose(); app.localAthenaChat.dispose() }
  })

  it('exposes only bounded registered actions, including actions that can request their own permissions', () => {
    const app = setup()
    try {
      const names = app.tools.definitions.map(definition => definition.name)
      expect(names).toContain('athena_chat_send_message')
      expect(names).toContain('browser_open_url')
      expect(names).not.toContain('execute_command')
      app.controller.settings.automationPermissions.externalMessageSubmission = false
      const restricted = app.registry.createTools({ localChat: app.localChat, userText: 'send a message', requestId: crypto.randomUUID(), voiceOnly: true })
      expect(restricted.definitions.map(definition => definition.name)).toContain('athena_chat_send_message')
    } finally { app.onlineChat.dispose(); app.localChat.dispose(); app.localAthenaChat.dispose() }
  })
})
