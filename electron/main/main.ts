import { CopilotService } from './ai/copilotService'
import { CopilotProvider } from './ai/CopilotProvider'
import { AntigravityProvider } from './ai/AntigravityProvider'
import { AntigravityACPService, AntigravityGeneralWorkspace } from './ai/antigravityACP'
import { MeetingService } from './meetings/meetingService'
import { OllamaProvider as MeetingOllamaProvider } from './ai/OllamaProvider'
import { knownReasoningEfforts, supportsImageInput } from '../../shared/modelCapabilities'
import { app, dialog, Menu, nativeTheme, powerMonitor, screen, session, shell, type Tray } from 'electron'
import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
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
import { DesktopTools } from './desktop/desktopTools'
import { MacOSScreenCapture } from './screenCapture/macOSScreenCapture'
import { ScreenCaptureTools } from './screenCapture/screenCaptureTools'
import { LocalWhisperTranscription, RoutedTranscription } from './voice/localVoiceServices'
import { ChatterboxSpeech } from './voice/chatterboxSpeech'
import { OfficialCSM } from './voice/officialCSM'
import { HiggsTTS } from './voice/higgsTTS'
import { SelectedLocalSpeech } from './voice/selectedLocalSpeech'
import { shouldWarmLocalWake, wakeAcknowledgementCacheKey, warmWakeAcknowledgements } from './voice/wakeAcknowledgement'
import { HandsFreeController } from './voice/handsFreeController'
import { OllamaService } from './ai/ollamaService'
import { AcademyService } from './ai/academyService'
import { AcademyIntegrations } from './ai/academyIntegrations'
import { AcademyStudio } from './ai/academyStudio'
import { MLXInference } from './ai/mlxInference'
import { AcademyTraining } from './ai/academyTraining'
import { requireOnlineProvider, requireOnlineHistory, onlineContextSettings } from './ai/onlineIsolation'
import { ChatGPTAuth } from './ai/chatGPTAuth'
import { AutomationAuditLog } from './ai/automationAudit'
import { NativeActionRegistry } from './ai/nativeActionRegistry'
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
let meetings: MeetingService | undefined
let speech: SpeechController | undefined
let localVoice: SelectedLocalSpeech | undefined
let officialCSM: OfficialCSM | undefined
let higgsTTS: HiggsTTS | undefined
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
    const codexCLI = new CodexCLIService(app.getVersion())
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
    const unifiedAccounts = new UnifiedAccounts({ ai, chatGPT, cursor: cursorACP, copilot, claude: claudeAPI, antigravity: antigravityACP, thirdParty: thirdPartyInference }, () => controller?.settings.unifiedAccountEnabled ?? {})
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
    chat = new ChatController({
      contextDefaults: () => controller!.settings.aiContext,
      rememberedPermissions: permissions.remembered,
      origin: 'online-chat',
      maxConcurrent: () => controller?.settings.backgroundTasks.enabled ? controller.settings.backgroundTasks.maxConcurrent : 1,
      isViewed: sessionId => chat?.snapshot().sessionId === sessionId && Boolean(controller?.windows.control.isVisible() && controller.windows.control.isFocused()),
      unreadChanged: count => taskNotifications?.badge(count),
      executionEnded: event => taskNotifications?.completed(event),
      approvalChanged: event => taskNotifications?.approval(event),
      storeArtifact: input => artifacts.store(input.name, input.mimeType, input.bytes, { provider: input.provider }),
      childModel: config => config.accountRoute && config.model ? unifiedAccounts.model(config.accountRoute, config.model) : undefined,
      accountIdentity: async () => {
        const route = chat?.current().config.accountRoute
        if (route) return `${route.provider}:${route.accountId}`
        if (controller?.settings.aiMode === 'copilot') return copilot.identity()
        if (controller?.settings.aiMode !== 'subscription') return null
        if (controller.settings.chatGPTCodingBackend === 'codex-cli' && chat?.current().workspaces.length) {
          const identity = (await codexCLI.status()).identity
          return identity ? `codex:${createHash('sha256').update(identity.trim().toLowerCase()).digest('hex')}` : null
        }
        return (await chatGPT.status()).activeAccountId
      },
      usageProviderId: () => {
        const mode = chat?.current().config.accountRoute?.provider ?? controller!.settings.aiMode
        if (mode === 'cloud') return 'openai-api'
        if (mode === 'subscription') return !chat?.current().config.accountRoute && controller!.settings.chatGPTCodingBackend === 'codex-cli' && chat!.current().workspaces.length ? 'codex-subscription' : 'chatgpt-subscription'
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
        if (child?.isolated && !route && mode === 'subscription' && settings.chatGPTCodingBackend === 'codex-cli') throw new ChatError('Codex app-server currently does not expose Athena’s per-request sub-agent iteration and output-token controls. Sub-agents are unavailable with Codex CLI; the required cold-read gate remains incomplete.')
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
          if (!route && child?.coding && settings.chatGPTCodingBackend === 'codex-cli') {
            const status = await codexCLI.status()
            if (!status.authenticated || !status.identity) throw new ChatError(`${status.message} Athena did not fall back to its ChatGPT app-sharing connection.`)
            if (!config.model || !status.models.some((entry) => entry.id === config.model)) throw new ChatError('The selected model is not in the current Codex CLI catalog. Refresh Settings → AI → ChatGPT Subscription, then choose an available model. No fallback was used.')
            return new CodexAppServerProvider(codexCLI, config.model, status.identity)
          }
          const { accessToken, model, accountId, requestIdentity, contextWindow } = await chatGPT.activeModel(config.model, route?.accountId)
          return new OpenAIProvider(accessToken, model, undefined, settings.aiGeneration, true, (rejected) => chatGPT.accessTokenForRound(accountId, rejected), requestIdentity, usageLedger.forAccount('chatgpt-subscription', accountId), contextWindow)
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
      effectiveModel: () => chat?.current().config.accountRoute ? chat.current().config.model : controller?.settings.aiMode === 'cursor' ? chat?.current().config.model ?? 'cursor-managed' : controller?.settings.aiMode === 'antigravity' ? chat?.current().config.model ?? null : controller?.settings.aiMode === 'subscription' && controller.settings.chatGPTCodingBackend === 'codex-cli' && chat?.current().workspaces.length ? chat.current().config.model : controller?.settings.aiMode==='third-party'?chat?.current().config.model??null:null,
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
        if (!route && controller?.settings.aiMode === 'subscription' && controller.settings.chatGPTCodingBackend === 'codex-cli' && chat?.current().workspaces.length) return codexCLI.supportsEffortCached(model ?? '', effort)
        const provider = route?.provider ?? (controller?.settings.aiMode === 'subscription' ? 'subscription' : controller?.settings.aiMode)
        const trusted = knownReasoningEfforts(provider, model)
        return trusted ? trusted.includes(effort) : undefined
      },
      voiceTimeoutMs: () => (controller?.settings.voiceInteraction.aiResponseTimeoutSeconds ?? 120) * 1000,
      adaptiveVoiceReasoning: () => controller?.settings.voiceInteraction.adaptiveVoiceReasoning ?? true,
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
      else { controller?.command('open-chat'); chat?.command({ action: 'switch', id: route.sessionId }) }
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
    companion = new ChatController({
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
      resolveVoiceCommand: (session, request, requestId, signal) => companionContext.resolveNativeVoiceCommand(session, request, requestId, signal, true),
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
    desktopActions = new DesktopTools(new MacOSDesktopPlatform(), () => permissions.isCapabilityAllowed('desktopAutomation'), () => controller!.settings.doNotDisturb,
      (sessionId, index) => webSearch!.resultAt(sessionId, index))
    const automationAudit = new AutomationAuditLog(join(app.getPath('userData'), 'automation'))
    const nativeActions = new NativeActionRegistry({ controller, onlineChat: chat!, localAthenaChat: athenaChat!, validateLocalModel: async model => {
      try {
        const details = await ollama.modelDetails(model)
        return !details.capabilities.length || details.capabilities.includes('completion')
      } catch { return false }
    }, chatGPT, permissions, desktop: desktopActions, academy, academyTraining, audit: automationAudit,
      requestAutomationPermission: async (permission, actionId) => {
        const descriptions = {
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
    screenCapture = new ScreenCaptureTools(new MacOSScreenCapture(), () => permissions.getPermissionStatus('screenCapture').enabled, () => permissions.isCapabilityAllowed('screenCapture'), () => `online provider ${controller!.settings.aiMode}`)
    const appRoot = app.getAppPath()
    const voiceRoot = app.isPackaged ? process.resourcesPath : basename(appRoot) === 'out-dev' ? dirname(appRoot) : appRoot
    const chatterbox = new ChatterboxSpeech(() => controller!.settings, join(voiceRoot, 'voice-service', 'chatterbox.py'))
    officialCSM = new OfficialCSM(() => controller!.settings, join(voiceRoot, 'vendor', 'sesame-csm-official'), join(voiceRoot, 'voice-service', 'official_csm.py'), undefined, join(voiceRoot, 'voice-service', 'assets', 'athena-us-amy-reference.mp3'))
    higgsTTS = new HiggsTTS(() => controller!.settings, join(voiceRoot, 'voice-service', 'higgs_tts.py'), join(voiceRoot, 'voice-service', 'requirements-higgs.txt'))
    localVoice = new SelectedLocalSpeech(() => controller!.settings, chatterbox, officialCSM, higgsTTS, join(app.getPath('userData'), 'voice-cache', 'wake'))
    const warmSesameWake = () => {
      const settings = controller!.settings
      if (!localVoice || !shouldWarmLocalWake(settings)) return
      for (const text of warmWakeAcknowledgements(settings)) {
        void localVoice.generateCached(text, settings.voiceName, settings.voiceSpeed,
          new AbortController().signal, wakeAcknowledgementCacheKey(settings, text), 'wake-ack-warmup').catch(() => {
          // Warmup is opportunistic; the first real request still reports errors.
        })
      }
    }
    const wakeWarmup = setTimeout(warmSesameWake, 1500)
    wakeWarmup.unref()
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
      if ((!previous.voiceInteraction.handsFreeEnabled && next.voiceInteraction.handsFreeEnabled)
        || JSON.stringify(previous.localVoice) !== JSON.stringify(next.localVoice)
        || previous.voiceEnabled !== next.voiceEnabled || previous.voiceMuted !== next.voiceMuted
        || previous.doNotDisturb !== next.doNotDisturb) warmSesameWake()
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
    companionCapture = new ScreenCaptureTools(new MacOSScreenCapture(), () => permissions.getPermissionStatus('screenCapture').enabled, () => permissions.isCapabilityAllowed('screenCapture'), () => `local Ollama model ${controller!.settings.localAI.model ?? ''}`)
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
    athenaChatCapture = new ScreenCaptureTools(new MacOSScreenCapture(), () => permissions.getPermissionStatus('screenCapture').enabled, () => permissions.isCapabilityAllowed('screenCapture'), () => `local Ollama model ${athenaChat!.current().config.model ?? ''}`)
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
    companionContext.setNativeActions((_session, userText, requestId, voiceOnly) => nativeActions.createTools({ localChat: companion!, userText, requestId, voiceOnly }))
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
    handsFree = new HandsFreeController(localTranscription, () => controller!.settings, () => permissions.isCapabilityAllowed('microphone'))
    const mediaAllowed = (contents: Electron.WebContents | null, permission: string, details: { isMainFrame: boolean; requestingUrl?: string }, mediaTypes: string[]) => {
      if (meetings?.allowsMedia(contents, permission, details.isMainFrame, mediaTypes)) return true
      const window = controller!.windows.all().find((candidate) => candidate.webContents.id === contents?.id && (candidate === controller!.windows.control || candidate === controller!.windows.panel || candidate === controller!.windows.floating))
      if (!window) return false
      const trustedFrame = Boolean(contents && details.requestingUrl
        && controller!.windows.isTrustedURL(contents, details.requestingUrl)
        && controller!.windows.isTrustedURL(contents, contents.mainFrame.url)
        && contents.mainFrame.url === contents.getURL())
      return !window.isDestroyed() && allowsVoiceMedia({ senderId: contents?.id, controlId: window.webContents.id, permission, ...details,
        controlUrl: window.webContents.getURL(), mediaTypes, captureAllowed: trustedFrame && window.isVisible() && (Boolean(voice?.canCapture()) || Boolean(handsFree?.canCapture(window.webContents.id))) })
    }
    session.defaultSession.setPermissionCheckHandler((contents, permission, _origin, details) => mediaAllowed(contents, permission, details, [details.mediaType ?? 'unknown']))
    session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
      // Electron's MediaAccessPermissionRequest exposes securityOrigin/mediaTypes;
      // unlike permission-check details, it has no requestingUrl/isMainFrame.
      // Derive those from the bound WebContents' current main frame instead of
      // passing undefined into the strict lease check (which rejected every mic request).
      const context = mainFrameMediaRequestContext({ currentUrl: contents?.getURL(), mainFrameUrl: contents?.mainFrame.url,
        securityOrigin: 'securityOrigin' in details ? details.securityOrigin : undefined })
      callback(mediaAllowed(contents, permission, context, 'mediaTypes' in details ? details.mediaTypes ?? [] : []))
    })
    registerIPC(controller, ai, chat, permissions, context, voice, speech, applications, ollama, localVoice, chatGPT, handsFree, desktopActions, claudeAPI, cursorACP, slashCommands, webSearch, codexCLI, { chat: companion, context: companionContext }, {
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
    }, academy, academyIntegrations, academyStudio, localTranscription, academyTraining, officialCSM, higgsTTS, copilot, antigravityACP, antigravityGeneralWorkspace, thirdPartyInference, unifiedAccounts, providerUsage)
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
    powerMonitor.on('suspend', () => { speech?.stop(); voice?.cancel('Voice input cancelled while the computer sleeps.'); controller?.motion.stop() })
    powerMonitor.on('resume', () => { if (controller?.windows.floating.isVisible()) controller.motion.start() })
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
    disposeProjectGit()
    startup?.dispose()
    stopLlamaServer(); chat?.dispose(); companion?.dispose(); athenaChat?.dispose(); screenCapture?.dispose(); companionCapture?.dispose(); athenaChatCapture?.dispose(); desktopActions?.dispose(); speech?.dispose(); localVoice?.dispose(); handsFree?.dispose(); voice?.dispose(); controller?.dispose(); tray?.destroy()
    void Promise.allSettled([localSearch?.dispose(), meetings?.dispose(), agentTools?.dispose(), companionAgentTools?.dispose(), athenaChatAgentTools?.dispose()]).finally(() => app.quit())
  })
}
}
