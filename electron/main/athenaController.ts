import { app, globalShortcut, powerMonitor, systemPreferences } from 'electron'
import { join } from 'node:path'
import { AvatarModelRepository } from './avatarModelRepository'
import { isVrmAvatar } from '../../shared/avatarModels'
import { mergeSettings, type Settings } from '../../shared/settings'
import { transition, type BehaviorEvent } from '../../shared/behavior'
import type { AthenaState, DesktopCommand, Snapshot, TaskVisualMode, TaskVisualSnapshot } from '../../shared/contracts'
import { IPC } from '../../shared/contracts'
import { SettingsRepository } from './settingsRepository'
import { WindowManager } from './windowManager'
import type { StartupSplash } from './startupSplash'
import { MotionController } from './motionController'
import { currentArea, getDisplays } from './screenManager'
import { log } from './logger'
import { fixedPositions, type Flight } from '../../shared/flight'
import { IdleActionController } from './idleActionController'
import { VroidActionScheduler } from './vroidActionScheduler'
import type { VroidActionId, VroidVoicePhase } from '../../shared/vroidActions'
import type { ChatPhase } from '../../shared/chat'
import type { HandsFreeState } from '../../shared/handsFree'
import type { ChatSnapshot } from '../../shared/chat'
import { currentTaskActivity, taskVisualModeForActivity, taskVisualModeForStatus } from '../../shared/taskActivity'
import { isLocalOwnership } from '../../shared/aiOwnership'

export class AthenaController {
  settings: Settings
  windows: WindowManager
  motion: MotionController
  actions: IdleActionController
  vroidActions: VroidActionScheduler
  avatarModels: AvatarModelRepository
  state: AthenaState = 'idle'
  flight: Flight | null = null
  panelMode: 'chat' | 'menu' = 'chat'
  error: string | null = null
  private persistTimer?: ReturnType<typeof setTimeout>
  private reactionTimer?: ReturnType<typeof setTimeout>
  private panelTimer?: ReturnType<typeof setTimeout>
  private conversationState: Exclude<ChatPhase, 'idle'> | null = null
  private voiceState: 'listening' | 'thinking' | null = null
  private speechState: 'speaking' | 'working' | null = null
  private taskMode: TaskVisualMode = 'idle'
  private taskActivityType?: string
  private taskActivityLabel?: string
  private taskVisualSource?: 'local-chat' | 'background'
  private taskStartedAt?: number
  private taskStartTimer?: ReturnType<typeof setTimeout>
  private taskCompletionTimer?: ReturnType<typeof setTimeout>
  private taskOutcomeStatus?: string
  private handsFreeState: HandsFreeState = { state: 'paused' }
  onChange?: () => void
  onSettingsChange?: (previous: Settings, next: Settings) => void

  constructor(private repository: SettingsRepository, startup?: StartupSplash) {
    this.settings = repository.load()
    this.avatarModels = new AvatarModelRepository(join(app.getPath('userData'), 'avatars'), () => { if (this.windows) this.broadcast() })
    if (this.avatarModels.loadError) this.error = this.avatarModels.loadError
    this.windows = new WindowManager(() => this.settings, startup)
    this.windows.create()
    this.motion = new MotionController(this.windows.floating, {
      settings: () => this.settings,
      blocked: () => this.voiceState ? 'voice input' : this.settings.pauseFloatingWhileWorking && this.speechState ? 'voice output' : this.settings.pauseFloatingWhileWorking && this.conversationState ? 'conversation'
        : this.windows.panel.isVisible() ? 'user interaction'
        : this.settings.doNotDisturb ? 'do not disturb'
        : this.settings.reducedMotion || systemPreferences.getAnimationSettings().prefersReducedMotion ? 'reduced motion' : null,
      state: () => this.state,
      flight: (flight) => { this.flight = flight; if (flight) this.actions?.cancel(); this.broadcast() },
      activity: () => this.actions?.reconcile(),
      actionRemainingMs: () => isVrmAvatar(this.settings.avatarVariant) ? this.vroidActions?.remainingMs ?? 0 : this.actions?.current ? Math.max(0, this.actions.current.startedAt + this.actions.current.durationMs - Date.now()) : 0,
      taskActive: () => Boolean(this.conversationState || this.speechState || this.taskMode !== 'idle'),
      pauseForTask: () => this.settings.pauseFloatingWhileWorking || (this.settings.taskActivityEnabled && this.taskMode !== 'idle'),
      characterBounds: () => {
        const bounds = this.windows.floating.getBounds(), anchor = this.windows.getTaskAnchor()
        return anchor ? { x: bounds.x + anchor.x - this.settings.size / 2, y: bounds.y + anchor.y - this.settings.size / 2, width: this.settings.size, height: this.settings.size } : bounds
      },
      behavior: (event) => this.behavior(event),
      settled: ({ x, y }) => {
        const anchor = this.windows.getTaskAnchor()
        const position = anchor ? { x: x + anchor.x - this.settings.size / 2, y: y + anchor.y - this.settings.size / 2 } : { x, y }
        this.settings = { ...this.settings, position }; this.persistSoon()
      },
    })
    this.actions = new IdleActionController({ settings: () => this.settings, eligible: () => !isVrmAvatar(this.settings.avatarVariant) && this.canPerformIdleAction(), changed: () => this.broadcast() })
    this.vroidActions = new VroidActionScheduler({ context: () => {
      let task: { id: VroidActionId; key: string; loop: boolean } | undefined
      const mode = this.taskMode
      if (mode === 'completed' || mode === 'failed') task = { id: mode === 'completed' ? 'clapping' : 'sad', key: `${mode}:${this.taskStartedAt}`, loop: false }
      else if (!['idle', 'cancelled'].includes(mode) || (this.conversationState !== null && !this.activeFloatingVoicePhase()) || (!this.isFloatingVoiceActive() && (this.state === 'thinking' || this.state === 'working'))) task = { id: 'thinking', key: `work:${this.taskStartedAt ?? ''}`, loop: true }
      else if (this.state === 'happy') task = { id: 'greeting', key: 'greeting', loop: false }
      else if (this.state === 'sleeping') task = { id: 'sleepy', key: 'sleeping', loop: true }
      else if (this.state === 'error') task = { id: 'sad', key: 'error', loop: false }
      const model = this.avatarModels.list().find(m => m.id === this.settings.avatarVariant)
      return {
        selected: isVrmAvatar(this.settings.avatarVariant) && (!model || model.importStatus === 'ready'),
        blocked: Boolean(this.flight || this.motion?.isDragging || this.voiceState || this.speechState || ['moving', 'speaking', 'listening'].includes(this.state) || mode === 'cancelled' || this.settings.doNotDisturb || this.settings.reducedMotion || systemPreferences.getAnimationSettings().prefersReducedMotion),
        random: (model?.animationSettings.random ?? this.settings.vroidRandomActions) && (this.windows.floating.isVisible() || this.windows.control.isVisible()),
        enabled: model?.enabledActions ?? this.settings.vroidEnabledActions, task,
      }
    }, changed: () => this.broadcast() })
    this.windows.control.on('show', () => this.broadcast())
    this.windows.control.on('hide', () => this.broadcast())
    this.windows.floating.on('show', () => { this.motion.start(); this.actions.reconcile(); this.broadcast() })
    this.windows.floating.on('hide', () => { this.actions.cancel(); this.motion.stop(); this.broadcast() })
    this.windows.floating.once('closed', () => this.actions.dispose())
    this.windows.panel.on('show', () => { this.actions.cancel(); this.motion.reconcile() })
    this.windows.panel.on('hide', () => { this.motion.restart(); this.actions.reconcile(); clearTimeout(this.panelTimer); this.broadcast() })
    this.windows.panel.on('show', () => this.broadcast())
    this.windows.shouldKeepPanelOpen = () => Boolean(this.voiceState || this.speechState || this.conversationState)
    this.registerShortcuts()
  }
  snapshot(): Snapshot {
    return {
      settings: this.settings, displays: getDisplays(), state: this.state, flight: this.flight, idleAction: this.actions?.current ?? null,
      taskVisual: this.taskVisualSnapshot(),
      vroidActions: this.vroidActions?.snapshot(),
      importedAvatars: this.avatarModels.list(),
      visible: !this.windows.floating.isDestroyed() && this.windows.floating.isVisible(), panelMode: this.panelMode,
      panelVisible: !this.windows.panel.isDestroyed() && this.windows.panel.isVisible(),
      handsFreeState: this.handsFreeState,
      floatingVoiceActive: Boolean(this.activeFloatingVoicePhase()),
      onBattery: powerMonitor.isOnBatteryPower(), reducedMotion: systemPreferences.getAnimationSettings().prefersReducedMotion,
      platform: process.platform, version: app.getVersion(), error: this.error,
    }
  }
  broadcast(): void {
    this.vroidActions?.reconcile()
    const snapshot = this.snapshot()
    for (const window of this.windows.all()) window.webContents.send(IPC.changed, snapshot)
    this.onChange?.()
  }
  behavior(event: BehaviorEvent): void {
    const active = this.voiceState ?? this.speechState ?? this.conversationState
    const next = event !== 'DRAG' && active ? active : transition(this.state, event)
    if (next === this.state) return
    this.state = next
    this.actions?.reconcile()
    this.broadcast()
    clearTimeout(this.reactionTimer)
    if (next === 'happy') this.reactionTimer = setTimeout(() => this.behavior('REST'), 1200)
  }
  setConversationState(phase: ChatPhase): void {
    if (phase !== 'idle' && !this.conversationState) this.taskOutcomeStatus = undefined
    this.conversationState = phase === 'idle' ? null : phase
    if (phase !== 'idle') this.beginTaskVisual('local-chat')
    else if (this.taskMode !== 'idle' && !this.taskCompletionTimer) this.setTaskOutcome(this.taskOutcomeStatus ?? 'complete')
    clearTimeout(this.reactionTimer)
    if (!this.motion.isDragging) this.state = phase !== 'idle' ? phase : this.voiceState ?? this.speechState ?? 'idle'
    // A flight was calculated using the character-sized window. Stop it before
    // expanding that window for the console. Working Mode owns movement until
    // its ending has finished; normal wandering then starts a fresh timer.
    if (phase !== 'idle' && this.flight) this.motion.pause()
    this.motion.reconcile()
    this.updateTaskWindow()
    this.refreshVoiceAnimation()
    this.actions.reconcile()
    this.broadcast()
  }
  /** Drop an obsolete local-chat visual lease without reporting task completion. */
  clearTaskOwner(): void {
    clearTimeout(this.taskStartTimer); this.taskStartTimer = undefined
    clearTimeout(this.taskCompletionTimer); this.taskCompletionTimer = undefined
    this.conversationState = null
    this.taskMode = 'idle'; this.taskActivityType = undefined; this.taskActivityLabel = undefined
    this.taskVisualSource = undefined
    this.taskStartedAt = undefined; this.taskOutcomeStatus = undefined
    if (!this.motion.isDragging) this.state = this.conversationState ?? this.voiceState ?? this.speechState ?? 'idle'
    this.motion.reconcile(); this.updateTaskWindow(); this.refreshVoiceAnimation(); this.actions.reconcile(); this.broadcast()
  }
  setVoiceState(state: 'listening' | 'thinking' | null): void {
    if (state === 'listening' && !this.voiceState && !this.conversationState) this.taskOutcomeStatus = undefined
    this.voiceState = state
    clearTimeout(this.reactionTimer)
    if (state) { this.actions.cancel(); this.motion.pause() }
    else if (!state && !this.conversationState && !this.speechState && this.taskMode !== 'idle' && !this.taskCompletionTimer) this.setTaskOutcome(this.taskOutcomeStatus ?? 'complete')
    if (!this.motion.isDragging) this.state = this.conversationState ?? state ?? this.speechState ?? 'idle'
    this.refreshVoiceAnimation()
    this.motion.reconcile(); this.updateTaskWindow(); this.actions.reconcile(); this.broadcast()
  }
  setSpeechState(phase: 'idle' | 'generating' | 'playing'): void {
    this.speechState = phase === 'playing' ? 'speaking' : phase === 'generating' ? 'working' : null
    clearTimeout(this.reactionTimer)
    if (this.speechState) { this.actions.cancel(); this.motion.pause() }
    if (this.speechState && !this.conversationState && !this.isFloatingVoiceActive()) this.beginTaskVisual('local-chat')
    else if (!this.speechState && !this.conversationState && this.taskMode !== 'idle' && !this.taskCompletionTimer) this.setTaskOutcome(this.taskOutcomeStatus ?? 'complete')
    if (!this.motion.isDragging) this.state = this.conversationState ?? this.voiceState ?? this.speechState ?? 'idle'
    this.refreshVoiceAnimation()
    this.motion.reconcile(); this.updateTaskWindow(); this.actions.reconcile(); this.broadcast()
  }
  setTaskActivity(snapshot: ChatSnapshot): void {
    if (snapshot.phase === 'idle' || !this.settings.taskActivityEnabled) return
    this.beginTaskVisual('local-chat')
    const { mode, type, label } = currentTaskActivity(snapshot)
    if (this.taskMode === mode && this.taskActivityType === type && this.taskActivityLabel === label) return
    clearTimeout(this.taskCompletionTimer); this.taskCompletionTimer = undefined
    this.taskMode = mode; this.taskActivityType = type; this.taskActivityLabel = label
    this.taskVisualSource = 'local-chat'
    if (!this.taskStartedAt) this.taskStartedAt = Date.now()
    this.updateTaskWindow(); this.refreshVoiceAnimation(); this.broadcast()
  }
  /** Shows the active local action on Floating Athena without subscribing to online chat events. */
  setAutomationActivity(tool: string, label: string): void {
    // The explicit hands-free lease owns voice-only presentation. Native
    // actions requested from a local chat stay in the chat hologram lane.
    if (this.isFloatingVoiceActive()) return
    if (!this.settings.taskActivityEnabled || (!this.voiceState && !this.conversationState)) return
    this.beginTaskVisual('local-chat')
    const mode = taskVisualModeForActivity(tool, label)
    this.taskActivityType = tool
    this.taskActivityLabel = label.slice(0, 160)
    this.taskVisualSource = 'local-chat'
    this.taskMode = mode
    if (!this.taskStartedAt) this.taskStartedAt = Date.now()
    this.updateTaskWindow(); this.refreshVoiceAnimation(); this.broadcast()
  }
  setTaskOutcome(status: string | undefined): void {
    this.taskOutcomeStatus = status ?? 'complete'
    // Speech may still be draining after the model finishes. Preserve the
    // actual outcome and display it once the last active source is idle.
    if (this.conversationState || this.speechState || this.voiceState) return
    // Short tasks never flash the console after they have already finished.
    if (this.taskStartTimer) {
      clearTimeout(this.taskStartTimer); this.taskStartTimer = undefined
      this.taskMode = 'idle'; this.taskActivityType = undefined; this.taskActivityLabel = undefined; this.taskVisualSource = undefined; this.taskStartedAt = undefined
      this.refreshVoiceAnimation()
      this.updateTaskWindow(); this.motion.reconcile(); this.actions.reconcile(); this.broadcast()
      return
    }
    // A late/duplicate taskEnded or voice event must not resurrect a finished
    // visual. A fresh request calls beginTaskVisual before its outcome.
    if (this.taskMode === 'idle') return
    const mode = taskVisualModeForStatus(status ?? 'complete')
    if (this.taskCompletionTimer && this.taskMode === mode) return
    this.taskMode = this.settings.taskActivityEnabled && this.settings.taskCompletionNotification ? mode : 'idle'
    this.actions.cancel()
    this.motion.reconcile()
    this.refreshVoiceAnimation()
    this.updateTaskWindow(); this.broadcast()
    // Corrections (e.g. the final error arriving after phase=idle) may change
    // the result, but never restart the ending or postpone the return to idle.
    if (this.taskMode !== 'idle' && !this.taskCompletionTimer) this.taskCompletionTimer = setTimeout(() => {
      // If the user allowed roaming during work, stop any in-flight journey
      // before shrinking the expanded task canvas back to the character.
      this.motion.pause()
      this.taskCompletionTimer = undefined; this.taskMode = 'idle'; this.taskActivityType = undefined; this.taskActivityLabel = undefined; this.taskVisualSource = undefined; this.taskStartedAt = undefined
      this.refreshVoiceAnimation()
      this.updateTaskWindow(); this.motion.reconcile(); this.actions.reconcile(); this.broadcast()
    }, 1900)
    else if (this.taskMode === 'idle') { clearTimeout(this.taskCompletionTimer); this.taskCompletionTimer = undefined; this.taskActivityType = undefined; this.taskActivityLabel = undefined; this.taskVisualSource = undefined; this.taskStartedAt = undefined; this.refreshVoiceAnimation(); this.motion.reconcile(); this.actions.reconcile() }
  }
  private beginTaskVisual(source: 'local-chat' | 'background' = 'local-chat'): void {
    clearTimeout(this.taskCompletionTimer); this.taskCompletionTimer = undefined
    if (!this.settings.taskActivityEnabled) return
    if (this.taskMode === 'idle' || ['completed', 'failed', 'cancelled'].includes(this.taskMode)) {
      this.taskVisualSource = source
      this.taskStartedAt = Date.now()
      this.taskMode = 'thinking'
      // Delay the presentation once per task, not again for every tool/phase.
      // The task itself and the roaming pause take effect immediately.
      this.taskStartTimer = setTimeout(() => {
        this.taskStartTimer = undefined
        this.updateTaskWindow(); this.broadcast()
      }, 500)
    }
  }
  private updateTaskWindow(): void {
    const active = this.settings.taskActivityEnabled && !this.taskStartTimer && (Boolean(this.conversationState || (this.speechState && !this.isFloatingVoiceActive())) || ['completed', 'failed', 'cancelled'].includes(this.taskMode))
    const hadTaskCanvas = Boolean(this.windows.getTaskAnchor())
    const anchor = this.windows.setTaskVisualMode(active, this.settings.taskActivityEnabled && this.settings.taskHologramsEnabled)
    if (!active) {
      this.currentTaskAnchor = undefined
      if (hadTaskCanvas) {
        const bounds = this.windows.floating.getBounds()
        this.settings = { ...this.settings, position: { x: bounds.x, y: bounds.y } }
        this.persistSoon()
      }
      return
    }
    this.currentTaskAnchor = anchor ?? this.windows.getTaskAnchor() ?? { x: this.settings.size / 2, y: this.settings.size / 2 }
  }
  private currentTaskAnchor?: { x: number; y: number }
  private taskVisualSnapshot(): TaskVisualSnapshot {
    const mode = this.settings.taskActivityEnabled && !this.taskStartTimer ? this.taskMode : 'idle'
    return { mode, ...(mode !== 'idle' && this.taskVisualSource ? { source: this.taskVisualSource } : {}), ...(mode !== 'idle' && this.taskActivityType ? { activityType: this.taskActivityType } : {}), ...(mode !== 'idle' && this.taskActivityLabel ? { label: this.taskActivityLabel } : {}), ...(mode !== 'idle' && this.taskStartedAt ? { startedAt: this.taskStartedAt } : {}), anchor: mode !== 'idle' ? this.currentTaskAnchor ?? { x: this.settings.size / 2, y: this.settings.size / 2 } : { x: this.settings.size / 2, y: this.settings.size / 2 } }
  }
  private isFloatingVoiceActive(): boolean {
    return isLocalOwnership(this.handsFreeState.ownership) && ['listening', 'processing', 'speaking', 'follow-up'].includes(this.handsFreeState.state)
  }
  private activeFloatingVoicePhase(): VroidVoicePhase | null {
    if (!this.isFloatingVoiceActive()) return null
    // A local-chat task owns the hologram and its existing animation lifecycle,
    // even if the floating voice service happens to be active at the same time.
    if (this.conversationState || (this.taskVisualSource === 'local-chat' && this.taskMode !== 'idle')) return null
    if (this.handsFreeState.state === 'listening' || this.handsFreeState.state === 'follow-up') return 'listening'
    if (this.handsFreeState.state === 'processing') {
      if (this.speechState === 'speaking' || this.vroidActions?.voiceSession?.phase === 'talking') return 'talking'
      return 'thinking'
    }
    if (this.handsFreeState.state === 'speaking') {
      if (this.speechState === 'speaking') return 'talking'
      return this.vroidActions?.voiceSession?.phase === 'thinking' ? 'thinking' : null
    }
    return null
  }
  private refreshVoiceAnimation(): void { this.vroidActions?.setVoicePhase(this.activeFloatingVoicePhase()) }
  setHandsFreeState(state: HandsFreeState): void {
    this.handsFreeState = state
    this.refreshVoiceAnimation()
    if (state.state === 'paused' && !this.settings.voiceInteraction.handsFreeEnabled && !this.conversationState && !this.speechState) {
      this.clearHandsFreeActivity(false)
      return
    }
    this.broadcast()
  }
  /** Clear hands-free ownership and visuals without interrupting regular local speech or chat tasks. */
  clearHandsFreeActivity(broadcast = true): void {
    this.voiceState = null
    this.handsFreeState = { state: 'paused' }
    this.vroidActions?.setVoicePhase(null)
    if (!this.conversationState && !this.speechState && this.taskVisualSource !== 'local-chat') {
      clearTimeout(this.taskStartTimer); this.taskStartTimer = undefined
      clearTimeout(this.taskCompletionTimer); this.taskCompletionTimer = undefined
      this.taskMode = 'idle'; this.taskActivityType = undefined; this.taskActivityLabel = undefined
      this.taskVisualSource = undefined
      this.taskStartedAt = undefined; this.taskOutcomeStatus = undefined
    }
    if (!this.motion.isDragging) this.state = this.conversationState ?? this.speechState ?? 'idle'
    this.motion.reconcile(); this.updateTaskWindow(); this.actions.reconcile()
    if (broadcast) this.broadcast()
  }
  updateSettings(input: unknown): Snapshot {
    const next = mergeSettings(this.settings, input)
    const previous = this.settings
    if (next.avatarVariant !== previous.avatarVariant && next.avatarVariant.startsWith('imported-') && this.avatarModels.get(next.avatarVariant).importStatus !== 'ready') throw new Error('This model is not ready to activate.')
    if (next.launchAtLogin !== previous.launchAtLogin) {
      if (!app.isPackaged) throw new Error('Launch at login is available after installing a packaged Athena app.')
      app.setLoginItemSettings({ openAtLogin: next.launchAtLogin })
    }
    if (next.shortcutOpen !== previous.shortcutOpen || next.shortcutToggle !== previous.shortcutToggle) this.registerShortcuts(next)
    this.repository.save(next)
    this.settings = next
    if (next.avatarVariant !== previous.avatarVariant) {
      this.vroidActions.reset()
      const model = this.avatarModels.list().find(m => m.id === next.avatarVariant)
      if (model?.importStatus === 'ready') this.vroidActions.register(model.compatibleAnimations)
    }
    this.onSettingsChange?.(previous, next)
    this.error = null
    const positionsChanged = next.enabledPositions.join() !== previous.enabledPositions.join()
    const actionsChanged = next.avatarVariant !== previous.avatarVariant || next.randomActions !== previous.randomActions || next.actionIntervalSeconds !== previous.actionIntervalSeconds || next.enabledActions.join() !== previous.enabledActions.join()
    const motionChanged = positionsChanged || (['randomMovement', 'wanderIntervalSeconds', 'pinned', 'floatingEnabled', 'size', 'movementSpeed', 'monitorMode', 'selectedDisplay', 'edgePadding', 'doNotDisturb', 'reducedMotion', 'pauseFloatingWhileWorking'] as const).some((key) => next[key] !== previous[key])
    if (motionChanged) this.motion.restart()
    if (next.size !== previous.size || next.alwaysOnTop !== previous.alwaysOnTop) this.windows.applySettings()
    if (next.floatingEnabled !== previous.floatingEnabled) this.windows.setFloatingVisible(next.floatingEnabled)
    if (next.monitorMode !== previous.monitorMode || next.selectedDisplay !== previous.selectedDisplay || next.edgePadding !== previous.edgePadding) this.motion.clamp()
    if (next.taskActivityEnabled !== previous.taskActivityEnabled || next.taskHologramsEnabled !== previous.taskHologramsEnabled || next.pauseFloatingWhileWorking !== previous.pauseFloatingWhileWorking || next.taskCompletionNotification !== previous.taskCompletionNotification) {
        if (!next.taskActivityEnabled || (!next.taskCompletionNotification && ['completed', 'failed', 'cancelled'].includes(this.taskMode))) {
          clearTimeout(this.taskStartTimer); this.taskStartTimer = undefined
          clearTimeout(this.taskCompletionTimer); this.taskCompletionTimer = undefined; this.taskMode = 'idle'; this.taskActivityType = undefined; this.taskActivityLabel = undefined; this.taskVisualSource = undefined; this.taskStartedAt = undefined
        this.refreshVoiceAnimation(); this.updateTaskWindow(); this.motion.reconcile(); this.actions.reconcile()
      }
      else {
          if (this.conversationState || (this.speechState && !this.isFloatingVoiceActive())) this.beginTaskVisual('local-chat')
        this.updateTaskWindow()
      }
    }
    if (actionsChanged || positionsChanged || next.size !== previous.size) this.actions.restart()
    else this.actions.reconcile()
    this.broadcast()
    return this.snapshot()
  }
  command(command: DesktopCommand): void {
    switch (command) {
      case 'show': this.updateSettings({ floatingEnabled: true }); this.windows.setFloatingVisible(true); break
      case 'hide': this.updateSettings({ floatingEnabled: false }); break
      case 'toggle': this.command(this.windows.floating.isVisible() ? 'hide' : 'show'); break
      case 'pin': this.updateSettings({ pinned: true }); break
      case 'unpin': this.updateSettings({ pinned: false }); break
      case 'open-control': this.windows.showControl('companion'); break
      case 'open-chat': this.windows.showControl('conversation'); break
      case 'open-settings': this.windows.showControl('general'); break
      case 'open-panel':
      case 'open-menu':
        this.panelMode = command === 'open-menu' ? 'menu' : 'chat'
        this.motion.pause()
        this.behavior('ACKNOWLEDGE')
        this.broadcast()
        this.windows.showPanel()
        clearTimeout(this.panelTimer)
        this.panelTimer = setTimeout(() => { if (!this.windows.panel.isFocused() && !this.windows.shouldKeepPanelOpen?.()) this.windows.panel.hide() }, 45_000)
        break
      case 'close-panel': this.windows.panel.hide(); break
      case 'close-chat': this.windows.closeChat(); break
      case 'next-monitor': this.motion.pause(); this.windows.nextMonitor(); this.settings = { ...this.settings, position: { x: this.windows.floating.getBounds().x, y: this.windows.floating.getBounds().y } }; this.persistSoon(); this.broadcast(); break
      case 'quit': app.quit(); break
    }
    log('desktop.command', { command })
  }
  private registerShortcuts(settings = this.settings): void {
    globalShortcut.unregisterAll()
    try {
      const open = globalShortcut.register(settings.shortcutOpen, () => this.windows.showControl())
      const toggle = globalShortcut.register(settings.shortcutToggle, () => this.command('toggle'))
      if (!open || !toggle) throw new Error('A shortcut is already in use. Choose another combination.')
    } catch (error) {
      globalShortcut.unregisterAll()
      if (settings !== this.settings) { this.registerShortcuts(this.settings); throw error }
      this.error = 'A global shortcut is unavailable. Athena is still accessible from the tray.'
      log('shortcuts.registration_failed')
    }
  }
  private canPerformIdleAction(): boolean {
    if (this.settings.taskActivityEnabled && this.taskMode !== 'idle') return false
    if (this.voiceState || this.speechState || this.conversationState || !this.motion.availableForIdle || this.flight || this.state !== 'idle' || !this.settings.floatingEnabled || this.windows.panel.isVisible()) return false
    if (this.settings.doNotDisturb || this.settings.reducedMotion || systemPreferences.getAnimationSettings().prefersReducedMotion) return false
    const bounds = this.windows.floating.getBounds()
    const positions = fixedPositions(currentArea(this.windows.floating), bounds, this.settings.edgePadding)
    return this.settings.enabledPositions.some((id) => Math.hypot(bounds.x - positions[id].x, bounds.y - positions[id].y) <= 2)
  }
  private persistSoon(): void {
    clearTimeout(this.persistTimer)
    this.persistTimer = setTimeout(() => this.flush(), 400)
  }
  flush(): void {
    clearTimeout(this.persistTimer)
    try { this.repository.save(this.settings) }
    catch { this.error = 'Settings could not be saved. Check available disk space and permissions.'; this.broadcast(); log('settings.save_failed') }
  }
  dispose(): void {
    this.windows.quitting = true
    this.actions.dispose()
    this.vroidActions.dispose()
    this.motion.stop()
    clearTimeout(this.reactionTimer)
    clearTimeout(this.taskStartTimer)
    clearTimeout(this.taskCompletionTimer)
    clearTimeout(this.panelTimer)
    this.flush()
    globalShortcut.unregisterAll()
  }
}
