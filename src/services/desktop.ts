import { emptyAudioDeviceState } from '../../shared/audioDevices'
import type { AthenaAPI, Snapshot } from '../../shared/contracts'
import { defaultSettings, mergeSettings } from '../../shared/settings'
import { emptyAIStatus, type AIResult } from '../../shared/ai'
import { emptyChatGPTStatus } from '../../shared/chatgpt'
import { emptyChatSnapshot } from '../../shared/chat'
import { unavailablePermissions, type PermissionResult } from '../../shared/permissions'
import type { LocalStatus } from '../../shared/localAI'
import { emptyCodexCLIStatus } from '../../shared/codex'

// Browser preview is deliberately local: it never impersonates an OS integration.
let preview: Snapshot = {
  settings: { ...defaultSettings }, displays: [{ id: 1, label: 'Preview display', primary: true, x: 0, y: 0, width: 1440, height: 900 }],
  state: 'idle', flight: null, idleAction: null, visible: true, panelMode: 'chat', panelVisible: false, onBattery: false,
  reducedMotion: false, platform: 'browser', version: '0.1.0', error: null,
}
const listeners = new Set<(snapshot: Snapshot) => void>()
const publish = () => { for (const listener of listeners) listener(preview) }
const unavailableAI = async (): Promise<AIResult> => ({ ok: false, status: emptyAIStatus(), message: 'Open the macOS desktop app to configure secure AI access.' })
const unavailablePermissionResult = async (): Promise<PermissionResult> => ({ ok: false, snapshot: unavailablePermissions(), message: 'Open Athena on macOS to manage permissions.' })
const previewApi: AthenaAPI = {
  mediaGeneration: async () => ({routes:[],notices:['Media generation requires the desktop app.'],paidRequests:0}),
  liveVoice: async () => ({credential:false, message:'GPT-Live requires the Athena desktop app.'}),
  audioDevices: async () => emptyAudioDeviceState(), onAudioDevices: () => () => {},
  registerVroidAnimations: async () => preview,
  playVroidAction: async () => ({ ok: false, message: 'Synchronized VRoid actions require the Athena desktop app.' }),
  beginSpeech: async () => ({ ok: false, message: 'Speech output requires the desktop app.' }),
  nextSpeech: async () => ({ ok: false }), speechPlaying: async () => ({ ok: false }), stopSpeech: async () => ({ ok: true }), onSpeech: () => () => {},
  reportSpeechLevel: async () => ({ ok: true }), onSpeechLevel: () => () => {},
  getLocalVoiceStatus: async () => ({ runtime: 'unavailable', engines: { 'chatterbox-turbo': { status: 'unavailable' } }, profiles: [] }),
  installLocalVoice: async () => ({ ok: false, message: 'Local voice installation requires the desktop app.' }),
  cancelLocalVoiceInstall: async () => ({ ok: true }), manageVoiceProfile: async () => ({ ok: false }),
  previewLocalVoice: async () => ({ ok: false, message: 'Voice preview requires the desktop app.' }), manageLocalVoice: async () => ({ ok: false, message: 'Local voice management requires the desktop app.' }), stopAllSpeech: async () => ({ ok: true }), onLocalVoicePlaybackStopped: () => () => {}, onLocalVoiceProgress: () => () => {},
  beginVoice: async () => ({ ok: false, message: 'Push-to-talk requires the desktop app.' }),
  voiceRecording: async () => ({ ok: false }), transcribeVoice: async () => ({ ok: false }),
  cancelVoice: async () => ({ ok: true }), onVoice: () => () => {},
  enableHandsFree: async () => ({ ok: false, message: 'Hands-free voice requires the macOS desktop app.' }),
  disableHandsFree: async () => ({ ok: true }),
  transcribeHandsFree: async () => ({ ok: false, message: 'Hands-free voice requires the macOS desktop app.' }),
  cancelHandsFreeTranscription: async () => ({ ok: true }),
  answerHandsFree: async () => ({ ok: false, message: 'Hands-free voice requires the macOS desktop app.' }),
  onHandsFreeReplyProgress: () => () => {},
  steerVoiceAutomation:async()=>false,
  onVoiceSubmissionEnded:()=>()=>{},
  onVoiceAutomationStopped:()=>()=>{},
  computerUseCheck:async()=>({browser:'Desktop integration unavailable',locked:false,recent:[]}),
  cancelHandsFreeReply: async () => ({ ok: true }),
  clearHandsFreeContext: async () => ({ ok: true }),
  speakHandsFree: async () => ({ ok: false, message: 'Hands-free voice requires the macOS desktop app.' }),
  nextHandsFreeSpeech: async () => ({ ok: false, message: 'Hands-free voice requires the macOS desktop app.' }),
  stopHandsFreeSpeech: async () => ({ ok: true }),
  handsFreePlayback: async () => ({ ok: true }),
  setHandsFreeState: async () => ({ ok: true }),
  openApplicationByVoice: async () => ({ ok: false, status: 'failed', message: 'Voice desktop actions require the macOS desktop app.' }),
  focusApplicationByVoice: async () => ({ ok: false, status: 'failed', message: 'Voice desktop actions require the macOS desktop app.' }),
  openURLByVoice: async () => ({ ok: false, status: 'failed', message: 'Voice desktop actions require the macOS desktop app.' }),
  getVoiceSearchResult: async () => ({ ok: false, message: 'Search-result references require the macOS desktop app.' }),
  getPermissions: async () => unavailablePermissions(),
  getPermissionStatus: async ({ permission }) => unavailablePermissions().permissions.find((entry) => entry.permission === permission)!,
  updateRememberedPermissions: unavailablePermissionResult,
  setPermissionEnabled: unavailablePermissionResult, setFilesystemAccess: unavailablePermissionResult, requestPermission: unavailablePermissionResult, openPermissionSettings: unavailablePermissionResult,
  isCapabilityAllowed: async () => false,
  getApplications: async () => ({ ok: false, message: 'Application detection requires the macOS desktop app.' }),
  getChat: async () => emptyChatSnapshot(),
  chatSession: async () => ({ ok: false, message: 'Conversations require the desktop app.' }),
  projectGit: async () => ({ ok: true, state: { repository: false, head: '', branches: [] } }),
  projectEditor: async () => ({ ok: true, available: false }),
  onProjectGit: () => () => {},
  getProviderUsage: async () => { throw new Error('Usage storage requires the desktop app.') },
  configureOpenAIUsage: async () => ({ ok: false }),
  removeOpenAIUsage: async () => ({ ok: false }),
  getUnifiedAccounts: async () => ({ accounts: [], refreshedAt: 0 }),
  chatContext: async () => ({ ok: false, message: 'File access requires the desktop app.' }),
  searchChats: async () => [],
  sendChat: async () => ({ ok: false, message: 'Open the desktop app to chat with Athena.' }),
  getSlashCommands: async () => ({ commands: [], globalEnabled: false, message: 'Project commands require the desktop app.' }),
  retryChat: async () => ({ ok: false, message: 'Open the desktop app to chat with Athena.' }),
  stopChat: async () => ({ ok: true }), clearChat: async () => ({ ok: true }),
  copyChatText: async () => ({ ok: false, message: 'Copy is available in the desktop app.' }),
  onChat: () => () => {},
  getAthenaChat: async () => emptyChatSnapshot(),
  sendAthenaChat: async () => ({ ok: false, message: 'Local Athena Chat requires the desktop app.' }),
  athenaChatSession: async () => ({ ok: false, message: 'Local Athena Chat requires the desktop app.' }),
  athenaChatContext: async () => ({ ok: false, message: 'Local file access requires the desktop app.' }),
  searchAthenaChats: async () => [],
  retryAthenaChat: async () => ({ ok: false, message: 'Local Athena Chat requires the desktop app.' }),
  stopAthenaChat: async () => ({ ok: true }),
  clearAthenaChat: async () => ({ ok: false, message: 'Local Athena Chat requires the desktop app.' }),
  focusAthenaChat: async () => ({ ok: false, message: 'Local Athena Chat requires the desktop app.' }),
  onAthenaChat: () => () => {},
  copilot: async () => ({ accounts: [], activeId: null, message: 'Copilot requires the desktop app.' }),
  getAIStatus: unavailableAI, testAIConnection: unavailableAI, activateAI: unavailableAI,
  getOpenAIAccountStatus: unavailableAI,
  selectAIModel: unavailableAI, removeAIKey: unavailableAI,
  getWebSearchStatus: async () => ({ hasKey: false, provider: 'Local SearXNG', active: false, model: null, availableModels: [], validated: false, strictOffline: false, note: 'Local search requires the Athena desktop app.' }),
  restartWebSearch: async () => ({ ok: false, message: 'Local search requires the Athena desktop app.' }),
  testWebSearch: async () => ({ ok: false, message: 'Web search requires the macOS desktop app.' }), saveWebSearchKey: async () => ({ ok: false, message: 'Web search requires the macOS desktop app.' }), removeWebSearchKey: async () => ({ ok: false, message: 'Web search requires the macOS desktop app.' }),
  openExternalLink: async () => ({ ok: false, message: 'Opening external links requires the macOS desktop app.' }),
  getClaudeStatus: unavailableAI, testClaudeConnection: unavailableAI, activateClaudeAPI: unavailableAI, selectClaudeModel: unavailableAI, removeClaudeAPIKey: unavailableAI,
  inferenceConnections: async () => ({ ok: false, message: 'Third-party inference requires the desktop app.', connections: [], activeConnectionId: null }),
  getCursorStatus: async () => ({ installed: false, authenticated: false, identity: null, version: null, message: 'Cursor CLI requires the macOS desktop app.', models: [], modelCatalogAvailable: false }),
  signInCursor: async () => ({ installed: false, authenticated: false, identity: null, version: null, message: 'Cursor CLI requires the macOS desktop app.', models: [], modelCatalogAvailable: false }),
  signOutCursor: async () => ({ installed: false, authenticated: false, identity: null, version: null, message: 'Cursor CLI requires the macOS desktop app.', models: [], modelCatalogAvailable: false }),
  antigravity: async () => ({ installed: false, version: null, authState: 'unknown', identity: null, models: [], modelEfforts: {}, modelEffortDefaults: {}, modelCatalogAvailable: false, usage: null, usageError: null, message: 'Antigravity ACP requires the desktop app.' }),
  getChatGPTStatus: async () => ({ ...emptyChatGPTStatus(), message: 'Desktop app unavailable.' }),
  codexCommand: async () => ({ok:false,message:'Codex requires the desktop app.'}),
  getCodexCLIStatus: async () => ({ ...emptyCodexCLIStatus(), message: 'Codex CLI requires the macOS desktop app.' }),
  addChatGPTAccount: async () => ({ ...emptyChatGPTStatus(), message: 'Desktop app unavailable.' }), retryAddChatGPTAccount: async () => ({ ...emptyChatGPTStatus(), message: 'Desktop app unavailable.' }),
  confirmChatGPTAccount: async () => ({ ...emptyChatGPTStatus(), message: 'Desktop app unavailable.' }), cancelChatGPTAccount: async () => ({ ...emptyChatGPTStatus(), message: 'Desktop app unavailable.' }),
  reconnectChatGPTAccount: async () => ({ ...emptyChatGPTStatus(), message: 'Desktop app unavailable.' }), selectChatGPTAccount: async () => ({ ...emptyChatGPTStatus(), message: 'Desktop app unavailable.' }),
  setChatGPTAccountEnabled: async () => ({ ...emptyChatGPTStatus(), message: 'Desktop app unavailable.' }), renameChatGPTAccount: async () => ({ ...emptyChatGPTStatus(), message: 'Desktop app unavailable.' }), removeChatGPTAccount: async () => ({ ...emptyChatGPTStatus(), message: 'Desktop app unavailable.' }),
  signInChatGPT: async () => ({ ...emptyChatGPTStatus(), message: 'Desktop app unavailable.' }),
  signOutChatGPT: async () => ({ ...emptyChatGPTStatus(), message: 'Desktop app unavailable.' }),
  refreshChatGPTModels: async () => ({ ...emptyChatGPTStatus(), message: 'Desktop app unavailable.' }),
  selectChatGPTModel: async () => ({ ...emptyChatGPTStatus(), message: 'Desktop app unavailable.' }),
  openChatGPTUsage: async () => {},
  getLocalStatus: async (): Promise<LocalStatus> => ({ connected: false, message: 'Local AI requires the desktop app.', models: [], arch: 'unknown', totalMemoryBytes: 0, freeMemoryBytes: 0, whisperInstalled: false, macSpeechAvailable: false, macVoices: [] }),
  probeLocalContext: async () => ({ ok: false, message: 'Context measurement requires the desktop app.' }),
  pullLocalModel: async () => ({ ok: false, message: 'Local AI requires the desktop app.' }),
  cancelLocalPull: async () => ({ ok: true }),
  deleteLocalModel: async () => ({ ok: false, message: 'Local AI requires the desktop app.' }),
  onLocalProgress: () => () => {},
  getAcademy: async () => ({ profiles: [], sources: [], evaluations: [] }),
  academyCommand: async () => ({ ok: false, snapshot: { profiles: [], sources: [], evaluations: [] }, message: 'Athena Academy requires the desktop app.' }),
  getAcademyTraining: async () => ({ runtime: { ready: false, metalAvailable: false, message: 'Training requires the macOS desktop app.' }, profiles: [], jobs: [], comparisons: [] }),
  academyTrainingCommand: async () => ({ ok: false, snapshot: { runtime: { ready: false, metalAvailable: false, message: 'Training requires the macOS desktop app.' }, profiles: [], jobs: [], comparisons: [] }, message: 'Training requires the macOS desktop app.' }),
  onAcademyTrainingProgress: () => () => {},
  getAcademyIntegrations: async () => [{ provider: 'github' as const, connected: false }, { provider: 'gitlab' as const, connected: false }],
  academyIntegrationCommand: async () => ({ ok: false, statuses: [{ provider: 'github' as const, connected: false }, { provider: 'gitlab' as const, connected: false }], message: 'Code-host integrations require the desktop app.' }),
  getAcademyStudio: async () => ({ meetings: [], interviews: [], attempts: [] }),
  academyStudioCommand: async () => ({ ok: false, snapshot: { meetings: [], interviews: [], attempts: [] }, message: 'Practice & Notes requires the desktop app.' }),
  onAcademyProjectProgress: () => () => {},
  onAcademyProgress: () => () => {},
  getSnapshot: async () => preview,
  avatarModel: async () => ({ ok: false, error: 'Model imports require the updated desktop application.' }),
  readAvatarModel: async () => { throw new Error('Model files require the desktop application.') },
  updateSettings: async (patch) => { preview = { ...preview, settings: mergeSettings(preview.settings, patch) }; preview.visible = preview.settings.floatingEnabled; publish(); return preview },
  command: async (command) => {
    if (command === 'pin') await previewApi.updateSettings({ pinned: true })
    if (command === 'unpin') await previewApi.updateSettings({ pinned: false })
    if (command === 'hide' || command === 'show' || command === 'toggle') await previewApi.updateSettings({ floatingEnabled: command === 'show' || (command === 'toggle' && !preview.visible) })
    if (command === 'open-settings') window.dispatchEvent(new CustomEvent('athena:navigate', { detail: 'general' }))
    // The browser preview has no native microphone bridge; the desktop app
    // handles the direct floating voice activation through IPC.
  },
  beginDrag: async () => {}, endDrag: async () => false,
  onSnapshot: (callback) => { listeners.add(callback); return () => { listeners.delete(callback) } },
  onNavigate: (callback) => {
    const listener = (event: Event) => callback((event as CustomEvent<string>).detail)
    window.addEventListener('athena:navigate', listener)
    return () => window.removeEventListener('athena:navigate', listener)
  },
}
export const desktop = window.athena ?? previewApi
export const isDesktop = Boolean(window.athena)
