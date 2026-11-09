import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AthenaController } from '../electron/main/athenaController'
import { defaultSettings } from '../shared/settings'
import type { SettingsRepository } from '../electron/main/settingsRepository'
import { emptyChatSnapshot } from '../shared/chat'

const motionHooks = vi.hoisted(() => ({ current: null as null | { taskActive(): boolean; pauseForTask(): boolean } }))
const imported = vi.hoisted(() => ({ models: [] as import('../shared/avatarModels').ImportedAvatar[] }))
vi.mock('../electron/main/avatarModelRepository', () => ({ AvatarModelRepository: class {
  list() { return imported.models }
  get(id: string) { const model = imported.models.find(m => m.id === id); if (!model) throw new Error('Unknown model'); return model }
} }))

vi.mock('electron', () => ({ app: { getVersion: () => 'test', getPath: () => '/unused-test-profile' }, globalShortcut: { register: () => true, unregisterAll: () => {} }, powerMonitor: { isOnBatteryPower: () => false }, systemPreferences: { getAnimationSettings: () => ({ prefersReducedMotion: false }) } }))
vi.mock('../electron/main/screenManager', () => ({ getDisplays: () => [], currentArea: () => ({ x: 0, y: 0, width: 1000, height: 800 }) }))
vi.mock('../electron/main/windowManager', () => ({ WindowManager: class {
  anchor?: { x: number; y: number }
  floating = { on: vi.fn(), once: vi.fn(), isDestroyed: () => false, isVisible: () => true, getBounds: () => ({ x: 0, y: 0, width: 120, height: 120 }) }
  panel = { on: vi.fn(), isVisible: () => false, isDestroyed: () => false }
  control = { on: vi.fn(), isVisible: () => true, isDestroyed: () => false }
  create() {} all() { return [] } getTaskAnchor() { return this.anchor }
  setTaskVisualMode(active: boolean, enabled: boolean) { return this.anchor = active && enabled ? { x: 200, y: 150 } : undefined }
} }))
vi.mock('../electron/main/motionController', () => ({ MotionController: class {
  constructor(_window: unknown, hooks: NonNullable<typeof motionHooks.current>) { motionHooks.current = hooks }
  isDragging = false; availableForIdle = true
  reconcile = vi.fn(); pause = vi.fn(); restart = vi.fn(); stop = vi.fn()
} }))
vi.mock('../electron/main/idleActionController', () => ({ IdleActionController: class {
  current = null
  cancel = vi.fn(); reconcile = vi.fn(); dispose = vi.fn(); restart = vi.fn()
} }))
let controller: AthenaController
beforeEach(() => {
  imported.models = []
  vi.useFakeTimers()
  controller = new AthenaController({ load: () => structuredClone(defaultSettings), save: vi.fn() } as unknown as SettingsRepository)
})
it('synchronizes imported identity, independent action preferences and resets the old model clock', () => {
  const id = 'imported-00000000-0000-4000-8000-000000000001'
  imported.models = [{ id, name: 'Luna', importStatus: 'ready', enabledActions: ['bow'], animationSettings: { random: true, idleMs: 3000 }, compatibleAnimations: [{ id: 'idle', duration: 4 }, { id: 'bow', duration: 2 }] } as import('../shared/avatarModels').ImportedAvatar]
  const original = controller.settings.vroidEnabledActions
  controller.updateSettings({ avatarVariant: id })
  expect(controller.snapshot().settings.avatarVariant).toBe(id)
  expect(controller.snapshot().importedAvatars?.[0].name).toBe('Luna')
  expect(controller.snapshot().vroidActions?.session?.action).toBe('idle')
  vi.advanceTimersByTime(3220)
  expect(controller.snapshot().vroidActions?.session?.action).toBe('bow')
  expect(controller.settings.vroidEnabledActions).toEqual(original)
  controller.updateSettings({ avatarVariant: 'classic' })
  expect(controller.snapshot().vroidActions?.session).toBeNull()
  imported.models[0].importStatus = 'processing'
  expect(() => controller.updateSettings({ avatarVariant: id })).toThrow(/not ready/)
  expect(controller.settings.avatarVariant).toBe('classic')
})
afterEach(() => { controller.dispose(); vi.useRealTimers() })
function startTask() {
  controller.setConversationState('thinking')
  vi.advanceTimersByTime(500)
}

it('publishes one VRoid session to both windows and isolates robot action preferences', () => {
  controller.updateSettings({ avatarVariant: 'vroid-athena' })
  controller.vroidActions.register([{ id: 'idle', duration: 5 }, { id: 'bow', duration: 2 }, { id: 'thinking', duration: 3 }, { id: 'clapping', duration: 2 }])
  const previous = controller.settings.enabledActions
  controller.updateSettings({ vroidEnabledActions: ['bow'] })
  expect(controller.settings.enabledActions).toEqual(previous)
  vi.advanceTimersByTime(3220)
  expect(controller.snapshot().vroidActions?.session?.action).toBe('bow')
  expect(controller.snapshot().vroidActions?.session).toBe(controller.vroidActions.session)
  startTask()
  expect(controller.snapshot().vroidActions?.session?.action).toBe('thinking')
  controller.setConversationState('idle')
  controller.setTaskOutcome('complete')
  expect(controller.snapshot().vroidActions?.session?.action).toBe('clapping')
  vi.advanceTimersByTime(2000)
  expect(controller.snapshot().vroidActions?.session?.action).toBe('idle')
  controller.updateSettings({ avatarVariant: 'classic' })
  expect(controller.snapshot().vroidActions?.session).toBeNull()
})

it('retains active operation across phase changes, exits after completion, and clears the canvas', () => {
  startTask()
  const snapshot = emptyChatSnapshot(); snapshot.phase = 'thinking'
  snapshot.messages = [{ id: 'run', role: 'assistant', status: 'streaming', content: '', createdAt: 0, execution: { status: 'working', startedAt: 0, updatedAt: 0, activities: [{ id: 'op', tool: 'run_tests', label: 'Running tests', startedAt: 0, status: 'running' }] } }]
  controller.setTaskActivity(snapshot)
  controller.setConversationState('speaking')
  expect(controller.snapshot().taskVisual?.mode).toBe('terminal')
  controller.setConversationState('idle')
  controller.setTaskOutcome('complete')
  expect(controller.snapshot().taskVisual?.mode).toBe('completed')
  vi.advanceTimersByTime(1900)
  expect(controller.snapshot().taskVisual?.mode).toBe('idle')
  expect(controller.windows.getTaskAnchor()).toBeUndefined()
})
it('defers failure notification until speech ends and never turns it into success', () => {
  startTask()
  controller.setSpeechState('playing')
  controller.setConversationState('idle')
  controller.setTaskOutcome('error')
  expect(controller.snapshot().taskVisual?.mode).toBe('thinking')
  vi.advanceTimersByTime(5000)
  controller.setSpeechState('idle')
  expect(controller.snapshot().taskVisual?.mode).toBe('failed')
})
it('a new task cancels the old exit timer and a cancelled task has a neutral outcome', () => {
  startTask()
  controller.setConversationState('idle')
  controller.setTaskOutcome('stopped')
  expect(controller.snapshot().taskVisual?.mode).toBe('cancelled')
  vi.advanceTimersByTime(1000)
  controller.setConversationState('thinking')
  vi.advanceTimersByTime(2000)
  expect(controller.snapshot().taskVisual?.mode).toBe('thinking')
})
it('honors disabling visuals during work and reenabling them without restarting the task', () => {
  startTask()
  controller.updateSettings({ taskActivityEnabled: false })
  const snapshot = emptyChatSnapshot(); snapshot.phase = 'thinking'
  controller.setTaskActivity(snapshot)
  expect(controller.snapshot().taskVisual?.mode).toBe('idle')
  expect(controller.windows.getTaskAnchor()).toBeUndefined()
  controller.updateSettings({ taskActivityEnabled: true })
  vi.advanceTimersByTime(500)
  expect(controller.snapshot().taskVisual?.mode).toBe('thinking')
})

it('keeps direct floating voice errors out of the chat hologram task lane', () => {
  controller.updateSettings({ avatarVariant: 'vroid-athena' })
  controller.vroidActions.register([{ id: 'idle', duration: 5 }, { id: 'thinking', duration: 3 }])
  const ownership = { origin: 'athena-local' as const, sessionId: '00000000-0000-4000-8000-000000000001', correlationId: '00000000-0000-4000-8000-000000000002' }
  controller.setHandsFreeState({ state: 'processing', ownership })
  controller.setVoiceState('thinking')
  expect(controller.snapshot().floatingVoiceActive).toBe(true)
  expect(controller.snapshot().vroidActions?.voiceSession?.phase).toBe('thinking')
  expect(controller.snapshot().taskVisual?.mode).toBe('idle')
  controller.setHandsFreeState({ state: 'error', ownership })
  controller.setVoiceState(null)
  expect(controller.snapshot().floatingVoiceActive).toBe(false)
  expect(controller.snapshot().vroidActions?.voiceSession).toBeNull()
  expect(controller.snapshot().taskVisual?.mode).toBe('idle')
})

it('prioritizes local chat holograms over simultaneous floating voice events', () => {
  controller.updateSettings({ avatarVariant: 'vroid-athena' })
  controller.vroidActions.register([{ id: 'idle', duration: 5 }, { id: 'thinking', duration: 3 }])
  const ownership = { origin: 'athena-local' as const, sessionId: '00000000-0000-4000-8000-000000000003', correlationId: '00000000-0000-4000-8000-000000000004' }
  controller.setConversationState('thinking')
  controller.setHandsFreeState({ state: 'processing', ownership })
  controller.setVoiceState('thinking')
  vi.advanceTimersByTime(500)
  expect(controller.snapshot().taskVisual?.source).toBe('local-chat')
  expect(controller.snapshot().taskVisual?.mode).toBe('thinking')
  expect(controller.snapshot().vroidActions?.voiceSession).toBeNull()
  expect(controller.snapshot().vroidActions?.session?.source).toBe('task')
  expect(controller.snapshot().floatingVoiceActive).toBe(false)
  expect(controller.state).toBe('thinking')
})

it('does not infer floating voice mode from ordinary local chat speech playback', () => {
  controller.updateSettings({ avatarVariant: 'vroid-athena' })
  controller.vroidActions.register([{ id: 'idle', duration: 5 }, { id: 'thinking', duration: 3 }])
  controller.setSpeechState('playing')
  vi.advanceTimersByTime(500)
  expect(controller.snapshot().vroidActions?.voiceSession).toBeNull()
  expect(controller.snapshot().floatingVoiceActive).toBe(false)
  expect(controller.snapshot().taskVisual?.source).toBe('local-chat')
  expect(controller.snapshot().vroidActions?.session?.source).toBe('task')
})

it('holds position throughout cinematic work and releases the movement gate after the ending', () => {
  controller.updateSettings({ pauseFloatingWhileWorking: false })
  controller.setConversationState('thinking')
  expect(motionHooks.current!.taskActive()).toBe(true)
  expect(motionHooks.current!.pauseForTask()).toBe(true)
  vi.advanceTimersByTime(500)
  controller.setConversationState('idle')
  expect(motionHooks.current!.pauseForTask()).toBe(true)
  vi.advanceTimersByTime(1900)
  expect(motionHooks.current!.taskActive()).toBe(false)
  expect(motionHooks.current!.pauseForTask()).toBe(false)
})

it('finishes once when chat and voice deliver duplicate or late completion notifications', () => {
  startTask()
  controller.setConversationState('idle')
  vi.advanceTimersByTime(1400)
  controller.setTaskOutcome('complete')
  vi.advanceTimersByTime(500)
  expect(controller.snapshot().taskVisual?.mode).toBe('idle')
  controller.setTaskOutcome('complete')
  controller.setSpeechState('idle')
  controller.setConversationState('idle')
  expect(controller.snapshot().taskVisual?.mode).toBe('idle')
  expect(controller.windows.getTaskAnchor()).toBeUndefined()
  startTask()
  controller.setConversationState('idle')
  expect(controller.snapshot().taskVisual?.mode).toBe('completed')
})

it('updates a corrected outcome without replaying or extending the ending', () => {
  startTask()
  controller.setConversationState('idle')
  vi.advanceTimersByTime(1400)
  controller.setTaskOutcome('error')
  expect(controller.snapshot().taskVisual?.mode).toBe('failed')
  vi.advanceTimersByTime(500)
  expect(controller.snapshot().taskVisual?.mode).toBe('idle')
  expect(controller.windows.getTaskAnchor()).toBeUndefined()
})

it('delays the console once while continuing the task and retaining the latest activity', () => {
  controller.setConversationState('thinking')
  expect(controller.state).toBe('thinking')
  expect(motionHooks.current!.pauseForTask()).toBe(true)
  expect(controller.snapshot().taskVisual?.mode).toBe('idle')
  expect(controller.windows.getTaskAnchor()).toBeUndefined()
  vi.advanceTimersByTime(300)
  const snapshot = emptyChatSnapshot(); snapshot.phase = 'thinking'
  snapshot.messages = [{ id: 'run', role: 'assistant', status: 'streaming', content: '', createdAt: 0, execution: { status: 'working', startedAt: 0, updatedAt: 0, activities: [{ id: 'op', tool: 'read_file', label: 'Reading the plan', startedAt: 0, status: 'running' }] } }]
  controller.setTaskActivity(snapshot)
  controller.setConversationState('speaking')
  vi.advanceTimersByTime(199)
  expect(controller.snapshot().taskVisual?.mode).toBe('idle')
  vi.advanceTimersByTime(1)
  expect(controller.snapshot().taskVisual?.mode).toBe('reading')
  expect(controller.windows.getTaskAnchor()).toBeDefined()
})

it.each(['complete', 'stopped', 'error'])('does not start a delayed animation after a short task ends: %s', status => {
  controller.setConversationState('thinking')
  vi.advanceTimersByTime(250)
  controller.setConversationState('idle')
  controller.setTaskOutcome(status)
  vi.advanceTimersByTime(2500)
  expect(controller.snapshot().taskVisual?.mode).toBe('idle')
  expect(controller.windows.getTaskAnchor()).toBeUndefined()
})
