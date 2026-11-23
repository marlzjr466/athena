// @vitest-environment node
import { mkdtemp, mkdir, writeFile, realpath, rm, chmod, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { expect, it, vi } from 'vitest'
import { AgentCommands } from '../electron/main/ai/agentCommands'
import { CursorTerminalBridge } from '../electron/main/ai/cursorTerminal'
import { WorkspaceService } from '../electron/main/ai/workspaceService'
import { createProjectTools } from '../electron/main/ai/projectTools'
import { OpenAIProvider } from '../electron/main/ai/OpenAIProvider'
import { createSearchRecovery } from '../electron/main/ai/searchRecovery'
import { SearchError } from '../shared/searchOutcome'

it.each(['disabled', 'empty', 'timeout'] as const)('continues ChatGPT local reads after missing files with search %s', async search => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'athena-tool-recovery-')))
  try {
    await mkdir(join(root, 'src')); await writeFile(join(root, 'src/renamed.ts'), 'export const existing = true\n')
    const workspaces = new WorkspaceService(() => true), workspace = await workspaces.connect(root)
    const files = createProjectTools(workspaces, workspace.id, workspace.name, [], () => true)
    const recoverSearch = createSearchRecovery(), searchRequest = vi.fn(async () => { if (search === 'timeout') throw new SearchError('timeout', 'Search timed out'); return [] })
    const tools = { ...files, definitions: [...files.definitions, ...(search === 'disabled' ? [] : [{ name: 'web_search', description: 'Search public web', parameters: { type: 'object' } }])], execute: async (name: string, args: unknown, signal: AbortSignal) => name === 'web_search' ? JSON.stringify(await recoverSearch('searxng', 'public documentation', false, signal, searchRequest)) : files.execute(name, args, signal) }
    const requests: Record<string, any>[] = []
    const calls = [
      { name: 'read_file', arguments: JSON.stringify({ path: 'src/missing.ts', start_line: 1, end_line: 10 }) },
      { name: 'search_files', arguments: JSON.stringify({ path: 'src', query: '', glob: '**/*.ts', offset: 0 }) },
      { name: 'read_file', arguments: JSON.stringify({ path: 'src/renamed.ts', start_line: 1, end_line: 10 }) },
      ...(search === 'disabled' ? [] : [{ name: 'web_search', arguments: '{}' }]),
    ]
    const request = vi.fn<typeof fetch>(async (_url, init) => {
      const round = requests.length; requests.push(JSON.parse(init!.body as string))
      const events = round < calls.length ? [{ type: 'response.completed', response: { output: [{ ...calls[round], type: 'function_call', id: `item-${round}`, call_id: `call-${round}`, status: 'completed' }] } }] : [{ type: 'response.output_text.delta', delta: 'Verified the existing source.' }, { type: 'response.completed', response: { output: [] } }]
      return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
    })
    const chunks = []
    for await (const chunk of new OpenAIProvider('fixture-token', 'gpt-6-sol', request, undefined, true).streamMessage([{ id: 'user', role: 'user', status: 'complete', createdAt: 1, content: '/platform-dev MBM-11825' }], { effort: 'high', context: { attachments: [], sources: [], repositoryText: '', projectTools: tools } })) chunks.push(chunk)
    expect(chunks.at(-1)).toEqual({ type: 'done' })
    const results = requests.at(-1)!.input.filter((item: any) => item.type === 'function_call_output').map((item: any) => JSON.parse(item.output))
    expect(results[0]).toMatchObject({ reason: 'file_not_found', osCode: 'ENOENT' })
    expect(JSON.stringify(results[1])).toContain('renamed.ts')
    expect(results[2].content).toContain('existing = true')
    expect(searchRequest).toHaveBeenCalledTimes(search === 'disabled' ? 0 : 1)
    if (search !== 'disabled') expect(results[3].status).toBe(search)
  } finally { await rm(root, { recursive: true, force: true }) }
})

it.runIf(process.env.ATHENA_SANDBOX_TEST === '1')('uses the same sandbox for direct agent and Cursor/Grok Git status, preserving OS and secret restrictions', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'athena-git-reliability-')))
  const commands = new AgentCommands(), signal = new AbortController().signal
  const bridge = new CursorTerminalBridge(root, signal, async () => true, async () => {}, commands)
  const request = { executable: 'git', args: ['--no-pager', '-c', 'core.fsmonitor=false', 'status', '--porcelain=v1'], network: false, install: false, gitWrite: false, filesystemMode: 'project-only' as const }
  try {
    await mkdir(join(root, '.claude/commands'), { recursive: true })
    const doc = join(root, '.claude/commands/platform-dev.md')
    await writeFile(doc, 'original\n')
    const git = (args: string[]) => execFileSync(commands.executable('git'), args, { cwd: root, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }, stdio: 'pipe' })
    git(['init']); git(['add', '--', '.claude/commands/platform-dev.md'])
    git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'fixture'])
    await writeFile(doc, 'changed\n'); await writeFile(join(root, 'new.ts'), 'new\n')
    const direct = await commands.execute(root, request, signal)
    expect(direct.exitCode, direct.output).toBe(0)
    expect(direct.output).toContain('M .claude/commands/platform-dev.md')
    expect(direct.output).toContain('?? new.ts')
    const terminal = await bridge.create({ sessionId: 'fixture', cwd: root, command: 'git', args: ['status', '--porcelain=v1'] }, 'fixture')
    await bridge.waitForExit({ sessionId: 'fixture', ...terminal }, 'fixture')
    expect(bridge.output({ sessionId: 'fixture', ...terminal }, 'fixture')).toMatchObject({ output: direct.output, exitStatus: { exitCode: 0 } })
    const blocked = await commands.execute(root, { ...request, executable: 'node', args: ['-e', 'require("fs").readFileSync(process.argv[1])', doc] }, signal)
    expect(blocked.exitCode).not.toBe(0)
    await chmod(join(root, '.claude/commands'), 0)
    const denied = await commands.execute(root, request, signal)
    expect(denied.exitCode).not.toBe(0)
    expect(denied.output).toContain('incomplete')
    await chmod(join(root, '.claude/commands'), 0o700)
    await symlink('/etc/master.passwd', join(root, '.claude/commands/escape.md'))
    const escaped = await commands.execute(root, { ...request, executable: 'node', args: ['-e', 'require("fs").readFileSync(process.argv[1])', join(root, '.claude/commands/escape.md')] }, signal)
    expect(escaped.exitCode).not.toBe(0)
  } finally { bridge.dispose(); await chmod(join(root, '.claude/commands'), 0o700).catch(() => {}); await rm(root, { recursive: true, force: true }) }
}, 30000)

it.runIf(Boolean(process.env.ATHENA_RELIABILITY_PROJECT))('inspects the authorized live project through the normal sandbox without modifying it', async () => {
  const result = await new AgentCommands().execute(process.env.ATHENA_RELIABILITY_PROJECT!, { executable: 'git', args: ['--no-pager', '-c', 'core.fsmonitor=false', 'status', '--porcelain=v1'], network: false, install: false, gitWrite: false, filesystemMode: 'project-only' }, AbortSignal.timeout(30000))
  expect(result.exitCode, result.output).toBe(0)
  expect(result.output).not.toMatch(/Operation not permitted|Permission denied/)
}, 35000)
