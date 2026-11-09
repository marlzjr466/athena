// @vitest-environment node
import { mkdtemp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import { PermissionRepository } from '../electron/main/permissions/permissionRepository'
import { RememberedPermissions } from '../electron/main/permissions/rememberedPermissions'
import { ChatController } from '../electron/main/ai/chatController'
import { AgentTools } from '../electron/main/ai/agentTools'
import type { GitIdentityService } from '../electron/main/ai/gitIdentity'
import { WorkspaceService } from '../electron/main/ai/workspaceService'
import { ConversationRepository } from '../electron/main/ai/conversationRepository'
import type { AgentMode } from '../shared/agent'
import type { ProjectTools } from '../electron/main/ai/AIProvider'
import type { FilesystemAccessMode } from '../shared/permissions'
vi.mock('../electron/main/logger', () => ({ log: vi.fn() }))

async function fixture(mode: AgentMode, run: (tools: ProjectTools, signal: AbortSignal) => Promise<void>, gitIdentity?: GitIdentityService, configure?: (chat: ChatController, root: string, agent: AgentTools) => Promise<void>, filesystemMode: FilesystemAccessMode | (() => FilesystemAccessMode) = 'project-only', rememberedPermissions?: RememberedPermissions) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'athena-agent-flow-'))), root = join(directory, 'project')
  await mkdir(root); await writeFile(join(root, 'app.ts'), 'export const x = 1')
  const workspaces = new WorkspaceService(() => true, undefined, () => typeof filesystemMode === 'function' ? filesystemMode() : filesystemMode), workspace = await workspaces.connect(root), agent = new AgentTools(workspaces, join(directory, 'storage'), undefined, gitIdentity)
  let tools: ProjectTools
  const repository = new ConversationRepository(join(directory, 'storage'))
  const chat = new ChatController({ rememberedPermissions, provider: async () => ({ testConnection: async () => true, async *streamMessage(_messages, options) { if (rememberedPermissions) tools = agent.create(chat, chat.current().id, workspace.id, workspace.name, chat.current().config.agentMode ?? 'ask', [], () => true, chat.current().config.contextSettings); await run(tools, options!.signal!); yield { type: 'text', text: 'Finished from actual results.' }; yield { type: 'done' } } }), changed: vi.fn(), phase: vi.fn() }, repository)
  chat.addWorkspace(chat.current().id, workspace)
  chat.command({ action: 'agent-mode', id: chat.current().id, mode })
  if (configure) await configure(chat, root, agent)
  tools = agent.create(chat, chat.current().id, workspace.id, workspace.name, mode, [], () => true, chat.current().config.contextSettings)
  chat.send({ text: 'Create Button.tsx in this project.' })
  return { chat, root, tools, repository }
}
describe('coding permission and conversation lifecycle', () => {
  it('remembers actual Ask-mode file edits but keeps different operations and Read Only blocked', async () => {
    const store = await mkdtemp(join(tmpdir(), 'athena-real-grant-'))
    const remembered = new RememberedPermissions(new PermissionRepository(store))
    let run = 0
    const f = await fixture('ask', async (tools, signal) => {
      const current = JSON.parse(await tools.execute('read_file', { path: 'app.ts', start_line: 1, end_line: 20 }, signal))
      const result = JSON.parse(await tools.execute('write_file', { path: 'app.ts', content: `export const x = ${++run + 1}`, expected_version: current.version }, signal))
      if (run === 3) expect(JSON.stringify(result)).toContain('Read Only')
      else expect(result.result.ok).toBe(true)
    }, undefined, undefined, 'project-only', remembered)
    try {
      await vi.waitFor(() => expect(f.chat.snapshot().messages.at(-1)?.execution?.approval).toBeDefined())
      const approval = f.chat.snapshot().messages.at(-1)!.execution!.approval!
      expect(approval.rememberScope).toMatchObject({ operation: 'write_file', project: f.root, resources: [join(f.root, 'app.ts')] })
      expect(f.chat.command({ action: 'agent-approval', id: f.chat.current().id, approvalId: approval.id, allow: true, remember: true }).ok).toBe(true)
      await vi.waitFor(() => expect(f.chat.snapshot().phase).toBe('idle'))
      expect(await readFile(join(f.root, 'app.ts'), 'utf8')).toBe('export const x = 2')
      f.chat.send({ text: 'Update the same file again' })
      await vi.waitFor(() => expect(f.chat.snapshot().phase).toBe('idle'))
      expect(await readFile(join(f.root, 'app.ts'), 'utf8')).toBe('export const x = 3')
      expect(f.chat.snapshot().messages.at(-1)?.execution?.approval).toBeUndefined()
      expect(remembered.allows({ ...approval.rememberScope, operation: 'delete_file' })).toBe(false)
      f.chat.command({ action: 'project-permissions', id: f.chat.current().id, mode: 'read-only', allowDeletion: false, allowCommands: false })
      f.chat.send({ text: 'A grant must not override Read Only' })
      await vi.waitFor(() => expect(f.chat.snapshot().phase).toBe('idle'))
      expect(await readFile(join(f.root, 'app.ts'), 'utf8')).toBe('export const x = 3')
    } finally { f.chat.dispose() }
  })
  it('refreshes scope on explicit continuation without widening the old tool execution', async () => {
    let access: FilesystemAccessMode = 'project-only'
    let agent: AgentTools, host: ChatController, outside: string
    let result: { content?: string } = {}
    const f = await fixture('advanced', async (tools, signal) => {
      access = 'full-read-write'
      await expect(tools.execute('read_file', { path: outside, start_line: 1, end_line: 1 }, signal)).rejects.toMatchObject({ reason: 'operation_requires_approval', policyRule: 'authorization_refresh_required' })
      const session = host.current(), workspace = session.workspaces[0]
      const refreshed = agent.create(host, session.id, workspace.id, workspace.name, 'advanced', [], () => true, session.config.contextSettings)
      result = JSON.parse(await refreshed.execute('read_file', { path: outside, start_line: 1, end_line: 1 }, signal))
      const child = agent.create(host, session.id, workspace.id, workspace.name, 'read-only', [], () => true, session.config.contextSettings, { id: 'review' })
      expect(child.policy).toContain('Filesystem scope: project-only')
      expect(child.policy).toContain('explicitly delegated project-relative paths')
      expect(child.definitions.map((entry) => entry.name)).not.toContain('write_file')
    }, undefined, async (chat, root, tools) => {
      agent = tools; host = chat; outside = join(dirname(root), 'outside.md')
      await writeFile(outside, 'ordinary external notes')
    }, () => access)
    await vi.waitFor(() => expect(f.chat.snapshot().phase).toBe('idle'))
    expect(result.content).toContain('ordinary external notes')
    f.chat.dispose()
  })
  it('retains structured policy diagnostics for mutation tools', async () => {
    let output: Record<string, unknown> = {}
    const f = await fixture('read-only', async (tools, signal) => {
      output = JSON.parse(await tools.execute('create_file', { path: 'new.ts', content: 'export {}' }, signal))
    }, undefined, undefined, 'full-read-write')
    await vi.waitFor(() => expect(f.chat.snapshot().phase).toBe('idle'))
    expect(output).toMatchObject({ reason: 'filesystem_policy_denied', policyRule: 'tool_read_only', authorizationScope: 'full-read-write', effectiveToolAuthorization: 'filesystem-write', requestedPath: 'new.ts', macOSAccessAttempted: false })
    f.chat.dispose()
  })
  it.each([true, false])('applies command file reads only after user approval (%s)', async (allow) => {
    const execute = vi.fn(async () => ({ command: 'npm run format:check', exitCode: 0, output: 'checked', truncated: false, timedOut: false }))
    let result = ''
    const f = await fixture('advanced', async (tools, signal) => {
      result = await tools.execute('execute_command', { executable: 'npm', args: ['run', 'format:check'], network: false, install_dependencies: false, read_paths: ['edge-existing-credentials.json'] }, signal)
      if (allow) await tools.execute('execute_command', { executable: 'node', args: ['--version'], network: false, install_dependencies: false }, signal)
    }, undefined, async (_chat, root, agent) => {
      await writeFile(join(root, 'edge-existing-credentials.json'), '{"fixture":true}')
      const commands = (agent as unknown as { commands: { supported(): Promise<boolean>; execute: typeof execute } }).commands
      commands.supported = vi.fn(async () => true)
      commands.execute = execute
    }, 'full-read-write')
    await vi.waitFor(() => expect(f.chat.snapshot().messages.at(-1)?.execution?.approval?.title).toBe('Allow command to read these files?'))
    expect(execute).not.toHaveBeenCalled()
    const approval = f.chat.snapshot().messages.at(-1)!.execution!.approval!
    f.chat.command({ action: 'agent-approval', id: f.chat.current().id, approvalId: approval.id, allow })
    await vi.waitFor(() => expect(f.chat.snapshot().phase).toBe('idle'))
    if (allow) {
      expect(execute).toHaveBeenCalledTimes(2)
      expect(execute).toHaveBeenNthCalledWith(1, f.root, expect.objectContaining({ approvedReadPaths: [join(f.root, 'edge-existing-credentials.json')] }), expect.any(AbortSignal), expect.any(Function))
      expect(execute).toHaveBeenNthCalledWith(2, f.root, expect.not.objectContaining({ approvedReadPaths: expect.anything() }), expect.any(AbortSignal), expect.any(Function))
    } else {
      expect(execute).not.toHaveBeenCalled()
      expect(result).toContain('declined')
    }
    f.chat.dispose()
  })
  it('requires an explicit loopback grant and keeps external network disabled for agent commands', async () => {
    const execute = vi.fn(async () => ({ command: 'node -e fetch(...)', exitCode: 0, output: 'local service ready', truncated: false, timedOut: false }))
    let result = ''
    const f = await fixture('advanced', async (tools, signal) => {
      result = await tools.execute('execute_command', { executable: 'node', args: ['-e', 'fetch("http://127.0.0.1:5173")'], network: false, local_network: true, install_dependencies: false }, signal)
    }, undefined, async (_chat, _root, agent) => {
      const commands = (agent as unknown as { commands: { supported(): Promise<boolean>; execute: typeof execute } }).commands
      commands.supported = vi.fn(async () => true)
      commands.execute = execute
    })
    await vi.waitFor(() => expect(f.chat.snapshot().messages.at(-1)?.execution?.approval?.title).toBe('Run isolated command'))
    expect(f.chat.snapshot().messages.at(-1)?.execution?.approval?.description).toContain('outbound loopback only')
    expect(execute).not.toHaveBeenCalled()
    const approval = f.chat.snapshot().messages.at(-1)!.execution!.approval!
    f.chat.command({ action: 'agent-approval', id: f.chat.current().id, approvalId: approval.id, allow: true })
    await vi.waitFor(() => expect(f.chat.snapshot().phase).toBe('idle'))
    expect(execute).toHaveBeenCalledWith(f.root, expect.objectContaining({ loopback: true, network: false }), expect.any(AbortSignal), expect.any(Function))
    expect(result).toContain('local service ready')
    f.chat.dispose()
  })
  it('asks before reading a credential-named fixture and scopes approval to that read', async () => {
    let result = ''
    const f = await fixture('advanced', async (tools, signal) => {
      result = await tools.execute('read_file', { path: 'edge-existing-credentials.json', start_line: 1, end_line: 1 }, signal)
    }, undefined, async (_chat, root) => {
      await writeFile(join(root, 'edge-existing-credentials.json'), '{"access_token":"fixture-token-1234567890"}')
    }, 'full-read-write')
    await vi.waitFor(() => expect(f.chat.snapshot().messages.at(-1)?.execution?.approval?.title).toBe('Read credential-named file?'))
    expect(result).toBe('')
    const approval = f.chat.snapshot().messages.at(-1)!.execution!.approval!
    f.chat.command({ action: 'agent-approval', id: f.chat.current().id, approvalId: approval.id, allow: true })
    await vi.waitFor(() => expect(f.chat.snapshot().phase).toBe('idle'))
    expect(result).toContain('fixture-token-1234567890')
    f.chat.dispose()
  })
  it('stops an active execution at a safe boundary when Full Mac authorization changes', async () => {
    let access: FilesystemAccessMode = 'project-only'
    let reason = ''
    const f = await fixture('advanced', async (tools, signal) => {
      expect(JSON.parse(await tools.execute('read_file', { path: 'app.ts', start_line: 1, end_line: 1 }, signal)).content).toContain('export const x')
      access = 'full-read-write'
      try { await tools.execute('read_file', { path: 'app.ts', start_line: 1, end_line: 1 }, signal) }
      catch (error) { reason = error instanceof Error ? error.message : String(error) }
    }, undefined, undefined, () => access)
    await vi.waitFor(() => expect(f.chat.snapshot().phase).toBe('idle'))
    expect(reason).toContain('Continue to refresh authorization')
    f.chat.dispose()
  })
  it.each(['project-only', 'full-read-write'] as const)('reads workflow drafts and honors all four editing modes in %s', async (filesystemMode) => {
    for (const mode of ['read-only', 'ask', 'workspace-auto', 'advanced'] as const) {
      let initial: { content?: string; version?: string } = {}, outcome = ''
      const f = await fixture(mode, async (tools, signal) => {
        initial = JSON.parse(await tools.execute('read_file', { path: '.tmp/define.md', start_line: 1, end_line: 20 }, signal))
        outcome = await tools.execute('edit_file', { path: '.tmp/define.md', expected_version: initial.version, old_text: 'Draft plan', new_text: 'Reviewed plan' }, signal)
      }, undefined, async (_chat, root) => {
        await mkdir(join(root, '.tmp'))
        await writeFile(join(root, '.gitignore'), '.tmp\n')
        await writeFile(join(root, '.tmp/define.md'), 'Draft plan\n')
      }, filesystemMode)
      if (mode === 'ask') {
        await vi.waitFor(() => expect(f.chat.snapshot().messages.at(-1)?.execution?.approval?.title).toBe('Review project changes'))
        expect(await readFile(join(f.root, '.tmp/define.md'), 'utf8')).toBe('Draft plan\n')
        const approval = f.chat.snapshot().messages.at(-1)!.execution!.approval!
        f.chat.command({ action: 'agent-approval', id: f.chat.current().id, approvalId: approval.id, allow: true })
      }
      await vi.waitFor(() => expect(f.chat.snapshot().phase).toBe('idle'))
      expect(initial.content).toContain('Draft plan')
      expect(outcome).toContain(mode === 'read-only' ? 'Read Only mode blocks' : '"ok":true')
      expect(await readFile(join(f.root, '.tmp/define.md'), 'utf8')).toBe(mode === 'read-only' ? 'Draft plan\n' : 'Reviewed plan\n')
      f.chat.dispose()
    }
  })
  it('returns corrective evidence after an ambiguous or numbered replacement without weakening exact edits', async () => {
    const results: string[] = []
    const f = await fixture('advanced', async (tools, signal) => {
      const args = { path: 'app.ts', start_line: 1, end_line: 20 }
      const first = JSON.parse(await tools.execute('read_file', args, signal))
      results.push(await tools.execute('edit_file', { path: 'app.ts', expected_version: first.version, old_text: 'repeat', new_text: 'changed' }, signal))
      expect(JSON.parse(await tools.execute('read_file', args, signal)).content).toBe(first.content)
      results.push(await tools.execute('edit_file', { path: 'app.ts', expected_version: first.version, old_text: '1: repeat', new_text: 'changed' }, signal))
      expect(JSON.parse(await tools.execute('read_file', args, signal)).content).toBe(first.content)
      results.push(await tools.execute('edit_file', { path: 'app.ts', expected_version: first.version, old_text: 'repeat\nend', new_text: 'changed\nend' }, signal))
    }, undefined, async (_chat, root) => { await writeFile(join(root, 'app.ts'), 'repeat\nrepeat\nend') })
    await vi.waitFor(() => expect(f.chat.snapshot().phase).toBe('idle'))
    expect(results[0]).toContain('multiple locations')
    expect(results[1]).toContain('line-number prefixes')
    expect(results[2]).toContain('"ok":true')
    expect(await readFile(join(f.root, 'app.ts'), 'utf8')).toBe('repeat\nchanged\nend')
    f.chat.dispose()
  })
  it('advertises only tools available in Read Only and keeps direct mutation calls blocked', async () => {
    let output = ''
    const f = await fixture('read-only', async (tools, signal) => {
      const names = tools.definitions.map((entry) => entry.name)
      expect(names).toContain('read_file')
      expect(names).not.toContain('edit_file')
      expect(names).not.toContain('execute_command')
      expect(names).not.toContain('run_build')
      output = await tools.execute('edit_file', { path: 'app.ts', expected_version: 'a'.repeat(64), old_text: 'x', new_text: 'y' }, signal)
    })
    await vi.waitFor(() => expect(f.chat.snapshot().phase).toBe('idle'))
    expect(output).toContain('Read Only mode blocks')
    expect(f.chat.snapshot().messages.at(-1)?.execution?.approval).toBeUndefined()
    f.chat.dispose()
  })
  it('preauthorizes ordinary large edits and isolated offline commands in Advanced Agent', async () => {
    const execute = vi.fn(async () => ({ command: 'node --version', exitCode: 0, output: 'v22', truncated: false, timedOut: false }))
    let fileResult = '', commandResult = ''
    const f = await fixture('advanced', async (tools, signal) => {
      expect(tools.definitions.map((entry) => entry.name)).toContain('execute_command')
      fileResult = await tools.execute('create_file', { path: 'large.ts', content: 'x'.repeat(9_000) }, signal)
      commandResult = await tools.execute('execute_command', { executable: 'node', args: ['--version'], network: false, install_dependencies: false }, signal)
    }, undefined, async (_chat, _root, agent) => {
      const commands = (agent as unknown as { commands: { supported(): Promise<boolean>; execute: typeof execute } }).commands
      commands.supported = vi.fn(async () => true)
      commands.execute = execute
    })
    await vi.waitFor(() => expect(f.chat.snapshot().phase).toBe('idle'))
    expect(fileResult).toContain('"ok":true')
    expect(commandResult).toContain('v22')
    expect(execute).toHaveBeenCalledOnce()
    expect(await readFile(join(f.root, 'large.ts'), 'utf8')).toHaveLength(9_000)
    expect(f.chat.snapshot().messages.at(-1)?.execution?.approval).toBeUndefined()
    f.chat.dispose()
  })
  it('does not interrupt Workspace Auto Edit for a large ordinary source change', async () => {
    let result = ''
    const f = await fixture('workspace-auto', async (tools, signal) => {
      result = await tools.execute('create_file', { path: 'large.ts', content: 'x'.repeat(9_000) }, signal)
    })
    await vi.waitFor(() => expect(f.chat.snapshot().phase).toBe('idle'))
    expect(result).toContain('"ok":true')
    expect(f.chat.snapshot().messages.at(-1)?.execution?.approval).toBeUndefined()
    f.chat.dispose()
  })
  it('still asks for network command approval in Advanced Agent', async () => {
    const execute = vi.fn(async () => ({ command: 'npm view react', exitCode: 0, output: 'ok', truncated: false, timedOut: false }))
    let result = ''
    const f = await fixture('advanced', async (tools, signal) => {
      result = await tools.execute('execute_command', { executable: 'npm', args: ['view', 'react'], network: true, install_dependencies: false }, signal)
    }, undefined, async (_chat, _root, agent) => {
      const commands = (agent as unknown as { commands: { supported(): Promise<boolean>; execute: typeof execute } }).commands
      commands.supported = vi.fn(async () => true)
      commands.execute = execute
    })
    await vi.waitFor(() => expect(f.chat.snapshot().messages.at(-1)?.execution?.approval?.title).toBe('Run isolated command'))
    expect(execute).not.toHaveBeenCalled()
    const approval = f.chat.snapshot().messages.at(-1)!.execution!.approval!
    f.chat.command({ action: 'agent-approval', id: f.chat.current().id, approvalId: approval.id, allow: false })
    await vi.waitFor(() => expect(f.chat.snapshot().phase).toBe('idle'))
    expect(result).toContain('declined')
    expect(execute).not.toHaveBeenCalled()
    f.chat.dispose()
  })
  it('runs bounded repository and remote-ref checks through the isolated Git runner', async () => {
    const execute = vi.fn(async (_root: string, request: { args: string[]; network: boolean; gitWrite: boolean }) => ({ command: `git ${request.args.join(' ')}`, exitCode: 0, output: 'verified', truncated: false, timedOut: false }))
    let invalid = ''
    const f = await fixture('advanced', async (tools, signal) => {
      const names = tools.definitions.map((entry) => entry.name)
      expect(names).toEqual(expect.arrayContaining(['git_repository_root', 'git_remotes', 'git_remote_ref', 'git_fetch_branch']))
      await tools.execute('git_repository_root', {}, signal)
      await tools.execute('git_remotes', {}, signal)
      await tools.execute('git_remote_ref', { branch: 'feature/sandbox-dev' }, signal)
      invalid = await tools.execute('git_remote_ref', { branch: '../HEAD' }, signal)
    }, undefined, async (_chat, _root, agent) => {
      const commands = (agent as unknown as { commands: { supported(): Promise<boolean>; execute: typeof execute } }).commands
      commands.supported = vi.fn(async () => true)
      commands.execute = execute
    })
    await vi.waitFor(() => expect(f.chat.snapshot().phase).toBe('idle'))
    expect(execute).toHaveBeenCalledTimes(3)
    expect(execute.mock.calls.map(([, request]) => request.args.slice(-2))).toEqual([
      ['rev-parse', '--show-toplevel'], ['remote', '-v'], ['rev-parse', 'origin/feature/sandbox-dev'],
    ])
    expect(execute.mock.calls.every(([, request]) => !request.network && !request.gitWrite)).toBe(true)
    expect(invalid).toContain('without Git revision syntax')
    f.chat.dispose()
  })
  it('exposes read-only Git conflict, staged, reflog, stash and exact-commit inspections', async () => {
    const execute = vi.fn(async (_root: string, request: { args: string[]; network: boolean; gitWrite: boolean }) => ({ command: `git ${request.args.join(' ')}`, exitCode: 0, output: 'verified', truncated: false, timedOut: false }))
    let invalid = '', abbreviated = ''
    const commit = 'a'.repeat(40)
    const f = await fixture('advanced', async (tools, signal) => {
      expect(tools.definitions.map(entry => entry.name)).toEqual(expect.arrayContaining(['git_staged_diff', 'git_conflicts', 'git_reflog', 'git_stash_list', 'git_show_commit']))
      await tools.execute('git_staged_diff', {}, signal)
      await tools.execute('git_conflicts', {}, signal)
      await tools.execute('git_reflog', {}, signal)
      await tools.execute('git_stash_list', {}, signal)
      await tools.execute('git_show_commit', { commit }, signal)
      invalid = await tools.execute('git_show_commit', { commit: 'HEAD~1' }, signal)
      abbreviated = await tools.execute('git_show_commit', { commit: 'abcdef0' }, signal)
    }, undefined, async (_chat, _root, agent) => {
      const commands = (agent as unknown as { commands: { supported(): Promise<boolean>; execute: typeof execute } }).commands
      commands.supported = vi.fn(async () => true)
      commands.execute = execute
    })
    await vi.waitFor(() => expect(f.chat.snapshot().phase).toBe('idle'))
    expect(execute).toHaveBeenCalledTimes(5)
    const requests = execute.mock.calls.map(([, request]) => request)
    expect(requests[0].args.slice(-2)).toEqual(['--', 'app.ts'])
    expect(requests[1].args.slice(-3)).toEqual(['diff', '--name-only', '--diff-filter=U'])
    expect(requests[2].args).toContain('reflog')
    expect(requests[3].args).toContain('stash')
    expect(requests[4].args.slice(-2)).toEqual(['--format=%H%n%an%n%ad%n%s', commit])
    expect(requests.every(request => !request.network && !request.gitWrite)).toBe(true)
    expect(invalid).toContain('Invalid')
    expect(abbreviated).toContain('Invalid')
    f.chat.dispose()
  })
  it('requires explicit network and Git-write approval before fetching one validated branch', async () => {
    const execute = vi.fn(async (_root: string, request: { args: string[]; network: boolean; gitWrite: boolean }) => ({ command: `git ${request.args.join(' ')}`, exitCode: 0, output: 'fetched', truncated: false, timedOut: false }))
    let result = ''
    const f = await fixture('advanced', async (tools, signal) => {
      result = await tools.execute('git_fetch_branch', { branch: 'feature/sandbox-dev' }, signal)
    }, undefined, async (_chat, _root, agent) => {
      const commands = (agent as unknown as { commands: { supported(): Promise<boolean>; execute: typeof execute } }).commands
      commands.supported = vi.fn(async () => true)
      commands.execute = execute
    })
    await vi.waitFor(() => expect(f.chat.snapshot().messages.at(-1)?.execution?.approval?.title).toBe('Run isolated command'))
    expect(execute).not.toHaveBeenCalled()
    const approval = f.chat.snapshot().messages.at(-1)!.execution!.approval!
    expect(approval.description).toContain('Network: allowed')
    expect(approval.description).toContain('git --no-pager')
    f.chat.command({ action: 'agent-approval', id: f.chat.current().id, approvalId: approval.id, allow: true })
    await vi.waitFor(() => expect(f.chat.snapshot().phase).toBe('idle'))
    expect(execute).toHaveBeenCalledOnce()
    expect(execute.mock.calls[0][1]).toMatchObject({ network: true, gitWrite: true })
    expect(execute.mock.calls[0][1].args.slice(-3)).toEqual(['fetch', 'origin', 'feature/sandbox-dev'])
    expect(result).toContain('fetched')
    f.chat.dispose()
  })
  it('requires its independent opt-in before browser verification can start', async () => {
    let output = ''
    const f = await fixture('workspace-auto', async (tools, signal) => {
      output = await tools.execute('verify_local_app', { path: '/', viewport: 'desktop', selectors: [] }, signal)
    })
    await vi.waitFor(() => expect(f.chat.snapshot().phase).toBe('idle'))
    expect(output).toContain('Local Browser Verification in Settings → Permissions')
    f.chat.dispose()
  })
  it('applies an authorized Rspack config edit through the version-checked project file tool in Full Mac mode', async () => {
    let outcome = ''
    const f = await fixture('workspace-auto', async (tools, signal) => {
      expect(tools.definitions.map((entry) => entry.name)).toEqual(expect.arrayContaining(['start_dev_server', 'stop_dev_server', 'verify_local_app']))
      const initial = JSON.parse(await tools.execute('read_file', { path: 'rspack.config.ts', start_line: 1, end_line: 20 }, signal))
      outcome = await tools.execute('edit_file', { path: 'rspack.config.ts', expected_version: initial.version, old_text: 'devServer: false', new_text: 'devServer: true' }, signal)
    }, undefined, async (_chat, root) => { await writeFile(join(root, 'rspack.config.ts'), 'export default { devServer: false }\n') }, 'full-read-write')
    await vi.waitFor(() => expect(f.chat.snapshot().phase).toBe('idle'))
    expect(outcome).toContain('"ok":true')
    expect(await readFile(join(f.root, 'rspack.config.ts'), 'utf8')).toContain('devServer: true')
    f.chat.dispose()
  })
  it('asks before disclosing a Claude credential file to the selected AI provider', async () => {
    let result = '', credentialPath = ''
    const f = await fixture('read-only', async (tools, signal) => {
      result = await tools.execute('read_file', { path: credentialPath, start_line: 1, end_line: 2 }, signal)
    }, undefined, async (_chat, root) => {
      await mkdir(join(dirname(root), '.claude'))
      credentialPath = join(dirname(root), '.claude', '.credentials.json')
      await writeFile(credentialPath, '{"access_token":"fixture-token-1234567890"}')
    }, 'full-read-only')
    await vi.waitFor(() => expect(f.chat.snapshot().messages.at(-1)?.execution?.approval?.title).toBe('Access Claude/Codex configuration?'))
    expect(result).toBe('')
    const approval = f.chat.snapshot().messages.at(-1)!.execution!.approval!
    expect(approval.description).toContain('selected AI provider')
    f.chat.command({ action: 'agent-approval', id: f.chat.current().id, approvalId: approval.id, allow: true })
    await vi.waitFor(() => expect(f.chat.snapshot().phase).toBe('idle'))
    expect(JSON.parse(result).content).toContain('fixture-token-1234567890')
    f.chat.dispose()
  })
  it('does not return Codex credential contents when protected-file approval is declined', async () => {
    let result = '', credentialPath = ''
    const f = await fixture('read-only', async (tools, signal) => {
      result = await tools.execute('read_file', { path: credentialPath, start_line: 1, end_line: 2 }, signal)
    }, undefined, async (_chat, root) => {
      await mkdir(join(dirname(root), '.codex'))
      credentialPath = join(dirname(root), '.codex', 'auth.json')
      await writeFile(credentialPath, '{"access_token":"fixture-token-abcdefghij"}')
    }, 'full-read-only')
    await vi.waitFor(() => expect(f.chat.snapshot().messages.at(-1)?.execution?.approval?.title).toBe('Access Claude/Codex configuration?'))
    const approval = f.chat.snapshot().messages.at(-1)!.execution!.approval!
    f.chat.command({ action: 'agent-approval', id: f.chat.current().id, approvalId: approval.id, allow: false })
    await vi.waitFor(() => expect(f.chat.snapshot().phase).toBe('idle'))
    expect(result).toContain('declined')
    expect(result).not.toContain('fixture-token-abcdefghij')
    f.chat.dispose()
  })
  it.runIf(process.env.ATHENA_SANDBOX_TEST === '1')('shows every staged diff for approval and commits only after approval despite unrelated .claude access denial', async () => {
    const git = (root: string, ...args: string[]) => execFileSync('/usr/bin/git', args, { cwd: root, encoding: 'utf8' })
    const identity = { read: vi.fn(async () => ({ name: { status: 'found' as const, value: 'Global Fixture User', scope: 'global' as const }, email: { status: 'found' as const, value: 'global-fixture@example.invalid', scope: 'global' as const }, complete: true })) } as unknown as GitIdentityService
    let result = ''
    const f = await fixture('workspace-auto', async (tools, signal) => {
      result = await tools.execute('git_commit', { message: 'Reviewed fixture change' }, signal)
    }, identity, async (chat, root) => {
      git(root, 'init', '-q', '-b', 'feature/MBM-11390')
      await mkdir(join(root, '.claude', 'commands'), { recursive: true })
      await writeFile(join(root, '.claude', 'commands', 'platform-init.md'), '# original\n')
      git(root, 'add', '--', 'app.ts', '.claude/commands/platform-init.md')
      git(root, '-c', 'user.name=Fixture User', '-c', 'user.email=fixture@example.invalid', 'commit', '-q', '-m', 'Fixture baseline')
      await writeFile(join(root, 'app.ts'), 'export const x = 2\n')
      git(root, 'add', '--', 'app.ts')
      await writeFile(join(root, '.claude', 'commands', 'platform-init.md'), '# unstaged but preserved\n')
      chat.command({ action: 'project-permissions', id: chat.current().id, mode: 'workspace-auto', allowDeletion: false, allowCommands: true })
    })
    await vi.waitFor(() => expect(f.chat.snapshot().messages.at(-1)?.execution?.approval?.title).toBe('Create Git commit'))
    const approval = f.chat.snapshot().messages.at(-1)!.execution!.approval!
    expect(approval.description).toContain('feature/MBM-11390')
    expect(approval.description).toContain('Global Fixture User <global-fixture@example.invalid>')
    expect(approval.changes?.map((change) => change.path)).toEqual(['app.ts'])
    expect(approval.changes?.[0].diff).toContain('+export const x = 2')
    expect(git(f.root, 'log', '-1', '--format=%s').trim()).toBe('Fixture baseline')
    f.chat.command({ action: 'agent-approval', id: f.chat.current().id, approvalId: approval.id, allow: true })
    await vi.waitFor(() => expect(f.chat.snapshot().phase).toBe('idle'))
    expect(result).toContain('Reviewed fixture change')
    expect(git(f.root, 'log', '-1', '--format=%s').trim()).toBe('Reviewed fixture change')
    expect(git(f.root, 'log', '-1', '--format=%an <%ae>').trim()).toBe('Global Fixture User <global-fixture@example.invalid>')
    expect(await readFile(join(f.root, '.claude', 'commands', 'platform-init.md'), 'utf8')).toBe('# unstaged but preserved\n')
    expect(git(f.root, 'show', 'HEAD:.claude/commands/platform-init.md')).toBe('# original\n')
    f.chat.dispose()
  }, 30_000)
  it('registers the read-only Git identity tool and requests approval before reading global config in Project Only mode', async () => {
    const read = vi.fn(async () => ({ name: { status: 'found' as const, value: 'Fixture Name', scope: 'global' as const }, email: { status: 'found' as const, value: 'fixture@example.invalid', scope: 'global' as const }, complete: true }))
    let output = ''
    const f = await fixture('read-only', async (tools, signal) => {
      expect(tools.definitions.map((entry) => entry.name)).toContain('get_git_identity')
      output = await tools.execute('get_git_identity', {}, signal)
    }, { read } as unknown as GitIdentityService)
    await vi.waitFor(() => expect(f.chat.snapshot().messages.at(-1)?.execution?.approval?.title).toBe('Read Git identity'))
    expect(read).not.toHaveBeenCalled()
    const approval = f.chat.snapshot().messages.at(-1)!.execution!.approval!
    f.chat.command({ action: 'agent-approval', id: f.chat.current().id, approvalId: approval.id, allow: true })
    await vi.waitFor(() => expect(f.chat.snapshot().phase).toBe('idle'))
    expect(read).toHaveBeenCalledOnce()
    expect(JSON.parse(output).result).toMatchObject({ complete: true, name: { value: 'Fixture Name', scope: 'global' } })
    f.chat.dispose()
  })
  it('performs real directory, create, write, patch, rename, move and approved deletion operations', async () => {
    let finished = false
    const f = await fixture('workspace-auto', async (tools, signal) => {
      const run = async (name: string, args: unknown) => {
        const result = JSON.parse(await tools.execute(name, args, signal))
        expect(result.error).toBeUndefined()
        return result
      }
      const version = async (path: string) => (await run('read_file', { path, start_line: 1, end_line: 20 })).version
      await run('create_directory', { path: 'components' })
      await run('create_file', { path: 'components/one.ts', content: 'export const a = 1\n' })
      await run('write_file', { path: 'components/one.ts', expected_version: await version('components/one.ts'), content: 'export const a = 2\n' })
      await run('apply_patch', { changes: [{ path: 'components/one.ts', expected_version: await version('components/one.ts'), content: 'export const a = 3\n' }] })
      await run('rename_file', { path: 'components/one.ts', destination: 'components/two.ts', expected_version: await version('components/one.ts') })
      await run('move_file', { path: 'components/two.ts', destination: 'moved.ts', expected_version: await version('components/two.ts') })
      await run('delete_file', { path: 'moved.ts', expected_version: await version('moved.ts') })
      await run('delete_directory', { path: 'components' })
      finished = true
    })
    for (let i = 0; i < 4; i++) {
      await vi.waitFor(() => expect(f.chat.snapshot().messages.at(-1)?.execution?.approval).toBeDefined())
      const approval = f.chat.snapshot().messages.at(-1)!.execution!.approval!
      expect(approval.changes?.length).toBeGreaterThan(0)
      f.chat.command({ action: 'agent-approval', id: f.chat.current().id, approvalId: approval.id, allow: true })
    }
    await vi.waitFor(() => expect(f.chat.snapshot().phase).toBe('idle'))
    expect(finished).toBe(true)
    await expect(readFile(join(f.root, 'moved.ts'))).rejects.toThrow()
    expect(await readFile(join(f.root, 'app.ts'), 'utf8')).toBe('export const x = 1')
    const mutations = f.chat.snapshot().messages.at(-1)!.execution!.activities.filter(a => a.changes?.some(c => c.status === 'applied'))
    expect(mutations).toHaveLength(8)
    f.chat.dispose()
  })
  it('halts repeated denied writes instead of spending the entire iteration budget', async () => {
    let checked = false
    const f = await fixture('read-only', async (tools, signal) => {
      expect(await tools.execute('create_file', { path: 'blocked.ts', content: 'x' }, signal)).toContain('Read Only')
      await expect(tools.execute('create_file', { path: 'blocked.ts', content: 'x' }, signal)).rejects.toThrow('already denied')
      checked = true
    })
    await vi.waitFor(() => expect(f.chat.snapshot().phase).toBe('idle'))
    expect(checked).toBe(true); f.chat.dispose()
  })
  it('revokes permission during approval and rejects stale approvals immediately', async () => {
    const f = await fixture('ask', async (tools, signal) => { await tools.execute('create_file', { path: 'no.ts', content: 'blocked' }, signal) })
    await vi.waitFor(() => expect(f.chat.snapshot().messages.at(-1)?.execution?.approval).toBeDefined())
    const approval = f.chat.snapshot().messages.at(-1)!.execution!.approval!
    expect(f.chat.command({ action: 'project-permissions', id: f.chat.current().id, mode: 'read-only', allowDeletion: false, allowCommands: false }).ok).toBe(true)
    expect(f.chat.snapshot().phase).toBe('idle')
    expect(f.chat.command({ action: 'agent-approval', id: f.chat.current().id, approvalId: approval.id, allow: true }).ok).toBe(false)
    await expect(readFile(join(f.root, 'no.ts'))).rejects.toThrow()
    expect(f.repository.load().sessions[0].config.contextSettings).toMatchObject({ allowProjectCommands: false, allowProjectDeletion: false })
    f.chat.dispose()
  })
  it('waits for exact-session approval, applies real changes and persists duration/activity', async () => {
    const f = await fixture('ask', async (tools, signal) => {
      const result = JSON.parse(await tools.execute('create_file', { path: 'Button.tsx', content: 'export const Button = () => <button />' }, signal))
      expect(result.result.ok).toBe(true)
    })
    await vi.waitFor(() => expect(f.chat.snapshot().messages.at(-1)?.execution?.approval).toBeDefined())
    await expect(readFile(join(f.root, 'Button.tsx'))).rejects.toThrow()
    const approval = f.chat.snapshot().messages.at(-1)!.execution!.approval!
    expect(approval.changes![0].diff).toContain('+export const Button')
    expect(f.chat.command({ action: 'agent-approval', id: f.chat.current().id, approvalId: approval.id, allow: true }).ok).toBe(true)
    await vi.waitFor(() => expect(f.chat.snapshot().phase).toBe('idle'))
    expect(await readFile(join(f.root, 'Button.tsx'), 'utf8')).toContain('<button />')
    const execution = f.repository.load().sessions[0].messages.at(-1)!.execution!
    expect(execution.status).toBe('complete'); expect(execution.finishedAt).toBeGreaterThanOrEqual(execution.startedAt)
    expect(execution.activities[0].changes![0].status).toBe('applied')
    expect(f.chat.current().config.agentMode).toBe('ask'); f.chat.dispose()
  })
  it('enforces read-only in the executor rather than trusting model instructions', async () => {
    let output = ''
    const f = await fixture('read-only', async (tools, signal) => { output = await tools.execute('create_file', { path: 'Button.tsx', content: 'not allowed' }, signal) })
    await vi.waitFor(() => expect(f.chat.snapshot().phase).toBe('idle'))
    expect(output).toContain('Read Only mode blocks')
    await expect(readFile(join(f.root, 'Button.tsx'))).rejects.toThrow(); f.chat.dispose()
  })
  it('allows ordinary auto edits, prevents duplicate writes and requires approval for deletion', async () => {
    const f = await fixture('workspace-auto', async (tools, signal) => {
      const args = { path: 'Button.tsx', content: 'export const Button = 1' }
      expect(await tools.execute('create_file', args, signal)).toContain('"ok":true')
      expect(await tools.execute('create_file', args, signal)).toContain('already succeeded')
      const read = JSON.parse(await tools.execute('read_file', { path: 'Button.tsx', start_line: 1, end_line: 5 }, signal))
      expect(await tools.execute('delete_file', { path: 'Button.tsx', expected_version: read.version }, signal)).toContain('declined')
    })
    await vi.waitFor(() => expect(f.chat.snapshot().messages.at(-1)?.execution?.approval).toBeDefined())
    const approval = f.chat.snapshot().messages.at(-1)!.execution!.approval!
    f.chat.command({ action: 'agent-approval', id: f.chat.current().id, approvalId: approval.id, allow: false })
    await vi.waitFor(() => expect(f.chat.snapshot().phase).toBe('idle'))
    expect(await readFile(join(f.root, 'Button.tsx'), 'utf8')).toContain('Button'); f.chat.dispose()
  })
  it('cancels a pending approval, freezes elapsed duration and cannot apply a late approval', async () => {
    const f = await fixture('ask', async (tools, signal) => { await tools.execute('create_file', { path: 'Button.tsx', content: 'cancelled' }, signal) })
    await vi.waitFor(() => expect(f.chat.snapshot().messages.at(-1)?.execution?.approval).toBeDefined())
    const approval = f.chat.snapshot().messages.at(-1)!.execution!.approval!
    f.chat.stop()
    const end = f.chat.snapshot().messages.at(-1)!.execution!.finishedAt
    expect(f.chat.command({ action: 'agent-approval', id: f.chat.current().id, approvalId: approval.id, allow: true }).ok).toBe(false)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(f.chat.snapshot().messages.at(-1)!.execution).toMatchObject({ status: 'cancelled', finishedAt: end })
    await expect(readFile(join(f.root, 'Button.tsx'))).rejects.toThrow(); f.chat.dispose()
  })
  it('keeps mutation receipts across continuation and requires fresh reads before further edits', async () => {
    let verified = false
    const f = await fixture('workspace-auto', async (tools, signal) => {
      const create = { path: 'Button.tsx', content: 'export const Button = 1' }
      expect(await tools.execute('create_file', create, signal)).toContain('"ok":true')
      const read = JSON.parse(await tools.execute('read_file', { path: 'Button.tsx', start_line: 1, end_line: 10 }, signal))
      tools.continuation?.()
      expect(await tools.execute('create_file', create, signal)).toContain('already succeeded')
      const edit = { path: 'Button.tsx', expected_version: read.version, old_text: 'Button = 1', new_text: 'Button = 2' }
      expect(await tools.execute('edit_file', edit, signal)).toContain('after continuation')
      await tools.execute('read_file', { path: 'Button.tsx', start_line: 1, end_line: 10 }, signal)
      expect(await tools.execute('edit_file', edit, signal)).toContain('"ok":true')
      verified = true
    })
    await vi.waitFor(() => expect(f.chat.snapshot().phase).toBe('idle'))
    expect(verified).toBe(true)
    expect(await readFile(join(f.root, 'Button.tsx'), 'utf8')).toBe('export const Button = 2')
    const checkpoint = f.repository.load().sessions[0].messages.at(-1)!.execution!.taskCheckpoint!
    expect(checkpoint.modifiedFiles).toEqual(['Button.tsx'])
    expect(checkpoint.workspaceIds).toHaveLength(1)
    expect(checkpoint.pendingActions).toEqual([])
    f.chat.dispose()
  })
})
