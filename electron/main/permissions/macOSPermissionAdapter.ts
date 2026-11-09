import { desktopCapturer, shell, systemPreferences } from 'electron'
import type { AthenaPermission, OSPermissionStatus } from '../../../shared/permissions'

export interface OSAccess { status: OSPermissionStatus; canRequest: boolean; canOpenSettings: boolean; detail: string }
export interface PermissionPlatform {
  getStatus(permission: AthenaPermission): OSAccess
  request(permission: AthenaPermission): Promise<void>
  openSettings(permission: AthenaPermission): Promise<void>
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
    if (this.platform !== 'darwin') return { status: 'unavailable', canRequest: false, canOpenSettings: false, detail: 'OS permission integration currently supports macOS only.' }
    if (permission === 'microphone' || permission === 'screenCapture') {
      const status = mediaPermissionStatus(systemPreferences.getMediaAccessStatus(permission === 'microphone' ? 'microphone' : 'screen'))
      return { status, canRequest: status === 'not-requested' || (permission === 'screenCapture' && status === 'denied'), canOpenSettings: true,
        detail: permission === 'microphone' ? 'macOS microphone consent is checked directly. Push-to-talk records only while active, up to 60 seconds. Released recordings are sent to OpenAI for transcription; audio is not saved.' : 'Request macOS access to register screen sources without screenshots. macOS may prompt or require you to enable Athena in Screen & System Audio Recording, then restart. Actual snapshots require a separate approval in Conversation and are sent to OpenAI only for that request. No audio is captured.' }
    }
    if (permission === 'desktopAutomation') {
      return { status: 'not-required', canRequest: false, canOpenSettings: false,
        detail: 'These app-launch, app-switch, web-link, and notification actions need no Accessibility grant. Athena checks your opt-in for every action. macOS notification settings can still suppress delivery. This does not grant control of app contents.' }
    }
    if (permission === 'accessibilityControl') {
      const status = systemPreferences.isTrustedAccessibilityClient(false) ? 'allowed' : 'denied'
      return { status, canRequest: status !== 'allowed', canOpenSettings: true,
        detail: status === 'allowed' ? 'macOS Accessibility consent is active for this Athena process.' : 'macOS Accessibility consent is required for named control inspection and actions. Athena will not use screen coordinates.' }
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
}
