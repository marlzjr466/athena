import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChatController } from '../electron/main/ai/chatController'
import { ChatError, NOT_CONFIGURED, type AIProvider } from '../electron/main/ai/AIProvider'
import { localInferenceSlots } from '../electron/main/ai/localInferenceSlots'
import type { AIChunk, ChatMessage } from '../shared/chat'
import { timelineBlocks } from '../src/features/chat/agentTimelinePresentation'
vi.mock('../electron/main/logger', () => ({ log: vi.fn() }))
const gate = () => { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done }); return { promise, resolve } }
function fixture(stream: AIProvider['streamMessage'] = async function* () { yield { type: 'text', text: 'Hello.' }; yield { type: 'done' } }) {
  const provider: AIProvider = { testConnection: async () => true, streamMessage: vi.fn(stream) }
  const hooks = { provider: vi.fn(async () => provider), changed: vi.fn(), phase: vi.fn() }
  return { chat: new ChatController(hooks), provider, hooks }
}
afterEach(() => vi.useRealTimers())
describe('main-owned conversation lifecycle', () => {
  it('shows the project inspection preface only on the first ordinary turn', async () => {
    const f = fixture()
    f.chat.addWorkspace(f.chat.current().id, { id: '58922cd4-0341-42bb-9c8d-2bc40c1d13eb', name: 'Project' })
    expect(f.chat.send({ text: 'Help me with this project' })).toEqual({ ok: true })
    await vi.waitFor(() => expect(f.chat.snapshot().phase).toBe('idle'))
    expect(f.chat.snapshot().messages[1].execution?.timeline?.[0]?.text).toBe('I’ll inspect the authorized project and its current state before making changes.')
    expect(f.chat.send({ text: 'Now answer this follow-up' })).toEqual({ ok: true })
    await vi.waitFor(() => expect(f.chat.snapshot().phase).toBe('idle'))
    expect(f.chat.snapshot().messages[3].execution?.timeline?.some((entry) => entry.kind === 'started')).toBe(false)
    f.chat.dispose()
  })

  it('acknowledges a slash command without claiming to inspect the project', async () => {
    const provider: AIProvider = { testConnection: async () => true, streamMessage: vi.fn(async function* (): AsyncGenerator<AIChunk> { yield { type: 'text', text: 'Working on the requested command.' }; yield { type: 'done' } }) }
    const chat = new ChatController({ provider: async () => provider, resolveCommand: async () => 'Authorized command instructions', changed: vi.fn(), phase: vi.fn() })
    chat.addWorkspace(chat.current().id, { id: '58922cd4-0341-42bb-9c8d-2bc40c1d13eb', name: 'Project' })
    const command = { id: 'claude:platform-build', name: '/platform-build', source: 'Claude Project' as const, arguments: 'MBM-11390' }
    expect(chat.send({ text: '/platform-build MBM-11390' }, command)).toEqual({ ok: true })
    await vi.waitFor(() => expect(chat.snapshot().phase).toBe('idle'))
    expect(chat.snapshot().messages[1].execution?.timeline?.[0]).toMatchObject({ kind: 'started', text: 'Starting /platform-build.' })
    expect(chat.snapshot().messages[1].execution?.timeline?.some((entry) => entry.text?.includes('inspect the authorized project'))).toBe(false)
    chat.dispose()
  })
  it('persists Advanced Agent mode and explicitly enables isolated project commands when selected', () => {
    const f = fixture()
    const id = f.chat.current().id
    f.chat.addWorkspace(id, { id: '58922cd4-0341-42bb-9c8d-2bc40c1d13eb', name: 'Project' })
    expect(f.chat.command({ action: 'project-permissions', id, mode: 'ask', allowDeletion: false, allowCommands: false }).ok).toBe(true)
    expect(f.chat.command({ action: 'agent-mode', id, mode: 'advanced' }).ok).toBe(true)
    expect(f.chat.snapshot().config).toMatchObject({ agentMode: 'advanced', contextSettings: { allowProjectCommands: true, allowProjectDeletion: false } })
    f.chat.dispose()
  })
  it('removes trailing web Sources appendices before saving an assistant response', async () => {
    const f = fixture(async function* () {
      yield { type: 'text', text: 'Here is the current React information.' }
      yield { type: 'text', text: '\n\nSour' }
      yield { type: 'text', text: 'ces:\n- [React](https://react.dev/blog) — react.dev; retrieved 2026-10-11T00:00:00.000Z' }
      yield { type: 'done' }
    })
    expect(f.chat.send({ text: 'Find current React information' })).toEqual({ ok: true })
    await vi.waitFor(() => expect(f.chat.snapshot().phase).toBe('idle'))
    expect(f.chat.snapshot().messages[1].content).toBe('Here is the current React information.')
    f.chat.dispose()
  })

  it('streams thinking → speaking → idle and retains completed history', async () => {
    const begin = gate(), finish = gate()
    const f = fixture(async function* () { await begin.promise; yield { type: 'text', text: 'Hello' }; await finish.promise; yield { type: 'text', text: ' there.' }; yield { type: 'done' } })
    expect(f.chat.send({ text: 'Hi' })).toEqual({ ok: true })
    expect(f.chat.snapshot().phase).toBe('thinking')
    begin.resolve()
    await vi.waitFor(() => expect(f.chat.snapshot().phase).toBe('speaking'))
    expect(f.chat.snapshot().messages[1].content).toBe('Hello')
    expect(f.chat.send({ text: 'overlap' }).ok).toBe(false)
    finish.resolve()
    await vi.waitFor(() => expect(f.chat.snapshot().phase).toBe('idle'))
    expect(f.chat.snapshot().messages.map(({ content }) => content)).toEqual(['Hi', 'Hello there.'])
    expect(f.hooks.phase.mock.calls.map(([phase]) => phase)).toEqual(['thinking', 'speaking', 'idle'])
  })
  it('publishes interleaved text and tool events before the run completes', async () => {
    const finish = gate()
    let chat!: ChatController
    const f = fixture(async function* () {
      yield { type: 'text', text: 'Checking the project.' }
      const id = chat.activity('read_file', 'Read src/App.tsx')
      await finish.promise
      chat.finishActivity(id, { status: 'complete', summary: 'Read succeeded.' })
      yield { type: 'text', text: 'The file is ready.' }
      yield { type: 'done' }
    })
    chat = f.chat
    expect(chat.send({ text: 'Inspect my project' })).toEqual({ ok: true })
    await vi.waitFor(() => expect(chat.snapshot().messages[1].execution?.activities).toHaveLength(1))
    const running = chat.snapshot().messages[1]
    expect(running.status).toBe('streaming')
    expect(running.execution?.timeline?.map((event) => event.kind)).toEqual(['text', 'activity'])
    expect(running.execution?.activities[0].status).toBe('running')
    finish.resolve()
    await vi.waitFor(() => expect(chat.snapshot().phase).toBe('idle'))
    const execution = chat.snapshot().messages[1].execution!
    expect(execution.timeline?.map((event) => event.kind)).toEqual(['text', 'activity', 'text'])
    expect(execution.activities[0].status).toBe('complete')
    const renderedBlocks = timelineBlocks(execution)
    expect(renderedBlocks.map((block) => block.kind)).toEqual(['text', 'activity-group', 'text'])
    expect(renderedBlocks[1]).toMatchObject({ kind: 'activity-group', progressId: execution.timeline?.[0].id, activities: [{ id: execution.activities[0].id, summary: 'Read succeeded.' }] })
    chat.dispose()
  })
  it('persists provider-supplied Cursor activity in the same chronological timeline as progress text', async () => {
    const finish = gate()
    const f = fixture(async function* () {
      yield { type: 'text', text: 'I am inspecting the code.' }
      yield { type: 'activity', id: 'cursor-read-1', tool: 'read_file', label: 'Read src/App.tsx', status: 'running' }
      yield { type: 'activity', id: 'cursor-read-1', tool: 'read_file', label: 'Read src/App.tsx', status: 'complete' }
      yield { type: 'activity', id: 'cursor-test-2', tool: 'execute_command', label: 'Ran npm test', status: 'error' }
      yield { type: 'text', text: 'The test failed; I will inspect it.' }
      await finish.promise
      yield { type: 'done' }
    })
    f.chat.send({ text: 'Inspect and test the project' })
    await vi.waitFor(() => expect(f.chat.snapshot().messages[1].execution?.activities).toHaveLength(2))
    const interim = f.chat.snapshot().messages[1].execution!
    expect(interim.timeline?.map((event) => event.kind)).toEqual(['text', 'activity', 'activity', 'text'])
    expect(interim.activities.map((activity) => activity.status)).toEqual(['complete', 'error'])
    finish.resolve()
    await vi.waitFor(() => expect(f.chat.snapshot().phase).toBe('idle'))
    const saved = f.chat.snapshot().messages[1].execution!
    expect(timelineBlocks(saved).map((block) => block.kind)).toEqual(['text', 'activity-group', 'text'])
    expect(saved.activities).toHaveLength(2)
    f.chat.dispose()
  })
  it('pauses an expired subscription run with completed changes intact and continues explicitly', async () => {
    let chat!: ChatController
    let attempt = 0
    const f = fixture(async function* () {
      if (++attempt === 1) {
        const id = chat.activity('write_file', 'Edit src/App.tsx')
        chat.finishActivity(id, { status: 'complete', summary: 'Applied.', changes: [{ id: 'change-1', path: 'src/App.tsx', diff: '+updated', status: 'applied' }] })
        throw new ChatError('Reconnect the same ChatGPT account.', 'auth-reconnect')
      }
      yield { type: 'text', text: 'I checked the saved change and finished.' }
      yield { type: 'done' }
    })
    chat = f.chat
    chat.send({ text: 'Update the app' })
    await vi.waitFor(() => expect(chat.snapshot().phase).toBe('idle'))
    const failed = chat.snapshot().messages[1]
    expect(failed.execution?.status).toBe('waiting-auth')
    expect(failed.execution?.activities[0].changes?.[0].status).toBe('applied')
    expect(failed.execution?.taskCheckpoint?.pendingActions[0]).toContain('Reconnect')
    expect(chat.retry()).toEqual({ ok: true })
    await vi.waitFor(() => expect(chat.snapshot().phase).toBe('idle'))
    expect(chat.snapshot().messages[1].execution?.activities[0].changes?.[0].status).toBe('applied')
    expect(chat.snapshot().messages[2].content).toContain('finished')
    const handoff = vi.mocked(f.provider.streamMessage).mock.calls[1][0].at(-1)?.content
    expect(handoff).toContain('Continue the unfinished request')
    expect(handoff).toContain('Recorded modified paths: src/App.tsx')
    expect(handoff).toContain('Do not repeat completed slices')
    chat.dispose()
  })
  it('does not resume a task under a different subscription account', async () => {
    const firstAccount = '08aa3f5f-8eea-408b-afcc-c49927489588'
    let activeAccount = firstAccount
    let chat!: ChatController
    const provider: AIProvider = { testConnection: async () => true, streamMessage: vi.fn(async function* (): AsyncGenerator<AIChunk> {
      chat.activity('read_file', 'Read project file')
      throw new ChatError('Reconnect ChatGPT.', 'auth-reconnect')
    }) }
    chat = new ChatController({ provider: async () => provider, accountIdentity: async () => activeAccount, changed: vi.fn(), phase: vi.fn() })
    expect(chat.send({ text: 'Inspect project' })).toEqual({ ok: true })
    await vi.waitFor(() => expect(chat.snapshot().phase).toBe('idle'))
    const failed = chat.snapshot().messages[1]
    expect(failed.execution?.accountId).toBe(firstAccount)
    activeAccount = '18878277-7132-4928-8370-84a027b06c29'
    expect(chat.retry()).toEqual({ ok: true })
    await vi.waitFor(() => expect(chat.snapshot().phase).toBe('idle'))
    expect(chat.snapshot().messages.at(-1)?.error).toContain('same ChatGPT account')
    expect(provider.streamMessage).toHaveBeenCalledTimes(1)
    chat.dispose()
  })
  it('does not resume a coding task after its authorized project changes', async () => {
    let chat!: ChatController
    const f = fixture(async function* () {
      const id = chat.activity('read_file', 'Read plan.md')
      chat.finishActivity(id, { status: 'complete', summary: 'Plan read.' })
      throw new ChatError('Task interrupted.')
    })
    chat = f.chat
    f.chat.send({ text: 'Build the approved slice' })
    await vi.waitFor(() => expect(f.chat.snapshot().phase).toBe('idle'))
    f.chat.addWorkspace(f.chat.current().id, { id: '58922cd4-0341-42bb-9c8d-2bc40c1d13eb', name: 'Different project' })
    expect(f.chat.retry()).toEqual({ ok: true })
    await vi.waitFor(() => expect(f.chat.snapshot().phase).toBe('idle'))
    expect(f.chat.snapshot().messages.at(-1)?.error).toContain('authorized project changed')
    expect(f.provider.streamMessage).toHaveBeenCalledTimes(1)
    f.chat.dispose()
  })
  it('keeps hands-free exchanges in a transient voice context, separate from saved chat history', async () => {
    const f = fixture(async function* (messages) {
      const userText = messages.at(-1)?.content ?? ''
      yield { type: 'text', text: userText.includes('TypeScript') ? 'TypeScript adds types.' : 'It is maintained by Microsoft.' }
      yield { type: 'done' }
    })
    f.chat.send({ text: 'Saved chat question' })
    await vi.waitFor(() => expect(f.chat.snapshot().phase).toBe('idle'))
    const savedBefore = f.chat.snapshot().messages.map((message) => message.content)

    expect(await f.chat.answerHandsFree({ text: 'What is TypeScript?' })).toMatchObject({ ok: true, text: 'TypeScript adds types.' })
    expect(await f.chat.answerHandsFree({ text: 'Who maintains it?' })).toMatchObject({ ok: true, text: 'It is maintained by Microsoft.' })
    const voiceCall = vi.mocked(f.provider.streamMessage).mock.calls.at(-1)![0]
    expect(voiceCall.map(({ role, content }) => [role, content])).toEqual([
      ['user', 'What is TypeScript?'], ['assistant', 'TypeScript adds types.'], ['user', 'Who maintains it?'],
    ])
    expect(f.chat.snapshot().messages.map((message) => message.content)).toEqual(savedBefore)

    f.chat.clearHandsFreeContext()
    await f.chat.answerHandsFree({ text: 'Start fresh' })
    expect(vi.mocked(f.provider.streamMessage).mock.calls.at(-1)![0].map(({ content }) => content)).toEqual(['Start fresh'])
    expect(f.chat.snapshot().messages.map((message) => message.content)).toEqual(savedBefore)
    f.chat.dispose()
  })
  it('direct voice diagnostics bypass context preparation and use only the current short request', async () => {
    const provider: AIProvider = { modelId: 'qwen2.5-coder:3b', testConnection: async () => true, streamMessage: vi.fn(async function* (): AsyncGenerator<AIChunk> { yield { type: 'text', text: 'Four.' }; yield { type: 'done' } }) }
    const prepare = vi.fn(async () => ({ attachments: [], repositoryText: 'optional retrieval', sources: [], projectTools: { definitions: [], assertAccess: () => {}, execute: async () => '' } }))
    const chat = new ChatController({ resource: 'local', provider: async () => provider, prepare, changed: vi.fn(), phase: vi.fn() })
    await chat.answerHandsFree({ text: 'What is two plus two?', diagnosticDirect: true })
    expect(prepare).not.toHaveBeenCalled()
    expect(vi.mocked(provider.streamMessage).mock.calls[0][0].map(({ role, content }) => [role, content])).toEqual([['user', 'What is two plus two?']])
    expect(vi.mocked(provider.streamMessage).mock.calls[0][1]).toMatchObject({ voiceOnly: true, diagnosticDirect: true, context: undefined, traceId: expect.any(String) })
    chat.dispose()
  })
  it('cancels a floating voice turn while it waits for Athena Chat’s local inference slot', async () => {
    const holder = new AbortController()
    const releaseSlot = await localInferenceSlots.acquire(holder.signal)
    const provider = fixture()
    const chat = new ChatController({ resource: 'local', ...provider.hooks })
    const pending = chat.answerHandsFree({ text: 'Cancel while queued' })
    await vi.waitFor(() => expect(provider.hooks.provider).not.toHaveBeenCalled())
    chat.cancelHandsFreeReply()
    expect(await pending).toMatchObject({ ok: false, message: 'Voice response cancelled.' })
    expect(provider.hooks.provider).not.toHaveBeenCalled()
    releaseSlot(); holder.abort(); chat.dispose()
  })
  it('publishes voice text before completion while retaining cancellation and the selected provider', async () => {
    const release = gate()
    const f = fixture(async function* () {
      yield { type: 'text', text: 'React is a JavaScript library.' }
      await release.promise
      yield { type: 'text', text: ' It builds interfaces.' }
      yield { type: 'done' }
    })
    const progress: Array<{ type: 'model-start' | 'text' | 'trace'; text?: string }> = []
    const pending = f.chat.answerHandsFree({ text: 'What is React?' }, (event) => progress.push(event))
    await vi.waitFor(() => expect(progress.map((event) => event.type)).toEqual(['model-start', 'text']))
    expect(progress[1].text).toBe('React is a JavaScript library.')
    expect(vi.mocked(f.provider.streamMessage).mock.calls[0][1]?.effort).toBe('auto')
    release.resolve()
    expect(await pending).toMatchObject({ ok: true, text: 'React is a JavaScript library. It builds interfaces.' })
    expect(progress.map((event) => event.type)).toEqual(['model-start', 'text', 'text'])
    f.chat.dispose()
  })
  it('uses the resolved provider model for adaptive voice effort without changing the selected model', async () => {
    const f = fixture()
    Object.defineProperty(f.provider, 'modelId', { value: 'gpt-5.6-sol' })
    await f.chat.answerHandsFree({ text: 'Hi!' })
    expect(vi.mocked(f.provider.streamMessage).mock.calls[0][1]?.effort).toBe('low')
    await f.chat.answerHandsFree({ text: 'What is React?' })
    expect(vi.mocked(f.provider.streamMessage).mock.calls[1][1]?.effort).toBe('medium')
    await f.chat.answerHandsFree({ text: 'Investigate this complex bug' })
    expect(vi.mocked(f.provider.streamMessage).mock.calls[2][1]?.effort).toBe('high')
    expect(f.provider.modelId).toBe('gpt-5.6-sol')
    f.chat.dispose()
  })
  it('passes the voice-only preparation flag and its safe realtime tools to the selected provider', async () => {
    const tools = { definitions: [{ name: 'web_search', description: 'Search public web', parameters: { type: 'object', properties: {}, required: [], additionalProperties: false } }], assertAccess: () => {}, execute: async () => '{}' }
    const provider: AIProvider = { testConnection: async () => true, streamMessage: vi.fn(async function* (): AsyncGenerator<AIChunk> { yield { type: 'text', text: 'Grounded answer.' }; yield { type: 'done' } }) }
    const prepare = vi.fn(async () => ({ attachments: [], repositoryText: 'Live cited evidence.', sources: [], projectTools: tools }))
    const chat = new ChatController({ provider: async () => provider, prepare, changed: vi.fn(), phase: vi.fn() })
    expect(await chat.answerHandsFree({ text: 'Search the web for React docs' })).toMatchObject({ ok: true, text: 'Grounded answer.' })
    expect(prepare).toHaveBeenCalledWith(expect.any(Object), expect.any(Array), expect.any(AbortSignal), true)
    expect(vi.mocked(provider.streamMessage).mock.calls[0][1]?.context?.projectTools?.definitions[0].name).toBe('web_search')
    expect(chat.snapshot().messages).toHaveLength(0)
    chat.dispose()
  })
  it('previews cited voice searches without saving the exchange in chat history', async () => {
    const cited = 'React docs answer.\n\nSources:\n- [React](https://react.dev/)'
    const provider: AIProvider = { testConnection: async () => true, streamMessage: vi.fn(async function* (_messages, options): AsyncGenerator<AIChunk> { yield { type: 'text', text: options?.voiceOnly ? cited : 'Saved answer.' }; yield { type: 'done' } }) }
    const prepare = vi.fn(async () => ({ attachments: [], repositoryText: '', sources: [], webSources: [{ title: 'React', url: 'https://react.dev/', source: 'react.dev', retrievedAt: '2026-10-11T00:00:00.000Z' }] }))
    const chat = new ChatController({ provider: async () => provider, prepare, changed: vi.fn(), phase: vi.fn() })
    expect(await chat.answerHandsFree({ text: 'Search for React docs' })).toMatchObject({ ok: true })
    expect(chat.snapshot().voiceSearchPreview?.content).toBe(cited)
    expect(chat.snapshot().messages).toHaveLength(0)
    chat.clearHandsFreeContext()
    expect(chat.snapshot().voiceSearchPreview?.content).toBe(cited)
    expect(chat.send({ text: 'New saved question' })).toEqual({ ok: true })
    expect(chat.snapshot().voiceSearchPreview).toBeUndefined()
    await vi.waitFor(() => expect(chat.snapshot().phase).toBe('idle'))
    expect(chat.snapshot().messages.map((message) => message.content)).not.toContain(cited)
    chat.dispose()
  })
  it('bounds a stalled voice provider and clears the thinking phase', async () => {
    const pending = gate()
    const f = fixture(async function* () { await pending.promise; yield { type: 'text', text: 'late' }; yield { type: 'done' } })
    Object.assign(f.hooks, { voiceTimeoutMs: () => 30_000 })
    vi.useFakeTimers()
    const answer = f.chat.answerHandsFree({ text: 'Are you there?' })
    await vi.advanceTimersByTimeAsync(30_000)
    expect(await answer).toMatchObject({ ok: false, message: expect.stringContaining('took too long') })
    expect(f.hooks.phase.mock.calls.at(-1)?.[0]).toBe('idle')
    pending.resolve()
    await Promise.resolve()
    f.chat.dispose()
  })
  it('cancels a stale voice turn promptly without adding it to the next turn', async () => {
    const pending = gate()
    let calls = 0
    const f = fixture(async function* () {
      if (++calls === 1) await pending.promise
      yield { type: 'text', text: 'Current answer.' }
      yield { type: 'done' }
    })
    const first = f.chat.answerHandsFree({ text: 'Old request' })
    await vi.waitFor(() => expect(f.provider.streamMessage).toHaveBeenCalledTimes(1))
    f.chat.cancelHandsFreeReply()
    expect(await first).toMatchObject({ ok: false, message: 'Voice response cancelled.' })
    expect(await f.chat.answerHandsFree({ text: 'New request' })).toMatchObject({ ok: true, text: 'Current answer.' })
    pending.resolve()
    await Promise.resolve()
    expect(vi.mocked(f.provider.streamMessage).mock.calls[1][0].map(({ content }) => content)).toEqual(['New request'])
    expect(vi.mocked(f.provider.streamMessage).mock.calls[1][1]).toMatchObject({ voiceOnly: true })
    f.chat.dispose()
  })
  it('sends earlier completed messages but never exposes system role or tools to renderer input', async () => {
    const f = fixture()
    expect(f.chat.send({ text: 'one', role: 'system' }).ok).toBe(false)
    f.chat.send({ text: 'one' }); await vi.waitFor(() => expect(f.chat.snapshot().phase).toBe('idle'))
    f.chat.send({ text: 'two' }); await vi.waitFor(() => expect(f.chat.snapshot().phase).toBe('idle'))
    expect(vi.mocked(f.provider.streamMessage).mock.calls[1][0].map(({ role, content }) => [role, content])).toEqual([['user', 'one'], ['assistant', 'Hello.'], ['user', 'two']])
  })
  it('stop aborts the request, keeps partial text and ignores late chunks', async () => {
    const finish = gate()
    let signal: AbortSignal | undefined
    const f = fixture(async function* (_messages, options) { signal = options?.signal; yield { type: 'text', text: 'Partial' }; await finish.promise; yield { type: 'text', text: ' late' }; yield { type: 'done' } })
    f.chat.send({ text: 'hello' })
    await vi.waitFor(() => expect(f.chat.snapshot().phase).toBe('speaking'))
    f.chat.stop()
    expect(signal?.aborted).toBe(true)
    finish.resolve()
    await Promise.resolve()
    expect(f.chat.snapshot().phase).toBe('idle')
    expect(f.chat.snapshot().messages[1]).toMatchObject({ content: 'Partial', status: 'stopped' })
  })
  it('clear while streaming cannot resurrect messages after a late response', async () => {
    const finish = gate()
    const f = fixture(async function* () { await finish.promise; yield { type: 'text', text: 'late' }; yield { type: 'done' } })
    f.chat.send({ text: 'clear me' }); await Promise.resolve()
    f.chat.clear(); finish.resolve(); await Promise.resolve()
    expect(f.chat.snapshot().messages).toEqual([])
    expect(f.chat.snapshot().phase).toBe('idle')
  })
  it('reports applied MLX file changes when Stop cancels the remaining task', async () => {
    const finish = gate()
    const f = fixture(async function* () { yield { type: 'text', text: 'Working.' }; await finish.promise; yield { type: 'text', text: 'late completion' }; yield { type: 'done' } })
    f.chat.current().config.model = 'mlx:fixture'
    f.chat.addWorkspace(f.chat.current().id, { id: '58922cd4-0341-42bb-9c8d-2bc40c1d13eb', name: 'Fixture' })
    f.chat.send({ text: 'Create a file' })
    await vi.waitFor(() => expect(f.chat.snapshot().phase).toBe('speaking'))
    const activity = f.chat.activity('create_file', 'src/sum.ts')
    f.chat.finishActivity(activity, { status: 'complete', changes: [{ id: 'change', path: 'src/sum.ts', diff: '+ saved', status: 'applied' }] })
    f.chat.stop(); finish.resolve(); await Promise.resolve()
    expect(f.chat.snapshot().messages.at(-1)?.content).toContain('Partially completed; remaining operations cancelled.')
    expect(f.chat.snapshot().messages.at(-1)?.content).toContain('src/sum.ts')
    expect(f.chat.snapshot().messages.at(-1)?.content).not.toContain('late completion')
    f.chat.dispose()
  })
  it('retry replaces only the latest assistant answer, not its user message', async () => {
    const f = fixture()
    f.chat.send({ text: 'Hi' }); await vi.waitFor(() => expect(f.chat.snapshot().phase).toBe('idle'))
    const userId = f.chat.snapshot().messages[0].id
    expect(f.chat.retry().ok).toBe(true)
    await vi.waitFor(() => expect(f.chat.snapshot().phase).toBe('idle'))
    expect(f.chat.snapshot().messages).toHaveLength(2)
    expect(f.chat.snapshot().messages[0].id).toBe(userId)
    expect(f.provider.streamMessage).toHaveBeenCalledTimes(2)
  })
  it('shows not-configured guidance and cleans state without contacting a provider', async () => {
    const f = fixture()
    f.hooks.provider.mockRejectedValue(new ChatError(NOT_CONFIGURED))
    f.chat.send({ text: 'Hi' })
    await vi.waitFor(() => expect(f.chat.snapshot().error).toBe(NOT_CONFIGURED))
    expect(f.chat.snapshot().phase).toBe('idle')
    expect(f.provider.streamMessage).not.toHaveBeenCalled()
  })
  it('keeps partial output on failure and never exposes unexpected error details', async () => {
    const f = fixture(async function* () { yield { type: 'text', text: 'Kept' }; throw new Error('secret-token private-content') })
    f.chat.send({ text: 'Hi' })
    await vi.waitFor(() => expect(f.chat.snapshot().phase).toBe('idle'))
    expect(f.chat.snapshot().messages[1]).toMatchObject({ content: 'Kept', status: 'error' })
    expect(JSON.stringify(f.chat.snapshot())).not.toContain('secret-token')
  })
  it('rejects blank/oversize input and limits response growth', async () => {
    const f = fixture(async function* () { yield { type: 'text', text: 'x'.repeat(48_001) } })
    for (const input of [null, { text: ' ' }, { text: 'x'.repeat(12_001) }, { text: 'test', tools: [] }]) expect(f.chat.send(input).ok).toBe(false)
    f.chat.send({ text: 'Hi' })
    await vi.waitFor(() => expect(f.chat.snapshot().phase).toBe('idle'))
    expect(f.chat.snapshot().error).toContain('display limit')
    expect(f.chat.snapshot().messages[1].content).toBe('')
  })
  it('times out even if credential lookup stalls, clearing timers and state', async () => {
    vi.useFakeTimers()
    const f = fixture()
    f.hooks.provider.mockReturnValue(new Promise(() => {}))
    f.chat.send({ text: 'Hi' })
    await vi.advanceTimersByTimeAsync(120_000)
    expect(f.chat.snapshot().phase).toBe('idle')
    expect(f.chat.snapshot().error).toContain('task deadline')
    expect(vi.getTimerCount()).toBe(0)
    f.chat.dispose()
  })
  it('disposes without orphan timers or publishing after shutdown', async () => {
    vi.useFakeTimers()
    const finish = gate()
    const f = fixture(async function* (): AsyncIterable<AIChunk> { yield { type: 'text', text: 'Hi' }; await finish.promise; yield { type: 'done' } })
    f.chat.send({ text: 'hello' }); await Promise.resolve(); await Promise.resolve()
    f.chat.dispose()
    const count = f.hooks.changed.mock.calls.length
    finish.resolve(); await vi.runAllTimersAsync()
    expect(vi.getTimerCount()).toBe(0)
    expect(f.hooks.changed).toHaveBeenCalledTimes(count)
    expect(f.chat.send({ text: 'after dispose' }).ok).toBe(false)
  })
  it('returns detached snapshots instead of mutable internal history', async () => {
    const f = fixture(); f.chat.send({ text: 'hello' })
    await vi.waitFor(() => expect(f.chat.snapshot().phase).toBe('idle'))
    const snapshot = f.chat.snapshot(); (snapshot.messages[0] as ChatMessage).content = 'changed'
    expect(f.chat.snapshot().messages[0].content).toBe('hello')
  })
})
