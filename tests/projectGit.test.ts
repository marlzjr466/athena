// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { ProjectGitService, countGitChanges } from '../electron/main/ai/projectGitService'
import { WorkspaceService } from '../electron/main/ai/workspaceService'
import { ChatController } from '../electron/main/ai/chatController'
import { ConversationRepository } from '../electron/main/ai/conversationRepository'
import { contextDefaults } from '../shared/context'
import type { ProjectGitCommand, ProjectGitState } from '../shared/projectGit'
vi.mock('../electron/main/logger', () => ({ log: vi.fn() }))
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })
async function fixture(initialize = true) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'athena-branch-test-'))), root = join(dir, 'project')
  await mkdir(root)
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' }, stdio: ['ignore', 'pipe', 'pipe'] })
  if (initialize) { git('init', '-b', 'main'); await writeFile(join(root, 'a.txt'), 'base\n'); git('add', '.'); git('commit', '-m', 'fixture only'); git('branch', 'feature/one'); git('branch', 'feature/two') }
  const workspaces = new WorkspaceService(() => true), workspace = await workspaces.connect(root)
  const chat = new ChatController({ provider: async () => { throw new Error('No model calls in Git tests') }, authorized: id => workspaces.authorized(id), changed: vi.fn(), phase: vi.fn() }, new ConversationRepository(join(dir, 'storage')))
  chat.addWorkspace(chat.current().id, workspace)
  const service = new ProjectGitService(chat, workspaces)
  const target = { sessionId: chat.current().id, workspaceId: workspace.id }
  const run = (input: Partial<ProjectGitCommand> & { action: ProjectGitCommand['action'] }, notify = vi.fn()) => service.run({ ...target, ...input }, 'test', notify)
  cleanups.push(async () => { service.dispose(); chat.dispose(); await rm(dir, { recursive: true, force: true }) })
  return { root, dir, git, chat, service, workspaces, workspace, target, run }
}
describe('authorized project branch integration — real Git fixtures', () => {
  it('verifies mutations with a fresh snapshot instead of a watcher still reading the old branch', async () => {
    const f = await fixture(), subscriptionId = randomUUID()
    const before = (await f.run({ action: 'watch', subscriptionId })).state!
    const internal = f.service as unknown as { repositories: Map<string, { pending?: Promise<ProjectGitState> }>; git(root: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> }
    const original = internal.git.bind(internal)
    vi.spyOn(internal, 'git').mockImplementation(async (root, args) => {
      const result = await original(root, args)
      if (args.includes('switch') && result.code === 0) {
        const entry = internal.repositories.get(f.root)!
        entry.pending = new Promise<ProjectGitState>(resolve => setTimeout(() => resolve(before), 20)).finally(() => { entry.pending = undefined })
      }
      return result
    })
    expect(await f.run({ action: 'create', branch: 'feature/voice', expectedHead: before.head })).toMatchObject({ ok: true, state: { branch: 'feature/voice' } })
    expect(f.git('branch', '--show-current').trim()).toBe('feature/voice')
  })
  it('detects root, local branches and staged, unstaged, untracked files without counting renames twice', async () => {
    const f = await fixture()
    await writeFile(join(f.root, 'a.txt'), 'staged\n'); f.git('add', 'a.txt'); await writeFile(join(f.root, 'a.txt'), 'unstaged\n')
    await writeFile(join(f.root, 'untracked.txt'), 'new')
    const result = await f.run({ action: 'status' })
    expect(result).toMatchObject({ ok: true, state: { repository: true, root: f.root, branch: 'main', branches: ['feature/one', 'feature/two', 'main'], changedFiles: 2 } })
    expect(countGitChanges('R  new name\0old name\0?? line\nbreak\0')).toBe(2)
  })
  it('switches and creates with all dirty state preserved, in Ask mode', async () => {
    const f = await fixture()
    await writeFile(join(f.root, 'a.txt'), 'staged\n'); f.git('add', 'a.txt'); await writeFile(join(f.root, 'a.txt'), 'unstaged\n'); await writeFile(join(f.root, 'other'), 'untracked')
    const status = f.git('status', '--porcelain=v1', '-z')
    const before = (await f.run({ action: 'status' })).state!
    const switched = await f.run({ action: 'switch', branch: 'feature/one', expectedHead: before.head })
    expect(switched).toMatchObject({ ok: true, state: { branch: 'feature/one', changedFiles: 2 } })
    const created = await f.run({ action: 'create', branch: 'feature/new', expectedHead: switched.state!.head })
    expect(created).toMatchObject({ ok: true, state: { branch: 'feature/new', changedFiles: 2 } })
    expect(f.git('status', '--porcelain=v1', '-z')).toBe(status)
    expect(f.git('show', ':a.txt')).toBe('staged\n'); expect(await readFile(join(f.root, 'a.txt'), 'utf8')).toBe('unstaged\n')
  })
  it('blocks overwritten changes and reports Git’s explanation', async () => {
    const f = await fixture()
    f.git('switch', 'feature/one'); await writeFile(join(f.root, 'a.txt'), 'different\n'); f.git('commit', '-am', 'fixture branch'); f.git('switch', 'main')
    await writeFile(join(f.root, 'a.txt'), 'keep me\n')
    const before = (await f.run({ action: 'status' })).state!
    expect(await f.run({ action: 'switch', branch: 'feature/one', expectedHead: before.head })).toMatchObject({ ok: false, message: expect.stringMatching(/overwritten/) })
    expect(f.git('branch', '--show-current').trim()).toBe('main'); expect(await readFile(join(f.root, 'a.txt'), 'utf8')).toBe('keep me\n')
  })
  it('preserves untracked files that would be overwritten', async () => {
    const f = await fixture(); f.git('switch', 'feature/one'); await writeFile(join(f.root, 'new.txt'), 'tracked'); f.git('add', '.'); f.git('commit', '-m', 'fixture'); f.git('switch', 'main')
    await writeFile(join(f.root, 'new.txt'), 'untracked')
    expect(await f.run({ action: 'switch', branch: 'feature/one', expectedHead: (await f.run({ action: 'status' })).state!.head })).toMatchObject({ ok: false, message: expect.stringMatching(/untracked/) })
    expect(await readFile(join(f.root, 'new.txt'), 'utf8')).toBe('untracked')
  })
  it('validates names natively, prevents duplicates and option/reflog injection', async () => {
    const f = await fixture(), head = (await f.run({ action: 'status' })).state!.head
    for (const branch of ['bad..name', '-C', '@{-1}', 'main', 'name space', 'bad\nname']) expect((await f.run({ action: 'create', branch, expectedHead: head })).ok).toBe(false)
    expect(f.git('branch', '--show-current').trim()).toBe('main')
  })
  it('preserves ignored local files instead of Git’s default overwrite-ignore behavior', async () => {
    const f = await fixture()
    f.git('switch', 'feature/one'); await writeFile(join(f.root, 'local.txt'), 'tracked'); f.git('add', '.'); f.git('commit', '-m', 'fixture'); f.git('switch', 'main')
    await writeFile(join(f.root, '.gitignore'), 'local.txt\n'); await writeFile(join(f.root, 'local.txt'), 'keep ignored')
    const state = (await f.run({ action: 'status' })).state!
    expect((await f.run({ action: 'switch', branch: 'feature/one', expectedHead: state.head })).ok).toBe(false)
    expect(await readFile(join(f.root, 'local.txt'), 'utf8')).toBe('keep ignored')
  })
  it('rejects stale HEAD, Read Only, explicit command denial, revoked authorization and wrong conversations', async () => {
    const f = await fixture(), change = { action: 'switch' as const, branch: 'feature/one', expectedHead: (await f.run({ action: 'status' })).state!.head }
    expect((await f.run({ ...change, expectedHead: 'stale' })).ok).toBe(false)
    f.chat.current().config.agentMode = 'read-only'; expect((await f.run(change)).message).toMatch(/Read Only/)
    f.chat.current().config.agentMode = 'full-access'; f.chat.current().config.contextSettings = { ...contextDefaults(), allowProjectCommands: false }; expect((await f.run(change)).ok).toBe(false)
    f.chat.current().config.contextSettings!.allowProjectCommands = true
    expect((await f.run({ ...change, sessionId: randomUUID() })).ok).toBe(false)
    f.workspaces.disconnect(f.workspace.id); expect((await f.run(change)).ok).toBe(false)
  })
  it('supports detached HEAD, new branches from detached HEAD, and non-repositories', async () => {
    const f = await fixture(); f.git('switch', '--detach', 'HEAD')
    const state = (await f.run({ action: 'status' })).state!
    expect(state.branch).toBeUndefined(); expect(state.detached).toHaveLength(10)
    expect((await f.run({ action: 'create', branch: 'detached-child', expectedHead: state.head })).state?.branch).toBe('detached-child')
    const non = await fixture(false); expect((await non.run({ action: 'status' })).state?.repository).toBe(false)
  })
  it('handles occupied worktrees and does not expand a subdirectory grant', async () => {
    const f = await fixture(); f.git('worktree', 'add', join(f.dir, 'linked'), 'feature/one')
    expect((await f.run({ action: 'switch', branch: 'feature/one', expectedHead: (await f.run({ action: 'status' })).state!.head })).message).toMatch(/worktree|already (?:checked out|used)/)
    const nested = join(f.root, 'nested'); await mkdir(nested); const workspace = await f.workspaces.connect(nested); f.chat.current().workspaces = [workspace]
    const result = await f.run({ action: 'status', workspaceId: workspace.id }); expect(result.state?.mutationBlocked).toMatch(/repository root/)
    expect((await f.run({ action: 'switch', workspaceId: workspace.id, branch: 'feature/two', expectedHead: result.state!.head })).ok).toBe(false)
  })
  it('observes external branch creation/switches and isolates repositories; releases watchers', async () => {
    const f = await fixture(), other = await fixture(), notify = vi.fn(), otherNotify = vi.fn(), subscriptionId = randomUUID()
    await f.run({ action: 'watch', subscriptionId }, notify); await other.run({ action: 'watch', subscriptionId: randomUUID() }, otherNotify)
    const otherEvents = otherNotify.mock.calls.length
    f.git('switch', '-c', 'external')
    await vi.waitFor(() => expect(notify.mock.lastCall?.[0].state?.branch).toBe('external'), { timeout: 4000 })
    expect(otherNotify).toHaveBeenCalledTimes(otherEvents)
    await f.run({ action: 'unwatch', subscriptionId }); expect((f.service as unknown as { repositories: Map<string, unknown> }).repositories.size).toBe(0)
  })
  it('protects active executions, cancels before another tool after external HEAD changes, preserves checkpoints', async () => {
    const f = await fixture(), abort = new AbortController(), interrupt = vi.spyOn(f.chat, 'interruptWorkspace')
    const assert = await f.service.guard(f.target.sessionId, f.target.workspaceId, abort.signal)
    expect((await f.run({ action: 'switch', branch: 'feature/one', expectedHead: (await f.run({ action: 'status' })).state!.head })).message).toMatch(/Stop active/)
    f.git('switch', 'feature/two')
    expect(assert).toThrow(/branch changed/); expect(interrupt).toHaveBeenCalledWith(f.workspace.id, expect.stringMatching(/Completed work is preserved/))
    abort.abort()
  })
  it('does not leak a watcher when the project closes during initial authorization', async () => {
    const f = await fixture(), subscriptionId = randomUUID()
    let resolveRoot!: (root: string) => void
    vi.spyOn(f.workspaces, 'authorizedRoot').mockImplementationOnce(() => new Promise(resolve => { resolveRoot = resolve }))
    const watching = f.run({ action: 'watch', subscriptionId })
    await f.run({ action: 'unwatch', subscriptionId }); resolveRoot(f.root); await watching
    expect((f.service as unknown as { repositories: Map<string, unknown> }).repositories.size).toBe(0)
  })
  it('does not execute project hooks or configured content filters', async () => {
    const f = await fixture(), marker = join(f.dir, 'hook-ran')
    await writeFile(join(f.root, '.git/hooks/post-checkout'), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 })
    expect((await f.run({ action: 'switch', branch: 'feature/one', expectedHead: (await f.run({ action: 'status' })).state!.head })).ok).toBe(true)
    await expect(readFile(marker)).rejects.toThrow()
    f.git('config', 'filter.unsafe.clean', `touch '${marker}'`)
    const state = (await f.run({ action: 'status' })).state!
    expect(state.mutationBlocked).toMatch(/filters/); expect(state.changedFiles).toBeUndefined()
    expect((await f.run({ action: 'switch', branch: 'main', expectedHead: state.head })).ok).toBe(false)
    await expect(readFile(marker)).rejects.toThrow()
  })
  it('interrupts a real active controller turn with a resumable checkpoint on external branch change', async () => {
    const f = await fixture(); let ready = false, service: ProjectGitService
    const chat = new ChatController({
      provider: async () => ({ testConnection: async () => true, async *streamMessage(_messages, options) { await new Promise<void>(resolve => { if (options!.signal!.aborted) resolve(); else options!.signal!.addEventListener('abort', () => resolve(), { once: true }) }); yield { type: 'done' as const } } }),
      prepare: async (session, _messages, signal) => { await service.guard(session.id, f.workspace.id, signal); ready = true; return { attachments: [], repositoryText: '', sources: [] } },
      authorized: id => f.workspaces.authorized(id), changed: vi.fn(), phase: vi.fn(),
    }, new ConversationRepository(join(f.dir, 'active-storage')))
    service = new ProjectGitService(chat, f.workspaces); chat.addWorkspace(chat.current().id, f.workspace)
    try {
      expect(chat.send({ text: 'Inspect this project' }).ok).toBe(true)
      await vi.waitFor(() => expect(ready).toBe(true))
      f.git('switch', 'feature/one')
      await vi.waitFor(() => expect(chat.snapshot().phase).toBe('idle'), { timeout: 4000 })
      expect(chat.snapshot().messages.at(-1)?.error).toMatch(/project branch changed/)
      expect(chat.snapshot().messages.at(-1)?.execution?.taskCheckpoint?.control?.status).toBe('resumable')
    } finally { chat.dispose(); service.dispose() }
  })
})
