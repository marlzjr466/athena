import { create } from 'zustand'
import type { DesktopCommand, Snapshot } from '../../shared/contracts'
import type { SettingsPatch } from '../../shared/settings'
import { desktop } from '../services/desktop'

interface AthenaStore {
  snapshot: Snapshot | null
  error: string | null
  page: string
  setPage(page: string): void
  update(patch: SettingsPatch): Promise<void>
  command(command: DesktopCommand): Promise<void>
  dismissError(): void
}
export const useAthena = create<AthenaStore>((set) => ({
  snapshot: null, error: null, page: 'companion',
  setPage: (page) => set({ page }),
  update: async (patch) => {
    try { set({ snapshot: await desktop.updateSettings(patch), error: null }) }
    catch (error) { set({ error: error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : 'Unable to save this setting.' }) }
  },
  command: async (command) => {
    try { await desktop.command(command) }
    catch (error) { set({ error: error instanceof Error ? error.message : 'Unable to complete that action.' }) }
  },
  dismissError: () => set({ error: null }),
}))
export function connectDesktop(): () => void {
  let live = true
  let received = false
  const off = desktop.onSnapshot((snapshot) => { received = true; if (live) useAthena.setState({ snapshot }) })
  void desktop.getSnapshot().then((snapshot) => { if (live && !received) useAthena.setState({ snapshot }) }).catch(() => { if (live) useAthena.setState({ error: 'Could not connect to Athena’s desktop process. Restart the app to reconnect.' }) })
  const offNavigate = desktop.onNavigate((page) => useAthena.setState({ page }))
  return () => { live = false; off(); offNavigate() }
}
