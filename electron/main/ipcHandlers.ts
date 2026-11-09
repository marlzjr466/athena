import { copilotCommandSchema } from '../../shared/copilot'
import type { CopilotService } from './ai/copilotService'
import { app, clipboard, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron'
import { stat, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { z } from 'zod'
import { VROID_ACTION_IDS } from '../../shared/vroidActions'
import { avatarIdSchema, importedAvatarId, modelNameSchema, clipReportSchema, IMPORT_STAGES } from '../../shared/avatarModels'
import { contextCommandSchema, sessionCommandSchema } from '../../shared/conversations'
import type { ChatContextService } from './ai/chatContextService'
import { IPC, commandSchema } from '../../shared/contracts'
import type { AthenaController } from './athenaController'
import { log } from './logger'
import type { AIConfiguration } from './ai/aiConfiguration'
import type { ChatController } from './ai/chatController'
import { chatCopySchema, chatInputSchema } from '../../shared/chat'
import { filesystemAccessSchema, permissionInputSchema, permissionPreferenceSchema } from '../../shared/permissions'
import type { PermissionService } from './permissions/permissionService'
import type { VoiceController } from './voice/voiceController'
import type { SpeechController } from './voice/speechController'
import type { ApplicationDetectionController } from './applicationDetection/applicationDetectionController'
import { ChatError } from './ai/AIProvider'
import type { OllamaService } from './ai/ollamaService'
import { localModelIdSchema } from '../../shared/localAI'
import { allocationNotice } from '../../shared/contextEngine'
import { contextConfirmations, contextDecisionFor, latestPromptUsage, probeLocalContext } from './ai/contextEngineRuntime'
import { localEngineReport } from './ai/engineSupportRuntime'
import { isLlamaValidation, llamaLongGguf, llamaLongMetadata } from '../../shared/llamaLongContext'
import { localVoicePreviewSchema, VOICE_PREVIEW_TEXT } from '../../shared/localVoice'
import type { SpeechService } from './voice/speechService'
import type { OfficialCSM } from './voice/officialCSM'
import { officialCSMCommandSchema } from '../../shared/officialCSM'
import type { HiggsTTS } from './voice/higgsTTS'
import { higgsCommandSchema } from '../../shared/higgsTTS'
import { emptyVoiceEngines } from '../../shared/localVoice'
import type { ChatGPTAuth } from './ai/chatGPTAuth'
import type { HandsFreeController } from './voice/handsFreeController'
import type { DesktopTools } from './desktop/desktopTools'
import type { ClaudeAPIConfiguration } from './ai/claudeAPI'
import type { CursorACPService } from './ai/cursorACP'
import type { CodexCLIService } from './ai/codexCLIService'
import { cursorModelFamily, cursorSelectableModels, defaultCursorModel, cursorModelAvailable, type CursorStatus } from '../../shared/cursor'
import { handsFreeReplySchema, handsFreeSpeechSchema, handsFreeSpeechPartSchema, handsFreeStateSchema } from '../../shared/handsFree'
import { slashCatalogRequestSchema, commandAtStart, type SlashCommandMeta } from '../../shared/slashCommands'
import type { SlashCommandService } from './ai/slashCommandService'
import type { WebSearchService } from './ai/webSearchService'
import { apiKeySchema, emptyAIStatus } from '../../shared/ai'
import { verifiedModelCapabilities } from '../../shared/modelCapabilities'
import { requireOnlineProvider, onlineContextSettings, ONLINE_SELECTION_REQUIRED } from './ai/onlineIsolation'
import { companionChannels, routeCompanionRequest, type CompanionConversation } from './ai/companionRouting'
import { LocalVoiceOwnership } from './voice/localVoiceOwnership'
import { aiOwnershipSchema } from '../../shared/aiOwnership'
import { academyCommandSchema } from '../../shared/academy'
import { academyCourses } from '../../shared/academyCourses'
import type { AcademyService } from './ai/academyService'
import { academyIntegrationCommandSchema } from '../../shared/academyIntegrations'
import type { AcademyIntegrations } from './ai/academyIntegrations'
import { academyStudioCommandSchema } from '../../shared/academyStudio'
import type { AcademyStudio } from './ai/academyStudio'
import type { AcademyTraining } from './ai/academyTraining'
import { trainingCommandSchema } from '../../shared/academyTraining'
import type { LocalWhisperTranscription } from './voice/localVoiceServices'
import { wakeAcknowledgementCacheKey } from './voice/wakeAcknowledgement'

interface AthenaChatRuntime extends CompanionConversation { commands?: SlashCommandService; focus(active: boolean, sessionId?: string): boolean }
type CachedLocalVoice = SpeechService & {
  generateCached?: (text: string, voice: Parameters<SpeechService['generate']>[1], speed: number, signal: AbortSignal, cacheKey: string, contextKey?: string) => Promise<{ bytes: Uint8Array; cached: boolean }>
}

export function registerIPC(controller: AthenaController, ai: AIConfiguration, chat: ChatController, permissions: PermissionService, context?: ChatContextService, voice?: VoiceController, speech?: SpeechController, applications?: ApplicationDetectionController, ollama?: OllamaService, localVoice?: CachedLocalVoice & { dispose?(): void }, chatGPT?: ChatGPTAuth, handsFree?: HandsFreeController, desktopActions?: DesktopTools, claudeAPI?: ClaudeAPIConfiguration, cursorACP?: CursorACPService, slashCommands?: SlashCommandService, webSearch?: WebSearchService, codexCLI?: CodexCLIService, companion?: CompanionConversation, athenaChat?: AthenaChatRuntime, academy?: AcademyService, academyIntegrations?: AcademyIntegrations, academyStudio?: AcademyStudio, localTranscription?: LocalWhisperTranscription, academyTraining?: AcademyTraining, officialCSM?: OfficialCSM, higgsTTS?: HiggsTTS, copilot?: CopilotService): void {
  controller.windows.control.webContents.on('render-process-gone', () => controller.avatarModels.interrupt())
  controller.windows.control.webContents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) controller.avatarModels.interrupt() })
  let previewAbort: AbortController | undefined
  let handsFreeSpeechAbort: AbortController | undefined
  let handsFreeSpeechRequest: string | undefined
  let emittedVoiceTraceId = ''
  let emittedVoiceTraceEvents = 0
  const voiceOwnership = new LocalVoiceOwnership(() => companion?.chat.current().id, () => JSON.stringify(controller.settings.localAI))
  const ownsVoice = (owner: unknown) => Boolean(handsFree?.canCapture(controller.windows.floating.webContents.id) && voiceOwnership.accepts(owner))
  const stopPreview = (exceptSenderId?: number) => {
    handsFreeSpeechAbort?.abort(); handsFreeSpeechAbort = undefined; handsFreeSpeechRequest = undefined
    previewAbort?.abort(); previewAbort = undefined
    for (const window of controller.windows.all()) if (!window.isDestroyed() && window.webContents.id !== exceptSenderId) window.webContents.send(IPC.localVoicePlaybackStopped)
  }
  function trusted(event: IpcMainInvokeEvent): void {
    if (!controller.windows.owns(event.sender) || event.senderFrame !== event.sender.mainFrame) throw new Error('Untrusted IPC sender')
    const url = event.senderFrame.url
    if (!controller.windows.isTrustedURL(event.sender, url)) throw new Error('Untrusted IPC origin')
  }
  function handle(channel: string, callback: (event: IpcMainInvokeEvent, input: unknown) => unknown): void {
    ipcMain.handle(channel, async (event, input: unknown) => {
      trusted(event)
      try { return await callback(event, input) }
      catch (error) {
        const classification = error instanceof z.ZodError ? 'invalid-arguments' : error instanceof ChatError ? 'handler-failed' : 'ipc-failure'
        log('ipc.request_failed', { channel, classification })
        throw new Error(error instanceof ChatError ? error.userMessage : error instanceof z.ZodError ? 'Invalid Athena request.' : 'Athena could not complete that request. Please try again.')
      }
    })
  }
  handle(IPC.snapshot, () => controller.snapshot())
  handle(IPC.vroidCatalog, (_event, input) => {
    // Old renderer reports remain compatible, but can only describe the bundled model.
    const payload = Array.isArray(input) ? { modelId: 'vroid-athena', clips: input } : input
    const { modelId, clips: reports } = z.object({ modelId: avatarIdSchema, clips: z.array(clipReportSchema).max(VROID_ACTION_IDS.length) }).strict().parse(payload)
    if (modelId !== controller.settings.avatarVariant) return controller.snapshot()
    controller.vroidActions.register(reports)
    controller.broadcast()
    return controller.snapshot()
  })
  handle(IPC.vroidPlay, (_event, input) => controller.vroidActions.trigger(z.enum(VROID_ACTION_IDS).parse(input)))
  handle(IPC.settings, (event, input) => {
    if (input && typeof input === 'object' && ['aiMode', 'strictOffline', 'localAI', 'localVoice', 'athenaChatAvatarLinked', 'chatGPTCodingBackend'].some((key) => key in input) && event.sender.id !== controller.windows.control.webContents.id) throw new ChatError('AI configuration is only available in Settings.')
    const previousVoice = JSON.stringify(controller.settings.localVoice), previousLocal = JSON.stringify(controller.settings.localAI)
    const snapshot = controller.updateSettings(input)
    if (previousVoice !== JSON.stringify(controller.settings.localVoice) || previousLocal !== JSON.stringify(controller.settings.localAI) || !controller.settings.voiceEnabled || controller.settings.voiceMuted || controller.settings.doNotDisturb) {
      speech?.stop(); stopPreview()
      if (previousVoice !== JSON.stringify(controller.settings.localVoice) || previousLocal !== JSON.stringify(controller.settings.localAI)) localVoice?.dispose?.()
    }
    handsFree?.reconcile()
    return snapshot
  })
  handle(IPC.command, (event, input) => {
    const command = commandSchema.parse(input)
    if (event.sender.id !== controller.windows.control.webContents.id) {
      if (command === 'open-chat') return controller.command('open-panel')
      if (command === 'close-chat') return controller.command('close-panel')
    }
    return controller.command(command)
  })
  handle(IPC.dragStart, (event) => {
    if (event.sender.id !== controller.windows.floating.webContents.id) throw new Error('Dragging is only available on the companion.')
    voice?.cancel('Voice input cancelled while dragging Athena.')
    controller.windows.panel.hide()
    controller.motion.beginDrag()
  })
  handle(IPC.dragEnd, (event) => {
    if (event.sender.id !== controller.windows.floating.webContents.id) throw new Error('Invalid drag source')
    return controller.motion.endDrag()
  })
  // Sensitive settings/chat APIs are limited to the trusted top-level control center.
  const aiHandle = (channel: string, callback: (input: unknown, event: IpcMainInvokeEvent) => unknown) => handle(channel, (event, input) => {
    if (event.sender.id !== controller.windows.control.webContents.id) throw new Error('This operation is only available in the control center.')
    return callback(input, event)
  })
  handle(IPC.avatarRead, async (_event, input) => controller.avatarModels.read(importedAvatarId.parse(input)))
  aiHandle(IPC.avatarModel, async (input) => {
    try {
      const value = z.discriminatedUnion('action', [
        z.object({ action: z.literal('pick') }).strict(),
        z.object({ action: z.literal('import'), token: z.string().uuid(), name: modelNameSchema }).strict(),
        z.object({ action: z.literal('rename'), id: importedAvatarId, name: modelNameSchema }).strict(),
        z.object({ action: z.literal('delete'), id: importedAvatarId }).strict(),
        z.object({ action: z.literal('thumbnail'), id: importedAvatarId, thumbnail: z.string().max(3_000_000) }).strict(),
        z.object({ action: z.literal('retry'), id: importedAvatarId }).strict(),
        z.object({ action: z.literal('progress'), id: importedAvatarId, stage: z.enum(IMPORT_STAGES) }).strict(),
        z.object({ action: z.literal('fail'), id: importedAvatarId, error: z.string().max(1000) }).strict(),
        z.object({ action: z.literal('finish'), id: importedAvatarId, thumbnail: z.string().max(3_000_000), clips: z.array(clipReportSchema).max(VROID_ACTION_IDS.length), scale: z.number().finite().positive().max(1000) }).strict(),
        z.object({ action: z.literal('preferences'), id: importedAvatarId, enabledActions: z.array(z.enum(VROID_ACTION_IDS)).max(VROID_ACTION_IDS.length), random: z.boolean() }).strict(),
      ]).parse(input)
      const models = controller.avatarModels
      if (value.action === 'pick') {
        const picked = await dialog.showOpenDialog(controller.windows.control, { title: 'Import VRM model', filters: [{ name: 'VRM avatars', extensions: ['vrm'] }], properties: ['openFile'] })
        return { ok: true, ...(picked.canceled || !picked.filePaths[0] ? {} : { pick: models.pick(picked.filePaths[0]) }) }
      }
      if (value.action === 'import') return { ok: true, model: await models.import(value.token, value.name) }
      if (value.action === 'rename') return { ok: true, model: models.rename(value.id, value.name) }
      if (value.action === 'delete') {
        if (models.get(value.id).importStatus === 'processing') throw new Error('Wait for this import to finish before deleting it.')
        const wasActive = controller.settings.avatarVariant === value.id
        if (wasActive) controller.updateSettings({ avatarVariant: 'vroid-athena' })
        try { models.delete(value.id) }
        catch (error) {
          if (wasActive && models.get(value.id).importStatus === 'ready') controller.updateSettings({ avatarVariant: value.id })
          throw error
        }
        return { ok: true }
      }
      if (value.action === 'thumbnail') {
        if (models.get(value.id).importStatus !== 'ready') throw new Error('Only ready models can update their portrait.')
        return { ok: true, model: await models.saveThumbnail(value.id, value.thumbnail) }
      }
      if (value.action === 'retry') {
        const model = models.get(value.id)
        if (model.importStatus !== 'error') throw new Error('Only failed imports can be retried.')
        try { await models.read(value.id) }
        catch {
          const picked = await dialog.showOpenDialog(controller.windows.control, { title: `Choose the VRM file for ${model.name} again`, filters: [{ name: 'VRM avatars', extensions: ['vrm'] }], properties: ['openFile'] })
          if (picked.canceled || !picked.filePaths[0]) return { ok: true }
          return { ok: true, model: await models.replaceFailedSource(value.id, picked.filePaths[0]) }
        }
        return { ok: true, model: models.update(value.id, { importStatus: 'processing', importError: undefined, stage: 'Loading geometry and textures' }) }
      }
      if (value.action === 'preferences') {
        const model = models.get(value.id)
        const allowed = new Set(model.compatibleAnimations.filter(c => c.duration).map(c => c.id))
        if (value.enabledActions.some(id => !allowed.has(id))) throw new Error('Only compatible actions can be enabled.')
        return { ok: true, model: models.update(value.id, { enabledActions: [...new Set(value.enabledActions)], animationSettings: { random: value.random, idleMs: 3000 } }) }
      }
      if (models.get(value.id).importStatus !== 'processing') throw new Error('This import is no longer processing.')
      if (value.action === 'progress') return { ok: true, model: models.update(value.id, { stage: value.stage }) }
      if (value.action === 'fail') return { ok: true, model: models.update(value.id, { importStatus: 'error', importError: value.error }) }
      return { ok: true, model: await models.finish(value.id, value.thumbnail, value.clips, value.scale) }
    } catch (error) { return { ok: false, error: error instanceof z.ZodError ? error.issues[0].message : error instanceof Error ? error.message : 'Model import failed.' } }
  })
  const conversationHandle = (channel: string, callback: (input: unknown, event: IpcMainInvokeEvent) => unknown, allowFloating = false) => handle(channel, (event, input) => {
    const id = event.sender.id
    if (id !== controller.windows.control.webContents.id && id !== controller.windows.panel.webContents.id
      && (!allowFloating || id !== controller.windows.floating.webContents.id)) throw new Error('This conversation surface cannot perform that action.')
    if (id !== controller.windows.control.webContents.id && companionChannels.has(channel)) {
      if (!companion) throw new ChatError('The local companion is unavailable.')
      return routeCompanionRequest(channel, input, companion)
    }
    return callback(input, event)
  })
  // Athena Chat has its own local-only controller, private storage and IPC
  // namespace. Control-center requests cannot be routed into online history.
  aiHandle(IPC.athenaChatGet, () => {
    if (!athenaChat) throw new ChatError('Athena Chat is unavailable.')
    athenaChat.chat.initializeModel(controller.settings.localAI.model)
    return athenaChat.chat.snapshot()
  })
  aiHandle(IPC.athenaChatSearch, (input) => athenaChat?.chat.search(z.object({ query: z.string().max(200) }).strict().parse(input).query) ?? [])
  aiHandle(IPC.athenaChatSend, async (input) => {
    if (!athenaChat) return { ok: false, message: 'Athena Chat is unavailable.' }
    const request = chatInputSchema.parse(input)
    try {
      if (request.sessionId !== athenaChat.chat.current().id) throw new ChatError('Local conversation changed. Retry in the current chat.')
      if ((request.commandId || commandAtStart(request.text)) && !athenaChat.commands) throw new ChatError('Local command registry is unavailable.')
      const resolved = await athenaChat.commands?.invocation(athenaChat.chat.current(), request.text, request.commandId)
      return athenaChat.chat.send(request, resolved)
    } catch (error) { return { ok: false, message: error instanceof ChatError ? error.userMessage : 'Could not load the command definition.' } }
  })
  aiHandle(IPC.athenaChatRetry, () => athenaChat?.chat.retry() ?? { ok: false, message: 'Athena Chat is unavailable.' })
  aiHandle(IPC.athenaChatStop, () => athenaChat?.chat.stop() ?? { ok: false, message: 'Athena Chat is unavailable.' })
  aiHandle(IPC.athenaChatClear, () => athenaChat?.chat.clear() ?? { ok: false, message: 'Athena Chat is unavailable.' })
  aiHandle(IPC.athenaChatFocus, (input) => {
    const { active, sessionId } = z.object({ active: z.boolean(), sessionId: z.string().uuid().optional() }).strict().parse(input)
    if (!athenaChat || !sessionId || !athenaChat.focus(active, sessionId)) return { ok: false, message: 'Athena Chat session changed. Reopen the active conversation.' }
    return { ok: true }
  })
  aiHandle(IPC.athenaChatSession, async (input) => {
    if (!athenaChat) return { ok: false, message: 'Athena Chat is unavailable.' }
    const parsed = sessionCommandSchema.safeParse(input)
    if (!parsed.success) return { ok: false, message: 'Invalid Athena Chat operation.' }
    const command = parsed.data
    if (['configure', 'configure-effort', 'project-permissions'].includes(command.action)) return { ok: false, message: 'This configuration is not available in Athena Chat.' }
    if (command.action === 'configure-model') {
      if (!ollama) return { ok: false, message: 'Ollama is unavailable.' }
      const model = localModelIdSchema.safeParse(command.model)
      if (!model.success) return { ok: false, message: 'Choose a valid installed local model.' }
      try {
        const details = await ollama.modelDetails(model.data)
        if (details.capabilities.length && !details.capabilities.includes('completion')) return { ok: false, message: 'This model does not advertise chat completion.' }
      } catch (error) { return { ok: false, message: error instanceof ChatError ? error.userMessage : 'The selected local model is unavailable.' } }
    }
    if (command.action === 'delete' && !command.confirmed) {
      const decision = await dialog.showMessageBox(controller.windows.control, { type: 'question', title: 'Delete local conversation?', message: 'Remove this Athena Chat conversation?', detail: 'A private recovery copy remains in Athena’s local conversation archive.', buttons: ['Cancel', 'Delete'], defaultId: 0, cancelId: 0, noLink: true })
      if (decision.response !== 1) return { ok: false, message: 'Deletion cancelled.' }
    }
    if (command.action === 'edit') {
      try {
        if (command.id !== athenaChat.chat.current().id) throw new ChatError('Local conversation changed.')
        const resolved = await athenaChat.commands?.invocation(athenaChat.chat.current(), command.text, command.commandId)
        if ((commandAtStart(command.text) || command.commandId) && !resolved) throw new ChatError('Local command registry is unavailable.')
        return athenaChat.chat.command(command, resolved)
      } catch (error) { return { ok: false, message: error instanceof ChatError ? error.userMessage : 'Could not resolve this command.' } }
    }
    return athenaChat.chat.command(command)
  })
  aiHandle(IPC.athenaChatContext, (input) => athenaChat?.context.run(contextCommandSchema.parse(input)) ?? { ok: false, message: 'Local file context is unavailable.' })
  conversationHandle(IPC.openExternalLink, async (input) => {
    const { url: raw } = z.object({ url: z.string().url().max(2048) }).strict().parse(input)
    const url = new URL(raw)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new ChatError('Only public HTTP and HTTPS links can be opened from a message.')
    try { await shell.openExternal(url.toString()); return { ok: true } }
    catch { return { ok: false, message: 'macOS could not open that web link.' } }
  })
  aiHandle(IPC.copilot, input => { if (!copilot) throw new ChatError('Copilot integration unavailable.'); return copilot.command(copilotCommandSchema.parse(input)) })
  conversationHandle(IPC.aiStatus, async () => {
    if (controller.settings.aiMode === 'local' || controller.settings.aiMode === 'unconfigured') return { ok: false, status: emptyAIStatus(), message: ONLINE_SELECTION_REQUIRED }
    if (controller.settings.aiMode === 'copilot') return copilot!.aiStatus()
    if (controller.settings.aiMode === 'claude-api') {
      if (!claudeAPI) throw new ChatError('Claude API settings are unavailable.')
      return claudeAPI.getStatus()
    }
    if (controller.settings.aiMode === 'cursor') {
      if (!cursorACP) throw new ChatError('Cursor CLI integration is unavailable.')
      const status = cursorACP.cachedStatus()
      const active = status.authenticated
      const models = cursorSelectableModels(status.models, status.modelCatalogAvailable)
      return { ok: true, message: status.message, status: { provider: 'Cursor Subscription' as const, active, hasKey: false, model: defaultCursorModel(status), models: models.map((model) => model.id), modelLabels: Object.fromEntries(models.map((model) => [model.id, model.label])), modelFamilies: Object.fromEntries(models.map((model) => [model.id, cursorModelFamily(model)])), modelCapabilities: Object.fromEntries(models.map((model) => [model.id, [...verifiedModelCapabilities(model.id, 'cursor-acp').capabilities]])), cursorModelConfigurations: status.modelConfigurations, modelCatalogAvailable: status.modelCatalogAvailable, lastVerifiedAt: null, connection: active ? 'successful' as const : 'not-tested' as const } }
    }
    if (controller.settings.aiMode !== 'subscription') return ai.getStatus()
    if (!chatGPT) throw new ChatError('ChatGPT sign-in is unavailable.')
    if (controller.settings.chatGPTCodingBackend === 'codex-cli' && chat.current().workspaces.length > 0) {
      if (!codexCLI) throw new ChatError('Codex CLI integration is unavailable.')
      const status = await codexCLI.status()
      const selected = chat.current().config.model
      const model = selected && status.models.some((entry) => entry.id === selected) ? selected : status.defaultModel
      const models = status.models
      const active = status.authenticated && models.length > 0
      return { ok: active, message: status.message, status: { provider: 'Codex CLI' as const, active, hasKey: false, model, models: models.map((entry) => entry.id), modelLabels: Object.fromEntries(models.map((entry) => [entry.id, entry.displayName])), modelEfforts: Object.fromEntries(models.map((entry) => [entry.id, entry.efforts])), lastVerifiedAt: status.checkedAt, connection: active ? 'successful' as const : 'failed' as const } }
    }
    const status = await chatGPT.status()
    return { ok: true, message: status.message, status: { provider: 'ChatGPT Subscription' as const, active: status.connected && status.planEnabled, hasKey: false, model: status.model, models: status.models.map((model) => model.slug), modelLabels: Object.fromEntries(status.models.map((model) => [model.slug, model.displayName])), lastVerifiedAt: null, connection: status.connected && status.planEnabled ? 'successful' as const : 'not-tested' as const } }
  })
  aiHandle(IPC.codexCLIStatus, async (input) => {
    if (!codexCLI) throw new ChatError('Codex CLI integration is unavailable.')
    const parsed = z.object({ refresh: z.boolean().optional() }).strict().safeParse(input ?? {})
    if (!parsed.success) throw new ChatError('Invalid Codex CLI status request.')
    return codexCLI.status(parsed.data.refresh ?? false)
  })
  aiHandle(IPC.applicationDetection, () => applications?.preview() ?? { ok: false, message: 'Application detection is unavailable.' })
  conversationHandle(IPC.speechBegin, (input, event) => {
    if (event.sender.id !== controller.windows.panel.webContents.id) return { ok: false, message: 'Companion speech is available only for its local conversation.' }
    stopPreview(event.sender.id)
    return speech?.begin(input, event.sender.id) ?? { ok: false, message: 'Voice output is unavailable.' }
  }, true)
  conversationHandle(IPC.speechNext, (input, event) => speech?.next(input, event.sender.id) ?? { ok: false, message: 'Voice output is unavailable.' }, true)
  conversationHandle(IPC.speechPlaying, (input, event) => speech?.playing(input, event.sender.id) ?? { ok: false }, true)
  conversationHandle(IPC.speechStop, (input, event) => speech?.stopRequest(input, event.sender.id) ?? { ok: true }, true)
  handle(IPC.speechLevel, (event, input) => {
    if (event.sender.id !== controller.windows.panel.webContents.id) return { ok: false }
    const { level } = z.object({ level: z.number().min(0).max(1) }).strict().parse(input)
    const floating = controller.windows.floating
    if (!floating.isDestroyed()) floating.webContents.send(IPC.speechLevelChanged, { level })
    return { ok: true }
  })
  aiHandle(IPC.officialCSM, async input => {
    const request = officialCSMCommandSchema.parse(input)
    if (!officialCSM) return { ok: false, message: 'Official CSM is not available in this app instance.' }
    try {
      if (request.action === 'status') return { ok: true, status: await officialCSM.status() }
      if (request.action === 'setup' || request.action === 'download') {
        const decision = await dialog.showMessageBox(controller.windows.control, { type: 'question', title: 'Official Sesame CSM', message: request.action === 'setup' ? 'Install the official CSM Python dependencies in a separate environment?' : 'Download the official CSM weights and required tokenizer and watermark models?', detail: 'Several GB of storage may be needed. Chatterbox remains unchanged. Hugging Face gated-model terms must be accepted by you; Athena never stores your token in settings or diagnostics.', buttons: ['Cancel', 'Continue'], defaultId: 0, cancelId: 0 })
        if (decision.response !== 1) return { ok: false, message: 'Cancelled.' }
        if (request.action === 'setup') await officialCSM.setup(); else await officialCSM.download()
      } else if (request.action === 'cancel') officialCSM.cancel()
      else if (request.action === 'unload') { speech?.stop(); stopPreview(); officialCSM.unload() }
      else if (request.action === 'import-reference') {
        const selection = await dialog.showOpenDialog(controller.windows.control, { title: 'Authorized CSM reference (1–20 second WAV)', properties: ['openFile'], filters: [{ name: 'WAV recording', extensions: ['wav'] }] })
        if (selection.canceled || !selection.filePaths[0]) return { ok: false, message: 'No recording selected.' }
        const referenceId = await officialCSM.importReference(selection.filePaths[0], request.transcript, request.speaker)
        return { ok: true, referenceId, status: await officialCSM.status() }
      } else if (request.action === 'remove-reference') {
        const decision = await dialog.showMessageBox(controller.windows.control, { type: 'warning', message: 'Remove this copied Sesame reference recording and transcript?', detail: 'The original recording and Chatterbox reference will not be changed.', buttons: ['Cancel', 'Remove'], defaultId: 0, cancelId: 0 })
        if (decision.response !== 1) return { ok: false, message: 'Cancelled.' }
        speech?.stop(); stopPreview(); await officialCSM.removeReference(request.id)
        if (controller.settings.localVoice.officialCSM.referenceId === request.id) controller.updateSettings({ localVoice: { ...controller.settings.localVoice, officialCSM: { ...controller.settings.localVoice.officialCSM, referenceId: undefined } } })
      }
      return { ok: true, status: await officialCSM.status() }
    } catch (error) { return { ok: false, message: officialCSM.error(error), status: await officialCSM.status() } }
  })
  aiHandle(IPC.higgsTTS, async input => {
    const request = higgsCommandSchema.parse(input)
    if (!higgsTTS) return { ok: false, message: 'Higgs TTS 3 is not available in this app instance.' }
    try {
      if (request.action === 'status') return { ok: true, status: await higgsTTS.status() }
      if (request.action === 'setup' || request.action === 'download' || request.action === 'remove') {
        const prompts = {
          setup: { title: 'Higgs TTS 3 runtime', message: 'Install isolated PyTorch/Transformers dependencies for official Higgs TTS 3?', detail: 'This does not download the approximately 9.3GB checkpoint. Chatterbox and Sesame remain unchanged. NVIDIA SGLang-Omni is not installed.' },
          download: { title: 'Higgs TTS 3 checkpoint', message: 'Download the official bosonai/higgs-tts-3-4b checkpoint (about 9.3GB)?', detail: 'Research and non-commercial terms apply; commercial embedding needs a separate Boson license. Athena reuses your existing Hugging Face CLI login if required and never stores a token in settings. Chatterbox and Sesame files are not overwritten.' },
          remove: { title: 'Remove Higgs model files', message: 'Remove the downloaded Higgs TTS 3 checkpoint from this Mac?', detail: 'The isolated runtime and imported Higgs references remain. Chatterbox and Sesame are not changed.' },
        } as const
        const prompt = prompts[request.action]
        const decision = await dialog.showMessageBox(controller.windows.control, { type: request.action === 'remove' ? 'warning' : 'question', title: prompt.title, message: prompt.message, detail: prompt.detail, buttons: ['Cancel', 'Continue'], defaultId: 0, cancelId: 0 })
        if (decision.response !== 1) return { ok: false, message: 'Cancelled.' }
        if (request.action === 'setup') await higgsTTS.setup()
        else if (request.action === 'download') await higgsTTS.download()
        else await higgsTTS.removeModel()
      } else if (request.action === 'verify') await higgsTTS.verify()
      else if (request.action === 'cancel') higgsTTS.cancel()
      else if (request.action === 'unload') { speech?.stop(); stopPreview(); higgsTTS.unload() }
      else if (request.action === 'import-reference') {
        const selection = await dialog.showOpenDialog(controller.windows.control, { title: 'Authorized Higgs reference (1–20 second WAV)', properties: ['openFile'], filters: [{ name: 'WAV recording', extensions: ['wav'] }] })
        if (selection.canceled || !selection.filePaths[0]) return { ok: false, message: 'No recording selected.' }
        const referenceId = await higgsTTS.importReference(selection.filePaths[0], request.transcript)
        return { ok: true, referenceId, status: await higgsTTS.status() }
      } else if (request.action === 'remove-reference') {
        const decision = await dialog.showMessageBox(controller.windows.control, { type: 'warning', message: 'Remove this copied Higgs reference recording and transcript?', detail: 'The original recording and other engines will not be changed.', buttons: ['Cancel', 'Remove'], defaultId: 0, cancelId: 0 })
        if (decision.response !== 1) return { ok: false, message: 'Cancelled.' }
        speech?.stop(); stopPreview(); await higgsTTS.removeReference(request.id)
        if (controller.settings.localVoice.higgs.referenceId === request.id) controller.updateSettings({ localVoice: { ...controller.settings.localVoice, higgs: { ...controller.settings.localVoice.higgs, referenceId: undefined } } })
      }
      return { ok: true, status: await higgsTTS.status() }
    } catch (error) { return { ok: false, message: higgsTTS.error(error), status: await higgsTTS.status() } }
  })
  // Obsolete community/MLX voice-management endpoints stay disabled.
  const voiceRemoved = () => ({ ok: false, message: 'Sesame and voice model management were removed. The original Chatterbox voice is available in Settings → Voice.' })
  aiHandle(IPC.localVoiceStatus, () => ({ runtime: 'unavailable', engines: emptyVoiceEngines('unavailable'), profiles: [] }))
  aiHandle(IPC.localVoiceInstall, voiceRemoved)
  aiHandle(IPC.localVoiceCancel, () => ({ ok: true }))
  aiHandle(IPC.localVoiceProfile, voiceRemoved)
  aiHandle(IPC.localVoiceManage, voiceRemoved)
  aiHandle(IPC.localVoicePreview, async (input, event) => {
    const options = localVoicePreviewSchema.parse(input ?? {})
    stopPreview(event.sender.id)
    speech?.stop()
    const settings = controller.settings
    if (!settings.voiceEnabled || settings.voiceMuted || settings.doNotDisturb) return { ok: false, message: 'Voice output is disabled, muted, or paused by Do Not Disturb.' }
    const request = new AbortController(); previewAbort = request
    try {
      if (!localVoice) throw new ChatError('Natural speech is unavailable.')
      const bytes = await localVoice.generate(options.text ?? VOICE_PREVIEW_TEXT, settings.voiceName, 1, request.signal)
      return request.signal.aborted ? { ok: false, message: 'Voice preview stopped.' } : { ok: true, bytes, mimeType: 'audio/wav' as const, index: 0, count: 1 }
    }
    catch (error) { return { ok: false, message: error instanceof ChatError ? error.userMessage : 'Local voice preview failed.' } }
    finally { if (previewAbort === request) previewAbort = undefined }
  })
  conversationHandle(IPC.localVoiceStop, (_input, event) => {
    stopPreview(event.sender.id); speech?.stop()
    handsFreeSpeechAbort?.abort(); handsFreeSpeechAbort = undefined; handsFreeSpeechRequest = undefined
    companion?.chat?.cancelHandsFreeReply?.(); controller.setSpeechState?.('idle')
    return { ok: true }
  }, true)
  conversationHandle(IPC.voiceBegin, async (input, event) => {
    if (event.sender.id !== controller.windows.control.webContents.id) return { ok: false, message: 'Use local hands-free voice from the companion.' }
    if (speech?.isBusy() && !controller.settings.localVoice.allowSpeechInterruption) return { ok: false, message: 'Athena is speaking. Use Stop Speaking first, or enable speech interruption in Settings → Voice.' }
    stopPreview(event.sender.id)
    speech?.stop()
    // The floating companion and control center are separate renderer
    // processes, but macOS exposes one microphone route. If the user moves
    // between them, release the previous renderer's stream before starting
    // the new capture instead of letting getUserMedia race the old stream.
    if (voice && voice.snapshot().phase !== 'idle') {
      voice.cancel('Voice input moved to the active conversation.')
      await new Promise((resolve) => setTimeout(resolve, 180))
    }
    const wasHandsFreeActive = Boolean(handsFree?.canCapture(controller.windows.floating.webContents.id))
    const result = await (voice?.begin(input) ?? Promise.resolve({ ok: false, message: 'Voice input is unavailable.' }))
    if (result.ok && wasHandsFreeActive) {
      // The floating renderer receives the voice state and releases its local
      // stream before this IPC allows the chat renderer to request the mic.
      handsFree?.deactivate(controller.windows.floating.webContents.id)
      await new Promise((resolve) => setTimeout(resolve, 180))
    }
    return result
  }, true)
  conversationHandle(IPC.voiceRecording, (input) => voice?.recording(input) ?? { ok: false }, true)
  conversationHandle(IPC.voiceTranscribe, (input) => voice?.transcribe(input) ?? { ok: false }, true)
  conversationHandle(IPC.voiceCancel, (input) => voice?.cancelRequest(input) ?? { ok: true }, true)
  conversationHandle(IPC.handsFreeEnable, async (input, event) => {
    const isFloating = event.sender.id === controller.windows.floating.webContents.id
    if (isFloating) {
      const sessionId = z.string().uuid().parse(input)
      if (companion?.chat.current().id !== sessionId) return { ok: false, message: 'Local voice conversation changed. Retry in the active Athena session.' }
      // Activation and lease issuance must be one synchronous main-process step:
      // an older request cannot resume after a newer session acquired its lease.
      const result = handsFree?.activate(event.sender.id)
      if (!result?.ok) return result ?? { ok: false, message: 'Hands-free voice is unavailable.' }
      const ownership = voiceOwnership.acquire()
      if (!ownership || ownership.sessionId !== sessionId) { handsFree?.deactivate(event.sender.id); return { ok: false, message: 'Local voice conversation changed. Retry in the active Athena session.' } }
      return { ...result, ownership }
    }
    if (event.sender.id !== controller.windows.control.webContents.id) throw new Error('Enable hands-free voice from Settings.')
    if (controller.settings.localAI.speechEngine !== 'whisper-cli' || !controller.settings.localAI.speechModelPath) return { ok: false, message: 'Select a local Whisper model in My Athena → Local AI setup → Local voice before enabling always-listening.' }
    const preference = permissions.setPreference({ permission: 'microphone', enabled: true })
    if (!preference.ok) return { ok: false, message: preference.message }
    let permission = permissions.getPermissionStatus('microphone')
    if (permission.canRequest) { await permissions.requestPermission({ permission: 'microphone' }); permission = permissions.getPermissionStatus('microphone') }
    if (!permission.capabilityAllowed) return { ok: false, message: permission.detail || 'Microphone permission was not granted. Hands-free listening remains off.' }
    controller.updateSettings({ voiceInteraction: { ...controller.settings.voiceInteraction, handsFreeEnabled: true } })
    return { ok: true }
  }, true)
  conversationHandle(IPC.handsFreeDisable, (input, event) => {
    if (event.sender.id === controller.windows.floating.webContents.id) {
      if (!voiceOwnership.release(input)) return { ok: false }
      handsFree?.deactivate(event.sender.id)
      controller.clearHandsFreeActivity?.()
      controller.setVoiceState(null); controller.setSpeechState('idle')
      controller.setHandsFreeState({ state: 'paused' })
      return { ok: true }
    }
    if (event.sender.id !== controller.windows.control.webContents.id) throw new Error('Disable hands-free voice from Athena.')
    controller.updateSettings({ voiceInteraction: { ...controller.settings.voiceInteraction, handsFreeEnabled: false } })
    handsFree?.deactivate()
    voiceOwnership.clear()
    companion?.chat.clearHandsFreeContext()
    return { ok: true }
  }, true)
  conversationHandle(IPC.handsFreeTranscribe, (input, event) => handsFree?.transcribe(event.sender.id, input) ?? { ok: false, message: 'Local hands-free transcription is unavailable.' }, true)
  conversationHandle(IPC.handsFreeCancelTranscription, (input, event) => {
    const id = z.object({ id: z.string().uuid() }).strict().parse(input).id
    handsFree?.cancel(event.sender.id, id); return { ok: true }
  }, true)
  conversationHandle(IPC.handsFreeReply, (input, event) => {
    if (event.sender.id !== controller.windows.floating.webContents.id) throw new Error('Voice-only replies are restricted to the floating companion.')
    if (!controller.settings.voiceInteraction.handsFreeEnabled) return { ok: false, message: 'Hands-free voice is disabled in Settings → Voice.' }
    const request = handsFreeReplySchema.parse(input)
    if (request.diagnosticDirect && app.isPackaged) return { ok: false, message: 'Direct inference diagnostics are available only in development builds.' }
    if (!request.ownership || !ownsVoice(request.ownership)) return { ok: false, message: 'Local voice session changed. Reactivate hands-free voice and retry.' }
    if (!companion) return { ok: false, message: 'The local companion is unavailable.' }
    return companion.chat.answerHandsFree(request, request.id ? (progress) => {
      try { if (!event.sender.isDestroyed() && ownsVoice(request.ownership)) event.sender.send(IPC.handsFreeReplyProgress, { id: request.id, ...progress, ownership: request.ownership }) }
      catch { /* A closed floating window must not fail the provider request. */ }
    } : undefined)
  }, true)
  conversationHandle(IPC.handsFreeCancelReply, (_input, event) => {
    if (event.sender.id !== controller.windows.floating.webContents.id) throw new Error('Voice cancellation is restricted to the floating companion.')
    companion?.chat.cancelHandsFreeReply(); return { ok: true }
  }, true)
  conversationHandle(IPC.handsFreeClearContext, (_input, event) => {
    if (event.sender.id !== controller.windows.floating.webContents.id) throw new Error('Voice context is restricted to the floating companion.')
    // Clearing the conversational LLM context must not discard Sesame's
    // selected voice anchor or force a costly model reload on the next wake.
    companion?.chat.clearHandsFreeContext(); return { ok: true }
  }, true)
  conversationHandle(IPC.handsFreeSpeak, async (input, event) => {
    if (event.sender.id !== controller.windows.floating.webContents.id) throw new Error('Voice-only playback is restricted to the floating companion.')
    const request = handsFreeSpeechSchema.parse(input)
    if (!request.ownership || !ownsVoice(request.ownership)) return { ok: false, message: 'Local voice session changed. Reactivate hands-free voice and retry.' }
    const settings = controller.settings
    if (!settings.voiceEnabled || settings.voiceMuted || settings.doNotDisturb) return { ok: false, message: 'Voice output is disabled, muted, or paused by Do Not Disturb.' }
    if (handsFreeSpeechRequest === request.id) return { ok: false, message: 'This voice response is already being prepared.' }
    stopPreview(event.sender.id); speech?.stop()
    const abort = new AbortController(); handsFreeSpeechAbort = abort; handsFreeSpeechRequest = request.id
    try {
      if (!localVoice) throw new ChatError('Natural speech is unavailable.')
      const contextKey = `handsfree:${request.ownership.sessionId}:${settings.localAI.model}`
      const cacheKey = request.cache ? wakeAcknowledgementCacheKey(settings, request.text) : undefined
      const generated = request.cache && localVoice.generateCached ? await localVoice.generateCached(request.text, settings.voiceName, settings.voiceSpeed, abort.signal, cacheKey!, contextKey) : { bytes: await localVoice.generate(request.text, settings.voiceName, settings.voiceSpeed, abort.signal, contextKey), cached: false }
      const bytes = generated.bytes
      if (abort.signal.aborted || handsFreeSpeechAbort !== abort || !ownsVoice(request.ownership)) return { ok: false, message: 'Voice response was cancelled.' }
      return { ok: true, id: request.id, bytes, cached: generated.cached, mimeType: 'audio/wav' as const }
    } catch (error) {
      return { ok: false, message: error instanceof ChatError ? error.userMessage : 'Local voice synthesis failed.' }
    } finally { if (handsFreeSpeechAbort === abort) { handsFreeSpeechAbort = undefined; handsFreeSpeechRequest = undefined } }
  }, true)
  conversationHandle(IPC.handsFreeSpeechNext, async (input, event) => {
    if (event.sender.id !== controller.windows.floating.webContents.id) throw new Error('Voice-only playback is restricted to the floating companion.')
    const request = handsFreeSpeechPartSchema.parse(input)
    if (!ownsVoice(request.ownership)) return { ok: false, message: 'Local voice session changed.' }
    return { ok: false, message: 'Sesame audio streaming has been removed. Start a new natural voice response.' }
  }, true)
  conversationHandle(IPC.handsFreeStopSpeech, (_input, event) => {
    if (event.sender.id !== controller.windows.floating.webContents.id) throw new Error('Voice-only playback is restricted to the floating companion.')
    handsFreeSpeechAbort?.abort(); handsFreeSpeechAbort = undefined; handsFreeSpeechRequest = undefined
    companion?.chat.cancelHandsFreeReply(); speech?.stop(); controller.setSpeechState('idle')
    return { ok: true }
  }, true)
  conversationHandle(IPC.handsFreePlayback, (input, event) => {
    if (event.sender.id !== controller.windows.floating.webContents.id) throw new Error('Voice-only playback is restricted to the floating companion.')
    const { playing, ownership } = z.object({ playing: z.boolean(), ownership: aiOwnershipSchema.optional() }).strict().parse(input)
    if (!ownsVoice(ownership)) return { ok: false }
    if (playing) { controller.setVoiceState(null); controller.setSpeechState('playing') }
    else controller.setSpeechState('idle')
    return { ok: true }
  }, true)
  conversationHandle(IPC.handsFreeState, (input, event) => {
    if (event.sender.id !== controller.windows.floating.webContents.id) throw new Error('Voice interaction state is restricted to the floating companion.')
    const status = handsFreeStateSchema.parse(input)
    if (!ownsVoice(status.ownership)) return { ok: false }
    const diagnostics = status.diagnostics
    if (process.env.NODE_ENV === 'development' && diagnostics?.traceId && diagnostics.traceEvents) {
      if (emittedVoiceTraceId !== diagnostics.traceId) { emittedVoiceTraceId = diagnostics.traceId; emittedVoiceTraceEvents = 0 }
      for (const item of diagnostics.traceEvents.slice(emittedVoiceTraceEvents)) log('voice.latency', { traceId: diagnostics.traceId, mode: diagnostics.traceMode ?? 'normal', stage: item.stage, timestamp: item.timestamp, elapsedMs: item.elapsedMs, durationMs: item.durationMs ?? 0, detail: item.detail ?? '' })
      emittedVoiceTraceEvents = diagnostics.traceEvents.length
    }
    if (process.env.NODE_ENV === 'development') status.diagnostics = { ...status.diagnostics, mainRssMb: Math.round(process.memoryUsage().rss / 1048576) }
    const { state } = status
    controller.setHandsFreeState(status)
    if (state === 'listening' || state === 'follow-up') controller.setVoiceState('listening')
    else if (state === 'processing') controller.setVoiceState('thinking')
    else if (state === 'standby' || state === 'paused' || state === 'error') controller.setVoiceState(null)
    if (state === 'speaking') { controller.setVoiceState(null); controller.setSpeechState('playing') }
    return { ok: true }
  }, true)
  conversationHandle(IPC.handsFreeOpenApp, async (input, event) => {
    if (event.sender.id !== controller.windows.floating.webContents.id || !controller.settings.voiceInteraction.handsFreeEnabled || !handsFree?.canCapture(event.sender.id)) throw new Error('Hands-free desktop actions require an active authorized wake-word session.')
    const action = z.discriminatedUnion('action', [z.object({ action: z.literal('open-app'), app: z.string(), confirmed: z.boolean().optional() }).strict(), z.object({ action: z.literal('focus-app'), app: z.string(), confirmed: z.boolean().optional() }).strict(), z.object({ action: z.literal('open-url'), url: z.string(), confirmed: z.boolean().optional() }).strict()]).parse(input)
    if (!companion) throw new ChatError('The local companion is unavailable.')
    const permissionMode = companion.chat.current().config.agentMode
    if (permissionMode === 'read-only') return { ok: false, status: 'denied', message: 'Read Only mode blocks desktop actions. Change the permission mode in this conversation before asking me to open it.' }
    if (permissionMode === 'ask' && !action.confirmed) return { ok: false, status: 'denied', message: 'This conversation requires your confirmation before desktop actions.' }
    const abort = new AbortController()
    return action.action === 'open-app' ? desktopActions!.openApplicationByVoice(action.app, abort.signal) : action.action === 'focus-app' ? desktopActions!.focusApplicationByVoice(action.app, abort.signal) : desktopActions!.openURLByVoice(action.url, abort.signal)
  }, true)
  conversationHandle(IPC.handsFreeSearchResult, (input, event) => {
    if (event.sender.id !== controller.windows.floating.webContents.id || !controller.settings.voiceInteraction.handsFreeEnabled || !handsFree?.canCapture(event.sender.id)) throw new Error('Search-result references require an active hands-free conversation.')
    const { index } = z.object({ index: z.number().int().min(1).max(10) }).strict().parse(input)
    const result = companion ? webSearch?.resultAt(companion.chat.current().id, index) : undefined
    return result ? { ok: true, url: result.url, title: result.title } : { ok: false, message: 'I do not have that search result anymore. Search again first.' }
  }, true)
  aiHandle(IPC.rememberedPermissionsSet, (input) => permissions.updateRemembered(input))
  aiHandle(IPC.permissionsGet, () => permissions.snapshot())
  aiHandle(IPC.permissionStatus, (input) => permissions.getPermissionStatus(permissionInputSchema.parse(input).permission))
  aiHandle(IPC.permissionSet, (input) => {
    const result = permissions.setPreference(input)
    const preference = permissionPreferenceSchema.safeParse(input)
    if (preference.success && !preference.data.enabled) {
      const permission = preference.data.permission
      if (permission === 'microphone') { voice?.cancel('Microphone access was disabled.'); handsFree?.deactivate() }
      else {
        chat.stopAll('Access was disabled. Pending tool work has stopped; previously completed actions and transmitted data cannot be recalled.')
        companion?.chat.stop('Access was disabled. Local tool work has stopped.')
        companion?.chat.cancelHandsFreeReply()
        if (permission === 'personalFiles') companion?.context.workspaces.revoke()
        if (permission === 'personalFiles') context?.workspaces.revoke()
      }
    }
    return result
  })
  aiHandle(IPC.filesystemAccessSet, async (input) => {
    const { mode } = z.object({ mode: filesystemAccessSchema }).strict().parse(input)
    if (mode !== 'project-only') {
      const answer = await dialog.showMessageBox(controller.windows.control, {
        type: 'warning', title: 'Authorize Full Mac Access?', message: mode === 'full-read-only' ? 'Allow Athena to read accessible files across this Mac?' : 'Allow Athena to read and edit accessible files across this Mac?',
        detail: 'This applies only to the currently selected AI provider/account. File contents requested by that provider may be sent to it. Files inside .claude and .codex folders, including credentials, require separate approval for each AI tool action. Other secret files remain blocked. Deletions, sensitive configuration changes, and development commands still need separate approval. macOS may require its own privacy permission for Desktop, Documents, Downloads, and other protected locations.',
        buttons: ['Cancel', 'Authorize Full Mac Access'], defaultId: 0, cancelId: 0, noLink: true,
      })
      if (answer.response !== 1) return { ok: false, message: 'Full Mac Access was not enabled.', snapshot: permissions.snapshot() }
    }
    const previousMode = permissions.filesystemMode()
    const result = permissions.setFilesystemMode(mode)
    // Do not abort preserved work for a failed save or an unchanged setting.
    // Successful scope changes cancel the old execution before any new tool
    // starts; explicit continuation constructs tools with the current grant.
    if (result.ok && previousMode !== permissions.filesystemMode()) chat.stopAll('Filesystem permission changed. Continue the preserved task with the current access mode; completed operations and file changes are retained.')
    if (result.ok && previousMode !== permissions.filesystemMode()) { companion?.chat.stop('Filesystem permission changed. Continue with the current access mode.'); companion?.chat.cancelHandsFreeReply() }
    return result
  })
  aiHandle(IPC.permissionRequest, (input) => permissions.requestPermission(input))
  aiHandle(IPC.permissionSettings, (input) => permissions.openPermissionSettings(input))
  aiHandle(IPC.permissionAllowed, (input) => permissions.isCapabilityAllowed(permissionInputSchema.parse(input).permission))
  aiHandle(IPC.aiTest, (input) => ai.test(input))
  aiHandle(IPC.aiActivate, (input) => ai.activate(input))
  aiHandle(IPC.aiModel, (input) => ai.selectModel(input))
  aiHandle(IPC.aiRemove, () => ai.remove())
  aiHandle(IPC.webSearchStatus, async () => {
    const settings = onlineContextSettings(controller.settings)
    const provider = settings.webAccess.searchProvider === 'brave' ? 'Brave Search API' as const : 'OpenAI built-in web search' as const
    let hasKey = false, model: string | null = null, availableModels: string[] = [], validated = false, note = ''
    if (settings.webAccess.searchProvider === 'brave') {
      try { hasKey = Boolean(await webSearch?.hasKey()) } catch { note = 'Could not read the saved Brave credential from macOS Keychain.' }
      if (!note) note = hasKey ? 'The Brave key is stored in macOS Keychain. Search usage follows the Brave API plan.' : 'A Brave Search API key is required; it is saved only to macOS Keychain.'
    } else {
      const openAI = await ai.getStatus()
      hasKey = openAI.status.hasKey
      availableModels = openAI.status.models
      model = settings.webAccess.openAIModel ?? openAI.status.model
      if (settings.strictOffline) note = 'Strict Offline Mode blocks OpenAI web search. Disable it in Settings → AI to make an external Responses API request.'
      else if (!hasKey) note = 'Configure an OpenAI API key in Settings → AI. A ChatGPT Plus subscription is not an API key; once configured, web search works independently of the selected chat provider.'
      else if (!openAI.status.active) note = 'Verify the OpenAI API key in Settings → AI before testing a web search.'
      else if (!model) note = 'Choose a search model below, then test it. This does not change the model or provider used for chat.'
      else if (!availableModels.includes(model)) note = `The selected search model (${model}) is unavailable for this API key. Choose another model below.`
      else {
        try {
          const config = await ai.getActiveConfiguration(model)
          validated = Boolean(webSearch?.isOpenAIValidated(config.apiKey, config.model))
          note = validated
            ? `A real Responses web_search request succeeded for ${config.model}. Search requests use this OpenAI API key and may incur API charges.`
            : `Model ${config.model} is connected but Responses web search has not yet been tested. Test Search Connection or let the first requested search verify it.`
        } catch { note = 'OpenAI API configuration could not be read. Check Settings → AI and unlock macOS Keychain.' }
      }
    }
    const active = settings.webAccess.webSearchEnabled && !settings.strictOffline && (settings.webAccess.searchProvider === 'brave' ? hasKey : hasKey && Boolean(model && availableModels.includes(model)) && validated)
    if (!settings.webAccess.webSearchEnabled) note = 'Web search is disabled in Settings → AI → Tools & Web Access.'
    return { hasKey, provider, active, model, availableModels, validated, strictOffline: settings.strictOffline, note }
  })
  aiHandle(IPC.webSearchTest, async (input) => {
    const parsed = input === undefined ? { success: true as const, data: {} } : z.object({ apiKey: apiKeySchema.optional(), model: z.string().min(1).max(200).optional() }).strict().safeParse(input)
    if (!parsed.success) return { ok: false, message: 'Enter a valid search credential or model selection.' }
    if (!webSearch) return { ok: false, message: 'Web search service is unavailable.' }
    if (controller.settings.webAccess.searchProvider === 'openai-built-in') {
      const status = await ai.getStatus()
      if (!status.status.hasKey) return { ok: false, message: 'Configure an OpenAI API key in Settings → AI. ChatGPT Subscription credentials cannot authorize OpenAI API web search.' }
      if (!status.status.active) return { ok: false, message: 'Verify the OpenAI API key in Settings → AI before testing web search.' }
      const model = parsed.data.model ?? controller.settings.webAccess.openAIModel ?? status.status.model
      if (!model) return { ok: false, message: 'Choose an OpenAI search model in Tools & Web Access, then test again. This does not change your chat provider.' }
      if (!status.status.models.includes(model)) return { ok: false, message: `The selected search model (${model}) is not available to this API key. Refresh the OpenAI API connection and choose another model.` }
      try {
        const config = await ai.getActiveConfiguration(model)
        return await webSearch.testOpenAI(config.apiKey, config.model)
      } catch (error) { return { ok: false, message: error instanceof ChatError ? error.userMessage : 'Could not securely read the OpenAI API configuration.' } }
    }
    return webSearch.test(parsed.data.apiKey)
  })
  aiHandle(IPC.webSearchSave, async (input) => {
    if (!webSearch) return { ok: false, message: 'Web search service is unavailable.' }
    const parsed = z.object({ apiKey: apiKeySchema }).strict().safeParse(input)
    if (!parsed.success) return { ok: false, message: 'Enter a valid Brave Search API key.' }
    const verified = await webSearch.test(parsed.data.apiKey)
    if (!verified.ok) return verified
    await webSearch.saveKey(parsed.data.apiKey)
    return { ok: true, message: 'Brave Search was verified and securely saved in macOS Keychain.', resultCount: verified.resultCount }
  })
  aiHandle(IPC.webSearchRemove, async () => {
    if (!webSearch) return { ok: false, message: 'Web search service is unavailable.' }
    await webSearch.removeKey()
    return { ok: true, message: 'The saved Brave Search API key was removed from macOS Keychain.' }
  })
  aiHandle(IPC.claudeStatus, () => claudeAPI?.getStatus() ?? Promise.reject(new ChatError('Claude API settings are unavailable.')))
  aiHandle(IPC.claudeTest, (input) => claudeAPI?.test(input) ?? Promise.reject(new ChatError('Claude API settings are unavailable.')))
  aiHandle(IPC.claudeActivate, (input) => claudeAPI?.activate(input) ?? Promise.reject(new ChatError('Claude API settings are unavailable.')))
  aiHandle(IPC.claudeModel, (input) => claudeAPI?.selectModel(input) ?? Promise.reject(new ChatError('Claude API settings are unavailable.')))
  aiHandle(IPC.claudeRemove, () => claudeAPI?.remove() ?? Promise.reject(new ChatError('Claude API settings are unavailable.')))
  aiHandle(IPC.cursorStatus, (input) => {
    const parsed = z.object({ refreshModels: z.boolean().optional(), cachedOnly: z.boolean().optional() }).strict().safeParse(input ?? {})
    if (!parsed.success) throw new ChatError('Invalid Cursor status request.')
    if (!cursorACP) throw new ChatError('Cursor CLI integration is unavailable.')
    return parsed.data.cachedOnly ? cursorACP.cachedStatus() : cursorACP.status(parsed.data.refreshModels ?? false)
  })
  aiHandle(IPC.cursorLogin, async () => {
    if (chat.hasActiveExecutions()) throw new ChatError('Finish or stop all running conversations before changing Cursor authentication.')
    return cursorACP?.login() ?? Promise.reject(new ChatError('Cursor CLI integration is unavailable.'))
  })
  aiHandle(IPC.cursorLogout, async () => {
    if (chat.hasActiveExecutions()) throw new ChatError('Finish or stop all running conversations before changing Cursor authentication.')
    return cursorACP?.logout() ?? Promise.reject(new ChatError('Cursor CLI integration is unavailable.'))
  })
  aiHandle(IPC.chatGPTStatus, () => chatGPT!.status())
  aiHandle(IPC.chatGPTAccountAdd, () => chatGPT!.beginAddAccount())
  aiHandle(IPC.chatGPTAccountRetry, () => chatGPT!.retryAddAccount())
  aiHandle(IPC.chatGPTAccountConfirm, (input) => {
    const value = z.object({ pendingId: z.string().uuid(), label: z.string().max(80).optional() }).strict().parse(input)
    const before = chatGPT!.status()
    return before.then(async (previous) => {
      const status = await chatGPT!.confirmPendingAccount(value.pendingId, value.label)
      const active = status.accounts.find((account) => account.id === status.activeAccountId)
      if (!previous.activeAccountId && active?.model && chat.snapshot().phase === 'idle' && chat.current().config.model !== active.model) await chat.command({ action: 'configure-model', id: chat.current().id, model: active.model })
      return status
    })
  })
  aiHandle(IPC.chatGPTAccountCancel, (input) => chatGPT!.cancelPendingAccount(z.object({ pendingId: z.string().uuid() }).strict().parse(input).pendingId))
  aiHandle(IPC.chatGPTAccountReconnect, (input) => chatGPT!.reconnectAccount(z.object({ accountId: z.string().uuid() }).strict().parse(input).accountId))
  aiHandle(IPC.chatGPTAccountSelect, (input) => {
    if (chat.hasActiveExecutions()) throw new ChatError('Finish or stop all running conversations before changing the ChatGPT account. Each request remains bound to its original account.')
    return chatGPT!.selectAccount(z.object({ accountId: z.string().uuid() }).strict().parse(input).accountId).then(async (status) => {
      const active = status.accounts.find((account) => account.id === status.activeAccountId)
      if (active?.model && chat.current().config.model !== active.model) await chat.command({ action: 'configure-model', id: chat.current().id, model: active.model })
      return status
    })
  })
  aiHandle(IPC.chatGPTAccountEnabled, (input) => {
    const value = z.object({ accountId: z.string().uuid(), enabled: z.boolean() }).strict().parse(input)
    return chatGPT!.setAccountEnabled(value.accountId, value.enabled)
  })
  aiHandle(IPC.chatGPTAccountRename, (input) => {
    const value = z.object({ accountId: z.string().uuid(), label: z.string().min(1).max(80) }).strict().parse(input)
    return chatGPT!.renameAccount(value.accountId, value.label)
  })
  aiHandle(IPC.chatGPTAccountRemove, async (input) => {
    const accountId = z.object({ accountId: z.string().uuid() }).strict().parse(input).accountId
    const account = (await chatGPT!.status()).accounts.find((entry) => entry.id === accountId)
    if (!account) throw new ChatError('That saved ChatGPT account no longer exists.')
    if (account.active && chat.hasActiveExecutions()) throw new ChatError('Finish or stop all running conversations before removing the active ChatGPT account.')
    const confirmation = await dialog.showMessageBox(controller.windows.control, { type: 'warning', title: 'Remove ChatGPT account?', message: `Remove ${account.label}${account.email ? ` (${account.email})` : ''} from Athena?`, detail: 'Athena will delete its saved credentials and request token revocation when OpenAI is reachable. Conversations and project data will remain unchanged.', buttons: ['Cancel', 'Remove account'], defaultId: 0, cancelId: 0, noLink: true })
    if (confirmation.response !== 1) return chatGPT!.status()
    return chatGPT!.removeAccount(accountId)
  })
  aiHandle(IPC.chatGPTSignIn, () => chatGPT!.beginAddAccount())
  aiHandle(IPC.chatGPTSignOut, () => chatGPT!.signOut())
  aiHandle(IPC.chatGPTModels, (input) => {
    const value = z.object({ accountId: z.string().uuid().optional() }).strict().parse(input ?? {})
    return chatGPT!.refreshModels(value.accountId)
  })
  aiHandle(IPC.chatGPTModel, async (input) => {
    const value = z.object({ model: z.string().min(1).max(200), accountId: z.string().uuid().optional() }).strict().parse(input)
    const before = await chatGPT!.status()
    const status = await chatGPT!.selectModel(value.model, value.accountId)
    const selectedAccountId = value.accountId ?? before.activeAccountId
    if (selectedAccountId === status.activeAccountId && chat.snapshot().phase === 'idle') chat.command({ action: 'configure-model', id: chat.current().id, model: value.model })
    return status
  })
  aiHandle(IPC.chatGPTUsage, () => shell.openExternal('https://chatgpt.com/settings/usage'))
  aiHandle(IPC.localStatus, async () => {
    const status = await ollama!.status()
    const modelPath = controller.settings.localAI.speechModelPath
    const model = modelPath ? await stat(modelPath).catch(() => null) : null
    const selected = status.models.find((entry) => entry.name === controller.settings.localAI.model) ?? null
    const engines = await localEngineReport(ollama!, selected, status.connected).catch(() => null)
    let llamaValidation = null
    try { const parsed = JSON.parse(readFileSync(join(app.getPath('userData'), 'llama-context-validation.json'), 'utf8')); llamaValidation = isLlamaValidation(parsed) ? parsed : null } catch { llamaValidation = null }
    const models = existsSync(llamaLongGguf) && !status.models.some((entry) => entry.name === llamaLongMetadata().name) ? [...status.models, llamaLongMetadata()] : status.models
    return { ...status, models, whisperModelAvailable: Boolean(model?.isFile()), contextAllocations: contextConfirmations(), lastPromptUsage: latestPromptUsage(), engineFindings: engines?.findings, longContextNote: engines?.note, llamaValidation }
  })
  aiHandle(IPC.localContextProbe, async (input) => {
    if (!ollama) throw new ChatError('Local model management is unavailable.')
    const { model, tokens } = z.object({ model: localModelIdSchema, tokens: z.number().int().min(2048).max(262144) }).strict().parse(input)
    const details = await ollama.modelDetails(model)
    const decision = contextDecisionFor(details, tokens, undefined)
    const notice = allocationNotice(decision)
    if (!notice.measureAllowed) return { ok: false, message: notice.measureReason }
    const result = await probeLocalContext(ollama, model, tokens)
    return { ok: result.ok, message: result.message }
  })
  aiHandle(IPC.localPull, async (input) => {
    if (!ollama) throw new ChatError('Local model management is unavailable.')
    const model = localModelIdSchema.parse(z.object({ model: localModelIdSchema }).strict().parse(input).model)
    const confirmation = await dialog.showMessageBox(controller.windows.control, {
      type: 'warning', title: 'Download local AI model?',
      message: `Download ${model} with Ollama?`,
      detail: 'This is a user-approved network download, even when Strict Offline Mode is on. Large models may use substantial disk space and may not fit this Mac’s memory. Athena will not send your conversations to the model registry.',
      buttons: ['Cancel', 'Download'], defaultId: 0, cancelId: 0,
    })
    if (confirmation.response !== 1) return { ok: false, message: 'Download cancelled.' }
    void ollama.pullModel(model, (progress) => { if (!controller.windows.control.isDestroyed()) controller.windows.control.webContents.send(IPC.localProgress, progress) })
      .catch(() => { if (!controller.windows.control.isDestroyed()) controller.windows.control.webContents.send(IPC.localProgress, { model, status: 'Download failed or cancelled', done: true, error: 'Model download did not complete.' }) })
    return { ok: true, message: `Downloading ${model}.` }
  })
  aiHandle(IPC.localCancelPull, () => { ollama?.cancelPull(); return { ok: true } })
  aiHandle(IPC.localDelete, async (input) => {
    if (!ollama) throw new ChatError('Local model management is unavailable.')
    const { model } = z.object({ model: localModelIdSchema }).strict().parse(input)
    if (controller.settings.localAI.model === model || controller.settings.localAI.visionModel === model) throw new ChatError('Select a different local model before removing this one.')
    const result = await dialog.showMessageBox(controller.windows.control, { type: 'warning', title: 'Remove local model?', message: `Remove ${model} from Ollama?`, buttons: ['Cancel', 'Remove'], defaultId: 0, cancelId: 0 })
    if (result.response !== 1) return { ok: false, message: 'Removal cancelled.' }
    await ollama.deleteModel(model)
    return { ok: true, message: `${model} removed.` }
  })
  aiHandle(IPC.academyGet, () => academy?.snapshot() ?? { profiles: [], sources: [], evaluations: [] })
  aiHandle(IPC.academyTrainingGet, async () => {
    if (!academyTraining) return { runtime: { ready: false, metalAvailable: false, message: 'Training service is unavailable.' }, profiles: [], jobs: [], comparisons: [] }
    await academyTraining.inspectRuntime()
    return academyTraining.snapshot()
  })
  aiHandle(IPC.academyTrainingCommand, async input => {
    if (!academyTraining || !ollama) return { ok: false, snapshot: { runtime: { ready: false, metalAvailable: false, message: 'Training service is unavailable.' }, profiles: [], jobs: [], comparisons: [] }, message: 'Training service is unavailable.' }
    try {
      const command = trainingCommandSchema.parse(input)
      if (command.action === 'cancel') { academyTraining.mlx?.cancel(); return { ok: academyTraining.cancel(), snapshot: academyTraining.snapshot(), message: 'Cancellation requested. Completed adapter checkpoints will be preserved.' } }
      const report = (progress: import('../../shared/academyTraining').TrainingProgress) => {
        if (!controller.windows.control.isDestroyed()) controller.windows.control.webContents.send(IPC.academyTrainingProgress, progress)
      }
      if (command.action === 'install-runtime') {
        const decision = await dialog.showMessageBox(controller.windows.control, { type: 'question', title: 'Set up local MLX training?', message: 'Install a dedicated Python 3.11 MLX-LM training environment?', detail: 'Athena installs mlx-lm[train], MLX, Hugging Face Hub and dataset tooling into ~/.athena/models/training/runtime. This needs network access and disk space. It will not change your voice Python environment, download model weights, or start training.', buttons: ['Cancel', 'Install runtime'], defaultId: 0, cancelId: 0 })
        if (decision.response !== 1) return { ok: false, snapshot: academyTraining.snapshot(), message: 'Runtime installation cancelled.' }
        await academyTraining.installRuntime(report)
        return { ok: true, snapshot: academyTraining.snapshot(), message: 'Dedicated MLX training runtime is ready.' }
      }
      if (command.action === 'rollback-model') {
        const registration = academyTraining.mlx?.list().find(item => item.baseModel === command.model)
        if (!registration) throw new Error('No activated MLX model has a saved rollback selection.')
        if (registration.previousModel) await ollama.modelDetails(registration.previousModel)
        controller.updateSettings({ localAI: { ...controller.settings.localAI, model: registration.previousModel } })
        return { ok: true, snapshot: academyTraining.snapshot(), message: `Restored previous local model: ${registration.previousModel ?? 'none'}. Existing conversations keep their own model selection.` }
      }
      const model = await ollama.modelDetails(command.model ?? '')
      const tags = await (await ollama.call('api/tags', undefined, undefined, 5000)).json() as { models?: Array<{ name: string; digest?: string }> }
      model.digest = tags.models?.find(item => item.name === model.name)?.digest
      if (command.action === 'activate-adapter') {
        if (!academyTraining.mlx) throw new Error('Native MLX inference is unavailable.')
        const source = academyTraining.activationSource(model, command.jobId, command.adapter)
        const registered = await academyTraining.mlx.activate(source, controller.settings.localAI.model)
        controller.updateSettings({ localAI: { ...controller.settings.localAI, model: registered.id } })
        return { ok: true, snapshot: academyTraining.snapshot(), message: `Activated ${registered.label} using native MLX. Base and adapter generation verified; ${registered.adapterTensorCount} adapter tensors loaded. ${registered.toolsVerified ? 'Structured tool-call probe passed.' : 'Tool calls did not pass verification; text chat is available.'} Select it in Athena Chat for existing conversations.` }
      }
      if (command.action === 'configure') academyTraining.configure(model, command.settings)
      if (command.action === 'export-adapter') {
        const archive = await academyTraining.exportAdapter(model, command.jobId)
        const picked = await dialog.showSaveDialog(controller.windows.control, { title: 'Export MLX adapter', defaultPath: 'athena-mlx-adapter.zip', filters: [{ name: 'Adapter archive', extensions: ['zip'] }] })
        if (picked.canceled || !picked.filePath) return { ok: false, snapshot: academyTraining.snapshot(), message: 'Export cancelled.' }
        await writeFile(picked.filePath, archive, { flag: 'wx', mode: 0o600 })
        return { ok: true, snapshot: academyTraining.snapshot(), message: 'MLX adapter and configuration exported.' }
      }
      if (command.action === 'checkpoint-local') {
        const picked = await dialog.showOpenDialog(controller.windows.control, { title: 'Select an MLX-compatible source checkpoint folder', properties: ['openDirectory'] })
        if (picked.canceled || !picked.filePaths[0]) return { ok: false, snapshot: academyTraining.snapshot(), message: 'Checkpoint selection cancelled.' }
        academyTraining.registerCheckpoint(model, picked.filePaths[0])
      }
      if (command.action === 'checkpoint-download') {
        const decision = await dialog.showMessageBox(controller.windows.control, { type: 'question', title: 'Download a source checkpoint?', message: `Download ${command.repository} for ${model.name}?`, detail: 'This downloads model weights from Hugging Face into Athena’s private training storage. Review the model card, license, disk needs and source identity first. A matching family does not prove this is the same checkpoint used by the Ollama model. Athena will never train its Ollama inference blob or send your dataset to the source repository.', buttons: ['Cancel', 'Download'], defaultId: 0, cancelId: 0 })
        if (decision.response !== 1) return { ok: false, snapshot: academyTraining.snapshot(), message: 'Download cancelled.' }
        await academyTraining.downloadCheckpoint(model, command.repository, report)
      }
      if (command.action === 'dataset') {
        const picked = await dialog.showOpenDialog(controller.windows.control, { title: 'Choose private training examples', properties: ['openFile'], filters: [{ name: 'JSON Lines training data', extensions: ['jsonl', 'JSONL'] }] })
        if (picked.canceled || !picked.filePaths[0]) return { ok: false, snapshot: academyTraining.snapshot(), message: 'Dataset selection cancelled.' }
        const imported = academyTraining.importDataset(model, picked.filePaths[0])
        return { ok: true, snapshot: academyTraining.snapshot(), message: `Imported ${imported.fileName}: ${imported.exampleCount.toLocaleString()} examples (${imported.train.toLocaleString()} train, ${imported.valid.toLocaleString()} validation, ${imported.test.toLocaleString()} test).` }
      }
      if (command.action === 'dataset-mode') {
        academyTraining.setDatasetMode(model, command.mode)
        return { ok: true, snapshot: academyTraining.snapshot(), message: `${command.mode === 'manual' ? 'Manual' : 'Automatic'} Split selected.` }
      }
      if (command.action === 'dataset-split-import') {
        try {
          const imported = academyTraining.importSplitText(model, command.split, command.fileName, command.content)
          return { ok: true, snapshot: academyTraining.snapshot(), message: `Imported ${imported.fileName}: ${imported.exampleCount} validated ${command.split === 'valid' ? 'validation' : command.split} examples.` }
        } catch (error) { throw new Error(`${command.fileName}: ${error instanceof Error ? error.message : 'Dataset import failed.'}`) }
      }
      if (command.action === 'dataset-import') {
        let imported: ReturnType<typeof academyTraining.importDatasetText>
        try { imported = academyTraining.importDatasetText(model, command.fileName, command.content) }
        catch (error) { throw new Error(`${command.fileName}: ${error instanceof Error ? error.message : 'Dataset validation failed.'}`) }
        return { ok: true, snapshot: academyTraining.snapshot(), message: `Imported ${imported.fileName}: ${imported.exampleCount.toLocaleString()} examples (${imported.train.toLocaleString()} train, ${imported.valid.toLocaleString()} validation, ${imported.test.toLocaleString()} test).` }
      }
      if (command.action === 'evaluation-import') {
        const imported = academyTraining.importEvaluationText(model, command.fileName, command.content)
        return { ok: true, snapshot: academyTraining.snapshot(), message: `Imported independent evaluation set ${imported.name}: ${imported.count} labeled examples (${imported.counts.coding} coding, ${imported.counts.git} Git, ${imported.counts.jira} Jira). Training data and adapters were not changed.` }
      }
      if (command.action === 'train' || command.action === 'resume') {
        const decision = await dialog.showMessageBox(controller.windows.control, { type: 'question', title: 'Start local adapter training?', message: `Train an MLX adapter for ${model.name}?`, detail: 'Athena uses your saved training configuration, a separate checkpoint and private dataset, a 1024-token sequence limit and gradient checkpointing. This uses local CPU/GPU, memory and disk. It does not replace the active Ollama model.', buttons: ['Cancel', 'Start training'], defaultId: 0, cancelId: 0 })
        if (decision.response !== 1) return { ok: false, snapshot: academyTraining.snapshot(), message: 'Training cancelled.' }
        const resume = command.action === 'resume' ? academyTraining.snapshot().jobs.find(item => item.id === command.jobId) : undefined
        if (command.action === 'resume' && !resume) throw new Error('Training checkpoint not found.')
        const job = await academyTraining.train(model, command.iterations, report, resume)
        return { ok: job.stage === 'completed', snapshot: academyTraining.snapshot(), message: job.stage === 'completed' ? 'Adapter saved. Evaluate it before any manual deployment; the active Ollama model is unchanged.' : job.error }
      }
      if (command.action === 'evaluate') await academyTraining.evaluate(model, command.jobId, report)
      if (command.action === 'compare') {
        await academyTraining.compare(model, command.jobId, report)
        return { ok: true, snapshot: academyTraining.snapshot(), message: 'Comparison completed locally. No checkpoint was deployed or training rerun.' }
      }
      if (command.action === 'review-example') {
        academyTraining.reviewExample(model, command.comparisonId, command.exampleId, command.variantId, command.decision, command.note)
        return { ok: true, snapshot: academyTraining.snapshot(), message: 'Manual benchmark review saved. No checkpoint was deployed.' }
      }
      if (command.action === 'select-adapter') academyTraining.selectAdapter(model, command.jobId, command.adapter)
      return { ok: true, snapshot: academyTraining.snapshot() }
    } catch (error) { return { ok: false, snapshot: academyTraining.snapshot(), message: error instanceof Error ? error.message : 'Training operation failed.' } }
  })
  aiHandle(IPC.academyIntegrationsGet, async () => academyIntegrations?.statuses() ?? [])
  aiHandle(IPC.academyIntegrationsCommand, async input => {
    if (!academyIntegrations) return { ok: false, statuses: [], message: 'Code-host integrations are unavailable.' }
    try {
      const command = academyIntegrationCommandSchema.parse(input)
      if (command.action === 'connect') await academyIntegrations.connect(command.provider, command.token)
      if (command.action === 'disconnect') {
        const confirmation = await dialog.showMessageBox(controller.windows.control, { type: 'question', title: 'Disconnect code host?', message: `Remove the saved ${command.provider} credential from macOS Keychain?`, buttons: ['Cancel', 'Disconnect'], defaultId: 0, cancelId: 0 })
        if (confirmation.response !== 1) return { ok: false, statuses: await academyIntegrations.statuses(), message: 'Disconnect cancelled.' }
        await academyIntegrations.disconnect(command.provider)
      }
      const review = command.action === 'inspect-review' ? await academyIntegrations.inspectReview(command.provider, command.repository, command.number) : undefined
      return { ok: true, statuses: await academyIntegrations.statuses(), review }
    } catch (error) { return { ok: false, statuses: await academyIntegrations.statuses(), message: error instanceof Error && !(error instanceof z.ZodError) ? error.message : 'Invalid integration request.' } }
  })
  aiHandle(IPC.academyStudioGet, () => academyStudio?.snapshot() ?? { meetings: [], interviews: [], attempts: [] })
  aiHandle(IPC.academyStudioCommand, async input => {
    if (!academyStudio || !ollama) return { ok: false, snapshot: { meetings: [], interviews: [], attempts: [] }, message: 'Practice & Notes is unavailable.' }
    try {
      const command = academyStudioCommandSchema.parse(input)
      if (command.action === 'cancel') return { ok: academyStudio.cancel(), snapshot: academyStudio.snapshot(), message: 'Cancellation requested.' }
      if (command.action === 'delete-meeting' || command.action === 'delete-interview' || command.action === 'delete-coding-attempt') {
        const kind = command.action === 'delete-meeting' ? 'meeting' : command.action === 'delete-interview' ? 'interview' : 'coding-attempt'
        const snapshot = academyStudio.snapshot()
        const exists = kind === 'meeting' ? snapshot.meetings.some(item => item.id === command.id) : kind === 'interview' ? snapshot.interviews.some(item => item.id === command.id) : snapshot.attempts.some(item => item.id === command.id)
        if (!exists) throw new Error('This Practice & Notes record is unavailable.')
        const decision = await dialog.showMessageBox(controller.windows.control, { type: 'warning', title: 'Delete local record?', message: `Permanently delete this ${kind} record from Athena?`, buttons: ['Cancel', 'Delete'], defaultId: 0, cancelId: 0 })
        if (decision.response !== 1) return { ok: false, snapshot: academyStudio.snapshot(), message: 'Deletion cancelled.' }
        academyStudio.remove(kind, command.id)
      }
      if (command.action === 'export-meeting') {
        const markdown = academyStudio.meetingMarkdown(command.id)
        const choice = await dialog.showSaveDialog(controller.windows.control, { title: 'Export local meeting notes', defaultPath: `athena-meeting-${command.id.slice(0, 8)}.md`, filters: [{ name: 'Markdown', extensions: ['md'] }] })
        if (choice.canceled || !choice.filePath) return { ok: false, snapshot: academyStudio.snapshot(), message: 'Export cancelled.' }
        try { await writeFile(choice.filePath, markdown, { flag: 'wx', mode: 0o600 }) }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('That file already exists. Choose a new name; no file was overwritten.'); throw error }
      }
      if (command.action === 'prepare-meeting' || command.action === 'start-interview') {
        // The selected installed model is verified by Ollama's chat request.
        // Avoid a separate uncancellable /api/show request before the Studio job exists.
        const model = { name: command.model, size: 0, capabilities: [] }
        if (command.action === 'prepare-meeting') await academyStudio.prepareMeeting(model, command.transcript)
        else await academyStudio.startInterview(model, command.mode, command.topic)
      }
      if (command.action === 'answer-interview') {
        const session = academyStudio.snapshot().interviews.find(item => item.id === command.id)
        if (!session) throw new Error('This practice question is unavailable.')
        await academyStudio.answerInterview({ name: session.model, size: 0, capabilities: [] }, command.id, command.answer)
      }
      if (command.action === 'run-coding-practice') await academyStudio.runCodingPractice(command.model, command.challenge, command.code)
      if (command.action === 'import-meeting-audio') {
        if (!localTranscription) throw new Error('Local Whisper transcription is unavailable.')
        const picked = await dialog.showOpenDialog(controller.windows.control, { title: 'Import an authorized meeting audio excerpt', message: 'Select audio you have permission to transcribe. Athena processes it locally and does not start the microphone.', properties: ['openFile'], filters: [{ name: 'Meeting audio', extensions: ['wav', 'mp3', 'm4a', 'aiff', 'aif'] }] })
        if (picked.canceled || !picked.filePaths[0]) return { ok: false, snapshot: academyStudio.snapshot(), message: 'Audio import cancelled.' }
        const transcript = await academyStudio.transcribeMeetingAudio(picked.filePaths[0], localTranscription)
        return { ok: true, snapshot: academyStudio.snapshot(), transcript, message: 'Local transcription ready. Review or edit it before preparing notes.' }
      }
      return { ok: true, snapshot: academyStudio.snapshot() }
    } catch (error) { return { ok: false, snapshot: academyStudio.snapshot(), message: error instanceof Error && !(error instanceof z.ZodError) ? error.message : 'Invalid Practice & Notes request.' } }
  })
  aiHandle(IPC.academyCommand, async (input) => {
    if (!academy || !ollama) return { ok: false, snapshot: { profiles: [], sources: [], evaluations: [] }, message: 'Athena Academy is unavailable.' }
    try {
      const command = academyCommandSchema.parse(input)
      if (command.action === 'cancel-evaluation') return { ok: academy.cancelEvaluation(), snapshot: academy.snapshot(), message: 'Evaluation cancellation requested.' }
      if (command.action === 'cancel-index') return { ok: academy.cancelIndex(), snapshot: academy.snapshot(), message: 'Index cancellation requested.' }
      if (command.action === 'remove-source' && (!command.model || !command.courseId)) {
        const source = academy.snapshot().sources.find(item => item.id === command.sourceId)
        if (!source) throw new Error('The knowledge source is unavailable.')
        const decision = await dialog.showMessageBox(controller.windows.control, { type: 'warning', title: 'Remove knowledge source?', message: `Remove ${source.name} from Athena Academy?`, detail: 'This removes the private Academy copy and unlinks it from every model. Your original file is untouched.', buttons: ['Cancel', 'Remove'], defaultId: 0, cancelId: 0 })
        if (decision.response !== 1) return { ok: false, snapshot: academy.snapshot(), message: 'Removal cancelled.' }
        await academy.removeSource(command.sourceId)
        return { ok: true, snapshot: academy.snapshot() }
      }
      if (command.action === 'remove-correction') {
        const entry = academy.snapshot().corrections?.find(item => item.id === command.id)
        if (!entry) throw new Error('Correction entry not found.')
        const decision = await dialog.showMessageBox(controller.windows.control, { type: 'warning', title: 'Delete approved correction?', message: `Remove this saved correction from ${entry.model}?`, buttons: ['Cancel', 'Delete'], defaultId: 0, cancelId: 0 })
        if (decision.response !== 1) return { ok: false, snapshot: academy.snapshot(), message: 'Deletion cancelled.' }
        academy.removeCorrection(command.id)
        return { ok: true, snapshot: academy.snapshot() }
      }
      if (command.action === 'export-corrections') {
        const output = academy.exportCorrections(command.model)
        const picked = await dialog.showSaveDialog(controller.windows.control, { title: 'Export approved Academy corrections', defaultPath: 'athena-academy-corrections.json', filters: [{ name: 'JSON', extensions: ['json'] }] })
        if (picked.canceled || !picked.filePath) return { ok: false, snapshot: academy.snapshot(), message: 'Export cancelled.' }
        try { await writeFile(picked.filePath, output, { flag: 'wx', mode: 0o600 }) }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('That file already exists. Choose another filename; no file was overwritten.'); throw error }
        return { ok: true, snapshot: academy.snapshot(), message: 'Approved corrections exported.' }
      }
      if (command.action === 'save-correction') {
        const decision = await dialog.showMessageBox(controller.windows.control, { type: 'question', title: 'Save reusable correction?', message: 'Add this example to the private Academy profile?', detail: 'If Learn from verified corrections is enabled, matching future local requests using this exact model version may include the example. It will not change model weights, grant tools, or send data to cloud AI.', buttons: ['Cancel', 'Save correction'], defaultId: 0, cancelId: 0 })
        if (decision.response !== 1) return { ok: false, snapshot: academy.snapshot(), message: 'Correction not saved.' }
      }
      const model = await ollama.modelDetails(command.model ?? '')
      try {
        const tags = await (await ollama.call('api/tags', undefined, undefined, 5000)).json() as { models?: Array<{ name: string; digest?: string }> }
        model.digest = tags.models?.find(item => item.name === model.name)?.digest
      } catch { /* Older Ollama servers may omit digest metadata. */ }
      if (command.action === 'profile') academy.profile(model)
      if (command.action === 'remove-source' && command.model && command.courseId) {
        const source = academy.snapshot().sources.find(item => item.id === command.sourceId)
        if (!source) throw new Error('The knowledge source is unavailable.')
        const decision = await dialog.showMessageBox(controller.windows.control, { type: 'warning', title: 'Remove source from this module?', message: `Remove ${source.name} from this training module?`, detail: 'The private source copy and assignments in other training modules remain available.', buttons: ['Cancel', 'Remove'], defaultId: 0, cancelId: 0 })
        if (decision.response !== 1) return { ok: false, snapshot: academy.snapshot(), message: 'Removal cancelled.' }
        await academy.removeSource(command.sourceId, model, command.courseId)
      }
      academy.onProjectProgress = progress => { if (!controller.windows.control.isDestroyed()) controller.windows.control.webContents.send(IPC.academyProjectProgress, progress) }
      let academyMessage: string | undefined
      if (command.action === 'restart-course') { academy.restartCourse(model, command.courseId); academyMessage = 'Training restarted. Previous course results remain saved in the module history.' }
      if (command.action === 'delete-course-result') { academy.deleteCourseResult(model, command.courseId, command.resultId); academyMessage = 'Failed course result deleted.' }
      if (command.action === 'course-stage') await academy.courseStage(model, command.courseId, command.stage, command.threshold)
      if (command.action === 'retry-course-exercise') await academy.retryCourseExercise(model, command.courseId, command.resultId, command.exerciseId)
      if (command.action === 'instructions') academy.setInstructions(model, command.instructions)
      if (command.action === 'learning-toggle') academy.setLearning(model, command.enabled)
      if (command.action === 'save-correction') academy.saveCorrection(model, command)
      if (command.action === 'update-correction') academy.updateCorrection(model, command.id, command)
      if (command.action === 'module') academy.setModule(model, command.id, command.installed, command.enabled)
      if (command.action === 'link-source') academy.linkSource(model, command.sourceId, command.linked, command.courseId)
      if (command.action === 'embedding-model') {
        const embedding = command.embeddingModel ? await ollama.modelDetails(command.embeddingModel) : null
        if (embedding) {
          try {
            const tags = await (await ollama.call('api/tags', undefined, undefined, 5000)).json() as { models?: Array<{ name: string; digest?: string }> }
            embedding.digest = tags.models?.find(item => item.name === embedding.name)?.digest
          } catch { /* A missing digest is reported when indexing is requested. */ }
        }
        academy.setEmbeddingModel(model, embedding)
      }
      if (command.action === 'index-source') await academy.indexSource(model, command.sourceId, progress => {
        if (!controller.windows.control.isDestroyed()) controller.windows.control.webContents.send(IPC.academyProgress, progress)
      }, command.courseId)
      if (command.action === 'add-source') {
        const picked = await dialog.showOpenDialog(controller.windows.control, { title: 'Add local knowledge sources', message: 'Select one or more text or Markdown files. Each selected source will be assigned to this training module.', properties: ['openFile', 'multiSelections'], filters: [{ name: 'Text and Markdown', extensions: ['txt', 'md', 'markdown'] }] })
        if (picked.canceled || !picked.filePaths.length) return { ok: false, snapshot: academy.snapshot(), message: 'No sources selected.' }
        const added: string[] = [], failed: string[] = []
        for (const filePath of picked.filePaths) {
          try { added.push((await academy.addSource(filePath, model, command.courseId)).name) }
          catch (error) { failed.push(`${basename(filePath)}: ${error instanceof Error ? error.message : 'Could not add this source.'}`) }
        }
        const scopeName = command.courseId ? academyCourses.find(item => item.id === command.courseId)?.name : 'the selected module'
        const summary = added.length ? `Added ${added.length} source${added.length === 1 ? '' : 's'} to ${scopeName ?? 'the selected module'}.` : 'No sources were added.'
        return { ok: failed.length === 0, snapshot: academy.snapshot(), message: failed.length ? `${summary} ${failed.join(' ')}` : summary }
      }
      if (command.action === 'evaluate') await academy.evaluate(model, command.track)
      return { ok: true, snapshot: academy.snapshot(), ...(academyMessage ? { message: academyMessage } : {}) }
    } catch (error) { return { ok: false, snapshot: academy.snapshot(), message: error instanceof Error ? error.message : 'Academy operation failed.' } }
  })
  conversationHandle(IPC.chatGet, async () => {
    const mode = controller.settings.aiMode
    if (mode === 'local' || mode === 'unconfigured') return chat.snapshot()
    let model: string | null = null, models: string[] = [], modelCatalogAvailable = true
    let cursorCatalog: CursorStatus | undefined
    let codexDefault: string | null = null
    if (mode === 'subscription' && controller.settings.chatGPTCodingBackend === 'codex-cli' && chat.current().workspaces.length > 0) {
      const status = await codexCLI?.status()
      model = status?.defaultModel ?? null
      models = status?.models.map((entry) => entry.id) ?? []
      codexDefault = status?.defaultModel ?? null
      modelCatalogAvailable = Boolean(status?.authenticated && models.length)
    }
    else if (mode === 'subscription') { const status = await chatGPT!.status(); model = status.model; models = status.models.map((entry) => entry.slug) }
    else if (mode === 'copilot') { const status = (await copilot!.aiStatus()).status; model = status.model; models = status.models }
    else if (mode === 'claude-api') { const status = (await claudeAPI!.getStatus()).status; model = status.model; models = status.models }
    else if (mode === 'cursor') { const status = await cursorACP!.status(); cursorCatalog = status; model = defaultCursorModel(status); models = cursorSelectableModels(status.models, status.modelCatalogAvailable).map((entry) => entry.id); modelCatalogAvailable = status.modelCatalogAvailable }
    else if (mode === 'cloud') { const status = (await ai.getStatus()).status; model = status.model; models = status.models }
    const selected = chat.current().config.model
    if (mode === 'cursor' && chat.snapshot().phase !== 'idle') return chat.snapshot()
    if (mode === 'cursor') {
      const config = chat.current().config
      const available = (id: string) => cursorCatalog ? cursorModelAvailable(cursorCatalog, id) : models.includes(id)
      const saved = config.cursorPendingModel ?? config.cursorModel ?? (selected && available(selected) ? selected : null)
      if (!modelCatalogAvailable && config.cursorModel) {
        if (selected !== config.cursorModel) chat.selectCursorModel(config.cursorModel)
      } else if (saved && available(saved)) {
        if (selected !== saved || config.cursorModel !== saved || config.cursorPendingModel) chat.selectCursorModel(saved)
      } else if (model && models.includes(model)) chat.selectCursorModel(model, saved ? `Your previous Cursor model (${saved}) is no longer available. Athena selected ${model} for this conversation.` : undefined)
      else if (modelCatalogAvailable && saved && !available(saved)) chat.selectCursorModel(null, `Your previous Cursor model (${saved}) is no longer available. Choose a model from Cursor’s current catalog.`)
      else if (modelCatalogAvailable && (!selected || !available(selected))) chat.selectCursorModel(null)
    } else if (model && selected && models.length && !models.includes(selected)) await chat.command({ action: 'configure-model', id: chat.current().id, model })
    else if (mode === 'subscription' && controller.settings.chatGPTCodingBackend === 'codex-cli' && chat.current().workspaces.length > 0 && !selected && codexDefault) await chat.command({ action: 'configure-model', id: chat.current().id, model: codexDefault })
    else chat.initializeModel(model)
    return chat.snapshot()
  }, true)
  aiHandle(IPC.chatSearch, (input) => chat.search(z.object({ query: z.string().max(200) }).strict().parse(input).query))
  aiHandle(IPC.chatSlashCommands, async (input) => {
    const request = slashCatalogRequestSchema.parse(input)
    const registry = request.surface === 'local' ? athenaChat?.commands : slashCommands
    const commandChat = request.surface === 'local' ? athenaChat?.chat : chat
    if (!registry || !commandChat || commandChat.current().id !== request.sessionId) throw new ChatError('Conversation changed. Reopen the command menu and retry.')
    if (request.action === 'authorize-global') {
      const result = await dialog.showMessageBox(controller.windows.control, {
        type: 'question', title: 'Include global slash commands?',
        message: 'Allow Athena to discover your user-level Claude and Codex commands and skills?',
        detail: 'Athena will read only ~/.claude/commands, ~/.claude/skills, ~/.codex/prompts, ~/.codex/skills and ~/.agents/skills. Definitions are sent to your selected AI provider only when you explicitly submit one. They never grant extra file or tool permissions.',
        buttons: ['Cancel', 'Allow global commands'], defaultId: 0, cancelId: 0, noLink: true,
      })
      if (result.response === 1) await registry.authorizeGlobals()
    }
    if (request.action === 'revoke-global') await registry.revokeGlobals()
    return registry.list(commandChat.current())
  })
  conversationHandle(IPC.chatContext, (input, event) => {
    if (event.sender.id === controller.windows.panel.webContents.id && (!input || typeof input !== 'object' || !('action' in input)
      || !['connect', 'browse', 'attach-source', 'pick-files', 'remove', 'import-pasted', 'rename', 'update-text', 'preview', 'preview-artifact', 'artifact-url', 'download-artifact', 'open-artifact'].includes(String(input.action)))) throw new Error('This file operation requires the control center.')
    return context?.run(input) ?? { ok: false, message: 'File context is unavailable.' }
  }, true)
  conversationHandle(IPC.chatSession, async (input, event) => {
    const parsed = sessionCommandSchema.safeParse(input)
    if (!parsed.success) return { ok: false, message: 'Invalid conversation operation.' }
    const command = parsed.data
    if ((event.sender.id === controller.windows.panel.webContents.id || event.sender.id === controller.windows.floating.webContents.id) && !['draft', 'agent-approval'].includes(command.action)) return { ok: false, message: 'Open the full conversation for session management.' }
    if (command.action === 'configure' || command.action === 'configure-model') {
      requireOnlineProvider(controller.settings)
      const mode = controller.settings.aiMode
      let status: { status: { active: boolean; models: string[] } }
      let cursorCatalog: CursorStatus | undefined
      if (mode === 'subscription') { const value = await chatGPT!.status(); status = { status: { active: value.planEnabled, models: value.models.map((entry) => entry.slug) } } }
      else if (mode === 'copilot') status = await copilot!.aiStatus()
    else if (mode === 'claude-api') { const value = await claudeAPI!.getStatus(); status = { status: { active: value.status.active, models: value.status.models } } }
      else if (mode === 'cursor') { const value = await cursorACP!.status(); cursorCatalog = value; status = { status: { active: value.authenticated, models: cursorSelectableModels(value.models, value.modelCatalogAvailable).map((entry) => entry.id) } } }
      else { const value = await ai.getStatus(); status = { status: { active: value.status.active, models: value.status.models } } }
      const model = command.action === 'configure' ? command.config.model : command.model
      if (!status.status.active || !model || !(cursorCatalog ? cursorModelAvailable(cursorCatalog, model) : status.status.models.includes(model))) return { ok: false, message: mode === 'cursor' ? 'Choose a model from the authenticated Cursor CLI catalog, then retry.' : 'Select a model from your configured AI provider.' }
    }
    if (command.action === 'delete' && !command.confirmed) {
      const result = await dialog.showMessageBox(controller.windows.control, { type: 'question', title: 'Delete?', message: 'Remove this conversation from history?', detail: 'A recovery copy and its attachments remain in Athena’s private local conversation-archive folder.', buttons: ['Cancel', 'Delete'], defaultId: 0, cancelId: 0, noLink: true })
      if (result.response !== 1) return { ok: false, message: 'Deletion cancelled.' }
    }
    let resolvedCommand: SlashCommandMeta | undefined
    if (command.action === 'edit') {
      const invocation = commandAtStart(command.text)
      if (command.commandId && !invocation) return { ok: false, message: 'The command text changed. Choose a registered command again.' }
      if (invocation) {
        if (!slashCommands || command.id !== chat.current().id) return { ok: false, message: 'The current project command registry is unavailable. Refresh commands and retry.' }
        const matches = (await slashCommands.list(chat.current())).commands.filter((entry) => entry.name.toLowerCase() === invocation.name.toLowerCase())
        const selected = command.commandId ? matches.find((entry) => entry.id === command.commandId) : matches.length === 1 ? matches[0] : undefined
        if (!selected) return { ok: false, message: matches.length ? `Several sources define ${invocation.name}. Choose the intended command source and retry.` : `${invocation.name} is not registered in this conversation.` }
        if (selected.execution === 'built-in') return { ok: false, message: 'Run Athena built-in commands from the composer instead of editing a historical message.' }
        resolvedCommand = { id: selected.id, name: selected.name, source: selected.source, arguments: invocation.arguments }
      }
    }
    if (command.action === 'configure-model' && controller.settings.aiMode === 'cursor') {
      if (chat.snapshot().phase !== 'idle') chat.queueCursorModel(command.model)
      else chat.selectCursorModel(command.model)
      return { ok: true }
    }
    if (command.action === 'create' && controller.settings.aiMode === 'cursor') {
      const previous = chat.current().config.cursorModel
      const result = chat.command(command, resolvedCommand)
      if (result.ok) {
        const status = await cursorACP!.status()
        const preferred = !status.modelCatalogAvailable && previous ? previous : defaultCursorModel(status)
        chat.selectCursorModel(preferred)
      }
      return result
    }
    if (command.action === 'switch' && controller.settings.aiMode === 'cursor') {
      const result = chat.command(command, resolvedCommand)
      if (result.ok) {
        const status = await cursorACP!.status()
        const config = chat.current().config
        const saved = config.cursorModel ?? config.model
        if (status.modelCatalogAvailable && (!saved || !cursorModelAvailable(status, saved))) {
          const fallback = defaultCursorModel(status)
          chat.selectCursorModel(fallback, saved ? fallback
            ? `Your previous Cursor model (${saved}) is no longer available. Athena selected ${fallback} for this conversation.`
            : `Your previous Cursor model (${saved}) is no longer available. Choose a model from Cursor’s current catalog.` : undefined)
        } else if (saved && config.model !== saved) chat.selectCursorModel(saved)
        else chat.setCursorModelNotice()
      }
      return result
    }
    return chat.command(command, resolvedCommand)
  }, true)
  conversationHandle(IPC.chatSend, async (input) => {
    const parsed = chatInputSchema.safeParse(input)
    if (!parsed.success) return chat.send(input)
    const request = parsed.data
    if (request.commandId && (!slashCommands || request.sessionId !== chat.current().id)) return { ok: false, message: 'Conversation changed. Choose the command again in the current chat.' }
    let commandMeta: SlashCommandMeta | undefined
    const invocation = commandAtStart(request.text)
    if (request.commandId || invocation) {
      if (request.commandId && !invocation) return { ok: false, message: 'The selected command no longer matches the message. Choose it again.' }
      if (invocation && (!slashCommands || request.sessionId !== chat.current().id)) return { ok: false, message: 'The slash command registry is unavailable for this conversation. Refresh commands and retry.' }
      if (invocation && slashCommands) {
        const matches = (await slashCommands.list(chat.current())).commands.filter((entry) => entry.name.toLowerCase() === invocation.name.toLowerCase())
        const selected = request.commandId ? matches.find((entry) => entry.id === request.commandId) : matches.length === 1 ? matches[0] : undefined
        if (request.commandId && !selected) return { ok: false, message: 'This command is unavailable in the current project. Refresh commands and choose it again.' }
        if (!matches.length) return { ok: false, message: `${invocation.name} is not registered in this conversation. Refresh project commands or send it as ordinary text without a leading slash.` }
        if (!request.commandId && matches.length > 1) return { ok: false, message: `Several sources define ${invocation.name}. Select the intended source from the slash command menu.` }
        if (selected?.execution === 'built-in') return { ok: false, message: `Use ${selected.name} from the command menu in the full conversation.` }
        if (selected) commandMeta = { id: selected.id, name: selected.name, source: selected.source, arguments: invocation.arguments }
      }
    }
    const projectRequest = /^(?:hey athena[, ]*)?(?:open|switch to|use)\s+(?:my\s+)?(.+?)\s+project(?:\s+in\s+(?:vs code|visual studio code))?[.!?]?$/i.exec(request.text)
    const genericProjectRequest = /^(?:hey athena[, ]*)?(?:open|switch to|use)\s+my\s+project(?:\s+in\s+(?:vs code|visual studio code))?[.!?]?$/i.test(request.text)
    if ((!projectRequest && !genericProjectRequest) || !context || !request.sessionId || request.sessionId !== chat.current().id || chat.snapshot().phase !== 'idle') return commandMeta ? chat.send(input, commandMeta) : chat.send(input)
    const requested = projectRequest?.[1].trim().toLowerCase() ?? 'last'
    const candidates = chat.workspaceReferences().filter((workspace) => context.workspaces.authorized(workspace.id))
    let selected = requested === 'last' ? chat.snapshot().sessions?.find((entry) => entry.project && context.workspaces.authorized(entry.project.id))?.project
      : candidates.find((workspace) => workspace.name.toLowerCase() === requested)
    if (!selected) {
      const matches = candidates.filter((workspace) => workspace.name.toLowerCase().includes(requested))
      if (matches.length > 1) return { ok: false, message: `More than one authorized project matches “${requested}”. Choose the folder or use its exact name.` }
      selected = matches[0]
    }
    if (!selected) {
      const previousWorkspace = chat.current().workspaces[0]?.id
      const result = await context.run({ action: 'connect', sessionId: request.sessionId })
      if (!result.ok) return result
      selected = chat.current().workspaces[0]
      if (!selected || selected.id === previousWorkspace) return { ok: false, message: 'Choose a project folder to continue.' }
    } else chat.openWorkspace(selected, [])
    chat.command({ action: 'draft', id: request.sessionId, text: '' })
    return chat.send({ ...request, sessionId: chat.current().id })
  }, true)
  aiHandle(IPC.chatRetry, () => chat.retry())
  conversationHandle(IPC.chatStop, () => chat.stop(), true)
  aiHandle(IPC.chatClear, () => chat.clear())
  handle(IPC.chatCopy, (event, input) => {
    // Meeting answers are rendered in the independent floating meeting
    // window, so allow that trusted surface to use the same native clipboard
    // bridge as the control center. Other windows remain denied.
    if (event.sender.id !== controller.windows.control.webContents.id && event.sender.id !== controller.windows.meeting?.webContents.id) throw new Error('Copy is only available in Athena windows.')
    const parsed = chatCopySchema.safeParse(input)
    if (!parsed.success) return { ok: false, message: 'This text cannot be copied.' }
    clipboard.writeText(parsed.data.text)
    return { ok: true }
  })
}
