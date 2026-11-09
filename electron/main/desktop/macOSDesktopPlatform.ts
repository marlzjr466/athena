import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Notification, systemPreferences } from 'electron'
import { z } from 'zod'
import { APPLICATIONS, appIdentifierSchema, webURLSchema, notificationActionSchema, type AccessibilityActionResult, type AccessibilityInspection, type AppIdentifier, type DesktopActionResult } from '../../../shared/desktopActions'
import type { DesktopPlatform } from './desktopPlatform'

const executeFile = promisify(execFile)
type CommandRunner = (file: string, args: string[], options: { timeout: number; maxBuffer: number; signal: AbortSignal; encoding?: 'utf8' }) => Promise<{ stdout: string }>
// Arguments are data passed through argv to fixed AppKit code, never source code.
const APP_ACTION = `ObjC.import('AppKit');
function run(argv) {
  var bundle = argv[0], focus = argv[1] === 'focus';
  for (var attempt = 0; attempt < 30; attempt++) {
    var apps = $.NSRunningApplication.runningApplicationsWithBundleIdentifier(bundle);
    if (apps.count > 0) {
      if (!focus) return JSON.stringify({ running: true, focused: false });
      if (attempt === 0) apps.objectAtIndex(0).activateWithOptions(3);
      var front = $.NSWorkspace.sharedWorkspace.frontmostApplication;
      if (front && ObjC.unwrap(front.bundleIdentifier) === bundle) return JSON.stringify({ running: true, focused: true });
    } else if (focus) return JSON.stringify({ running: false, focused: false });
    $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.1));
  }
  return JSON.stringify({ running: $.NSRunningApplication.runningApplicationsWithBundleIdentifier(bundle).count > 0, focused: false });
}`
const appResult = z.object({ running: z.boolean(), focused: z.boolean() }).strict()
const accessibilityResult = z.union([
  z.object({ app: z.string(), window: z.string(), elements: z.array(z.object({ label: z.string(), role: z.string(), enabled: z.boolean(), value: z.string().optional() }).strict()).max(120), verified: z.boolean(), changed: z.boolean(), message: z.string() }).strict(),
  z.object({ error: z.string() }).strict(),
])
const ACCESSIBILITY_SCRIPT = `function run(argv) {
  var bundle = argv[0], action = argv[1], selector = argv[2], text = argv[3];
  var events = Application('System Events');
  var processes = events.processes.whose({ bundleIdentifier: bundle })();
  if (!processes.length) return JSON.stringify({ error: 'The selected application is not running.' });
  var process = processes[0], windows = process.windows();
  if (!windows.length) return JSON.stringify({ error: 'The selected application has no accessible window.' });
  function read(element, property) { try { var value = element[property](); if (value === null || value === undefined) return ''; return typeof value === 'string' ? value : ObjC.unwrap(value); } catch (_) { return ''; } }
  function list() {
    var output = [];
    windows = process.windows();
    for (var w = 0; w < windows.length; w++) {
      var descendants = []; try { descendants = windows[w].entireContents(); } catch (_) {}
      for (var i = 0; i < descendants.length && output.length < 120; i++) {
        var element = descendants[i], role = String(read(element, 'role')), name = String(read(element, 'name'));
        var label = String(read(element, 'description')) || name || String(read(element, 'title'));
        if (!label) continue;
        var value = role.indexOf('Secure') >= 0 ? '' : String(read(element, 'value'));
        output.push({ label: label.slice(0, 160), role: role.slice(0, 80), enabled: read(element, 'enabled') !== false, ...(value && role.indexOf('Secure') < 0 ? { value: value.slice(0, 500) } : {}) });
      }
    }
    return output;
  }
  var before = list(), title = String(read(windows[0], 'name') || read(windows[0], 'title'));
  if (action === 'inspect') return JSON.stringify({ app: bundle, window: title, elements: before, verified: true, changed: false, message: 'Accessible controls were read.' });
  var matches = [];
  if (action !== 'shortcut') for (var wi = 0; wi < windows.length; wi++) { var children = []; try { children = windows[wi].entireContents(); } catch (_) {} for (var j = 0; j < children.length; j++) { var label = String(read(children[j], 'description') || read(children[j], 'name') || read(children[j], 'title')); if (label === selector) matches.push(children[j]); } }
  if (action !== 'shortcut' && matches.length !== 1) return JSON.stringify({ app: bundle, window: title, elements: before, verified: false, changed: false, message: matches.length ? 'More than one accessible control has that exact label.' : 'No accessible control has that exact label.' });
  try {
    var element = matches[0];
    if (action === 'click') element.click();
    else if (action === 'set-text') { if (String(read(element, 'role')).indexOf('Secure') >= 0) throw new Error('Secure text controls are unavailable.'); element.value = text; }
    else if (action === 'shortcut') {
      process.frontmost = true;
      var map = { copy:['c',['command down']], paste:['v',['command down']], 'select-all':['a',['command down']], save:['s',['command down']], undo:['z',['command down']], redo:['z',['command down','shift down']], enter:['return',[]], escape:['escape',[]], tab:['tab',[]] };
      var keys = map[selector]; if (!keys) throw new Error('Unsupported shortcut.');
      events.keystroke(keys[0], keys[1].length ? { using: keys[1] } : {});
    }
    var after = list(), afterTitle = String(read(process.windows()[0], 'name') || read(process.windows()[0], 'title'));
    if (action === 'set-text') { var actual = String(read(element, 'value')); return JSON.stringify({ app: bundle, window: afterTitle, elements: after, verified: actual === text, changed: actual === text, message: actual === text ? 'The accessible text value matches the requested text.' : 'The application did not retain the requested text.' }); }
    var changed = JSON.stringify(before) !== JSON.stringify(after) || title !== afterTitle;
    return JSON.stringify({ app: bundle, window: afterTitle, elements: after, verified: changed, changed, message: changed ? 'The accessible application state changed after the action.' : 'The action was invoked, but Athena could not verify a visible state change.' });
  } catch (error) { return JSON.stringify({ app: bundle, window: title, elements: before, verified: false, changed: false, message: 'macOS could not invoke that accessible control.' }); }
}`

export class MacOSDesktopPlatform implements DesktopPlatform {
  private notifications = new Set<Notification>()
  private abort = new AbortController()
  private lastNotification = -Infinity
  constructor(private platform = process.platform, private run: CommandRunner = async (file, args, options) => executeFile(file, args, { ...options, encoding: 'utf8' })) {}

  private signal(signal: AbortSignal): AbortSignal {
    if (this.platform !== 'darwin') throw new Error('Desktop actions currently support macOS only.')
    const combined = AbortSignal.any([signal, this.abort.signal, AbortSignal.timeout(8_000)])
    combined.throwIfAborted()
    return combined
  }
  private async inspect(app: AppIdentifier, focus: boolean, signal: AbortSignal) {
    const { stdout } = await this.run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', APP_ACTION, APPLICATIONS[app].bundleId, focus ? 'focus' : 'inspect'], {
      encoding: 'utf8', timeout: 5_000, maxBuffer: 16 * 1024, signal,
    })
    return appResult.parse(JSON.parse(stdout))
  }
  async openApplication(input: AppIdentifier, signal: AbortSignal): Promise<DesktopActionResult> {
    const app = appIdentifierSchema.parse(input), deadline = this.signal(signal), target = APPLICATIONS[app]
    await this.run('/usr/bin/open', ['-b', target.bundleId], { timeout: 5_000, maxBuffer: 16 * 1024, signal: deadline })
    const result = await this.inspect(app, false, deadline)
    return result.running
      ? { ok: true, status: 'completed', message: `${target.name} is running. Its foreground position was not checked.` }
      : { ok: false, status: 'failed', message: `macOS accepted the launch request, but ${target.name} could not be confirmed running. Check the app before retrying.` }
  }
  async focusApplication(input: AppIdentifier, signal: AbortSignal): Promise<DesktopActionResult> {
    const app = appIdentifierSchema.parse(input), target = APPLICATIONS[app]
    const result = await this.inspect(app, true, this.signal(signal))
    return result.focused
      ? { ok: true, status: 'completed', message: `${target.name} is now the frontmost application.` }
      : { ok: false, status: 'failed', message: result.running ? `${target.name} is running, but macOS did not confirm switching to it.` : `${target.name} is not running. Ask to open it first.` }
  }
  async openWorkspace(path: string, app: 'vscode' | 'finder', signal: AbortSignal): Promise<DesktopActionResult> {
    const deadline = this.signal(signal)
    const args = app === 'vscode' ? ['-b', APPLICATIONS.vscode.bundleId, '--', path] : [path]
    await this.run('/usr/bin/open', args, { timeout: 5_000, maxBuffer: 16 * 1024, signal: deadline })
    const result = await this.inspect(app, false, deadline)
    return result.running
      ? { ok: true, status: 'completed', message: `${app === 'vscode' ? 'Visual Studio Code' : 'Finder'} is running and macOS accepted the project folder. The folder view itself was not inspected.` }
      : { ok: false, status: 'failed', message: 'macOS accepted the folder request, but the application could not be confirmed running.' }
  }
  private async accessibility(app: AppIdentifier, action: string, selector: string, text: string, signal: AbortSignal) {
    const target = appIdentifierSchema.parse(app), deadline = this.signal(signal)
    if (!systemPreferences.isTrustedAccessibilityClient(false)) throw new Error('Enable Accessibility UI Control in Settings → Privacy, then allow Athena in macOS Accessibility settings.')
    const { stdout } = await this.run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', ACCESSIBILITY_SCRIPT, APPLICATIONS[target].bundleId, action, selector, text], { timeout: 8_000, maxBuffer: 96 * 1024, signal: deadline })
    const result = accessibilityResult.parse(JSON.parse(stdout))
    if ('error' in result) throw new Error(result.error)
    return result
  }
  async inspectAccessibility(app: AppIdentifier, signal: AbortSignal): Promise<AccessibilityInspection> {
    const result = await this.accessibility(app, 'inspect', '', '', signal)
    return { app: APPLICATIONS[appIdentifierSchema.parse(app)].name, window: result.window, elements: result.elements }
  }
  async clickAccessibleElement(app: AppIdentifier, label: string, signal: AbortSignal): Promise<AccessibilityActionResult> {
    const result = await this.accessibility(app, 'click', label, '', signal)
    return { ok: result.verified, verified: result.verified, message: result.message }
  }
  async setAccessibleText(app: AppIdentifier, label: string, text: string, signal: AbortSignal): Promise<AccessibilityActionResult> {
    const result = await this.accessibility(app, 'set-text', label, text, signal)
    return { ok: result.verified, verified: result.verified, message: result.message }
  }
  async pressShortcut(app: AppIdentifier, shortcut: string, signal: AbortSignal): Promise<AccessibilityActionResult> {
    const result = await this.accessibility(app, 'shortcut', shortcut, '', signal)
    return { ok: result.verified, verified: result.verified, message: result.message }
  }
  async openURL(input: string, signal: AbortSignal): Promise<DesktopActionResult> {
    const url = webURLSchema.parse(input), deadline = this.signal(signal)
    deadline.throwIfAborted()
    await this.run('/usr/bin/open', [url], { timeout: 8_000, maxBuffer: 16 * 1024, signal: deadline, encoding: 'utf8' })
    deadline.throwIfAborted()
    return { ok: true, status: 'submitted', message: 'macOS accepted the URL for opening in the default browser. Page loading and page contents were not verified.' }
  }
  async showNotification(title: string, body: string, signal: AbortSignal): Promise<DesktopActionResult> {
    const data = notificationActionSchema.parse({ title, body }), deadline = this.signal(signal)
    if (!Notification.isSupported()) return { ok: false, status: 'failed', message: 'Desktop notifications are unavailable on this system.' }
    if (Date.now() - this.lastNotification < 5_000) return { ok: false, status: 'denied', message: 'Notification rate limit reached. Wait a few seconds before requesting another.' }
    this.lastNotification = Date.now()
    if (this.notifications.size >= 20) {
      const oldest = this.notifications.values().next().value!
      oldest.close(); this.notifications.delete(oldest)
    }
    const notification = new Notification({ title: `Athena · ${data.title}`, body: data.body, silent: true })
    this.notifications.add(notification)
    notification.once('close', () => this.notifications.delete(notification))
    return new Promise((resolve) => {
      let finished = false
      const finish = (result: DesktopActionResult) => {
        if (finished) return
        finished = true
        clearTimeout(timer); deadline.removeEventListener('abort', cancelled)
        notification.removeListener('show', shown); notification.removeListener('failed', failed)
        resolve(result)
      }
      const shown = () => finish({ ok: true, status: 'completed', message: 'macOS reported the Athena notification was shown.' })
      const failed = () => { this.notifications.delete(notification); finish({ ok: false, status: 'failed', message: 'macOS could not display the notification. Check notification settings for Athena.' }) }
      const cancelled = () => { notification.close(); this.notifications.delete(notification); finish({ ok: false, status: 'cancelled', message: 'Notification request stopped; it may already have appeared.' }) }
      const timer = setTimeout(() => finish({ ok: true, status: 'submitted', message: 'Notification submitted. macOS did not confirm display; Focus mode or notification settings may suppress it.' }), 2_000)
      notification.once('show', shown); notification.once('failed', failed)
      deadline.addEventListener('abort', cancelled, { once: true })
      if (deadline.aborted) cancelled()
      else { try { notification.show() } catch { failed() } }
    })
  }
  dispose(): void {
    this.abort.abort()
    for (const notification of this.notifications) notification.close()
    this.notifications.clear()
  }
}
