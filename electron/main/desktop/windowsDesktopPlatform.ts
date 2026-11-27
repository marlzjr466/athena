import { windowsWindowContext } from './windowsWindowContext'
import { chooseWindow, windowRequest, workspaceStateSchema, workspaceResultSchema, type WorkspaceRequest } from './desktopContext'
import { desktopRectSchema } from '../../../shared/desktopActions'
import { execFile, spawn } from 'node:child_process'
import { gzipSync } from 'node:zlib'
import { promisify } from 'node:util'
import { access } from 'node:fs/promises'
import { win32 } from 'node:path'
import { Notification, shell } from 'electron'
import { z } from 'zod'
import { appIdentifierSchema, webURLSchema, type AppIdentifier, type AccessibilityInspection, type AccessibilityActionResult, type DesktopActionResult } from '../../../shared/desktopActions'
import { ChatError } from '../ai/AIProvider'
import type { DesktopPlatform, NativePageRequest } from './desktopPlatform'
import type { BrowserApp } from './desktopContext'

const execute = promisify(execFile)
type Runner = (file: string, args: string[], options: { signal: AbortSignal; timeout: number; maxBuffer: number; windowsHide: boolean }) => Promise<{ stdout: string }>
// Fixed UI Automation program. Only validated JSON data is interpolated as base64.
const UIASetup = String.raw`
$ErrorActionPreference='Stop'
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes,System.Windows.Forms
Add-Type 'using System; using System.Runtime.InteropServices; public class AthenaWindow { [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); [DllImport("user32.dll")]public static extern bool IsWindow(IntPtr h); [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr w,out int p); }'
$names=@{cursor='Cursor';edge='msedge';firefox='firefox';teams='ms-teams';word='WINWORD';excel='EXCEL';discord='Discord';vscode='Code';chrome='chrome';finder='explorer';terminal='powershell';slack='slack';spotify='Spotify';calculator='CalculatorApp'}
`
const UIA = String.raw`
$fg=[AthenaWindow]::GetForegroundWindow();$fgOwner=0;[void][AthenaWindow]::GetWindowThreadProcessId($fg,[ref]$fgOwner)
$all=@(Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -or $_.Id -eq $fgOwner })
if($request.action -eq 'running') { @($all | ForEach-Object { @{app=$_.ProcessName;name=$_.ProcessName;active=($_.Id -eq $fgOwner)} }) | ConvertTo-Json -Compress; exit }
$targets=if($request.path){@($all | Where-Object {$_.Path -eq $request.path})}else{@($all | Where-Object { $_.ProcessName -eq $names[$request.app] })}
$targets=@($targets)
if($targets.Count -gt 1 -and $targets.Id -contains $fgOwner){$targets=@($targets|Where-Object {$_.Id -eq $fgOwner})}
if($targets.Count -ne 1) { throw 'No unique supported application window. Open the app and select a single window first.' }
$target=$targets[0]; $handle=if($target.Id -eq $fgOwner){$fg}else{$target.MainWindowHandle}; $token="$($target.Id):$handle"
if($request.action -eq 'focus') { [void][AthenaWindow]::SetForegroundWindow($handle); @{ok=([AthenaWindow]::GetForegroundWindow() -eq $handle);verified=([AthenaWindow]::GetForegroundWindow() -eq $handle);message='Checked the target foreground window.'} | ConvertTo-Json -Compress; exit }
if($request.path -and $fgOwner -ne $target.Id){throw 'The authorized application is no longer in the foreground.'}
$root=[System.Windows.Automation.AutomationElement]::FromHandle($handle)
$web=$request.action.StartsWith('web-')
$walker=[System.Windows.Automation.TreeWalker]::ControlViewWalker
function WalkPage($base,$findDoc) {
  $queue=New-Object System.Collections.Queue;$queue.Enqueue($base);$count=0
  while($queue.Count -gt 0 -and $count -lt 1200) {
    $item=$queue.Dequeue();$count++
    if($item.Current.IsPassword){continue}
    $document=$item.Current.ControlType -eq [System.Windows.Automation.ControlType]::Document
    if($document -and $findDoc){if(-not $item.Current.IsOffscreen){$item};continue}
    if($document -and -not $item.Equals($base)){continue}
    if(-not $findDoc -and -not $item.Current.IsOffscreen){$item}
    for($child=$walker.GetFirstChild($item);$null -ne $child;$child=$walker.GetNextSibling($child)){$queue.Enqueue($child)}
  }
}
if($web) {
  if($fg -ne $handle){throw 'Focus the browser window before inspecting its page.'}
  $docs=@(WalkPage $root $true);if($docs.Count -ne 1){throw 'Select one visible browser document.'}
  $root=$docs[0];$pageURL=$root.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value
  if($pageURL -notmatch '^https?://'){throw 'The browser has not exposed the public page address.'}
  $token+=':'+($root.GetRuntimeId() -join '.')+':'+$pageURL
  $request.action=$request.action.Substring(4)
}
function Elements { if($web){WalkPage $root $false}else{$root.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition)} }
function ControlName($e) {
  $name=$e.Current.Name
  if($web -and -not $name -and $e.Current.ControlType.ProgrammaticName -in @('ControlType.Edit','ControlType.ComboBox')) {
    $name='Unlabeled '+$e.Current.ControlType.ProgrammaticName+' · '+($e.GetRuntimeId() -join '.')
  }
  if($name){$name.Substring(0,[Math]::Min(160,$name.Length))}
}
function Snapshot { @((Elements) | Where-Object { -not $_.Current.IsPassword -and (-not $web -or $_.Current.ControlType.ProgrammaticName -notin @('ControlType.Document','ControlType.Group','ControlType.Pane')) -and (ControlName $_) } | Select-Object -First 120 | ForEach-Object { @{label=(ControlName $_);role=$_.Current.ControlType.ProgrammaticName;enabled=$_.Current.IsEnabled;focused=$_.Current.HasKeyboardFocus;bounds=$(if ($_.Current.BoundingRectangle.Width -gt 0 -and $_.Current.BoundingRectangle.Height -gt 0){@{x=$_.Current.BoundingRectangle.X;y=$_.Current.BoundingRectangle.Y;width=$_.Current.BoundingRectangle.Width;height=$_.Current.BoundingRectangle.Height}})} }) }
$before=Snapshot
if($request.action -eq 'inspect') {
  $view=@{app=$request.app;window=$root.Current.Name;windowToken=$token;elements=$before}
  if($web){
    $view.pageURL=$pageURL
    $box=$root.Current.BoundingRectangle
    if($box.Width -gt 0 -and $box.Height -gt 0){$view.pageBounds=@{x=$box.X;y=$box.Y;width=$box.Width;height=$box.Height}}
  }
  $view | ConvertTo-Json -Depth 5 -Compress; exit
}
if(-not $request.token -or $request.token -ne $token) { throw 'The target window changed or needs a fresh inspection.' }
if($request.action -eq 'window') {
  if($request.label -eq 'close') {
    $pattern=$root.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern)
    $pattern.Close()
    $deadline=[DateTime]::UtcNow.AddSeconds(1)
    while([AthenaWindow]::IsWindow($handle) -and [DateTime]::UtcNow -lt $deadline){Start-Sleep -Milliseconds 30}
    $closed=-not [AthenaWindow]::IsWindow($handle)
    @{ok=$closed;verified=$closed;message=$(if($closed){'The observed window closed.'}else{'The window remains open. Review any save dialog.'})}|ConvertTo-Json -Compress;exit
  }
  if($request.label -eq 'move') {
    $xy=$request.text.Split(','); if($xy.Length -ne 2){throw 'Invalid window position.'}
    $x=[int]$xy[0]; $y=[int]$xy[1]
    if(-not ([System.Windows.Forms.Screen]::AllScreens | Where-Object {$_.Bounds.Contains($x,$y)})) { throw 'Choose a point on a connected display.' }
    $transform=$root.GetCurrentPattern([System.Windows.Automation.TransformPattern]::Pattern)
    $transform.Move($x,$y); Start-Sleep -Milliseconds 200
    $rect=$root.Current.BoundingRectangle; $ok=([math]::Abs($rect.Left-$x) -le 2 -and [math]::Abs($rect.Top-$y) -le 2)
  } else {
    $states=@{maximize='Maximized';minimize='Minimized';restore='Normal'}
    if(-not $states.ContainsKey($request.label)){throw 'Unknown window operation.'}
    $pattern=$root.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern)
    $desired=[System.Windows.Automation.WindowVisualState]$states[$request.label]; $pattern.SetWindowVisualState($desired)
    Start-Sleep -Milliseconds 200; $ok=($pattern.Current.WindowVisualState -eq $desired)
  }
  @{ok=$ok;verified=$ok;message='Checked the requested window state.'} | ConvertTo-Json -Compress;exit
}
$matches=@((Elements) | Where-Object { (ControlName $_) -ceq $request.label -and -not $_.Current.IsPassword -and $_.Current.IsEnabled -and (-not $web -or $request.action -ne 'set-text' -or $_.Current.ControlType.ProgrammaticName -in @('ControlType.Edit','ControlType.ComboBox')) -and (-not $web -or $request.action -ne 'click' -or $_.Current.ControlType.ProgrammaticName -match 'Button$|Hyperlink$|MenuItem$|CheckBox$') })
if($request.action -ne 'shortcut' -and $matches.Count -ne 1) { throw 'No unique enabled, non-password control has that label.' }
if([AthenaWindow]::GetForegroundWindow() -ne $handle) {throw 'The target window lost focus. Inspect it again.'}
if($web -and $root.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value -ne $pageURL){throw 'The active page changed.'}
if($request.action -eq 'click') { $matches[0].GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke() }
elseif($request.action -eq 'set-text') {
  if($request.label -match 'password|secret|token|credential') { throw 'Sensitive text entry is unavailable.' }
  $pattern=$matches[0].GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
  if($pattern.Current.IsReadOnly) { throw 'The text control is read-only.' }
  $pattern.SetValue($request.text)
  $verified=($pattern.Current.Value -eq $request.text)
}
elseif($request.action -eq 'scroll') { $pattern=$matches[0].GetCurrentPattern([System.Windows.Automation.ScrollPattern]::Pattern); $amount=if($request.text -eq 'down'){[System.Windows.Automation.ScrollAmount]::LargeIncrement}else{[System.Windows.Automation.ScrollAmount]::LargeDecrement}; $old=$pattern.Current.VerticalScrollPercent; $pattern.Scroll([System.Windows.Automation.ScrollAmount]::NoAmount,$amount); $verified=if($request.text -eq 'down'){$pattern.Current.VerticalScrollPercent -gt $old}else{$pattern.Current.VerticalScrollPercent -lt $old} }
elseif($request.action -eq 'shortcut') {
  $keys=@{'editor-terminal'=('^'+[char]96);copy='^c';paste='^v';'select-all'='^a';save='^s';undo='^z';redo='^y';enter='{ENTER}';escape='{ESC}';tab='{TAB}'}
  if(-not $keys.ContainsKey($request.label)) { throw 'Unsupported shortcut.' }
  if([AthenaWindow]::GetForegroundWindow() -ne $handle) { throw 'Target app did not gain focus. No input was sent.' }
  [System.Windows.Forms.SendKeys]::SendWait($keys[$request.label])
}
$after=Snapshot
if($null -eq $verified) { $verified=(($before | ConvertTo-Json -Depth 5 -Compress) -ne ($after | ConvertTo-Json -Depth 5 -Compress)) }
@{ok=[bool]$verified;verified=[bool]$verified;message=$(if($verified){'The target control state changed as requested.'}else{'The action was invoked but its result could not be verified. Inspect before retrying.'})} | ConvertTo-Json -Compress
`
const actionResult = z.object({ ok: z.boolean(), verified: z.boolean(), message: z.string() })

/** Windows UIA runs at Athena's existing integrity level. Never elevates or changes execution policy. */
export class WindowsDesktopPlatform implements DesktopPlatform {
  private lifetime = new AbortController()
  private observations = new Map<string, { token: string; at: number }>()
  constructor(private run: Runner = async (file, args, options) => execute(file, args, { ...options, encoding: 'utf8' }), private env: NodeJS.ProcessEnv = process.env) {}
  private async invoke(action: string, app: string | undefined, signal: AbortSignal, label = '', text = '', path?:string,workspace?:WorkspaceRequest,explicitToken?:string): Promise<unknown> {
    const observed = app && this.observations.get(app)
    const data = Buffer.from(JSON.stringify({ action, app, label, text, path, workspace, token: explicitToken ?? (observed && Date.now() - observed.at < 60_000 ? observed.token : '') })).toString('base64')
    let program = `$request=([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${data}')) | ConvertFrom-Json)\n${UIASetup}\n${workspace ? windowsWindowContext : UIA}`
    // Windows CreateProcess limits the complete command line to 32,767 UTF-16 characters.
    if(Buffer.byteLength(program,'utf16le')*4/3>28500){
      const compressed=gzipSync(Buffer.from(program,'utf8')).toString('base64')
      program=`$b=[Convert]::FromBase64String('${compressed}');$m=[IO.MemoryStream]::new($b);$z=[IO.Compression.GzipStream]::new($m,[IO.Compression.CompressionMode]::Decompress);& ([ScriptBlock]::Create([IO.StreamReader]::new($z).ReadToEnd()))`
    }
    const command = win32.join(this.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    try {
      const result = await this.run(command, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(program, 'utf16le').toString('base64')], { signal: AbortSignal.any([signal, this.lifetime.signal]), timeout: 10_000, maxBuffer: 128 * 1024, windowsHide: true })
      return JSON.parse(result.stdout.trim())
    } catch {
      throw new ChatError(signal.aborted ? 'Desktop action cancelled. Check the target before retrying.' : 'Windows UI Automation could not access a unique target window. Keep both applications at the same integrity level, select the target window, then inspect again. Athena does not elevate applications.')
    }
  }
  async workspace(app:AppIdentifier,request:WorkspaceRequest,signal:AbortSignal) {
    const value=await this.invoke('workspace',app,signal,'','',undefined,request)
    if(value && typeof value==='object' && 'error' in value)throw new ChatError(String(value.error))
    return value
  }
  private async activateExisting(app:AppIdentifier,signal:AbortSignal,path?:string):Promise<DesktopActionResult|undefined> {
    const current=workspaceStateSchema.parse(await this.workspace(app,{operation:'observe',path},signal))
    if(!current.running)return undefined
    const win=chooseWindow(current)
    if(current.focused && !win?.minimized)return {ok:true,status:'completed',message:'The application is already in the foreground.'}
    const result=workspaceResultSchema.parse(await this.workspace(app,{operation:'activate',...windowRequest(current,win),path},signal))
    return {...result,status:result.ok?'completed':'failed'}
  }
  async runningApplications(signal: AbortSignal) {
    const value = await this.invoke('running', undefined, signal)
    return z.array(z.object({ app: z.string(), name: z.string(), active: z.boolean() })).max(200).parse(value ? Array.isArray(value) ? value : [value] : [])
  }
  workspaceInstalled(target:import('./installedApplications').InstalledApplication,request:WorkspaceRequest,signal:AbortSignal){
    return this.workspace(target.key as AppIdentifier,{...request,path:target.path},signal)
  }
  async installedAction(target:import('./installedApplications').InstalledApplication,operation:import('./installedApplications').InstalledOperation,label:string,signal:AbortSignal,text='') {
    signal.throwIfAborted()
    if(operation==='open') {
      const existing=await this.activateExisting(target.key as AppIdentifier,signal,target.path)
      if(existing)return existing
      await new Promise<void>((resolve,reject)=>{
        const child=spawn(target.path,[],{shell:false,detached:true,stdio:'ignore'})
        child.once('error',reject);child.once('spawn',()=>{child.unref();resolve()})
      })
      const result=actionResult.parse(await this.invoke('focus',target.key,signal,'','',target.path))
      return {ok:result.ok,message:result.ok?target.name+' is in the foreground.':'Application launch was submitted. Its window could not be verified.'}
    }
    const value=await this.invoke(operation,target.key,signal,label,text,target.path)
    if(operation==='inspect') {
      const view=z.object({windowToken:z.string(),elements:z.array(z.object({label:z.string(),role:z.string(),enabled:z.boolean(),focused:z.boolean().optional(),bounds:desktopRectSchema.nullish().transform(v=>v??undefined)}))}).parse(value)
      this.observations.set(target.key,{token:view.windowToken,at:Date.now()})
      return {ok:true,message:'Inspected '+target.name+'.',elements:view.elements,windowToken:view.windowToken}
    }
    this.observations.delete(target.key)
    return actionResult.parse(value)
  }
  async browserPage(app:BrowserApp,request:NativePageRequest,signal:AbortSignal) {
    if(request.action.startsWith('background-'))throw new ChatError('Windows native automation requires the authorized browser window in the foreground for this action. No input was sent.')
    if(request.action==='prepare-search' || request.action==='submit-search')throw new ChatError('Windows UI Automation cannot verify this form’s search submission. Inspect and activate its search button instead.')
    const result=await this.invoke('web-'+request.action,app,signal,request.label,request.text,undefined,undefined,request.token??'')
    if(request.action!=='inspect')return actionResult.parse(result)
    const view=this.parseInspection(result)
    return {...view,ok:true,verified:true,message:'Read the accessible browser document.'}
  }
  private parseInspection(value:unknown) {
    return z.object({app:z.string(),window:z.string(),pageURL:z.string().optional(),pageBounds:desktopRectSchema.optional(),windowToken:z.string(),elements:z.array(z.object({label:z.string(),role:z.string(),enabled:z.boolean(),focused:z.boolean().optional(),bounds:desktopRectSchema.nullish().transform(v=>v??undefined)}))}).parse(value)
  }
  async inspectAccessibility(app: AppIdentifier, signal: AbortSignal): Promise<AccessibilityInspection> {
    const target = appIdentifierSchema.parse(app)
    const value = this.parseInspection(await this.invoke('inspect', target, signal))
    this.observations.set(target, { token: value.windowToken, at: Date.now() })
    return value
  }
  private async action(action: string, app: AppIdentifier, label: string, text: string, signal: AbortSignal): Promise<AccessibilityActionResult> {
    try { return actionResult.parse(await this.invoke(action, appIdentifierSchema.parse(app), signal, label, text)) }
    finally { this.observations.delete(app) }
  }
  manageWindow(app:AppIdentifier, operation:import('../../../shared/desktopActions').WindowOperation, point:string,signal:AbortSignal){return this.action('window',app,operation,point,signal)}
  clickAccessibleElement(app: AppIdentifier, label: string, signal: AbortSignal) { return this.action('click', app, label, '', signal) }
  setAccessibleText(app: AppIdentifier, label: string, text: string, signal: AbortSignal) { return this.action('set-text', app, label, text, signal) }
  pressShortcut(app: AppIdentifier, shortcut: string, signal: AbortSignal) { return this.action('shortcut', app, shortcut, '', signal) }
  scrollAccessible(app: AppIdentifier, label: string, direction: 'up' | 'down', signal: AbortSignal) { return this.action('scroll', app, label, direction, signal) }
  async focusApplication(app: AppIdentifier, signal: AbortSignal): Promise<DesktopActionResult> {
    return await this.activateExisting(appIdentifierSchema.parse(app),signal) ?? {ok:false,status:'failed',message:'The application is not running.'}
  }
  async openApplication(app: AppIdentifier, signal: AbortSignal): Promise<DesktopActionResult> {
    appIdentifierSchema.parse(app); signal.throwIfAborted()
    const existing=await this.activateExisting(app,signal)
    if(existing)return existing
    const local = this.env.LOCALAPPDATA, programs = this.env.ProgramFiles ?? 'C:\\Program Files', windows = this.env.SystemRoot ?? 'C:\\Windows'
    const paths: Partial<Record<AppIdentifier, Array<string | undefined>>> = {
      vscode: [local && win32.join(local, 'Programs', 'Microsoft VS Code', 'Code.exe'), win32.join(programs, 'Microsoft VS Code', 'Code.exe')],
      chrome: [win32.join(programs, 'Google', 'Chrome', 'Application', 'chrome.exe'), local && win32.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe')],
      finder: [win32.join(windows, 'explorer.exe')], terminal: [win32.join(windows, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')],
      cursor:[local && win32.join(local,'Programs','cursor','Cursor.exe')],
      edge:[win32.join(this.env['ProgramFiles(x86)'] ?? programs,'Microsoft','Edge','Application','msedge.exe')],
      firefox:[win32.join(programs,'Mozilla Firefox','firefox.exe')],
      word:[win32.join(programs,'Microsoft Office','root','Office16','WINWORD.EXE')],
      excel:[win32.join(programs,'Microsoft Office','root','Office16','EXCEL.EXE')],
      teams:[local && win32.join(local,'Microsoft','WindowsApps','ms-teams.exe')],
      calculator: [win32.join(windows, 'System32', 'calc.exe')], slack: [local && win32.join(local, 'slack', 'slack.exe')], spotify: [this.env.APPDATA && win32.join(this.env.APPDATA, 'Spotify', 'Spotify.exe')],
    }
    for (const path of paths[app] ?? []) {
      if (!path) continue
      try { await access(path) } catch { continue }
      signal.throwIfAborted()
      await new Promise<void>((resolve, reject) => { const child = spawn(path, [], { shell: false, detached: true, stdio: 'ignore' }); child.once('error', reject); child.once('spawn', () => { child.unref(); resolve() }) })
      return await this.activateExisting(app,signal) ?? {ok:false,status:'failed',message:'The application launch was submitted. Its window could not be verified.'}
    }
    return { ok: false, status: 'failed', message: 'This application is not installed in a supported Windows location, or has no Windows equivalent.' }
  }
  async openWorkspace(path: string, app: 'vscode' | 'finder', signal: AbortSignal): Promise<DesktopActionResult> {
    signal.throwIfAborted()
    if (app === 'vscode') {
      const { VSCodeApplication } = await import('./vscodeApplication')
      await new VSCodeApplication().openFolder(path, async () => { signal.throwIfAborted() })
    } else { const error = await shell.openPath(path); if (error) throw new ChatError('Windows Explorer could not open the folder.') }
    return { ok: true, status: 'submitted', message: 'The application accepted the project folder. Window contents were not inspected.' }
  }
  async openURL(url: string, signal: AbortSignal): Promise<DesktopActionResult> { signal.throwIfAborted(); await shell.openExternal(webURLSchema.parse(url)); return { ok: true, status: 'submitted', message: 'Windows accepted the URL. Page loading was not verified.' } }
  async showNotification(title: string, body: string, signal: AbortSignal): Promise<DesktopActionResult> { signal.throwIfAborted(); if (!Notification.isSupported()) throw new ChatError('Notifications are unavailable.'); new Notification({ title: `Athena · ${title}`, body, silent: true }).show(); return { ok: true, status: 'submitted', message: 'Notification submitted. Windows may suppress it.' } }
  dispose() { this.lifetime.abort(); this.observations.clear() }
}
