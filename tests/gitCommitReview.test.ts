// @vitest-environment node
import { execFileSync } from 'node:child_process'
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentCommands, redactOutput, type CommandRequest, type CommandResult } from '../electron/main/ai/agentCommands'
import { assertCompleteStagedReview, assertStagedCommitUnchanged, inspectStagedCommit, retryStagedReviewChunk } from '../electron/main/ai/gitCommitReview'

const roots: string[] = []
const signal = new AbortController().signal
function git(root: string, ...args: string[]): string { return execFileSync('/usr/bin/git', args, { cwd: root, encoding: 'utf8' }) }
function changedLines(diff: string): string[] { return diff.split('\n').filter(line => (line.startsWith('+') && !line.startsWith('+++')) || (line.startsWith('-') && !line.startsWith('---'))) }
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'athena-git-review-'))
  roots.push(root)
  git(root, 'init', '-q', '-b', 'feature/MBM-11390')
  git(root, 'config', 'user.name', 'Fixture User')
  git(root, 'config', 'user.email', 'fixture@example.invalid')
  await mkdir(join(root, '.claude', 'commands'), { recursive: true })
  await writeFile(join(root, '.claude', 'commands', 'platform-init.md'), '# Initial command\n')
  await writeFile(join(root, 'source.ts'), 'export const baseline = true\n')
  git(root, 'add', '--', '.claude/commands/platform-init.md', 'source.ts')
  git(root, 'commit', '-q', '-m', 'Fixture baseline')
  return root
}
afterEach(async () => { for (const root of roots.splice(0)) { await chmod(join(root, '.claude'), 0o755).catch(() => {}); await rm(root, { recursive: true, force: true }) } })

const localRunner = {
  async execute(root: string, request: CommandRequest): Promise<CommandResult> {
    try { return { command: 'git', exitCode: 0, output: redactOutput(git(root, ...request.args)), truncated: false, timedOut: false } }
    catch (error) {
      const e = error as { status?: number; stderr?: Buffer }
      return { command: 'git', exitCode: e.status ?? 1, output: redactOutput(e.stderr?.toString() ?? ''), truncated: false, timedOut: false }
    }
  },
}
const streamingRunner = {
  async execute(root: string, request: CommandRequest, _signal?: AbortSignal, onOutput?: (chunk: string) => void): Promise<CommandResult> {
    if (!request.streamOutput) return localRunner.execute(root, request)
    const full = git(root, ...request.args)
    for (let offset = 0; offset < full.length; offset += 8192) onOutput?.(full.slice(offset, offset + 8192))
    return { command: 'git', exitCode: 0, output: '', stdout: '', stderr: '', truncated: false, timedOut: false }
  },
}

describe('Git index-only commit review', () => {
  it('reviews a combined diff above the old 30 KB cap without scanning unrelated .claude files', async () => {
    const root = await fixture()
    await writeFile(join(root, '.claude', 'commands', 'platform-init.md'), '# Unstaged command edit\n')
    await writeFile(join(root, '.claude', 'ignored.tmp'), 'Untracked and unrelated')
    await writeFile(join(root, 'one.ts'), 'export const one = [\n' + '  "safe staged line",\n'.repeat(1000) + ']\n')
    await writeFile(join(root, 'two.ts'), 'export const two = [\n' + '  "safe staged line",\n'.repeat(1000) + ']\n')
    git(root, 'add', '--', 'one.ts', 'two.ts')
    expect(git(root, 'diff', '--cached').length).toBeGreaterThan(30_000)
    const review = await inspectStagedCommit(localRunner, root, signal)
    expect(review.branch).toBe('feature/MBM-11390')
    expect(review.changes.map((change) => change.path)).toEqual(['one.ts', 'two.ts'])
    expect(review.changes.every((change) => change.diff.includes('safe staged line'))).toBe(true)
    expect(review.fileReviews.every(file => file.status === 'complete')).toBe(true)
    expect(() => assertCompleteStagedReview(review)).not.toThrow()
    await assertStagedCommitUnchanged(localRunner, review, signal)
    expect(git(root, 'status', '--short')).toContain('.claude/')
  })
  it('reviews staged .claude command content from the index, not from its working-tree permission', async () => {
    const root = await fixture()
    const path = '.claude/commands/platform-init.md'
    await writeFile(join(root, path), '# Staged command edit\n')
    git(root, 'add', '--', path)
    await writeFile(join(root, path), '# Different unstaged command edit\n')
    await chmod(join(root, path), 0o000)
    const review = await inspectStagedCommit(localRunner, root, signal)
    expect(review.changes).toHaveLength(1)
    expect(review.changes[0].diff).toContain('Staged command edit')
    expect(review.changes[0].diff).not.toContain('Different unstaged')
  })
  it('identifies an exact staged path and operation when Git returns Operation not permitted', async () => {
    const root = await fixture()
    await writeFile(join(root, 'blocked.ts'), 'export const blocked = true\n')
    git(root, 'add', '--', 'blocked.ts')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const runner = { execute: async (directory: string, request: CommandRequest) => request.args.includes(':(literal)blocked.ts')
      ? { command: 'git', exitCode: 1, output: 'fatal: blocked.ts: Operation not permitted', truncated: false, timedOut: false }
      : localRunner.execute(directory, request) }
    await expect(inspectStagedCommit(runner, root, signal)).rejects.toThrow(/staged diff inspection.*blocked\.ts.*Operation not permitted/)
    expect(warn).toHaveBeenCalledWith('[git-commit-review]', 'staged diff inspection', '"blocked.ts"', expect.stringContaining('Operation not permitted'))
    warn.mockRestore()
    expect(git(root, 'diff', '--cached', '--name-only').trim()).toBe('blocked.ts')
  })
  it('splits an oversized single-file diff into complete hash-bound chunks and preserves staging', async () => {
    const root = await fixture()
    await writeFile(join(root, 'large.ts'), 'export const large = [\n' + '  "a long staged line with meaningful content",\n'.repeat(2000) + ']\n')
    git(root, 'add', '--', 'large.ts')
    const review = await inspectStagedCommit(localRunner, root, signal)
    expect(review.fileReviews).toHaveLength(1)
    expect(review.fileReviews[0]).toMatchObject({ path: 'large.ts', status: 'complete' })
    expect(review.changes.length).toBeGreaterThan(1)
    expect(review.changes.every(change => change.diff.length <= 45_000 && change.reviewChunk?.status === 'complete')).toBe(true)
    expect(review.changes.map(change => change.reviewChunk?.index)).toEqual(review.changes.map((_change, index) => index + 1))
    expect(review.changes.every(change => change.reviewChunk?.total === review.changes.length)).toBe(true)
    expect(review.changes.map(change => change.diff).join('')).toContain('a long staged line with meaningful content')
    expect(() => assertCompleteStagedReview(review)).not.toThrow()
    await assertStagedCommitUnchanged(localRunner, review, signal)
    expect(git(root, 'diff', '--cached', '--name-only').trim()).toBe('large.ts')
  })
  it('reviews the MBM-11745 define.md oversized-file regression without truncating its staged content', async () => {
    const root = await fixture()
    const path = 'docs/tickets/MBM-11745/define.md'
    await mkdir(join(root, 'docs/tickets/MBM-11745'), { recursive: true })
    const paragraphs = Array.from({ length: 1_800 }, (_value, index) => `## Acceptance detail ${index + 1}\n\nThe staged requirement ${index + 1} must be preserved and reviewed in the complete commit preview.\n`).join('\n')
    await writeFile(join(root, path), `# MBM-11745 define\n\n${paragraphs}`)
    git(root, 'add', '--', path)
    const review = await inspectStagedCommit(localRunner, root, signal)
    expect(review.fileReviews[0].path).toBe(path)
    expect(review.changes.length).toBeGreaterThan(1)
    const chunkedDiff = review.changes.map(change => change.diff).join('')
    expect(chunkedDiff).toContain('Acceptance detail 1800')
    expect(changedLines(chunkedDiff)).toEqual(changedLines(git(root, 'diff', '--cached', '--no-color')))
    await assertStagedCommitUnchanged(localRunner, review, signal)
  })
  it('streams a diff larger than the normal command-output cap and retains Unicode content', async () => {
    const root = await fixture()
    await writeFile(join(root, 'large-unicode.md'), '# 大きな仕様 🌙\n' + Array.from({ length: 2_200 }, (_value, index) => `項目 ${index + 1} — complete staged content\n`).join(''))
    git(root, 'add', '--', 'large-unicode.md')
    const review = await inspectStagedCommit(streamingRunner, root, signal)
    expect(review.changes.length).toBeGreaterThan(1)
    expect(review.changes.map(change => change.diff).join('')).toContain('項目 2200 — complete staged content')
    expect(review.fileReviews[0].status).toBe('complete')
  })
  it('splits multiple oversized files independently and aggregates both file hashes', async () => {
    const root = await fixture()
    for (const path of ['first.md', 'second.md']) await writeFile(join(root, path), `# ${path}\n` + Array.from({ length: 1_400 }, (_value, index) => `- detailed changed line ${index} for ${path}\n+ reviewed replacement ${index} for ${path}\n`).join(''))
    git(root, 'add', '--', 'first.md', 'second.md')
    const review = await inspectStagedCommit(localRunner, root, signal)
    expect(review.fileReviews.map(file => file.path)).toEqual(['first.md', 'second.md'])
    expect(review.fileReviews.every(file => file.status === 'complete' && file.chunkHashes.length > 1)).toBe(true)
    expect(() => assertCompleteStagedReview(review)).not.toThrow()
  })
  it('keeps replacement lines exactly once across chunk boundaries while retaining valid hunk headers', async () => {
    const root = await fixture()
    const path = 'replacement.ts'
    const before = Array.from({ length: 1_500 }, (_value, index) => `const previous_${index} = "old value ${index}"\n`).join('')
    const after = Array.from({ length: 1_500 }, (_value, index) => `const updated_${index} = "new value ${index}"\n`).join('')
    await writeFile(join(root, path), before)
    git(root, 'add', '--', path); git(root, 'commit', '-q', '-m', 'Add replacement fixture')
    await writeFile(join(root, path), after); git(root, 'add', '--', path)
    const review = await inspectStagedCommit(localRunner, root, signal)
    expect(review.changes.length).toBeGreaterThan(1)
    const chunkedDiff = review.changes.map(change => change.diff).join('')
    expect(changedLines(chunkedDiff)).toEqual(changedLines(git(root, 'diff', '--cached', '--no-color')))
    expect(() => assertCompleteStagedReview(review)).not.toThrow()
  })
  it('blocks incomplete or tampered chunks, then accepts a fully retried chunk result', async () => {
    const root = await fixture()
    await writeFile(join(root, 'large.md'), '# Large\n' + 'complete review line\n'.repeat(3_000))
    git(root, 'add', '--', 'large.md')
    const review = await inspectStagedCommit(localRunner, root, signal)
    const failed = review.changes[1]
    review.changes[1] = { ...failed, reviewChunk: { ...failed.reviewChunk!, status: 'incomplete' } }
    expect(() => assertCompleteStagedReview(review)).toThrow(/missing, changed, or incomplete/)
    await expect(assertStagedCommitUnchanged(localRunner, review, signal)).rejects.toThrow(/incomplete/)
    // Retrying the affected chunk restores its content-bound completion state;
    // unrelated file chunks remain unchanged.
    const untouched = review.changes.filter((_change, index) => index !== 1)
    await retryStagedReviewChunk(localRunner, review, 'large.md', 2, signal)
    expect(review.changes.filter((_change, index) => index !== 1)).toEqual(untouched)
    expect(() => assertCompleteStagedReview(review)).not.toThrow()
    await assertStagedCommitUnchanged(localRunner, review, signal)
  })
  it('rejects a staged file changed after review and invalidates its cached review hash', async () => {
    const root = await fixture()
    const path = 'large.md'
    await writeFile(join(root, path), '# Large\n' + 'initial reviewed line\n'.repeat(3_000))
    git(root, 'add', '--', path)
    const review = await inspectStagedCommit(localRunner, root, signal)
    await writeFile(join(root, path), '# Large\n' + 'new staged line\n'.repeat(3_000))
    git(root, 'add', '--', path)
    await expect(assertStagedCommitUnchanged(localRunner, review, signal)).rejects.toThrow(/staged index changed during approval/)
  })
  it('blocks staged credentials while allowing ordinary staged files', async () => {
    const root = await fixture()
    await writeFile(join(root, '.env'), 'PASSWORD=not-for-model\n')
    git(root, 'add', '-f', '--', '.env')
    await expect(inspectStagedCommit(localRunner, root, signal)).rejects.toThrow(/\.env.*credential-sensitive/)
  })
  it('rejects index changes after review without altering the index or working tree', async () => {
    const root = await fixture()
    await writeFile(join(root, 'source.ts'), 'export const baseline = false\n')
    git(root, 'add', '--', 'source.ts')
    const review = await inspectStagedCommit(localRunner, root, signal)
    await writeFile(join(root, 'source.ts'), 'export const baseline = "changed after review"\n')
    git(root, 'add', '--', 'source.ts')
    await expect(assertStagedCommitUnchanged(localRunner, review, signal)).rejects.toThrow(/staged index changed during approval/)
    expect(await readFile(join(root, 'source.ts'), 'utf8')).toContain('changed after review')
  })
  it('blocks unresolved merge stages before approval', async () => {
    const root = await fixture()
    await writeFile(join(root, 'source.ts'), 'export const baseline = false\n')
    git(root, 'add', '--', 'source.ts')
    // A synthetic unmerged entry in this throwaway repository.
    const blob = git(root, 'rev-parse', ':source.ts').trim()
    execFileSync('/usr/bin/git', ['update-index', '--index-info'], { cwd: root, input: `100644 ${blob} 1\tconflicted.ts\n` })
    await expect(inspectStagedCommit(localRunner, root, signal)).rejects.toThrow(/unresolved merge conflicts/)
  })
})

it.runIf(process.env.ATHENA_SANDBOX_TEST === '1')('reviews staged files through the production macOS sandbox despite an unrelated .claude working-tree denial', async () => {
  const root = await fixture()
  await writeFile(join(root, 'source.ts'), 'export const baseline = false\n')
  git(root, 'add', '--', 'source.ts')
  await writeFile(join(root, '.claude', 'commands', 'platform-init.md'), '# Unstaged command edit\n')
  const runner = new AgentCommands()
  expect(await runner.supported()).toBe(true)
  const review = await inspectStagedCommit(runner, root, signal)
  expect(review.changes.map((change) => change.path)).toEqual(['source.ts'])
}, 30_000)

it.runIf(Boolean(process.env.ATHENA_GIT_REVIEW_ROOT))('reviews an existing staged repository read-only without committing or changing the index', async () => {
  const root = resolve(process.env.ATHENA_GIT_REVIEW_ROOT!)
  const before = git(root, 'diff', '--cached', '--raw', '--no-abbrev')
  const commands = new AgentCommands()
  const status = await commands.execute(root, { executable: 'git', args: ['--no-pager', '-c', 'core.fsmonitor=false', 'status', '--short', '--branch'], network: false, install: false, gitWrite: false }, signal)
  console.log(`Isolated Git status: exit=${status.exitCode}; ${status.output.slice(0, 300).replace(/\n/g, ' | ')}`)
  const review = await inspectStagedCommit(commands, root, signal)
  await assertStagedCommitUnchanged(commands, review, signal)
  expect(review.changes.length).toBeGreaterThan(0)
  expect(git(root, 'diff', '--cached', '--raw', '--no-abbrev')).toBe(before)
  console.log(`Read-only staged review: ${review.changes.length} files on ${review.branch}`)
}, 60_000)
