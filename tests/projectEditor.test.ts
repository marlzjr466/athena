// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProjectEditorService } from '../electron/main/ai/projectEditorService'
import { WorkspaceService } from '../electron/main/ai/workspaceService'
import type { ChatController } from '../electron/main/ai/chatController'
import type { VSCodeApplication } from '../electron/main/desktop/vscodeApplication'
const cleanups: string[] = []
afterEach(async () => { for (const path of cleanups.splice(0)) await rm(path, { recursive: true, force: true }) })
async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'athena-editor-test-'))); cleanups.push(directory)
  const root = join(directory, 'project with spaces'); await mkdir(root)
  const workspaces = new WorkspaceService(() => true), workspace = await workspaces.connect(root)
  const session = { id: randomUUID(), workspaces: [workspace] }
  let selected: string = session.id
  const chat = { getSession: (id: string) => id === session.id ? session : undefined, selectedSessionId: () => selected } as unknown as ChatController
  const editor = { available: vi.fn(async () => true), openFolder: vi.fn(async (_root: string, authorize: () => Promise<void>) => { await authorize() }) }
  const service = new ProjectEditorService(chat, workspaces, editor as unknown as VSCodeApplication)
  const command = { action: 'open', sessionId: session.id, workspaceId: workspace.id }
  return { directory, root, workspace, workspaces, session, editor, service, command, select: (id: string) => { selected = id } }
}
describe('conversation-scoped project editor', () => {
  it('opens the authorized whole folder without requiring Git or an AI provider', async () => {
    const f = await fixture()
    expect(await f.service.run(f.command)).toMatchObject({ ok: true, available: true })
    expect(f.editor.openFolder).toHaveBeenCalledWith(f.root, expect.any(Function))
    expect(await f.service.run({ action: 'status' })).toEqual({ ok: true, available: true })
  })
  it('rejects arbitrary executable/path arguments, other workspaces and inactive conversations', async () => {
    const f = await fixture()
    for (const command of [{ ...f.command, path: '/etc' }, { ...f.command, executable: '/bin/sh' }, { ...f.command, workspaceId: randomUUID() }, { ...f.command, sessionId: randomUUID() }]) expect((await f.service.run(command)).ok).toBe(false)
    f.select(randomUUID()); expect((await f.service.run(f.command)).message).toMatch(/conversation changed/)
    expect(f.editor.openFolder).not.toHaveBeenCalled()
  })
  it('rejects revoked access and missing folders with actionable messages', async () => {
    const f = await fixture()
    await rm(f.root, { recursive: true })
    expect((await f.service.run(f.command)).message).toMatch(/missing/)
    f.workspaces.disconnect(f.workspace.id)
    expect((await f.service.run(f.command)).message).toMatch(/reauthorize/)
    expect(f.editor.openFolder).not.toHaveBeenCalled()
  })
  it('does not follow a project replaced with a symlink', async () => {
    const f = await fixture(), outside = join(f.directory, 'other'); await mkdir(outside)
    await rm(f.root, { recursive: true }); await symlink(outside, f.root)
    expect((await f.service.run(f.command)).message).toMatch(/folder changed/)
    expect(f.editor.openFolder).not.toHaveBeenCalled()
  })
  it('revalidates the selected conversation immediately before launching', async () => {
    const f = await fixture()
    f.editor.openFolder.mockImplementation(async (_root, authorize) => { f.select(randomUUID()); await authorize() })
    expect((await f.service.run(f.command)).message).toMatch(/conversation changed/)
  })
  it('deduplicates simultaneous launches', async () => {
    const f = await fixture()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    f.editor.openFolder.mockImplementation(async (_root, authorize) => { await authorize(); await gate })
    const first = f.service.run(f.command), second = f.service.run(f.command)
    await vi.waitFor(() => expect(f.editor.openFolder).toHaveBeenCalledOnce())
    release(); expect(await Promise.all([first, second])).toEqual([{ ok: true, available: true }, { ok: true, available: true }])
  })
  it('reports removal, permission denial and launcher failures without claiming success', async () => {
    const f = await fixture()
    f.editor.openFolder.mockRejectedValueOnce(new Error('vscode-unavailable'))
    expect(await f.service.run(f.command)).toMatchObject({ ok: false, available: false, message: expect.stringContaining('no longer available') })
    f.editor.openFolder.mockRejectedValueOnce(Object.assign(new Error('private details'), { code: 'EACCES' }))
    expect((await f.service.run(f.command)).message).toMatch(/Access was denied/)
    f.editor.openFolder.mockRejectedValueOnce(new Error('private details'))
    expect(await f.service.run(f.command)).toMatchObject({ ok: false, message: expect.stringContaining('Try opening VS Code manually') })
  })
})
