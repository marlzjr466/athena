import { app, BrowserWindow } from 'electron'
import { AgentCommands } from '../../electron/main/ai/agentCommands'
import { DevelopmentServerService } from '../../electron/main/ai/developmentServer'
import { LocalBrowserVerificationService } from '../../electron/main/ai/localBrowserVerification'
import { runBrowserWorker } from '../../electron/main/ai/browserWorker'

if (process.argv.includes('--athena-browser-worker')) {
  runBrowserWorker()
} else {
  const servers = new DevelopmentServerService(new AgentCommands(), 5000)
  const browser = new LocalBrowserVerificationService(() => true)
  Object.assign(globalThis, { serverFixture: {
    servers, browser, pid: process.pid, checkpoint: { task: 'preserved', completed: ['file-one'] },
    async start(root: string, options = {}) {
      return servers.start('conversation', root, 'dev:mock', 'project-only', new AbortController().signal, undefined, () => true, options)
    },
    async cleanup() { await Promise.all([browser.dispose(), servers.stopAll()]) },
  } })
  void app.whenReady().then(async () => {
    const window = new BrowserWindow({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
    await window.loadURL('data:text/html,<h1>Athena process fixture</h1>')
  })
}
