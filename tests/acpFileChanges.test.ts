import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ACPFileChangeTracker } from '../electron/main/ai/acpFileChanges'

const roots: string[] = []
async function workspace() {
  const root = await mkdtemp(join(tmpdir(), 'athena-acp-changes-'))
  roots.push(root)
  await mkdir(join(root, 'docs'), { recursive: true })
  return root
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

describe('ACP file change normalization', () => {
  it('accepts paths supplied after an incomplete pending event, before approval', async () => {
    const root = await workspace()
    await writeFile(join(root, 'docs/events.yaml'), 'draft\n')
    const tracker = new ACPFileChangeTracker(root, 'c', 'e', 'cursor-subscription')
    await tracker.begin('edit', 'edit', { title: 'Edit File' })
    await tracker.begin('edit', 'edit', { locations: [{ path: 'docs/events.yaml' }] })
    await writeFile(join(root, 'docs/events.yaml'), 'approved\n')
    expect(await tracker.finish('edit', null, {})).toMatchObject([{ path: 'docs/events.yaml', diff: expect.stringContaining('-draft'), verified: true }])
  })

  it.each(['cursor-subscription', 'google-antigravity-subscription'])('verifies completed diff content when %s reports after the write', async provider => {
    const root = await workspace()
    await writeFile(join(root, 'docs/events.yaml'), 'approved\n')
    const tracker = new ACPFileChangeTracker(root, 'c', 'e', provider)
    await tracker.begin('edit', 'edit', { path: 'docs/events.yaml' })
    const changes = await tracker.finish('edit', 'edit', { content: [{ type: 'diff', path: 'docs/events.yaml', oldText: 'draft\n', newText: 'approved\n' }] })
    expect(changes).toMatchObject([{ path: 'docs/events.yaml', diff: expect.stringContaining('-draft'), verified: true, providerId: provider }])
    expect(changes[0].diff).toContain('+approved')
    expect(await tracker.finish('edit', 'edit', {})).toEqual([])
  })

  it('handles create, repeated edit, and delete with completion-only diffs', async () => {
    const root = await workspace()
    const file = join(root, 'docs/new.yaml')
    const tracker = new ACPFileChangeTracker(root, 'c', 'e', 'cursor-subscription')
    const payload = (oldText: string | null, newText: string) => ({ content: [{ type: 'diff', path: 'docs/new.yaml', oldText, newText }] })
    await writeFile(file, 'first\n')
    const first = await tracker.finish('create', 'edit', payload(null, 'first\n'))
    await writeFile(file, 'second\n')
    const second = await tracker.finish('edit', 'edit', payload('first\n', 'second\n'))
    expect(first[0].operation).toBe('create')
    expect(second[0].id).toBe(first[0].id)
    expect(second[0].diff).toContain('+second')
    expect(second[0].diff).not.toContain('-first')
    await rm(file)
    expect(await tracker.finish('delete', 'delete', payload('second\n', ''))).toMatchObject([{ id: first[0].id, status: 'reverted' }])
  })

  it('keeps the full permission diff when the completion event only includes a snippet', async () => {
    const root = await workspace()
    const file = join(root, 'docs/events.yaml')
    await writeFile(file, 'header\ndraft\nfooter\n')
    const tracker = new ACPFileChangeTracker(root, 'c', 'e', 'cursor-subscription')
    const diff = { type: 'diff', path: 'docs/events.yaml', oldText: 'header\ndraft\nfooter\n', newText: 'header\napproved\nfooter\n' }
    await tracker.begin('edit', 'edit', { content: [diff] })
    await writeFile(file, diff.newText)
    expect(await tracker.finish('edit', null, { content: [{ ...diff, oldText: 'draft', newText: 'approved' }] }))
      .toMatchObject([{ verified: true, diff: expect.stringContaining('-draft') }])
  })

  it('uses captured file state when a new-file diff contains provider patch headers', async () => {
    const root = await workspace()
    const tracker = new ACPFileChangeTracker(root, 'c', 'e', 'cursor-subscription')
    await tracker.begin('create', 'edit', {})
    await tracker.begin('create', 'edit', { rawInput: { path: 'docs/new.txt' } })
    await writeFile(join(root, 'docs/new.txt'), 'verified\n')
    expect(await tracker.finish('create', 'edit', { content: [{ type: 'diff', path: 'docs/new.txt', oldText: '-- /dev/null', newText: '++ b/docs/new.txt\nverified' }] }))
      .toMatchObject([{ operation: 'create', verified: true, diff: expect.stringContaining('--- /dev/null') }])
  })

  it('rejects snippets, stale after images, missing before images, and unsafe paths', async () => {
    const root = await workspace()
    await writeFile(join(root, 'docs/events.yaml'), 'user prefix\napproved\n')
    const tracker = new ACPFileChangeTracker(root, 'c', 'e', 'cursor-subscription')
    for (const [index, diff] of [
      { path: 'docs/events.yaml', oldText: 'draft\n', newText: 'approved\n' },
      { path: 'docs/events.yaml', oldText: 'draft\n', newText: 'stale\n' },
      { path: 'docs/events.yaml', newText: 'user prefix\napproved\n' },
      { path: '../outside.yaml', oldText: null, newText: '' },
      { path: '.env', oldText: null, newText: '' },
    ].entries()) expect(await tracker.finish(`edit-${index}`, 'edit', { content: [{ type: 'diff', ...diff }] })).toEqual([])
  })

  it('records only declared, verified file changes and identifies the provider and task', async () => {
    const root = await workspace()
    await writeFile(join(root, 'docs', 'events.yaml'), 'phase: draft\n')
    await writeFile(join(root, 'docs', 'unrelated.yaml'), 'owner: user\n')
    const tracker = new ACPFileChangeTracker(root, 'conversation-1', 'execution-1', 'cursor-subscription')
    await tracker.begin('operation-1', 'edit', { rawInput: { path: 'docs/events.yaml' } })
    await writeFile(join(root, 'docs', 'events.yaml'), 'phase: reopened\n')
    const changes = await tracker.finish('operation-1', 'edit', { rawInput: { path: 'docs/events.yaml' } })
    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({ path: 'docs/events.yaml', status: 'applied', operation: 'edit', conversationId: 'conversation-1', executionId: 'execution-1', providerId: 'cursor-subscription', verified: true })
    expect(changes[0].diff).toContain('+phase: reopened')
    expect(changes.some(change => change.path.includes('unrelated'))).toBe(false)
  })

  it('keeps one task-scoped net diff for repeated edits to the same file', async () => {
    const root = await workspace()
    const file = join(root, 'docs', 'workflow.yaml')
    await writeFile(file, 'phase: define\n')
    const tracker = new ACPFileChangeTracker(root, 'conversation-1', 'execution-2', 'google-antigravity-subscription')
    const input = { rawInput: { path: 'docs/workflow.yaml' } }
    await tracker.begin('operation-1', 'edit', input)
    await writeFile(file, 'phase: plan\n')
    const first = await tracker.finish('operation-1', 'edit', input)
    await tracker.begin('operation-2', 'edit', input)
    await writeFile(file, 'phase: complete\n')
    const second = await tracker.finish('operation-2', 'edit', input)
    expect(first[0].id).toBe(second[0].id)
    expect(second[0].diff).toContain('+phase: complete')
    expect(second[0].diff).not.toContain('+phase: plan')
  })

  it('does not invent a change when a completed operation leaves the file untouched', async () => {
    const root = await workspace()
    const file = join(root, 'docs', 'same.yaml')
    await writeFile(file, 'phase: define\n')
    const tracker = new ACPFileChangeTracker(root, 'conversation-1', 'execution-3', 'google-antigravity-subscription')
    const input = { path: 'docs/same.yaml' }
    await tracker.begin('read-only-or-noop', 'edit', input)
    const changes = await tracker.finish('read-only-or-noop', 'edit', input)
    expect(changes).toEqual([])
    expect(await readFile(file, 'utf8')).toBe('phase: define\n')
  })
})
