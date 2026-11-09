// @vitest-environment node
import { mkdtemp, mkdir, rename, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { WorkspaceService } from '../electron/main/ai/workspaceService'
import { createProjectTools, supportsProjectTools } from '../electron/main/ai/projectTools'
import { contextDefaults } from '../shared/context'
import { globMatcher, matchingLines } from '../electron/main/ai/projectSearch'
import type { SourceReference } from '../shared/conversations'
import { FilesystemAccessError, filesystemToolError } from '../electron/main/ai/filesystemErrors'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'athena-tools-'))
  await mkdir(join(root, 'src', 'components'), { recursive: true })
  await mkdir(join(root, 'ignored'))
  await writeFile(join(root, '.gitignore'), 'ignored/\n*.generated.ts\n')
  await writeFile(join(root, 'package.json'), '{"name":"example","dependencies":{"react":"19"}}')
  await writeFile(join(root, 'src', 'auth.ts'), 'export function authenticate(user: string) {\n  return user.length > 0\n}\nexport const unauthenticate = false')
  await writeFile(join(root, 'src', 'components', 'Account.tsx'), 'import { authenticate } from "../auth"\nexport const Account = () => authenticate("hello")')
  await writeFile(join(root, 'ignored', 'internal.ts'), 'excluded')
  await writeFile(join(root, '.env'), 'DO_NOT_SEND=private')
  await writeFile(join(root, 'src', 'config.ts'), 'const key = "sk-abcdefghijklmnopqrstuvwxyz123456"')
  const service = new WorkspaceService(() => true), reference = await service.connect(root)
  const sources: SourceReference[] = []
  const tools = createProjectTools(service, reference.id, reference.name, sources, () => true)
  const call = async (name: string, args: unknown) => JSON.parse(await tools.execute(name, args, new AbortController().signal))
  return { root, service, reference, sources, tools, call }
}

describe('read-only dynamic project tools', () => {
  it('distinguishes policy, approval, OS, missing, invalid, symlink, and read-only failures', () => {
    const classify = (error: unknown) => filesystemToolError(error, 'target', 'read_file', 'full-read-write', 'project')
    expect(classify(new FilesystemAccessError('Approval declined.', 'operation_requires_approval', 'explicit_user_approval')).reason).toBe('operation_requires_approval')
    expect(classify(new FilesystemAccessError('Symlink escape.', 'symlink_escape_denied', 'symlink_boundary')).reason).toBe('symlink_escape_denied')
    expect(classify(Object.assign(new Error('denied'), { code: 'EPERM' }))).toMatchObject({ reason: 'macos_permission_denied', policyRule: null, macOSAccessAttempted: true })
    expect(classify(Object.assign(new Error('missing'), { code: 'ENOENT' })).reason).toBe('file_not_found')
    expect(classify(Object.assign(new Error('not a directory'), { code: 'ENOTDIR' })).reason).toBe('invalid_path')
    expect(classify(Object.assign(new Error('read only'), { code: 'EROFS' })).reason).toBe('readonly_filesystem')
    expect(classify(new FilesystemAccessError('Credentials excluded.', 'filesystem_policy_denied', 'credential_content', '/project/file.json', true))).toMatchObject({ policyRule: 'credential_content', macOSAccessAttempted: true, osCode: null })
    expect(filesystemToolError(Object.assign(new Error('denied'), { code: 'EPERM', path: '/project/file.ts' }), 'file.ts', 'write_file', 'full-read-write', 'project', 'filesystem-write')).toMatchObject({ reason: 'macos_permission_denied', effectiveToolAuthorization: 'filesystem-write', normalizedPath: '/project/file.ts', osCode: 'EPERM' })
  })
  it('searches a directly targeted file as well as directories', async () => {
    const f = await fixture()
    const result = await f.call('search_code', { path: 'src/auth.ts', query: 'authenticate', glob: '', mode: 'symbol', case_sensitive: true, offset: 0 })
    expect(result.matches).toHaveLength(1)
    expect(result.matches[0]).toMatchObject({ path: 'src/auth.ts', line: 1 })
    expect(result.scannedFiles).toBe(1)
    expect((await f.call('search_code', { path: '.env', query: 'PRIVATE', glob: '', mode: 'exact', case_sensitive: true, offset: 0 })).error).toBeTruthy()
  })
  it('reports missing files as missing, not as permission failures', async () => {
    const f = await fixture()
    const missing = await f.call('read_file', { path: 'missing.ts', start_line: 1, end_line: 10 })
    expect(missing).toMatchObject({ reason: 'file_not_found', requestedPath: 'missing.ts', authorizationScope: 'project-only', operation: 'read_file', macOSAccessAttempted: true })
    expect(missing.error).toContain('not found (ENOENT)')
    const denied = await f.call('read_file', { path: '.env', start_line: 1, end_line: 10 })
    expect(denied).toMatchObject({ reason: 'filesystem_policy_denied', requestedPath: '.env', authorizationScope: 'project-only', policyRule: 'project_protected_or_generated_path', macOSAccessAttempted: false })
  })
  it('requires a fresh per-read approval for an explicitly targeted credential-named fixture', async () => {
    const f = await fixture()
    const path = 'src/edge-existing-credentials.json'
    await writeFile(join(f.root, path), '{"access_token":"fixture-token-1234567890"}')
    const input = { path, start_line: 1, end_line: 1 }
    expect(await f.call('read_file', input)).toMatchObject({ reason: 'operation_requires_approval', policyRule: 'credential_file_approval' })
    const approve = vi.fn(async () => {})
    const tools = createProjectTools(f.service, f.reference.id, f.reference.name, [], () => true, 48000, contextDefaults(), async () => {}, approve)
    const call = async () => JSON.parse(await tools.execute('read_file', input, new AbortController().signal))
    expect((await call()).content).toContain('fixture-token-1234567890')
    tools.invalidate?.()
    expect((await call()).content).toContain('fixture-token-1234567890')
    expect(approve).toHaveBeenCalledTimes(2)
    await expect(f.service.readRange(f.reference.id, path, 1, 1)).rejects.toMatchObject({ reason: 'filesystem_policy_denied' })
    const rejectRead = vi.fn(async () => { throw new FilesystemAccessError('Declined.', 'operation_requires_approval', 'credential_file_approval') })
    const declined = createProjectTools(f.service, f.reference.id, f.reference.name, [], () => true, 48000, contextDefaults(), async () => {}, rejectRead)
    expect(JSON.parse(await declined.execute('read_file', input, new AbortController().signal))).toMatchObject({ reason: 'operation_requires_approval', policyRule: 'credential_file_approval' })
    expect(JSON.parse(await declined.execute('read_file', input, new AbortController().signal))).toMatchObject({ reason: 'operation_requires_approval' })
    expect(rejectRead).toHaveBeenCalledOnce()
  })
  it('inspects an explicit dependency without adding it to broad search results', async () => {
    const f = await fixture(), cookies = join(f.root, 'node_modules', 'undici', 'lib', 'web', 'cookies')
    await mkdir(cookies, { recursive: true })
    await writeFile(join(cookies, 'index.js'), 'exports.parseCookie = true')
    await writeFile(join(f.root, '.gitignore'), 'node_modules/\n')
    const path = 'node_modules/undici/lib/web/cookies/index.js'
    expect((await f.call('read_file', { path, start_line: 1, end_line: 1 })).content).toContain('parseCookie')
    expect((await f.call('list_directory', { path: 'node_modules/undici/lib/web/cookies', offset: 0 })).entries.map((entry: { path: string }) => entry.path)).toContain(path)
    expect((await f.call('search_files', { path: '', query: 'cookies', glob: '**/*.js', offset: 0 })).matches).toEqual([])
  })
  it('allows explicit ignored workflow drafts without exposing secrets or escaping the project', async () => {
    const f = await fixture()
    await mkdir(join(f.root, '.tmp'))
    await writeFile(join(f.root, '.gitignore'), '.tmp\nignored/\n')
    await writeFile(join(f.root, '.tmp/plan.md'), 'Approved plan')
    await writeFile(join(f.root, '.tmp/.env'), 'SECRET=fixture')
    await writeFile(join(f.root, '.tmp/notes.md'), 'const key = "sk-abcdefghijklmnopqrstuvwxyz123456"')
    await symlink(join(f.root, 'src/auth.ts'), join(f.root, '.tmp/link.ts'))
    expect((await f.call('read_file', { path: '.tmp/plan.md', start_line: 1, end_line: 10 })).content).toContain('Approved plan')
    expect((await f.call('list_directory', { path: '.tmp', offset: 0 })).entries.map((entry: { path: string }) => entry.path)).toContain('.tmp/plan.md')
    for (const path of ['.tmp/.env', '.tmp/notes.md', '.tmp/link.ts', '.tmp/../src/auth.ts', 'ignored/internal.ts']) {
      expect((await f.call('read_file', { path, start_line: 1, end_line: 10 })).error).toBeTruthy()
    }
  })
  it('rejects unsafe paths before speaking and rechecks access after acknowledgment', async () => {
    const f = await fixture(), before = vi.fn(async () => {})
    let selected = true
    const tools = createProjectTools(f.service, f.reference.id, f.reference.name, [], () => selected, 48000, contextDefaults(), before)
    for (const path of ['.env', '../outside.ts', 'ignored/internal.ts', 'missing.ts']) {
      expect(JSON.parse(await tools.execute('read_file', { path, start_line: 1, end_line: 5 }, new AbortController().signal)).error).toBeTruthy()
    }
    expect(before).not.toHaveBeenCalled()
    before.mockImplementation(async () => { selected = false })
    await expect(tools.execute('read_file', { path: 'src/auth.ts', start_line: 1, end_line: 5 }, new AbortController().signal)).rejects.toThrow('disconnected')
    expect(before).toHaveBeenCalledOnce()
  })
  it('refreshes externally modified content and permits rereading evidence after compaction', async () => {
    const f = await fixture(), args = { path: 'src/auth.ts', start_line: 1, end_line: 4 }
    const before = await f.call('read_file', args)
    expect((await f.call('read_file', args)).notice).toContain('already returned')
    await writeFile(join(f.root, 'src/auth.ts'), 'export const freshContent = true')
    const fresh = await f.call('read_file', args)
    expect(fresh.content).toContain('freshContent'); expect(fresh.version).not.toBe(before.version)
    f.tools.invalidate?.()
    expect((await f.call('read_file', args)).content).toContain('freshContent')
  })
  it('enforces configured file range and search limits without a lifetime byte exhaustion gate', async () => {
    const f = await fixture()
    await writeFile(join(f.root, 'large.ts'), Array.from({ length: 800 }, (_, i) => `export const item${i} = ${i}`).join('\n'))
    const tools = createProjectTools(f.service, f.reference.id, f.reference.name, [], () => true, 80000, { ...contextDefaults(), maxFileReadChars: 1000, maxSearchResults: 5 })
    const run = async (tool: string, args: unknown) => JSON.parse(await tools.execute(tool, args, new AbortController().signal))
    const read = await run('read_file', { path: 'large.ts', start_line: 1, end_line: 400 })
    expect(read.content.length).toBeLessThanOrEqual(1000); expect(read.truncated).toBe(true)
    const search = await run('search_code', { path: '', query: 'export', glob: '**/*.ts', mode: 'exact', case_sensitive: false, offset: 0 })
    expect(search.matches).toHaveLength(5); expect(search.nextOffset).toBe(5)
    for (let i = 0; i < 30; i++) { tools.invalidate?.(); expect((await run('read_file', { path: 'large.ts', start_line: i * 5 + 1, end_line: i * 5 + 40 })).content).toBeTruthy() }
  })
  it('lists nested directories, configuration and metadata without reading every source file', async () => {
    const f = await fixture()
    const root = await f.call('list_directory', { path: '', offset: 0 })
    expect(root.entries.map((entry: { path: string }) => entry.path)).toEqual(['package.json', 'src'])
    const nested = await f.call('list_directory', { path: 'src/components', offset: 0 })
    expect(nested.entries[0]).toMatchObject({ path: 'src/components/Account.tsx', type: 'file', extension: '.tsx' })
    const tree = await f.call('get_project_structure', { path: '', depth: 4 })
    expect(tree.configurationFiles).toContain('package.json')
    expect(tree.entries.some((entry: { path: string }) => entry.path === 'src/components/Account.tsx')).toBe(true)
    const metadata = await f.call('get_file_metadata', { path: 'src/auth.ts' })
    expect(metadata.size).toBeGreaterThan(0); expect(metadata.modifiedAt).toBeTruthy()
    expect(f.sources).toEqual([])
  })
  it('reads previously unseen/new files and exact ranges, and refreshes source contents on follow-up', async () => {
    const f = await fixture()
    await writeFile(join(f.root, 'src', 'new.ts'), '// unseen\nexport const version = 1\n// end')
    const result = await f.call('read_file', { path: 'src/new.ts', start_line: 2, end_line: 2 })
    expect(result.content).toBe('2: export const version = 1')
    expect(f.sources).toEqual([{ workspace: f.reference.name, path: 'src/new.ts', start: 2, end: 2 }])
    await writeFile(join(f.root, 'src', 'new.ts'), '// updated\nexport const version = 2')
    const nextTurn = createProjectTools(f.service, f.reference.id, f.reference.name, [], () => true)
    expect(JSON.parse(await nextTurn.execute('read_file', { path: 'src/new.ts', start_line: 2, end_line: 2 }, new AbortController().signal)).content).toBe('2: export const version = 2')
  })
  it('searches globs, exact content, whole symbols and regular expressions with actual line numbers', async () => {
    const f = await fixture()
    expect((await f.call('search_files', { path: '', query: 'account', glob: '**/*.tsx', offset: 0 })).matches[0].path).toBe('src/components/Account.tsx')
    expect((await f.call('search_code', { path: '', query: 'return user', glob: '**/*.ts', offset: 0, mode: 'exact', case_sensitive: false })).matches[0]).toMatchObject({ path: 'src/auth.ts', line: 2 })
    const symbols = await f.call('search_code', { path: 'src', query: 'authenticate', glob: '*.ts', offset: 0, mode: 'symbol', case_sensitive: true })
    // Globs are project-relative; scope and pattern both constrain results.
    expect(symbols.matches).toEqual([])
    const regex = await f.call('search_code', { path: 'src', query: 'function\\s+authenticate', glob: '**/*.ts', offset: 0, mode: 'regex', case_sensitive: true })
    expect(regex.matches).toEqual([{ path: 'src/auth.ts', line: 1, excerpt: 'export function authenticate(user: string) {' }])
    expect(matchingLines('authenticate\nunauthenticate\nauthenticate()', 'authenticate', 'symbol', true, 100)).toEqual([0, 2])
  })
  it('blocks traversal, symlinks, generated output, ignored files and sensitive contents for direct reads', async () => {
    const f = await fixture(), outside = await mkdtemp(join(tmpdir(), 'athena-tools-outside-'))
    await writeFile(join(outside, 'private.ts'), 'outside content')
    await symlink(outside, join(f.root, 'linked'))
    await writeFile(join(f.root, 'src', '.gitignore'), 'local.ts\n')
    await writeFile(join(f.root, 'src', 'local.ts'), 'ignored locally')
    await writeFile(join(f.root, 'src', 'code.generated.ts'), 'generated')
    for (const path of ['../private.ts', join(outside, 'private.ts'), 'linked/private.ts', '.env', 'ignored/internal.ts', 'src/config.ts', 'src/local.ts', 'src/code.generated.ts']) {
      expect((await f.call('read_file', { path, start_line: 1, end_line: 20 })).error).toBeTruthy()
    }
    expect(f.sources).toEqual([])
    await rename(join(f.root, 'src'), join(f.root, 'old-src'))
    await symlink(outside, join(f.root, 'src'))
    expect((await f.call('list_directory', { path: 'src', offset: 0 })).error).toBeTruthy()
  })
  it('rechecks permission, session association and cancellation before every call', async () => {
    const f = await fixture()
    let active = true
    const scoped = createProjectTools(f.service, f.reference.id, f.reference.name, [], () => active)
    active = false
    await expect(scoped.execute('read_file', { path: 'package.json', start_line: 1, end_line: 2 }, new AbortController().signal)).rejects.toThrow('disconnected')
    const abort = new AbortController(); abort.abort()
    await expect(f.tools.execute('list_directory', { path: '', offset: 0 }, abort.signal)).rejects.toThrow('cancelled')
    f.service.disconnect(f.reference.id)
    await expect(f.call('list_directory', { path: '', offset: 0 })).rejects.toThrow('disconnected')
  })
  it('validates schemas, refuses unknown tools and suppresses duplicate content', async () => {
    const f = await fixture()
    expect((await f.call('exec', { command: 'ls' })).error).toContain('Unknown')
    expect((await f.call('read_file', { path: 'src/auth.ts', start_line: 0, end_line: 4 })).error).toContain('Invalid')
    expect((await f.call('read_file', { path: 'src/auth.ts', start_line: 5, end_line: 1 })).error).toContain('end_line')
    const args = { path: 'src/auth.ts', start_line: 1, end_line: 4 }
    expect((await f.call('read_file', args)).content).toContain('authenticate')
    expect((await f.call('read_file', args)).notice).toContain('already returned')
  })
  it('interrupts a stalled filesystem operation at the tool deadline and never records late evidence', async () => {
    const f = await fixture(), timer = new AbortController()
    let finish!: (value: Awaited<ReturnType<WorkspaceService['readRange']>>) => void
    vi.spyOn(f.service, 'readRange').mockReturnValue(new Promise((resolve) => { finish = resolve }))
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timer.signal)
    try {
      const pending = f.call('read_file', { path: 'src/auth.ts', start_line: 1, end_line: 3 })
      timer.abort()
      expect((await pending).error).toContain('timed out')
      finish({ path: 'src/auth.ts', content: '1: late content', version: 'a'.repeat(64), start: 1, end: 1, totalLines: 1, truncated: false })
      await Promise.resolve()
      expect(f.sources).toEqual([])
    } finally { timeout.mockRestore() }
  })
  it('paginates recursive search and directory listings without repeating results', async () => {
    const f = await fixture()
    await Promise.all(Array.from({ length: 105 }, (_, index) => writeFile(join(f.root, 'src', `part${String(index).padStart(3, '0')}.ts`), `export const symbol${index} = true`)))
    const first = await f.call('search_files', { path: 'src', query: 'part', glob: '**/*.ts', offset: 0 })
    expect(first.matches.length).toBeLessThanOrEqual(30)
    const paths: string[] = first.matches.map((entry: { path: string }) => entry.path)
    let offset = first.nextOffset
    while (offset !== null) {
      const page = await f.call('search_files', { path: 'src', query: 'part', glob: '**/*.ts', offset })
      expect(page.nextOffset === null || page.nextOffset > offset).toBe(true)
      paths.push(...page.matches.map((entry: { path: string }) => entry.path)); offset = page.nextOffset
    }
    expect(paths).toHaveLength(105); expect(new Set(paths).size).toBe(105)
    const entries: string[] = []; offset = 0
    while (offset !== null) { const page = await f.call('list_directory', { path: 'src', offset }); entries.push(...page.entries.map((entry: { path: string }) => entry.path)); offset = page.nextOffset }
    expect(new Set(entries).size).toBe(108)
  })
  it('bounds large file ranges, source references and result sizes', async () => {
    const f = await fixture()
    await writeFile(join(f.root, 'large.ts'), Array.from({ length: 10_000 }, (_, index) => `export const item${index} = ${index}`).join('\n'))
    const result = await f.call('read_file', { path: 'large.ts', start_line: 500, end_line: 2000 })
    expect(result.start).toBe(500); expect(result.end).toBeLessThanOrEqual(899)
    expect(result.totalLines).toBe(10_000); expect(result.truncated).toBe(true)
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(24_000)
    expect(f.sources[0].end).toBe(result.end)
  })
  it('bounds regex execution and safely handles glob metacharacters', () => {
    expect(() => matchingLines('a'.repeat(100_000) + '!', '(a+)+$', 'regex', true, 100)).toThrow('deadline')
    expect(() => matchingLines('abc', '[', 'regex', true, 100)).toThrow('invalid')
    expect(globMatcher('**/*.tsx')('Account.tsx')).toBe(true)
    expect(globMatcher('**/*.tsx')('src/Account.tsx')).toBe(true)
    expect(globMatcher('src/*')('src/deep/file.ts')).toBe(false)
    expect(globMatcher('src/**/file?.ts')('src/deep/file1.ts')).toBe(true)
    expect(globMatcher('[x].ts')('[x].ts')).toBe(true)
  })
  it('only advertises function calling for known compatible models', () => {
    for (const model of ['gpt-4.1', 'gpt-5.6-luna', 'gpt-6-astra', 'o3']) expect(supportsProjectTools(model)).toBe(true)
    for (const model of [null, 'unknown', 'gpt-4o-audio', 'gpt-5-chat-latest']) expect(supportsProjectTools(model)).toBe(false)
  })
})
