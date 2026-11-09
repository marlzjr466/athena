// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { ChatController } from '../electron/main/ai/chatController'
import { ChatContextService } from '../electron/main/ai/chatContextService'
import { OpenAIProvider } from '../electron/main/ai/OpenAIProvider'
import { AttachmentService } from '../electron/main/ai/attachmentService'
import { WorkspaceService } from '../electron/main/ai/workspaceService'
import { DesktopTools } from '../electron/main/desktop/desktopTools'
import type { DesktopPlatform } from '../electron/main/desktop/desktopPlatform'
vi.mock('../electron/main/logger', () => ({ log: vi.fn() }))

describe('desktop actions through the existing conversation', () => {
  it('routes model requests through real chat approvals and returns execution receipts to the same model', async () => {
    const platform: DesktopPlatform = {
      openApplication: vi.fn(async () => ({ ok: true, status: 'completed' as const, message: 'Visual Studio Code is running.' })),
      focusApplication: vi.fn(), openURL: vi.fn(), showNotification: vi.fn(), dispose: vi.fn(),
    }
    const actions = new DesktopTools(platform, () => true, () => false)
    const sse = (...events: unknown[]) => new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
    const call = (name: string, args: unknown, id: string) => ({ type: 'function_call', name, arguments: JSON.stringify(args), call_id: id, id: `fc_${id}`, status: 'completed' })
    const completed = (output: unknown[]) => ({ type: 'response.completed', response: { output } })
    let round = 0, context!: ChatContextService
    const request = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(init!.body as string)
      expect(body.model).toBe('gpt-4.1')
      expect(body.tools.map((tool: { name: string }) => tool.name)).toEqual(['open_application', 'focus_application', 'open_url', 'show_notification'])
      if (++round === 1) return sse(completed([call('open_application', { app: 'vscode' }, 'open')]))
      expect(JSON.parse(body.input.find((item: { call_id: string; type: string }) => item.type === 'function_call_output' && item.call_id === 'open').output)).toMatchObject({ ok: true, message: 'Visual Studio Code is running.' })
      if (round === 2) return sse(completed([call('open_url', { url: 'https://example.com' }, 'url')]))
      expect(JSON.parse(body.input.find((item: { call_id: string; type: string }) => item.type === 'function_call_output' && item.call_id === 'url').output)).toMatchObject({ ok: false, status: 'denied' })
      return sse({ type: 'response.output_text.delta', delta: 'VS Code is running. The web link was declined.' }, completed([]))
    })
    const chat = new ChatController({ provider: async () => new OpenAIProvider('sk-fake', 'gpt-4.1', request), prepare: (...args) => context.prepare(...args), changed: vi.fn(), phase: vi.fn() })
    context = new ChatContextService(chat, new AttachmentService('/tmp/athena-desktop-actions-test', () => false, () => { throw new Error() }), new WorkspaceService(() => false), { files: async () => [], folder: async () => undefined }, () => false, undefined, undefined, actions)
    chat.command({ action: 'configure', id: chat.current().id, config: { provider: 'OpenAI', model: 'gpt-4.1', effort: 'auto', agentMode: 'ask' } })
    const approval = () => chat.snapshot().messages.at(-1)?.execution?.approval
    try {
      chat.send({ text: 'Open VS Code and example.com.' })
      await vi.waitFor(() => expect(approval()?.description).toBe('Open Visual Studio Code.'))
      expect(platform.openApplication).not.toHaveBeenCalled()
      chat.command({ action: 'agent-approval', id: chat.current().id, approvalId: approval()!.id, allow: true })
      await vi.waitFor(() => expect(approval()?.description).toContain('https://example.com/'))
      chat.command({ action: 'agent-approval', id: chat.current().id, approvalId: approval()!.id, allow: false })
      await vi.waitFor(() => expect(chat.snapshot().phase).toBe('idle'))
      expect(chat.snapshot().messages.at(-1)).toMatchObject({ status: 'complete', content: 'VS Code is running. The web link was declined.' })
      expect(platform.openApplication).toHaveBeenCalledOnce()
      expect(platform.openURL).not.toHaveBeenCalled()
      expect(chat.snapshot().messages.at(-1)?.execution?.activities.map((entry) => entry.status)).toEqual(['complete', 'error'])
    } finally { chat.dispose(); actions.dispose() }
  })
})
