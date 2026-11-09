import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SlashCommandService, expandCommand } from '../electron/main/ai/slashCommandService'
import { newConversation } from '../electron/main/ai/conversationRepository'
import { commandAtStart, filterSlashCommands, resolveSlashCommand, slashQuery } from '../shared/slashCommands'
import type { WorkspaceService } from '../electron/main/ai/workspaceService'
import { workflowSubagentRequirements } from '../electron/main/ai/subagentWorkflow'

const created: string[] = []
afterEach(async () => { for (const path of created.splice(0)) await rm(path, { recursive: true, force: true }) })
async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'athena-slash-')); created.push(base)
  let project = join(base, 'project'), globalHome = join(base, 'home'); const userData = join(base, 'app')
  await Promise.all([mkdir(project), mkdir(globalHome), mkdir(userData)])
  project = await realpath(project); globalHome = await realpath(globalHome)
  const workspace = { id: '00000000-0000-4000-a000-000000000001', name: 'Project', fingerprint: 'a'.repeat(64) }
  const session = newConversation(); session.workspaces = [workspace]
  const grants = { authorized: vi.fn((id: string) => id === workspace.id), authorizedRoot: vi.fn(async () => project) } as unknown as WorkspaceService
  const service = new SlashCommandService(grants, userData, () => true, globalHome)
  return { base, project, globalHome, userData, workspace, session, grants, service }
}
async function add(root: string, relative: string, content: string) { const file = join(root, relative); await mkdir(join(file, '..'), { recursive: true }); await writeFile(file, content); return file }

describe('project-aware slash command discovery', () => {
  it('passes generic sub-agent declarations from command metadata to the shared execution gate', async () => {
    const f = await fixture()
    await add(f.project, '.claude/commands/platform-spec.md', '---\ndescription: Review a specification\nsubagents: [{"id":"cold-review","role":"Reviewer","files":[".tmp/define.md"]}]\n---\nPersist the draft, then complete its independent review.')
    const definition = (await f.service.list(f.session)).commands.find((entry) => entry.name === '/platform-spec')!
    const expanded = await f.service.resolve(f.session, { ...definition, arguments: '' }, '/platform-spec', new AbortController().signal)
    expect(workflowSubagentRequirements(expanded)[0]).toMatchObject({ id: 'cold-review', mode: 'cold_read', required: true })
    expect(expanded).toContain('Never substitute your own review')
  })
  it('loads platform-init completely without injecting its referenced skill or entire repository', async () => {
    const f = await fixture()
    const body = '# /platform-init — One-time environment setup\n\nSkill: `skills/platform-init/`\nUsage: `/platform-init`\nNo ticket ID required. Ask for configuration choices.\nNever bypass approvals.'
    await add(f.project, '.claude/commands/platform-init.md', body)
    await add(f.project, 'skills/platform-init/prompt.md', 'REFERENCE_NOT_EAGERLY_INJECTED')
    const definition = (await f.service.list(f.session)).commands.find(command => command.name === '/platform-init')!
    const expanded = await f.service.resolve(f.session, { ...definition, arguments: '' }, '/platform-init', new AbortController().signal)
    expect(expanded).toContain(body)
    expect(expanded.split(body)).toHaveLength(2)
    expect(expanded).not.toContain('REFERENCE_NOT_EAGERLY_INJECTED')
    expect(expanded).toContain('not a grant of permissions')
  })
  it('preserves large supported command definitions and rejects excessive expansion instead of truncating', async () => {
    const f = await fixture(), body = 'Workflow requirement.\n'.repeat(2000) + '\nFINAL_REQUIRED_STEP'
    await add(f.project, '.claude/commands/large.md', body)
    let definition = (await f.service.list(f.session)).commands.find(command => command.name === '/large')!
    const expanded = await f.service.resolve(f.session, { ...definition, arguments: '' }, '/large', new AbortController().signal)
    expect(expanded).toContain(body)
    await add(f.project, '.claude/commands/large.md', '$ARGUMENTS '.repeat(100))
    definition = (await f.service.list(f.session)).commands.find(command => command.name === '/large')!
    const args = 'x'.repeat(2000)
    await expect(f.service.resolve(f.session, { ...definition, arguments: args }, `/large ${args}`, new AbortController().signal)).rejects.toThrow('no instructions were truncated')
  })
  it('finds Claude commands/skills, Codex prompts and skills without scanning unapproved globals', async () => {
    const f = await fixture()
    await add(f.project, '.claude/commands/platform-spec.md', '---\ndescription: Write a platform specification\nargument-hint: <ticket>\n---\nWrite a spec for $ARGUMENTS')
    await add(f.project, '.claude/skills/review/SKILL.md', '---\nname: review\ndescription: Review carefully\n---\nInspect the change.')
    await add(f.project, '.agents/skills/test/SKILL.md', '---\nname: test\ndescription: Run checks\n---\nValidate carefully.')
    await add(f.project, '.codex/prompts/fix.md', '---\ndescription: Fix the issue\n---\nFix $1')
    await add(f.globalHome, '.claude/commands/private.md', 'Private global prompt')
    const catalog = await f.service.list(f.session)
    expect(catalog.commands.map((item) => item.name)).toEqual(expect.arrayContaining(['/platform-spec', '/review', '/skill:test', '/prompts:fix']))
    expect(catalog.commands.map((item) => item.name)).not.toContain('/private')
    expect(catalog.commands.find((item) => item.name === '/platform-spec')).toMatchObject({ source: 'Claude Project', argumentHint: '<ticket>' })
    await f.service.authorizeGlobals()
    const approved = await f.service.list(f.session)
    expect(approved.commands.some((item) => item.name === '/private' && item.source === 'Claude Global')).toBe(true)
  })
  it('isolates projects, refreshes changed files and rejects symlink escapes', async () => {
    const f = await fixture()
    const file = await add(f.project, '.claude/commands/first.md', 'First instruction')
    const before = await f.service.list(f.session)
    expect(before.commands.some((item) => item.name === '/first')).toBe(true)
    await writeFile(file, 'Changed instruction')
    const entry = (await f.service.list(f.session)).commands.find((item) => item.name === '/first')!
    const instruction = await f.service.resolve(f.session, { id: entry.id, name: entry.name, source: entry.source, arguments: '' }, '/first', new AbortController().signal)
    expect(instruction).toContain('Changed instruction')
    await add(f.base, 'outside.md', 'Unauthorized text')
    await symlink(join(f.base, 'outside.md'), join(f.project, '.claude/commands/escape.md'))
    expect((await f.service.list(f.session)).commands.some((item) => item.name === '/escape')).toBe(false)
    f.session.workspaces = []
    expect((await f.service.list(f.session)).commands.some((item) => item.name === '/first')).toBe(false)
  })
  it('keeps duplicate names distinct and refuses stale identities or unsupported native interpolation', async () => {
    const f = await fixture()
    await add(f.project, '.claude/commands/review.md', 'Review $ARGUMENTS')
    await add(f.project, '.claude/skills/review/SKILL.md', 'Different review')
    const catalog = await f.service.list(f.session)
    const duplicates = catalog.commands.filter((item) => item.name === '/review')
    expect(duplicates).toHaveLength(2)
    expect(new Set(duplicates.map((item) => item.id)).size).toBe(2)
    await expect(f.service.resolve(f.session, { id: duplicates[0].id, name: '/review', source: 'Codex Project', arguments: 'src' }, '/review src', new AbortController().signal)).rejects.toThrow('unavailable')
    expect(() => expandCommand('Run !`cat secrets`', '', 'claude-command')).toThrow('shell interpolation')
  })
  it('expands supported arguments verbatim and recognizes only leading slash positions', () => {
    expect(expandCommand('Ticket $ARGUMENTS, first $0, second $ARGUMENTS[1]', 'MBM-11559 "src/components"', 'claude-command')).toBe('Ticket MBM-11559 "src/components", first MBM-11559, second "src/components"')
    expect(expandCommand('First $1 and literal $$', 'one two', 'codex-prompt')).toBe('First one and literal $')
    expect(slashQuery('/', 1)).toBe('/')
    expect(slashQuery('/plat', 5)).toBe('/plat')
    expect(slashQuery('https://example.com', 8)).toBeNull()
    expect(slashQuery('src/components', 5)).toBeNull()
    expect(commandAtStart('/review src/components')).toEqual({ name: '/review', arguments: 'src/components' })
    expect(filterSlashCommands([{ id: 'one', name: '/platform-spec', description: 'Spec', source: 'Claude Project', scope: 'project', execution: 'prompt' }], '/plat')).toHaveLength(1)
  })
  it('shares command parsing for leading whitespace, quoted path arguments, unknown names and duplicate sources', () => {
    const commands = [
      { id: 'claude', name: '/platform-review', description: 'Review', source: 'Claude Project' as const, scope: 'project' as const, execution: 'prompt' as const },
      { id: 'codex', name: '/platform-review', description: 'Review', source: 'Codex Project' as const, scope: 'project' as const, execution: 'prompt' as const },
    ]
    expect(commandAtStart('  /platform-review "src/components/shared"')).toEqual({ name: '/platform-review', arguments: '"src/components/shared"' })
    expect(resolveSlashCommand('/platform-review MBM-11390', commands)?.status).toBe('ambiguous')
    expect(resolveSlashCommand('/platform-init', commands)?.status).toBe('unknown')
    expect(resolveSlashCommand('Please review /platform-review', commands)).toBeNull()
    expect(commandAtStart('/Users/mario/Projects/Athena')).toBeNull()
    expect(slashQuery('  /platform-', 12)).toBe('/platform-')
  })
})
