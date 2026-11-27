import type { AccessibilityActionResult, AccessibilityInspection, AppIdentifier, DesktopActionResult, DesktopRect } from '../../../shared/desktopActions'
import type { BrowserApp } from './desktopContext'

export interface NativePageRequest {
  action:'inspect'|'click'|'set-text'|'set-search-text'|'prepare-search'|'submit-search'|'scroll'|'background-bind'|'background-inspect'|'background-set-text'|'background-submit-search'
  label?:string
  text?:string
  token?:string
}
export interface NativePageResult extends AccessibilityActionResult {
  inputIssued?:boolean
  pageReference?:string
  pageURL?:string
  pageBounds?:DesktopRect
  windowToken?:string
  elements?:Array<AccessibilityInspection['elements'][number] & {searchFieldId?:string;searchValueStamp?:string}>
}

export interface DesktopPlatform {
  browserPage?(app:BrowserApp, request:NativePageRequest, signal:AbortSignal):Promise<NativePageResult>
  installedAction?(target:import('./installedApplications').InstalledApplication,operation:import('./installedApplications').InstalledOperation,label:string,signal:AbortSignal,text?:string):Promise<{ok:boolean;message:string;windowToken?:string;elements?:AccessibilityInspection['elements']}>
  openApplication(app: AppIdentifier, signal: AbortSignal): Promise<DesktopActionResult>
  focusApplication(app: AppIdentifier, signal: AbortSignal): Promise<DesktopActionResult>
  openURL(url: string, signal: AbortSignal): Promise<DesktopActionResult>
  showNotification(title: string, body: string, signal: AbortSignal): Promise<DesktopActionResult>
  openWorkspace?(path: string, app: 'vscode' | 'finder', signal: AbortSignal): Promise<DesktopActionResult>
  inspectAccessibility?(app: AppIdentifier, signal: AbortSignal): Promise<AccessibilityInspection>
  clickAccessibleElement?(app: AppIdentifier, label: string, signal: AbortSignal): Promise<AccessibilityActionResult>
  setAccessibleText?(app: AppIdentifier, label: string, text: string, signal: AbortSignal): Promise<AccessibilityActionResult>
  pressShortcut?(app: AppIdentifier, shortcut: string, signal: AbortSignal): Promise<AccessibilityActionResult>
  manageWindow?(app:AppIdentifier, operation:import('../../../shared/desktopActions').WindowOperation, point:string, signal:AbortSignal):Promise<AccessibilityActionResult>
  scrollAccessible?(app: AppIdentifier, label: string, direction: 'up' | 'down', signal: AbortSignal): Promise<AccessibilityActionResult>
  runningApplications?(signal: AbortSignal): Promise<Array<{ app: string; name: string; active: boolean }>>
  dispose(): void
}
