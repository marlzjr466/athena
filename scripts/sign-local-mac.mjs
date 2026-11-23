import { readdir, readFile } from 'node:fs/promises'
import { openSync, readSync, closeSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { signAsync } from '@electron/osx-sign'
import { prepareCredentialService } from './prepare-credential-service.mjs'

const APP_ID = 'com.athena.companion'
const localIdentityDirectory = join(homedir(), 'Library/Application Support/AthenaBuild/signing')
const productionEntitlements = resolve('build/entitlements.mac.plist')

// osx-sign's generic binary detector also selects timezone databases and
// compiled translations. Only Mach-O files in the Python bundle are code.
function searchDataResource(file, appPath) {
  if (!resolve(file).startsWith(join(appPath, 'Contents/Resources/search-runtime') + '/')) return false
  if (!statSync(file).isFile()) return false
  const descriptor = openSync(file, 'r'), header = Buffer.alloc(4)
  try { readSync(descriptor, header, 0, 4, 0) } finally { closeSync(descriptor) }
  return !['feedface', 'cefaedfe', 'feedfacf', 'cffaedfe', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca'].includes(header.toString('hex'))
}

function run(binary, args) {
  const result = spawnSync(binary, args, { encoding: 'utf8' })
  // Never include command arguments: local signing commands can contain a keychain password.
  if (result.error || result.status !== 0) throw new Error(`${binary} failed (exit ${result.status}). Athena was not signed.`)
  return result.stdout
}

function metadata(binary, args) {
  const result = spawnSync(binary, args, { encoding: 'utf8' })
  if (result.error || result.status !== 0) throw new Error(`${binary} could not inspect the Athena signature.`)
  return `${result.stdout}\n${result.stderr}`
}

function notarizationRequested() {
  return Boolean(process.env.APPLE_API_KEY && process.env.APPLE_API_KEY_ID && process.env.APPLE_API_ISSUER)
    || Boolean(process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID)
    || Boolean(process.env.APPLE_KEYCHAIN && process.env.APPLE_KEYCHAIN_PROFILE)
}

function findDeveloperIdIdentity(requested) {
  const lines = run('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning']).split(/\r?\n/)
  const line = lines.find((entry) => entry.includes(requested) && entry.includes('Developer ID Application:'))
  const fingerprint = line?.match(/\b([A-Fa-f0-9]{40})\s+"/)?.[1]
  const name = line?.match(/"(Developer ID Application: .*?)"/)?.[1]
  const teamId = name?.match(/\(([A-Z0-9]{10})\)$/)?.[1]
  if (!line || !fingerprint || !name || !teamId) {
    throw new Error('ATHENA_MACOS_SIGN_IDENTITY must identify a valid Developer ID Application certificate in the macOS signing keychain.')
  }
  return { fingerprint: fingerprint.toLowerCase(), name, teamId }
}

async function localSigningIdentity() {
  let identity, password
  try {
    identity = JSON.parse(await readFile(join(localIdentityDirectory, 'identity.json'), 'utf8'))
    password = (await readFile(join(localIdentityDirectory, 'keychain-password'), 'utf8')).trim()
  } catch {
    throw new Error('Persistent Athena signing identity missing. Run npm run setup:local-signing once; do not replace an existing identity or fall back to ad-hoc signing.')
  }
  const keychain = join(localIdentityDirectory, 'athena-build.keychain-db')
  if (!/^[A-Fa-f0-9]{40}$/.test(identity.fingerprint) || identity.keychain !== keychain || !password) {
    throw new Error('Invalid local Athena signing configuration.')
  }
  return { fingerprint: identity.fingerprint.toLowerCase(), keychain, password }
}

async function findHelperApps(root) {
  const found = []
  const pending = [join(root, 'Contents', 'Frameworks')]
  while (pending.length) {
    const current = pending.pop()
    let entries
    try { entries = await readdir(current, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const path = join(current, entry.name)
      if (entry.name.endsWith('.app')) found.push(path)
      else pending.push(path)
    }
  }
  return found
}

function signatureInfo(bundlePath) {
  const details = metadata('/usr/bin/codesign', ['-dv', '--verbose=4', bundlePath])
  const requirement = metadata('/usr/bin/codesign', ['-dr', '-', bundlePath])
  return {
    identifier: details.match(/^Identifier=(.+)$/m)?.[1],
    teamId: details.match(/^TeamIdentifier=(.+)$/m)?.[1],
    requirement: requirement.match(/designated => (.+)$/m)?.[1] ?? '',
  }
}

async function verifySigner(appPath, { mode, fingerprint, teamId, bundleId }) {
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath])
  run('/usr/bin/codesign', ['--verify', '--strict', '-R', `=identifier "com.athena.companion.credentials" and certificate leaf = H"${fingerprint}"`, join(appPath, 'Contents/Resources/native/athena-credential-service')])
  const bundles = [appPath, ...await findHelperApps(appPath)]
  for (const bundle of bundles) {
    const info = signatureInfo(bundle)
    if (!info.identifier || !info.requirement) throw new Error('A signed Athena bundle is missing its identifier or designated requirement.')
    if (mode === 'local' && !info.requirement.toLowerCase().includes(`certificate leaf = h"${fingerprint}"`)) {
      throw new Error('Athena or one of its helpers is not signed by the persistent local certificate.')
    }
    if (mode === 'developer-id' && info.teamId !== teamId) {
      throw new Error('Athena or one of its helpers is not signed by the configured Developer ID team.')
    }
  }
  const main = signatureInfo(appPath)
  if (main.identifier !== bundleId) throw new Error('The signed Athena bundle identifier did not match the expected identifier.')
  if (mode === 'developer-id' && (!main.requirement.includes('anchor apple generic') || !main.requirement.includes(`subject.OU] = "${teamId}"`))) {
    throw new Error('Athena’s designated requirement is not bound to the configured Apple Developer team.')
  }
  return bundles.length - 1
}

/** Sign an Athena app bundle using the persistent local identity or an explicit Developer ID identity. */
export async function signApp({ app, bundleId = APP_ID } = {}) {
  if (process.platform !== 'darwin') throw new Error('macOS signing requires macOS.')
  const appPath = resolve(app ?? '')
  const actualBundleId = run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', join(appPath, 'Contents/Info.plist')]).trim()
  if (actualBundleId !== bundleId) throw new Error(`Refusing to sign bundle ${actualBundleId}; expected ${bundleId}.`)

  const configuredDeveloperIdentity = process.env.ATHENA_MACOS_SIGN_IDENTITY?.trim()
  if (configuredDeveloperIdentity) {
    const identity = findDeveloperIdIdentity(configuredDeveloperIdentity)
    const credentialService = await prepareCredentialService(appPath, identity, true)
    await signAsync({ app: appPath, platform: 'darwin', identity: identity.fingerprint,
      ignore: file => resolve(file) === credentialService || searchDataResource(file, appPath),
      identityValidation: true, preAutoEntitlements: false, preEmbedProvisioningProfile: false,
      optionsForFile: () => ({ hardenedRuntime: true, entitlements: productionEntitlements }) })
    const helperCount = await verifySigner(appPath, { mode: 'developer-id', ...identity, bundleId })
    console.log(`Athena and ${helperCount} helper app(s) signed and verified with Developer ID team ${identity.teamId}.`)
    return
  }

  if (notarizationRequested()) {
    throw new Error('Apple notarization credentials are present, but ATHENA_MACOS_SIGN_IDENTITY is not set. Refusing to notarize an ad-hoc or local-development build.')
  }
  const identity = await localSigningIdentity()
  const original = [...run('/usr/bin/security', ['list-keychains', '-d', 'user']).matchAll(/"([^"]+)"/g)].map((match) => match[1])
  try {
    run('/usr/bin/security', ['unlock-keychain', '-p', identity.password, identity.keychain])
    // codesign needs the keychain in its search list. Restore the user's list and lock this keychain afterward.
    run('/usr/bin/security', ['list-keychains', '-d', 'user', '-s', identity.keychain, ...original.filter((path) => path !== identity.keychain)])
    const credentialService = await prepareCredentialService(appPath, identity)
    await signAsync({ app: appPath, platform: 'darwin', identity: identity.fingerprint, keychain: identity.keychain,
      ignore: file => resolve(file) === credentialService || searchDataResource(file, appPath),
      identityValidation: false, preAutoEntitlements: false, preEmbedProvisioningProfile: false,
      optionsForFile: () => ({ hardenedRuntime: false, entitlements: [], timestamp: 'none' }) })
    const helperCount = await verifySigner(appPath, { mode: 'local', ...identity, bundleId })
    console.log(`Athena and ${helperCount} helper app(s) signed and verified with the persistent local certificate.`)
  } finally {
    run('/usr/bin/security', ['list-keychains', '-d', 'user', '-s', ...original])
    run('/usr/bin/security', ['lock-keychain', identity.keychain])
  }
}

export async function sign(options) { return signApp({ app: options.app }) }

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.argv[2]) throw new Error('Pass the existing Athena.app path.')
  await signApp({ app: process.argv[2] })
}
