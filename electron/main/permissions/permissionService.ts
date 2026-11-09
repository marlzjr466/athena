import { RememberedPermissions } from './rememberedPermissions'
import { ATHENA_PERMISSIONS, filesystemAccessSchema, permissionInputSchema, permissionPreferenceSchema, permissionSchema, type AthenaPermission, type FilesystemAccessMode, type FilesystemAccessStatus, type PermissionInfo, type PermissionPreferences, type PermissionResult, type PermissionSnapshot } from '../../../shared/permissions'
import type { PermissionPreferencesStore } from './permissionRepository'
import type { OSAccess, PermissionPlatform } from './macOSPermissionAdapter'
import { log } from '../logger'

export class PermissionService {
  readonly remembered: RememberedPermissions
  private preferences: PermissionPreferences
  private filesystemAccess: FilesystemAccessStatus
  private requests = new Map<AthenaPermission, Promise<PermissionResult>>()
  constructor(private repository: PermissionPreferencesStore, private platform: PermissionPlatform, private provider: () => string = () => 'unknown') { this.remembered = new RememberedPermissions(repository); this.preferences = repository.load(); this.filesystemAccess = repository.loadFilesystemAccess?.() ?? { mode: 'project-only', active: false, provider: null } }
  filesystemMode(): FilesystemAccessMode { return this.filesystemModeFor(this.provider()) }
  /** Main-process callers supply their own lane; never accept this identity from renderer input. */
  filesystemModeFor(provider: string): FilesystemAccessMode { return provider !== 'unknown' && this.isCapabilityAllowed('personalFiles') && this.filesystemAccess.provider === provider ? this.filesystemAccess.mode : 'project-only' }
  filesystemStatus(): FilesystemAccessStatus { return { ...this.filesystemAccess, active: this.filesystemMode() !== 'project-only' } }
  setFilesystemMode(input: unknown): PermissionResult {
    const parsed = filesystemAccessSchema.safeParse(input)
    if (!parsed.success) return this.result(false, 'Invalid filesystem access mode.')
    if (parsed.data !== 'project-only' && !this.isCapabilityAllowed('personalFiles')) return this.result(false, 'Enable Personal File Access first.')
    const provider = this.provider()
    if (parsed.data !== 'project-only' && provider === 'unknown') return this.result(false, 'Select an AI provider before enabling Full Mac Access.')
    if (!this.repository.saveFilesystemAccess) return this.result(false, 'Secure filesystem preference storage is unavailable.')
    const next: FilesystemAccessStatus = { mode: parsed.data, active: parsed.data !== 'project-only', provider: parsed.data === 'project-only' ? null : provider }
    try { this.repository.saveFilesystemAccess(next, this.preferences); this.filesystemAccess = next }
    catch { return this.result(false, 'Could not save filesystem access. The previous mode remains in effect.') }
    log('permission.filesystem_mode_changed', { mode: parsed.data, provider: next.provider ?? 'none' })
    return this.result(true, parsed.data === 'project-only' ? 'Full Mac Access revoked. Project Only is active.' : 'Full Mac Access saved for the current AI provider. macOS privacy controls and operation approvals still apply.')
  }
  getPermissionStatus(permission: AthenaPermission): PermissionInfo {
    permissionSchema.parse(permission)
    let os: OSAccess
    try { os = this.platform.getStatus(permission) }
    catch { os = { status: 'unavailable', canRequest: false, canOpenSettings: false, detail: 'Could not read the OS permission. Refresh or reopen Athena to retry.' } }
    const enabled = this.preferences[permission]
    const capabilityAllowed = enabled && (os.status === 'allowed' || os.status === 'not-required')
    return { permission, enabled, status: os.status === 'unavailable' || os.status === 'restricted' ? os.status : !enabled ? 'not-requested' : os.status === 'not-required' ? 'allowed' : os.status,
      osStatus: os.status, capabilityAllowed, canRequest: os.canRequest, canOpenSettings: os.canOpenSettings, detail: os.detail }
  }
  snapshot(): PermissionSnapshot { return { permissions: ATHENA_PERMISSIONS.map((permission) => this.getPermissionStatus(permission)), filesystemAccess: this.filesystemStatus(), remembered: this.remembered.snapshot() } }
  updateRemembered(input: unknown): PermissionResult {
    try { this.remembered.command(input); return this.result(true, 'Remembered permissions updated. Existing OS and project restrictions still apply.') }
    catch { return this.result(false, 'Could not save remembered permissions. No change was applied; retry.') }
  }
  // Necessary capability gate, never sufficient authorization for a specific action/path.
  // Call at execution time, not just when rendering the switch: OS consent can be revoked.
  isCapabilityAllowed(permission: AthenaPermission): boolean { return this.getPermissionStatus(permission).capabilityAllowed }
  private result(ok: boolean, message: string): PermissionResult { return { ok, message, snapshot: this.snapshot() } }
  setPreference(input: unknown): PermissionResult {
    const parsed = permissionPreferenceSchema.safeParse(input)
    if (!parsed.success) return this.result(false, 'Invalid permission preference.')
    const { permission, enabled } = parsed.data
    if (enabled && this.getPermissionStatus(permission).osStatus === 'unavailable') return this.result(false, 'This permission is unavailable on this platform.')
    const next = { ...this.preferences, [permission]: enabled }
    try { this.repository.save(next); this.preferences = next; if (permission === 'personalFiles' && !enabled) { this.filesystemAccess = { mode: 'project-only', active: false, provider: null }; this.repository.saveFilesystemAccess?.(this.filesystemAccess, next) } }
    catch { if (!enabled) this.preferences[permission] = false; return this.result(false, 'Could not save permission preferences. Disabling still takes effect for this session; retry to save it.') }
    log('permission.preference_changed', { permission, enabled })
    return this.result(true, enabled ? 'Athena opt-in saved. OS consent and action-specific checks still apply.' : 'Disabled in Athena. OS consent is unchanged; revoke it separately in System Settings if desired.')
  }
  requestPermission(input: unknown): Promise<PermissionResult> {
    const parsed = permissionInputSchema.safeParse(input)
    if (!parsed.success) return Promise.resolve(this.result(false, 'Invalid permission request.'))
    const permission = parsed.data.permission
    const existing = this.requests.get(permission)
    if (existing) return existing
    const operation = this.request(permission).finally(() => this.requests.delete(permission))
    this.requests.set(permission, operation)
    return operation
  }
  private async request(permission: AthenaPermission): Promise<PermissionResult> {
    if (!this.preferences[permission]) return this.result(false, 'Enable Athena’s opt-in before requesting OS access.')
    const before = this.getPermissionStatus(permission)
    if (before.osStatus === 'allowed' || before.osStatus === 'not-required') return this.result(true, 'Permission check complete. No OS prompt is needed.')
    if (!before.canRequest) return this.result(false, before.canOpenSettings ? 'Review this permission in System Settings, then return to Athena and refresh.' : 'This permission cannot be requested on this platform.')
    try { await this.platform.request(permission) }
    catch { return this.result(false, 'The OS permission request could not be completed. Review System Settings and retry.') }
    const after = this.getPermissionStatus(permission)
    log('permission.request_completed', { permission, status: after.osStatus })
    return this.result(after.capabilityAllowed, after.capabilityAllowed ? 'Permission allowed. No recording, capture or desktop action has started.' : 'Access is not enabled. Review the OS decision in System Settings; Athena will remain blocked.')
  }
  async openPermissionSettings(input: unknown): Promise<PermissionResult> {
    const parsed = permissionInputSchema.safeParse(input)
    if (!parsed.success) return this.result(false, 'Invalid permission request.')
    if (!this.getPermissionStatus(parsed.data.permission).canOpenSettings) return this.result(false, 'This capability has no separate OS permission settings page.')
    try { await this.platform.openSettings(parsed.data.permission); return this.result(true, 'System Settings opened. Return here and refresh after changing consent; macOS may require Athena to restart.') }
    catch { return this.result(false, 'Could not open System Settings. Open Privacy & Security manually.') }
  }
}
