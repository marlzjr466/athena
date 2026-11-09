// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { ChatController } from '../electron/main/ai/chatController'
import { ChatContextService } from '../electron/main/ai/chatContextService'
import { OpenAIProvider } from '../electron/main/ai/OpenAIProvider'
import { AttachmentService } from '../electron/main/ai/attachmentService'
import { WorkspaceService } from '../electron/main/ai/workspaceService'
import { DesktopTools } from '../electron/main/desktop/desktopTools'
import type { DesktopPlatform } from '../electron/main/desktop/desktopPlatform'
import { VoiceController } from '../electron/main/voice/voiceController'
import { SpeechController } from '../electron/main/voice/speechController'
import { defaultSettings } from '../shared/settings'

vi.mock('../electron/main/logger', () => ({ log: vi.fn() }))
const sse = (...events: unknown[]) => new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
const completed = (output: unknown[]) => ({ type: 'response.completed', response: { output } })

describe('online text, dictation and tool lifecycle without companion speech', () => {
  it.each(['text', 'voice'] as const)('preserves the selected model and real tool receipt without speaking a %s command result', async (input) => {
    await exercise(input, 'success')
  })
  it.each(['declined', 'revoked', 'failed', 'cancelled'] as const)('preserves %s action status in the spoken-command pipeline', async (outcome) => {
    await exercise('voice', outcome)
  })
})

async function exercise(input: 'text' | 'voice', outcome: 'success' | 'declined' | 'revoked' | 'failed' | 'cancelled') {
  let allowed = true, context!: ChatContextService, voice: VoiceController | undefined, speech: SpeechController | undefined
  const phases: string[] = [], voicePhases: string[] = [], speechPhases: string[] = []
  const platform: DesktopPlatform = {
    openApplication: vi.fn(async () => outcome === 'failed'
      ? { ok: false, status: 'failed' as const, message: 'Chrome is not installed.' }
      : { ok: true, status: 'completed' as const, message: 'Google Chrome is running.' }),
    focusApplication: vi.fn(), openURL: vi.fn(), showNotification: vi.fn(), dispose: vi.fn(),
  }
  const actions = new DesktopTools(platform, () => allowed, () => false)
  let requests = 0, observedReceipt = ''
  const request = vi.fn<typeof fetch>(async (_url, init) => {
    const body = JSON.parse(init!.body as string)
    expect(body.model).toBe('gpt-5.2'); expect(body.reasoning.effort).toBe('medium')
    if (++requests === 1) {
      expect(body.tools.some((tool: { name: string }) => tool.name === 'open_application')).toBe(true)
      return sse(completed([{ type: 'function_call', name: 'open_application', arguments: JSON.stringify({ app: 'chrome' }), call_id: 'open-chrome', id: 'fc_open', status: 'completed' }]))
    }
    const receipt = JSON.parse(body.input.find((item: { type: string; call_id: string }) => item.type === 'function_call_output' && item.call_id === 'open-chrome').output)
    observedReceipt = receipt.message
    expect(receipt.ok).toBe(outcome === 'success')
    return sse({ type: 'response.output_text.delta', delta: receipt.message }, completed([]))
  })
  const chat = new ChatController({ provider: async (config) => new OpenAIProvider('sk-fixture', config.model!, request), prepare: (...args) => context.prepare(...args), changed: () => { voice?.reconcile(); speech?.reconcile() }, phase: (phase) => phases.push(phase) })
  context = new ChatContextService(chat, new AttachmentService('/tmp/athena-phase11-unused', () => false, () => { throw new Error('unused') }), new WorkspaceService(() => false), { files: async () => [], folder: async () => undefined }, () => false, undefined, undefined, actions)
  chat.command({ action: 'configure', id: chat.current().id, config: { provider: 'OpenAI', model: 'gpt-5.2', effort: 'medium', agentMode: 'ask' } })
  const transcribe = vi.fn(async () => 'Open Chrome.')
  voice = new VoiceController({ transcribe }, {
    context: () => ({ sessionId: chat.current().id, idle: chat.snapshot().phase === 'idle', fingerprint: JSON.stringify(chat.current().config) }),
    allowed: () => true, authorize: async () => {}, changed: (state) => { voicePhases.push(state.phase); speech?.reconcile() },
  })
  const generate = vi.fn(async () => new Uint8Array([1, 2, 3]))
  speech = new SpeechController({ generate }, {
    context: () => ({ sessionId: chat.current().id, idle: chat.snapshot().phase === 'idle', inputActive: voice?.snapshot().phase !== 'idle', lastMessage: chat.current().messages.at(-1) }),
    settings: () => ({ ...defaultSettings, voiceEnabled: true }), changed: (state) => speechPhases.push(state.phase),
  })
  try {
    let text = 'Open Chrome.'
    const sessionId = chat.current().id
    if (input === 'voice') {
      const identity = { id: randomUUID(), sessionId }
      expect((await voice.begin(identity)).ok).toBe(true)
      expect(voice.recording(identity).ok).toBe(true)
      const clip = { ...identity, mimeType: 'audio/webm' as const, bytes: new Uint8Array([1, 2]) }
      const result = await voice.transcribe(clip)
      expect(result.ok).toBe(true); text = result.transcript!
      expect(clip.bytes.every((byte) => byte === 0)).toBe(true)
      expect(voicePhases).toEqual(['preparing', 'listening', 'transcribing', 'idle'])
    }
    expect(chat.send({ text, sessionId, requestId: randomUUID() }).ok).toBe(true)
    const approval = () => chat.snapshot().messages.at(-1)?.execution?.approval
    await vi.waitFor(() => expect(approval()).toBeDefined())
    const pending = chat.current().messages.at(-1)!, started = pending.execution!.startedAt
    expect(platform.openApplication).not.toHaveBeenCalled()
    expect((await speech.begin({ sessionId, messageId: pending.id })).ok).toBe(false)
    if (outcome === 'cancelled') chat.stop()
    else {
      if (outcome === 'revoked') allowed = false
      chat.command({ action: 'agent-approval', id: sessionId, approvalId: approval()!.id, allow: outcome !== 'declined' })
    }
    await vi.waitFor(() => expect(chat.snapshot().phase).toBe('idle'))
    const reply = chat.current().messages.at(-1)!
    expect(reply.execution?.startedAt).toBe(started)
    expect(reply.execution?.finishedAt).toBeGreaterThanOrEqual(started)
    expect(chat.current().messages[0].content).toBe(text)
    if (outcome === 'cancelled') {
      expect(reply.status).toBe('stopped')
      expect((await speech.begin({ sessionId, messageId: reply.id })).ok).toBe(false)
      expect(generate).not.toHaveBeenCalled()
    } else {
      expect(reply.status).toBe('complete'); expect(reply.content).toBe(observedReceipt)
      expect(reply.ownership?.origin).toBe('online-chat')
      expect((await speech.begin({ sessionId, messageId: reply.id })).ok).toBe(false)
      expect(generate).not.toHaveBeenCalled()
      expect(speech.playing({ sessionId, messageId: reply.id, index: 0 }).ok).toBe(false)
      expect(speechPhases).toEqual([])
    }
    expect(platform.openApplication).toHaveBeenCalledTimes(['success', 'failed'].includes(outcome) ? 1 : 0)
    expect(phases).toContain('thinking'); expect(phases.at(-1)).toBe('idle')
  } finally { voice.dispose(); speech.dispose(); chat.dispose(); actions.dispose() }
}
