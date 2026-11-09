import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ATHENA_PERMISSIONS, emptyPermissionPreferences, filesystemAccessSchema, type FilesystemAccessStatus, type PermissionPreferences, rememberedStateSchema, type RememberedState } from '../../../shared/permissions'
import { log } from '../logger'

export interface PermissionPreferencesStore { loadRemembered?(): RememberedState; saveRemembered?(state: RememberedState): void; load(): PermissionPreferences; save(preferences: PermissionPreferences): void; loadFilesystemAccess?(): FilesystemAccessStatus; saveFilesystemAccess?(access: FilesystemAccessStatus, preferences: PermissionPreferences): void }
export function restoreFilesystemAccess(input: unknown): FilesystemAccessStatus {
  if (!input || typeof input !== 'object') return { mode: 'project-only', active: false, provider: null }
  const raw = input as { version?: unknown; filesystemAccess?: unknown }
  if (raw.version !== 2 || !raw.filesystemAccess || typeof raw.filesystemAccess !== 'object') return { mode: 'project-only', active: false, provider: null }
  const grant = raw.filesystemAccess as Record<string, unknown>
  const mode = filesystemAccessSchema.safeParse(grant.mode)
  return mode.success && typeof grant.provider === 'string' && grant.provider.length <= 150
    ? { mode: mode.data, active: mode.data !== 'project-only', provider: grant.provider }
    : { mode: 'project-only', active: false, provider: null }
}
export function restorePermissionPreferences(input: unknown): PermissionPreferences {
  const defaults = emptyPermissionPreferences()
  if (!input || typeof input !== 'object' || Array.isArray(input)) return defaults
  const raw = input as { version?: unknown; enabled?: unknown }
  if (![1, 2].includes(Number(raw.version)) || !raw.enabled || typeof raw.enabled !== 'object' || Array.isArray(raw.enabled)) return defaults
  for (const permission of ATHENA_PERMISSIONS) defaults[permission] = (raw.enabled as Record<string, unknown>)[permission] === true
  return defaults
}
export class PermissionRepository implements PermissionPreferencesStore {
  private file: string
  constructor(private directory: string) { this.file = join(directory, 'permissions.json') }
  loadRemembered(): RememberedState {
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8'))
      const parsed = raw.version === 2 ? rememberedStateSchema.safeParse(raw.remembered) : undefined
      if (parsed?.success) return parsed.data
    } catch { /* Missing or malformed grants never authorize operations. */ }
    return { enabled: true, rules: [] }
  }
  saveRemembered(remembered: RememberedState): void {
    rememberedStateSchema.parse(remembered)
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    writeFileSync(`${this.file}.tmp`, JSON.stringify({ version: 2, enabled: this.load(), filesystemAccess: this.loadFilesystemAccess(), remembered }), { mode: 0o600 })
    renameSync(`${this.file}.tmp`, this.file)
  }
  load(): PermissionPreferences {
    try { return restorePermissionPreferences(JSON.parse(readFileSync(this.file, 'utf8'))) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') log('permissions.load_failed'); return emptyPermissionPreferences() }
  }
  save(enabled: PermissionPreferences): void {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    writeFileSync(`${this.file}.tmp`, JSON.stringify({ version: 2, enabled, filesystemAccess: this.loadFilesystemAccess(), remembered: this.loadRemembered() }), { mode: 0o600 })
    renameSync(`${this.file}.tmp`, this.file)
  }
  loadFilesystemAccess(): FilesystemAccessStatus {
    try { return restoreFilesystemAccess(JSON.parse(readFileSync(this.file, 'utf8'))) }
    catch { return { mode: 'project-only', active: false, provider: null } }
  }
  saveFilesystemAccess(access: FilesystemAccessStatus, enabled: PermissionPreferences): void {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    writeFileSync(`${this.file}.tmp`, JSON.stringify({ version: 2, enabled, filesystemAccess: access, remembered: this.loadRemembered() }), { mode: 0o600 })
    renameSync(`${this.file}.tmp`, this.file)
  }
}
