import { MEETING_COMMAND, MEETING_EVENT, type MeetingAPI, type MeetingSnapshot } from '../../shared/meetings'
import { contextBridge, ipcRenderer } from 'electron'
import { STARTUP_IPC } from '../../shared/startup'
import type { AthenaAPI, Snapshot } from '../../shared/contracts'
import { IPC } from '../../shared/ipcChannels'
import type { ChatSnapshot } from '../../shared/chat'
import type { VoiceSnapshot } from '../../shared/voice'
import type { SpeechStatus } from '../../shared/speech'
import type { LocalPullProgress } from '../../shared/localAI'
import type { AcademyIndexProgress, AcademyProjectProgress } from '../../shared/academy'
import type { TrainingProgress } from '../../shared/academyTraining'
import type { VoiceInstallProgress } from '../../shared/localVoice'
import type { HandsFreeAudio, HandsFreeReplyProgress, HandsFreeState } from '../../shared/handsFree'

contextBridge.exposeInMainWorld('athenaStartup', { ready: () => ipcRenderer.send(STARTUP_IPC.ready) })

const api: AthenaAPI = {
  beginSpeech: (input) => ipcRenderer.invoke(IPC.speechBegin, input),
  nextSpeech: (input) => ipcRenderer.invoke(IPC.speechNext, input),
  speechPlaying: (input) => ipcRenderer.invoke(IPC.speechPlaying, input),
  stopSpeech: (input) => ipcRenderer.invoke(IPC.speechStop, input),
  onSpeech: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, status: SpeechStatus) => callback(status)
    ipcRenderer.on(IPC.speechChanged, listener)
    return () => ipcRenderer.removeListener(IPC.speechChanged, listener)
  },
  reportSpeechLevel: (input) => ipcRenderer.invoke(IPC.speechLevel, input),
  onSpeechLevel: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, input: { level: number }) => callback(input)
    ipcRenderer.on(IPC.speechLevelChanged, listener)
    return () => ipcRenderer.removeListener(IPC.speechLevelChanged, listener)
  },
  officialCSM: (input) => ipcRenderer.invoke(IPC.officialCSM, input),
  higgsTTS: (input) => ipcRenderer.invoke(IPC.higgsTTS, input),
  getLocalVoiceStatus: () => ipcRenderer.invoke(IPC.localVoiceStatus),
  installLocalVoice: (input) => ipcRenderer.invoke(IPC.localVoiceInstall, input),
  cancelLocalVoiceInstall: () => ipcRenderer.invoke(IPC.localVoiceCancel),
  manageVoiceProfile: (input) => ipcRenderer.invoke(IPC.localVoiceProfile, input),
  previewLocalVoice: (input) => ipcRenderer.invoke(IPC.localVoicePreview, input),
  manageLocalVoice: (input) => ipcRenderer.invoke(IPC.localVoiceManage, input),
  stopAllSpeech: () => ipcRenderer.invoke(IPC.localVoiceStop),
  onLocalVoicePlaybackStopped: (callback) => { const listener = () => callback(); ipcRenderer.on(IPC.localVoicePlaybackStopped, listener); return () => ipcRenderer.removeListener(IPC.localVoicePlaybackStopped, listener) },
  onLocalVoiceProgress: (callback) => { const listener = (_event: Electron.IpcRendererEvent, event: VoiceInstallProgress) => callback(event); ipcRenderer.on(IPC.localVoiceProgress, listener); return () => ipcRenderer.removeListener(IPC.localVoiceProgress, listener) },
  beginVoice: (input) => ipcRenderer.invoke(IPC.voiceBegin, input),
  voiceRecording: (input) => ipcRenderer.invoke(IPC.voiceRecording, input),
  transcribeVoice: (input) => ipcRenderer.invoke(IPC.voiceTranscribe, input),
  cancelVoice: (input) => ipcRenderer.invoke(IPC.voiceCancel, input),
  onVoice: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, snapshot: VoiceSnapshot) => callback(snapshot)
    ipcRenderer.on(IPC.voiceChanged, listener)
    return () => { ipcRenderer.removeListener(IPC.voiceChanged, listener) }
  },
  enableHandsFree: (sessionId) => ipcRenderer.invoke(IPC.handsFreeEnable, sessionId),
  disableHandsFree: (ownership) => ipcRenderer.invoke(IPC.handsFreeDisable, ownership),
  transcribeHandsFree: (input: HandsFreeAudio) => ipcRenderer.invoke(IPC.handsFreeTranscribe, input),
  cancelHandsFreeTranscription: (input: { id: string }) => ipcRenderer.invoke(IPC.handsFreeCancelTranscription, input),
  answerHandsFree: (input) => ipcRenderer.invoke(IPC.handsFreeReply, input),
  onHandsFreeReplyProgress: (callback) => { const listener = (_event: Electron.IpcRendererEvent, progress: HandsFreeReplyProgress) => callback(progress); ipcRenderer.on(IPC.handsFreeReplyProgress, listener); return () => ipcRenderer.removeListener(IPC.handsFreeReplyProgress, listener) },
  cancelHandsFreeReply: () => ipcRenderer.invoke(IPC.handsFreeCancelReply),
  clearHandsFreeContext: () => ipcRenderer.invoke(IPC.handsFreeClearContext),
  speakHandsFree: (input) => ipcRenderer.invoke(IPC.handsFreeSpeak, input),
  nextHandsFreeSpeech: (input) => ipcRenderer.invoke(IPC.handsFreeSpeechNext, input),
  stopHandsFreeSpeech: () => ipcRenderer.invoke(IPC.handsFreeStopSpeech),
  handsFreePlayback: (input) => ipcRenderer.invoke(IPC.handsFreePlayback, input),
  setHandsFreeState: (input: HandsFreeState) => ipcRenderer.invoke(IPC.handsFreeState, input),
  openApplicationByVoice: (input) => ipcRenderer.invoke(IPC.handsFreeOpenApp, { action: 'open-app', ...input }),
  focusApplicationByVoice: (input) => ipcRenderer.invoke(IPC.handsFreeOpenApp, { action: 'focus-app', ...input }),
  openURLByVoice: (input) => ipcRenderer.invoke(IPC.handsFreeOpenApp, { action: 'open-url', ...input }),
  getVoiceSearchResult: (input) => ipcRenderer.invoke(IPC.handsFreeSearchResult, input),
  updateRememberedPermissions: (input) => ipcRenderer.invoke(IPC.rememberedPermissionsSet, input),
  getPermissions: () => ipcRenderer.invoke(IPC.permissionsGet),
  getPermissionStatus: (input) => ipcRenderer.invoke(IPC.permissionStatus, input),
  setPermissionEnabled: (input) => ipcRenderer.invoke(IPC.permissionSet, input),
  setFilesystemAccess: (input) => ipcRenderer.invoke(IPC.filesystemAccessSet, input),
  requestPermission: (input) => ipcRenderer.invoke(IPC.permissionRequest, input),
  openPermissionSettings: (input) => ipcRenderer.invoke(IPC.permissionSettings, input),
  isCapabilityAllowed: (input) => ipcRenderer.invoke(IPC.permissionAllowed, input),
  getApplications: () => ipcRenderer.invoke(IPC.applicationDetection),
  getChat: () => ipcRenderer.invoke(IPC.chatGet),
  chatSession: (input) => ipcRenderer.invoke(IPC.chatSession, input),
  chatContext: (input) => ipcRenderer.invoke(IPC.chatContext, input),
  searchChats: (input) => ipcRenderer.invoke(IPC.chatSearch, input),
  sendChat: (input) => ipcRenderer.invoke(IPC.chatSend, input),
  getSlashCommands: (input) => ipcRenderer.invoke(IPC.chatSlashCommands, input),
  retryChat: () => ipcRenderer.invoke(IPC.chatRetry),
  stopChat: () => ipcRenderer.invoke(IPC.chatStop),
  clearChat: () => ipcRenderer.invoke(IPC.chatClear),
  copyChatText: (input) => ipcRenderer.invoke(IPC.chatCopy, input),
  onChat: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, snapshot: ChatSnapshot) => callback(snapshot)
    ipcRenderer.on(IPC.chatChanged, listener)
    return () => { ipcRenderer.removeListener(IPC.chatChanged, listener) }
  },
  getAthenaChat: () => ipcRenderer.invoke(IPC.athenaChatGet),
  sendAthenaChat: (input) => ipcRenderer.invoke(IPC.athenaChatSend, input),
  athenaChatSession: (input) => ipcRenderer.invoke(IPC.athenaChatSession, input),
  athenaChatContext: (input) => ipcRenderer.invoke(IPC.athenaChatContext, input),
  searchAthenaChats: (input) => ipcRenderer.invoke(IPC.athenaChatSearch, input),
  retryAthenaChat: () => ipcRenderer.invoke(IPC.athenaChatRetry),
  stopAthenaChat: () => ipcRenderer.invoke(IPC.athenaChatStop),
  clearAthenaChat: () => ipcRenderer.invoke(IPC.athenaChatClear),
  focusAthenaChat: (input) => ipcRenderer.invoke(IPC.athenaChatFocus, input),
  onAthenaChat: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, snapshot: ChatSnapshot) => callback(snapshot)
    ipcRenderer.on(IPC.athenaChatChanged, listener)
    return () => ipcRenderer.removeListener(IPC.athenaChatChanged, listener)
  },
  copilot: input => ipcRenderer.invoke(IPC.copilot, input),
  getAIStatus: () => ipcRenderer.invoke(IPC.aiStatus),
  testAIConnection: (input) => ipcRenderer.invoke(IPC.aiTest, input),
  activateAI: (input) => ipcRenderer.invoke(IPC.aiActivate, input),
  selectAIModel: (input) => ipcRenderer.invoke(IPC.aiModel, input),
  removeAIKey: () => ipcRenderer.invoke(IPC.aiRemove),
  getWebSearchStatus: () => ipcRenderer.invoke(IPC.webSearchStatus),
  testWebSearch: (input) => ipcRenderer.invoke(IPC.webSearchTest, input),
  saveWebSearchKey: (input) => ipcRenderer.invoke(IPC.webSearchSave, input),
  removeWebSearchKey: () => ipcRenderer.invoke(IPC.webSearchRemove),
  openExternalLink: (input) => ipcRenderer.invoke(IPC.openExternalLink, input),
  getClaudeStatus: () => ipcRenderer.invoke(IPC.claudeStatus),
  testClaudeConnection: (input) => ipcRenderer.invoke(IPC.claudeTest, input),
  activateClaudeAPI: (input) => ipcRenderer.invoke(IPC.claudeActivate, input),
  selectClaudeModel: (input) => ipcRenderer.invoke(IPC.claudeModel, input),
  removeClaudeAPIKey: () => ipcRenderer.invoke(IPC.claudeRemove),
  getCursorStatus: (input) => ipcRenderer.invoke(IPC.cursorStatus, input),
  signInCursor: () => ipcRenderer.invoke(IPC.cursorLogin),
  signOutCursor: () => ipcRenderer.invoke(IPC.cursorLogout),
  getChatGPTStatus: () => ipcRenderer.invoke(IPC.chatGPTStatus),
  getCodexCLIStatus: (input) => ipcRenderer.invoke(IPC.codexCLIStatus, input),
  addChatGPTAccount: () => ipcRenderer.invoke(IPC.chatGPTAccountAdd),
  retryAddChatGPTAccount: () => ipcRenderer.invoke(IPC.chatGPTAccountRetry),
  confirmChatGPTAccount: (input) => ipcRenderer.invoke(IPC.chatGPTAccountConfirm, input),
  cancelChatGPTAccount: (input) => ipcRenderer.invoke(IPC.chatGPTAccountCancel, input),
  reconnectChatGPTAccount: (input) => ipcRenderer.invoke(IPC.chatGPTAccountReconnect, input),
  selectChatGPTAccount: (input) => ipcRenderer.invoke(IPC.chatGPTAccountSelect, input),
  setChatGPTAccountEnabled: (input) => ipcRenderer.invoke(IPC.chatGPTAccountEnabled, input),
  renameChatGPTAccount: (input) => ipcRenderer.invoke(IPC.chatGPTAccountRename, input),
  removeChatGPTAccount: (input) => ipcRenderer.invoke(IPC.chatGPTAccountRemove, input),
  signInChatGPT: () => ipcRenderer.invoke(IPC.chatGPTSignIn),
  signOutChatGPT: () => ipcRenderer.invoke(IPC.chatGPTSignOut),
  refreshChatGPTModels: (input) => ipcRenderer.invoke(IPC.chatGPTModels, input),
  selectChatGPTModel: (input) => ipcRenderer.invoke(IPC.chatGPTModel, input),
  openChatGPTUsage: () => ipcRenderer.invoke(IPC.chatGPTUsage),
  getLocalStatus: () => ipcRenderer.invoke(IPC.localStatus),
  probeLocalContext: (input) => ipcRenderer.invoke(IPC.localContextProbe, input),
  pullLocalModel: (input) => ipcRenderer.invoke(IPC.localPull, input),
  cancelLocalPull: () => ipcRenderer.invoke(IPC.localCancelPull),
  deleteLocalModel: (input) => ipcRenderer.invoke(IPC.localDelete, input),
  onLocalProgress: (callback) => { const listener = (_event: Electron.IpcRendererEvent, progress: LocalPullProgress) => callback(progress); ipcRenderer.on(IPC.localProgress, listener); return () => ipcRenderer.removeListener(IPC.localProgress, listener) },
  getAcademy: () => ipcRenderer.invoke(IPC.academyGet),
  academyCommand: (input) => ipcRenderer.invoke(IPC.academyCommand, input),
  getAcademyTraining: () => ipcRenderer.invoke(IPC.academyTrainingGet),
  academyTrainingCommand: (input) => ipcRenderer.invoke(IPC.academyTrainingCommand, input),
  onAcademyTrainingProgress: (callback) => { const listener = (_event: Electron.IpcRendererEvent, progress: TrainingProgress) => callback(progress); ipcRenderer.on(IPC.academyTrainingProgress, listener); return () => ipcRenderer.removeListener(IPC.academyTrainingProgress, listener) },
  getAcademyIntegrations: () => ipcRenderer.invoke(IPC.academyIntegrationsGet),
  academyIntegrationCommand: (input) => ipcRenderer.invoke(IPC.academyIntegrationsCommand, input),
  getAcademyStudio: () => ipcRenderer.invoke(IPC.academyStudioGet),
  academyStudioCommand: (input) => ipcRenderer.invoke(IPC.academyStudioCommand, input),
  onAcademyProjectProgress: (callback) => { const listener = (_event: Electron.IpcRendererEvent, progress: AcademyProjectProgress) => callback(progress); ipcRenderer.on(IPC.academyProjectProgress, listener); return () => ipcRenderer.removeListener(IPC.academyProjectProgress, listener) },
  onAcademyProgress: (callback) => { const listener = (_event: Electron.IpcRendererEvent, progress: AcademyIndexProgress) => callback(progress); ipcRenderer.on(IPC.academyProgress, listener); return () => ipcRenderer.removeListener(IPC.academyProgress, listener) },
  getSnapshot: () => ipcRenderer.invoke(IPC.snapshot),
  avatarModel: input => ipcRenderer.invoke(IPC.avatarModel, input),
  readAvatarModel: id => ipcRenderer.invoke(IPC.avatarRead, id),
  registerVroidAnimations: (clips, modelId = 'vroid-athena') => ipcRenderer.invoke(IPC.vroidCatalog, { clips, modelId }),
  playVroidAction: (id) => ipcRenderer.invoke(IPC.vroidPlay, id),
  updateSettings: (patch) => ipcRenderer.invoke(IPC.settings, patch),
  command: (command) => ipcRenderer.invoke(IPC.command, command),
  beginDrag: () => ipcRenderer.invoke(IPC.dragStart),
  endDrag: () => ipcRenderer.invoke(IPC.dragEnd),
  onSnapshot: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, snapshot: Snapshot) => callback(snapshot)
    ipcRenderer.on(IPC.changed, listener)
    return () => { ipcRenderer.removeListener(IPC.changed, listener) }
  },
  onNavigate: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, page: string) => callback(page)
    ipcRenderer.on(IPC.navigate, listener)
    return () => { ipcRenderer.removeListener(IPC.navigate, listener) }
  },
}
contextBridge.exposeInMainWorld('athena', api)

const meetings: MeetingAPI = { command: input => ipcRenderer.invoke(MEETING_COMMAND, input), subscribe: callback => { const listener = (_event: Electron.IpcRendererEvent, value: MeetingSnapshot) => callback(value); ipcRenderer.on(MEETING_EVENT,listener); return () => ipcRenderer.removeListener(MEETING_EVENT,listener) } }; contextBridge.exposeInMainWorld('meetings', meetings)
