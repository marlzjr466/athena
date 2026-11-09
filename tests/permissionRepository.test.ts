// @vitest-environment node
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PermissionRepository, restoreFilesystemAccess, restorePermissionPreferences } from '../electron/main/permissions/permissionRepository'
import { emptyPermissionPreferences } from '../shared/permissions'
describe('permission preference persistence', () => {
  it('saves only versioned opt-ins, never cached OS grants', () => {
    const directory = mkdtempSync(join(tmpdir(), 'athena-permissions-unit-'))
    const repository = new PermissionRepository(directory)
    expect(repository.load()).toEqual(emptyPermissionPreferences())
    const enabled = { ...emptyPermissionPreferences(), applicationDetection: true }
    repository.save(enabled)
    expect(new PermissionRepository(directory).load()).toEqual(enabled)
    expect(JSON.parse(readFileSync(join(directory, 'permissions.json'), 'utf8'))).toEqual({ version: 2, enabled, filesystemAccess: { mode: 'project-only', active: false, provider: null }, remembered: { enabled: true, rules: [] } })
    repository.saveFilesystemAccess({ mode: 'full-read-only', active: true, provider: 'local' }, enabled)
    expect(new PermissionRepository(directory).loadFilesystemAccess()).toEqual({ mode: 'full-read-only', active: true, provider: 'local' })
    repository.save(enabled)
    expect(new PermissionRepository(directory).loadFilesystemAccess().mode).toBe('full-read-only')
  })
  it('defaults malformed and unknown-version preferences to off', () => {
    for (const input of [null, [], 'yes', { version: 3, enabled: { microphone: true } }, { version: 1, enabled: [] }]) expect(restorePermissionPreferences(input)).toEqual(emptyPermissionPreferences())
    expect(restorePermissionPreferences({ version: 1, enabled: { microphone: 'true', screenCapture: 1, applicationDetection: true } })).toEqual({ ...emptyPermissionPreferences(), applicationDetection: true })
    expect(restoreFilesystemAccess({ version: 2, filesystemAccess: { mode: 'full-read-write', provider: 42 } }).mode).toBe('project-only')
  })
})
