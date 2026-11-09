import { z } from 'zod'
import { WANDER_POSITIONS } from './flight'
import { IDLE_ACTIONS } from './idleActions'
import { VROID_ACTION_IDS, VROID_RANDOM_IDS } from './vroidActions'
import { avatarIdSchema } from './avatarModels'
import { generationSettingsSchema, generationDefaults } from './generation'
import { DEFAULT_SPEECH_VOICE, MAX_SPEECH_SPEED, MIN_SPEECH_SPEED, speechVoiceSchema } from './speech'
import { localAISettingsSchema, localAIDefaults, localAIPresets, localInferenceDefaults } from './localAI'
import { localVoiceSettingsSchema, defaultLocalVoiceSettings } from './localVoice'
import { voiceInteractionSettingsSchema, voiceInteractionDefaults } from './handsFree'
import { webAccessDefaults, webAccessSettingsSchema } from './webAccess'
import { subagentDefaults, subagentSettingsSchema } from './subagents'
import { automationPermissionDefaults, automationPermissionsSchema } from './automation'

export const SIZE = { min: 80, max: 400, default: 180 } as const
export const DEFAULT_WANDER_INTERVAL_SECONDS = 30
export const DEFAULT_ACTION_INTERVAL_SECONDS = 30
export const MIN_WANDER_INTERVAL = 10
export const MAX_WANDER_INTERVAL = 300
export const MIN_MOVEMENT_SPEED = 0.5
export const MAX_MOVEMENT_SPEED = 10
export const pointSchema = z.object({ x: z.number().finite(), y: z.number().finite() }).strict()
export const settingsSchema = z.object({
  version: z.literal(1).default(1),
  aiGeneration: generationSettingsSchema.default(generationDefaults),
  subagents: subagentSettingsSchema.default(subagentDefaults),
  backgroundTasks: z.object({ enabled: z.boolean().default(true), maxConcurrent: z.number().int().min(1).max(6).default(3), notifyComplete: z.boolean().default(true), notifyFailed: z.boolean().default(true), badge: z.boolean().default(true), nativeNotifications: z.boolean().default(true) }).default({ enabled: true, maxConcurrent: 3, notifyComplete: true, notifyFailed: true, badge: true, nativeNotifications: true }),
  notificationPreferences: z.object({ approvals: z.boolean().default(true), approvalBadges: z.boolean().default(true), sound: z.boolean().default(false), preview: z.boolean().default(true), suppressDuringDnd: z.boolean().default(true) }).default({ approvals: true, approvalBadges: true, sound: false, preview: true, suppressDuringDnd: true }),
  // Online conversation selection only. 'local' is read solely for migration
  // and internal local tool context; it is never an online provider choice.
  aiMode: z.enum(['cloud', 'local', 'unconfigured', 'subscription', 'claude-api', 'cursor', 'copilot']).default('cloud'),
  // Migration marker: unknown legacy history must not be silently sent online.
  reviewLegacyLocalHistory: z.boolean().default(false),
  // Explicitly opts project conversations into the installed Codex CLI harness.
  // General, unscoped ChatGPT conversations continue to use Athena's provider.
  chatGPTCodingBackend: z.enum(['athena', 'codex-cli']).default('athena'),
  strictOffline: z.boolean().default(false),
  webAccess: webAccessSettingsSchema.default(webAccessDefaults),
  automationPermissions: automationPermissionsSchema.default(automationPermissionDefaults),
  localAI: localAISettingsSchema.default(localAIDefaults),
  athenaChatAvatarLinked: z.boolean().default(true),
  voiceEnabled: z.boolean().default(true),
  localVoice: localVoiceSettingsSchema.default(defaultLocalVoiceSettings),
  voiceAutoSend: z.boolean().default(false),
  voiceInteraction: voiceInteractionSettingsSchema.default(voiceInteractionDefaults),
  showFloatingBubble: z.boolean().default(true),
  showFloatingTaskStatus: z.boolean().default(true),
  showFloatingProject: z.boolean().default(true),
  taskActivityEnabled: z.boolean().default(true),
  taskHologramsEnabled: z.boolean().default(true),
  taskDetailedHolograms: z.boolean().default(false),
  taskAnimationIntensity: z.number().min(0).max(1).default(0.65),
  taskCompletionNotification: z.boolean().default(true),
  pauseFloatingWhileWorking: z.boolean().default(true),
  voiceMuted: z.boolean().default(false),
  voiceName: speechVoiceSchema.default(DEFAULT_SPEECH_VOICE),
  voiceSpeed: z.number().finite().min(MIN_SPEECH_SPEED).max(MAX_SPEECH_SPEED).default(1),
  voiceVolume: z.number().finite().min(0).max(1).default(0.8),
  size: z.number().int().min(SIZE.min).max(SIZE.max).default(SIZE.default),
  avatarVariant: avatarIdSchema.default('vroid-athena'),
  avatarEnergyFX: z.boolean().default(true),
  vroidRandomActions: z.boolean().default(true),
  vroidEnabledActions: z.array(z.enum(VROID_ACTION_IDS)).max(20).refine(values => new Set(values).size === values.length).default([...VROID_RANDOM_IDS]),
  floatingEnabled: z.boolean().default(true),
  randomMovement: z.boolean().default(true),
  enabledPositions: z.array(z.enum(WANDER_POSITIONS)).min(1).max(6).refine((values) => new Set(values).size === values.length).default([...WANDER_POSITIONS]),
  randomActions: z.boolean().default(true),
  actionIntervalSeconds: z.number().int().min(10).max(300).default(DEFAULT_ACTION_INTERVAL_SECONDS),
  enabledActions: z.array(z.enum(IDLE_ACTIONS)).max(IDLE_ACTIONS.length).refine((values) => new Set(values).size === values.length).default([...IDLE_ACTIONS]),
  wanderIntervalSeconds: z.number().int().min(MIN_WANDER_INTERVAL).max(MAX_WANDER_INTERVAL).default(DEFAULT_WANDER_INTERVAL_SECONDS),
  pinned: z.boolean().default(false),
  alwaysOnTop: z.boolean().default(true),
  hoverAnimation: z.boolean().default(true),
  // Legacy fields remain readable; only wanderIntervalSeconds controls wait timing.
  movementFrequency: z.enum(['low', 'normal', 'high']).default('normal'),
  movementSpeed: z.number().min(MIN_MOVEMENT_SPEED).max(MAX_MOVEMENT_SPEED).default(1),
  resumeDelay: z.number().int().min(5).max(120).default(30),
  edgePadding: z.number().int().min(0).max(80).default(24),
  monitorMode: z.enum(['current', 'primary', 'selected', 'any']).default('current'),
  selectedDisplay: z.number().int().nullable().default(null),
  crossMonitor: z.boolean().default(false),
  position: pointSchema.nullable().default(null),
  glowIntensity: z.number().min(0).max(2).default(1),
  particleIntensity: z.number().min(0).max(1).default(0.5),
  animationIntensity: z.number().min(0).max(1).default(0.65),
  renderQuality: z.enum(['performance', 'balanced', 'quality']).default('balanced'),
  uiScale: z.number().min(0.85).max(1.2).default(1),
  launchAtLogin: z.boolean().default(false),
  startHidden: z.boolean().default(false),
  minimizeToTray: z.boolean().default(true),
  reduceOnBattery: z.boolean().default(true),
  doNotDisturb: z.boolean().default(false),
  reducedMotion: z.boolean().default(false),
  shortcutOpen: z.string().min(3).max(70).default('CommandOrControl+Shift+Space'),
  shortcutToggle: z.string().min(3).max(70).default('CommandOrControl+Shift+H'),
}).strict()

export type Settings = z.infer<typeof settingsSchema>
// Window coordinates and schema version are main-process owned.
const writableFields = settingsSchema.omit({ version: true, position: true, reviewLegacyLocalHistory: true }).shape
// Zod 4 applies nested defaults even in a partial object. Strip them so a one-field
// update cannot silently reset unrelated preferences.
const patchFields = Object.fromEntries(Object.entries(writableFields).map(([key, schema]) => [key, schema.removeDefault()])) as {
  [Key in keyof typeof writableFields]: ReturnType<(typeof writableFields)[Key]['removeDefault']>
}
export const settingsPatchSchema = z.object(patchFields).partial().strict()
export type SettingsPatch = z.infer<typeof settingsPatchSchema>
export const defaultSettings = settingsSchema.parse({})

export function restoreSettings(input: unknown): Settings {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ...defaultSettings }
  const raw = input as Record<string, unknown>
  if (raw.version !== undefined && raw.version !== 1) return { ...defaultSettings }
  const restored = { ...defaultSettings }
  for (const key of Object.keys(defaultSettings) as (keyof Settings)[]) {
    const parsed = settingsSchema.shape[key].safeParse(raw[key])
    if (parsed.success) Object.assign(restored, { [key]: parsed.data })
  }
  // Profiles created before local inference presets existed have the raw
  // inference controls but no preset marker. Preserve those user choices as
  // an independent Custom preset instead of presenting them as Balanced.
  // A legacy profile that contains no inference controls is still treated as
  // a new/default profile and keeps the Balanced preset.
  const rawLocal = raw.localAI
  if (rawLocal && typeof rawLocal === 'object' && !Array.isArray(rawLocal)) {
    const localRecord = rawLocal as Record<string, unknown>
    const inferenceKeys = ['reasoning', 'contextLength', 'maxOutputTokens', 'temperature', 'keepAliveMinutes', 'autoUnload']
    const local = restored.localAI
    const hasLegacyControls = !('preset' in localRecord) && inferenceKeys.some((key) => key in localRecord)
    // A short-lived schema migration could have persisted the default
    // Balanced marker alongside older, non-Balanced values. Recognize that
    // shape as legacy too, but leave explicitly selected/clamped presets
    // untouched.
    const balancedDefaults = localAIPresets.balanced
    const customDefaults = localInferenceDefaults()
    const looksLikePersistedLegacyBalanced = localRecord.preset === 'balanced'
      && JSON.stringify(local.customInference) === JSON.stringify(customDefaults)
      && Object.entries(balancedDefaults).some(([key, value]) => local[key as keyof typeof local] !== value)
    if (hasLegacyControls || looksLikePersistedLegacyBalanced) {
      restored.localAI = {
        ...local,
        preset: 'custom',
        customInference: {
          reasoning: local.reasoning,
          contextLength: local.contextLength,
          maxOutputTokens: local.maxOutputTokens,
          temperature: local.temperature,
          keepAliveMinutes: local.keepAliveMinutes,
          autoUnload: local.autoUnload,
        },
      }
    }
  }
  if (typeof raw.wanderIntervalSeconds === 'number' && Number.isFinite(raw.wanderIntervalSeconds)) {
    restored.wanderIntervalSeconds = Math.max(MIN_WANDER_INTERVAL, Math.min(MAX_WANDER_INTERVAL, Math.round(raw.wanderIntervalSeconds)))
  }
  if (typeof raw.movementSpeed === 'number' && Number.isFinite(raw.movementSpeed)) {
    restored.movementSpeed = Math.max(MIN_MOVEMENT_SPEED, Math.min(MAX_MOVEMENT_SPEED, raw.movementSpeed))
  }
  if (typeof raw.actionIntervalSeconds === 'number' && Number.isFinite(raw.actionIntervalSeconds)) {
    restored.actionIntervalSeconds = Math.max(10, Math.min(300, Math.round(raw.actionIntervalSeconds)))
  }
  // The local companion's offline preference survives online provider changes.
  if (restored.aiMode === 'local') { restored.aiMode = 'unconfigured'; restored.reviewLegacyLocalHistory = true }
  // Each runtime applies it only to its own network-capable tools.
  // Noise suppression is a fixed part of the hands-free capture pipeline.
  // Normalize legacy settings that exposed an on/off switch.
  restored.voiceInteraction = { ...restored.voiceInteraction, noiseSuppression: true }
  return restored
}

export function mergeSettings(current: Settings, input: unknown): Settings {
  const patch = settingsPatchSchema.parse(input)
  const next = { ...current, ...patch }
  if (next.aiMode === 'local') { next.aiMode = 'unconfigured'; next.reviewLegacyLocalHistory = true }
  // Retain the legacy field for compatibility, but do not allow it to disable
  // the always-on microphone noise suppression pipeline.
  next.voiceInteraction = { ...next.voiceInteraction, noiseSuppression: true }
  return settingsSchema.parse(next)
}
