import { spawn, spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { prepareLocalDevElectron } from './prepare-local-dev-electron.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
function runNode(script) {
  const result = spawnSync(process.execPath, [resolve(root, script)], { cwd: root, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

runNode('scripts/build-screen-ocr.mjs')
runNode('scripts/prepare-dev.mjs')
const electronExecutable = await prepareLocalDevElectron()
const viteCli = resolve(root, 'node_modules/electron-vite/bin/electron-vite.js')
const child = spawn(process.execPath, [viteCli, 'dev', '--entry', 'out-dev'], {
  cwd: root,
  env: { ...process.env, ...(electronExecutable ? { ELECTRON_EXEC_PATH: electronExecutable } : {}) },
  stdio: 'inherit',
})
child.on('error', (error) => { console.error(`Could not start Electron Vite: ${error.message}`); process.exitCode = 1 })
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exitCode = code ?? 1
})
