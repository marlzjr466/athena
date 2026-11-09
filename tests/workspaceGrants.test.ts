// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, rename, symlink, stat, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import { WorkspaceService } from '../electron/main/ai/workspaceService'
import { WorkspaceGrants } from '../electron/main/ai/workspaceGrants'
import { ChatController } from '../electron/main/ai/chatController'
import { ConversationRepository } from '../electron/main/ai/conversationRepository'
vi.mock('../electron/main/logger', () => ({ log: vi.fn() }))

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'athena-grants-')), root = join(directory, 'project'), storage = join(directory, 'profile')
  await mkdir(root); await writeFile(join(root, 'app.ts'), 'export const answer = 42')
  await writeFile(join(root, '.env'), 'SECRET=blocked')
  const service = new WorkspaceService(() => true, new WorkspaceGrants(storage))
  const reference = await service.connect(root)
  const restart = (allowed = true) => new WorkspaceService(() => allowed, new WorkspaceGrants(storage))
  return { directory, root, storage, service, reference, restart }
}
describe('remembered local project authorization', () => {
  it('restores the same project across process lifetimes and reads current contents without exposing the path', async () => {
    const f = await fixture(), restarted = f.restart()
    await restarted.restore([f.reference])
    expect(restarted.authorized(f.reference.id)).toBe(true)
    await writeFile(join(f.root, 'app.ts'), 'export const answer = 43')
    expect((await restarted.readRange(f.reference.id, 'app.ts', 1, 5)).content).toContain('43')
    expect(await restarted.connect(f.root, [f.reference])).toEqual(f.reference)
    expect(JSON.stringify(f.reference)).not.toContain(f.root)
    expect((await stat(join(f.storage, 'workspace-grants.json'))).mode & 0o777).toBe(0o600)
    await expect(restarted.readRange(f.reference.id, '.env', 1, 5)).rejects.toThrow('excluded')
    await expect(restarted.readRange(f.reference.id, '../outside.ts', 1, 5)).rejects.toThrow('Invalid')
  })
  it('does not treat a saved name, fingerprint or unrelated session ID as an authorization', async () => {
    const f = await fixture(), noGrants = new WorkspaceService(() => true)
    await noGrants.restore([f.reference]); expect(noGrants.authorized(f.reference.id)).toBe(false)
    const restarted = f.restart()
    await restarted.restore([{ ...f.reference, id: randomUUID() }]); expect(restarted.authorized(f.reference.id)).toBe(false)
    await restarted.restore([{ ...f.reference, fingerprint: 'f'.repeat(64) }]); expect(restarted.authorized(f.reference.id)).toBe(false)
    await f.restart(false).restore([f.reference])
    expect(f.restart(false).authorized(f.reference.id)).toBe(false)
  })
  it('restores the same folder when macOS assigns a new device number after restart', async () => {
    const f = await fixture(), file = join(f.storage, 'workspace-grants.json')
    const saved = JSON.parse(await readFile(file, 'utf8'))
    expect(saved.grants[0].birthtimeMs).toBeGreaterThan(0)
    saved.grants[0].device += 1
    await writeFile(file, JSON.stringify(saved))
    const restarted = f.restart()
    await restarted.restore([f.reference])
    expect(restarted.authorized(f.reference.id)).toBe(true)
    expect((await restarted.readRange(f.reference.id, 'app.ts', 1, 5)).content).toContain('42')
  })
  it('requires explicit reauthorization for an old grant whose device changed', async () => {
    const f = await fixture(), file = join(f.storage, 'workspace-grants.json')
    const saved = JSON.parse(await readFile(file, 'utf8'))
    delete saved.grants[0].birthtimeMs
    saved.grants[0].device += 1
    await writeFile(file, JSON.stringify(saved))
    const restarted = f.restart()
    await restarted.restore([f.reference])
    expect(restarted.authorized(f.reference.id)).toBe(false)
    expect(await restarted.connect(f.root, [f.reference])).toEqual(f.reference)
    const next = f.restart()
    await next.restore([f.reference])
    expect(next.authorized(f.reference.id)).toBe(true)
  })
  it('rejects a saved grant whose folder creation time changed', async () => {
    const f = await fixture(), file = join(f.storage, 'workspace-grants.json')
    const saved = JSON.parse(await readFile(file, 'utf8'))
    saved.grants[0].birthtimeMs += 1000
    await writeFile(file, JSON.stringify(saved))
    const restarted = f.restart()
    await restarted.restore([f.reference])
    expect(restarted.authorized(f.reference.id)).toBe(false)
  })
  it.each(['replacement', 'symlink', 'missing'])('fails closed when the root is %s', async (kind) => {
    const f = await fixture()
    await rename(f.root, join(f.directory, 'original'))
    if (kind === 'replacement') await mkdir(f.root)
    if (kind === 'symlink') await symlink(join(f.directory, 'original'), f.root)
    const restarted = f.restart(); await restarted.restore([f.reference])
    expect(restarted.authorized(f.reference.id)).toBe(false)
  })
  it.each(['disconnect', 'revoke'] as const)('persists %s so removed authorization cannot return after restart', async (action) => {
    const f = await fixture()
    if (action === 'disconnect') f.service.disconnect(f.reference.id); else f.service.revoke()
    const restarted = f.restart(); await restarted.restore([f.reference])
    expect(restarted.authorized(f.reference.id)).toBe(false)
    expect(JSON.parse(await readFile(join(f.storage, 'workspace-grants.json'), 'utf8')).grants).toEqual([])
  })
  it('rejects corrupted grant data and can recover through a fresh explicit folder choice', async () => {
    const f = await fixture()
    await writeFile(join(f.storage, 'workspace-grants.json'), '{invalid')
    const restarted = f.restart(); await restarted.restore([f.reference])
    expect(restarted.authorized(f.reference.id)).toBe(false)
    expect(await restarted.connect(f.root, [f.reference])).toEqual(f.reference)
    const next = f.restart(); await next.restore([f.reference]); expect(next.authorized(f.reference.id)).toBe(true)
  })
  it('migrates a legacy project on one explicit re-selection without changing its ID or custom name', async () => {
    const f = await fixture(), legacyService = new WorkspaceService(() => true)
    const legacy = await legacyService.connect(f.root)
    legacy.name = 'My renamed project'
    const service = f.restart()
    await service.restore([legacy]); expect(service.authorized(legacy.id)).toBe(false)
    expect(await service.connect(f.root, [legacy])).toEqual(legacy)
    const restarted = f.restart(); await restarted.restore([legacy])
    expect(restarted.authorized(legacy.id)).toBe(true)
  })
  it('preserves project sessions and their association on a real conversation-library restart', async () => {
    const f = await fixture(), repository = new ConversationRepository(f.storage)
    const hooks = (workspaces: WorkspaceService) => ({ provider: async () => { throw new Error('No API needed') }, changed: vi.fn(), phase: vi.fn(), authorized: (id: string) => workspaces.authorized(id) })
    const chat = new ChatController(hooks(f.service), repository)
    chat.addWorkspace(chat.current().id, f.reference)
    const first = chat.current().id
    chat.command({ action: 'rename', id: first, title: 'Existing project session' })
    chat.command({ action: 'create', workspaceId: f.reference.id })
    const second = chat.current().id
    chat.dispose()
    const workspaces = f.restart(), restored = new ChatController(hooks(workspaces), repository)
    await workspaces.restore(restored.workspaceReferences())
    expect(restored.current().id).toBe(second)
    expect(restored.snapshot().workspaces![0].authorized).toBe(true)
    restored.command({ action: 'switch', id: first })
    expect(restored.current().title).toBe('Existing project session')
    expect(restored.snapshot().workspaces![0]).toMatchObject({ id: f.reference.id, authorized: true })
    restored.openWorkspace(await workspaces.connect(f.root, restored.workspaceReferences()), [])
    expect(restored.snapshot().sessions).toHaveLength(2)
    restored.dispose()
  })
})
