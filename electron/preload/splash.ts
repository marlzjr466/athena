import { contextBridge, ipcRenderer } from 'electron'
import type { StartupPresentation } from '../../shared/startup'

// Keep this preload self-contained: sandboxed Electron preloads cannot require
// Rollup's shared local chunks. The contract test checks these wire names.
const STARTUP_IPC = { state: 'athena:startup-state', stage: 'athena:startup-stage' } as const

// The splash has no access to chat, credentials, settings, or the filesystem.
contextBridge.exposeInMainWorld('athenaSplash', {
  getState: () => ipcRenderer.invoke(STARTUP_IPC.state),
  onStage: (callback: (state: StartupPresentation) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: StartupPresentation) => callback(state)
    ipcRenderer.on(STARTUP_IPC.stage, listener)
    return () => ipcRenderer.removeListener(STARTUP_IPC.stage, listener)
  },
})
