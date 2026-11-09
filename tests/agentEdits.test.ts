// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AgentEdits, versionOf } from '../electron/main/ai/agentEdits'
import { WorkspaceService } from '../electron/main/ai/workspaceService'
import { elapsedLabel } from '../shared/agent'

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'athena-agent-edit-')), root = join(directory, 'project')
  await mkdir(root); await mkdir(join(root, 'src')); await writeFile(join(root, 'src/app.ts'), 'export const value = 1\n')
  const workspaces = new WorkspaceService(() => true), workspace = await workspaces.connect(root), session = randomUUID()
  return { directory, root, workspaces, workspace, session, edits: new AgentEdits(workspaces, join(directory, 'storage')), signal: new AbortController().signal }
}
describe('version-checked local file changes', () => {
  it('creates and modifies an outside-project file only while Full Mac Read & Write is active', async () => {
    const f = await fixture(), outside = await realpath(f.directory)
    let access: 'project-only' | 'full-read-only' | 'full-read-write' = 'project-only'
    const workspaces = new WorkspaceService(() => true, undefined, () => access)
    const workspace = await workspaces.connect(f.root), edits = new AgentEdits(workspaces, join(f.directory, 'global-recovery'))
    const target = join(outside, 'notes.md')
    await expect(edits.prepare(f.session, workspace.id, [{ path: target, expected: null, content: 'first' }])).rejects.toThrow()
    access = 'full-read-only'
    await expect(edits.prepare(f.session, workspace.id, [{ path: target, expected: null, content: 'first' }])).rejects.toThrow('Read Only')
    access = 'full-read-write'
    await edits.apply(await edits.prepare(f.session, workspace.id, [{ path: target, expected: null, content: 'first' }]), f.signal)
    expect(await readFile(target, 'utf8')).toBe('first')
    const prepared = await edits.prepare(f.session, workspace.id, [{ path: target, expected: versionOf('first'), content: 'second' }])
    access = 'project-only'
    await expect(edits.apply(prepared, f.signal)).rejects.toThrow()
    expect(await readFile(target, 'utf8')).toBe('first')
  })
  it('version-checks credential-bearing Claude/Codex files only under Full Mac Read & Write', async () => {
    const f = await fixture(), home = await realpath(f.directory)
    await mkdir(join(home, '.claude')); await mkdir(join(home, '.codex'))
    const claude = join(home, '.claude', '.credentials.json'), codex = join(home, '.codex', 'auth.json')
    const original = '{"access_token":"fixture-token-1234567890"}'
    await writeFile(claude, original)
    let access: 'project-only' | 'full-read-only' | 'full-read-write' = 'project-only'
    const workspaces = new WorkspaceService(() => true, undefined, () => access)
    const workspace = await workspaces.connect(f.root), edits = new AgentEdits(workspaces, join(home, 'credential-recovery'))
    await expect(edits.prepare(f.session, workspace.id, [{ path: claude, expected: versionOf(original), content: original + '\n' }])).rejects.toThrow()
    access = 'full-read-only'
    await expect(edits.prepare(f.session, workspace.id, [{ path: claude, expected: versionOf(original), content: original + '\n' }])).rejects.toThrow('Read Only')
    access = 'full-read-write'
    await edits.apply(await edits.prepare(f.session, workspace.id, [{ path: claude, expected: versionOf(original), content: original + '\n' }, { path: codex, expected: null, content: '{"access_token":"fixture-token-abcdefghij"}' }]), f.signal)
    expect(await readFile(claude, 'utf8')).toBe(original + '\n')
    expect(await readFile(codex, 'utf8')).toContain('fixture-token-abcdefghij')
    await expect(edits.prepare(f.session, workspace.id, [{ path: claude, expected: versionOf(original), content: 'stale' }])).rejects.toThrow('version changed')
  })
  it('creates multiple actual files, reads fresh versions and reverts individual changes', async () => {
    const f = await fixture()
    const prepared = await f.edits.prepare(f.session, f.workspace.id, [{ path: 'src/Button.tsx', expected: null, content: 'export const Button = () => <button />' }, { path: 'src/index.ts', expected: null, content: 'export { Button } from "./Button"' }])
    expect(prepared[0].preview.diff).toContain('+export const Button')
    const result = await f.edits.apply(prepared, f.signal)
    expect(await readFile(join(f.root, 'src/Button.tsx'), 'utf8')).toContain('<button />')
    expect((await f.workspaces.readRange(f.workspace.id, 'src/index.ts', 1, 20)).version).toBe(versionOf('export { Button } from "./Button"'))
    await f.edits.revert(f.session, f.workspace.id, result[0].id)
    await expect(readFile(join(f.root, 'src/Button.tsx'))).rejects.toThrow()
    expect(await readFile(join(f.root, 'src/index.ts'), 'utf8')).toContain('Button')
  })
  it('rejects stale versions both before and after approval without overwriting user changes', async () => {
    const f = await fixture(), path = 'src/app.ts', version = (await f.workspaces.readRange(f.workspace.id, path, 1, 20)).version
    await expect(f.edits.prepare(f.session, f.workspace.id, [{ path, expected: '0'.repeat(64), content: 'wrong' }])).rejects.toThrow('version changed')
    const prepared = await f.edits.prepare(f.session, f.workspace.id, [{ path, expected: version, content: 'new' }])
    await writeFile(join(f.root, path), 'user edit')
    await expect(f.edits.apply(prepared, f.signal)).rejects.toThrow('changed while awaiting approval')
    expect(await readFile(join(f.root, path), 'utf8')).toBe('user edit')
  })
  it('preflights whole batches and rejects traversal, ignore rules, symlinks and sensitive files', async () => {
    const f = await fixture()
    await writeFile(join(f.root, '.gitignore'), 'ignored/\n*.generated.ts\n'); await mkdir(join(f.root, 'ignored'))
    await symlink(f.directory, join(f.root, 'linked'))
    for (const path of ['../outside.ts', '/tmp/outside.ts', 'linked/outside.ts', 'ignored/file.ts', '.env', 'src/key.pem', 'src/thing.generated.ts']) await expect(f.edits.prepare(f.session, f.workspace.id, [{ path, expected: null, content: 'x' }])).rejects.toThrow()
    await expect(f.edits.prepare(f.session, f.workspace.id, [{ path: 'src/config.ts', expected: null, content: 'const key = "sk-abcdefghijklmnopqrstuvwxyz123456"' }])).rejects.toThrow('credentials')
  })
  it('supports recoverable deletion and refuses rollback over newer edits or a different session', async () => {
    const f = await fixture(), path = 'src/app.ts', before = await readFile(join(f.root, path), 'utf8')
    const result = await f.edits.apply(await f.edits.prepare(f.session, f.workspace.id, [{ path, expected: versionOf(before), content: null }]), f.signal)
    await expect(f.edits.revert(randomUUID(), f.workspace.id, result[0].id)).rejects.toThrow('conversation')
    await writeFile(join(f.root, path), 'external replacement')
    await expect(f.edits.revert(f.session, f.workspace.id, result[0].id)).rejects.toThrow('External modification')
  })
  it('does not write after cancellation or revoked workspace access', async () => {
    const f = await fixture(), prepared = await f.edits.prepare(f.session, f.workspace.id, [{ path: 'src/new.ts', expected: null, content: 'new' }])
    const abort = new AbortController(); abort.abort()
    await expect(f.edits.apply(prepared, abort.signal)).rejects.toThrow()
    f.workspaces.disconnect(f.workspace.id)
    await expect(f.edits.apply(prepared, f.signal)).rejects.toThrow('authorize')
    await expect(readFile(join(f.root, 'src/new.ts'))).rejects.toThrow()
  })
  it('keeps directory deletion nonrecursive', async () => {
    const f = await fixture()
    await f.edits.modifyDirectory(f.workspace.id, 'components', false)
    await f.edits.modifyDirectory(f.workspace.id, 'components', true)
    await expect(f.edits.modifyDirectory(f.workspace.id, 'src', true)).rejects.toThrow()
  })
})
describe('request elapsed duration', () => {
  it('formats timestamps including background time and 90 seconds', () => {
    expect(elapsedLabel(10_000, 100_000)).toBe('Worked for 1m and 30s')
    expect(elapsedLabel(10_000, 15_000, true)).toBe('Working for 5s…')
    expect(elapsedLabel(10_000, 5000)).toBe('Worked for 0s')
  })
})
