import { z } from 'zod'

export const ATHENA_PERMISSIONS = ['microphone', 'screenCapture', 'applicationDetection', 'desktopAutomation', 'accessibilityControl', 'personalFiles', 'browserAutomation'] as const
export const permissionSchema = z.enum(ATHENA_PERMISSIONS)
export type AthenaPermission = z.infer<typeof permissionSchema>
export type PermissionStatus = 'not-requested' | 'allowed' | 'denied' | 'restricted' | 'unavailable'
export type OSPermissionStatus = PermissionStatus | 'not-required'
export const permissionInputSchema = z.object({ permission: permissionSchema }).strict()
export const permissionPreferenceSchema = permissionInputSchema.extend({ enabled: z.boolean() }).strict()
export type PermissionPreferences = Record<AthenaPermission, boolean>
export const filesystemAccessSchema = z.enum(['project-only', 'full-read-only', 'full-read-write'])
export type FilesystemAccessMode = z.infer<typeof filesystemAccessSchema>
export interface FilesystemAccessStatus { mode: FilesystemAccessMode; active: boolean; provider: string | null }
export const emptyPermissionPreferences = (): PermissionPreferences => ({ microphone: false, screenCapture: false, applicationDetection: false, desktopAutomation: false, accessibilityControl: false, personalFiles: false, browserAutomation: false })

export interface PermissionInfo {
  permission: AthenaPermission
  enabled: boolean
  status: PermissionStatus
  osStatus: OSPermissionStatus
  capabilityAllowed: boolean
  canRequest: boolean
  canOpenSettings: boolean
  detail: string
}
// Only host-created, unambiguous operations are eligible. No shell, deletion,
// credentials, screen sharing, Git mutation, or generic provider approvals.
export const rememberedSandboxCommandSchema = z.object({
  tool: z.enum(['cursor-terminal', 'execute_command', 'run_tests', 'run_lint', 'run_typecheck', 'run_format_check']),
  manager: z.enum(['npm', 'pnpm', 'yarn']),
  executable: z.string().min(1).max(4096),
  executableIdentity: z.string().min(1).max(200),
  args: z.array(z.string().max(1000)).min(1).max(40),
  packageHash: z.string().regex(/^[a-f0-9]{64}$/),
  sandbox: z.literal('project-offline-no-source-or-dependency-writes-v1'),
}).strict()
export const rememberedScopeSchema = z.object({
  operation: z.enum(['sandbox_check_command', 'create_file', 'write_file', 'edit_file', 'apply_patch', 'create_directory', 'cursor_read', 'open_application', 'focus_application', 'open_url']),
  project: z.string().min(1).max(4096),
  projectIdentity: z.string().regex(/^[0-9]+:[0-9]+:[0-9.]+$/).optional(),
  resources: z.array(z.string().min(1).max(4096)).min(1).max(30),
  command: rememberedSandboxCommandSchema.optional(),
}).strict()
export type RememberedScope = z.infer<typeof rememberedScopeSchema>
export const rememberedRuleSchema = z.object({ id: z.string().uuid(), scope: rememberedScopeSchema, grantedAt: z.number().int().positive(), revokedAt: z.number().int().positive().optional() }).strict()
export type RememberedRule = z.infer<typeof rememberedRuleSchema>
export const rememberedStateSchema = z.object({ enabled: z.boolean(), rules: z.array(rememberedRuleSchema).max(2000) }).strict()
export type RememberedState = z.infer<typeof rememberedStateSchema>
export const rememberedCommandSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('enable'), enabled: z.boolean() }).strict(),
  z.object({ action: z.literal('revoke'), id: z.string().uuid() }).strict(),
  z.object({ action: z.literal('revoke-all') }).strict(),
])
export type RememberedCommand = z.infer<typeof rememberedCommandSchema>
export interface PermissionSnapshot { permissions: PermissionInfo[]; filesystemAccess?: FilesystemAccessStatus; remembered?: RememberedState }
export interface PermissionResult { ok: boolean; snapshot: PermissionSnapshot; message: string }
export const PERMISSION_LABELS: Record<AthenaPermission, string> = {
  microphone: 'Microphone Access', screenCapture: 'Screen Capture & Awareness', applicationDetection: 'Application Detection', desktopAutomation: 'Desktop Automation', accessibilityControl: 'Accessibility UI Control', personalFiles: 'Personal File Access', browserAutomation: 'Local Browser Verification',
}
export const PERMISSION_DESCRIPTIONS: Record<AthenaPermission, string> = {
  microphone: 'Allow manual voice dictation in chat and hands-free Athena after explicit opt-in. Hands-free wake detection and recognition stay on this Mac; passive audio is never uploaded or saved. Manual chat dictation uses the transcription service selected in Settings.',
  screenCapture: 'Allow one-shot screenshots for questions about your screen. Each request asks before capturing all connected displays and sending images to OpenAI. No background recording; images are not saved locally. Hide sensitive content before approving.',
  applicationDetection: 'Allow Athena to identify the active app and list running apps for relevant conversation requests or when you check here. Names are read on demand; Athena does not continuously watch your apps.',
  desktopAutomation: 'Allow opening and switching supported apps, approved web URLs, and Athena notifications. Ask Before Changes previews actions; Read Only blocks them. Web addresses require approval unless an exact, active remembered permission matches.',
  accessibilityControl: 'Allow Athena to inspect named controls and invoke accessible actions in supported macOS applications. macOS Accessibility consent is required. Athena does not use screen coordinates.',
  personalFiles: 'Allow Athena to use explicitly selected files and projects. Full Mac Access, if separately enabled below, expands the scope only for the authorized AI provider; OS privacy controls still apply.',
  browserAutomation: 'Allow Athena to open an isolated, temporary browser window for the managed local development server only. It cannot use your personal browser profile, saved logins, or navigate to external websites. This does not grant filesystem access.',
}
export const unavailablePermissions = (): PermissionSnapshot => ({ permissions: ATHENA_PERMISSIONS.map((permission) => ({ permission, enabled: false, status: 'unavailable', osStatus: 'unavailable', capabilityAllowed: false, canRequest: false, canOpenSettings: false, detail: 'Permission integration is available in the macOS desktop app.' })) })
