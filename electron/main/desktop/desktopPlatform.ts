import type { AccessibilityActionResult, AccessibilityInspection, AppIdentifier, DesktopActionResult } from '../../../shared/desktopActions'

export interface DesktopPlatform {
  openApplication(app: AppIdentifier, signal: AbortSignal): Promise<DesktopActionResult>
  focusApplication(app: AppIdentifier, signal: AbortSignal): Promise<DesktopActionResult>
  openURL(url: string, signal: AbortSignal): Promise<DesktopActionResult>
  showNotification(title: string, body: string, signal: AbortSignal): Promise<DesktopActionResult>
  openWorkspace?(path: string, app: 'vscode' | 'finder', signal: AbortSignal): Promise<DesktopActionResult>
  inspectAccessibility?(app: AppIdentifier, signal: AbortSignal): Promise<AccessibilityInspection>
  clickAccessibleElement?(app: AppIdentifier, label: string, signal: AbortSignal): Promise<AccessibilityActionResult>
  setAccessibleText?(app: AppIdentifier, label: string, text: string, signal: AbortSignal): Promise<AccessibilityActionResult>
  pressShortcut?(app: AppIdentifier, shortcut: string, signal: AbortSignal): Promise<AccessibilityActionResult>
  dispose(): void
}
