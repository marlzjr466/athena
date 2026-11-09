import { app, desktopCapturer, shell, systemPreferences } from 'electron'
import { dirname } from 'node:path'
import type { MeetingScreenAccess } from '../../../shared/meetings'

export const screenPermissionHelp = 'macOS has not authorized this running copy of Athena. If Athena is already enabled, open Screen access below, show this Athena app, remove the stale Athena entry in System Settings and add this app again, then restart Athena.'

export function meetingScreenAccess(): MeetingScreenAccess {
  return {
    status: process.platform === 'darwin' ? systemPreferences.getMediaAccessStatus('screen') : 'not-required',
    appPath: app.isPackaged && process.platform === 'darwin' ? dirname(dirname(dirname(app.getPath('exe')))) : app.getAppPath(),
  }
}

/** Register this process with macOS without requesting any image or audio frames. */
export async function requestMeetingScreenAccess(signal?: AbortSignal): Promise<MeetingScreenAccess> {
  signal?.throwIfAborted()
  const before = meetingScreenAccess()
  if (process.platform === 'darwin' && before.status !== 'granted' && before.status !== 'restricted') {
    await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false })
  }
  signal?.throwIfAborted()
  return meetingScreenAccess()
}

export async function ensureMeetingScreenAccess(signal: AbortSignal): Promise<void> {
  if (process.platform !== 'darwin') return
  const access = await requestMeetingScreenAccess(signal)
  if (access.status === 'restricted') throw new Error('Screen capture is restricted by macOS policy. Contact the administrator of this Mac.')
  // A nonempty desktop thumbnail can contain only wallpaper when permission is
  // denied. Never mistake that for successful authorized application capture.
  if (access.status !== 'granted') throw new Error(screenPermissionHelp)
}

export async function openMeetingScreenSettings(): Promise<void> {
  if (process.platform !== 'darwin') throw new Error('Screen recording settings are available on macOS only.')
  await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture')
}

export function revealMeetingApp(): void { shell.showItemInFolder(meetingScreenAccess().appPath) }
