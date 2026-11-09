import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const profile = await mkdtemp(join(tmpdir(), 'athena-build-isolation-'))
let dev, build, devOutput = '', buildOutput = ''
const capture = (child, update) => {
  child.stdout.on('data', chunk => update(chunk.toString()))
  child.stderr.on('data', chunk => update(chunk.toString()))
}
const waitFor = async (check, label, timeout) => {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > timeout) throw new Error(`Timed out waiting for ${label}.`)
    await new Promise(resolve => setTimeout(resolve, 200))
  }
}
const stopOwned = async child => {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  try { process.kill(-child.pid, 'SIGINT') } catch { /* already exited */ }
  await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 5000))])
  if (child.exitCode === null && child.signalCode === null) try { process.kill(-child.pid, 'SIGKILL') } catch { /* already exited */ }
}

try {
  dev = spawn('npm', ['run', 'dev'], { cwd: root, env: { ...process.env, ATHENA_TEST_DATA: profile }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  capture(dev, chunk => { devOutput = (devOutput + chunk).slice(-24_000) })
  await waitFor(() => devOutput.includes('application.started') || dev.exitCode !== null, 'development Electron startup', 40_000)
  if (dev.exitCode !== null) throw new Error(`Development process exited before build (code ${dev.exitCode}, signal ${dev.signalCode}).`)
  const packageVersion = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version
  if (!devOutput.includes(`"event":"application.started","version":"${packageVersion}"`)) throw new Error('Development Electron loaded the wrong package identity or version.')
  const url = devOutput.match(/https?:\/\/localhost:\d+\//)?.[0]
  if (!url) throw new Error('Development server URL was not reported.')
  if ((await fetch(url)).status !== 200) throw new Error('Development renderer was not reachable before build.')

  build = spawn('npm', ['run', 'build'], { cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  capture(build, chunk => { buildOutput = (buildOutput + chunk).slice(-24_000) })
  await waitFor(() => build.exitCode !== null || build.signalCode !== null, 'production build', 180_000)
  if (build.exitCode !== 0) throw new Error(`Production build exited with code ${build.exitCode}, signal ${build.signalCode}.`)
  if (dev.exitCode !== null || dev.signalCode !== null) throw new Error(`Development process exited during build (code ${dev.exitCode}, signal ${dev.signalCode}).`)
  const renderer = await fetch(url)
  const hmrClient = await fetch(new URL('@vite/client', url))
  if (renderer.status !== 200 || hmrClient.status !== 200) throw new Error(`Development renderer/HMR is unavailable after build (${renderer.status}/${hmrClient.status}).`)
  for (const path of ['out/main/main.js', 'out/preload/preload.cjs', 'out/renderer/index.html', 'out-dev/main/main.js', 'out-dev/preload/preload.cjs']) {
    if (!existsSync(join(root, path))) throw new Error(`Missing required output: ${path}`)
  }
  console.log(JSON.stringify({ result: 'pass', developmentPid: dev.pid, developmentUrl: url, buildExitCode: build.exitCode, rendererStatus: renderer.status, hmrClientStatus: hmrClient.status, electronStarted: true }))
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  console.error('Development output:', devOutput.slice(-3000))
  console.error('Build output:', buildOutput.slice(-3000))
  process.exitCode = 1
} finally {
  await stopOwned(build)
  await stopOwned(dev)
  await rm(profile, { recursive: true, force: true })
}
