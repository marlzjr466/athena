// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { ApplicationDetectionController } from '../electron/main/applicationDetection/applicationDetectionController'
import { MacOSApplicationDetectionService, type ApplicationDetectionService } from '../electron/main/applicationDetection/macOSApplicationDetectionService'
import { combineTools, createApplicationTools } from '../electron/main/ai/applicationTools'
import type { ProjectTools } from '../electron/main/ai/AIProvider'
import { ChatController } from '../electron/main/ai/chatController'
import { ChatContextService } from '../electron/main/ai/chatContextService'
import { OpenAIProvider } from '../electron/main/ai/OpenAIProvider'
import { AttachmentService } from '../electron/main/ai/attachmentService'
import { WorkspaceService } from '../electron/main/ai/workspaceService'

vi.mock('../electron/main/logger', () => ({ log: vi.fn() }))

const front = { name: 'Visual Studio Code', bundleId: 'com.microsoft.VSCode', pid: 123 }
const browser = { name: 'Safari', bundleId: 'com.apple.Safari', pid: 345 }
function fixture() {
  let allowed = false
  const service: ApplicationDetectionService = {
    snapshot: vi.fn(async () => ({ active: front, running: [front, browser] })),
    getActiveApplication: vi.fn(async () => front),
    getRunningApplications: vi.fn(async () => [front, browser]),
  }
  const controller = new ApplicationDetectionController(service, () => allowed)
  return { controller, service, allow: (value: boolean) => { allowed = value } }
}

describe('macOS application detection', () => {
  it('returns only validated app identities and sorts user-facing apps', async () => {
    const service = new MacOSApplicationDetectionService('darwin', async () => JSON.stringify({ active: front, running: [front, browser] }))
    expect(await service.getActiveApplication()).toEqual(front)
    expect((await service.getRunningApplications()).map((app) => app.name)).toEqual(['Safari', 'Visual Studio Code'])
  })
  it('rejects malformed OS output and unsupported platforms', async () => {
    await expect(new MacOSApplicationDetectionService('darwin', async () => JSON.stringify({ active: { ...front, pid: '123' }, running: [] })).getActiveApplication()).rejects.toThrow()
    await expect(new MacOSApplicationDetectionService('linux', async () => '{}').getRunningApplications()).rejects.toThrow('macOS only')
  })
  it('never queries macOS when opted out and discards data if permission is revoked mid-read', async () => {
    const f = fixture()
    await expect(f.controller.active()).rejects.toThrow('Application Detection is off')
    expect(f.service.getActiveApplication).not.toHaveBeenCalled()
    expect(await f.controller.preview()).toMatchObject({ ok: false })
    f.allow(true)
    let release!: (value: typeof front) => void
    vi.mocked(f.service.getActiveApplication).mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
    const pending = f.controller.active()
    f.allow(false); release(front)
    await expect(pending).rejects.toThrow('Application Detection is off')
  })
  it('validates read-only tool arguments and checks the gate for each call', async () => {
    const f = fixture(), tools = createApplicationTools(f.controller, () => true), signal = new AbortController().signal
    expect(tools.definitions.map((entry) => entry.name)).toEqual(['get_active_app', 'get_running_apps'])
    expect(JSON.parse(await tools.execute('get_active_app', { extra: 'script' }, signal))).toHaveProperty('error')
    expect(JSON.parse(await tools.execute('execute_command', {}, signal))).toHaveProperty('error')
    expect(JSON.parse(await tools.execute('get_active_app', {}, signal))).toHaveProperty('error')
    expect(f.service.getActiveApplication).not.toHaveBeenCalled()
    f.allow(true)
    expect(JSON.parse(await tools.execute('get_active_app', {}, signal))).toEqual({ active: front })
    expect(JSON.parse(await tools.execute('get_running_apps', {}, signal))).toEqual({ running: [front, browser] })
    f.allow(false)
    expect(JSON.parse(await tools.execute('get_running_apps', {}, signal))).toHaveProperty('error')
    expect(f.service.getRunningApplications).toHaveBeenCalledOnce()
  })
  it('combines app reads with existing project tools without weakening project access checks', async () => {
    const f = fixture(); f.allow(true)
    const base: ProjectTools = { definitions: [{ name: 'read_file', description: 'read', parameters: {} }], assertAccess: vi.fn(), execute: vi.fn(async () => '{"content":"source"}') }
    const tools = combineTools(base, createApplicationTools(f.controller, () => true))!
    expect(tools.definitions.map((item) => item.name)).toEqual(['read_file', 'get_active_app', 'get_running_apps'])
    tools.assertAccess()
    expect(await tools.execute('read_file', {}, new AbortController().signal)).toContain('source')
    expect(JSON.parse(await tools.execute('get_active_app', {}, new AbortController().signal))).toEqual({ active: front })
    expect(base.execute).toHaveBeenCalledOnce()
    expect(base.assertAccess).toHaveBeenCalled()
  })
})

describe('application tools in conversation', () => {
  it('lets a tool-capable model request current and running apps without a project', async () => {
    const f = fixture(); f.allow(true)
    const sse = (...events: unknown[]) => new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
    const call = (name: string, id: string) => ({ type: 'function_call', name, arguments: '{}', call_id: id, id: `fc_${id}`, status: 'completed' })
    const completed = (output: unknown[]) => ({ type: 'response.completed', response: { output } })
    let round = 0
    const request = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(init!.body as string)
      if (++round === 1) {
        expect(body.tools.map((tool: { name: string }) => tool.name)).toEqual(['get_active_app', 'get_running_apps'])
        expect(body.instructions).not.toContain('undefined')
        return sse(completed([call('get_active_app', 'active'), call('get_running_apps', 'running')]))
      }
      const results = body.input.filter((item: { type: string }) => item.type === 'function_call_output')
      expect(JSON.parse(results.find((item: { call_id: string }) => item.call_id === 'active').output)).toEqual({ active: front })
      expect(JSON.parse(results.find((item: { call_id: string }) => item.call_id === 'running').output)).toEqual({ running: [front, browser] })
      return sse({ type: 'response.output_text.delta', delta: 'Visual Studio Code is active; Safari is also running.' }, completed([]))
    })
    let context!: ChatContextService
    const chat = new ChatController({ provider: async () => new OpenAIProvider('sk-fake', 'gpt-4.1', request), prepare: (...args) => context.prepare(...args), changed: vi.fn(), phase: vi.fn() })
    context = new ChatContextService(chat, new AttachmentService('/tmp/athena-app-detection-test', () => false, () => { throw new Error('No attachments') }), new WorkspaceService(() => false), { files: async () => [], folder: async () => undefined }, () => false, undefined, f.controller)
    chat.command({ action: 'configure', id: chat.current().id, config: { provider: 'OpenAI', model: 'gpt-4.1', effort: 'auto' } })
    chat.send({ text: 'What app am I using, and what else is running?' })
    await vi.waitFor(() => expect(chat.snapshot().phase).toBe('idle'))
    expect(chat.snapshot().messages.at(-1)).toMatchObject({ role: 'assistant', status: 'complete', content: 'Visual Studio Code is active; Safari is also running.' })
    expect(f.service.getActiveApplication).toHaveBeenCalledOnce()
    expect(f.service.getRunningApplications).toHaveBeenCalledOnce()
    chat.dispose()
  })
  it('does not advertise application tools while the permission is off', async () => {
    const f = fixture()
    const chat = new ChatController({ provider: async () => ({ testConnection: async () => true, async *streamMessage() {} }), changed: vi.fn(), phase: vi.fn() })
    chat.command({ action: 'configure', id: chat.current().id, config: { provider: 'OpenAI', model: 'gpt-4.1', effort: 'auto' } })
    const context = new ChatContextService(chat, new AttachmentService('/tmp/athena-app-detection-test', () => false, () => { throw new Error('No attachments') }), new WorkspaceService(() => false), { files: async () => [], folder: async () => undefined }, () => false, undefined, f.controller)
    expect((await context.prepare(chat.current(), [], new AbortController().signal)).projectTools).toBeUndefined()
    expect(f.service.getActiveApplication).not.toHaveBeenCalled()
    chat.dispose()
  })
})
