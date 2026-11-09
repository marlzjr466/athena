// @vitest-environment node
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, symlinkSync, unlinkSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PermissionRepository } from '../electron/main/permissions/permissionRepository'
import { RememberedPermissions, normalizeRememberedScope } from '../electron/main/permissions/rememberedPermissions'
import { ChatController } from '../electron/main/ai/chatController'
import { emptyPermissionPreferences, type RememberedScope } from '../shared/permissions'
import { log } from '../electron/main/logger'
vi.mock('../electron/main/logger', () => ({ log: vi.fn() }))
const directories: string[] = []
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); vi.clearAllMocks() })
function fixture() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'athena-remembered-'))); directories.push(directory)
  const project = join(directory, 'project'); mkdirSync(project)
  const resource = join(project, 'app.ts'); writeFileSync(resource, 'export {}')
  const repository = new PermissionRepository(join(directory, 'preferences'))
  const permissions = new RememberedPermissions(repository)
  const scope: RememberedScope = { operation: 'write_file', project, resources: [resource] }
  return { directory, project, resource, repository, permissions, scope }
}
describe('persistent, exact permission matching', () => {
  it('persists explicit grants, preserves existing opt-ins and filesystem grants, and audits without content', () => {
    const f = fixture(), prefs = { ...emptyPermissionPreferences(), personalFiles: true }
    f.repository.save(prefs)
    f.repository.saveFilesystemAccess({ mode: 'full-read-only', active: true, provider: 'local' }, prefs)
    f.permissions.grant(f.scope)
    f.repository.save(prefs)
    f.repository.saveFilesystemAccess({ mode: 'full-read-only', active: true, provider: 'local' }, prefs)
    const restarted = new RememberedPermissions(new PermissionRepository(join(f.directory, 'preferences')))
    expect(restarted.allows(f.scope)).toBe(true)
    expect(f.repository.load()).toEqual(prefs)
    expect(f.repository.loadFilesystemAccess().mode).toBe('full-read-only')
    expect(log).toHaveBeenCalledWith('permission.automatic_approval', expect.objectContaining({ operation: 'write_file', ruleId: expect.any(String) }))
  })
  it('does not authorize another operation, file, project or tool lookalike', () => {
    const f = fixture(); f.permissions.grant(f.scope)
    for (const operation of ['edit_file', 'create_file', 'delete_file', 'read_file', 'write_files', 'execute_command']) expect(f.permissions.allows({ ...f.scope, operation })).toBe(false)
    expect(f.permissions.allows({ ...f.scope, resources: [join(f.project, 'other.ts')] })).toBe(false)
    const other = join(f.directory, 'other'); mkdirSync(other); writeFileSync(join(other, 'app.ts'), '')
    expect(f.permissions.allows({ ...f.scope, project: other, resources: [join(other, 'app.ts')] })).toBe(false)
  })
  it('keeps Cursor read grants separate from edits, deletion, and other adapters', () => {
    const f = fixture(), read = { ...f.scope, operation: 'cursor_read' as const }
    f.permissions.grant(read)
    expect(new RememberedPermissions(f.repository).allows(read)).toBe(true)
    for (const operation of ['cursor_edit', 'write_file', 'delete_file']) expect(f.permissions.allows({ ...read, operation })).toBe(false)
  })
  it('revokes one or all grants permanently, retaining the history', () => {
    const f = fixture(); f.permissions.grant(f.scope)
    const id = f.permissions.snapshot().rules[0].id
    f.permissions.command({ action: 'revoke', id })
    expect(new RememberedPermissions(f.repository).allows(f.scope)).toBe(false)
    expect(f.permissions.snapshot().rules[0].revokedAt).toBeTypeOf('number')
    f.permissions.grant(f.scope); expect(f.permissions.snapshot().rules).toHaveLength(2)
    f.permissions.command({ action: 'revoke-all' }); expect(f.permissions.allows(f.scope)).toBe(false)
  })
  it('disables matching and granting immediately without erasing history, across restart', () => {
    const f = fixture(); f.permissions.grant(f.scope); f.permissions.command({ action: 'enable', enabled: false })
    const restarted = new RememberedPermissions(f.repository)
    expect(restarted.allows(f.scope)).toBe(false); expect(restarted.eligible(f.scope)).toBeUndefined()
    expect(() => restarted.grant(f.scope)).toThrow()
    restarted.command({ action: 'enable', enabled: true }); expect(restarted.allows(f.scope)).toBe(true)
  })
  it('rejects traversal, sibling-prefix paths, hidden files, secrets and high-risk operations', () => {
    const f = fixture()
    for (const path of [`${f.project}/../outside.ts`, `${f.project}-extra/app.ts`, join(f.project, '.env'), join(f.project, 'token.json'), join(f.project, '.codex/config.toml')]) expect(normalizeRememberedScope({ ...f.scope, resources: [path] })).toBeUndefined()
    for (const operation of ['delete_file', 'git_commit', 'git_add', 'capture_screen', 'execute_command']) expect(normalizeRememberedScope({ ...f.scope, operation })).toBeUndefined()
  })
  it('invalidates a file grant after symlink replacement and rejects dangling symlinks', () => {
    const f = fixture(); f.permissions.grant(f.scope)
    unlinkSync(f.resource); symlinkSync(join(f.directory, 'missing.ts'), f.resource)
    expect(f.permissions.allows(f.scope)).toBe(false)
    writeFileSync(join(f.directory, 'missing.ts'), 'outside')
    expect(f.permissions.allows(f.scope)).toBe(false)
  })
  it('rejects scope escapes through a changed parent directory', () => {
    const f = fixture(), folder = join(f.project, 'src'); mkdirSync(folder)
    const scope = { ...f.scope, resources: [join(folder, 'app.ts')] }; f.permissions.grant(scope)
    rmSync(folder, { recursive: true }); symlinkSync(f.directory, folder, 'dir')
    expect(f.permissions.allows(scope)).toBe(false)
  })
  it('does not revive a grant for a replacement project at the same path', () => {
    const f = fixture(); f.permissions.grant(f.scope)
    renameSync(f.project, `${f.project}-old`); mkdirSync(f.project); writeFileSync(f.resource, 'replacement project')
    expect(new RememberedPermissions(f.repository).allows(f.scope)).toBe(false)
  })
  it('rejects corrupt records and unavailable storage; failed writes do not grant', () => {
    const f = fixture(); mkdirSync(join(f.directory, 'preferences'))
    writeFileSync(join(f.directory, 'preferences/permissions.json'), JSON.stringify({ version: 2, remembered: { enabled: true, rules: [{ scope: f.scope }] } }))
    expect(new RememberedPermissions(f.repository).allows(f.scope)).toBe(false)
    const broken = new RememberedPermissions({ load: emptyPermissionPreferences, save() {}, saveRemembered() { throw new Error('disk full') } })
    expect(() => broken.grant(f.scope)).toThrow('disk full'); expect(broken.allows(f.scope)).toBe(false)
    expect(new RememberedPermissions({ load: emptyPermissionPreferences, save() {} }).eligible(f.scope)).toBeUndefined()
  })
  it('limits desktop grants to exact known apps and URLs without embedded credentials or query secrets', () => {
    const f = fixture(), app = { operation: 'open_application', project: 'desktop', resources: ['vscode'] }
    f.permissions.grant(app); expect(f.permissions.allows(app)).toBe(true)
    expect(f.permissions.allows({ ...app, resources: ['terminal'] })).toBe(false)
    expect(f.permissions.allows({ ...app, operation: 'focus_application' })).toBe(false)
    const url = { operation: 'open_url', project: 'desktop', resources: ['https://example.com/docs'] }
    f.permissions.grant(url); expect(f.permissions.allows(url)).toBe(true)
    expect(f.permissions.allows({ ...url, resources: ['https://example.com/admin'] })).toBe(false)
    for (const resource of ['file:///etc/passwd', 'https://user:pass@example.com/', 'https://example.com/?token=private']) expect(f.permissions.eligible({ ...url, resources: [resource] })).toBeUndefined()
  })
})

function conversation(permissions: RememberedPermissions, scope?: RememberedScope, origin: 'online-chat' | 'athena-local' = 'online-chat') {
  let chat: ChatController
  const events = vi.fn(), decisions: boolean[] = []
  chat = new ChatController({ rememberedPermissions: permissions, origin, changed: vi.fn(), phase: vi.fn(), approvalChanged: events,
    provider: async () => ({ testConnection: async () => true, async *streamMessage(_messages, options) {
      decisions.push(await chat.approve({ title: 'Host operation', description: 'Exact resource', rememberScope: scope }, options!.signal!))
      yield { type: 'text', text: 'Operation resolved' }; yield { type: 'done' }
    } }) })
  return { chat, events, decisions }
}
const pending = (chat: ChatController) => chat.snapshot().messages.at(-1)?.execution?.approval
const waitPending = async (chat: ChatController) => { await vi.waitFor(() => expect(pending(chat)).toBeDefined()); return pending(chat)! }
const waitIdle = (chat: ChatController) => vi.waitFor(() => expect(chat.snapshot().phase).toBe('idle'))
describe('shared online/local approval lifecycle', () => {
  it('Allow once asks again, while Always allow survives new conversations, local lanes and restart', async () => {
    const f = fixture(), online = conversation(f.permissions, f.scope)
    try {
      online.chat.send({ text: 'First' }); let approval = await waitPending(online.chat)
      online.chat.command({ action: 'agent-approval', id: online.chat.current().id, approvalId: approval.id, allow: true }); await waitIdle(online.chat)
      expect(f.permissions.snapshot().rules).toHaveLength(0)
      online.chat.send({ text: 'Second' }); approval = await waitPending(online.chat)
      expect(approval.rememberScope).toMatchObject(f.scope)
      online.chat.command({ action: 'agent-approval', id: online.chat.current().id, approvalId: approval.id, allow: true, remember: true }); await waitIdle(online.chat)
      online.chat.command({ action: 'create' }); online.chat.send({ text: 'Third' }); await waitIdle(online.chat)
      expect(online.decisions).toEqual([true, true, true])
      expect(online.events.mock.calls.filter(([e]) => e.action === 'required')).toHaveLength(2)
      const local = conversation(new RememberedPermissions(f.repository), f.scope, 'athena-local')
      try { local.chat.send({ text: 'Local after restart' }); await waitIdle(local.chat); expect(local.decisions).toEqual([true]); expect(local.events).not.toHaveBeenCalled() } finally { local.chat.dispose() }
    } finally { online.chat.dispose() }
  })
  it('forged remember decisions cannot authorize mandatory or cancelled requests', async () => {
    const f = fixture(), c = conversation(f.permissions)
    try {
      c.chat.send({ text: 'Sensitive request' }); const approval = await waitPending(c.chat)
      expect(approval.rememberScope).toBeUndefined()
      expect(c.chat.command({ action: 'agent-approval', id: c.chat.current().id, approvalId: approval.id, allow: true, remember: true }).ok).toBe(false)
      expect(c.decisions).toEqual([]); expect(f.permissions.snapshot().rules).toHaveLength(0)
      c.chat.stop()
      expect(c.chat.command({ action: 'agent-approval', id: c.chat.current().id, approvalId: approval.id, allow: true, remember: true }).ok).toBe(false)
    } finally { c.chat.dispose() }
  })
  it('rechecks disabled grants on a pending decision and preserves the Deny flow', async () => {
    const f = fixture(), c = conversation(f.permissions, f.scope)
    try {
      c.chat.send({ text: 'Request' }); const approval = await waitPending(c.chat)
      f.permissions.command({ action: 'enable', enabled: false })
      expect(c.chat.command({ action: 'agent-approval', id: c.chat.current().id, approvalId: approval.id, allow: true, remember: true }).ok).toBe(false)
      expect(c.chat.command({ action: 'agent-approval', id: c.chat.current().id, approvalId: approval.id, allow: false }).ok).toBe(true)
      await waitIdle(c.chat); expect(c.decisions).toEqual([false])
    } finally { c.chat.dispose() }
  })
})
