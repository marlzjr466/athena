import { z } from 'zod'
import type { ImportedAvatar, ModelCommand, ModelResult } from './avatarModels'
import type { VroidActionId, VroidActionSnapshot, VroidClipReport } from './vroidActions'
import type { Settings, SettingsPatch } from './settings'
import type { DisplayArea } from './geometry'
import type { Flight } from './flight'
import type { IdleActionSession } from './idleActions'
import type { AIResult } from './ai'
import type { ChatGPTStatus } from './chatgpt'
import type { ChatResult, ChatSnapshot } from './chat'
import type { ContextCommand, ContextResult, SessionCommand } from './conversations'
import type { AthenaPermission, FilesystemAccessMode, PermissionInfo, PermissionResult, PermissionSnapshot } from './permissions'
import type { VoiceClip, VoiceIdentity, VoiceResult, VoiceSnapshot } from './voice'
import type { SpeechAudioResult, SpeechStart, SpeechPart, SpeechStatus, SpeechStop } from './speech'
import type { ApplicationDetectionResult } from './applicationDetection'
import type { LocalPullProgress, LocalStatus } from './localAI'
import type { AcademyCommand, AcademyIndexProgress, AcademyProjectProgress, AcademyResult, AcademySnapshot } from './academy'
import type { TrainingCommand, TrainingProgress, TrainingResult, TrainingSnapshot } from './academyTraining'
import type { AcademyIntegrationCommand, AcademyIntegrationResult, AcademyIntegrationStatus } from './academyIntegrations'
import type { AcademyStudioCommand, AcademyStudioResult, AcademyStudioSnapshot } from './academyStudio'
import type { LocalVoiceStatus, VoiceEngine, VoiceInstallProgress, VoiceProfileCommand, LocalVoiceCommand, LocalVoiceCommandResult } from './localVoice'
import type { HandsFreeAudio, HandsFreeReplyResult, HandsFreeSpeechResult, HandsFreeState } from './handsFree'
import type { DesktopActionResult } from './desktopActions'
import type { CursorStatus } from './cursor'
import type { CodexCLIStatus } from './codex'
import type { SlashCommandCatalog } from './slashCommands'
import type { WebSearchStatus, WebSearchTestResult } from './webAccess'

export const athenaStates = ['idle', 'floating', 'listening', 'thinking', 'speaking', 'moving', 'working', 'happy', 'sleeping', 'error'] as const
export type AthenaState = typeof athenaStates[number]
export type TaskVisualMode = 'idle' | 'thinking' | 'exploring' | 'reading' | 'searching' | 'typing' | 'terminal' | 'browser' | 'completed' | 'failed' | 'cancelled'
export interface TaskVisualSnapshot { mode: TaskVisualMode; source?: 'local-chat' | 'background'; label?: string; activityType?: string; startedAt?: number; anchor: { x: number; y: number } }
export type Surface = 'control' | 'floating' | 'panel' | 'meeting'
export const commandSchema = z.enum(['show', 'hide', 'toggle', 'pin', 'unpin', 'open-control', 'open-chat', 'open-settings', 'open-panel', 'open-menu', 'close-panel', 'close-chat', 'next-monitor', 'quit'])
export type DesktopCommand = z.infer<typeof commandSchema>
export interface Snapshot {
  importedAvatars?: ImportedAvatar[]
  vroidActions?: VroidActionSnapshot
  settings: Settings
  displays: DisplayArea[]
  state: AthenaState
  flight: Flight | null
  taskVisual?: TaskVisualSnapshot
  idleAction: IdleActionSession | null
  visible: boolean
  panelMode: 'chat' | 'menu'
  panelVisible: boolean
  handsFreeState?: HandsFreeState
  /** Explicit local Floating Athena voice ownership; independent of avatar model and speech playback. */
  floatingVoiceActive?: boolean
  onBattery: boolean
  reducedMotion: boolean
  platform: string
  version: string
  error: string | null
}
export interface AthenaAPI {
  officialCSM(input: import('./officialCSM').OfficialCSMCommand): Promise<import('./officialCSM').CSMResult>
  higgsTTS(input: import('./higgsTTS').HiggsCommand): Promise<import('./higgsTTS').HiggsResult>
  avatarModel(input: ModelCommand): Promise<ModelResult>
  readAvatarModel(id: string): Promise<Uint8Array>
  beginSpeech(input: SpeechStart): Promise<SpeechAudioResult>
  nextSpeech(input: SpeechPart): Promise<SpeechAudioResult>
  speechPlaying(input: SpeechPart): Promise<{ ok: boolean; reason?: string }>
  stopSpeech(input: SpeechStop): Promise<{ ok: boolean }>
  onSpeech(callback: (status: SpeechStatus) => void): () => void
  reportSpeechLevel(input: { level: number }): Promise<{ ok: boolean }>
  onSpeechLevel(callback: (input: { level: number }) => void): () => void
  getLocalVoiceStatus(): Promise<LocalVoiceStatus>
  installLocalVoice(input: { engine: VoiceEngine }): Promise<{ ok: boolean; message: string }>
  cancelLocalVoiceInstall(): Promise<{ ok: boolean }>
  manageVoiceProfile(input: VoiceProfileCommand): Promise<{ ok: boolean; message?: string }>
  previewLocalVoice(input?: { text?: string; saveSample?: boolean }): Promise<SpeechAudioResult>
  manageLocalVoice(input: LocalVoiceCommand): Promise<LocalVoiceCommandResult>
  stopAllSpeech(): Promise<{ ok: boolean }>
  onLocalVoicePlaybackStopped(callback: () => void): () => void
  onLocalVoiceProgress(callback: (progress: VoiceInstallProgress) => void): () => void
  beginVoice(input: VoiceIdentity): Promise<VoiceResult>
  voiceRecording(input: VoiceIdentity): Promise<VoiceResult>
  transcribeVoice(input: VoiceClip): Promise<VoiceResult>
  cancelVoice(input: VoiceIdentity): Promise<VoiceResult>
  onVoice(callback: (snapshot: VoiceSnapshot) => void): () => void
  enableHandsFree(sessionId?: string): Promise<{ ok: boolean; message?: string; ownership?: import('./aiOwnership').AIOwnership }>
  disableHandsFree(ownership?: import('./aiOwnership').AIOwnership): Promise<{ ok: boolean }>
  transcribeHandsFree(input: HandsFreeAudio): Promise<{ ok: boolean; transcript?: string; message?: string }>
  cancelHandsFreeTranscription(input: { id: string }): Promise<{ ok: boolean }>
  answerHandsFree(input: { id?: string; text: string; ownership?: import('./aiOwnership').AIOwnership; diagnosticDirect?: boolean }): Promise<HandsFreeReplyResult>
  onHandsFreeReplyProgress(callback: (progress: import('./handsFree').HandsFreeReplyProgress) => void): () => void
  cancelHandsFreeReply(): Promise<{ ok: boolean }>
  clearHandsFreeContext(): Promise<{ ok: boolean }>
  speakHandsFree(input: { id: string; text: string; ownership?: import('./aiOwnership').AIOwnership; cache?: boolean }): Promise<HandsFreeSpeechResult>
  nextHandsFreeSpeech(input: { id: string; index: number; ownership: import('./aiOwnership').AIOwnership }): Promise<HandsFreeSpeechResult>
  stopHandsFreeSpeech(): Promise<{ ok: boolean }>
  handsFreePlayback(input: { playing: boolean; ownership?: import('./aiOwnership').AIOwnership }): Promise<{ ok: boolean }>
  setHandsFreeState(input: HandsFreeState): Promise<{ ok: boolean }>
  openApplicationByVoice(input: { app: string; confirmed?: boolean }): Promise<DesktopActionResult>
  focusApplicationByVoice(input: { app: string; confirmed?: boolean }): Promise<DesktopActionResult>
  openURLByVoice(input: { url: string; confirmed?: boolean }): Promise<DesktopActionResult>
  getVoiceSearchResult(input: { index: number }): Promise<{ ok: boolean; url?: string; title?: string; message?: string }>
  updateRememberedPermissions(input: import('./permissions').RememberedCommand): Promise<PermissionResult>
  getPermissions(): Promise<PermissionSnapshot>
  getPermissionStatus(input: { permission: AthenaPermission }): Promise<PermissionInfo>
  setPermissionEnabled(input: { permission: AthenaPermission; enabled: boolean }): Promise<PermissionResult>
  setFilesystemAccess(input: { mode: FilesystemAccessMode }): Promise<PermissionResult>
  requestPermission(input: { permission: AthenaPermission }): Promise<PermissionResult>
  openPermissionSettings(input: { permission: AthenaPermission }): Promise<PermissionResult>
  isCapabilityAllowed(input: { permission: AthenaPermission }): Promise<boolean>
  getApplications(): Promise<ApplicationDetectionResult>
  getChat(): Promise<ChatSnapshot>
  sendChat(input: { text: string; sessionId?: string; requestId?: string; commandId?: string }): Promise<ChatResult>
  getSlashCommands(input: { action: 'list' | 'authorize-global' | 'revoke-global'; sessionId: string; surface?: 'conversation' | 'local' }): Promise<SlashCommandCatalog>
  chatSession(input: SessionCommand): Promise<ChatResult>
  chatContext(input: ContextCommand): Promise<ContextResult>
  searchChats(input: { query: string }): Promise<string[]>
  retryChat(): Promise<ChatResult>
  stopChat(): Promise<ChatResult>
  clearChat(): Promise<ChatResult>
  copyChatText(input: { text: string }): Promise<ChatResult>
  onChat(callback: (snapshot: ChatSnapshot) => void): () => void
  getAthenaChat(): Promise<ChatSnapshot>
  sendAthenaChat(input: { text: string; sessionId?: string; requestId?: string; commandId?: string }): Promise<ChatResult>
  athenaChatSession(input: SessionCommand): Promise<ChatResult>
  athenaChatContext(input: ContextCommand): Promise<ContextResult>
  searchAthenaChats(input: { query: string }): Promise<string[]>
  retryAthenaChat(): Promise<ChatResult>
  stopAthenaChat(): Promise<ChatResult>
  clearAthenaChat(): Promise<ChatResult>
  focusAthenaChat(input: { active: boolean; sessionId?: string }): Promise<ChatResult>
  onAthenaChat(callback: (snapshot: ChatSnapshot) => void): () => void
  copilot(input: import('./copilot').CopilotCommand): Promise<import('./copilot').CopilotStatus>
  getAIStatus(): Promise<AIResult>
  testAIConnection(input?: { apiKey: string }): Promise<AIResult>
  activateAI(input: { apiKey: string }): Promise<AIResult>
  selectAIModel(input: { model: string }): Promise<AIResult>
  removeAIKey(): Promise<AIResult>
  getWebSearchStatus(): Promise<WebSearchStatus>
  testWebSearch(input?: { apiKey?: string; model?: string }): Promise<WebSearchTestResult>
  saveWebSearchKey(input: { apiKey: string }): Promise<WebSearchTestResult>
  removeWebSearchKey(): Promise<{ ok: boolean; message: string }>
  openExternalLink(input: { url: string }): Promise<{ ok: boolean; message?: string }>
  getClaudeStatus(): Promise<AIResult>
  testClaudeConnection(input?: { apiKey: string }): Promise<AIResult>
  activateClaudeAPI(input: { apiKey: string }): Promise<AIResult>
  selectClaudeModel(input: { model: string }): Promise<AIResult>
  removeClaudeAPIKey(): Promise<AIResult>
  getCursorStatus(input?: { refreshModels?: boolean; cachedOnly?: boolean }): Promise<CursorStatus>
  signInCursor(): Promise<CursorStatus>
  signOutCursor(): Promise<CursorStatus>
  getChatGPTStatus(): Promise<ChatGPTStatus>
  getCodexCLIStatus(input?: { refresh?: boolean }): Promise<CodexCLIStatus>
  addChatGPTAccount(): Promise<ChatGPTStatus>
  retryAddChatGPTAccount(): Promise<ChatGPTStatus>
  confirmChatGPTAccount(input: { pendingId: string; label?: string }): Promise<ChatGPTStatus>
  cancelChatGPTAccount(input: { pendingId: string }): Promise<ChatGPTStatus>
  reconnectChatGPTAccount(input: { accountId: string }): Promise<ChatGPTStatus>
  selectChatGPTAccount(input: { accountId: string }): Promise<ChatGPTStatus>
  setChatGPTAccountEnabled(input: { accountId: string; enabled: boolean }): Promise<ChatGPTStatus>
  renameChatGPTAccount(input: { accountId: string; label: string }): Promise<ChatGPTStatus>
  removeChatGPTAccount(input: { accountId: string }): Promise<ChatGPTStatus>
  signInChatGPT(): Promise<ChatGPTStatus>
  signOutChatGPT(): Promise<ChatGPTStatus>
  refreshChatGPTModels(input?: { accountId?: string }): Promise<ChatGPTStatus>
  selectChatGPTModel(input: { model: string; accountId?: string }): Promise<ChatGPTStatus>
  openChatGPTUsage(): Promise<void>
  getLocalStatus(): Promise<LocalStatus>
  probeLocalContext(input: { model: string; tokens: number }): Promise<{ ok: boolean; message: string }>
  pullLocalModel(input: { model: string }): Promise<{ ok: boolean; message: string }>
  cancelLocalPull(): Promise<{ ok: boolean }>
  deleteLocalModel(input: { model: string }): Promise<{ ok: boolean; message: string }>
  onLocalProgress(callback: (progress: LocalPullProgress) => void): () => void
  getAcademy(): Promise<AcademySnapshot>
  academyCommand(input: AcademyCommand): Promise<AcademyResult>
  getAcademyTraining(): Promise<TrainingSnapshot>
  academyTrainingCommand(input: TrainingCommand): Promise<TrainingResult>
  onAcademyTrainingProgress(callback: (progress: TrainingProgress) => void): () => void
  getAcademyIntegrations(): Promise<AcademyIntegrationStatus[]>
  academyIntegrationCommand(input: AcademyIntegrationCommand): Promise<AcademyIntegrationResult>
  getAcademyStudio(): Promise<AcademyStudioSnapshot>
  academyStudioCommand(input: AcademyStudioCommand): Promise<AcademyStudioResult>
  onAcademyProjectProgress(callback: (progress: AcademyProjectProgress) => void): () => void
  onAcademyProgress(callback: (progress: AcademyIndexProgress) => void): () => void
  getSnapshot(): Promise<Snapshot>
  registerVroidAnimations(clips: VroidClipReport[], modelId?: string): Promise<Snapshot>
  playVroidAction(id: VroidActionId): Promise<{ ok: boolean; message?: string }>
  updateSettings(patch: SettingsPatch): Promise<Snapshot>
  command(command: DesktopCommand): Promise<void>
  beginDrag(): Promise<void>
  endDrag(): Promise<boolean>
  onSnapshot(callback: (snapshot: Snapshot) => void): () => void
  onNavigate(callback: (page: string) => void): () => void
}
export { IPC } from './ipcChannels'
