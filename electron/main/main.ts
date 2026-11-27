import { randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { authorizeCua, CodexCua, CuaUnavailable, type CuaBinding } from './ai/codexCua'
import { CodexCuaControls, cuaOperation, UnsupportedCuaControl } from './desktop/codexCuaControls'
import { CodexVoiceAutomation } from './ai/codexVoiceAutomation'
import type { AutomationEngineStatus } from '../../shared/applicationAutomation'
import { CodexComputerTools } from './desktop/codexComputerTools'
import type { AppIdentifier } from '../../shared/desktopActions'
import { AudioDeviceService } from './voice/audioDeviceService'
import { NativeAudioEndpoints, enrichAudioEndpoints } from './voice/nativeAudioEndpoints'
import { CopilotService } from './ai/copilotService'
import { CopilotProvider } from './ai/CopilotProvider'
import { AntigravityProvider } from './ai/AntigravityProvider'
import { AntigravityACPService, AntigravityGeneralWorkspace } from './ai/antigravityACP'
import { MeetingService } from './meetings/meetingService'
import { OllamaProvider as MeetingOllamaProvider } from './ai/OllamaProvider'
import { knownReasoningEfforts, supportsImageInput } from '../../shared/modelCapabilities'
import { app, dialog, Menu, nativeTheme, powerMonitor, safeStorage, screen, session, shell, type Tray } from 'electron'
import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { mkdir, realpath } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { AthenaController } from './athenaController'
import { SettingsRepository } from './settingsRepository'
import { registerIPC } from './ipcHandlers'
import { createTray } from './tray'
import { log } from './logger'
import { AIConfiguration } from './ai/aiConfiguration'
import { KeychainCredentialStore } from './ai/credentialStore'
import { OpenAIConnection } from './ai/openAIConnection'
import { OpenAIProvider } from './ai/OpenAIProvider'
import { ThirdPartyAIProvider, ThirdPartyInferenceService } from './ai/thirdPartyInference'
import { inferenceCatalogSelectable } from '../../shared/thirdPartyInference'
import { UnifiedAccounts } from './ai/unifiedAccounts'
import { ChatController } from './ai/chatController'
import { IPC } from '../../shared/ipcChannels'
import { PermissionRepository } from './permissions/permissionRepository'
import { MacOSPermissionAdapter } from './permissions/macOSPermissionAdapter'
import { PermissionService } from './permissions/permissionService'
import { ConversationRepository } from './ai/conversationRepository'
import { UsageLedger, apiUsageAccount } from './ai/usageLedger'
import { ProviderUsageService } from './ai/providerUsageService'
import { WorkspaceService } from './ai/workspaceService'
import { ProjectIntelligence } from './ai/projectIntelligence'
import { SlashCommandService } from './ai/slashCommandService'
import { AttachmentService, decodeAttachmentImage } from './ai/attachmentService'
import { ChatContextService } from './ai/chatContextService'
import { AgentTools } from './ai/agentTools'
import { supportsProjectTools } from './ai/projectTools'
import { WorkspaceGrants } from './ai/workspaceGrants'
import { VoiceController } from './voice/voiceController'
import { OpenAITranscriptionService } from './voice/transcriptionService'
import { allowsVoiceMedia, mainFrameMediaRequestContext } from './voice/mediaPolicy'
import { ChatError } from './ai/AIProvider'
import { SpeechController } from './voice/speechController'
import { ActionNarrator } from './voice/actionNarrator'
import { ApplicationDetectionController } from './applicationDetection/applicationDetectionController'
import { MacOSApplicationDetectionService } from './applicationDetection/macOSApplicationDetectionService'
import { MacOSDesktopPlatform } from './desktop/macOSDesktopPlatform'
import { WindowsDesktopPlatform } from './desktop/windowsDesktopPlatform'
import { ExistingBrowser } from './desktop/existingBrowser'
import { contextualControl } from './ai/voiceActionPlan'
import { APPLICATIONS, appIdentifierSchema } from '../../shared/desktopActions'
import { DesktopContext, browserApps, knownApplication, chooseWindow, otherWindow, windowRequest, workspaceStateSchema, workspaceResultSchema, type BrowserApp } from './desktop/desktopContext'
import { ForegroundWatch, type FocusStamp } from './desktop/foregroundWatch'
import { internalBounds, internalTarget } from './desktop/internalInteraction'
import { InteractionOverlay, screenRect } from './desktop/interactionOverlay'
import { sameTargetImage } from './desktop/targetImage'
import { ObservationRequired } from './desktop/observationRequired'
import { isPublicBrowserURL, VoiceBrowser } from './desktop/voiceBrowser'
import { dictatedBrowserText, voiceDesktopActions } from './ai/voiceDesktopActions'
import { DesktopTools } from './desktop/desktopTools'
import { MacOSScreenCapture } from './screenCapture/macOSScreenCapture'
import { ScreenCaptureTools } from './screenCapture/screenCaptureTools'
import { LocalWhisperTranscription, RoutedTranscription } from './voice/localVoiceServices'
import { ChatterboxSpeech } from './voice/chatterboxSpeech'
import { SelectedLocalSpeech } from './voice/selectedLocalSpeech'
import { InstalledApplications } from './desktop/installedApplications'
import { HandsFreeController } from './voice/handsFreeController'
import { OllamaService } from './ai/ollamaService'
import { AcademyService } from './ai/academyService'
import { AcademyIntegrations } from './ai/academyIntegrations'
import { AcademyStudio } from './ai/academyStudio'
import { MLXInference } from './ai/mlxInference'
import { AcademyTraining } from './ai/academyTraining'
import { requireOnlineProvider, requireOnlineHistory, onlineContextSettings } from './ai/onlineIsolation'
import { ChatGPTAuth } from './ai/chatGPTAuth'
import { AutomationAuditLog, safeAutomationDiagnostic } from './ai/automationAudit'
import { ApplicationAutomation } from './ai/applicationAutomation'
import { AutomationJournal } from './ai/automationJournal'
import { approvedWindowDriver } from './desktop/approvedWindowDriver'
import { computerInstruction, isPageSearchRequest } from '../../shared/applicationAutomation'
import { NativeActionRegistry } from './ai/nativeActionRegistry'
import { voiceProjectActions } from './ai/voiceProjectActions'
import { ClaudeAPIConfiguration, ClaudeAPIProvider, ClaudeCredentialStore } from './ai/claudeAPI'
import { CursorACPProvider, CursorACPService } from './ai/cursorACP'
import { CodexAppServerProvider } from './ai/CodexAppServerProvider'
import { CodexCLIService } from './ai/codexCLIService'
import { CursorGeneralWorkspace } from './ai/cursorGeneralWorkspace'
import { cursorModelAvailable, resolveCursorModel } from '../../shared/cursor'
import { BraveSearchCredentialStore, WebSearchService } from './ai/webSearchService'
import { SearxngRuntime } from './ai/searxngRuntime'
import type { LocalModel } from '../../shared/localAI'
import { LocalActivityBridge } from './ai/localActivityBridge'
import { localChatProvider, localCompanionProvider, localCompanionSettings } from './ai/localCompanion'
import { stopLlamaServer } from './ai/llamaServer'
import { installAthenaRendererHandler, registerAthenaRendererScheme, setAthenaArtifactResolver } from './rendererProtocol'
import { developmentUserDataPath } from './developmentPaths'
import { TaskNotifications } from './ai/taskNotifications'
import { cursorMedia } from './media/cursorMedia'
import { MediaRegistry } from './media/registry'
import { MediaService } from './media/mediaService'
import { GeneratedArtifactManager } from './ai/artifactService'
import { StartupSplash } from './startupSplash'

if (process.argv.includes('--athena-browser-worker')) {
  void import('./ai/browserWorker').then(({ runBrowserWorker }) => runBrowserWorker())
} else {
app.setName('Athena')
registerAthenaRendererScheme()
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
// Development and packaged Athena must not share Electron's single-instance
// lock or write the same settings database while both are open. The explicit
// integration-test profile remains the highest-priority override.
if (!app.isPackaged) {
  const developmentData = developmentUserDataPath(app.getPath('appData'), process.env.ATHENA_TEST_DATA)
  mkdirSync(developmentData, { recursive: true, mode: 0o700 })
  app.setPath('userData', developmentData)
}
const lock = app.requestSingleInstanceLock()
let controller: AthenaController | undefined
let chat: ChatController | undefined
let disposeProjectGit = () => {}
let voiceDesktopLocked = false
const automationFocus=new ForegroundWatch()
let interactionOverlay:InteractionOverlay|undefined
let voiceBrowser: VoiceBrowser | undefined
let companion: ChatController | undefined
let athenaChat: ChatController | undefined
let companionAgentTools: AgentTools | undefined
let athenaChatAgentTools: AgentTools | undefined
let companionCapture: ScreenCaptureTools | undefined
let athenaChatCapture: ScreenCaptureTools | undefined
let agentTools: AgentTools | undefined
let tray: Tray | undefined
let voice: VoiceController | undefined
let handsFree: HandsFreeController | undefined
let closeCodex: (()=>Promise<void>) | undefined
let closeLiveVoice: (()=>Promise<void>) | undefined
let audioDevices: AudioDeviceService | undefined
let meetings: MeetingService | undefined
let speech: SpeechController | undefined
let localVoice: SelectedLocalSpeech | undefined
let desktopActions: DesktopTools | undefined
let screenCapture: ScreenCaptureTools | undefined
let taskNotifications: TaskNotifications | undefined
let startup: StartupSplash | undefined
let localSearch: SearxngRuntime | undefined
if (!lock) app.quit()
else {
  app.on('second-instance', () => controller?.windows.showControl())
  void app.whenReady().then(async () => {
    installAthenaRendererHandler()
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    session.defaultSession.setPermissionCheckHandler(() => false)
    startup = new StartupSplash(process.env.ATHENA_SPLASH_DURATION_SECONDS, message => {
      log('application.start_failed')
      dialog.showErrorBox('Athena could not start', message)
      app.quit()
    })
    startup.create()
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: 'Athena', submenu: [{ role: 'about' }, { type: 'separator' }, { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => controller?.command('open-settings') }, { role: 'hide' }, { role: 'quit' }] },
      { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
      { label: 'Window', submenu: [{ role: 'minimize' }, { label: 'Open Athena', click: () => controller?.command('open-control') }] },
    ]))
    const usageLedger = new UsageLedger(app.getPath('userData'))
    usageLedger.importHistory(app.getPath('userData'))
    const providerUsage = new ProviderUsageService(usageLedger, app.getPath('userData'))
    let webSearch!: WebSearchService
    let thirdPartyInference!: ThirdPartyInferenceService
    const ai = new AIConfiguration(new KeychainCredentialStore(), new OpenAIConnection(), () => { webSearch?.clearOpenAIValidation(); voice?.cancel('AI configuration changed. Please record again.'); chat?.stopAll('AI configuration changed. Send a new message or retry.') })
    webSearch = new WebSearchService(new BraveSearchCredentialStore())
    thirdPartyInference = new ThirdPartyInferenceService(join(app.getPath('userData'),'third-party-inference'), () => {
      voice?.cancel('Inference profiles changed. Please record again.')
      chat?.stopAll('Inference profiles changed. Continue the preserved task using the current provider.')
    })
    const resolveOpenAIWebSearch = async (requestedModel: string | null) => {
      const connection = await ai.getStatus()
      if (!connection.status.hasKey) return { model: null, validated: false, note: 'Configure an OpenAI API key in Settings → AI. ChatGPT Subscription authentication does not grant Responses API access.' }
      if (!connection.status.active) return { model: null, validated: false, note: 'Verify the OpenAI API key in Settings → AI before testing Responses web search.' }
      const model = requestedModel ?? controller?.settings.webAccess.openAIModel ?? connection.status.model
      if (!model) return { model: null, validated: false, note: 'Select an available OpenAI API model in Settings → AI before testing web search. This search model is independent of the active chat provider.' }
      if (!connection.status.models.includes(model)) return { model: null, validated: false, note: `The selected OpenAI search model (${model}) is not in this API key’s available-model catalog. Choose another model in Settings → AI → Tools & Web Access.` }
      const config = await ai.getActiveConfiguration(model)
      const validated = webSearch.isOpenAIValidated(config.apiKey, config.model)
      return { apiKey: config.apiKey, model: config.model, validated, note: validated
        ? undefined
        : `OpenAI Responses web search has not yet been verified for ${config.model}. Test it here, or let the first requested search verify it automatically; Athena will not switch to Brave.` }
    }
    // Each ChatGPT provider is constructed with an immutable account token/model
    // snapshot for the whole request. Account settings therefore affect the
    // next request without cancelling or retargeting work already in flight.
    const chatGPT = new ChatGPTAuth()
    const codexVoiceCwd=join(app.getPath('userData'),'codex-voice-workspaces')
    const codexCLI = new CodexCLIService(app.getVersion(),codexVoiceCwd)
    closeCodex = () => codexCLI.shutdown()
    const claudeAPI = new ClaudeAPIConfiguration(new ClaudeCredentialStore(), undefined, () => { voice?.cancel('AI configuration changed. Please record again.'); chat?.stopAll('AI configuration changed. Send a new message or retry.') })
    const cursorACP = new CursorACPService(undefined, undefined, undefined, join(app.getPath('userData'), 'cursor-cli-status.json'))
    const cursorGeneralWorkspace = new CursorGeneralWorkspace(app.getPath('userData'), new WorkspaceGrants(join(app.getPath('userData'), 'cursor-general-workspace-grants')))
    const permissions = new PermissionService(new PermissionRepository(app.getPath('userData')), new MacOSPermissionAdapter(), () => {
      const mode = controller?.settings.aiMode
      if (mode === 'unconfigured' || mode === 'local') return 'unknown'
      return mode === 'subscription' ? `subscription:${chatGPT.selectedAccountId() ?? 'disconnected'}` : mode ?? 'unknown'
    })
    const applications = new ApplicationDetectionController(new MacOSApplicationDetectionService(), () => permissions.isCapabilityAllowed('applicationDetection'))
    const copilot = new CopilotService(join(app.getPath('userData'), 'copilot'))
    app.on('before-quit', () => { void copilot.shutdown() })
    const antigravityACP = new AntigravityACPService(app.getPath('userData'))
    const antigravityGeneralWorkspace = new AntigravityGeneralWorkspace(app.getPath('userData'))
    const unifiedAccounts = new UnifiedAccounts({ ai, codex: codexCLI, chatGPT, cursor: cursorACP, copilot, claude: claudeAPI, antigravity: antigravityACP, thirdParty: thirdPartyInference }, () => controller?.settings.unifiedAccountEnabled ?? {})
    const filesAllowed = () => permissions.isCapabilityAllowed('personalFiles')
    const workspaces = new WorkspaceService(filesAllowed, new WorkspaceGrants(app.getPath('userData')), () => permissions.filesystemMode())
    const slashCommands = new SlashCommandService(workspaces, app.getPath('userData'), filesAllowed)
    const attachments = new AttachmentService(app.getPath('userData'), filesAllowed, decodeAttachmentImage)
    const artifacts = new GeneratedArtifactManager(join(app.getPath('userData'), 'athena-artifacts'))
    setAthenaArtifactResolver(async token => artifacts.readAssetToken(token))
    const ollama = new OllamaService(() => controller?.settings.localAI.endpoint ?? 'http://127.0.0.1:11434')
    const academy = new AcademyService(join(app.getPath('userData'), 'athena-local', 'academy'), ollama)
    const academyIntegrations = new AcademyIntegrations()
    const academyStudio = new AcademyStudio(join(app.getPath('userData'), 'athena-local', 'academy'), ollama)
    const academyTraining = new AcademyTraining(join(app.getPath('userData'), 'athena-local', 'academy', 'training'))
    const mlx = new MLXInference(join(app.getPath('userData'), 'athena-local', 'mlx-inference'))
    academyTraining.mlx = mlx; ollama.mlx = mlx
    app.on('before-quit', () => mlx.cancel())
    let context: ChatContextService
    let companionContext: ChatContextService
    let athenaChatContext: ChatContextService
    let companionModel: LocalModel | undefined
    const athenaChatModels = new Map<string, LocalModel>()
    let athenaChatVisible = false
    let narrator: ActionNarrator | undefined
    const voiceSubmissions = new Map<string,string>()
    let floatingMediaRequest: string | undefined
    chat = new ChatController({
      resolveComputerCommand:(session,text,id,signal)=>computerInstruction(text)?context.resolveNativeVoiceCommand(session,text,id,signal,false):Promise.resolve({handled:false}),
      mediaChanged: job => {
        if(job.requestId!==floatingMediaRequest) return
        controller?.setVoiceMedia(job)
        if(['failed','stopped','ready'].includes(job.status))floatingMediaRequest=undefined
      },
      contextDefaults: () => controller!.settings.aiContext,
      rememberedPermissions: permissions.remembered,
      origin: 'online-chat',
      maxConcurrent: () => controller?.settings.backgroundTasks.enabled ? controller.settings.backgroundTasks.maxConcurrent : 1,
      isViewed: sessionId => chat?.snapshot().sessionId === sessionId && Boolean(controller?.windows.control.isVisible() && controller.windows.control.isFocused()),
      unreadChanged: count => taskNotifications?.badge(count),
      executionEnded: event => taskNotifications?.completed(event),
      taskEnded: (sessionId,reply) => {
        const messages = chat?.getSession(sessionId)?.messages
        const index = messages?.findIndex(m=>m.id===reply.id) ?? -1
        const parent = index>0 ? messages?.[index-1] : undefined
        const id = parent && voiceSubmissions.get(parent.id)
        if (!parent || !id) return
        voiceSubmissions.delete(parent.id)
        const floating = controller?.windows.floating
        if (floating && !floating.isDestroyed() && !voiceDesktopLocked && controller?.settings.computerUse.voice && controller.settings.computerUse.enabled)
          floating.webContents.send(IPC.voiceSubmissionEnded,id,reply.status==='complete')
      },
      approvalChanged: event => taskNotifications?.approval(event),
      storeArtifact: input => artifacts.store(input.name, input.mimeType, input.bytes, { provider: input.provider }),
      childModel: config => config.accountRoute && config.model ? unifiedAccounts.model(config.accountRoute, config.model) : undefined,
      accountIdentity: async () => {
        const route = chat?.current().config.accountRoute
        if (route) return `${route.provider}:${route.accountId}`
        if (controller?.settings.aiMode === 'copilot') return copilot.identity()
        if (controller?.settings.aiMode !== 'subscription') return null
        if (controller.settings.aiMode === 'subscription') {
          const identity = (await codexCLI.status()).identity
          return identity ? `codex:${createHash('sha256').update(identity.trim().toLowerCase()).digest('hex')}` : null
        }
        return (await chatGPT.status()).activeAccountId
      },
      usageProviderId: () => {
        const mode = chat?.current().config.accountRoute?.provider ?? controller!.settings.aiMode
        if (mode === 'cloud') return 'openai-api'
        if (mode === 'subscription') return 'codex-subscription'
        if (mode === 'claude-api') return 'claude-api'
        if (mode === 'cursor') return 'cursor-subscription'
        if (mode === 'copilot') return 'github-copilot-subscription'
        if (mode === 'antigravity') return 'google-antigravity-subscription'
        if (mode === 'third-party') return `third-party:${chat?.current().config.accountRoute?.accountId ?? controller!.settings.thirdPartyConnectionId ?? 'unselected'}`
        return 'unknown'
      },
      provider: async (config, child) => {
        const settings = controller!.settings
        const route = config.accountRoute
        const mode = route?.provider ?? settings.aiMode
        if (route && !unifiedAccounts.isEnabled(route)) throw new ChatError('This account is disabled. Re-enable it in Settings → AI or choose another enabled model. The conversation history is preserved.')
        if (route) {
          const singleton: Partial<Record<typeof route.provider, string>> = { cursor: 'cursor', antigravity: 'antigravity', cloud: 'openai-api', 'claude-api': 'claude-api' }
          if (singleton[route.provider] && singleton[route.provider] !== route.accountId) throw new ChatError('The selected account reference is invalid. Choose its model again from the connected account catalog.')
        }
        if (!route) requireOnlineProvider(settings)
        requireOnlineHistory(settings, chat!.current().messages)
        if (child?.isolated && mode === 'cursor') throw new ChatError('Cursor’s native agent does not expose Athena’s scoped child-tool interface. Independent sub-agents are unavailable with this provider.')
        if (child?.isolated && mode === 'subscription' && child.purpose !== 'voice-planning') throw new ChatError('Codex owns native sub-agent execution. Athena cannot wrap it in a second agent loop.')
        if (child?.isolated && mode !== 'third-party' && !supportsProjectTools(config.model)) throw new ChatError('The requested sub-agent model has no verified application tool support. Select a compatible model in Settings → AI → Sub-agents.')
        if (mode === 'copilot') {
          if (child?.isolated) throw new ChatError('Copilot sub-agent budget enforcement is not yet supported. No child was launched.')
          const { account, models } = await copilot.active()
          if (route && route.accountId !== account.id) throw new ChatError('The selected GitHub Copilot account changed. Reconnect it in Settings → AI.')
          if (route && !models.some(item => item.id === config.model)) throw new ChatError('This model is no longer available in the selected GitHub Copilot account. Refresh its model catalog.')
          const model = config.model ?? models[0]?.id
          if (!model) throw new ChatError('Select an available Copilot model.')
          return new CopilotProvider(copilot, model, account.id)
        }
        if (mode === 'subscription') {
          // The separate voice planner is not a main-text Codex conversation.
          if(child?.purpose === 'voice-planning') {
            const {accessToken,model,accountId,requestIdentity,contextWindow}=await chatGPT.activeModel(config.model,route?.accountId==='codex-local'?undefined:route?.accountId)
            return new OpenAIProvider(accessToken,model,undefined,settings.aiGeneration,true,rejected=>chatGPT.accessTokenForRound(accountId,rejected),requestIdentity,usageLedger.forAccount('chatgpt-subscription',accountId),contextWindow)
          }
          const status = await codexCLI.status()
          if (!status.authenticated || !status.identity) throw new ChatError(`${status.message} No alternate execution path or API billing was used.`)
          if (route && route.accountId !== 'codex-local') {
            const account = (await chatGPT.status()).accounts.find(a => a.id === route.accountId)
            if (!account?.email || account.email.toLowerCase() !== status.identity.toLowerCase()) throw new ChatError('Sign in to Codex with the selected ChatGPT account, or explicitly select the Codex account in the model menu. No account was substituted.')
          }
          const model = config.model ?? status.defaultModel
          if (!model || !status.models.some(entry => entry.id === model)) throw new ChatError('Select a model from the Codex catalog. The previous model was not silently replaced.')
          return new CodexAppServerProvider(codexCLI, model, status.identity)
        }
        if (mode === 'claude-api') {
          if (child?.isolated && config.contextSettings?.taskSpendLimitUsd != null) throw new ChatError('Athena cannot enforce a dollar cap with the current Claude adapter. This capped sub-agent was not launched.')
          if (route && !config.model) throw new ChatError('Select a Claude API model for this conversation.')
          const { apiKey, model, capacity } = await claudeAPI.getActiveConfiguration(config.model)
          if (route && model !== config.model) throw new ChatError('The selected Claude API model is unavailable. Refresh its model catalog and choose a model again.')
          if (child?.isolated && model !== config.model) throw new ChatError('The requested Claude sub-agent model is unavailable. No fallback model was used.')
          const efforts = knownReasoningEfforts('claude-api', model)
          if (config.effort !== 'auto' && !efforts?.includes(config.effort)) throw new ChatError('The selected Claude model does not advertise that reasoning effort. Choose a supported level or Auto.')
          const reasoning = config.effort === 'auto' ? undefined : { output_config: { effort: config.effort } }
          return new ClaudeAPIProvider(apiKey, model, undefined, { reasoning, ...capacity })
        }
        if (mode === 'cursor') {
          const sessionId = chat!.current().id
          const workspace = chat!.current().workspaces[0]
          if (workspace && !workspaces.authorized(workspace.id)) throw new ChatError('The project attached to this conversation is unavailable or no longer authorized. Reconnect that folder before continuing; Athena will not switch to another project.')
          const cursorStatus = await cursorACP.status()
          if (!cursorStatus.authenticated && cursorStatus.authenticationStatus !== 'unknown') throw new ChatError('Cursor CLI reports that it is not signed in. Connect it in Settings → AI. Athena will not switch providers automatically.')
          if (route && (!config.model || !cursorModelAvailable(cursorStatus, config.model))) throw new ChatError('The selected Cursor model is unavailable for this account. Refresh its model catalog in Settings → AI.')
          let root: string
          let assertWorkspace: () => Promise<void>
          if (workspace) {
            root = await workspaces.authorizedRoot(workspace.id)
            assertWorkspace = async () => {
              const current = chat!.current()
              if (current.id !== sessionId || current.workspaces[0]?.id !== workspace.id || !workspaces.authorized(workspace.id) || await workspaces.authorizedRoot(workspace.id) !== root) throw new ChatError('The active project authorization changed. Cursor stopped before accessing another folder.')
            }
          } else {
            const managed = await cursorGeneralWorkspace.authorize()
            root = managed.root
            assertWorkspace = async () => {
              const current = chat!.current()
              if (current.id !== sessionId || current.workspaces.length) throw new ChatError('The active conversation workspace changed. Cursor stopped this request before entering another folder.')
              await managed.assertAccess()
            }
          }
          const model = resolveCursorModel(cursorStatus, cursorStatus.modelCatalogAvailable ? config.model : config.cursorModel)
          if (cursorStatus.modelCatalogAvailable && !model) throw new ChatError('Select an available Cursor model in this conversation before sending a request. Cursor did not provide a reliable default.')
          // Cursor's generate_image extension treats filePath as a suggestion.
          // Prepare one project-scoped handoff directory up front so the
          // provider can write there without ever targeting Athena's private
          // artifact store or an arbitrary user path.
          const generatedOutputDir = await artifacts.prepareProviderOutput(root, 'images')
          return new CursorACPProvider(cursorACP, root, config.agentMode === 'read-only', cursorStatus.identity, model, assertWorkspace, undefined, generatedOutputDir)
        }
        if (mode === 'antigravity') {
          if (child?.isolated) throw new ChatError('Antigravity ACP does not expose Athena’s bounded sub-agent interface. No child task was started.')
          if (route) {
            const status = await antigravityACP.status()
            if (status.authState !== 'authenticated' || !config.model || !status.models.some(model => model.id === config.model)) throw new ChatError('The selected Google Antigravity model is unavailable. Reconnect the account or refresh its model catalog.')
          }
          const sessionId = chat!.current().id
          const workspace = chat!.current().workspaces[0]
          let root: string
          let assertWorkspace: () => Promise<void>
          if (workspace) {
            if (!workspaces.authorized(workspace.id)) throw new ChatError('The attached project is no longer authorized. Reconnect it before using Antigravity.')
            root = await workspaces.authorizedRoot(workspace.id)
            assertWorkspace = async () => {
              const current = chat!.getSession(sessionId)
              if (current?.workspaces[0]?.id !== workspace.id || !workspaces.authorized(workspace.id) || await workspaces.authorizedRoot(workspace.id) !== root) throw new ChatError('The project authorization changed. Antigravity stopped before accessing another folder.')
            }
          } else {
            const managed = await antigravityGeneralWorkspace.authorize()
            root = managed.root
            assertWorkspace = async () => {
              if (chat!.getSession(sessionId)?.workspaces.length !== 0) throw new ChatError('The conversation workspace changed. Antigravity stopped before accessing another folder.')
              await managed.assertAccess()
            }
          }
          return new AntigravityProvider(antigravityACP, root, config.model, assertWorkspace, Boolean(workspace), config.effort)
        }
        if(mode==='third-party') {
          const disabledProfile = route ? (await thirdPartyInference.list()).find(profile => profile.id === route.accountId && !profile.enabled) : undefined
          if (disabledProfile) throw new ChatError('This third-party inference account is disabled. Re-enable it in Settings → AI or choose another enabled model.')
          const profile=await thirdPartyInference.active(route?.accountId ?? settings.thirdPartyConnectionId)
          if(!profile) throw new ChatError('Select an enabled, tested third-party inference connection in Settings → AI.')
          const model=config.model??profile.defaultModel
          if(!model||!profile.models.some(item=>item.id===model&&item.enabled)) throw new ChatError('Select an enabled model for this third-party inference profile in Settings → AI, then choose it in the conversation.')
          if(!inferenceCatalogSelectable(profile)) throw new ChatError('Test the selected third-party connection before sending a request.')
          const modelCapabilities=thirdPartyInference.runtimeCapabilities(profile,model)
          if(child?.isolated&&modelCapabilities.toolCalling!==true&&modelCapabilities.functionCalling!==true) throw new ChatError('Sub-agents require verified tool calling for this exact model and gateway. Use Test this model in Settings → AI first.')
          return new ThirdPartyAIProvider(thirdPartyInference,profile,model)
        }
        const apiStatus = await ai.getStatus()
        if (route && (!config.model || !apiStatus.status.active || !apiStatus.status.models.includes(config.model))) throw new ChatError('The selected OpenAI API model is unavailable. Refresh its model catalog or reconnect the API account.')
        if (child?.isolated && (!config.model || !apiStatus.status.models.includes(config.model))) throw new ChatError('The requested OpenAI sub-agent model is unavailable in this account. No fallback model was used.')
        const selectedModel = config.model && apiStatus.status.models.includes(config.model) ? config.model : apiStatus.status.model
        const { apiKey, model } = await ai.getActiveConfiguration(selectedModel)
        return new OpenAIProvider(apiKey, model, undefined, settings.aiGeneration, false, undefined, {}, usageLedger.forAccount('openai-api', apiUsageAccount(apiKey)))
      },
      // API-key checkpoints may contain encrypted provider state. Never reuse
      // one with a distinct ChatGPT OAuth account, even for the same model ID.
      useCheckpoint: () => (chat?.current().config.accountRoute?.provider ?? controller?.settings.aiMode) === 'cloud',
      effectiveModel: () => chat?.current().config.accountRoute ? chat.current().config.model : controller?.settings.aiMode === 'cursor' ? chat?.current().config.model ?? 'cursor-managed' : controller?.settings.aiMode === 'antigravity' ? chat?.current().config.model ?? null : controller?.settings.aiMode === 'subscription' ? chat?.current().config.model ?? null : controller?.settings.aiMode==='third-party'?chat?.current().config.model??null:null,
      modelSupportsEffort: (model, effort, route) => {
        if (route?.provider === 'cloud' || !route && controller?.settings.aiMode === 'cloud') {
          if (effort === 'auto') return true
          const advertised = route ? unifiedAccounts.model(route, model ?? '')?.efforts : undefined
          return (advertised ?? knownReasoningEfforts('cloud', model))?.includes(effort) ?? false
        }
        if (route && ['third-party', 'cursor', 'copilot', 'claude-api', 'antigravity'].includes(route.provider)) {
          const advertised = unifiedAccounts.model(route, model ?? '')?.efforts
          // Auto means “let the provider decide” and sends no explicit effort
          // value, so it remains valid even when the model explicitly reports
          // no configurable effort levels.
          if (effort === 'auto') return true
          return advertised !== undefined ? advertised.includes(effort) : Boolean(knownReasoningEfforts(route.provider, model)?.includes(effort))
        }
        if ((route?.provider ?? controller?.settings.aiMode) === 'antigravity') return antigravityACP.supportsEffortCached(model ?? '', effort)
        if ((route?.provider ?? controller?.settings.aiMode) === 'subscription') return codexCLI.supportsEffortCached(model ?? '', effort)
        const provider = route?.provider ?? (controller?.settings.aiMode === 'subscription' ? 'subscription' : controller?.settings.aiMode)
        const trusted = knownReasoningEfforts(provider, model)
        return trusted ? trusted.includes(effort) : undefined
      },
      voiceApproval:(request,signal)=>confirmVoiceOperation(request,signal),
      voiceTimeoutMs: () => (controller?.settings.voiceInteraction.aiResponseTimeoutSeconds ?? 120) * 1000,
      adaptiveVoiceReasoning: () => controller?.settings.voiceInteraction.adaptiveVoiceReasoning ?? true,
      nativeExecution: conversation => (conversation.config.accountRoute?.provider ?? controller!.settings.aiMode) === 'subscription',
      nativeHistory: async conversation => {
        const state=conversation.nativeCodex!
        const connection=await codexCLI.connection(),account=await codexCLI.account(connection)
        if(state.account !== `${connection.accountId ?? account.email}:${account.email}`)throw new ChatError('Codex account changed. Restore the thread account before reading history.')
        await codexCLI.assertChatThread(state.threadId)
        const history=await codexCLI.turns(state.threadId)
        const rows=[]
        for(const turn of history.data)rows.push({turn,items:await codexCLI.items(state.threadId,turn.id)})
        return rows
      },
      prepareNative: async (conversation, messages, signal) => {
        signal.throwIfAborted()
        const roots = await Promise.all(conversation.workspaces.map(w => workspaces.authorizedRoot(w.id)))
        let cwd = roots[0]
        if (!cwd) {
          const safe = join(app.getPath('userData'), 'codex-workspaces', conversation.id)
          await mkdir(safe, {recursive:true, mode:0o700}); cwd = await realpath(safe)
          roots.push(cwd)
        }
        const files = await Promise.all((messages.findLast(m=>m.role==='user')?.attachments ?? []).map(a=>attachments.prepare(conversation.id,a)))
        const objective=messages.findLast(message=>message.role==='user')?.content ?? ''
        const computer=(!conversation.nativeCodex || conversation.nativeCodex.computerToolsRegistered) && controller!.settings.computerUse.enabled && !controller!.settings.strictOffline
          ? makeComputerTurn('chat:'+conversation.id,objective,randomUUID(),false,signal,conversation.workspaces.length>0) : undefined
        return {cwd, writableRoots:roots, computer, context:{attachments:files.map(a=>a.kind==='pdf'?{...a,kind:'text' as const}:a),repositoryText:'',sources:[]}}
      },
      prepare: (conversation, messages, signal, voiceOnly) => context.prepare(conversation, messages, signal, voiceOnly),
      resolveCommand: (conversation, command, text, signal) => slashCommands.resolve(conversation, command, text, signal),
      authorized: (id) => workspaces.authorized(id),
      workspaceRoot: id => workspaces.authorizedRoot(id),
      workspaceOnly: () => workspaces.filesystemMode() === 'project-only',
      phase: () => { /* Online requests do not own the companion's animation lane. */ },
      changed: (snapshot) => {
        voice?.reconcile()
        controller?.windows.control.webContents.send(IPC.chatChanged, snapshot)
      },
    }, new ConversationRepository(app.getPath('userData')))
    await workspaces.restore(chat.workspaceReferences())
    controller = new AthenaController(new SettingsRepository(app.getPath('userData')), startup)
    localSearch = new SearxngRuntime(join(app.getPath('userData'), 'search'), app.isPackaged ? join(process.resourcesPath, 'search-runtime') : join(app.getAppPath().endsWith('out-dev') ? dirname(app.getAppPath()) : app.getAppPath(), 'build', 'search-runtime', `${process.platform}-${process.arch}`))
    webSearch.configure(() => controller!.settings, localSearch)
    void localSearch.initialize().then(() => webSearch.reconcile())
    // Hydrate the non-secret Cursor status hint once at application startup.
    // This discovers an existing official CLI login after an upgrade or before
    // the first Settings visit; subsequent page visits remain cache-only.
    if (controller.settings.aiMode === 'cursor') void cursorACP.status().catch(() => {})
    taskNotifications = new TaskNotifications(() => controller?.windows.control, () => controller!.settings, route => {
      if (route.source === 'local') { controller?.windows.showControl('my-athena-chat'); athenaChat?.command({ action: 'switch', id: route.sessionId }) }
      else if (route.source === 'companion') { controller?.windows.showControl('companion'); companion?.command({ action: 'switch', id: route.sessionId }) }
      else { controller?.command('open-chat'); chat?.command({ action: 'switch', id: route.sessionId }); if(route.mediaMessageId)chat?.focusMedia(route.mediaMessageId) }
    }, join(app.getPath('userData'), 'notifications', 'approvals.json'))
    taskNotifications.badge(chat.unreadCompletions())
    controller.windows.control.on('focus', () => chat?.markViewed())
    const companionDirectory = join(app.getPath('userData'), 'athena-local', 'companion')
    const companionWorkspaces = new WorkspaceService(filesAllowed, new WorkspaceGrants(companionDirectory), () => permissions.filesystemModeFor('local'))
    const companionAttachments = new AttachmentService(companionDirectory, filesAllowed, decodeAttachmentImage)
    const companionCommands = new SlashCommandService(companionWorkspaces, companionDirectory, filesAllowed)
    const localActivity = new LocalActivityBridge(() => controller, () => athenaChatVisible && controller!.settings.athenaChatAvatarLinked ? athenaChat!.selectedSessionId() : companion!.selectedSessionId())
    const reconcileLocalActivity = () => {
      localActivity.reset()
      const active = athenaChatVisible && controller!.settings.athenaChatAvatarLinked ? athenaChat : companion
      const snapshot = active?.snapshot()
      if (snapshot && snapshot.phase !== 'idle') { localActivity.phase(snapshot.phase, snapshot.ownership); localActivity.activity(snapshot) }
    }
    const automationAudit = new AutomationAuditLog(join(app.getPath('userData'), 'automation'))
    const toolDialogs = new AsyncLocalStorage<string[]>()
    const confirmVoiceOperation = async (request: { title: string; description: string; allowLabel?:string }, signal: AbortSignal) => {
      signal.throwIfAborted()
      const kind=request.title==='Allow routine control of this browser tab?'?'tab access':
        request.title==='Share this context with Codex?'?'structured context':
        request.title==='Share this window with Codex?'?'window sharing':'action approval'
      toolDialogs.getStore()?.push(kind)
      controller!.windows.dialogActive = true
      try {
        const result = await dialog.showMessageBox(controller!.windows.panel.isVisible() ? controller!.windows.panel : controller!.windows.control, { type: 'question', title: request.title, message: request.title, detail: request.description, buttons: ['Deny', request.allowLabel ?? 'Allow once'], defaultId: 0, cancelId: 0, noLink: true, signal })
        return result.response === 1 && !signal.aborted
      } finally { controller!.windows.dialogActive = false }
    }
    companion = new ChatController({
      voiceApproval: confirmVoiceOperation,
      voiceActionAudit: (tool, status, durationMs) => { void automationAudit.record({ actionId: `athena.tool.${tool.replaceAll(/[^a-zA-Z0-9]/g, '')}`, permission: 'shared-executor', status, ...(durationMs === undefined ? {} : { durationMs }) }).catch(() => log('automation.audit_failed', { status })) },
      contextDefaults: () => controller!.settings.aiContext,
      rememberedPermissions: permissions.remembered,
      origin: 'athena-local',
      resource: 'local',
      maxConcurrent: () => 1,
      provider: (config, child) => localCompanionProvider(ollama, controller!.settings, config, child?.isolated, model => { if (!child?.isolated && model.name === controller!.settings.localAI.model) companionModel = model }, model => (request, project) => academy.instructionsFor(model, request, project), app.getPath('userData')),
      useCheckpoint: () => false,
      effectiveModel: () => controller!.settings.localAI.model,
      voiceTimeoutMs: () => controller!.settings.voiceInteraction.aiResponseTimeoutSeconds * 1000,
      adaptiveVoiceReasoning: () => controller!.settings.voiceInteraction.adaptiveVoiceReasoning,
      prepare: (session, messages, signal, voiceOnly) => companionContext.prepare(session, messages, signal, voiceOnly),
      resolveVoiceCommand: async (session, request, requestId, signal) => {
        if (voiceDesktopLocked) return {handled:true,success:false,text:'Unlock your desktop to use voice actions.'}
        const target = chat!.getSession(chat!.selectedSessionId())!
        const openMedia = /^(?:please )?(?:open|show|display) (?:me )?(?:(?:my|the) )?(?:last|latest|previous) (?:generated )?(image|photo|picture|video|clip)[.!?]?$/i.exec(request.trim())
        if (openMedia) {
          signal.throwIfAborted()
          if (!controller!.settings.automationPermissions.internalNavigation) return {handled:true,success:false,text:'Enable Athena navigation to open generated media by voice.'}
          const kind = /video|clip/i.test(openMedia[1]) ? 'video/' : 'image/'
          const last = [...target.messages].reverse().find(m => m.role==='assistant' && m.artifacts?.some(a=>a.mimeType.startsWith(kind)))
          if (!last) return {handled:true,success:false,text:'This conversation has no matching generated media.'}
          controller!.windows.showControl('conversation')
          const focused=chat!.focusMedia(last.id)
          return {handled:true,success:focused,action:'show_media',text:focused?'Opened the generated media in your conversation.':'This media is no longer available.'}
        }
        const op = chat!.mediaIntent(request)
        if (op) {
          signal.throwIfAborted()
          if (!controller!.settings.automationPermissions.externalMessageSubmission) return { handled:true,success:false,text:'Enable External message submission to send a media request to the active conversation.' }
          floatingMediaRequest=requestId
          const result = await chat!.mediaCommand({action:'generate',sessionId:target.id,requestId,operation:op,prompt:request,options:{}})
          const message = target.messages.find(m=>m.mediaJob?.requestId===requestId)
          return {handled:true,success:!!message,action:'generate_media',text:message?'Your generation request is in the active conversation.':('message' in result?result.message:'Media generation could not start.')}
        }
        return companionContext.resolveNativeVoiceCommand(session, request, requestId, signal, true)
      },
      resolveCommand: (session, command, text, signal) => companionCommands.resolve(session, command, text, signal),
      authorized: id => companionWorkspaces.authorized(id),
      workspaceRoot: id => companionWorkspaces.authorizedRoot(id),
      workspaceOnly: () => companionWorkspaces.filesystemMode() === 'project-only',
      phase: (phase, owner, source) => { if (source !== 'floating-voice') localActivity.phase(phase, owner) },
      approvalChanged: event => taskNotifications?.approval({ ...event, source: 'companion' }),
      beforeAction: event => event.ownership?.origin === 'athena-local' ? narrator?.beforeAction(event) ?? Promise.resolve(undefined) : Promise.resolve(undefined),
      taskEnded: (_sessionId, message) => localActivity.ended(message),
      storeArtifact: input => artifacts.store(input.name, input.mimeType, input.bytes, { provider: input.provider }),
      changed: snapshot => {
        controller!.setVoiceAutomationProgress(snapshot.automationProgress)
        localActivity.activity(snapshot)
        speech?.reconcile()
        for (const window of [controller!.windows.panel, controller!.windows.floating]) window.webContents.send(IPC.chatChanged, snapshot)
      },
    }, new ConversationRepository(companionDirectory))
    const selectCompanionModel = () => {
      const model = controller!.settings.localAI.model
      if (companion!.current().config.model === model) return
      companion!.clearHandsFreeContext()
      const saved = companion!.snapshot().sessions?.find(session => session.config.model === model)
      if (saved) companion!.command({ action: 'switch', id: saved.id })
      else if (companion!.current().messages.length || companion!.current().attachments.length || companion!.current().workspaces.length) companion!.command({ action: 'create' })
      if (model) companion!.command({ action: 'configure-model', id: companion!.current().id, model })
    }
    selectCompanionModel()
    await companionWorkspaces.restore(companion.workspaceReferences())
    const athenaChatDirectory = join(app.getPath('userData'), 'athena-local', 'chat')
    const athenaChatWorkspaces = new WorkspaceService(filesAllowed, new WorkspaceGrants(athenaChatDirectory), () => permissions.filesystemModeFor('local'))
    const athenaChatAttachments = new AttachmentService(athenaChatDirectory, filesAllowed, decodeAttachmentImage)
    const athenaChatCommands = new SlashCommandService(athenaChatWorkspaces, athenaChatDirectory, filesAllowed)
    athenaChat = new ChatController({
      resolveComputerCommand:(session,text,id,signal)=>computerInstruction(text)?athenaChatContext.resolveNativeVoiceCommand(session,text,id,signal,false):Promise.resolve({handled:false}),
      contextDefaults: () => controller!.settings.aiContext,
      rememberedPermissions: permissions.remembered,
      origin: 'athena-local',
      resource: 'local',
      maxConcurrent: () => 1,
      provider: (config, child) => localChatProvider(ollama, controller!.settings, config, child?.isolated, model => athenaChatModels.set(model.name, model), model => (request, project) => academy.instructionsFor(model, request, project), app.getPath('userData')),
      useCheckpoint: () => false,
      effectiveModel: () => athenaChat!.current().config.model,
      prepare: (session, messages, signal, voiceOnly) => athenaChatContext.prepare(session, messages, signal, voiceOnly),
      resolveCommand: (session, command, text, signal) => athenaChatCommands.resolve(session, command, text, signal),
      authorized: id => athenaChatWorkspaces.authorized(id),
      workspaceRoot: id => athenaChatWorkspaces.authorizedRoot(id),
      workspaceOnly: () => athenaChatWorkspaces.filesystemMode() === 'project-only',
      approvalChanged: event => taskNotifications?.approval({ ...event, source: 'local' }),
      phase: (phase, owner) => localActivity.phase(phase, owner),
      taskEnded: (_sessionId, message) => localActivity.ended(message),
      storeArtifact: input => artifacts.store(input.name, input.mimeType, input.bytes, { provider: input.provider }),
      changed: snapshot => {
        localActivity.activity(snapshot)
        if (!controller!.windows.control.isDestroyed()) controller!.windows.control.webContents.send(IPC.athenaChatChanged, snapshot)
      },
    }, new ConversationRepository(athenaChatDirectory))
    athenaChat.initializeModel(controller.settings.localAI.model)
    await athenaChatWorkspaces.restore(athenaChat.workspaceReferences())
    taskNotifications.reconcile([
      ...chat.pendingApprovals().map(entry => ({ ...entry, source: 'online' as const })),
      ...athenaChat.pendingApprovals().map(entry => ({ ...entry, source: 'local' as const })),
      ...companion.pendingApprovals().map(entry => ({ ...entry, source: 'companion' as const })),
    ])
    const nativeWindowAccess=()=>!voiceDesktopLocked && permissions.isCapabilityAllowed('accessibilityControl') && controller!.settings.automationPermissions.desktopUIInteraction
    const desktopPlatform=process.platform==='win32'?new WindowsDesktopPlatform():new MacOSDesktopPlatform(process.platform,undefined,undefined,nativeWindowAccess)
    const installedApps=new InstalledApplications()
    const desktopContext=new DesktopContext((app,request,signal)=>desktopPlatform.workspace(app,request,signal),signal=>desktopActions!.runningApplications(signal))
    interactionOverlay=new InteractionOverlay(()=>controller!.settings.computerUse)
    controller.windows.clearAutomationFeedback=()=>interactionOverlay?.hide()
    desktopActions = new DesktopTools(desktopPlatform, () => permissions.isCapabilityAllowed('desktopAutomation'), () => controller!.settings.doNotDisturb,
      (sessionId, index) => webSearch!.resultAt(sessionId, index),interactionOverlay)
    const foreground=async(signal:AbortSignal)=>{
      const active=(await desktopActions!.runningApplications(signal)).find(a=>a.active)
      if(!active || active.app===app.getName() || active.app==='com.athena.companion')return
      const id=knownApplication(active)
      if(id)return {key:id,name:APPLICATIONS[id].name,id}
      const trusted=controller!.settings.computerUse.trustedInstalled
      const installed=trusted.length && await installedApps.foreground(active,key=>trusted.includes(key),signal)
      return installed ? {key:installed.key,name:installed.name,installed} : undefined
    }
    const canObserveForeground=()=>controller!.settings.computerUse.applicationAwareness && nativeWindowAccess() && controller!.settings.automationPermissions.desktopApplicationControl && permissions.isCapabilityAllowed('applicationDetection') && permissions.isCapabilityAllowed('desktopAutomation')
    const capturePlatform=new MacOSScreenCapture(process.platform,interactionOverlay)
    const automationJournal=new AutomationJournal(join(app.getPath('userData'),'automation'),safeStorage.isEncryptionAvailable()?{
      seal:plain=>safeStorage.encryptString(plain).toString('base64'),
      open:data=>safeStorage.decryptString(Buffer.from(data,'base64')),
    }:undefined)
    const computerTools=new CodexComputerTools()
    const nativeCua=new CodexCua()
    // A loopback grant belongs to one approved project turn and is visible only
    // inside that turn's executor calls. Other browser callers keep public-only access.
    type BrowserTabIdentity = {app:BrowserApp;pid:number;window:string;tab:string}
    type BrowserTurnScope = { owner:string; objective:string; voice:boolean; selection?:BrowserTabIdentity; previewOrigin?:string; focusGrant?:{app:string;pid:number;window:string;tab:string}; clearGrant?():void }
    const browserScope=new AsyncLocalStorage<BrowserTurnScope>()
    const openWindow=(target:AppIdentifier,objective:string,gate:()=>Promise<void>,signal:AbortSignal,observed?:Record<string,unknown>,recipient?:'codex',codexWindowGrants?:Set<string>)=>{
      let observation:import('./desktop/interactionOverlay').InteractionHandle|undefined
      return approvedWindowDriver({
        recipient,codexWindowGrants,
        desktop:desktopActions!,platform:capturePlatform,workspace:(app,query,s)=>desktopPlatform.workspace(app,query,s),athenaPid:process.pid,sameTarget:sameTargetImage,
        observing:async(target,s)=>{observation=await interactionOverlay?.begin({label:'Observing '+APPLICATIONS[target].name},s)},
        stopObserving:()=>observation?.finish(false),
        confirm:(title,description,s)=>confirmVoiceOperation({title,description,allowLabel:codexWindowGrants && title==='Share this window with Codex?'?'Share for this voice session':undefined},s),
        allowed:(app,input,clipboard)=>{
          const {computerUse:c,automationPermissions:p,strictOffline}=controller!.settings
          return !strictOffline && !voiceDesktopLocked && c.enabled && c.vision && !c.blockedApps.includes(app) && p.screenObservation &&
            p.desktopApplicationControl && p.desktopUIInteraction && permissions.isCapabilityAllowed('screenCapture') && permissions.isCapabilityAllowed('applicationDetection') &&
            permissions.isCapabilityAllowed('accessibilityControl') && permissions.isCapabilityAllowed('desktopAutomation') && (!input||c.input) && (!clipboard||c.clipboard)
        },
      },target,objective,gate,signal,observed)
    }
    const applicationAutomation=new ApplicationAutomation({
      config:()=>controller!.settings.applicationAutomation,
      cloudAllowed:()=>!voiceDesktopLocked && !controller!.settings.strictOffline && controller!.settings.computerUse.enabled,
      credential:()=>ai.mediaCredential(),account:()=>ai.usageAccountId(),
      confirm:(title,description,signal)=>confirmVoiceOperation({title,description},signal),
      visual:openWindow,
    },automationJournal)
    app.on('before-quit',()=>applicationAutomation.stop())
    powerMonitor.on('lock-screen',()=>applicationAutomation.stop())
    const nativeActions:NativeActionRegistry = new NativeActionRegistry({
      complexAutomation:async(options,signal)=>{
        const {localChat,voiceOnly,userText,requestId}=options, preferences=controller!.settings
        const localOnly=preferences.strictOffline || localChat===athenaChat || voiceOnly && (!preferences.automationPermissions.externalMessageSubmission || preferences.computerUse.planner==='local')
        const nativeLocal=localOnly || preferences.computerUse.planner==='local'
        const planner=nativeLocal ? (localChat===athenaChat?athenaChat!:companion!) : chat!
        const owner=localChat.current().id, scope=chat!.selectedSessionId()
        const screenQuestion=/\b(?:what (?:can you see|is|do you see)|describe|inspect|look at)\b.*\b(?:screen|window)\b/i.test(userText)
        const pageSearch=isPageSearchRequest(userText)
        const currentTarget=screenQuestion||pageSearch?await foreground(signal):undefined
        const visualTarget=options.visualTarget ?? (screenQuestion || pageSearch && browserApps.some(id=>id===currentTarget?.id)?currentTarget?.id:undefined)
        return applicationAutomation.run({id:requestId,owner:(voiceOnly?'voice:':'chat:')+owner+'|'+scope,text:userText,localOnly,nativeLocal,visualTarget,
          check:async s=>{
            s.throwIfAborted()
            const current=controller!.settings
            if(voiceDesktopLocked || !current.computerUse.enabled || localChat.current().id!==owner || voiceOnly && !current.computerUse.voice)throw new ChatError('The desktop, conversation or automation permission changed.')
            if(!localOnly && (current.strictOffline || voiceOnly && (!current.automationPermissions.externalMessageSubmission || current.computerUse.planner==='local')))throw new ChatError('External automation planning permission changed.')
            if(voiceOnly)await localChat.beforeVoiceStep(s)
          },
          nativePlan:(prompt,s,format)=>{
            if(!nativeLocal && controller!.settings.computerUse.planner==='local')throw new ChatError('The native planner changed to local. Resume with the updated preference.')
            return planner.proposeComputerAction(prompt,s,format)
          },
          observe:async s=>{
            s.throwIfAborted()
            const allowed=controller!.settings.automationPermissions
            const active=canObserveForeground()?await foreground(s):undefined
            const state=active?.id?workspaceStateSchema.parse(await desktopPlatform.workspace(active.id,{operation:'observe',details:true},s)):undefined
            const window=state?.focused?state.windows.find(w=>w.focused):undefined
            return {application:active?.name,window:window?.id,capture:window?.captureId,pid:window?state?.pid:undefined,minimized:window?.minimized,
              conversation:allowed.conversationManagement?chat!.selectedSessionId():undefined}
          },
          tools:(text,id)=>nativeActions.createTools({...options,userText:text,requestId:id}),
          announce:(task,phase,message)=>{
            if(phase!=='running')void automationAudit.record({actionId:'athena.automation.task',permission:'screenObservation',status:phase==='complete'?'completed':phase==='cancelled'?'cancelled':'failed',durationMs:Date.now()-task.started,
              diagnostics:{taskId:task.id,sessionId:owner,provider:task.engine,model:task.engine==='OpenAI'?controller!.settings.applicationAutomation.model:(planner.current().config.model??'Configured native model'),
                targetApplication:task.application??'Resolved by executor',executionMethod:'Existing automation orchestrator',observationMethod:visualTarget?'Scoped window capture':'Registered structured observations',
                verification:phase==='complete'?'Executor returned verified result':'Not verified',result:phase==='complete'?'Task completed; response retained in its conversation.':safeAutomationDiagnostic(message??phase),cursor:'Desktop feedback tied to actual executor actions',apiRequests:String(task.requests??0)}}).catch(()=>{})
            const previous=localChat.snapshot().automationProgress
            localChat.setAutomationProgress({id:requestId,task:task.action,engine:task.engine,application:task.application,phase,paused:task.paused,verifiedSteps:task.steps,apiRequests:task.requests,startedAt:task.started,updatedAt:Date.now(),cancelTarget:voiceOnly?'voice':'chat',steps:previous?.id===requestId?previous.steps:[],message})
          },
        },signal)
      },
      contextualPlan:async(text,signal)=>{
        if(!contextualControl(text) || !canObserveForeground())return
        const target=await foreground(signal)
        if(!target || ['chrome','safari','edge','firefox'].includes(target.key))return
        return {kind:'foreground-control',steps:[{name:'athena_desktop_observed_control',input:{target:target.key}}]}
      },
      authorizedNames:async signal=>{
        const cfg=controller!.settings
        if(voiceDesktopLocked || !cfg.computerUse.enabled || !cfg.automationPermissions.desktopApplicationControl || !permissions.isCapabilityAllowed('applicationDetection') || !cfg.computerUse.trustedInstalled.length)return []
        return (await installedApps.list(signal)).filter(a=>cfg.computerUse.trustedInstalled.includes(a.key)).map(a=>a.name)
      },
      beginInteraction:async(action,input,signal,onConflict)=>{
        const settings=controller!.settings.computerUse
        const win=controller!.windows.control, selector=internalTarget(action,input)
        const controlInput=/^athena\.desktop\.(clickAccessibleElement|scroll|setAccessibleText|pressShortcut)$/.test(action)
        const native=controlInput && typeof input.label==='string'
        const coordinates=()=>native ? desktopActions!.interactionBounds(input.app,String(input.label),signal) :
          selector && controller!.windows.isTrustedURL(win.webContents,win.webContents.getURL()) ? internalBounds(win,selector) : Promise.resolve(undefined)
        const bounds=await coordinates()
        let displayBounds:import('../../shared/desktopActions').DesktopRect|undefined
        if(!bounds && canObserveForeground()){
          const target=appIdentifierSchema.safeParse(input.app)
          const id=target.success?target.data:(await foreground(signal))?.id
          if(id && !settings.blockedApps.includes(id)){
            const view=workspaceStateSchema.parse(await desktopPlatform.workspace(id,{operation:'observe',details:true},signal))
            displayBounds=(view.windows.find(w=>w.focused)??(view.windows.length===1?view.windows[0]:undefined))?.bounds
          }
        }
        let baseline:FocusStamp|undefined
        const watch=settings.applicationAwareness && nativeWindowAccess() && permissions.isCapabilityAllowed('applicationDetection') && settings.pauseOnConflict && (controlInput || !!bounds)
          ? automationFocus.subscribe(stamp=>{if(baseline && (stamp.pid!==baseline.pid || stamp.window!==baseline.window || JSON.stringify(stamp.bounds)!==JSON.stringify(baseline.bounds))){onConflict();interactionOverlay?.hide()} baseline=stamp}) : undefined
        const label=action==='athena.browser.action'?String(input.operation??input.action).replaceAll('-',' '):action.split('.').at(-1)!.replace(/([a-z])([A-Z])/g,'$1 $2').toLowerCase()
        let overlayError:string|undefined
        const indicator=await interactionOverlay?.begin({bounds,displayBounds,nativePixels:!!native||!!displayBounds,label,click:action==='athena.desktop.clickAccessibleElement'},signal).catch(error=>{overlayError=safeAutomationDiagnostic(error instanceof Error?error.message:'Overlay failed');return undefined})
        return {status:indicator?.status??overlayError??'Overlay unavailable',finish:(verified:boolean)=>{watch?.();indicator?.finish(verified)},recheck:async()=>{
          if(bounds && JSON.stringify(await coordinates())!==JSON.stringify(bounds))throw new ChatError('The interaction target moved or lost focus. Inspect it again.')
        }}
      }, onVoiceSubmitted:(message,id)=>{
      if (voiceSubmissions.size >= 64) voiceSubmissions.delete(voiceSubmissions.keys().next().value!)
      voiceSubmissions.set(message,id)
    }, computerLocked:()=>voiceDesktopLocked, controller, onlineChat: chat!, localAthenaChat: athenaChat!, validateLocalModel: async model => {
      try {
        const details = await ollama.modelDetails(model)
        return !details.capabilities.length || details.capabilities.includes('completion')
      } catch { return false }
    }, chatGPT, permissions, confirmDesktopAction: (description, signal) => confirmVoiceOperation({ title: 'Allow desktop interaction?', description }, signal), desktop: desktopActions, academy, academyTraining, audit: automationAudit,
      requestAutomationPermission: async (permission, actionId) => {
        const descriptions = {
          projectManagement: 'Manage explicitly authorized project folders.',
          gitOperations: 'Inspect local Git state and perform explicitly requested safe branch changes.',
          browserInteraction: 'Operate public pages in Athena’s dedicated browser or in an existing browser window you authorize for desktop control.',
          desktopUIInteraction: 'Operate accessible controls only with separate OS accessibility authorization.',
          screenObservation: 'Observe screens only with separate Screen Capture permission and target approval.',
          internalNavigation: 'Let Floating Athena navigate between Athena pages when you explicitly ask.',
          conversationManagement: 'Let Floating Athena create, open, and manage Athena conversations when you explicitly ask.',
          browserAccess: 'Let Floating Athena open requested public web addresses and use separately configured public web tools. This does not enable Brave Search.',
          desktopApplicationControl: 'Let Floating Athena launch supported desktop applications when you explicitly ask. macOS may also ask for Desktop Automation consent.',
          fileReading: 'Let Floating Athena read only files or projects you separately authorize.',
          fileModification: 'Let Floating Athena propose and apply bounded file changes using existing approvals.',
          terminalExecution: 'Let Floating Athena use the existing bounded, approval-controlled project command tools.',
          externalMessageSubmission: 'Let Floating Athena submit exact dictated text to the selected online conversation when you explicitly say send or submit.',
          destructiveOperations: 'Let Floating Athena request individual destructive actions, which still require a separate confirmation.',
        } satisfies Record<import('../../shared/automation').AutomationPermission, string>
        const window = controller!.windows.control
        if (!window.isVisible()) controller!.windows.showControl()
        controller!.windows.dialogActive = true
        try {
          const response = await dialog.showMessageBox(window, { type: 'question', title: 'Allow Athena automation?', message: `Allow ${permission.replaceAll(/([A-Z])/g, ' $1').toLowerCase()}?`, detail: `${descriptions[permission]}\n\nRequested by: ${actionId}. You can revoke this capability in Settings → AI → Automation Permissions.`, buttons: ['Not now', 'Allow and continue'], defaultId: 0, cancelId: 0, noLink: true })
          if (response.response !== 1) return false
          controller!.updateSettings({ automationPermissions: { ...controller!.settings.automationPermissions, [permission]: true } })
          return controller!.settings.automationPermissions[permission]
        } finally { controller!.windows.dialogActive = false }
      },
      openExternalURL: async (url, signal) => {
        signal.throwIfAborted()
        try {
          // The dev Electron shell API activated Chrome during the live voice
          // test but did not navigate it. Use macOS LaunchServices directly;
          // ATHENA_TEST_DATA keeps the Electron integration test isolated.
          const opened = !app.isPackaged && process.env.ATHENA_TEST_DATA
            ? (await shell.openExternal(url, { activate: true }), { ok: true, message: 'macOS accepted the test URL request.' })
            : await desktopActions!.openURLWithBrowserAccess(url, signal)
          if (!opened.ok) throw new Error(opened.message)
          log('automation.browser_open', { result: 'os-accepted', host: new URL(url).host })
          return { ok: true, message: `macOS accepted ${new URL(url).host} for opening in your default browser. Page loading was not verified.` }
        } catch {
          log('automation.browser_open', { result: 'os-rejected', host: new URL(url).host })
          return { ok: false, message: 'macOS did not accept the URL open request. Check the default browser and try again.' }
        }
      },
      confirmDelete: async title => {
        controller!.windows.dialogActive = true
        try {
          const response = await dialog.showMessageBox(controller!.windows.control, { type: 'warning', title: 'Delete conversation?', message: `Delete “${title.slice(0, 120)}”?`, detail: 'This archives the selected online conversation locally. The action cannot be undone from this dialog.', buttons: ['Cancel', 'Delete conversation'], defaultId: 0, cancelId: 0, noLink: true })
          return response.response === 1
        } finally { controller!.windows.dialogActive = false }
      },
    })
    screenCapture = new ScreenCaptureTools(capturePlatform, () => permissions.getPermissionStatus('screenCapture').enabled, () => permissions.isCapabilityAllowed('screenCapture'), () => `online provider ${controller!.settings.aiMode}`)
    const appRoot = app.getAppPath()
    const voiceRoot = app.isPackaged ? process.resourcesPath : basename(appRoot) === 'out-dev' ? dirname(appRoot) : appRoot
    const chatterbox = new ChatterboxSpeech(() => controller!.settings, join(voiceRoot, 'voice-service', 'chatterbox.py'))
    localVoice = new SelectedLocalSpeech(() => controller!.settings, chatterbox, join(app.getPath('userData'), 'voice-cache', 'wake'))
    speech = new SpeechController(localVoice, {
      context: () => { const snapshot = companion!.snapshot(); return { sessionId: snapshot.sessionId!, idle: snapshot.phase === 'idle', lastMessage: companion!.current().messages.at(-1), findMessage: (id: string) => companion!.current().messages.find((entry) => entry.id === id) } },
      settings: () => controller!.settings,
      changed: (status) => {
        controller?.setSpeechState(status.phase)
        controller?.windows.panel.webContents.send(IPC.speechChanged, status)
      },
    })
    narrator = new ActionNarrator(() => controller!.settings, (request) => speech!.announce(request))
    controller.onSettingsChange = (previous, next) => {
      if (previous.voiceInteraction.handsFreeEnabled !== next.voiceInteraction.handsFreeEnabled) controller!.windows.floating.webContents.setBackgroundThrottling(!next.voiceInteraction.handsFreeEnabled)
      if (previous.computerUse !== next.computerUse || previous.automationPermissions !== next.automationPermissions) {
        if (JSON.stringify([previous.computerUse,previous.automationPermissions]) !== JSON.stringify([next.computerUse,next.automationPermissions])) companion?.cancelHandsFreeReply()
      }
      voiceBrowser?.reconcile()
      if(!next.computerUse.enabled || !next.computerUse.visibleCursor && !next.computerUse.highlightTargets)interactionOverlay?.hide()
      if (previous.strictOffline !== next.strictOffline || JSON.stringify(previous.webAccess) !== JSON.stringify(next.webAccess)) webSearch.reconcile()
      if (JSON.stringify(previous.unifiedAccountEnabled) !== JSON.stringify(next.unifiedAccountEnabled)) unifiedAccounts.invalidate()
      if (previous.aiMode !== next.aiMode) {
        voice?.cancel('AI configuration changed. Please record again.'); chat?.stopAll('AI configuration changed. Send a new message or retry.')
      }
      if (previous.strictOffline !== next.strictOffline || JSON.stringify(previous.localAI) !== JSON.stringify(next.localAI)) {
        speech?.stop(); companion?.stop('Local model configuration changed. Retry with the updated settings.'); companion?.clearHandsFreeContext(); companionModel = undefined
        selectCompanionModel()
        if (previous.strictOffline !== next.strictOffline || JSON.stringify({ ...previous.localAI, model: null, visionModel: null }) !== JSON.stringify({ ...next.localAI, model: null, visionModel: null })) athenaChat?.stop('Local inference settings changed. Retry with the updated settings.')
      }
      if (previous.athenaChatAvatarLinked !== next.athenaChatAvatarLinked) reconcileLocalActivity()
      if (previous.voiceInteraction.handsFreeEnabled && !next.voiceInteraction.handsFreeEnabled) {
        handsFree?.deactivate(); companion?.clearHandsFreeContext(); controller?.clearHandsFreeActivity()
      }
      speech?.reconcile()
      if (JSON.stringify(previous.notificationPreferences) !== JSON.stringify(next.notificationPreferences) || previous.doNotDisturb !== next.doNotDisturb || previous.backgroundTasks.badge !== next.backgroundTasks.badge || previous.backgroundTasks.nativeNotifications !== next.backgroundTasks.nativeNotifications) taskNotifications?.settingsChanged()
      if (previous.backgroundTasks.badge !== next.backgroundTasks.badge) taskNotifications?.badge(chat?.unreadCompletions() ?? 0)
      if (previous.backgroundTasks.maxConcurrent !== next.backgroundTasks.maxConcurrent || previous.backgroundTasks.enabled !== next.backgroundTasks.enabled) chat?.updateConcurrency()
    }
    context = new ChatContextService(chat, attachments, workspaces, {
      files: async () => {
        controller!.windows.dialogActive = true
        try { return (await dialog.showOpenDialog(controller!.windows.panel.isVisible() ? controller!.windows.panel : controller!.windows.control, { title: 'Attach files to this conversation', message: 'Saved locally. Relevant contents are sent to the account selected for this conversation when you send a message.', properties: ['openFile', 'multiSelections'] })).filePaths }
        finally { controller!.windows.dialogActive = false }
      },
      folder: async () => {
        controller!.windows.dialogActive = true
        try { return (await dialog.showOpenDialog(controller!.windows.panel.isVisible() ? controller!.windows.panel : controller!.windows.control, { title: 'Authorize a project folder', message: 'Remember access to this project on this Mac, including after restart. Relevant source is sent to your AI provider only for your requests. Changes follow the conversation permission mode. Deleting the project or disabling Personal File Access revokes saved access.', properties: ['openDirectory'] })).filePaths[0] }
        finally { controller!.windows.dialogActive = false }
      },
      saveFile: async (name) => {
        controller!.windows.dialogActive = true
        try { return (await dialog.showSaveDialog(controller!.windows.panel.isVisible() ? controller!.windows.panel : controller!.windows.control, { title: 'Save attachment', defaultPath: name })).filePath }
        finally { controller!.windows.dialogActive = false }
      },
      openFile: async (path) => { const error = await shell.openPath(path); if (error) throw new ChatError(error) },
    }, filesAllowed, agentTools = new AgentTools(workspaces, app.getPath('userData'), () => false, undefined, () => permissions.isCapabilityAllowed('browserAutomation')), applications, desktopActions, screenCapture,
    undefined, webSearch, () => onlineContextSettings(controller!.settings), resolveOpenAIWebSearch, undefined, artifacts, async (model, session) => {
      const profile=await thirdPartyInference.active(session.config.accountRoute?.accountId ?? controller!.settings.thirdPartyConnectionId)
      const selected=profile?.models.find(item=>item.id===model)
      if(!profile)return undefined
      if(!selected)return {contextWindow:undefined,imageInput:false,toolCalling:false}
      const caps=thirdPartyInference.runtimeCapabilities(profile,model)
      return {contextWindow:caps.contextWindow,imageInput:caps.imageInput===true,toolCalling:caps.toolCalling===true||caps.functionCalling===true}
    })
    companionCapture = new ScreenCaptureTools(new MacOSScreenCapture(process.platform,interactionOverlay), () => permissions.getPermissionStatus('screenCapture').enabled, () => permissions.isCapabilityAllowed('screenCapture'), () => `local Ollama model ${controller!.settings.localAI.model ?? ''}`)
    const companionDialog = async <T,>(operation: () => Promise<T>): Promise<T> => {
      controller!.windows.dialogActive = true
      try { return await operation() } finally { controller!.windows.dialogActive = false }
    }
    companionContext = new ChatContextService(companion, companionAttachments, companionWorkspaces, {
      files: () => companionDialog(async () => (await dialog.showOpenDialog(controller!.windows.panel, { title: 'Attach local companion files', message: 'Used only by the local companion model.', properties: ['openFile', 'multiSelections'] })).filePaths),
      folder: () => companionDialog(async () => (await dialog.showOpenDialog(controller!.windows.panel, { title: 'Authorize a local companion project', properties: ['openDirectory'] })).filePaths[0]),
      saveFile: name => companionDialog(async () => (await dialog.showSaveDialog(controller!.windows.panel, { title: 'Save attachment', defaultPath: name })).filePath),
      openFile: async (path) => { const error = await shell.openPath(path); if (error) throw new ChatError(error) },
    }, filesAllowed, companionAgentTools = new AgentTools(companionWorkspaces, companionDirectory, () => controller!.settings.strictOffline, undefined, () => permissions.isCapabilityAllowed('browserAutomation')), applications, desktopActions, companionCapture,
    () => ({ active: true, vision: companionModel?.capabilities.includes('vision') ?? false, tools: companionModel?.capabilities.includes('tools') ?? false, contextCharacters: controller!.settings.localAI.contextLength * 3 }),
    webSearch, () => localCompanionSettings(controller!.settings), undefined, (model, question, signal) => academy.retrieve(model, question, signal), artifacts)
    athenaChatCapture = new ScreenCaptureTools(new MacOSScreenCapture(process.platform,interactionOverlay), () => permissions.getPermissionStatus('screenCapture').enabled, () => permissions.isCapabilityAllowed('screenCapture'), () => `local Ollama model ${athenaChat!.current().config.model ?? ''}`)
    athenaChatContext = new ChatContextService(athenaChat, athenaChatAttachments, athenaChatWorkspaces, {
      files: () => companionDialog(async () => (await dialog.showOpenDialog(controller!.windows.control, { title: 'Attach files to Athena Chat', message: 'Files are used only by the selected local model.', properties: ['openFile', 'multiSelections'] })).filePaths),
      folder: () => companionDialog(async () => (await dialog.showOpenDialog(controller!.windows.control, { title: 'Authorize a local Athena Chat project', properties: ['openDirectory'] })).filePaths[0]),
      saveFile: name => companionDialog(async () => (await dialog.showSaveDialog(controller!.windows.control, { title: 'Save local chat attachment', defaultPath: name })).filePath),
      openFile: async (path) => { const error = await shell.openPath(path); if (error) throw new ChatError(error) },
    }, filesAllowed, athenaChatAgentTools = new AgentTools(athenaChatWorkspaces, athenaChatDirectory, () => controller!.settings.strictOffline, undefined, () => permissions.isCapabilityAllowed('browserAutomation')), applications, desktopActions, athenaChatCapture,
    session => { const model = athenaChatModels.get(session.config.model ?? ''); return { active: true, vision: model?.capabilities.includes('vision') ?? false, tools: model?.capabilities.includes('tools') ?? false, contextCharacters: controller!.settings.localAI.contextLength * 3 } },
    webSearch, () => localCompanionSettings(controller!.settings), undefined, (model, question, signal) => academy.retrieve(model, question, signal), artifacts)
    const projectScope = async (name: string) => {
      const tags = await ollama.call('api/tags', undefined, new AbortController().signal, 10_000)
      const body = await tags.json() as { models?: Array<{ name: string; digest: string }> }
      const model = body.models?.find(m => m.name === name)
      const profile = academy.snapshot().profiles.find(p => p.model === name && p.digest === model?.digest)
      const embedding = body.models?.find(m => m.name === profile?.embeddingModel)
      if (!model?.digest || !embedding?.digest) throw new Error('Choose verified local and embedding models in Academy before indexing project knowledge.')
      return { model: name, digest: model.digest, embeddingModel: embedding.name, embeddingDigest: embedding.digest }
    }
    context.setProjectIntelligence(new ProjectIntelligence(workspaces, slashCommands, app.getPath('userData'), ollama), projectScope)
    companionContext.setProjectIntelligence(new ProjectIntelligence(companionWorkspaces, companionCommands, companionDirectory, ollama), projectScope)
    disposeProjectGit = () => { context.dispose(); companionContext.dispose(); athenaChatContext.dispose() }
    athenaChatContext.setProjectIntelligence(new ProjectIntelligence(athenaChatWorkspaces, athenaChatCommands, athenaChatDirectory, ollama), projectScope)
    const confirmBrowser=async (message:string) => companionDialog(async () => {
      toolDialogs.getStore()?.push('browser input')
      const result = await dialog.showMessageBox(controller!.windows.panel.isVisible() ? controller!.windows.panel : controller!.windows.control, { type: 'question', title: 'Allow browser interaction?', message, detail: 'Check the target page. This may submit data or change the website. Athena will not repeat it automatically.', buttons: ['Cancel', 'Allow once'], defaultId: 0, cancelId: 0, noLink: true })
      return result.response === 1
    })
    voiceBrowser = new VoiceBrowser(() => Boolean(!voiceDesktopLocked && controller?.settings.computerUse.enabled && controller.settings.automationPermissions.browserInteraction && controller.settings.automationPermissions.browserAccess && controller.settings.webAccess.webSearchEnabled), confirmBrowser, undefined, () => controller!.settings.computerUse.browser, async (kind,host,signal)=>{
      const authorized=()=>{
        const s=controller!.settings,p=s.automationPermissions
        return !voiceDesktopLocked && s.computerUse.enabled && (browserScope.getStore()?.voice===false || s.computerUse.voice) && p.browserInteraction && p.browserAccess &&
          permissions.isCapabilityAllowed('personalFiles') && (kind==='upload'?p.fileReading&&p.externalMessageSubmission:p.fileModification)
      }
      if(!authorized())throw new ChatError('Enable the relevant file and browser permissions. Uploading also requires External message submission.')
      const parent=controller!.windows.control
      const path=await companionDialog(async()=>kind==='upload'
        ? (await dialog.showOpenDialog(parent,{title:'Choose a file to share with '+host,properties:['openFile']})).filePaths[0]
        : (await dialog.showSaveDialog(parent,{title:'Save a download from '+host,buttonLabel:'Save new file'})).filePath)
      signal.throwIfAborted()
      if(!authorized())throw new ChatError('File transfer permission changed.')
      return path
    },new ExistingBrowser({
      athenaPid:process.pid,
      expectedSelection:()=>browserScope.getStore()?.selection,
      backgroundOwner:()=>{
        const turn=browserScope.getStore()
        return turn && (turn.voice || controller!.settings.computerUse.handsFreeBrowserSearches && isPageSearchRequest(turn.objective)) ? turn.owner : undefined
      },
      handsFreeSearch:()=>{
        const turn=browserScope.getStore()
        return !!turn && controller!.settings.computerUse.handsFreeBrowserSearches && isPageSearchRequest(turn.objective)
      },
      allowBackground:target=>computerTools.allowsVoiceBrowser(browserScope.getStore()?.owner,target),
      allowSearch:(target,text)=>{
        const turn=browserScope.getStore()
        return !!turn && (turn.voice || controller!.settings.computerUse.handsFreeBrowserSearches) && computerTools.allowsVoiceBrowser(turn.owner,target) && dictatedBrowserText(turn.objective,text,true)
      },
      context:desktopContext,mark:(target,signal)=>interactionOverlay!.begin(target,signal),canDiscover:()=>nativeWindowAccess() && controller!.settings.automationPermissions.desktopApplicationControl && permissions.isCapabilityAllowed('applicationDetection') && permissions.isCapabilityAllowed('desktopAutomation'),feedback:()=>controller!.settings.computerUse,settings:()=>controller!.settings.computerUse,
      requireExisting:()=>!!browserScope.getStore(),
      consumeFocusGrant:target=>{
        const scope=browserScope.getStore(), grant=scope?.focusGrant
        scope?.clearGrant?.()
        return !!grant && grant.app===target.app && grant.pid===target.pid && grant.window===target.window && grant.tab===target.tab
      },
      publicURL:async value=>{
        const grant=browserScope.getStore()?.previewOrigin
        if(grant){const url=new URL(value);if(url.origin===grant && !url.username && !url.password)return true}
        return isPublicBrowserURL(value)
      },confirm:confirmBrowser,
      defaultBrowser:()=>{const name=app.getApplicationNameForProtocol('https').toLowerCase();return browserApps.find(id=>name.includes(id))},
      allowed:(id,input)=>{const cfg=controller!.settings;return !voiceDesktopLocked && cfg.computerUse.enabled && (browserScope.getStore()?.voice===false || cfg.computerUse.voice) && cfg.automationPermissions.browserInteraction && cfg.automationPermissions.browserAccess && cfg.webAccess.webSearchEnabled && nativeWindowAccess() && permissions.isCapabilityAllowed('desktopAutomation') && permissions.isCapabilityAllowed('applicationDetection') && cfg.automationPermissions.desktopApplicationControl && !cfg.computerUse.blockedApps.includes(id) && (!input || cfg.computerUse.input)},
      onOtherDisplay:(a,b)=>!!a.bounds && !!b.bounds && screen.getDisplayMatching(screenRect(a.bounds,true)).id!==screen.getDisplayMatching(screenRect(b.bounds,true)).id,
      launch:(id,signal)=>desktopPlatform.openApplication(id,signal),nativePage:(id,request,signal)=>desktopPlatform.browserPage(id,request,signal),
    }),()=>controller!.settings.computerUse)
    nativeActions.register(voiceDesktopActions(desktopActions, voiceBrowser,app=>!controller!.settings.computerUse.blockedApps.includes(app),{
      contextAction:async(input,text,signal,revalidate)=>{
        const focused=await foreground(signal), intent=contextualControl(text)
        if(!focused || focused.key!==input.target || !intent || /terminal|powershell|command prompt|iterm|console/i.test(focused.name))throw new ChatError('Focus an authorized application control and repeat the instruction.')
        const {id,installed}=focused
        const check=async()=>{
          await revalidate()
          if(!canObserveForeground() || !controller!.settings.computerUse.input || id && controller!.settings.computerUse.blockedApps.includes(id) || (await foreground(signal))?.key!==focused.key)throw new ChatError('The target is unavailable or the foreground changed. Name an authorized application.')
        }
        await check()
        const view=installed ? await desktopActions!.installedAction(installed,'inspect','',signal) : await desktopActions!.inspectAccessibleUI(id,signal)
        const matches=(view.elements??[]).filter(e=>e.enabled && (intent.label ? e.label===intent.label : intent.operation==='scroll' ? /scrollbar/i.test(e.role) : e.focused && /button/i.test(e.role)))
        if(matches.length!==1){
          if(id)throw new ObservationRequired(id,'The foreground application did not expose one matching accessible control. No input was issued; a scoped visual observation is required.')
          throw new ChatError('Which control? Say its exact accessible name and application.')
        }
        const target=matches[0]
        if(intent.operation!=='scroll' && !await confirmVoiceOperation({title:'Allow desktop interaction?',description:intent.operation+' in '+focused.name+' on “'+target.label+'”. Review the target and its effects.'},signal))throw new ChatError('Application action declined.')
        await check()
        if(installed){
          const {ok,message}=await desktopActions!.installedAction(installed,intent.operation==='type'?'set-text':intent.operation,target.label,signal,intent.text??intent.direction)
          return {ok,message}
        }
        const bounds=await desktopActions!.interactionBounds(id,target.label,signal)
        const mark=await interactionOverlay?.begin({bounds,nativePixels:true,label:intent!.operation,click:intent!.operation==='click'},signal)
        let verified=false
        try{
          await check()
          if(JSON.stringify(bounds)!==JSON.stringify(await desktopActions!.interactionBounds(id,target.label,signal)))throw new ChatError('The target moved. Inspect it again.')
          const result=intent!.operation==='scroll'?await desktopActions!.scrollAccessible(id,target.label,intent!.direction as 'up'|'down',signal):intent!.operation==='type'?await desktopActions!.setAccessibleText(id,target.label,intent!.text!,signal):await desktopActions!.clickAccessibleElement(id,target.label,signal)
          verified=result.verified
          return {...result}
        }finally{mark?.finish(verified)}
      },
      selectWindow:async(selection,name,signal)=>{
        const active=(await desktopActions!.runningApplications(signal)).find(a=>a.active)
        const id=name?.toLowerCase()==='browser'?await desktopContext.browser(undefined,signal):
          name?knownApplication({app:name.toLowerCase()==='vs code'?'vscode':name,name}):knownApplication(active)
        const cfg=()=>controller!.settings.computerUse
        if(id && cfg().blockedApps.includes(id))throw new ChatError('The application is disabled in Computer use settings.')
        const trusted=(key:string)=>cfg().trustedInstalled.includes(key)
        const installed=id?undefined:name?await installedApps.resolve(name,trusted,signal):active && await installedApps.foreground(active,trusted,signal)
        const invoke=async(request:import('./desktop/desktopContext').WorkspaceRequest)=>{
          if(!nativeWindowAccess() || !cfg().enabled || (id?cfg().blockedApps.includes(id):!installed || !cfg().trustedInstalled.includes(installed.key)))throw new ChatError('Application authorization changed.')
          return id?desktopPlatform.workspace(id,request,signal):desktopPlatform.workspaceInstalled(installed!,request,signal)
        }
        const state=workspaceStateSchema.parse(await invoke({operation:'observe',details:true}))
        const original=chooseWindow(state)
        if(!original)throw new ChatError('The application has no accessible window.')
        let dest=selection==='other'?otherWindow(state,original):original
        if(selection==='other-display'){
          if(!original.bounds)throw new ChatError('The active window has no observable display bounds.')
          const monitor=screen.getDisplayMatching(screenRect(original.bounds,true)).id
          dest=chooseWindow(state,w=>!!w.bounds && screen.getDisplayMatching(screenRect(w.bounds,true)).id!==monitor)!
        }
        return workspaceResultSchema.parse(await invoke({operation:'activate',...windowRequest(state,dest),details:true}))
      },
      catalog:installedApps,
      trusted:key=>!voiceDesktopLocked && controller!.settings.computerUse.trustedInstalled.includes(key),
      confirm:(description,signal)=>confirmVoiceOperation({title:'Allow application action?',description},signal),
    }))
    nativeActions.register(voiceProjectActions({ chat, context, catalog: () => unifiedAccounts.list(), provider: () => controller!.settings.aiMode,
      location:async()=>{const w=controller!.windows.control;if(w.isDestroyed() || !controller!.windows.isTrustedURL(w.webContents,w.webContents.getURL()))return
        return w.webContents.executeJavaScript('document.querySelector("main[data-active-page]")?.dataset.activePage')},
      showConversation: () => controller!.windows.showControl('conversation'),
      pickFolder: createName => companionDialog(async () => (await dialog.showOpenDialog(controller!.windows.panel.isVisible() ? controller!.windows.panel : controller!.windows.control, {
        title: createName ? 'Choose parent folder for the new project' : 'Authorize a project folder',
        message: createName ? `Create “${createName}” inside the folder you select. Only the new folder receives project access.` : 'Authorize this folder as a project. Changes follow its conversation permission mode.',
        properties: ['openDirectory'],
      })).filePaths[0]),
      reveal: async folder => { const error = await shell.openPath(folder); if (error) throw new ChatError('The file manager could not open this project folder.') },
    }))
    function makeComputerTurn(owner:string,objective:string,requestId:string,voiceOnly:boolean,turnSignal:AbortSignal,project=false,voiceCheck?:(s:AbortSignal)=>Promise<void>,voiceModel?:string) {
      const localChat=voiceOnly?companion!:chat!
      const accessOwner=owner
      const turnScope:BrowserTurnScope={voice:voiceOnly,owner:accessOwner,objective}
      const check=async(signal:AbortSignal)=>{
        turnSignal.throwIfAborted()
        signal.throwIfAborted()
        const cfg=controller!.settings
        if(voiceDesktopLocked || cfg.strictOffline || !cfg.computerUse.enabled || voiceOnly && (!cfg.computerUse.voice || cfg.applicationAutomation.engine!=='codex'))
          throw new ChatError('Computer use is unavailable. Check the current engine, desktop lock and automation permissions.')
        if(voiceCheck)await voiceCheck(signal)
      }
      const listWindows=async(target:AppIdentifier,signal:AbortSignal,pinned?:import('./desktop/codexComputerTools').CodexBrowserTarget)=>{
        await check(signal)
        if(!canObserveForeground() || controller!.settings.computerUse.blockedApps.includes(target))throw new ChatError('Window inspection requires application detection and authorized desktop access.')
        return workspaceStateSchema.parse(await desktopPlatform.workspace(target,{operation:'observe',tabs:true,details:true,...(pinned?.tab?{pid:pinned.pid,window:pinned.window,tab:pinned.tab}:{})},signal))
      }
      let lastSelected=computerTools.previousBrowser(owner)
      const browserTarget=async(signal:AbortSignal,initialSearch?:Pick<import('../../shared/applicationAutomation').BrowserSearchRequest,'browser'|'destination'>)=>{
        await check(signal)
        if(!canObserveForeground() || !controller!.settings.automationPermissions.browserInteraction)throw new ChatError('Enable browser interaction and desktop application detection to inspect the browser.')
        const background=(voiceOnly || controller!.settings.computerUse.handsFreeBrowserSearches && isPageSearchRequest(objective)) && await voiceBrowser?.backgroundTarget(signal)
        if(background)return background
        if(process.platform==='darwin' && initialSearch && controller!.settings.computerUse.handsFreeBrowserSearches && isPageSearchRequest(objective)){
          const current=await voiceBrowser?.initialSearchTarget(initialSearch.browser,initialSearch.destination,signal)
          if(current)return current
        }
        const target=await desktopContext.browser(undefined,signal)??lastSelected?.app
        if(!target || !browserApps.includes(target as BrowserApp))return
        const pin=lastSelected?.app===target?lastSelected:undefined
        const state=await listWindows(target,signal,pin),win=chooseWindow(state)
        if(win){
          const observed={app:target,pid:state.pid,window:win.id,capture:win.captureId,tab:win.tabs?.find(t=>t.selected)?.id,url:win.address,focused:state.focused && win.focused}
          if(observed.tab && observed.url)lastSelected=observed
          return observed
        }
      }
      const confirm=async(title:string,description:string,signal:AbortSignal)=>{
        const active=canObserveForeground()?await foreground(signal):undefined
        const before=active?.id?await listWindows(active.id,signal):undefined
        const original=before?.windows.find(w=>w.focused && !w.hidden && !w.minimized)
        turnScope.clearGrant?.()
        let changed=false
        const unsubscribe=original && before ? automationFocus.subscribe(stamp=>{
          if(stamp.pid!==process.pid && (stamp.pid!==before.pid || stamp.window!==original.id)){
            changed=true;turnScope.clearGrant?.()
          }
        }):undefined
        let expiry:ReturnType<typeof setTimeout>|undefined
        const clear=()=>{unsubscribe?.();clearTimeout(expiry);turnScope.focusGrant=undefined;turnScope.clearGrant=undefined}
        turnScope.clearGrant=clear
        let approved=false
        try{
          const allowLabel=voiceOnly && title==='Allow routine control of this browser tab?' ? 'Allow for this voice session' :
            voiceOnly && title==='Share this context with Codex?' ? 'Share for this voice session' : undefined
          approved=await confirmVoiceOperation({title,description,allowLabel},signal)
          if(approved && !changed && active?.id && before?.focused && original){
            const after=await listWindows(active.id,signal)
            const same=after.windows.find(w=>w.id===original.id && !w.minimized && !w.hidden)
            const tab=original.tabs?.find(t=>t.selected)?.id
            if(!changed && same && after.foreground===process.pid && after.pid===before.pid && tab===same.tabs?.find(t=>t.selected)?.id){
              if(tab && browserApps.some(id=>id===active.id)){
                turnScope.focusGrant={app:active.id,pid:before.pid,window:original.id,tab}
                expiry=setTimeout(clear,2000)
              }
              await desktopPlatform.workspace(active.id,{operation:'activate',...windowRequest(after,same),details:true},signal)
            }
          }
        }finally{if(!turnScope.focusGrant)clear()}
        return approved
      }
      let binding:CuaBinding|undefined, cuaDenied=false
      let authorizedTab:import('./desktop/codexComputerTools').CodexBrowserTarget|undefined
      const controls=new CodexCuaControls()
      let selectedMethod:string|undefined, fallbackReason:string|undefined
      const preferredComputer:NonNullable<import('./ai/nativeActionRegistry').NativeActionOptions['preferredComputer']>=async(name,args,signal,allowed,diagnostics)=>{
        const operation=cuaOperation(name,args)
        const local=(reason:string)=>{diagnostics.executionMethod=selectedMethod='Athena local driver';fallbackReason=reason;diagnostics.fallbackReason=reason;return undefined}
        if(cuaDenied)throw new ChatError('The Codex computer-use plugin is disabled for this thread.')
        if(!operation){
          const id=appIdentifierSchema.safeParse(args.app??args.browser??authorizedTab?.app)
          if(binding && id.success)await authorizeCua(binding,APPLICATIONS[id.data].bundleId,typeof args.url==='string'?args.url:authorizedTab?.url)
          return local('Window setup or this operation uses the registered local driver.')
        }
        if(!binding || process.platform!=='darwin')return local('The scoped native CUA application interface is unavailable on this platform or turn.')
        if(operation==='navigate' && authorizedTab && (!authorizedTab.url || /^(?:about:blank|chrome:\/\/newtab\/?|edge:\/\/newtab\/?|about:newtab)$/.test(authorizedTab.url))){
          const destination=String(args.url)
          await authorizeCua(binding,APPLICATIONS[authorizedTab.app].bundleId,destination)
          return local('The selected empty tab has no web document for CUA to identify. The local window driver will open the requested address.')
        }
        const browser=name==='athena_browser_action'
        const input=!['inspect','read','athena_desktop_inspect_accessible_ui'].includes(operation)
        const current=async()=>{
          await check(signal);await allowed()
          const cfg=controller!.settings, p=cfg.automationPermissions
          if(!canObserveForeground() || !permissions.isCapabilityAllowed('accessibilityControl') || !p.desktopUIInteraction ||
             !p.screenObservation || input && !cfg.computerUse.input || browser && (!p.browserAccess || !p.browserInteraction || !cfg.webAccess.webSearchEnabled))
            throw new ChatError('Enable the required application, observation and input permissions for Codex computer use.')
          const app=browser?authorizedTab?.app:args.app
          if(!appIdentifierSchema.safeParse(app).success || app==='terminal' || cfg.computerUse.blockedApps.includes(app as AppIdentifier))throw new ChatError('The intended application is unavailable or outside the allowed scope.')
          const id=app as AppIdentifier, state=await listWindows(id,signal,browser?authorizedTab:undefined), w=chooseWindow(state)
          if(!w || w.minimized || w.hidden || !state.focused && state.windows.filter(x=>!x.hidden && !x.minimized).length!==1)return
          if(!browser && (!authorizedTab || authorizedTab.app!==id || authorizedTab.pid!==state.pid || authorizedTab.window!==w.id))
            throw new ChatError('The authorized desktop window changed. Inspect the current window before acting.')
          const selected=w.tabs?.find(t=>t.selected),tab=selected?.id
          const uniqueTitle=selected?.title && state.windows.flatMap(win=>(win.tabs??[]).filter(t=>t.selected)).filter(t=>t.title===selected.title).length===1 ? w.documentTitle || selected.title : undefined
          if(browserApps.includes(id as BrowserApp)){
            if(!browser || !tab || !w.address)throw new ChatError('Use the scoped browser control for an identifiable, selected web tab.')
            if(!authorizedTab || authorizedTab.pid!==state.pid || authorizedTab.window!==w.id || authorizedTab.tab!==tab)throw new ChatError('The selected tab is no longer the authorized tab.')
            if(!(turnScope.previewOrigin && new URL(w.address).origin===turnScope.previewOrigin) && !await isPublicBrowserURL(w.address))throw new ChatError('This tab is outside the authorized public or project preview scope.')
          }
          return {app:id,pid:state.pid,window:w.id,tab:browser?tab:undefined,url:browser?w.address:undefined,uniqueTitle:browser?uniqueTitle:undefined,uniqueWindowTitle:browser?w.uniqueWindowTitle:undefined}
        }
        const target=await current()
        if(!target)throw new ChatError('Select the intended application window so Codex can verify it.')
        let call
        const bundle=APPLICATIONS[target.app].bundleId
        if(browser && target.url!==authorizedTab?.url)throw new ChatError('The page changed since authorization. Inspect the selected tab again.')
        try{call=await nativeCua.application(owner,binding,bundle,signal,target.url,detail=>confirm('Codex computer-use approval',detail,signal))}
        catch(error){if(error instanceof CuaUnavailable)return local(error.userMessage);throw error}
        diagnostics.executionMethod=selectedMethod='Codex cua_repl.js'
        diagnostics.observationMethod='Codex native application accessibility'
        diagnostics.cursor='Codex native feedback; visibility not reported by the protocol'
        const parent=binding
        try{return await controls.run({name,args},{target,current,call,signal,
          historyDestination:direction=>computerTools.historyDestination(owner,target,direction),
          resolveLink:async label=>{
            if(!target.tab || !target.url)return
            const active=await current()
            if(!active || active.url!==target.url)throw new ChatError('The selected page changed before the link could be verified.')
            const observed=workspaceStateSchema.parse(await desktopPlatform.workspace(target.app,{operation:'observe',tabs:true,details:true,
              pid:target.pid,window:target.window,tab:target.tab,url:target.url,linkLabel:label},signal))
            const win=observed.windows.find(w=>w.id===target.window && w.address===target.url && w.tabs?.some(t=>t.id===target.tab && t.selected))
            if(observed.pid===target.pid && win && !win.minimized && !win.hidden)return win.linkDestination
          },
          allowDestination:async url=>{
            if(!(turnScope.previewOrigin && new URL(url).origin===turnScope.previewOrigin) && !await isPublicBrowserURL(url))throw new ChatError('This destination is outside the authorized scope.')
            await authorizeCua(parent,bundle,url)
          },
          confirm:detail=>confirm('Allow this computer action?',detail,signal)})}catch(error){
          if(error instanceof UnsupportedCuaControl)return local(error.userMessage)
          throw error
        }
      }
      const registry=nativeActions.createTools({localChat,userText:objective,requestId:owner+':'+requestId,voiceOnly,preferredComputer,
        reviewComputerStep:(description,signal)=>confirm('Allow this Codex computer action?',description,signal)})
      const tools=computerTools.forTurn({
        owner:accessOwner,chatSession:voiceOnly?undefined:owner,hasUnverifiedInput:()=>controls.hasUnverifiedInput,objective,registry,check,browserTarget,listWindows,bindTarget:target=>{authorizedTab=target},
        authorizeBrowserObservation:async(target,signal)=>{
          await check(signal)
          const cfg=controller!.settings
          if(!canObserveForeground() || !cfg.automationPermissions.browserAccess || !cfg.automationPermissions.browserInteraction || cfg.computerUse.blockedApps.includes(target.app))
            throw new ChatError('Browser observation is unavailable for the selected application.')
          if(cuaDenied)throw new ChatError('The Codex computer-use plugin is disabled for this thread.')
          if(binding)await authorizeCua(binding,APPLICATIONS[target.app].bundleId,target.url)
          signal.throwIfAborted()
        },
        withTabSelection:(selection,run)=>browserScope.run({...turnScope,selection},run),
        handsFreeSearch:()=>controller!.settings.computerUse.handsFreeBrowserSearches,
        confirm,
        openWindow:async(target,text,gate,signal,grants)=>{
          const state=await listWindows(target,signal)
          const window=state.focused && state.windows.find(w=>w.focused && !w.hidden && !w.minimized)
          if(!window)throw new ChatError('Focus the window you want to share with Codex.')
          return openWindow(target,text,gate,signal,{
            application:APPLICATIONS[target].name, pid:state.pid, window:window.id,
            capture:window.captureId, tab:window.tabs?.find(item=>item.selected)?.id
          },'codex',grants)
        },
        openProjectPreview:project?async(url,signal)=>{
          const preview=new URL(url)
          if(preview.protocol!=='http:' || !['localhost','127.0.0.1','[::1]'].includes(preview.hostname) || Number(preview.port)<1024 || !preview.port || preview.username || preview.password)
            throw new ChatError('Choose an unprivileged loopback port for this development server.')
          turnScope.previewOrigin=preview.origin
          try {
            const result=await voiceBrowser!.run({action:'window',operation:'navigate',url},signal,'Use the existing browser')
            if(!result.ok)turnScope.previewOrigin=undefined
            return result
          } catch(error){turnScope.previewOrigin=undefined;throw error}
        }:undefined,
      })
      tools.bindComputerTurn=(turn,denied)=>{binding=turn;cuaDenied=denied}
      const dispose=tools.dispose
      tools.dispose=()=>{
        turnScope.clearGrant?.()
        if(!voiceOnly)voiceBrowser?.forgetBackground(accessOwner)
        const result=dispose?.()
        return result
      }
      const execute=tools.execute
      // The stdio listener was created outside the background chat's async
      // context. Restore the originating conversation before any registry call.
      const runInOrigin=AsyncLocalStorage.snapshot()
      let latestFailure:string|undefined
      tools.lastFailure=()=>latestFailure
      tools.execute=(name,input,signal)=>runInOrigin(()=>browserScope.run(turnScope,async()=>{
        const started=Date.now()
        selectedMethod=undefined;fallbackReason=undefined
        const painted=new Set<string>()
        const dialogs:string[]=[]
        let status:'completed'|'cancelled'|'failed'='failed'
        let reason:string|undefined
        let errorCode:string|undefined
        try {
          const run=()=>toolDialogs.run(dialogs,()=>execute(name,input,signal))
          const result=interactionOverlay ? await interactionOverlay.reportTo(value=>painted.add(value),run,requestId) : await run()
          const receipt=JSON.parse(result)
          if(receipt.ok===true)status='completed'
          else {
            reason=safeAutomationDiagnostic(String(receipt.error??receipt.message??'Unverified computer action'))
            if(typeof receipt.code==='string' && /^[a-z0-9-]{1,64}$/.test(receipt.code))errorCode=receipt.code
          }
          return result
        }catch(error){
          reason=safeAutomationDiagnostic(error instanceof Error?error.message:'Computer action failed.')
          if(error instanceof Error && 'automationCode' in error && typeof error.automationCode==='string'
              && /^[a-z0-9-]{1,64}$/.test(error.automationCode))errorCode=error.automationCode
          throw error
        }finally{
          if(signal.aborted || turnSignal.aborted)status='cancelled'
          if(status==='failed' && reason)latestFailure=reason
          // Only tool identifiers and renderer acknowledgments are recorded.
          // Page text, captured images, arguments and successful receipts stay out of the audit.
          void automationAudit.record({actionId:'athena.codex.computerTool',permission:'computerUse',status,durationMs:Date.now()-started,
            diagnostics:{taskId:requestId,sessionId:owner,provider:'Codex App Server',model:voiceModel??localChat.current().config.model??'Codex',
              requestedAction:name,executionMethod:selectedMethod??'Local computer tool',...(fallbackReason?{fallbackReason:String(fallbackReason)}:{} as Record<string,string>),approvalDialogs:dialogs.length?dialogs.join(', '):'None',cursor:selectedMethod==='Codex cua_repl.js'?'Native Codex cursor; visibility unreported':[...painted].join(' · ') || 'No target feedback painted',
              verification:status==='completed'?'Local tool returned success':'Unverified',...(reason?{failureReason:reason}:{}),...(errorCode?{errorCode}:{})}
          }).catch(()=>log('automation.audit_write_failed'))
        }
      }))
      return tools
    }
    let voiceTask:AutomationEngineStatus['task']
    let codexConnection:AutomationEngineStatus['codex']
    const codexVoice=new CodexVoiceAutomation({
      service:codexCLI,cwd:codexVoiceCwd,
      selection:async()=>{
        if(!unifiedAccounts.isEnabled({provider:'subscription',accountId:'codex-local'}))throw new ChatError('Enable the Codex subscription account in AI settings.')
        const status=await codexCLI.status(),model=controller!.settings.applicationAutomation.model
        if(!status.authenticated || !status.identity)throw new ChatError(status.message)
        if(!status.models.some(item=>item.id===model))throw new ChatError('The selected automation model is unavailable in your Codex account.')
        return {model,identity:status.identity}
      },
      tools:ctx=>makeComputerTurn(ctx.owner,ctx.objective,ctx.requestId,true,ctx.signal,false,ctx.check,ctx.model),
      forget:owner=>{nativeCua.forget(owner);computerTools.forget(owner);voiceBrowser?.forgetBackground(owner)},
      onControl:(id,action)=>{
        if(voiceTask?.id!==id)return
        voiceTask.paused=action==='pause'
        if(action==='resume')interactionOverlay?.setTaskStatus(id,'Continuing voice automation')
        else interactionOverlay?.endTask(id,true)
      },
      announce:event=>{
        const running=event.phase==='running'
        const paused=voiceTask?.id===event.id && voiceTask.paused
        voiceTask=running?{id:event.id,action:event.message,engine:'Codex',model:event.model,started:event.started,paused:!!paused,steps:event.verifiedSteps}:undefined
        if(running && !paused)interactionOverlay?.setTaskStatus(event.id,'Working on your voice request')
        else if(!running)interactionOverlay?.endTask(event.id,event.phase!=='complete')
        companion!.setAutomationProgress({id:event.id,task:'Voice computer use',engine:'Codex',cancelTarget:'voice',phase:event.phase,
          startedAt:event.started,updatedAt:Date.now(),steps:[],verifiedSteps:event.verifiedSteps,message:event.message})
      },
    })
    const mediaSettings = () => controller!.settings.mediaGeneration
    const mediaRegistry = new MediaRegistry(ai, thirdPartyInference, mediaSettings, ctx=>cursorMedia(ctx,cursorACP,cursorGeneralWorkspace,artifacts),(provider,accountId)=>unifiedAccounts.isEnabled({provider,accountId}))
    for (const [host, files, local] of [[chat, attachments, false], [athenaChat, athenaChatAttachments, true], [companion, companionAttachments, true]] as const) {
      host.attachMedia(new MediaService(mediaRegistry, mediaSettings, session => {
        const route = session.config.accountRoute
        const mode = route?.provider ?? controller!.settings.aiMode
        const legacyPrivate = controller!.settings.reviewLegacyLocalHistory && session.messages.some(m=>m.role==='assistant'&&m.ownership?.origin!=='online-chat')
        return { selected: mode === 'third-party' ? route?.accountId ?? controller!.settings.thirdPartyConnectionId ?? '' : mode,
          model: session.config.model, offline: local || legacyPrivate || controller!.settings.strictOffline }
      }, artifacts, async (session, attachment) => {
        if (attachment.kind === 'video') return { mime: attachment.mime, bytes: await files.original(session.id, attachment) }
        const file = await files.prepare(session.id, attachment)
        if (!file.data.startsWith('data:image/png;base64,')) throw new Error('Unsupported reference format.')
        return { mime:'image/png',bytes:Buffer.from(file.data.slice('data:image/png;base64,'.length),'base64') }
      },join(app.getPath('userData'),'media-spending','reservations.json')))
    }
    companionContext.setVoiceVisualInputAllowed(app => {
      const settings = controller!.settings
      return !voiceDesktopLocked && settings.computerUse.input && app!=='terminal' && !settings.computerUse.blockedApps.includes(app) &&
        settings.automationPermissions.desktopApplicationControl && settings.automationPermissions.desktopUIInteraction &&
        permissions.isCapabilityAllowed('desktopAutomation') && permissions.isCapabilityAllowed('accessibilityControl')
    })
    companionContext.setVoiceProjectSource(signal => context.voiceProjectTools(signal, companion!, () => controller!.settings.automationPermissions))
    companionContext.setNativeActions((_session, userText, requestId, voiceOnly) => nativeActions.createTools({ localChat: companion!, userText, requestId, voiceOnly }))
    context.setNativeActions((_session,userText,requestId,voiceOnly)=>nativeActions.createTools({localChat:chat!,userText,requestId,voiceOnly}))
    athenaChatContext.setNativeActions((_session, userText, requestId, voiceOnly) => nativeActions.createTools({ localChat: athenaChat!, userText, requestId, voiceOnly }))
    const localTranscription = new LocalWhisperTranscription(() => controller!.settings)
    meetings = new MeetingService({ windows: controller.windows, root: join(app.getPath('userData'), 'meetings'), transcriber: localTranscription, artifacts,
      offline: () => controller!.settings.strictOffline, filesAllowed: () => permissions.isCapabilityAllowed('personalFiles'),
      models: async () => {
        const list: Array<{ id: string; provider: 'local' | 'subscription' | 'cloud' | 'claude-api'; vision: boolean }> = []
        const results = await Promise.allSettled([ollama.status(), ai.getStatus(), claudeAPI.getStatus(), chatGPT.status()])
        const local = results[0]; if (local.status === 'fulfilled') for (const m of local.value.models) list.push({ id:m.name, provider:'local', vision:m.capabilities.includes('vision') })
        const api = results[1]; if (api.status === 'fulfilled' && api.value.status.active) for (const id of api.value.status.models) list.push({id,provider:'cloud',vision:supportsImageInput(id,'openai-responses')})
        const claude = results[2]; if (claude.status === 'fulfilled' && claude.value.status.active) for (const id of claude.value.status.models) list.push({id,provider:'claude-api',vision:supportsImageInput(id,'openai-responses')})
        const subscription = results[3]; if (subscription.status === 'fulfilled') for (const m of subscription.value.models) list.push({id:m.slug,provider:'subscription',vision:supportsImageInput(m.slug,'openai-responses')})
        return list
      },
      provider: async p => {
        if (p.provider === 'local') { const model = (await ollama.status()).models.find(m => m.name === p.model); if (!model) throw new Error('Selected Ollama model is not installed. Install it in Local AI setup.'); return {provider:new MeetingOllamaProvider(ollama,p.model,controller!.settings.localAI,model),vision:model.capabilities.includes('vision')} }
        if (controller!.settings.strictOffline || !p.cloudConsent) throw new Error('Online meeting context is not authorized.')
        if (p.provider === 'subscription') { const { accessToken, model, accountId, requestIdentity, contextWindow } = await chatGPT.activeModel(p.model); return {provider:new OpenAIProvider(accessToken,model,undefined,controller!.settings.aiGeneration,true,rejected => chatGPT.accessTokenForRound(accountId,rejected),requestIdentity,usageLedger.forAccount('chatgpt-subscription',accountId),contextWindow),vision:supportsImageInput(model,'openai-responses')} }
        if (p.provider === 'claude-api') { const { apiKey,model,capacity } = await claudeAPI.getActiveConfiguration(p.model); if(model !== p.model) throw new Error('Selected model unavailable; no fallback used'); return {provider:new ClaudeAPIProvider(apiKey,model,undefined,capacity),vision:supportsImageInput(model,'openai-responses')} }
        const status = await ai.getStatus(); if(!status.status.models.includes(p.model)) throw new Error('Selected API model unavailable; no fallback used'); const {apiKey,model} = await ai.getActiveConfiguration(p.model); return {provider:new OpenAIProvider(apiKey,model,undefined,controller!.settings.aiGeneration,false,undefined,{},usageLedger.forAccount('openai-api',apiUsageAccount(apiKey))),vision:supportsImageInput(model,'openai-responses')}
      },
    })
    await meetings.initialize()

    voice = new VoiceController(new RoutedTranscription(() => onlineContextSettings(controller!.settings),
      new OpenAITranscriptionService(async () => (await ai.getActiveConfiguration(chat!.current().config.model)).apiKey), localTranscription), {
      context: () => {
        const current = chat!.current()
        return { sessionId: current.id, idle: chat!.snapshot().phase === 'idle',
          fingerprint: JSON.stringify({ config: current.config, workspaces: current.workspaces, messages: current.messages.map((entry) => entry.id) }) }
      },
      allowed: () => permissions.isCapabilityAllowed('microphone'),
      allowBusyInterrupt: () => true,
      authorize: async () => {
        requireOnlineProvider(controller!.settings)
        if (!controller?.windows.control.isVisible() && !controller?.windows.panel.isVisible() && !controller?.windows.floating.isVisible()) throw new ChatError('Show Athena before recording.')
        const permission = permissions.getPermissionStatus('microphone')
        if (!permission.enabled) throw new ChatError('Enable Microphone Access in Settings → Privacy before using push-to-talk.')
        if (controller!.settings.aiMode === 'subscription') {
          if (!controller!.settings.localAI.speechModelPath) throw new ChatError('Configure a local speech recognition model in My Athena → Local AI setup → Local voice.')
        } else {
          await ai.getActiveConfiguration(chat!.current().config.model)
        }
        if (permission.canRequest) await permissions.requestPermission({ permission: 'microphone' })
      },
      changed: (state) => {
        speech?.reconcile()
        controller?.windows.control.webContents.send(IPC.voiceChanged, state)
      },
    })
    const nativeAudio = new NativeAudioEndpoints(voiceRoot)
    audioDevices = new AudioDeviceService(() => controller!.settings.audioDevices, state => {
      for (const window of controller!.windows.all()) if (!window.isDestroyed()) window.webContents.send(IPC.audioDevicesChanged, state)
    }, () => {
      speech?.stop()
      for (const window of controller!.windows.all()) if (!window.isDestroyed()) window.webContents.send(IPC.localVoicePlaybackStopped)
    }, preferences => controller!.updateSettings({ audioDevices: preferences }), () => permissions.isCapabilityAllowed('microphone'))
    audioDevices.enrich = async devices => enrichAudioEndpoints(devices, await nativeAudio.read())
    controller.windows.floating.webContents.setBackgroundThrottling(!controller.settings.voiceInteraction.handsFreeEnabled)
    controller.windows.control.on('hide', () => audioDevices?.stopTest())
    handsFree = new HandsFreeController(localTranscription, () => controller!.settings, () => permissions.isCapabilityAllowed('microphone'))
    const mediaAllowed = (contents: Electron.WebContents | null, permission: string, details: { isMainFrame: boolean; requestingUrl?: string }, mediaTypes: string[], permissionCheck = false) => {
      if (meetings?.allowsMedia(contents, permission, details.isMainFrame, mediaTypes)) return true
      const window = controller!.windows.all().find((candidate) => candidate.webContents.id === contents?.id && (candidate === controller!.windows.control || candidate === controller!.windows.panel || candidate === controller!.windows.floating))
      if (!window) return false
      const trustedFrame = Boolean(contents && details.requestingUrl
        && controller!.windows.isTrustedURL(contents, details.requestingUrl)
        && controller!.windows.isTrustedURL(contents, contents.mainFrame.url)
        && contents.mainFrame.url === contents.getURL())
      if (permission === 'speaker-selection') return !window.isDestroyed() && trustedFrame && details.isMainFrame
      // Chromium checks audio permission to enumerate named input endpoints.
      // Opening a stream goes through the separate request handler and its capture lease.
      if (permissionCheck && permission === 'media' && mediaTypes.length === 1 && mediaTypes[0] === 'audio'
        && trustedFrame && details.isMainFrame && window !== controller!.windows.panel
        && !window.isDestroyed() && window.isVisible() && permissions.isCapabilityAllowed('microphone')) return true
      return !window.isDestroyed() && allowsVoiceMedia({ senderId: contents?.id, controlId: window.webContents.id, permission, ...details,
        controlUrl: window.webContents.getURL(), mediaTypes, captureAllowed: trustedFrame && window.isVisible() && (Boolean(window === controller!.windows.control && voice?.canCapture()) || Boolean(handsFree?.canCapture(window.webContents.id)) || Boolean(audioDevices?.canTest(window.webContents.id) && !controller!.settings.voiceInteraction.handsFreeEnabled && permissions.isCapabilityAllowed('microphone'))) })
    }
    session.defaultSession.setPermissionCheckHandler((contents, permission, _origin, details) => mediaAllowed(contents, permission, details, [details.mediaType ?? 'unknown'], true))
    session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
      // Electron's MediaAccessPermissionRequest exposes securityOrigin/mediaTypes;
      // unlike permission-check details, it has no requestingUrl/isMainFrame.
      // Derive those from the bound WebContents' current main frame instead of
      // passing undefined into the strict lease check (which rejected every mic request).
      const context = mainFrameMediaRequestContext({ currentUrl: contents?.getURL(), mainFrameUrl: contents?.mainFrame.url,
        securityOrigin: 'securityOrigin' in details ? details.securityOrigin : undefined })
      callback(mediaAllowed(contents, permission, context, 'mediaTypes' in details ? details.mediaTypes ?? [] : []))
    })
    closeLiveVoice = registerIPC(controller, ai, chat, permissions, context, voice, speech, applications, ollama, localVoice, chatGPT, handsFree, desktopActions, claudeAPI, cursorACP, slashCommands, webSearch, codexCLI, { chat: companion, context: companionContext }, {
      chat: athenaChat, context: athenaChatContext, commands: athenaChatCommands,
      focus: (active, sessionId) => {
        if (sessionId !== athenaChat!.current().id) return false
        if (active || athenaChatVisible) {
          athenaChatVisible = active
          // The active session can change while this page stays visible. Revoke
          // the previous animation lease even though visibility did not change.
          reconcileLocalActivity()
        }
        return true
      },
    }, academy, academyIntegrations, academyStudio, localTranscription, academyTraining, copilot, antigravityACP, antigravityGeneralWorkspace, thirdPartyInference, unifiedAccounts, providerUsage, audioDevices, async action=>{
      if(typeof action==='object'){
        if(!codexVoice.control(action.taskId,action.action))applicationAutomation.control(action)
      }
      const automationStatus=async()=>{
        const stored=await applicationAutomation.status(controller!.settings.applicationAutomation.engine==='openai' && (action==='status'||action==='prepare-environment'),action==='prepare-environment')
        const cfg=controller!.settings.applicationAutomation
        if(cfg.engine==='codex' && action==='status'){
          const subscription=await codexCLI.status(true)
          codexConnection={connected:subscription.authenticated,model:cfg.model,available:subscription.models.some(m=>m.id===cfg.model),version:subscription.version}
        }
        return {...stored,task:voiceTask??stored.task,codex:cfg.engine==='codex' && codexConnection?.model===cfg.model?codexConnection:undefined}
      }
      if(action==='activity' || typeof action==='object')return {browser:voiceBrowser?.status() ?? 'Browser unavailable',locked:voiceDesktopLocked,recent:[],automation:await automationStatus()}
      let test
      const checks:NonNullable<import('../../shared/automation').ComputerUseStatus['checks']>=[]
      await voiceBrowser?.refresh(AbortSignal.timeout(8000)).catch(error=>checks.push({name:'Existing browser',status:'failed',message:error instanceof ChatError?error.userMessage:'Browser inspection failed.'}))
      if(action==='test'){
        const text='What is my current task status?'
        const result=await companionContext.resolveNativeVoiceCommand(companion!.current(),text,randomUUID(),AbortSignal.timeout(10000))
        test={ok:result.handled && result.success!==false,message:result.text ?? 'The voice action was unavailable.'}
        checks.push({name:'Internal action registry',status:test.ok?'passed':'failed',message:test.message})
        for(const [name,key] of [['Screen capture permission','screenCapture'],['Accessibility permission','accessibilityControl'],['Application detection permission','applicationDetection']] as const)
          checks.push({name,status:permissions.isCapabilityAllowed(key)?'passed':'failed',message:permissions.isCapabilityAllowed(key)?'Production process permission gate allows this capability.':'Application or OS permission gate is closed.'})
        try{
          if(!canObserveForeground())throw new ChatError('Application observation is not authorized.')
          const active=await foreground(AbortSignal.timeout(8000))
          checks.push({name:'Foreground application',status:active?'passed':'not-tested',message:active?'Observed '+active.name:'The foreground app is Athena or is not authorized.'})
          if(active?.id){
            const view=await desktopActions!.inspectAccessibleUI(active.id,AbortSignal.timeout(8000))
            checks.push({name:'Native accessibility helper',status:'passed',message:'Production helper returned '+view.elements.length+' accessible controls.'})
          }else checks.push({name:'Native accessibility helper',status:'not-tested',message:'Focus an authorized external application for the interactive test.'})
        }catch(error){checks.push({name:'Native accessibility helper',status:'failed',message:error instanceof ChatError?error.userMessage:'Native observation failed.'})}
        checks.push({name:'Existing browser',status:'not-tested',message:voiceBrowser?.status()??'Browser unavailable'})
        for(const name of ['GPT-Live delegation','Browser page inspection','Window capture','Vision inference','Mouse and keyboard input','Cursor overlay','End-to-end result verification'])
          checks.push({name,status:'not-tested',message:'Requires the interactive floating-voice test on an approved target window. No input, screenshot or paid request was issued by this check.'})
        test={ok:false,message:'Individual checks completed. Continuous GPT-Live computer use is not verified by this diagnostic check.'}
      }
      const installed=permissions.isCapabilityAllowed('applicationDetection') && !voiceDesktopLocked
        ? (await installedApps.list(AbortSignal.timeout(6500)).catch(()=>[])).map(({key,name})=>({key,name})) : []
      return {installed,browser:voiceBrowser?.status() ?? 'Browser unavailable',locked:voiceDesktopLocked,recent:await automationAudit.recent(),automation:await automationStatus(),test,checks}
    },codexVoice)
    controller.windows.panel.on('hide', () => voice?.cancel('Voice input cancelled because the floating panel was hidden.'))
    controller.windows.panel.webContents.on('render-process-gone', () => { voice?.cancel(); speech?.stop() })
    controller.windows.control.webContents.on('render-process-gone', () => { voice?.cancel(); if (athenaChatVisible) { athenaChatVisible = false; reconcileLocalActivity() } })
    controller.windows.control.webContents.on('did-start-navigation', () => { voice?.cancel(); if (athenaChatVisible) { athenaChatVisible = false; reconcileLocalActivity() } })
    tray = createTray(controller)
    const displaysChanged = () => { controller?.motion.pause(); controller?.windows.applySettings(); controller?.motion.clamp(); controller?.broadcast() }
    screen.on('display-added', displaysChanged)
    screen.on('display-removed', displaysChanged)
    screen.on('display-metrics-changed', displaysChanged)
    nativeTheme.on('updated', () => controller?.broadcast())
    powerMonitor.on('on-battery', () => controller?.broadcast())
    powerMonitor.on('on-ac', () => controller?.broadcast())
    voiceDesktopLocked=powerMonitor.getSystemIdleState(1)==='locked'
    const pauseDesktop = () => { computerTools.clearChatGrants(); codexVoice.end(); interactionOverlay?.hide(); voiceDesktopLocked = true; controller?.windows.floating.webContents.send(IPC.voiceAutomationStopped); companion?.cancelHandsFreeReply(); athenaChat?.cancelHandsFreeReply(); voiceBrowser?.reconcile() }
    powerMonitor.on('lock-screen',pauseDesktop)
    powerMonitor.on('unlock-screen',()=>{voiceDesktopLocked=false})
    powerMonitor.on('suspend', () => { pauseDesktop(); speech?.stop(); voice?.cancel('Voice input cancelled while the computer sleeps.'); controller?.motion.stop() })
    powerMonitor.on('resume', () => { voiceDesktopLocked=powerMonitor.getSystemIdleState(1)==='locked'; if (controller?.windows.floating.isVisible()) controller.motion.start() })
    log('application.started', { version: app.getVersion(), platform: process.platform })
    startup.servicesReady()
  }).catch(() => {
    startup?.dispose()
    log('application.start_failed')
    dialog.showErrorBox('Athena could not start', 'Athena could not initialize its workspace. Please restart the app.')
    app.quit()
  })
  app.on('activate', () => controller?.windows.showControl())
  app.on('window-all-closed', () => { /* The tray owns the application lifetime. */ })
  let quittingAfterCleanup = false
  app.on('before-quit', (event) => {
    if (quittingAfterCleanup) return
    event.preventDefault()
    quittingAfterCleanup = true
    disposeProjectGit(); automationFocus.dispose(); interactionOverlay?.dispose(); voiceBrowser?.dispose()
    startup?.dispose()
    stopLlamaServer(); chat?.dispose(); companion?.dispose(); athenaChat?.dispose(); screenCapture?.dispose(); companionCapture?.dispose(); athenaChatCapture?.dispose(); desktopActions?.dispose(); speech?.dispose(); localVoice?.dispose(); handsFree?.dispose(); audioDevices?.dispose(); voice?.dispose(); controller?.dispose(); tray?.destroy()
    void Promise.allSettled([closeCodex?.(), closeLiveVoice?.(), localSearch?.dispose(), meetings?.dispose(), agentTools?.dispose(), companionAgentTools?.dispose(), athenaChatAgentTools?.dispose()]).finally(() => app.quit())
  })
}
}
