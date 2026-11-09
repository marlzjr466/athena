// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { ChatController } from '../electron/main/ai/chatController'
import { ChatContextService } from '../electron/main/ai/chatContextService'
import { OpenAIProvider } from '../electron/main/ai/OpenAIProvider'
import { AttachmentService } from '../electron/main/ai/attachmentService'
import { WorkspaceService } from '../electron/main/ai/workspaceService'
import { newConversation } from '../electron/main/ai/conversationRepository'
import { ScreenCaptureTools } from '../electron/main/screenCapture/screenCaptureTools'
import type { ScreenCapturePlatform } from '../electron/main/screenCapture/screenCapturePlatform'

vi.mock('../electron/main/logger', () => ({ log: vi.fn() }))
const sse = (...events: unknown[]) => new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
const completed = (output: unknown[]) => ({ type: 'response.completed', response: { output } })
const imageData = 'data:image/jpeg;base64,cHJpdmF0ZS10ZXN0LWltYWdl'
const call = { type: 'function_call', name: 'read_screen', arguments: '{}', call_id: 'screen', id: 'fc_screen', status: 'completed' }
function setup() {
  let enabled = true, allowed = true, context!: ChatContextService
  const display = { id: '1', name: 'Display 1', width: 1920, height: 1080 }
  const platform: ScreenCapturePlatform = { displays: () => [display], capture: vi.fn(async () => [{ display, dataURL: imageData, width: 1600, height: 900, capturedAt: 1000 }]), dispose: vi.fn() }
  const screens = new ScreenCaptureTools(platform, () => enabled, () => allowed)
  const request = vi.fn<typeof fetch>(), saved: string[] = [], session = newConversation()
  const chat = new ChatController({ provider: async () => new OpenAIProvider('sk-fake', 'gpt-4.1', request), prepare: (...args) => context.prepare(...args), changed: vi.fn(), phase: vi.fn() }, {
    load: () => ({ version: 1, activeId: session.id, sessions: [session] }),
    save: (data) => { saved.push(JSON.stringify(data)) }, archive: vi.fn(),
  })
  context = new ChatContextService(chat, new AttachmentService('/tmp/athena-screen-test', () => false, () => { throw new Error('unused') }), new WorkspaceService(() => false), { files: async () => [], folder: async () => undefined }, () => false, undefined, undefined, undefined, screens)
  chat.command({ action: 'configure', id: chat.current().id, config: { provider: 'OpenAI', model: 'gpt-4.1', effort: 'auto', agentMode: 'read-only' } })
  const approval = () => chat.snapshot().messages.at(-1)?.execution?.approval
  const respond = (allow: boolean) => chat.command({ action: 'agent-approval', id: chat.current().id, approvalId: approval()!.id, allow })
  return { chat, context, platform, request, saved, screens, approval, respond, enable: (value: boolean) => { enabled = value }, allow: (value: boolean) => { allowed = value } }
}

describe('screen images through the existing OpenAI conversation', () => {
  it('requires approval, sends real image parts, preserves the timer through recovery, and never saves images or derived checkpoints', async () => {
    const f = setup()
    let round = 0, startedAt: number | undefined
    f.request.mockImplementation(async (_url, init) => {
      const body = JSON.parse(init!.body as string)
      expect(body.model).toBe('gpt-4.1'); expect(body.store).toBe(false)
      const execution = f.chat.snapshot().messages.at(-1)!.execution!
      if (++round === 1) { startedAt = execution.startedAt; return sse(completed([call])) }
      expect(execution.startedAt).toBe(startedAt)
      const imageResult = body.input.find((item: { type: string; call_id?: string }) => item.type === 'function_call_output' && item.call_id === 'screen')
      expect(imageResult.output).toContainEqual({ type: 'input_image', detail: 'high', image_url: imageData })
      if (round === 2) return sse({ type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' }, output: [] } })
      return sse({ type: 'response.output_text.delta', delta: 'The approved snapshot shows a test desktop.' }, completed([]))
    })
    try {
      f.chat.send({ text: 'What is on my screen?' })
      await vi.waitFor(() => expect(f.approval()).toBeDefined())
      expect(f.platform.capture).not.toHaveBeenCalled()
      expect(f.approval()!.description).toContain('ALL 1 connected display')
      f.respond(true)
      await vi.waitFor(() => expect(f.chat.snapshot().phase).toBe('idle'))
      expect(f.chat.snapshot().messages.at(-1)).toMatchObject({ status: 'complete', execution: { startedAt, recovery: { attempts: 1, continuing: false } } })
      expect(f.platform.capture).toHaveBeenCalledTimes(1)
      expect(f.chat.current().contextCheckpoint).toBeUndefined()
      f.chat.dispose()
      expect(f.saved.length).toBeGreaterThan(0)
      expect(f.saved.join('')).not.toContain(imageData)
      expect(f.saved.join('')).not.toContain('function_call_output')
    } finally { f.chat.dispose(); f.screens.dispose() }
  })
  it('returns declined capture to the model without any image', async () => {
    const f = setup()
    f.request.mockResolvedValueOnce(sse(completed([call]))).mockImplementationOnce(async (_url, init) => {
      const body = JSON.parse(init!.body as string)
      const result = body.input.find((item: { type: string }) => item.type === 'function_call_output')
      expect(JSON.parse(result.output)).toMatchObject({ ok: false, message: expect.stringContaining('declined') })
      expect(JSON.stringify(body)).not.toContain('data:image')
      return sse({ type: 'response.output_text.delta', delta: 'You declined screen capture.' }, completed([]))
    })
    try {
      f.chat.send({ text: 'Read my screen.' })
      await vi.waitFor(() => expect(f.approval()).toBeDefined()); f.respond(false)
      await vi.waitFor(() => expect(f.chat.snapshot().phase).toBe('idle'))
      expect(f.platform.capture).not.toHaveBeenCalled()
      expect(f.chat.snapshot().messages.at(-1)?.status).toBe('complete')
    } finally { f.chat.dispose(); f.screens.dispose() }
  })
  it('omits screen tools when disabled or model vision is unverified', async () => {
    const f = setup()
    try {
      f.enable(false)
      expect((await f.context.prepare(f.chat.current(), [], new AbortController().signal)).projectTools).toBeUndefined()
      f.enable(true)
      f.chat.command({ action: 'configure-model', id: f.chat.current().id, model: 'unknown-model' })
      const prepared = await f.context.prepare(f.chat.current(), [], new AbortController().signal)
      expect(prepared.projectTools).toBeUndefined(); expect(prepared.notice).toContain('vision')
      expect(f.platform.capture).not.toHaveBeenCalled()
    } finally { f.chat.dispose(); f.screens.dispose() }
  })
  it('stops pending approval immediately on task cancellation', async () => {
    const f = setup(); f.request.mockResolvedValueOnce(sse(completed([call])))
    try {
      f.chat.send({ text: 'Read my screen.' })
      await vi.waitFor(() => expect(f.approval()).toBeDefined())
      f.chat.stop()
      await vi.waitFor(() => expect(f.chat.snapshot().phase).toBe('idle'))
      expect(f.approval()).toBeUndefined(); expect(f.platform.capture).not.toHaveBeenCalled()
      expect(f.request).toHaveBeenCalledTimes(1)
    } finally { f.chat.dispose(); f.screens.dispose() }
  })
})
