// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { DesktopTools } from '../electron/main/desktop/desktopTools'
import type { DesktopPlatform } from '../electron/main/desktop/desktopPlatform'
import type { ChatController } from '../electron/main/ai/chatController'
import type { WorkspaceService } from '../electron/main/ai/workspaceService'
import type { AgentMode } from '../shared/agent'
import { webURLSchema } from '../shared/desktopActions'
vi.mock('../electron/main/logger', () => ({ log: vi.fn() }))

function fixture(mode: AgentMode = 'advanced') {
  let allowed = true, quiet = false, selected = 'session'
  const result = { ok: true as const, status: 'completed' as const, message: 'Confirmed by macOS.' }
  const platform: DesktopPlatform = { openApplication: vi.fn(async () => result), focusApplication: vi.fn(async () => result), openURL: vi.fn(async () => ({ ...result, status: 'submitted' as const })), showNotification: vi.fn(async () => result), dispose: vi.fn() }
  const chat = { current: () => ({ id: selected, config: { agentMode: mode } }), activity: vi.fn(() => 'activity'), finishActivity: vi.fn(), approve: vi.fn(async () => true), beforeAction: vi.fn(async () => {}) }
  const registry = new DesktopTools(platform, () => allowed, () => quiet)
  const tools = registry.create(chat as unknown as ChatController, 'session')
  const signal = new AbortController()
  const call = async (tool: string, args: unknown) => JSON.parse(await tools.execute(tool, args, signal.signal))
  return { platform, chat, registry, tools, signal, call, allow: (value: boolean) => { allowed = value }, quiet: (value: boolean) => { quiet = value }, select: (value: string) => { selected = value } }
}

describe('desktop action execution boundary', () => {
  it('approves before speaking, waits for speech, then executes once', async () => {
    const f = fixture('ask'), order: string[] = []
    f.chat.approve.mockImplementation(async () => { order.push('approval'); return true })
    let release!: () => void
    f.chat.beforeAction.mockImplementation(() => new Promise<void>((resolve) => { order.push('speech'); release = resolve }))
    const pending = f.call('open_application', { app: 'vscode' })
    await vi.waitFor(() => expect(order).toEqual(['approval', 'speech']))
    expect(f.platform.openApplication).not.toHaveBeenCalled()
    release(); expect((await pending).ok).toBe(true)
    await f.call('open_application', { app: 'vscode' })
    expect(f.chat.beforeAction).toHaveBeenCalledOnce(); expect(f.platform.openApplication).toHaveBeenCalledOnce()
  })
  it('does not acknowledge a declined action and rechecks permissions after speech', async () => {
    const f = fixture('ask'); f.chat.approve.mockResolvedValueOnce(false)
    await f.call('open_application', { app: 'vscode' })
    expect(f.chat.beforeAction).not.toHaveBeenCalled()
    f.chat.beforeAction.mockImplementation(async () => { f.allow(false) })
    expect((await f.call('open_application', { app: 'chrome' })).status).toBe('denied')
    expect(f.platform.openApplication).not.toHaveBeenCalled()
  })
  it('cancels during the acknowledgment without executing the action', async () => {
    const f = fixture()
    f.chat.beforeAction.mockImplementation(async () => { f.signal.abort() })
    expect((await f.call('open_application', { app: 'vscode' })).status).toBe('cancelled')
    expect(f.platform.openApplication).not.toHaveBeenCalled()
  })
  it('exposes exactly four validated desktop tools and no shell endpoint', () => {
    const f = fixture()
    expect(f.tools.definitions.map((tool) => tool.name)).toEqual(['open_application', 'focus_application', 'open_url', 'show_notification'])
    expect(f.tools.definitions.every((tool) => tool.parameters.additionalProperties === false)).toBe(true)
  })
  it('blocks disabled permission and Read Only before any OS action or approval', async () => {
    const f = fixture('read-only')
    expect(await f.call('open_application', { app: 'vscode' })).toMatchObject({ ok: false, status: 'denied' })
    const disabled = fixture('ask'); disabled.allow(false)
    expect(await disabled.call('open_application', { app: 'vscode' })).toMatchObject({ ok: false, status: 'denied' })
    expect(f.platform.openApplication).not.toHaveBeenCalled()
    expect(disabled.platform.openApplication).not.toHaveBeenCalled()
    expect(disabled.chat.approve).not.toHaveBeenCalled()
  })
  it('validates app IDs and rejects unknown tools, extra flags, paths, and script injection', async () => {
    const f = fixture()
    for (const args of [{ app: '/Applications/App.app' }, { app: 'vscode; touch /tmp/bad' }, { app: 'chrome', args: ['--remote-debugging-port=9222'] }, null]) expect((await f.call('open_application', args)).ok).toBe(false)
    expect((await f.call('execute_shell', { command: 'ls' })).ok).toBe(false)
    expect(f.platform.openApplication).not.toHaveBeenCalled()
  })
  it('asks in Ask Before Changes, rechecks permission after approval, and reports actual results', async () => {
    const f = fixture('ask')
    f.chat.approve.mockImplementationOnce(async () => { f.allow(false); return true })
    expect((await f.call('open_application', { app: 'vscode' })).ok).toBe(false)
    expect(f.platform.openApplication).not.toHaveBeenCalled()
    expect(f.chat.approve).toHaveBeenCalledWith(expect.objectContaining({ description: 'Open Visual Studio Code.' }), f.signal.signal)
    f.allow(true)
    expect(await f.call('focus_application', { app: 'chrome' })).toMatchObject({ ok: true, status: 'completed' })
    expect(f.platform.focusApplication).toHaveBeenCalledWith('chrome', f.signal.signal)
  })
  it('never dispatches declined or cancelled operations and does not repeat successful actions', async () => {
    const f = fixture('ask'); f.chat.approve.mockResolvedValueOnce(false)
    expect((await f.call('open_application', { app: 'slack' })).status).toBe('denied')
    await f.call('open_application', { app: 'slack' })
    expect(f.chat.approve).toHaveBeenCalledOnce()
    await f.call('open_application', { app: 'vscode' }); await f.call('open_application', { app: 'vscode' })
    expect(f.platform.openApplication).toHaveBeenCalledOnce()
    f.signal.abort()
    expect((await f.call('open_application', { app: 'chrome' })).status).toBe('cancelled')
    expect(f.platform.openApplication).toHaveBeenCalledOnce()
  })
  it('validates web URLs and always previews the exact normalized destination', async () => {
    const f = fixture()
    for (const url of ['file:///tmp/app', 'javascript:alert(1)', 'data:text/html,bad', 'https://user:secret@example.com', 'https://example.com\n', 'https://example.com\\@evil.test']) expect(webURLSchema.safeParse(url).success).toBe(false)
    expect(await f.call('open_url', { url: 'https://example.com' })).toMatchObject({ status: 'submitted' })
    expect(f.chat.approve).toHaveBeenCalledWith(expect.objectContaining({ description: expect.stringContaining('https://example.com/') }), f.signal.signal)
    expect(f.platform.openURL).toHaveBeenCalledWith('https://example.com/', f.signal.signal)
  })
  it('opens a saved live-search result only after browser approval and never invents a missing reference', async () => {
    const f = fixture()
    const resolver = vi.fn((_sessionId: string, index: number) => index === 1 ? { title: 'React Documentation', url: 'https://react.dev/learn' } : undefined)
    const registry = new DesktopTools(f.platform, () => true, () => false, resolver)
    const tools = registry.create(f.chat as unknown as ChatController, 'session')
    expect(tools.definitions.map((tool) => tool.name)).toContain('open_search_result')
    const open = async (index: number) => JSON.parse(await tools.execute('open_search_result', { index }, f.signal.signal))
    expect(await open(1)).toMatchObject({ ok: true, status: 'submitted' })
    expect(f.chat.approve).toHaveBeenCalledWith(expect.objectContaining({ description: expect.stringContaining('https://react.dev/learn') }), f.signal.signal)
    expect(f.platform.openURL).toHaveBeenCalledWith('https://react.dev/learn', f.signal.signal)
    expect((await open(2)).ok).toBe(false)
    expect(f.platform.openURL).toHaveBeenCalledOnce()
  })
  it('honors Do Not Disturb and avoids issuing concurrent duplicate notifications', async () => {
    const f = fixture(); f.quiet(true)
    const args = { title: 'Build done', body: 'Completed successfully.' }
    expect((await f.call('show_notification', args)).status).toBe('denied')
    expect(f.platform.showNotification).not.toHaveBeenCalled()
    f.quiet(false)
    await Promise.all([f.call('show_notification', args), f.call('show_notification', args)])
    expect(f.platform.showNotification).toHaveBeenCalledOnce()
  })
  it('sanitizes platform failures, records activity, and stops when the session changes', async () => {
    const f = fixture(); vi.mocked(f.platform.openApplication).mockRejectedValue(new Error('private os output'))
    const result = await f.call('open_application', { app: 'notes' })
    expect(result.ok).toBe(false); expect(result.message).not.toContain('private os output')
    expect(f.chat.finishActivity).toHaveBeenCalledWith('activity', expect.objectContaining({ status: 'error' }))
    f.select('different')
    await expect(f.call('focus_application', { app: 'notes' })).rejects.toThrow('conversation changed')
  })
  it('opens only the active authorized project in VS Code through the desktop permission gate', async () => {
    const f = fixture('ask')
    const path = '/Users/test/Projects/React app'
    const workspace = { authorizedRoot: vi.fn(async () => path) } as unknown as WorkspaceService
    f.platform.openWorkspace = vi.fn(async () => ({ ok: true as const, status: 'completed' as const, message: 'VS Code is running.' }))
    const tools = f.registry.create(f.chat as unknown as ChatController, 'session', { id: 'project', name: 'React app', service: workspace })
    expect(tools.definitions.map((tool) => tool.name)).toContain('open_project_in_vscode')
    const denied = JSON.parse(await tools.execute('open_project_in_vscode', { path: '/tmp/elsewhere' }, f.signal.signal))
    expect(denied.status).toBe('denied')
    const approved = JSON.parse(await tools.execute('open_project_in_vscode', {}, f.signal.signal))
    expect(approved.ok).toBe(true)
    expect(f.chat.approve).toHaveBeenCalledWith(expect.objectContaining({ description: 'Open authorized project React app in Visual Studio Code.' }), f.signal.signal)
    expect(workspace.authorizedRoot).toHaveBeenCalledWith('project')
    expect(f.platform.openWorkspace).toHaveBeenCalledWith(path, 'vscode', f.signal.signal)
  })
})
