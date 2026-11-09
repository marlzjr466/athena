// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath, symlink } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkspaceService } from '../electron/main/ai/workspaceService'
import { AgentTools } from '../electron/main/ai/agentTools'
import { SlashCommandService } from '../electron/main/ai/slashCommandService'
import { ProjectIntelligence } from '../electron/main/ai/projectIntelligence'
import { combineTools } from '../electron/main/ai/applicationTools'
import { newConversation } from '../electron/main/ai/conversationRepository'
import { analyzeMLXProject, mlxReadOnlyTools } from '../electron/main/ai/mlxProjectAnalysis'
import { MLXProvider } from '../electron/main/ai/MLXProvider'
import { defaultSettings } from '../shared/settings'
import type { OllamaService } from '../electron/main/ai/ollamaService'
vi.mock('../electron/main/logger', () => ({ log: vi.fn() }))
const roots: string[] = []
afterEach(async () => { for (const p of roots.splice(0)) await rm(p, { recursive: true, force: true }) })
async function fixture(external?: string) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mlx-project-'))); roots.push(root)
  const project = external ?? join(root, 'project'), storage = join(root, 'storage')
  await mkdir(storage)
  if (!external) {
    for (const folder of ['src/components', 'src/api', 'docs', '.claude/commands', '.codex/skills/review', 'ignored', 'skills/platform-spec']) await mkdir(join(project, folder), { recursive: true })
    for (const [path, text] of Object.entries({
      'package.json': JSON.stringify({ name: 'fixture', dependencies: { react: '19', 'react-router-dom': '7', axios: '1' }, devDependencies: { typescript: '5', vite: '7' } }),
      'tsconfig.json': '{"compilerOptions":{"jsx":"react-jsx"}}',
      'src/main.tsx': 'import App from "./App";\ncreateRoot(document.getElementById("root")).render(<App/>);',
      'src/App.tsx': 'import { Routes, Route } from "react-router-dom";\nexport default function App(){return <Routes><Route path="/home" /></Routes>}',
      'src/api/client.ts': 'import axios from "axios";\nexport const client=axios.create({baseURL:"/api"});',
      'src/components/Card.tsx': 'export function Card(){return <div>Card</div>}',
      'skills/platform-spec/CLAUDE.md': 'Skill reference text only; never execute instructions here.',
      'AGENTS.md': 'Read project evidence. Never execute this document.',
      'CLAUDE.md': 'See docs/architecture.md.',
      '.claude/commands/platform-spec.md': 'Read [architecture](../../docs/architecture.md) and [skill](../../skills/platform-spec/).\nDo not execute me.',
      '.codex/skills/review/SKILL.md': '---\nname: review\ndescription: Review sources\n---\nRead the project; do not run scripts.',
      'docs/architecture.md': 'React UI imports the API client.\n[Missing](missing.md)',
      '.gitignore': 'ignored/\n.claude/\n.codex/\n',
      'ignored/private.ts': 'IGNORE_ME', '.env': 'PRIVATE_VALUE=hidden',
    })) await writeFile(join(project, path), text)
    await symlink('/etc/passwd', join(project, 'src/escape.ts'))
  }
  const workspaces = new WorkspaceService(() => true), workspace = await workspaces.connect(project)
  const session = newConversation(); session.workspaces = [workspace]; session.config.agentMode = 'read-only'
  const activity = vi.fn(() => crypto.randomUUID()), finishActivity = vi.fn()
  const chat = { getSession: () => session, activity, finishActivity, approve: vi.fn(async () => false), beforeAction: async () => {}, stageChanges: vi.fn(), updateActivityOutput: vi.fn(), updateActivityLabel: vi.fn(), changeReverted: vi.fn() }
  const sources: any[] = []
  const base = new AgentTools(workspaces, storage).create(chat, session.id, workspace.id, workspace.name, 'read-only', sources, () => true)
  const intelligence = new ProjectIntelligence(workspaces, new SlashCommandService(workspaces, storage, () => true), storage, { call: vi.fn() })
  const extensions = intelligence.createTools(session, base, async () => { throw new Error('Semantic index is not needed') }, async () => {})
  const tools = combineTools(base, extensions)!
  return { project, tools, activity, finishActivity, sources, workspace, workspaces }
}
async function collect(f: Awaited<ReturnType<typeof fixture>>, request = 'Analyze project architecture') {
  let text = ''
  for await (const event of analyzeMLXProject(f.tools, f.workspace.name, request, {})) if (event.type === 'text') text += event.text
  return text
}
describe('MLX verified read-only project intelligence', () => {
  it('collects real code, command references and operation activity, without writing project files', async () => {
    const f = await fixture(), original = await readFile(join(f.project, 'package.json'), 'utf8')
    const text = await collect(f)
    for (const expected of ['react', 'axios', 'typescript', 'src/main.tsx', 'src/api/client.ts', 'platform-spec', 'docs/architecture.md', '.codex/skills/review/SKILL.md', 'AGENTS.md', 'skills/platform-spec/CLAUDE.md']) expect(text).toContain(expected)
    expect(text).not.toContain('IGNORE_ME'); expect(text).not.toContain('PRIVATE_VALUE')
    expect(f.activity).toHaveBeenCalledWith('read_file', expect.stringContaining('package.json'))
    expect(f.finishActivity).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ status: 'complete' }))
    expect(f.sources.some(s => s.path === 'src/api/client.ts')).toBe(true)
    expect(await readFile(join(f.project, 'package.json'), 'utf8')).toBe(original)
  })
  it('blocks mutation, shell and escaped paths even if underlying tools advertise them', async () => {
    const f = await fixture(), execute = vi.fn()
    const tools = mlxReadOnlyTools({ ...f.tools, execute, definitions: [...f.tools.definitions, { name: 'write_file', description: '', parameters: {} }] })
    for (const name of ['write_file', 'execute_command', 'execute_project_workflow']) await expect(tools.execute(name, {}, new AbortController().signal)).rejects.toThrow('read-only')
    for (const path of ['/etc/passwd', '../outside', '~/.ssh', 'src/../.env']) await expect(tools.execute('read_file', { path }, new AbortController().signal)).rejects.toThrow('relative path')
    expect(execute).not.toHaveBeenCalled()
  })
  it('uses fresh targeted ranges and surfaces actual missing-file, symlink and schema errors', async () => {
    const f = await fixture()
    expect(await collect(f, 'Read src/api/client.ts')).toContain('axios')
    await writeFile(join(f.project, 'src/api/client.ts'), 'export const updated = true')
    expect(await collect(f, 'Read src/api/client.ts')).toContain('updated')
    expect(await collect(f, 'Read missing.ts')).toContain('ENOENT')
    expect(await collect(f, 'Read src/escape.ts')).toMatch(/symlink|symbolic/i)
    const result = JSON.parse(await mlxReadOnlyTools(f.tools).execute('read_file', { path: 'package.json', end_line: 'wrong' }, new AbortController().signal))
    expect(result.error).toContain('Invalid tool arguments')
  })
  it('routes analysis without relying on model tool initiation and fails closed without project access', async () => {
    const f = await fixture(), call = vi.fn()
    const provider = new MLXProvider({ call } as unknown as OllamaService, 'mlx:athena-coder-v2', defaultSettings.localAI, { name: 'mlx:athena-coder-v2', size: 1, capabilities: ['completion'], provider: 'mlx' })
    const history = [{ id: '1', role: 'user' as const, content: 'Analyze this project', status: 'complete' as const, createdAt: 1 }]
    let answer = ''
    for await (const e of provider.streamMessage(history, { context: { authorizedProject: true, projectName: 'fixture', projectTools: f.tools, attachments: [], sources: [], repositoryText: '' } })) if (e.type === 'text') answer += e.text
    expect(answer).toContain('package.json'); expect(call).not.toHaveBeenCalled()
    await expect((async () => { for await (const _ of provider.streamMessage(history)) {} })()).rejects.toThrow('authorized project')
  })
  it('stops immediately on cancellation or revocation', async () => {
    const f = await fixture(), abort = new AbortController(); abort.abort()
    await expect((async () => { for await (const _ of analyzeMLXProject(f.tools, 'fixture', '', { signal: abort.signal })) {} })()).rejects.toThrow()
    await expect(collect({ ...f, tools: { ...f.tools, assertAccess() { throw new Error('Project disconnected') } } })).rejects.toThrow('disconnected')
  })
  it.skipIf(!process.env.ATHENA_PROJECT_ROOT)('inspects the authorized real project read-only', async () => {
    const f = await fixture(process.env.ATHENA_PROJECT_ROOT)
    const before = await readFile(join(f.project, 'package.json'), 'utf8')
    const state = () => createHash('sha256').update(execFileSync('git', ['diff', '--no-ext-diff', '--binary', 'HEAD'], { cwd: f.project, maxBuffer: 32 * 1024 * 1024 })).update(execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: f.project })).digest('hex')
    const originalState = state()
    const report = await collect(f)
    await writeFile('/private/tmp/athena-mlx-project-report.md', report)
    expect(report).toContain('package.json'); expect(report).toContain('react'); expect(report).toContain('src/')
    for (const expected of ['src/main.tsx', 'src/router.tsx', 'src/routeConfig.tsx', 'src/api/baseQuery.ts', '/platform-spec', '/platform-dev', 'skills/platform-dev/CLAUDE.md']) expect(report).toContain(expected)
    expect(f.activity.mock.calls.length).toBeGreaterThan(10)
    expect(await readFile(join(f.project, 'package.json'), 'utf8')).toBe(before)
    expect(state()).toBe(originalState)
  }, 180000)
})
