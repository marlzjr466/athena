// @vitest-environment node
import { mkdtemp, mkdir, readFile, readdir, rename, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { realpath } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { CursorGeneralWorkspace } from '../electron/main/ai/cursorGeneralWorkspace'
import { WorkspaceGrants } from '../electron/main/ai/workspaceGrants'

async function fixture() {
  const data = await mkdtemp(join(tmpdir(), 'athena-cursor-data-'))
  const outside = await mkdtemp(join(tmpdir(), 'athena-cursor-outside-'))
  const grantDirectory = join(data, 'cursor-general-workspace-grants')
  return { data, outside, grantDirectory, grants: () => new WorkspaceGrants(grantDirectory) }
}

describe('Cursor private general-chat workspace', () => {
  it('grants only the dedicated app-data directory and restores that exact grant', async () => {
    const f = await fixture()
    const first = new CursorGeneralWorkspace(f.data, f.grants())
    const access = await first.authorize()
    expect(access.root).toBe(join(await realpath(f.data), 'cursor-general-chat'))
    expect(access.root).not.toBe(f.data)
    expect(access.root).not.toBe(tmpdir())
    await access.assertAccess()

    const grant = f.grants().list()
    expect(grant).toHaveLength(1)
    expect(grant[0].root).toBe(access.root)
    expect(grant[0].birthtimeMs).toBeGreaterThan(0)
    const restarted = await new CursorGeneralWorkspace(f.data, f.grants()).authorize()
    expect(restarted.root).toBe(access.root)
    await restarted.assertAccess()
  })

  it('keeps a verified workspace grant when macOS changes its device number', async () => {
    const f = await fixture()
    const first = await new CursorGeneralWorkspace(f.data, f.grants()).authorize()
    const file = join(f.grantDirectory, 'workspace-grants.json')
    const saved = JSON.parse(await readFile(file, 'utf8'))
    saved.grants[0].device += 1
    await writeFile(file, JSON.stringify(saved))
    const restarted = await new CursorGeneralWorkspace(f.data, f.grants()).authorize()
    expect(restarted.root).toBe(first.root)
    await restarted.assertAccess()
  })

  it('moves a legacy device-mismatched grant to a fresh empty workspace without entering the old one', async () => {
    const f = await fixture()
    const first = await new CursorGeneralWorkspace(f.data, f.grants()).authorize()
    const file = join(f.grantDirectory, 'workspace-grants.json')
    const saved = JSON.parse(await readFile(file, 'utf8'))
    delete saved.grants[0].birthtimeMs
    saved.grants[0].device += 1
    await writeFile(file, JSON.stringify(saved))
    const restarted = await new CursorGeneralWorkspace(f.data, f.grants()).authorize()
    expect(restarted.root).not.toBe(first.root)
    expect(restarted.root).toMatch(/cursor-general-chat-[0-9a-f-]{36}$/)
    expect(await readdir(restarted.root)).toEqual([])
    expect(f.grants().list()).toHaveLength(2)
    await restarted.assertAccess()
    const next = await new CursorGeneralWorkspace(f.data, f.grants()).authorize()
    expect(next.root).toBe(restarted.root)
  })

  it('refuses a symlinked workspace root that points outside Athena data', async () => {
    const f = await fixture()
    await symlink(f.outside, join(f.data, 'cursor-general-chat'))
    await expect(new CursorGeneralWorkspace(f.data, f.grants()).authorize()).rejects.toThrow('safe directory')
    expect(f.grants().list()).toHaveLength(0)
  })

  it('fails closed if a previously granted workspace directory is replaced', async () => {
    const f = await fixture()
    const manager = new CursorGeneralWorkspace(f.data, f.grants())
    const access = await manager.authorize()
    await rename(access.root, join(f.data, 'cursor-general-chat-original'))
    await mkdir(access.root)
    await expect(access.assertAccess()).rejects.toThrow('changed or is unavailable')
    await expect(new CursorGeneralWorkspace(f.data, f.grants()).authorize()).rejects.toThrow('no longer matches')
  })
})
