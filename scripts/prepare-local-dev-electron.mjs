import { access, mkdir, readFile, rm } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { signApp } from './sign-local-mac.mjs'
import { credentialServiceConfiguration } from './prepare-credential-service.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const APP_ID = 'com.athena.companion'

function run(binary, args) {
  const result = spawnSync(binary, args, { encoding: 'utf8' })
  if (result.error || result.status !== 0) throw new Error(`${binary} failed while preparing Athena’s stable development app.`)
  return result.stdout
}

async function isReadable(path) { return access(path).then(() => true, () => false) }

export async function prepareLocalDevElectron() {
  if (process.platform !== 'darwin') return undefined
  const identityDirectory = join(homedir(), 'Library/Application Support/AthenaBuild/signing')
  let signingIdentity
  try { signingIdentity = JSON.parse(await readFile(join(identityDirectory, 'identity.json'), 'utf8')) }
  catch { throw new Error('Run npm run setup:local-signing once before starting macOS development.') }
  if (!/^[A-Fa-f0-9]{40}$/.test(signingIdentity.fingerprint)) throw new Error('The persistent Athena development signing identity is invalid.')

  const require = createRequire(import.meta.url)
  const electronPackagePath = require.resolve('electron/package.json')
  const electronRoot = dirname(electronPackagePath)
  const electronVersion = JSON.parse(await readFile(electronPackagePath, 'utf8')).version
  const executableRelative = (await readFile(join(electronRoot, 'path.txt'), 'utf8')).trim()
  const appMarker = '.app/'
  const appRelative = executableRelative.slice(0, executableRelative.indexOf(appMarker) + 4)
  if (!appRelative.endsWith('.app')) throw new Error('Electron’s macOS app bundle could not be located.')
  const sourceApp = join(electronRoot, 'dist', appRelative)
  const generatedRoot = resolve(root, 'out-dev', '.electron-dev')
  const bundleRoot = join(generatedRoot, `${electronVersion}-${signingIdentity.fingerprint.toLowerCase()}`)
  const appBundle = join(bundleRoot, 'Athena.app')
  const executable = join(appBundle, executableRelative.slice(executableRelative.indexOf(appMarker) + appMarker.length))
  const infoPlist = join(appBundle, 'Contents', 'Info.plist')
  const expectedRequirement = `identifier "${APP_ID}" and certificate leaf = H"${signingIdentity.fingerprint.toLowerCase()}"`

  let reusable = await isReadable(infoPlist) && await isReadable(join(appBundle, 'Contents/Resources/native/athena-credential-service'))
  if (reusable) {
    try {
      const { sourceKey } = await credentialServiceConfiguration({ ...signingIdentity, fingerprint: signingIdentity.fingerprint.toLowerCase() })
      if ((await readFile(join(appBundle, 'Contents/Resources/native/credential-service-version'), 'utf8')).trim() !== sourceKey) throw new Error('Credential service update required.')
      const bundleId = run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', infoPlist]).trim()
      const result = spawnSync('/usr/bin/codesign', ['-dr', '-', appBundle], { encoding: 'utf8' })
      if (result.error || result.status !== 0) throw new Error('Signature not available.')
      const requirement = `${result.stdout}\n${result.stderr}`
      run('/usr/bin/codesign', ['--verify', '--deep', '--strict', appBundle])
      reusable = bundleId === APP_ID && requirement.includes(expectedRequirement)
    } catch { reusable = false }
  }
  if (!reusable) {
    const relativeTarget = relative(generatedRoot, appBundle)
    if (!relativeTarget || relativeTarget.startsWith(`..${sep}`) || relativeTarget === '..') throw new Error('Refusing to modify a path outside generated development output.')
    await rm(bundleRoot, { recursive: true, force: true })
    await mkdir(bundleRoot, { recursive: true })
    run('/usr/bin/ditto', [sourceApp, appBundle])
    run('/usr/libexec/PlistBuddy', ['-c', `Set :CFBundleIdentifier ${APP_ID}`, infoPlist])
    await signApp({ app: appBundle, bundleId: APP_ID })
  }
  return executable
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const path = await prepareLocalDevElectron()
  if (path) console.log('Athena development will use its stable locally signed Electron bundle.')
}
