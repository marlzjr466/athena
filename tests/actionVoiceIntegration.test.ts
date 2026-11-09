// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { ChatController } from '../electron/main/ai/chatController'
import { DesktopTools } from '../electron/main/desktop/desktopTools'
import { SpeechController } from '../electron/main/voice/speechController'
import { ActionNarrator } from '../electron/main/voice/actionNarrator'
import { defaultSettings } from '../shared/settings'
import type { ProjectTools } from '../electron/main/ai/AIProvider'
import type { SpeechStatus } from '../shared/speech'
vi.mock('../electron/main/logger', () => ({ log: vi.fn() }))

describe('acknowledgment → action → result on the same task', () => {
  it.each(['local', 'cloud'] as const)('keeps timer, context and tool identity intact in %s mode', async (aiMode) => {
    const settings = { ...structuredClone(defaultSettings), aiMode, strictOffline: aiMode === 'local', voiceEnabled: true }
    const order: string[] = [], statuses: SpeechStatus[] = []
    let tools: ProjectTools, speech: SpeechController, narrator: ActionNarrator
    let providerRequests = 0
    const open = vi.fn(async () => { order.push('open'); return { ok: true as const, status: 'completed' as const, message: 'Calculator is running.' } })
    const desktop = new DesktopTools({ openApplication: open, focusApplication: vi.fn(), openURL: vi.fn(), showNotification: vi.fn(), dispose: vi.fn() }, () => true, () => false)
    const chat = new ChatController({
      origin: aiMode === 'local' ? 'athena-local' : 'online-chat',
      provider: async () => ({ testConnection: async () => true, async *streamMessage(messages, options) {
        providerRequests++
        expect(messages.filter((message) => message.role === 'user')).toHaveLength(1)
        const result = await tools.execute('open_application', { app: 'calculator' }, options!.signal!)
        expect(JSON.parse(result).ok).toBe(true)
        yield { type: 'text', text: 'Calculator is running.' }
        yield { type: 'done' }
      } }),
      beforeAction: (event) => narrator.beforeAction(event),
      changed: () => speech?.reconcile(), phase: vi.fn(),
    })
    speech = new SpeechController({ generate: async (text) => { order.push(text); return new Uint8Array([1]) } }, {
      settings: () => settings,
      context: () => ({ sessionId: chat.current().id, idle: chat.snapshot().phase === 'idle', lastMessage: chat.current().messages.at(-1) }),
      changed: (status) => {
        statuses.push(status)
        if (status.offered) {
          const identity = { sessionId: status.sessionId!, messageId: status.messageId! }
          void speech.begin(identity, 1).then((audio) => { expect(audio.ok).toBe(true); order.push('playback'); speech.playing({ ...identity, index: 0 }, 1) })
        }
      },
    })
    narrator = new ActionNarrator(() => settings, (request) => speech.announce(request), () => 0)
    chat.command({ action: 'agent-mode', id: chat.current().id, mode: 'workspace-auto' })
    tools = desktop.create(chat, chat.current().id)
    try {
      expect(chat.send({ text: 'Open Calculator.' }).ok).toBe(true)
      const started = chat.current().messages.at(-1)!.execution!.startedAt
      await vi.waitFor(() => expect(chat.snapshot().phase).toBe('idle'))
      const reply = chat.current().messages.at(-1)!
      expect(order).toEqual(aiMode === 'local' ? ["Sure. I'm opening Calculator now.", 'playback', 'open'] : ['open'])
      expect(open).toHaveBeenCalledOnce(); expect(providerRequests).toBe(1)
      expect(chat.current().messages).toHaveLength(2)
      expect(reply.execution).toMatchObject({ startedAt: started, status: 'complete' })
      expect(reply.execution?.activities.map((entry) => entry.tool)).toEqual(aiMode === 'local' ? ['open_application', 'voice_acknowledgment'] : ['open_application'])
      expect(reply.content).toBe('Calculator is running.')
      if (aiMode === 'cloud') {
        expect(statuses).toEqual([])
        expect((await speech.begin({ sessionId: chat.current().id, messageId: reply.id }, 1)).ok).toBe(false)
        return
      }
      // The acknowledgment remains in the existing speech lane until it ends.
      const offered = statuses.find((status) => status.offered)!
      expect(await speech.next({ sessionId: offered.sessionId, messageId: offered.messageId, index: 1 }, 1)).toMatchObject({ done: true })
      expect((await speech.begin({ sessionId: chat.current().id, messageId: reply.id }, 1)).ok).toBe(true)
      expect(order.at(-1)).toBe('Calculator is running.')
    } finally { speech.dispose(); chat.dispose(); desktop.dispose() }
  })
})
