// Release-time provisioning only: end users never run pip or download Python.
import { readFile, writeFile, mkdir, mkdtemp, rename, rm, cp } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'

const lock = JSON.parse(await readFile('search-runtime/runtime-lock.json', 'utf8'))
const target = `${process.platform}-${process.arch}`
const spec = lock.targets[target]
if (!spec) throw new Error(`SearXNG bundle is not supported on ${target}. Build on a supported native release runner.`)
const destination = resolve('build/search-runtime', target)
const manifest = await readFile(join(destination, 'manifest.json'), 'utf8').then(JSON.parse).catch(() => null)
const launcher = await readFile('search-runtime/launcher.py')
const frozenVersion = await readFile('search-runtime/version_frozen.py')
const launcherHash = createHash('sha256').update(launcher).update(frozenVersion).digest('hex')
const dependencies = await readFile('search-runtime/requirements-lock.txt')
const dependenciesHash = createHash('sha256').update(dependencies).digest('hex')
if (manifest?.revision === lock.revision && manifest.dependenciesHash === dependenciesHash) {
  if (manifest.launcherHash !== launcherHash) {
    await writeFile(join(destination, 'launcher.py'), launcher)
    await writeFile(join(destination, 'source/searx/version_frozen.py'), frozenVersion)
    await writeFile(join(destination, 'manifest.json'), JSON.stringify({ ...manifest, launcherHash }))
  }
  process.exit(0)
}
await mkdir(resolve('build/search-runtime'), { recursive: true })
const stage = await mkdtemp(resolve('build/search-runtime/.build-'))
async function download(url, hash, name) {
  const response = await fetch(url, { signal: AbortSignal.timeout(180000) })
  if (!response.ok) throw new Error(`Runtime download failed: HTTP ${response.status}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  if (createHash('sha256').update(bytes).digest('hex') !== hash) throw new Error(`Checksum mismatch: ${name}`)
  const file = join(stage, name)
  await writeFile(file, bytes)
  return file
}
try {
  const archive = await download(`https://github.com/astral-sh/python-build-standalone/releases/download/${lock.pythonRelease}/cpython-${lock.pythonVersion}%2B${lock.pythonRelease}-${spec.triple}-install_only_stripped.tar.gz`, spec.sha256, 'python.tar.gz')
  execFileSync('tar', ['-xzf', archive, '-C', stage], { stdio: 'inherit' })
  const source = await download(`https://codeload.github.com/searxng/searxng/tar.gz/${lock.searxngCommit}`, lock.sourceSha256, 'searxng-source.tar.gz')
  await mkdir(join(stage, 'source'))
  execFileSync('tar', ['-xzf', source, '--strip-components=1', '-C', join(stage, 'source')], { stdio: 'inherit' })
  const python = join(stage, 'python', process.platform === 'win32' ? 'python.exe' : 'bin/python3')
  execFileSync(python, ['-I', '-m', 'pip', 'install', '--disable-pip-version-check', '--only-binary=:all:', '-r', resolve('search-runtime/requirements-lock.txt'), '-r', join(stage, 'source/requirements.txt')], { stdio: 'inherit', timeout: 600000 })
  await writeFile(join(stage, 'launcher.py'), launcher)
  await writeFile(join(stage, 'source/searx/version_frozen.py'), frozenVersion)
  execFileSync(python, ['-I', '-c', 'import flask, lxml, curl_cffi, waitress, msgspec'], { stdio: 'inherit' })
  await writeFile(join(stage, 'manifest.json'), JSON.stringify({ revision: lock.revision, target, python: lock.pythonVersion, searxng: lock.searxngCommit, launcherHash, dependenciesHash }))
  // Include exact corresponding SearXNG source and licenses in every distribution.
  await cp('search-runtime/NOTICE.txt', join(stage, 'NOTICE.txt'))
  await rm(archive); await rm(source)
  await rm(destination, { recursive: true, force: true }) // generated bundle only
  await rename(stage, destination)
  console.log(`Prepared managed SearXNG runtime: ${target}`)
} finally { await rm(stage, { recursive: true, force: true }) }
