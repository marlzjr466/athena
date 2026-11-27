// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { ChatController } from '../electron/main/ai/chatController'
import { ChatContextService, gateLocalTools } from '../electron/main/ai/chatContextService'
import { AttachmentService } from '../electron/main/ai/attachmentService'
import { AgentTools } from '../electron/main/ai/agentTools'
import { WorkspaceService } from '../electron/main/ai/workspaceService'
import { WorkspaceGrants } from '../electron/main/ai/workspaceGrants'
import { NativeActionRegistry } from '../electron/main/ai/nativeActionRegistry'
import { voiceProjectActions } from '../electron/main/ai/voiceProjectActions'
import { resolveVoiceActionPlan, matchesDictatedText } from '../electron/main/ai/voiceActionPlan'
import { AutomationAuditLog } from '../electron/main/ai/automationAudit'
import { defaultSettings, restoreSettings } from '../shared/settings'
import { ChatError, type AIProvider } from '../electron/main/ai/AIProvider'
import { ConversationRepository } from '../electron/main/ai/conversationRepository'
import { LocalWhisperTranscription } from '../electron/main/voice/localVoiceServices'
import { HandsFreeController } from '../electron/main/voice/handsFreeController'
import { classifyHandsFreeTranscript, encodeHandsFreeWav } from '../shared/handsFree'
import { OllamaService } from '../electron/main/ai/ollamaService'
import { localCompanionProvider } from '../electron/main/ai/localCompanion'

vi.mock('../electron/main/logger', () => ({ log: vi.fn() }))
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })
async function fixture(preserveForEditorReview = false) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'athena-voice-actions-'))), root = join(dir, 'Voice Project')
  await mkdir(root); await mkdir(join(root, 'src')); await writeFile(join(root, 'src', 'base.ts'), 'export const value = 1\n')
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' }, stdio: ['ignore', 'pipe', 'pipe'] })
  git('init', '-b', 'main'); git('add', '.'); git('commit', '-m', 'isolated voice fixture'); git('branch', 'feature/other')
  const settings = structuredClone(defaultSettings)
  for (const key of Object.keys(settings.automationPermissions) as Array<keyof typeof settings.automationPermissions>) settings.automationPermissions[key] = true
  const workspaces = new WorkspaceService(() => true, new WorkspaceGrants(join(dir, 'online')))
  const provider: AIProvider = { testConnection: async () => true, async *streamMessage() { yield { type: 'text', text: 'fixture response' }; yield { type: 'done' } } }
  const online = new ChatController({ provider: async () => provider, changed: vi.fn(), phase: vi.fn(), authorized: id => workspaces.authorized(id), workspaceOnly: () => true }, new ConversationRepository(join(dir, 'online')))
  const workspace = await workspaces.connect(root); online.addWorkspace(online.current().id, workspace)
  const agent = new AgentTools(workspaces, join(dir, 'edits'))
  const context = new ChatContextService(online, new AttachmentService(dir, () => true, () => { throw new Error('unused') }), workspaces, { folder: async () => root, files: async () => [] }, () => true, agent, undefined, undefined, undefined, undefined, undefined, () => settings)
  const local = new ChatController({ provider: async () => { throw new Error('No model needed for native voice commands') }, changed: vi.fn(), phase: vi.fn() })
  const controller = { settings, windows: { showControl: vi.fn() }, setAutomationActivity: vi.fn(), updateSettings: vi.fn() }
  const audit = new AutomationAuditLog(join(dir, 'audit'))
  const registry = new NativeActionRegistry({ controller: controller as never, onlineChat: online, localAthenaChat: local, chatGPT: { status: vi.fn(() => { throw new Error('Authentication must not be queried') }) } as never, validateLocalModel: async () => true, permissions: { isCapabilityAllowed: () => true } as never, audit, confirmDelete: async () => false })
  const pickFolder = vi.fn(async () => dir as string | undefined)
  registry.register(voiceProjectActions({ chat: online, context, pickFolder, provider:()=> 'subscription',catalog:async()=>({refreshedAt:Date.now(),accounts:[{route:{provider:'subscription',accountId:'fixture'},name:'ChatGPT',enabled:true,state:'connected',models:[{id:'gpt-6.2-astra',label:'GPT-6.2 Astra',available:true,efforts:['high']}]}]}),reveal: vi.fn(), showConversation: vi.fn() }))
  const command = async (text: string, id = randomUUID()) => registry.createTools({ localChat: local, userText: text, requestId: id, voiceOnly: true }).resolveDeterministicAction!(text, new AbortController().signal)
  cleanups.push(async () => { context.dispose(); await agent.dispose(); online.dispose(); local.dispose(); if (!preserveForEditorReview) await rm(dir, { recursive: true, force: true }) })
  return { dir, root, git, settings, workspaces, workspace, online, local, context, registry, command, pickFolder }
}

describe('voice commands through the native registry and real local services', () => {
  it.runIf(process.env.ATHENA_VOICE_PLANNER_LIVE === '1')('plans a fixture file inspection with the installed local model and actual shared executor', async () => {
    const f = await fixture(), calls: string[] = []
    f.settings.localAI = { ...f.settings.localAI, model: 'qwen2.5-coder:3b', contextLength: 16384, maxOutputTokens: 512, temperature: 0 }
    const service = new OllamaService(() => 'http://127.0.0.1:11434')
    const voice: ChatController = new ChatController({ changed: vi.fn(), phase: vi.fn(), resource: 'local', origin: 'athena-local', effectiveModel: () => f.settings.localAI.model,
      voiceTimeoutMs: () => 120_000,
      provider: config => localCompanionProvider(service, f.settings, config),
      prepare: async (_session, _messages, signal) => {
        const tools = gateLocalTools((await f.context.voiceProjectTools(signal, voice, () => f.settings.automationPermissions))!.tools, () => f.settings.automationPermissions)
        const execute = tools.execute.bind(tools)
        return { attachments: [], repositoryText: '', sources: [], projectTools: { ...tools, execute: async (name, input, signal) => { calls.push(name); return execute(name, input, signal) } } }
      },
    })
    try {
      const result = await voice.answerHandsFree({ text: 'Please read the file src/base.ts in this project and tell me the value assigned to value. Do not modify anything.', id: randomUUID() })
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true })
      expect(calls).toContain('read_file')
      expect(result.text).toMatch(/\b1\b/)
      expect(f.git('status', '--porcelain=v1')).toBe('')
      console.info('Live local planner verified', { model: f.settings.localAI.model, calls, result: result.ok })
    } finally { voice.dispose() }
  }, 150_000)
  it.runIf(process.env.ATHENA_VOICE_EDITOR_LIVE === '1')('opens the authorized fixture through the real installed VS Code launcher', async () => {
    // The OS open receipt precedes the editor consuming the folder. Retain this
    // explicitly gated fixture for visual verification; never delete it early.
    const f = await fixture(true)
    await writeFile('/tmp/athena-voice-editor-fixture.json', JSON.stringify({ directory: f.dir, project: f.root }))
    expect(await f.context.editor.run({ action: 'status' })).toMatchObject({ available: true })
    const result = await f.command('Athena, open this project in VS Code')
    expect(result).toMatchObject({ handled: true, text: expect.stringContaining('VS Code accepted') })
    expect(f.git('status', '--porcelain=v1')).toBe('')
  })
  it.runIf(Boolean(process.env.ATHENA_WHISPER_MODEL))('transcribes actual synthetic audio locally, recognizes the wake word and executes a native conversation action', async () => {
    const f = await fixture(), audio = join(f.dir, 'utterance.wav')
    execFileSync('/usr/bin/say', ['-v', 'Samantha', '--file-format=WAVE', '--data-format=LEI16@16000', '-o', audio, 'Athena, create a new chat.'], { timeout: 15_000 })
    f.settings.localAI.speechModelPath = process.env.ATHENA_WHISPER_MODEL!
    f.settings.voiceInteraction.handsFreeEnabled = true
    const controller = new HandsFreeController(new LocalWhisperTranscription(() => f.settings), () => f.settings, () => true)
    try {
      expect(controller.activate(1)).toMatchObject({ ok: true })
      const wav = await readFile(audio)
      let pcm: Buffer | undefined
      for (let offset = 12; offset + 8 <= wav.length;) { const size = wav.readUInt32LE(offset + 4); if (wav.toString('ascii', offset, offset + 4) === 'data') pcm = wav.subarray(offset + 8, offset + 8 + size); offset += 8 + size + size % 2 }
      expect(pcm).toBeDefined()
      // Feed the same canonical WAV format produced by the microphone encoder.
      const bytes = encodeHandsFreeWav(Float32Array.from({ length: pcm!.length / 2 }, (_, i) => pcm!.readInt16LE(i * 2) / 32768)), id = randomUUID()
      const recognized = await controller.transcribe(1, { id, mimeType: 'audio/wav', bytes })
      expect(recognized.ok, recognized.message).toBe(true)
      expect(recognized.transcript).toMatch(/Athena/i)
      expect(classifyHandsFreeTranscript(recognized.transcript!, f.settings.voiceInteraction.wakePhrases, false, true)).toMatchObject({ kind: 'command' })
      const previous = f.online.current().id
      expect(await f.command(recognized.transcript!)).toMatchObject({ handled: true, text: expect.stringContaining('Created') })
      expect(f.online.current().id).not.toBe(previous)
      expect(bytes.every(value => value === 0)).toBe(true)
    } finally { controller.dispose() }
  }, 60_000)
  it('preserves staged, unstaged and untracked work across a verified branch switch and creation', async () => {
    const f = await fixture()
    await writeFile(join(f.root, 'src', 'base.ts'), 'staged'); f.git('add', '.')
    await writeFile(join(f.root, 'src', 'base.ts'), 'keep unstaged'); await writeFile(join(f.root, 'untracked'), 'keep')
    const before = f.git('status', '--porcelain=v1', '-z')
    expect(await f.command('Athena, what branch am I on?')).toMatchObject({ handled: true, text: expect.stringContaining('main') })
    expect(await f.command('Athena, switch to feature/other')).toMatchObject({ text: expect.stringContaining('Switched to feature/other') })
    const id = randomUUID(), created = await f.command('Create a branch named feature/voice', id)
    expect(created.text).toContain('Created and switched')
    expect(await f.command('Create a branch named feature/voice', id)).toEqual(created)
    expect(f.git('branch', '--show-current').trim()).toBe('feature/voice')
    expect(f.git('status', '--porcelain=v1', '-z')).toBe(before)
    const log = await readFile(join(f.dir, 'audit', 'audit.json'), 'utf8')
    expect(log).toContain('athena.git.create'); expect(log).not.toContain('feature/voice'); expect(log).not.toContain('keep unstaged')
  })
  it('blocks unsafe Git switches without false success or data loss', async () => {
    const f = await fixture()
    f.git('switch', 'feature/other'); await writeFile(join(f.root, 'src', 'base.ts'), 'other'); f.git('commit', '-am', 'fixture conflict'); f.git('switch', 'main')
    await writeFile(join(f.root, 'src', 'base.ts'), 'local work')
    expect(await f.command('switch to feature/other')).toMatchObject({ success: false, text: expect.stringContaining('overwritten') })
    expect(f.git('branch', '--show-current').trim()).toBe('main')
    expect(await readFile(join(f.root, 'src', 'base.ts'), 'utf8')).toBe('local work')
  })
  it('checks disabled categories on every action and read-only mode at the Git service', async () => {
    const f = await fixture(); f.settings.automationPermissions.gitOperations = false
    expect(await f.command('list my local branches')).toMatchObject({ success: false, text: expect.stringContaining('is off') })
    f.settings.automationPermissions.gitOperations = true
    f.online.command({ action: 'agent-mode', id: f.online.current().id, mode: 'read-only' })
    expect(await f.command('switch to feature/other')).toMatchObject({ success: false, text: expect.stringContaining('Read Only') })
    expect(f.git('branch', '--show-current').trim()).toBe('main')
  })
  it('creates a normal conversation without authentication, opens named projects and requires a picker for unknown paths', async () => {
    const f = await fixture(), projectSession = f.online.current().id
    expect(await f.command('create a new normal chat')).toMatchObject({ text: expect.stringContaining('Created') })
    expect(f.online.current().workspaces).toHaveLength(0)
    expect(await f.command('open Voice Project')).toMatchObject({ text: expect.stringContaining('Opened project') })
    expect(f.online.current().id).toBe(projectSession)
    expect(await f.command('open unknown project')).toMatchObject({ success: false, text: expect.stringContaining('choose its folder') })
    f.pickFolder.mockResolvedValueOnce(undefined)
    expect(await f.command('open another project')).toMatchObject({ success: false, text: expect.stringContaining('cancelled') })
    expect(await f.command('create a new project folder named Voice Fixture')).toMatchObject({ text: expect.stringContaining('Created and opened') })
    expect(await realpath(join(f.dir, 'Voice Fixture'))).toBe(await f.workspaces.authorizedRoot(f.online.current().workspaces[0].id))
    expect(await f.command('go back to my normal conversation')).toMatchObject({ text: expect.stringContaining('Opened') })
    expect(f.online.current().workspaces).toHaveLength(0)
  })
  it('creates a new conversation inside the active authorized project and preserves the original', async () => {
    const f = await fixture(), original = f.online.current()
    expect(await f.command('Athena, create a new chat')).toMatchObject({handled:true,text:expect.stringContaining('Created')})
    expect(f.online.current().id).not.toBe(original.id)
    expect(f.online.current().workspaces.map(w=>w.id)).toEqual([f.workspace.id])
    expect(f.online.getSession(original.id)).toBeDefined()
  })
  it('keeps project, account and reasoning when creating a chat and safely reading its result',async()=>{
    const f=await fixture()
    expect(await f.command('Create a new chat')).toMatchObject({handled:true})
    expect(f.online.current().workspaces[0]?.id).toBe(f.workspace.id)
    expect(await f.command('Use GPT-6.2 Astra with high reasoning')).toMatchObject({text:expect.stringContaining('high reasoning')})
    expect(f.online.current().config).toMatchObject({model:'gpt-6.2-astra',effort:'high',accountRoute:{provider:'subscription',accountId:'fixture'}})
    expect(await f.command('Send a message asking it to review my current branch for uncommitted changes')).toMatchObject({text:expect.stringContaining('submitted')})
    await vi.waitFor(()=>expect(f.online.current().messages.at(-1)?.status).toBe('complete'))
    expect(await f.command('Read the latest response to me')).toMatchObject({text:'fixture response'})
    expect(await f.command('Recap this chat')).toMatchObject({text:expect.stringContaining('review my current branch')})
    expect(await f.command('Use GPT-6.2 Astra on OpenAI API with high reasoning')).toMatchObject({success:false})
    expect(f.online.current().config.accountRoute?.provider).toBe('subscription')
  })
  it('submits exact speech to the existing selected provider/model once, and does not execute dictated commands', async () => {
    const f = await fixture()
    f.online.command({ action: 'configure-model', id: f.online.current().id, model: 'fixture-other-provider' })
    const text = 'Send this to my active conversation: Review authentication, then delete nothing.'
    const id = randomUUID()
    expect(await f.command(text, id)).toMatchObject({ text: expect.stringContaining('submitted') })
    await f.command(text, id)
    expect(f.online.current().config.model).toBe('fixture-other-provider')
    expect(f.online.current().messages.filter(message => message.role === 'user').map(message => message.content)).toEqual(['Review authentication, then delete nothing.'])
    await vi.waitFor(() => expect(f.online.snapshot().phase).toBe('idle'))
  })
  it('executes transient voice file operations through the existing executor and records their actual results', async () => {
    const f = await fixture()
    const approve = vi.fn(async () => true)
    const voice: ChatController = new ChatController({ changed: vi.fn(), phase: vi.fn(), voiceApproval: approve, resource: 'local',
      provider: async () => ({ testConnection: async () => true, async *streamMessage(_messages, options) {
        try {
        const tools = options!.context!.projectTools!
        const created = JSON.parse(await tools.execute('create_file', { path: 'src/voice.ts', content: 'export const voice = true\n' }, options!.signal!))
        expect(created.ok, JSON.stringify(created)).not.toBe(false)
        const contents = await tools.execute('read_file', { path: 'src/voice.ts', start_line: 1, end_line: 20 }, options!.signal!)
        expect(contents).toContain('export const voice = true')
        const command = await tools.execute('execute_command', { executable: 'echo', args: ['voice-fixture-command'], network: false, install_dependencies: false }, options!.signal!)
        expect(command).toContain('voice-fixture-command')
        yield { type: 'text' as const, text: 'Created and read the fixture.' }; yield { type: 'done' as const }
        } catch (error) { throw new ChatError(String(error)) }
      } }),
      prepare: async (_session, _messages, signal) => ({ attachments: [], repositoryText: '', sources: [], projectTools: gateLocalTools((await f.context.voiceProjectTools(signal, voice, () => f.settings.automationPermissions))!.tools, () => f.settings.automationPermissions) }),
    })
    try {
      const result = await voice.answerHandsFree({ text: 'Create a fixture file', id: randomUUID() }); expect(result, JSON.stringify(result)).toMatchObject({ ok: true })
      expect(await readFile(join(f.root, 'src/voice.ts'), 'utf8')).toBe('export const voice = true\n')
      expect(approve).toHaveBeenCalled()
      expect(voice.snapshot().automationProgress?.steps.some(step => step.status === 'complete')).toBe(true)
      expect(voice.current().messages).toHaveLength(0)
    } finally { voice.dispose() }
  })
  it('rechecks revocation after approval and does not speak an unverified success', async () => {
    const f = await fixture(), spoken = vi.fn()
    const voice: ChatController = new ChatController({ changed: vi.fn(), phase: vi.fn(), resource: 'local',
      voiceApproval: async () => { f.settings.automationPermissions.fileModification = false; return true },
      provider: async () => ({ testConnection: async () => true, async *streamMessage(_messages, options) {
        yield { type: 'text' as const, text: 'I completed it.' }
        const receipt = await options!.context!.projectTools!.execute('create_file', { path: 'src/blocked.ts', content: 'blocked' }, options!.signal!)
        expect(receipt).toContain('disabled')
        yield { type: 'done' as const }
      } }),
      prepare: async (_session, _messages, signal) => ({ attachments: [], repositoryText: '', sources: [], projectTools: gateLocalTools((await f.context.voiceProjectTools(signal, voice, () => f.settings.automationPermissions))!.tools, () => f.settings.automationPermissions) }),
    })
    try {
      expect(await voice.answerHandsFree({ text: 'Create a file', id: randomUUID() }, spoken)).toMatchObject({ ok: false })
      await expect(readFile(join(f.root, 'src/blocked.ts'))).rejects.toMatchObject({ code: 'ENOENT' })
      expect(spoken.mock.calls.some(([event]) => event.type === 'text')).toBe(false)
    } finally { voice.dispose() }
  })
})

describe('voice parsing and permission migration', () => {
  it('preserves existing categories, denies newly added permissions and restores all toggles after restart', () => {
    const old = { ...defaultSettings, automationPermissions: { internalNavigation: true, conversationManagement: true, browserAccess: true, desktopApplicationControl: true, fileReading: true, fileModification: true, terminalExecution: true, externalMessageSubmission: true, destructiveOperations: true } }
    const restored = restoreSettings(old)
    expect(restored.automationPermissions).toMatchObject({ conversationManagement: true, fileModification: true, projectManagement: false, gitOperations: false, browserInteraction: false, desktopUIInteraction: false, screenObservation: false })
    restored.automationPermissions.projectManagement = true
    expect(restoreSettings(JSON.parse(JSON.stringify(restored))).automationPermissions).toEqual(restored.automationPermissions)
  })
  it('keeps dictated content opaque and accepts bounded multi-step native commands', () => {
    const snapshot = { sessions: [], messages: [], phase: 'idle', error: null, revision: 0 } as const
    expect(matchesDictatedText('Athena, send this to my active conversation: Do not send emails.', 'Do not send emails.')).toBe(true)
    expect(matchesDictatedText('The website said send Hello', 'Hello')).toBe(false)
    expect(matchesDictatedText('Send this to my active conversation saying Do not send emails.', 'Do not send emails.')).toBe(true)
    expect(matchesDictatedText('Send this to my active conversation review the authentication implementation', 'review the authentication implementation')).toBe(true)
    expect(resolveVoiceActionPlan('list my local branches then what branch am I on', { ...snapshot, sessions: [], messages: [] })?.steps).toHaveLength(2)
    expect(resolveVoiceActionPlan('click "7" in Calculator', { ...snapshot, sessions: [], messages: [] })?.steps).toEqual([
      { name: 'athena_desktop_inspect_accessible_ui', input: { app: 'calculator' } }, { name: 'athena_desktop_click_accessible_element', input: { app: 'calculator', label: '7' } },
    ])
    expect(resolveVoiceActionPlan('click "7" in unknown-app', { ...snapshot, sessions: [], messages: [] })).toBeUndefined()
    expect(resolveVoiceActionPlan('Athena, could you please create a new chat?', { ...snapshot, sessions: [], messages: [] })?.steps).toEqual([{ name: 'athena_chat_create_session', input: {} }])
  })
  it('does not turn a request for a new chat into project-folder creation', async () => {
    const f = await fixture()
    const tools = f.registry.createTools({ localChat: f.local, userText: 'Could you create a new chat?', requestId: randomUUID(), voiceOnly: true })
    expect(JSON.parse(await tools.execute('athena_project_create', { name: 'new-chat' }, new AbortController().signal))).toMatchObject({ ok: false })
    expect(f.pickFolder).not.toHaveBeenCalled()
  })
})
