import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import { registerIPC } from '../electron/main/ipcHandlers'
import { IPC } from '../shared/ipcChannels'
import type { AthenaController } from '../electron/main/athenaController'
import type { AIConfiguration } from '../electron/main/ai/aiConfiguration'
import { ChatController } from '../electron/main/ai/chatController'
import type { PermissionService } from '../electron/main/permissions/permissionService'
import type { ChatContextService } from '../electron/main/ai/chatContextService'
import type { VoiceController } from '../electron/main/voice/voiceController'
import { matchesRendererURL } from '../electron/main/rendererSecurity'
import { defaultSettings } from '../shared/settings'
import type { SpeechController } from '../electron/main/voice/speechController'
import { newConversation } from '../electron/main/ai/conversationRepository'
import type { CompanionConversation } from '../electron/main/ai/companionRouting'
const handlers = vi.hoisted(() => new Map<string, (event: IpcMainInvokeEvent, input?: unknown) => unknown>())
vi.mock('electron', () => ({ ipcMain: { handle: (channel: string, fn: (event: IpcMainInvokeEvent, input?: unknown) => unknown) => handlers.set(channel, fn) } }))
vi.mock('../electron/main/logger', () => ({ log: vi.fn() }))
const methods = { getStatus: vi.fn(), test: vi.fn(), activate: vi.fn(), selectModel: vi.fn(), remove: vi.fn() }
const controller = { settings: structuredClone(defaultSettings), windows: { all: () => [], owns: (sender: { id: number }) => [1, 2, 3].includes(sender.id), isTrustedURL: (_sender: unknown, url: string) => matchesRendererURL(url, 'file:///athena/index.html'), control: { webContents: { id: 1, on: vi.fn() } }, floating: { webContents: { id: 2 } }, panel: { webContents: { id: 3 } } } } as unknown as AthenaController
function event(id = 1, child = false, url = 'file:///athena/index.html'): IpcMainInvokeEvent {
  const frame = { url }
  return { sender: { id, mainFrame: frame }, senderFrame: child ? { url } : frame } as unknown as IpcMainInvokeEvent
}
beforeEach(() => { handlers.clear(); vi.clearAllMocks(); registerIPC(controller, methods as unknown as AIConfiguration, {} as ChatController, {} as PermissionService) })
function registerLocal(online: ChatController, companion: CompanionConversation, voice?: VoiceController, speech?: SpeechController) {
  const args: Parameters<typeof registerIPC> = [controller, methods as unknown as AIConfiguration, online, {} as PermissionService]
  args[5] = voice; args[6] = speech; args[18] = companion
  registerIPC(...args)
}
describe('AI IPC authority', () => {
  it('does not reinstall or activate Sesame through legacy IPC', async () => {
    for (const channel of [IPC.localVoiceInstall, IPC.localVoiceManage, IPC.localVoiceProfile]) {
      expect(await handlers.get(channel)!(event(), { engine: 'sesame-csm', action: 'install' })).toMatchObject({ ok: false, message: expect.stringContaining('removed') })
    }
  })
  it('previews the requested text through the active speech service despite a stale Sesame setting', async () => {
    const old = controller.settings
    const generate = vi.fn(async () => new Uint8Array([82, 73, 70, 70]))
    controller.settings = { ...structuredClone(defaultSettings), localVoice: { ...defaultSettings.localVoice, engine: 'sesame-csm' } }
    const args: Parameters<typeof registerIPC> = [controller, methods as unknown as AIConfiguration, {} as ChatController, {} as PermissionService]
    args[9] = { generate, mimeType: 'audio/wav' }
    registerIPC(...args)
    try {
      expect(await handlers.get(IPC.localVoicePreview)!(event(), { text: 'This is the requested response.' })).toMatchObject({ ok: true, mimeType: 'audio/wav' })
      expect(generate).toHaveBeenCalledWith('This is the requested response.', controller.settings.voiceName, 1, expect.any(AbortSignal))
      controller.settings.voiceMuted = true
      expect(await handlers.get(IPC.localVoicePreview)!(event(), {})).toMatchObject({ ok: false })
      expect(generate).toHaveBeenCalledTimes(1)
    } finally { controller.settings = old }
  })
  it.each([IPC.officialCSM, IPC.higgsTTS, IPC.localVoiceManage, IPC.localVoiceInstall, IPC.localVoicePreview, IPC.localVoiceProfile])('restricts voice management to the trusted control center: %s', async (channel) => {
    await expect(Promise.resolve().then(() => handlers.get(channel)!(event(2), { action: 'unload' }))).rejects.toThrow()
    await expect(Promise.resolve().then(() => handlers.get(channel)!(event(1, true), { action: 'unload' }))).rejects.toThrow()
  })
  it('does not let control-center or unowned floating requests pull local speech chunks', async () => {
    const input = { id: crypto.randomUUID(), index: 1, ownership: { origin: 'athena-local', sessionId: crypto.randomUUID(), correlationId: crypto.randomUUID() } }
    await expect(Promise.resolve().then(() => handlers.get(IPC.handsFreeSpeechNext)!(event(1), input))).rejects.toThrow()
    expect(await handlers.get(IPC.handsFreeSpeechNext)!(event(2), input)).toMatchObject({ ok: false })
  })
  it('keeps Cursor page status reads passive and starts a check only for an explicit refresh', async () => {
    const previousSettings = controller.settings
    const cached = { installed: false, authenticated: false, authenticationStatus: 'unknown', identity: null, version: null, message: 'Not checked.', models: [], modelCatalogAvailable: false }
    const cursor = { cachedStatus: vi.fn(() => cached), status: vi.fn(async () => cached) }
    const args: Parameters<typeof registerIPC> = [controller, methods as unknown as AIConfiguration, {} as ChatController, {} as PermissionService]
    args[14] = cursor as never
    controller.settings = { ...defaultSettings, aiMode: 'cursor' }
    registerIPC(...args)
    try {
      expect(await handlers.get(IPC.cursorStatus)!(event(), { cachedOnly: true })).toEqual(cached)
      await handlers.get(IPC.aiStatus)!(event())
      expect(cursor.status).not.toHaveBeenCalled()
      expect(cursor.cachedStatus).toHaveBeenCalledTimes(2)
      await handlers.get(IPC.cursorStatus)!(event(), { refreshModels: true })
      expect(cursor.status).toHaveBeenCalledExactlyOnceWith(true)
    } finally { controller.settings = previousSettings }
  })
  it('lets a retired floating voice effect release only its own lease after a session switch', async () => {
    const previousSettings = controller.settings
    const previousState = controller.setHandsFreeState, previousVoice = controller.setVoiceState, previousSpeech = controller.setSpeechState
    let sessionId = crypto.randomUUID()
    const activate = vi.fn(() => ({ ok: true })), deactivate = vi.fn(), state = vi.fn(), voiceState = vi.fn(), speechState = vi.fn()
    controller.settings = { ...structuredClone(defaultSettings), voiceInteraction: { ...defaultSettings.voiceInteraction, handsFreeEnabled: true } }
    controller.setHandsFreeState = state; controller.setVoiceState = voiceState; controller.setSpeechState = speechState
    const args: Parameters<typeof registerIPC> = [controller, methods as unknown as AIConfiguration, {} as ChatController, {} as PermissionService]
    args[11] = { activate, canCapture: () => true, deactivate } as never
    args[18] = { chat: { current: () => ({ id: sessionId }) } as ChatController } as CompanionConversation
    registerIPC(...args)
    try {
      const first = await handlers.get(IPC.handsFreeEnable)!(event(2), sessionId) as { ownership: import('../shared/aiOwnership').AIOwnership }
      sessionId = crypto.randomUUID()
      expect(await handlers.get(IPC.handsFreeEnable)!(event(2), first.ownership.sessionId)).toMatchObject({ ok: false })
      expect(activate).toHaveBeenCalledTimes(1)
      const second = await handlers.get(IPC.handsFreeEnable)!(event(2), sessionId) as { ownership: import('../shared/aiOwnership').AIOwnership }
      expect(await handlers.get(IPC.handsFreeDisable)!(event(2), first.ownership)).toEqual({ ok: false })
      expect(deactivate).not.toHaveBeenCalled()
      expect(await handlers.get(IPC.handsFreeState)!(event(2), { state: 'listening', ownership: second.ownership })).toEqual({ ok: true })
      expect(await handlers.get(IPC.handsFreeDisable)!(event(2), second.ownership)).toEqual({ ok: true })
      expect(deactivate).toHaveBeenCalledWith(2)
      expect(await handlers.get(IPC.handsFreeState)!(event(2), { state: 'listening', ownership: second.ownership })).toEqual({ ok: false })
    } finally { controller.settings = previousSettings; controller.setHandsFreeState = previousState; controller.setVoiceState = previousVoice; controller.setSpeechState = previousSpeech }
  })
  it('requires a main-issued local voice owner before state, playback, or inference can reach the companion', async () => {
    const previousSettings = controller.settings
    const previousState = controller.setHandsFreeState, previousVoice = controller.setVoiceState, previousSpeech = controller.setSpeechState
    const state = vi.fn(), voiceState = vi.fn(), speechState = vi.fn(), reply = vi.fn(async () => ({ ok: true, text: 'Local' }))
    let capture = true, sessionId = crypto.randomUUID()
    controller.settings = { ...structuredClone(defaultSettings), voiceInteraction: { ...defaultSettings.voiceInteraction, handsFreeEnabled: true } }
    controller.setHandsFreeState = state; controller.setVoiceState = voiceState; controller.setSpeechState = speechState
    const args: Parameters<typeof registerIPC> = [controller, methods as unknown as AIConfiguration, {} as ChatController, {} as PermissionService]
    args[11] = { activate: () => ({ ok: true }), canCapture: () => capture } as never
    args[18] = { chat: { current: () => ({ id: sessionId }), answerHandsFree: reply } as unknown as ChatController, context: {} as ChatContextService }
    registerIPC(...args)
    try {
      const authorized = await handlers.get(IPC.handsFreeEnable)!(event(2), sessionId) as { ownership: import('../shared/aiOwnership').AIOwnership }
      const ownership = authorized.ownership
      for (const rejected of [undefined, { ...ownership, origin: 'online-chat' }, { ...ownership, correlationId: crypto.randomUUID() }]) {
        expect(await handlers.get(IPC.handsFreeState)!(event(2), { state: 'processing', ownership: rejected })).toEqual({ ok: false })
        expect(await handlers.get(IPC.handsFreePlayback)!(event(2), { playing: true, ownership: rejected })).toEqual({ ok: false })
        expect(await handlers.get(IPC.handsFreeReply)!(event(2), { text: 'Hello', ownership: rejected })).toMatchObject({ ok: false })
      }
      expect(state).not.toHaveBeenCalled(); expect(voiceState).not.toHaveBeenCalled(); expect(speechState).not.toHaveBeenCalled(); expect(reply).not.toHaveBeenCalled()
      await expect(handlers.get(IPC.handsFreeState)!(event(1), { state: 'processing', ownership })).rejects.toThrow()
      expect(await handlers.get(IPC.handsFreeState)!(event(2), { state: 'processing', ownership })).toEqual({ ok: true })
      expect(state).toHaveBeenCalledWith(expect.objectContaining({ ownership }))
      expect(await handlers.get(IPC.handsFreeReply)!(event(2), { text: 'Hello', ownership })).toMatchObject({ ok: true })
      expect(reply).toHaveBeenCalledOnce()
      capture = false
      expect(await handlers.get(IPC.handsFreePlayback)!(event(2), { playing: true, ownership })).toEqual({ ok: false })
      capture = true; sessionId = crypto.randomUUID()
      expect(await handlers.get(IPC.handsFreeState)!(event(2), { state: 'speaking', ownership })).toEqual({ ok: false })
      expect(state).toHaveBeenCalledOnce()
    } finally { controller.settings = previousSettings; controller.setHandsFreeState = previousState; controller.setVoiceState = previousVoice; controller.setSpeechState = previousSpeech }
  })
  it('does not resolve any provider or rewrite history for a migrated unconfigured online selection', async () => {
    const previousSettings = controller.settings, snapshot = { sessionId: crypto.randomUUID(), messages: [{ content: 'Preserved history' }] }
    controller.settings = { ...defaultSettings, aiMode: 'unconfigured' }
    registerIPC(controller, methods as unknown as AIConfiguration, { snapshot: () => snapshot } as unknown as ChatController, {} as PermissionService)
    try {
      expect(await handlers.get(IPC.aiStatus)!(event())).toMatchObject({ ok: false, status: { active: false, models: [] } })
      expect(await handlers.get(IPC.chatGet)!(event())).toEqual(snapshot)
      expect(methods.getStatus).not.toHaveBeenCalled()
    } finally { controller.settings = previousSettings }
  })
  it('switches away from a deleted active avatar and rejects bundled deletion at the bridge', async () => {
    const previousModels = controller.avatarModels, previousUpdate = controller.updateSettings, previousSettings = controller.settings
    const id = 'imported-00000000-0000-4000-8000-000000000001'
    const calls: string[] = []
    controller.settings = { ...previousSettings, avatarVariant: id }
    controller.avatarModels = { get: vi.fn(() => ({ importStatus: 'ready' })), delete: vi.fn(() => calls.push('delete')) } as unknown as typeof controller.avatarModels
    controller.updateSettings = vi.fn(() => { calls.push('switch'); return {} as ReturnType<typeof controller.updateSettings> })
    try {
      expect(await handlers.get(IPC.avatarModel)!(event(), { action: 'delete', id })).toEqual({ ok: true })
      expect(controller.updateSettings).toHaveBeenCalledWith({ avatarVariant: 'vroid-athena' })
      expect(calls).toEqual(['switch', 'delete'])
      expect(await handlers.get(IPC.avatarModel)!(event(), { action: 'delete', id: 'vroid-athena' })).toMatchObject({ ok: false })
      expect(controller.avatarModels.delete).toHaveBeenCalledOnce()
    } finally { controller.avatarModels = previousModels; controller.updateSettings = previousUpdate; controller.settings = previousSettings }
  })
  it.each([IPC.avatarModel, IPC.applicationDetection, IPC.aiTest, IPC.aiActivate, IPC.aiModel, IPC.aiRemove, IPC.chatRetry, IPC.chatClear, IPC.chatCopy, IPC.permissionsGet, IPC.permissionStatus, IPC.permissionSet, IPC.filesystemAccessSet, IPC.permissionRequest, IPC.permissionSettings, IPC.permissionAllowed, IPC.chatSearch])('keeps configuration and permissions in the control window for %s', async (channel) => {
    for (const untrusted of [event(2), event(3), event(99), event(1, true), event(1, false, 'file:///other.html'), event(1, false, 'https://example.com/')]) await expect(handlers.get(channel)!(untrusted)).rejects.toThrow()
    for (const method of Object.values(methods)) expect(method).not.toHaveBeenCalled()
  })
  it.each([IPC.aiStatus, IPC.chatGet, IPC.chatContext])('rejects untrusted frames and missing local runtimes for %s', async (channel) => {
    for (const untrusted of [event(2), event(99), event(3, true), event(3, false, 'file:///other.html')]) await expect(handlers.get(channel)!(untrusted)).rejects.toThrow()
  })
  it('keeps floating navigation and folder context in the local lane', async () => {
    const previousCommand = controller.command
    const command = vi.fn(), localContext = vi.fn(() => ({ ok: true })), onlineContext = vi.fn()
    const sessionId = crypto.randomUUID()
    controller.command = command
    const args: Parameters<typeof registerIPC> = [controller, methods as unknown as AIConfiguration, {} as ChatController, {} as PermissionService]
    args[4] = { run: onlineContext } as unknown as ChatContextService
    args[18] = { chat: { snapshot: () => ({ sessionId }) } as unknown as ChatController, context: { run: localContext } as unknown as ChatContextService }
    registerIPC(...args)
    try {
      expect(await handlers.get(IPC.chatGet)!(event(2))).toEqual({ sessionId })
      expect(await handlers.get(IPC.chatContext)!(event(2), { action: 'connect', sessionId })).toEqual({ ok: true })
      expect(localContext).toHaveBeenCalledWith({ action: 'connect', sessionId })
      expect(onlineContext).not.toHaveBeenCalled()
      await handlers.get(IPC.command)!(event(2), 'open-chat')
      await handlers.get(IPC.command)!(event(2), 'close-chat')
      expect(command.mock.calls).toEqual([['open-panel'], ['close-panel']])
    } finally { controller.command = previousCommand }
  })
  it.each([IPC.chatStop, IPC.localVoiceStop, IPC.chatSend, IPC.chatSession, IPC.voiceBegin, IPC.voiceRecording, IPC.voiceTranscribe, IPC.voiceCancel])('allows trusted floating voice surfaces for %s', async (channel) => {
    for (const untrusted of [event(99), event(2, true), event(2, false, 'file:///other.html')]) await expect(handlers.get(channel)!(untrusted)).rejects.toThrow()
  })
  it('routes floating input only to the local controller and keeps online dictation separate', async () => {
    const send = vi.fn(() => ({ ok: true })), onlineSend = vi.fn(), begin = vi.fn(async () => ({ ok: true }))
    registerLocal({ send: onlineSend } as unknown as ChatController, { chat: { send, getSession: () => undefined } as unknown as ChatController, context: {} as ChatContextService }, { begin, snapshot: () => ({ phase: 'idle' }) } as unknown as VoiceController)
    expect(await handlers.get(IPC.chatSend)!(event(3), { text: 'Hello Athena.' })).toEqual({ ok: true })
    expect(send).toHaveBeenCalledWith({ text: 'Hello Athena.' })
    expect(onlineSend).not.toHaveBeenCalled()
    expect(await handlers.get(IPC.voiceBegin)!(event(3), { id: crypto.randomUUID(), sessionId: crypto.randomUUID() })).toMatchObject({ ok: false })
    expect(begin).not.toHaveBeenCalled()
    await expect(handlers.get(IPC.chatSession)!(event(3), { action: 'delete', id: crypto.randomUUID() })).rejects.toThrow('does not belong')
    await expect(handlers.get(IPC.chatContext)!(event(3), { action: 'project-delete' })).rejects.toThrow()
  })
  it('stops speech separately from tasks on the floating surface and honors interruption opt-out', async () => {
    const stopTask = vi.fn(() => ({ ok: true })), stopSpeech = vi.fn(), begin = vi.fn(async () => ({ ok: true }))
    const onlineStop = vi.fn()
    registerLocal({ stop: onlineStop } as unknown as ChatController, { chat: { stop: stopTask } as unknown as ChatController, context: {} as ChatContextService },
      { begin, snapshot: () => ({ phase: 'idle' }) } as unknown as VoiceController, { isBusy: () => true, stop: stopSpeech } as unknown as SpeechController)
    controller.settings.localVoice.allowSpeechInterruption = false
    try {
      expect(await handlers.get(IPC.voiceBegin)!(event(2), {})).toMatchObject({ ok: false })
      expect(begin).not.toHaveBeenCalled(); expect(stopSpeech).not.toHaveBeenCalled()
      expect(await handlers.get(IPC.localVoiceStop)!(event(2))).toEqual({ ok: true })
      expect(stopSpeech).toHaveBeenCalledOnce(); expect(stopTask).not.toHaveBeenCalled()
      expect(await handlers.get(IPC.chatStop)!(event(2))).toEqual({ ok: true })
      expect(stopTask).toHaveBeenCalledOnce()
      expect(onlineStop).not.toHaveBeenCalled()
    } finally { controller.settings.localVoice.allowSpeechInterruption = true }
  })
  it('preserves online project requests in the control window', async () => {
    const original = '00000000-0000-4000-a000-000000000100'
    const projectSession = '00000000-0000-4000-a000-000000000101'
    const workspace = { id: '00000000-0000-4000-a000-000000000102', name: 'React', fingerprint: 'a'.repeat(64) }
    let active = original
    const send = vi.fn(() => ({ ok: true })), draft = vi.fn()
    const chat = { current: () => ({ id: active }), snapshot: () => ({ phase: 'idle', sessions: [] }), workspaceReferences: () => [workspace], openWorkspace: () => { active = projectSession }, command: draft, send }
    const context = { workspaces: { authorized: () => true } }
    registerIPC(controller, methods as unknown as AIConfiguration, chat as unknown as ChatController, {} as PermissionService, context as unknown as ChatContextService)
    expect(await handlers.get(IPC.chatSend)!(event(1), { text: 'Open my React project.', sessionId: original })).toEqual({ ok: true })
    expect(send).toHaveBeenCalledWith({ text: 'Open my React project.', sessionId: projectSession })
    expect(draft).toHaveBeenCalledWith({ action: 'draft', id: original, text: '' })
  })
  it('re-resolves manually typed commands against the IPC registry and rejects unknown commands', async () => {
    const session = newConversation(), commandMeta = { id: 'project:build', name: '/platform-build', description: 'Build', source: 'Claude Project' as const, sourceFile: '.claude/commands/platform-build.md', scope: 'project' as const, execution: 'prompt' as const }
    const send = vi.fn(() => ({ ok: true })), list = vi.fn(async () => ({ commands: [commandMeta], globalEnabled: false }))
    const chat = { current: () => session, snapshot: () => ({ phase: 'idle' }), send, workspaceReferences: () => [] }
    registerIPC(controller, methods as unknown as AIConfiguration, chat as unknown as ChatController, {} as PermissionService, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, { list } as never)
    expect(await handlers.get(IPC.chatSend)!(event(), { text: '/platform-build MBM-11390', sessionId: session.id })).toEqual({ ok: true })
    expect(send).toHaveBeenCalledWith({ text: '/platform-build MBM-11390', sessionId: session.id }, { id: commandMeta.id, name: commandMeta.name, source: commandMeta.source, arguments: 'MBM-11390' })
    list.mockResolvedValueOnce({ commands: [], globalEnabled: false })
    expect(await handlers.get(IPC.chatSend)!(event(), { text: '/platform-typo MBM-11390', sessionId: session.id })).toMatchObject({ ok: false, message: expect.stringContaining('not registered') })
    expect(send).toHaveBeenCalledOnce()
  })
  it('routes only named operations from the trusted control frame', () => {
    const input = { apiKey: 'sk-test-only-not-a-real-api-key' }
    handlers.get(IPC.aiStatus)!(event())
    handlers.get(IPC.aiTest)!(event(), input)
    handlers.get(IPC.aiActivate)!(event(), input)
    handlers.get(IPC.aiModel)!(event(), { model: 'model-a' })
    handlers.get(IPC.aiRemove)!(event())
    expect(methods.getStatus).toHaveBeenCalledOnce()
    expect(methods.test).toHaveBeenCalledWith(input)
    expect(methods.activate).toHaveBeenCalledWith(input)
    expect(methods.selectModel).toHaveBeenCalledWith({ model: 'model-a' })
    expect(methods.remove).toHaveBeenCalledOnce()
  })
  it('keeps Cursor model choices per conversation and leaves new conversations unselected without a non-Auto default', async () => {
    const previous = controller.settings
    controller.settings = { ...structuredClone(defaultSettings), aiMode: 'cursor' }
    const cursor = { status: vi.fn(async () => ({ installed: true, authenticated: true, identity: 'test@example.invalid', version: '1', message: 'Connected', modelCatalogAvailable: true, models: [{ id: 'auto', label: 'Auto' }, { id: 'grok-4.7', label: 'Grok 4.7' }, { id: 'kimi-k2', label: 'Kimi K2' }] })) }
    const chat = new ChatController({ provider: async () => ({ testConnection: async () => true, async *streamMessage() {} }), changed: vi.fn(), phase: vi.fn() })
    try {
      registerIPC(controller, methods as unknown as AIConfiguration, chat, {} as PermissionService, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, cursor as never)
      const first = (await handlers.get(IPC.chatGet)!(event()) as { sessionId: string }).sessionId
      expect(chat.current().config.model).toBeNull()
      expect(await handlers.get(IPC.chatSession)!(event(), { action: 'configure-model', id: first, model: 'kimi-k2' })).toEqual({ ok: true })
      expect(chat.current().config).toMatchObject({ model: 'kimi-k2', cursorModel: 'kimi-k2' })
      expect(await handlers.get(IPC.chatSession)!(event(), { action: 'configure-model', id: first, model: 'not-listed' })).toMatchObject({ ok: false })
      expect(await handlers.get(IPC.chatSession)!(event(), { action: 'create' })).toEqual({ ok: true })
      expect(chat.current().config.model).toBeNull()
      await handlers.get(IPC.chatSession)!(event(), { action: 'switch', id: first })
      expect(chat.current().config.model).toBe('kimi-k2')
    } finally { chat.dispose(); controller.settings = previous }
  })
  it('validates and retains a parameterized Cursor selection through configure, reload and navigation', async () => {
    const previous = controller.settings
    controller.settings = { ...structuredClone(defaultSettings), aiMode: 'cursor' }
    const selection = 'grok-4.6[effort=medium,fast=false]'
    const cursor = { status: vi.fn(async () => ({
      installed: true, authenticated: true, modelCatalogAvailable: true,
      models: [{ id: 'cursor-grok-4.6-high-fast', label: 'Grok 4.6 Fast' }],
      modelConfigurations: [{ id: 'grok-4.6', name: 'Grok 4.6', options: [
        { id: 'effort', name: 'Effort', category: 'thought_level', currentValue: 'high', options: [{ value: 'medium', name: 'Medium' }, { value: 'high', name: 'High' }] },
        { id: 'fast', name: 'Fast', currentValue: 'true', options: [{ value: 'false', name: 'Off' }, { value: 'true', name: 'Fast' }] },
      ] }],
    })) }
    const chat = new ChatController({ provider: async () => ({ testConnection: async () => true, async *streamMessage() {} }), changed: vi.fn(), phase: vi.fn() })
    try {
      registerIPC(controller, methods as unknown as AIConfiguration, chat, {} as PermissionService, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, cursor as never)
      const first = chat.current().id
      expect(await handlers.get(IPC.chatSession)!(event(), { action: 'configure-model', id: first, model: selection })).toEqual({ ok: true })
      await handlers.get(IPC.chatGet)!(event())
      expect(chat.current().config.model).toBe(selection)
      expect(await handlers.get(IPC.chatSession)!(event(), { action: 'configure-model', id: first, model: 'grok-4.6[effort=max,fast=false]' })).toMatchObject({ ok: false })
      await handlers.get(IPC.chatSession)!(event(), { action: 'create' })
      await handlers.get(IPC.chatSession)!(event(), { action: 'switch', id: first })
      expect(chat.current().config.model).toBe(selection)
    } finally { chat.dispose(); controller.settings = previous }
  })
  it('keeps OpenAI Responses search available while ChatGPT Subscription handles conversation inference', async () => {
    const previous = controller.settings
    controller.settings = { ...structuredClone(defaultSettings), aiMode: 'subscription', webAccess: { ...defaultSettings.webAccess, webSearchEnabled: true, searchProvider: 'openai-built-in' } }
    const apiKey = 'sk-test-independent-openai-search-key'
    const ai = {
      ...methods,
      getStatus: vi.fn(async () => ({ ok: true, message: '', status: { provider: 'OpenAI', active: true, hasKey: true, model: 'gpt-5.5', models: ['gpt-5.5'], lastVerifiedAt: 1, connection: 'successful' } })),
      getActiveConfiguration: vi.fn(async () => ({ apiKey, model: 'gpt-5.5' })),
    }
    const search = { isOpenAIValidated: vi.fn(() => true), testOpenAI: vi.fn(async () => ({ ok: true, model: 'gpt-5.5', message: 'Live OpenAI search succeeded.' })) }
    try {
      registerIPC(controller, ai as unknown as AIConfiguration, {} as ChatController, {} as PermissionService,
        undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, search as never)
      expect(await handlers.get(IPC.webSearchStatus)!(event())).toMatchObject({ active: true, hasKey: true, model: 'gpt-5.5', validated: true })
      expect(await handlers.get(IPC.webSearchTest)!(event(), { model: 'gpt-5.5' })).toMatchObject({ ok: true })
      expect(ai.getActiveConfiguration).toHaveBeenCalledWith('gpt-5.5')
      expect(search.testOpenAI).toHaveBeenCalledWith(apiKey, 'gpt-5.5')
    } finally { controller.settings = previous }
  })
  it('uses the independently saved search model when the API key has no conversation model', async () => {
    const previous = controller.settings
    controller.settings = { ...structuredClone(defaultSettings), aiMode: 'subscription', webAccess: { ...defaultSettings.webAccess, webSearchEnabled: true, searchProvider: 'openai-built-in', openAIModel: 'gpt-4.1-mini' } }
    const apiKey = 'sk-test-independent-openai-search-key'
    const ai = {
      ...methods,
      getStatus: vi.fn(async () => ({ ok: true, message: '', status: { provider: 'OpenAI', active: true, hasKey: true, model: null, models: ['gpt-4.1-mini'], lastVerifiedAt: 1, connection: 'successful' } })),
      getActiveConfiguration: vi.fn(async (model: string) => ({ apiKey, model })),
    }
    const search = { isOpenAIValidated: vi.fn(() => false), testOpenAI: vi.fn(async () => ({ ok: true, model: 'gpt-4.1-mini', message: 'Live OpenAI search succeeded.' })) }
    try {
      registerIPC(controller, ai as unknown as AIConfiguration, {} as ChatController, {} as PermissionService,
        undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, search as never)
      expect(await handlers.get(IPC.webSearchStatus)!(event())).toMatchObject({ model: 'gpt-4.1-mini', availableModels: ['gpt-4.1-mini'], validated: false })
      expect(await handlers.get(IPC.webSearchTest)!(event())).toMatchObject({ ok: true })
      expect(ai.getActiveConfiguration).toHaveBeenCalledWith('gpt-4.1-mini')
      expect(search.testOpenAI).toHaveBeenCalledWith(apiKey, 'gpt-4.1-mini')
      expect(await handlers.get(IPC.webSearchTest)!(event(), { model: 'not-in-catalog' })).toMatchObject({ ok: false, message: expect.stringContaining('not available') })
      expect(search.testOpenAI).toHaveBeenCalledOnce()
    } finally { controller.settings = previous }
  })
  it('sanitizes async failures instead of exposing native or credential error text', async () => {
    methods.test.mockRejectedValueOnce(new Error('private-api-key and /private/user/path'))
    await expect(handlers.get(IPC.aiTest)!(event(), {})).rejects.toThrow('Athena could not complete that request.')
  })
  it('does not cancel chat when enabling unrelated permissions, and cancels only the affected work on revocation', async () => {
    const stop = vi.fn(), revoke = vi.fn(), cancel = vi.fn()
    registerIPC(controller, methods as unknown as AIConfiguration, { stopAll: stop } as unknown as ChatController,
      { setPreference: () => ({ ok: true }) } as unknown as PermissionService,
      { workspaces: { revoke } } as unknown as ChatContextService, { cancel } as unknown as VoiceController)
    const set = (permission: string, enabled: boolean) => handlers.get(IPC.permissionSet)!(event(), { permission, enabled })
    await set('desktopAutomation', true)
    expect(stop).not.toHaveBeenCalled(); expect(revoke).not.toHaveBeenCalled()
    await set('microphone', false)
    expect(cancel).toHaveBeenCalledOnce(); expect(stop).not.toHaveBeenCalled()
    for (const permission of ['applicationDetection', 'screenCapture', 'desktopAutomation']) await set(permission, false)
    expect(stop).toHaveBeenCalledTimes(3); expect(revoke).not.toHaveBeenCalled()
    await set('personalFiles', false)
    expect(stop).toHaveBeenCalledTimes(4); expect(revoke).toHaveBeenCalledOnce()
  })
})
