import { connectAudioDevices, setAudioDiscoveryVisibility } from '../services/speech/audioDevices'
import { create } from 'zustand'
import type { DesktopCommand, Snapshot } from '../../shared/contracts'
import type { SettingsPatch } from '../../shared/settings'
import { desktop } from '../services/desktop'

interface AthenaStore {
  snapshot: Snapshot | null
  error: string | null
  page: string
  previousPages: string[]
  nextPages: string[]
  setPage(page: string): void
  update(patch: SettingsPatch): Promise<void>
  command(command: DesktopCommand): Promise<void>
  dismissError(): void
}
export const useAthena = create<AthenaStore>((set) => ({
  snapshot: null, error: null, page: 'companion',
  previousPages: [], nextPages: [],
  setPage: (page) => set(state => page === state.page ? state : {
    page, previousPages: [...state.previousPages, state.page].slice(-40), nextPages: [],
  }),
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
  const offAudio = connectAudioDevices()
  let live = true
  let received = false
  const off = desktop.onSnapshot((snapshot) => { received = true; if (live) { setAudioDiscoveryVisibility(snapshot.visible); useAthena.setState({ snapshot }) } })
  void desktop.getSnapshot().then((snapshot) => { if (live && !received) { setAudioDiscoveryVisibility(snapshot.visible); useAthena.setState({ snapshot }) } }).catch(() => { if (live) useAthena.setState({ error: 'Could not connect to Athena’s desktop process. Restart the app to reconnect.' }) })
  const offNavigate = desktop.onNavigate((page) => {
    const state = useAthena.getState()
    if (page === 'back' || page === 'forward') {
      const from = page === 'back' ? 'previousPages' : 'nextPages'
      const to = page === 'back' ? 'nextPages' : 'previousPages'
      const next = state[from].at(-1)
      if (!next) return
      useAthena.setState({ page: next, [from]: state[from].slice(0,-1), [to]: [...state[to], state.page] })
    } else state.setPage(page)
    return useAthena.getState().page
  })
  return () => { live = false; off(); offNavigate(); offAudio() }
}
