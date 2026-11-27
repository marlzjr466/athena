import { desktopCapturer, shell, systemPreferences } from 'electron'
import type { AthenaPermission, OSPermissionStatus } from '../../../shared/permissions'
import { runningApplicationPath, revealRunningApplication } from './runningApplication'

export interface OSAccess { status: OSPermissionStatus; canRequest: boolean; canOpenSettings: boolean; detail: string; appPath?: string }
export interface PermissionPlatform {
  getStatus(permission: AthenaPermission): OSAccess
  request(permission: AthenaPermission): Promise<void>
  openSettings(permission: AthenaPermission): Promise<void>
  revealApplication?(): void
}
const settingsURLs: Partial<Record<AthenaPermission, string>> = {
  microphone: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
  screenCapture: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  accessibilityControl: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
}
export function mediaPermissionStatus(value: string): OSPermissionStatus {
  switch (value) {
    case 'granted': return 'allowed'
    case 'not-determined': return 'not-requested'
    case 'denied': return 'denied'
    case 'restricted': return 'restricted'
    default: return 'unavailable'
  }
}
export class MacOSPermissionAdapter implements PermissionPlatform {
  constructor(private platform = process.platform) {}
  getStatus(permission: AthenaPermission): OSAccess {
    if (this.platform === 'win32') {
      if (permission === 'screenCapture') return { status: 'not-required', canRequest: false, canOpenSettings: false, detail: 'Explicit Athena opt-in and approval of each capture target are required. Protected or elevated windows may be unavailable.' }
      if (permission === 'microphone') return { status: mediaPermissionStatus(systemPreferences.getMediaAccessStatus('microphone')), canRequest: false, canOpenSettings: false, detail: 'Allow desktop microphone access in Windows Settings → Privacy & security → Microphone.' }
      return { status: 'not-required', canRequest: false, canOpenSettings: false, detail: 'Athena opt-in is required. Windows integrity, filesystem, and target application restrictions are checked when an action runs. Athena never elevates.' }
    }
    if (this.platform !== 'darwin') return { status: 'unavailable', canRequest: false, canOpenSettings: false, detail: 'OS permission integration currently supports macOS only.' }
    if (permission === 'microphone' || permission === 'screenCapture') {
      const status = mediaPermissionStatus(systemPreferences.getMediaAccessStatus(permission === 'microphone' ? 'microphone' : 'screen'))
      return { status, canRequest: status === 'not-requested' || (permission === 'screenCapture' && status === 'denied'), canOpenSettings: true,
        detail: permission === 'microphone' ? 'macOS microphone consent is checked directly. Push-to-talk records only while active, up to 60 seconds. Released recordings are sent to OpenAI for transcription; audio is not saved.' : 'OS access permits screen-source discovery. Conversation snapshots need approval. Computer use separately asks to share a specific window, then observes that same window before and after actions for the active task. Capture stops with the task or revoked access; another window needs new approval. No screen audio is captured.' }
    }
    if (permission === 'desktopAutomation') {
      return { status: 'not-required', canRequest: false, canOpenSettings: false,
        detail: 'These app-launch, app-switch, web-link, and notification actions need no Accessibility grant. Athena checks your opt-in for every action. macOS notification settings can still suppress delivery. This does not grant control of app contents.' }
    }
    if (permission === 'accessibilityControl') {
      const status = systemPreferences.isTrustedAccessibilityClient(false) ? 'allowed' : 'denied'
      return { status, canRequest: status !== 'allowed', canOpenSettings: true, appPath: runningApplicationPath(this.platform),
        detail: status === 'allowed' ? 'macOS Accessibility consent is active for this running copy of Athena. Desktop UI interaction must also be enabled under AI → Automation permissions.' : 'macOS has not authorized this running copy of Athena. An enabled Athena entry may point to another copy or an older build. Use “Show this Athena app”, then check the entry with “Show in Finder” in System Settings → Privacy & Security → Accessibility. Replace a stale Athena entry with this exact app, enable it, then return and refresh. Restart Athena if macOS still reports denied. Athena never changes OS grants automatically.' }
    }
    return { status: 'not-required', canRequest: false, canOpenSettings: false,
      detail: permission === 'personalFiles' ? 'This is Athena’s base file-access opt-in. Project folders require separate selection; Full Mac Access requires its own authorization below. macOS can still deny protected locations until you grant Athena access in System Settings.' : permission === 'browserAutomation' ? 'Browser verification runs in a temporary Athena-owned Electron window, never your personal browser profile. Navigation and network requests are restricted to the managed loopback development server.' : 'Basic application-name detection has no dedicated macOS consent switch. Athena’s opt-in gates each on-demand read. It does not grant screen capture or desktop automation.' }
  }
  async request(permission: AthenaPermission): Promise<void> {
    if (!this.getStatus(permission).canRequest) return
    if (permission === 'microphone') await systemPreferences.askForMediaAccess('microphone')
    if (permission === 'screenCapture') await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false })
    if (permission === 'accessibilityControl') systemPreferences.isTrustedAccessibilityClient(true)
  }
  async openSettings(permission: AthenaPermission): Promise<void> {
    if (this.platform !== 'darwin' || !settingsURLs[permission]) throw new Error('No OS settings page for this permission')
    await shell.openExternal(settingsURLs[permission]!)
  }
  revealApplication(): void {
    if (this.platform !== 'darwin') throw new Error('Application permission recovery is available on macOS only.')
    revealRunningApplication(this.platform)
  }
}
