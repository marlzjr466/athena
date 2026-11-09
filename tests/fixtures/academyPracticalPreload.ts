import { contextBridge, ipcRenderer } from 'electron'
contextBridge.exposeInMainWorld('academyFixture', {
  snapshot: () => ipcRenderer.invoke('academy-test:snapshot'),
  requests: () => ipcRenderer.invoke('academy-test:request-count'),
  command: (command: unknown) => ipcRenderer.invoke('academy-test:command', command),
})
