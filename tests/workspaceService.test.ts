// @vitest-environment node
import { mkdtemp, mkdir, realpath, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import { FULL_MAC_WORKSPACE_ID, developerConfigurationPath, protectedMacPath, sensitiveContent, sensitivePath, WorkspaceService } from '../electron/main/ai/workspaceService'
import { FilesystemAccessError } from '../electron/main/ai/filesystemErrors'
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>()
  return { ...fs, lstat: vi.fn(fs.lstat) }
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'athena-project-'))
  await mkdir(join(root, 'src')); await mkdir(join(root, 'node_modules')); await mkdir(join(root, 'ignored'))
  await writeFile(join(root, '.gitignore'), 'ignored/\nnode_modules/\n*.generated.ts\n')
  await writeFile(join(root, '.env'), 'PRIVATE=secret')
  await writeFile(join(root, 'src', 'auth.ts'), 'export function authenticate(user: string) {\n  return user.length > 0\n}\n')
  await writeFile(join(root, 'src', 'key.ts'), 'const key = "sk-abcdefghijklmnopqrstuvwxyz123456"')
  await writeFile(join(root, 'src', 'ignored.generated.ts'), 'hidden')
  await writeFile(join(root, 'ignored', 'hidden.ts'), 'hidden')
  await writeFile(join(root, 'node_modules', 'dependency.ts'), 'hidden')
  await writeFile(join(root, 'README.md'), '# Auth project\nSee src/auth.ts')
  return root
}
describe('authorized read-only repository indexing', () => {
  it.runIf(process.platform === 'darwin')('normalizes macOS system aliases without allowing arbitrary symlink escapes', async () => {
    const root = await fixture(), service = new WorkspaceService(() => true, undefined, () => 'full-read-write')
    const project = await service.connect(root)
    const canonical = await realpath(root), aliased = canonical.replace(/^\/private\/var\//, '/var/')
    expect((await service.readRange(project.id, join(aliased, 'README.md'), 1, 2)).content).toContain('Auth project')
    expect((await service.editTarget(project.id, join(aliased, 'new.md'))).absolute).toBe(join(canonical, 'new.md'))
    await symlink(join(root, 'README.md'), join(root, 'alias.md'))
    await expect(service.readRange(project.id, join(aliased, 'alias.md'), 1, 2)).rejects.toMatchObject({ reason: 'symlink_escape_denied' })
    await expect(service.readRange(project.id, join(aliased, '.env'), 1, 2)).rejects.toMatchObject({ reason: 'filesystem_policy_denied' })
  })
  it('preserves project grants and OS error codes after a temporary root permission failure', async () => {
    const root = await fixture(), service = new WorkspaceService(() => true), project = await service.connect(root)
    const fs = await import('node:fs/promises')
    const stat = vi.mocked(fs.lstat).mockRejectedValueOnce(Object.assign(new Error('Permission denied'), { code: 'EACCES' }))
    try {
      await expect(service.commandRoot(project.id)).rejects.toMatchObject({ code: 'EACCES' })
      expect(service.authorized(project.id)).toBe(true)
    } finally { stat.mockClear() }
    expect((await service.readRange(project.id, 'README.md', 1, 2)).content).toContain('Auth project')
  })
  it.runIf(Boolean(process.env.ATHENA_PROJECT_ROOT))('reads the selected project installed undici cookies files', async () => {
    const service = new WorkspaceService(() => true)
    const project = await service.connect(process.env.ATHENA_PROJECT_ROOT!)
    const path = 'node_modules/undici/lib/web/cookies'
    const entries = await service.directory(project.id, path)
    expect(entries.entries.map((entry) => entry.path)).toContain(`${path}/index.js`)
    expect((await service.readRange(project.id, `${path}/index.js`, 1, 10)).content).toContain('parseSetCookie')
  })
  it.runIf(Boolean(process.env.ATHENA_PROJECT_ROOT))('reproduces the real fixture policy denial without opening or exposing its contents', async () => {
    const service = new WorkspaceService(() => true, undefined, () => 'full-read-write')
    const project = await service.connect(process.env.ATHENA_PROJECT_ROOT!)
    const path = 'skills/platform-init/fixtures/edge-existing-credentials.json'
    await expect(service.metadata(project.id, path)).rejects.toMatchObject({
      reason: 'filesystem_policy_denied', policyRule: 'credential_filename', macOSAccessAttempted: false,
      normalizedPath: join(await realpath(process.env.ATHENA_PROJECT_ROOT!), path),
    })
  })
  it('keeps project-only boundaries, then allows explicit global paths with a full grant', async () => {
    const root = await fixture(), outside = await realpath(await mkdtemp(join(tmpdir(), 'athena-global-')))
    await writeFile(join(outside, 'notes.md'), 'ordinary notes')
    await mkdir(join(outside, '.claude'))
    await mkdir(join(outside, '.codex'))
    await writeFile(join(outside, '.claude', 'instructions.md'), '# Instructions')
    await writeFile(join(outside, '.claude', '.credentials.json'), '{"access_token":"fixture-token-1234567890"}')
    await writeFile(join(outside, '.codex', 'auth.json'), '{"access_token":"fixture-token-abcdefghij"}')
    await symlink(join(outside, '.env'), join(outside, '.claude', 'linked-secret'))
    await writeFile(join(outside, '.env'), 'SECRET=hidden')
    await mkdir(join(root, '.claude'))
    await writeFile(join(root, '.claude', 'credentials.json'), '{"access_token":"fixture-project-token-123456"}')
    let mode: 'project-only' | 'full-read-only' | 'full-read-write' = 'project-only'
    const service = new WorkspaceService(() => true, undefined, () => mode)
    const project = await service.connect(root)
    await expect(service.readRange(project.id, join(outside, 'notes.md'), 1, 2)).rejects.toThrow()
    mode = 'full-read-only'
    expect((await service.readRange(project.id, join(outside, 'notes.md'), 1, 2)).content).toContain('ordinary notes')
    expect((await service.readRange(project.id, join(outside, '.claude', 'instructions.md'), 1, 2)).content).toContain('Instructions')
    const claude = join(outside, '.claude', '.credentials.json'), codex = join(outside, '.codex', 'auth.json')
    expect((await service.directory(project.id, join(outside, '.claude'))).entries.map((entry) => entry.path)).toContain(claude)
    expect((await service.readRange(project.id, claude, 1, 2)).content).toContain('fixture-token-1234567890')
    expect((await service.readRange(project.id, codex, 1, 2)).content).toContain('fixture-token-abcdefghij')
    expect((await service.readRange(project.id, '.claude/credentials.json', 1, 2)).content).toContain('fixture-project-token-123456')
    await expect(service.readRange(project.id, join(outside, '.claude', 'linked-secret'), 1, 2)).rejects.toThrow('Symbolic links')
    expect((await service.search(project.id, { path: join(outside, '.claude'), query: 'access_token', glob: '**/*', mode: 'exact', caseSensitive: false, offset: 0 })).matches.map((item) => item.path)).toContain(claude)
    await expect(service.readRange(project.id, join(outside, '.env'), 1, 2)).rejects.toThrow()
    await expect(service.editTarget(project.id, join(outside, 'notes.md'))).rejects.toThrow('Read Only')
    mode = 'full-read-write'
    expect((await service.editTarget(project.id, join(outside, 'notes.md'))).absolute).toBe(join(outside, 'notes.md'))
    expect((await service.editTarget(project.id, claude)).absolute).toBe(claude)
    expect(service.authorized(FULL_MAC_WORKSPACE_ID)).toBe(true)
    expect((await service.readRange(FULL_MAC_WORKSPACE_ID, join(outside, 'notes.md'), 1, 2)).content).toContain('ordinary notes')
    mode = 'project-only'
    expect(service.authorized(FULL_MAC_WORKSPACE_ID)).toBe(false)
    await expect(service.readRange(project.id, join(outside, 'notes.md'), 1, 2)).rejects.toThrow()
  })
  it('keeps credential-named fixtures protected under Full Mac while allowing ordinary fixtures and new files', async () => {
    const root = await fixture(), outside = await realpath(await mkdtemp(join(tmpdir(), 'athena-fixture-')))
    await mkdir(join(root, 'skills/platform-init/fixtures'), { recursive: true })
    const protectedFixture = 'skills/platform-init/fixtures/edge-existing-credentials.json'
    const linkedFixture = 'skills/platform-init/fixtures/linked-credentials.json'
    const ordinaryFixture = 'skills/platform-init/fixtures/edge-existing.json'
    await writeFile(join(root, protectedFixture), '{"access_token":"fixture-token-1234567890"}')
    await symlink(join(root, protectedFixture), join(root, linkedFixture))
    await writeFile(join(root, ordinaryFixture), '{"example":true}')
    await writeFile(join(outside, 'notes.md'), 'outside')
    let mode: 'project-only' | 'full-read-only' | 'full-read-write' = 'full-read-write'
    const service = new WorkspaceService(() => true, undefined, () => mode), project = await service.connect(root)
    expect((await service.readRange(project.id, ordinaryFixture, 1, 1)).content).toContain('example')
    expect((await service.readRange(project.id, join(outside, 'notes.md'), 1, 1)).content).toContain('outside')
    await expect(service.readRange(project.id, protectedFixture, 1, 1)).rejects.toMatchObject({ reason: 'filesystem_policy_denied', policyRule: 'credential_filename', macOSAccessAttempted: false })
    await expect(service.metadata(project.id, protectedFixture)).rejects.toBeInstanceOf(FilesystemAccessError)
    const approved = await service.withApprovedCredentialRead(project.id, protectedFixture, () => service.readRange(project.id, protectedFixture, 1, 1))
    expect(approved.content).toContain('fixture-token-1234567890')
    await expect(service.withApprovedCredentialRead(project.id, linkedFixture, () => service.readRange(project.id, linkedFixture, 1, 1))).rejects.toMatchObject({ reason: 'symlink_escape_denied' })
    await expect(service.readRange(project.id, protectedFixture, 1, 1)).rejects.toMatchObject({ policyRule: 'credential_filename' })
    await service.withApprovedCredentialRead(project.id, protectedFixture, async () => {
      await expect(service.readRange(project.id, '.env', 1, 1)).rejects.toMatchObject({ policyRule: 'environment_file' })
      await expect(service.readRange(project.id, ordinaryFixture, 1, 1)).resolves.toMatchObject({ path: ordinaryFixture })
    })
    await expect(service.withApprovedCredentialRead(project.id, '.env', () => service.readRange(project.id, '.env', 1, 1))).rejects.toMatchObject({ policyRule: 'credential_approval_scope' })
    expect((await service.editTarget(project.id, join(outside, 'new.md'))).absolute).toBe(join(outside, 'new.md'))
    mode = 'full-read-only'
    expect((await service.withApprovedCredentialRead(project.id, protectedFixture, () => service.readRange(project.id, protectedFixture, 1, 1))).content).toContain('fixture-token-1234567890')
    await expect(service.editTarget(project.id, join(outside, 'new.md'))).rejects.toThrow('Read Only')
    mode = 'project-only'
    expect((await service.withApprovedCredentialRead(project.id, protectedFixture, () => service.readRange(project.id, protectedFixture, 1, 1))).content).toContain('fixture-token-1234567890')
    await expect(service.readRange(project.id, join(outside, 'notes.md'), 1, 1)).rejects.toMatchObject({ reason: 'invalid_path' })
  })
  it.runIf(Boolean(process.env.ATHENA_PROJECT_ROOT))('classifies the existing platform-init credential fixture without reading its contents', async () => {
    const service = new WorkspaceService(() => true, undefined, () => 'full-read-write')
    const project = await service.connect(process.env.ATHENA_PROJECT_ROOT!)
    const path = 'skills/platform-init/fixtures/edge-existing-credentials.json'
    await expect(service.metadata(project.id, path)).rejects.toMatchObject({ reason: 'filesystem_policy_denied', policyRule: 'credential_filename', macOSAccessAttempted: false })
    const inspected = await service.withApprovedCredentialRead(project.id, path, () => service.readRange(project.id, path, 1, 1))
    expect(inspected.content.length).toBeGreaterThan(0)
    await expect(service.metadata(project.id, path)).rejects.toMatchObject({ reason: 'filesystem_policy_denied' })
  })
  it('requires opt-in and explicit folder authorization, never authorizes a saved name', async () => {
    let allowed = false
    const service = new WorkspaceService(() => allowed), root = await fixture()
    await expect(service.connect(root)).rejects.toThrow('Personal File Access')
    allowed = true; const workspace = await service.connect(root)
    expect(service.authorized(workspace.id)).toBe(true)
    expect(new WorkspaceService(() => true).authorized(workspace.id)).toBe(false)
    allowed = false; await expect(service.browse(workspace.id, '', 0)).rejects.toThrow('Personal File Access')
    allowed = true; await expect(service.browse(workspace.id, '', 0)).rejects.toThrow('authorize')
  })
  it('excludes secrets, .gitignore files, generated output, symlinks and traversal', async () => {
    const root = await fixture(), outside = await mkdtemp(join(tmpdir(), 'athena-outside-'))
    await writeFile(join(outside, 'outside.ts'), 'not authorized')
    await symlink(outside, join(root, 'linked'))
    await symlink(join(outside, 'outside.ts'), join(root, 'src', 'escape.ts'))
    const service = new WorkspaceService(() => true), workspace = await service.connect(root)
    const result = await service.browse(workspace.id, '', 0)
    expect(result.files.map((file) => file.path).sort()).toEqual(['README.md', 'src/auth.ts'])
    for (const path of ['../outside.ts', '/etc/passwd', 'src/escape.ts', '.env', 'ignored/hidden.ts', 'src/key.ts']) await expect(service.source(workspace.id, path)).rejects.toThrow()
    service.disconnect(workspace.id); await expect(service.source(workspace.id, 'src/auth.ts')).rejects.toThrow('authorize')
  })
  it('allows explicit dependency inspection without indexing packages or following escaped symlinks', async () => {
    const root = await fixture(), outside = await mkdtemp(join(tmpdir(), 'athena-outside-'))
    const cookies = join(root, 'node_modules', 'undici', 'lib', 'web', 'cookies')
    await mkdir(cookies, { recursive: true })
    await writeFile(join(cookies, 'index.js'), 'module.exports = { parseCookie: true }\n')
    await mkdir(join(root, 'node_modules', 'undici', 'dist'))
    await writeFile(join(root, 'node_modules', 'undici', 'dist', 'bundle.js'), 'exports.bundle = true')
    await mkdir(join(root, 'node_modules', '.bin'))
    await symlink(join(cookies, 'index.js'), join(root, 'node_modules', '.bin', 'cookie-tool'))
    await writeFile(join(outside, 'outside.js'), 'outside')
    await symlink(join(outside, 'outside.js'), join(root, 'node_modules', 'escaped.js'))
    await writeFile(join(root, 'node_modules', 'Cookies'), 'browser secrets')
    await symlink(join(root, 'node_modules', 'Cookies'), join(root, 'node_modules', 'aliased-cookie.js'))
    await writeFile(join(root, 'node_modules', '.env'), 'SECRET=hidden')
    const service = new WorkspaceService(() => true), project = await service.connect(root)
    expect((await service.directory(project.id, 'node_modules/undici/lib/web/cookies')).entries.map((entry) => entry.path)).toContain('node_modules/undici/lib/web/cookies/index.js')
    expect((await service.readRange(project.id, 'node_modules/undici/lib/web/cookies/index.js', 1, 1)).content).toContain('parseCookie')
    expect((await service.readRange(project.id, 'node_modules/undici/dist/bundle.js', 1, 1)).content).toContain('bundle')
    await expect(service.editTarget(project.id, 'node_modules/undici/dist/bundle.js')).rejects.toThrow('read-only')
    expect((await service.readRange(project.id, 'node_modules/.bin/cookie-tool', 1, 1)).content).toContain('parseCookie')
    await expect(service.readRange(project.id, 'node_modules/escaped.js', 1, 1)).rejects.toThrow('Symbolic links')
    await expect(service.readRange(project.id, 'node_modules/Cookies', 1, 1)).rejects.toThrow('credential file')
    await expect(service.readRange(project.id, 'node_modules/aliased-cookie.js', 1, 1)).rejects.toThrow('credential file')
    await expect(service.readRange(project.id, 'node_modules/.env', 1, 1)).rejects.toThrow('policy')
    expect((await service.browse(project.id, '', 0)).files.map((file) => file.path)).not.toContain('node_modules/undici/lib/web/cookies/index.js')
    const full = new WorkspaceService(() => true, undefined, () => 'full-read-only')
    const fullProject = await full.connect(root)
    expect((await full.readRange(fullProject.id, 'node_modules/undici/lib/web/cookies/index.js', 1, 1)).content).toContain('parseCookie')
  })
  it('searches code with exact line references and refreshes changed files before retrieval', async () => {
    const root = await fixture(), service = new WorkspaceService(() => true), workspace = await service.connect(root)
    expect((await service.browse(workspace.id, 'return user', 0)).files[0]).toMatchObject({ path: 'src/auth.ts', line: 2 })
    await writeFile(join(root, 'src', 'auth.ts'), '// changed\nexport function login() { return true }')
    const result = await service.retrieve([workspace.id], 'Where is login implemented?')
    expect(result.text).toContain('2: export function login()')
    expect(result.text).not.toContain('authenticate')
    expect(result.sources).toContainEqual({ workspace: workspace.name, path: 'src/auth.ts', start: 1, end: 2 })
  })
  it('blocks a previously authorized directory replaced with a symlink', async () => {
    const root = await fixture(), service = new WorkspaceService(() => true), workspace = await service.connect(root)
    const { rename } = await import('node:fs/promises')
    await rename(join(root, 'src'), join(root, 'original'))
    await symlink(join(root, 'original'), join(root, 'src'))
    await expect(service.source(workspace.id, 'src/auth.ts')).rejects.toThrow()
  })
  it('recognizes common secret paths and embedded credentials', () => {
    for (const name of ['.env.local', '.ssh/id_rsa', 'credentials.json', 'private-key.pem', '.npmrc']) expect(sensitivePath(name)).toBe(true)
    expect(sensitiveContent('-----BEGIN PRIVATE KEY-----')).toBe(true)
    expect(sensitivePath('src/auth.ts')).toBe(false)
    const home = '/fixture/home'
    expect(developerConfigurationPath(`${home}/.claude/.credentials.json`)).toBe(true)
    expect(developerConfigurationPath(`${home}/.codex/auth.json`)).toBe(true)
    expect(developerConfigurationPath(`${home}/other/.claude/.credentials.json`)).toBe(true)
    expect(developerConfigurationPath(`${home}/.claude-other/.credentials.json`)).toBe(false)
    expect(protectedMacPath(`${home}/.claude/.credentials.json`)).toBe(false)
    expect(protectedMacPath(`${home}/other/credentials.json`)).toBe(true)
  })
})
