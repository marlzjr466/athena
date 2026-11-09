import type { RememberedScope } from '../../../shared/permissions'
import { z } from 'zod'
import { APPLICATIONS, appIdentifierSchema, applicationActionSchema, notificationActionSchema, urlActionSchema, type AccessibilityActionResult, type AccessibilityInspection, type DesktopActionResult } from '../../../shared/desktopActions'
import { ChatError, type ProjectTools } from '../ai/AIProvider'
import type { ChatController } from '../ai/chatController'
import { log } from '../logger'
import type { DesktopPlatform } from './desktopPlatform'
import type { WorkspaceService } from '../ai/workspaceService'

interface AthenaTool {
  name: string
  description: string
  schema: z.ZodType
  preview(input: unknown): string
  execute(input: unknown, signal: AbortSignal): Promise<DesktopActionResult>
}

export class DesktopTools {
  private tools: AthenaTool[]
  constructor(private platform: DesktopPlatform, private allowed: () => boolean, private quiet: () => boolean, private resolveSearchResult?: (sessionId: string, index: number) => { url: string; title: string } | undefined) {
    this.tools = [
      { name: 'open_application', description: 'Open an installed supported application. Returns whether macOS confirms it running. App IDs: vscode (Visual Studio Code), chrome, safari, finder, terminal, slack, spotify, notes, calculator. Cannot run commands or open files.', schema: applicationActionSchema,
        preview: (input) => `Open ${APPLICATIONS[applicationActionSchema.parse(input).app].name}.`,
        execute: (input, signal) => platform.openApplication(applicationActionSchema.parse(input).app, signal) },
      { name: 'focus_application', description: 'Switch to an already running supported application. Returns whether it became frontmost. Does not launch a stopped application.', schema: applicationActionSchema,
        preview: (input) => `Switch to ${APPLICATIONS[applicationActionSchema.parse(input).app].name}.`,
        execute: (input, signal) => platform.focusApplication(applicationActionSchema.parse(input).app, signal) },
      { name: 'open_url', description: 'Ask the user to approve an HTTP(S) URL, then request opening it in the default browser. This explicit browser action is permitted in Strict Offline Mode, which only blocks external AI services. Does not verify page loading, read the browser, or support file/custom-scheme URLs.', schema: urlActionSchema,
        preview: (input) => `Open this address in your browser?\n${urlActionSchema.parse(input).url}`,
        execute: (input, signal) => platform.openURL(urlActionSchema.parse(input).url, signal) },
      { name: 'show_notification', description: 'Display a short, silent Athena desktop notification when relevant to the user request. Blocked by Athena Do Not Disturb. Result distinguishes confirmed display from submission; macOS may suppress notifications.', schema: notificationActionSchema,
        preview: (input) => { const data = notificationActionSchema.parse(input); return `Show an Athena notification:\n${data.title}\n${data.body}` },
        execute: (input, signal) => { const data = notificationActionSchema.parse(input); return platform.showNotification(data.title, data.body, signal) } },
    ]
  }
  isAllowed(): boolean { return this.allowed() }
  async inspectAccessibleUI(app: unknown, signal: AbortSignal): Promise<AccessibilityInspection> {
    const target = appIdentifierSchema.parse(app)
    if (!this.allowed()) throw new ChatError('Desktop Automation is disabled in Settings → Privacy.')
    if (!this.platform.inspectAccessibility) throw new ChatError('Accessible UI inspection is unavailable on this platform.')
    signal.throwIfAborted()
    return this.platform.inspectAccessibility(target, signal)
  }
  async clickAccessibleElement(app: unknown, label: string, signal: AbortSignal): Promise<AccessibilityActionResult> {
    const target = appIdentifierSchema.parse(app)
    if (!this.allowed()) throw new ChatError('Desktop Automation is disabled in Settings → Privacy.')
    if (!this.platform.clickAccessibleElement) throw new ChatError('Accessible UI actions are unavailable on this platform.')
    signal.throwIfAborted()
    return this.platform.clickAccessibleElement(target, label, signal)
  }
  async setAccessibleText(app: unknown, label: string, text: string, signal: AbortSignal): Promise<AccessibilityActionResult> {
    const target = appIdentifierSchema.parse(app)
    if (!this.allowed()) throw new ChatError('Desktop Automation is disabled in Settings → Privacy.')
    if (!this.platform.setAccessibleText) throw new ChatError('Accessible text entry is unavailable on this platform.')
    signal.throwIfAborted()
    return this.platform.setAccessibleText(target, label, text, signal)
  }
  async pressShortcut(app: unknown, shortcut: string, signal: AbortSignal): Promise<AccessibilityActionResult> {
    const target = appIdentifierSchema.parse(app)
    if (!this.allowed()) throw new ChatError('Desktop Automation is disabled in Settings → Privacy.')
    if (!this.platform.pressShortcut) throw new ChatError('Accessible keyboard shortcuts are unavailable on this platform.')
    signal.throwIfAborted()
    return this.platform.pressShortcut(target, shortcut, signal)
  }
  async openApplicationByVoice(app: unknown, signal: AbortSignal): Promise<DesktopActionResult> {
    if (!this.allowed()) return { ok: false, status: 'denied', message: 'Desktop Automation is off. Enable it in Settings → Privacy before asking me to open apps.' }
    const tool = this.tools.find((entry) => entry.name === 'open_application')
    if (!tool) return { ok: false, status: 'failed', message: 'Application launching is unavailable.' }
    const parsed = applicationActionSchema.safeParse({ app })
    if (!parsed.success) return { ok: false, status: 'failed', message: 'I can only open one of Athena’s supported applications by name.' }
    try { signal.throwIfAborted(); return await tool.execute(parsed.data, signal) }
    catch (error) { return { ok: false, status: signal.aborted ? 'cancelled' : 'failed', message: error instanceof Error ? error.message : 'macOS could not open that application.' } }
  }
  async focusApplicationByVoice(app: unknown, signal: AbortSignal): Promise<DesktopActionResult> {
    if (!this.allowed()) return { ok: false, status: 'denied', message: 'Desktop Automation is off. Enable it in Settings → Privacy before asking me to switch apps.' }
    const tool = this.tools.find((entry) => entry.name === 'focus_application')
    const parsed = applicationActionSchema.safeParse({ app })
    if (!tool || !parsed.success) return { ok: false, status: 'failed', message: 'I can only focus one of Athena’s supported applications by name.' }
    try { signal.throwIfAborted(); return await tool.execute(parsed.data, signal) }
    catch (error) { return { ok: false, status: signal.aborted ? 'cancelled' : 'failed', message: error instanceof Error ? error.message : 'macOS could not switch to that application.' } }
  }
  async openURLByVoice(url: unknown, signal: AbortSignal): Promise<DesktopActionResult> {
    if (!this.allowed()) return { ok: false, status: 'denied', message: 'Desktop Automation is off. Enable it in Settings → Privacy before asking me to open a website.' }
    const tool = this.tools.find((entry) => entry.name === 'open_url')
    const parsed = urlActionSchema.safeParse({ url })
    if (!tool || !parsed.success) return { ok: false, status: 'failed', message: 'I can only open a valid HTTP or HTTPS address.' }
    try { signal.throwIfAborted(); return await tool.execute(parsed.data, signal) }
    catch (error) { return { ok: false, status: signal.aborted ? 'cancelled' : 'failed', message: error instanceof Error ? error.message : 'macOS could not open that website.' } }
  }
  /** Browser Access is checked by NativeActionRegistry; opening a URL does not require desktop control. */
  async openURLWithBrowserAccess(url: unknown, signal: AbortSignal): Promise<DesktopActionResult> {
    const parsed = urlActionSchema.safeParse({ url })
    if (!parsed.success) return { ok: false, status: 'failed', message: 'I can only open a valid HTTP or HTTPS address.' }
    try { signal.throwIfAborted(); return await this.platform.openURL(parsed.data.url, signal) }
    catch (error) { return { ok: false, status: signal.aborted ? 'cancelled' : 'failed', message: error instanceof Error ? error.message : 'macOS could not open that website.' } }
  }
  create(chat: ChatController, sessionId: string, workspace?: { id: string; name: string; service: WorkspaceService }): ProjectTools {
    const receipts = new Map<string, Promise<string>>()
    let calls = 0, busy = false
    const assertAccess = () => { if (chat.current().id !== sessionId) throw new ChatError('The conversation changed. Desktop action stopped.') }
    const denied = (message: string): DesktopActionResult => ({ ok: false, status: 'denied', message })
    const gate = (signal: AbortSignal): DesktopActionResult | undefined => {
      assertAccess()
      if (signal.aborted) return { ok: false, status: 'cancelled', message: 'Desktop action cancelled.' }
      if (!this.allowed()) return denied('Desktop Automation is off or unavailable. Enable it in Settings → Privacy.')
      if (chat.current().config.agentMode === 'read-only') return denied('Read Only mode blocks desktop actions. Choose another permission mode to perform this action.')
    }
    const workspaceTool: AthenaTool | undefined = workspace ? {
      name: 'open_project_in_vscode',
      description: `Open the currently authorized project ${workspace.name} in Visual Studio Code. Requires Desktop Automation and the existing project grant. Returns macOS's confirmed launch result; it does not inspect editor contents.`,
      schema: z.object({}).strict(),
      preview: () => `Open authorized project ${workspace.name} in Visual Studio Code.`,
      execute: async (_input, signal) => {
        if (!this.platform.openWorkspace) return { ok: false, status: 'failed', message: 'Opening project folders in VS Code is unavailable on this platform.' }
        const path = await workspace.service.authorizedRoot(workspace.id)
        return this.platform.openWorkspace(path, 'vscode', signal)
      },
    } : undefined
    const searchResultTool: AthenaTool | undefined = this.resolveSearchResult ? {
      name: 'open_search_result',
      description: 'Open a numbered result from the most recent live web search in this conversation in the default browser. The first result has index 1. Requires explicit browser-opening approval and does not read the page.',
      schema: z.object({ index: z.number().int().min(1).max(10) }).strict(),
      preview: (input) => {
        const result = this.resolveSearchResult?.(sessionId, z.object({ index: z.number().int().min(1).max(10) }).parse(input).index)
        if (!result) throw new ChatError('That search result is unavailable. Search the web again first.')
        return `Open ${result.title} in your browser?\n${result.url}`
      },
      execute: async (input, signal) => {
        const result = this.resolveSearchResult?.(sessionId, z.object({ index: z.number().int().min(1).max(10) }).parse(input).index)
        if (!result) return { ok: false, status: 'failed', message: 'That search result is unavailable. Search the web again first.' }
        return this.platform.openURL(urlActionSchema.parse({ url: result.url }).url, signal)
      },
    } : undefined
    const tools = [...this.tools, ...(searchResultTool ? [searchResultTool] : []), ...(workspaceTool ? [workspaceTool] : [])]
    const perform = async (tool: AthenaTool, input: unknown, signal: AbortSignal): Promise<string> => {
      if (busy) return JSON.stringify(denied('Another desktop action is in progress. Wait for its result.'))
      busy = true
      let activity: string | undefined
      let result: DesktopActionResult = { ok: false, status: 'failed', message: 'Desktop action did not finish.' }
      try {
        activity = chat.activity(tool.name, tool.name.replaceAll('_', ' '))
        if (chat.current().config.agentMode === 'ask' || tool.name === 'open_url' || tool.name === 'open_search_result') {
          const rememberScope: RememberedScope | undefined = tool.name === 'open_application' || tool.name === 'focus_application'
            ? { operation: tool.name, project: 'desktop', resources: [applicationActionSchema.parse(input).app] }
            : tool.name === 'open_url' ? { operation: 'open_url', project: 'desktop', resources: [urlActionSchema.parse(input).url] } : undefined
          const approved = await chat.approve({ title: 'Allow desktop action?', description: tool.preview(input), rememberScope }, signal)
          if (!approved) return JSON.stringify(result = signal.aborted ? { ok: false, status: 'cancelled', message: 'Desktop action cancelled before execution.' } : denied('The desktop action was declined. Do not retry without a new user request.'))
        }
        const blocked = gate(signal)
        if (blocked) return JSON.stringify(result = blocked)
        if (tool.name === 'show_notification' && this.quiet()) return JSON.stringify(result = denied('Do Not Disturb is enabled. No notification was sent.'))
        if (tool.name === 'open_project_in_vscode' && workspace) await workspace.service.authorizedRoot(workspace.id)
        await chat.beforeAction(tool.name, input, signal)
        const changed = gate(signal)
        if (changed) return JSON.stringify(result = changed)
        result = await tool.execute(input, signal)
        return JSON.stringify(result)
      } catch (error) {
        result = { ok: false, status: signal.aborted ? 'cancelled' : 'failed', message: signal.aborted
          ? 'Desktop action stopped. An action already sent to macOS may have taken effect; check before retrying.'
          : error instanceof ChatError ? error.userMessage : 'macOS could not confirm the desktop action. Check that the app is installed or the requested action is available before retrying.' }
        return JSON.stringify(result)
      } finally {
        busy = false
        if (activity) chat.finishActivity(activity, { status: result.status === 'cancelled' ? 'cancelled' : result.ok ? 'complete' : 'error', summary: result.message })
        log('desktop.action_finished', { tool: tool.name, status: result.status })
      }
    }
    return {
      definitions: tools.map(({ name, description, schema }) => {
        const { $schema: _schema, ...parameters } = z.toJSONSchema(schema, { io: 'input' })
        return { name, description, parameters }
      }),
      assertAccess,
      parallelSafe: () => false,
      execute: async (name, input, signal) => {
        const tool = tools.find((entry) => entry.name === name)
        if (!tool) return JSON.stringify(denied('Unknown desktop tool.'))
        const parsed = tool.schema.safeParse(input)
        if (!parsed.success) return JSON.stringify(denied('Invalid desktop tool arguments. Use a supported app ID, valid HTTP(S) URL, or short notification.'))
        const blocked = gate(signal)
        if (blocked) return JSON.stringify(blocked)
        if (name === 'show_notification' && this.quiet()) return JSON.stringify(denied('Do Not Disturb is enabled. No notification was sent.'))
        const key = `${name}:${JSON.stringify(parsed.data)}`
        const previous = receipts.get(key)
        if (previous) return previous
        if (++calls > 8) return JSON.stringify(denied('Desktop action limit reached for this request.'))
        const operation = perform(tool, parsed.data, signal)
        receipts.set(key, operation)
        return operation
      },
    }
  }
  dispose(): void { this.platform.dispose() }
}
