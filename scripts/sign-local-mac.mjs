import { readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { signAsync } from '@electron/osx-sign'

// Personal local builds keep the same certificate across updates. No Apple
// account, global certificate trust, privacy database edits or ad-hoc fallback.
const directory = join(homedir(), 'Library/Application Support/AthenaBuild/signing')
function run(binary, args) {
  const result = spawnSync(binary, args, { encoding: 'utf8' })
  // Never include command arguments: security commands contain the keychain password.
  if (result.error || result.status !== 0) throw new Error(`${binary} failed (exit ${result.status}). Local signing was not completed.`)
  return result.stdout
}
export async function sign(options) {
  if (process.platform !== 'darwin') throw new Error('Local macOS signing requires macOS.')
  let identity, password
  try {
    identity = JSON.parse(await readFile(join(directory, 'identity.json'), 'utf8'))
    password = (await readFile(join(directory, 'keychain-password'), 'utf8')).trim()
  } catch { throw new Error('Persistent Athena signing identity missing. Run npm run setup:local-signing once; do not replace an existing identity or fall back to ad-hoc signing.') }
  if (!/^[A-Fa-f0-9]{40}$/.test(identity.fingerprint) || identity.keychain !== join(directory, 'athena-build.keychain-db')) throw new Error('Invalid local signing configuration.')
  const appPath = resolve(options.app)
  const bundleId = run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', join(appPath, 'Contents/Info.plist')]).trim()
  if (bundleId !== 'com.athena.companion') throw new Error('Refusing to sign a different application.')
  const original = [...run('/usr/bin/security', ['list-keychains', '-d', 'user']).matchAll(/"([^"]+)"/g)].map(match => match[1])
  try {
    run('/usr/bin/security', ['unlock-keychain', '-p', password, identity.keychain])
    // codesign needs the keychain in the search list even with --keychain. The
    // previous list is restored; certificate trust settings are never changed.
    run('/usr/bin/security', ['list-keychains', '-d', 'user', '-s', identity.keychain, ...original.filter(path => path !== identity.keychain)])
    await signAsync({ app: appPath, platform: 'darwin', identity: identity.fingerprint, keychain: identity.keychain,
      identityValidation: false, preAutoEntitlements: false, preEmbedProvisioningProfile: false,
      optionsForFile: () => ({ hardenedRuntime: false, entitlements: [], timestamp: 'none' }) })
    run('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath])
    const requirement = `identifier "com.athena.companion" and certificate leaf = H"${identity.fingerprint.toLowerCase()}"`
    run('/usr/bin/codesign', ['--verify', '-R', `=${requirement}`, appPath])
    console.log('Athena signed and verified with its persistent local certificate.')
  } finally {
    run('/usr/bin/security', ['list-keychains', '-d', 'user', '-s', ...original])
    run('/usr/bin/security', ['lock-keychain', identity.keychain])
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.argv[2]) throw new Error('Pass the existing Athena.app path.')
  await sign({ app: process.argv[2] })
}
