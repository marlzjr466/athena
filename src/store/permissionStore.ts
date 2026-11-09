import { create } from 'zustand'
import { desktop } from '../services/desktop'
import type { AthenaPermission, FilesystemAccessMode, PermissionResult, PermissionSnapshot } from '../../shared/permissions'

interface PermissionStore {
  snapshot: PermissionSnapshot | null
  pending: boolean
  error: string | null
  notice: string
  updateRemembered(input: import('../../shared/permissions').RememberedCommand): Promise<boolean>
  refresh(): Promise<void>
  setEnabled(permission: AthenaPermission, enabled: boolean): Promise<boolean>
  setFilesystemAccess(mode: FilesystemAccessMode): Promise<boolean>
  request(permission: AthenaPermission): Promise<boolean>
  openSettings(permission: AthenaPermission): Promise<boolean>
}
async function mutate(operation: () => Promise<PermissionResult>): Promise<boolean> {
  if (usePermissions.getState().pending) return false
  usePermissions.setState({ pending: true, error: null, notice: '' })
  try {
    const result = await operation()
    usePermissions.setState({ snapshot: result.snapshot, notice: result.ok ? result.message : '', error: result.ok ? null : result.message })
    return result.ok
  } catch { usePermissions.setState({ error: 'Could not update permissions. Reopen Privacy or retry.' }); return false }
  finally { usePermissions.setState({ pending: false }) }
}
export const usePermissions = create<PermissionStore>(() => ({
  snapshot: null, pending: false, error: null, notice: '',
  refresh: async () => {
    if (usePermissions.getState().pending) return
    usePermissions.setState({ pending: true, error: null })
    try { usePermissions.setState({ snapshot: await desktop.getPermissions() }) }
    catch { usePermissions.setState({ snapshot: null, error: 'Could not read permissions. Refresh to retry.' }) }
    finally { usePermissions.setState({ pending: false }) }
  },
  updateRemembered: (input) => mutate(() => desktop.updateRememberedPermissions(input)),
  setEnabled: (permission, enabled) => mutate(() => desktop.setPermissionEnabled({ permission, enabled })),
  setFilesystemAccess: (mode) => mutate(() => desktop.setFilesystemAccess({ mode })),
  request: (permission) => mutate(() => desktop.requestPermission({ permission })),
  openSettings: (permission) => mutate(() => desktop.openPermissionSettings({ permission })),
}))
