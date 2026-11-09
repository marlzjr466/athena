import { describe, expect, it, vi } from 'vitest'
import { PermissionService } from '../electron/main/permissions/permissionService'
import { emptyPermissionPreferences, type OSPermissionStatus } from '../shared/permissions'
import type { PermissionPlatform } from '../electron/main/permissions/macOSPermissionAdapter'
vi.mock('../electron/main/logger', () => ({ log: vi.fn() }))
function setup(initial: OSPermissionStatus = 'not-requested') {
  let status = initial
  const repository = { load: () => emptyPermissionPreferences(), save: vi.fn() }
  const platform: PermissionPlatform = { getStatus: vi.fn(() => ({ status, canRequest: status === 'not-requested', canOpenSettings: true, detail: 'Test OS status' })), request: vi.fn(async () => { status = 'allowed' }), openSettings: vi.fn(async () => {}) }
  return { service: new PermissionService(repository, platform), platform, repository, status: (next: OSPermissionStatus) => { status = next } }
}
describe('permission service', () => {
  it('keeps full Mac grants opt-in, provider-bound, revocable, and dependent on Personal File Access', () => {
    let provider = 'local'
    let grant = { mode: 'project-only' as const, active: false, provider: null as string | null }
    const repository = { load: () => emptyPermissionPreferences(), save: vi.fn(), loadFilesystemAccess: () => grant, saveFilesystemAccess: vi.fn((next: typeof grant) => { grant = next }) }
    const platform: PermissionPlatform = { getStatus: () => ({ status: 'not-required', canRequest: false, canOpenSettings: false, detail: '' }), request: vi.fn(), openSettings: vi.fn() }
    const service = new PermissionService(repository, platform, () => provider)
    expect(service.setFilesystemMode('full-read-write').ok).toBe(false)
    expect(service.setPreference({ permission: 'personalFiles', enabled: true }).ok).toBe(true)
    expect(service.setFilesystemMode('full-read-write').ok).toBe(true)
    expect(service.filesystemMode()).toBe('full-read-write')
    expect(service.filesystemModeFor('cloud')).toBe('project-only')
    provider = 'subscription:other'; expect(service.filesystemMode()).toBe('project-only')
    expect(service.filesystemModeFor('local')).toBe('full-read-write')
    service.setFilesystemMode('full-read-only')
    expect(service.filesystemModeFor('local')).toBe('project-only')
    expect(service.filesystemModeFor('subscription:other')).toBe('full-read-only')
    provider = 'local'; service.setFilesystemMode('full-read-write')
    provider = 'local'; expect(service.filesystemMode()).toBe('full-read-write')
    service.setPreference({ permission: 'personalFiles', enabled: false })
    expect(service.filesystemMode()).toBe('project-only')
    expect(grant.mode).toBe('project-only')
  })
  it('defaults off even when OS access is granted, without prompting', () => {
    const { service, platform } = setup('allowed')
    expect(service.snapshot().permissions.every((p) => !p.enabled && !p.capabilityAllowed && p.osStatus === 'allowed')).toBe(true)
    expect(platform.request).not.toHaveBeenCalled()
  })
  it('keeps preference separate from OS consent and rechecks revocation at execution time', () => {
    const { service, status, repository } = setup('denied')
    expect(service.setPreference({ permission: 'microphone', enabled: true }).ok).toBe(true)
    expect(repository.save).toHaveBeenCalledOnce()
    expect(service.getPermissionStatus('microphone')).toMatchObject({ enabled: true, status: 'denied', capabilityAllowed: false })
    status('allowed'); expect(service.isCapabilityAllowed('microphone')).toBe(true)
    status('denied'); expect(service.isCapabilityAllowed('microphone')).toBe(false)
  })
  it('does not request OS consent before explicit opt-in', async () => {
    const { service, platform } = setup()
    expect((await service.requestPermission({ permission: 'microphone' })).ok).toBe(false)
    expect(platform.request).not.toHaveBeenCalled()
  })
  it('requests once and re-reads actual OS state', async () => {
    const { service, platform } = setup()
    service.setPreference({ permission: 'microphone', enabled: true })
    const first = service.requestPermission({ permission: 'microphone' })
    expect(service.requestPermission({ permission: 'microphone' })).toBe(first)
    expect((await first).ok).toBe(true)
    expect(platform.request).toHaveBeenCalledOnce()
  })
  it('never re-enables an opt-out while a prompt is pending', async () => {
    const { service, platform, status } = setup()
    let finish!: () => void
    platform.request = () => new Promise((resolve) => { finish = resolve })
    service.setPreference({ permission: 'microphone', enabled: true })
    const operation = service.requestPermission({ permission: 'microphone' })
    service.setPreference({ permission: 'microphone', enabled: false })
    status('allowed'); finish(); await operation
    expect(service.getPermissionStatus('microphone')).toMatchObject({ enabled: false, osStatus: 'allowed', capabilityAllowed: false })
  })
  it.each(['denied', 'restricted', 'unavailable'] as const)('never grants %s', async (value) => {
    const { service, platform } = setup(value)
    service.setPreference({ permission: 'microphone', enabled: true })
    expect((await service.requestPermission({ permission: 'microphone' })).ok).toBe(false)
    expect(service.isCapabilityAllowed('microphone')).toBe(false)
    expect(platform.request).not.toHaveBeenCalled()
  })
  it('supports app-only consent without inventing OS grants', () => {
    const { service } = setup('not-required')
    service.setPreference({ permission: 'personalFiles', enabled: true })
    expect(service.getPermissionStatus('personalFiles')).toMatchObject({ status: 'allowed', osStatus: 'not-required', capabilityAllowed: true })
  })
  it('keeps local browser verification opt-in separate from filesystem access', () => {
    const { service } = setup('not-required')
    expect(service.isCapabilityAllowed('browserAutomation')).toBe(false)
    expect(service.setPreference({ permission: 'browserAutomation', enabled: true }).ok).toBe(true)
    expect(service.isCapabilityAllowed('browserAutomation')).toBe(true)
    expect(service.setPreference({ permission: 'browserAutomation', enabled: false }).ok).toBe(true)
    expect(service.isCapabilityAllowed('browserAutomation')).toBe(false)
  })
  it('fails closed on OS errors and failed persistence', () => {
    const { service, platform, repository } = setup('allowed')
    repository.save.mockImplementation(() => { throw new Error('disk full') })
    expect(service.setPreference({ permission: 'microphone', enabled: true }).ok).toBe(false)
    expect(service.isCapabilityAllowed('microphone')).toBe(false)
    repository.save.mockReset(); service.setPreference({ permission: 'microphone', enabled: true })
    repository.save.mockImplementation(() => { throw new Error('disk full') })
    service.setPreference({ permission: 'microphone', enabled: false })
    expect(service.isCapabilityAllowed('microphone')).toBe(false)
    platform.getStatus = () => { throw new Error('OS unavailable') }
    expect(service.getPermissionStatus('microphone').osStatus).toBe('unavailable')
  })
  it('handles rejected OS requests and settings failures safely', async () => {
    const { service, platform } = setup()
    service.setPreference({ permission: 'microphone', enabled: true })
    platform.request = async () => { throw new Error('private error') }
    expect((await service.requestPermission({ permission: 'microphone' })).message).not.toContain('private error')
    platform.openSettings = async () => { throw new Error('private error') }
    expect((await service.openPermissionSettings({ permission: 'microphone' })).ok).toBe(false)
  })
  it('validates names, booleans and extra fields, and returns detached snapshots', async () => {
    const { service, platform } = setup()
    expect(service.setPreference({ permission: 'microphone', enabled: 'yes' }).ok).toBe(false)
    expect((await service.openPermissionSettings({ permission: 'microphone', url: 'https://evil.example' })).ok).toBe(false)
    expect((await service.requestPermission({ permission: 'shell' })).ok).toBe(false)
    expect(() => service.isCapabilityAllowed('shell' as never)).toThrow()
    service.snapshot().permissions[0].enabled = true
    expect(service.getPermissionStatus('microphone').enabled).toBe(false)
    expect(platform.openSettings).not.toHaveBeenCalled()
  })
})
