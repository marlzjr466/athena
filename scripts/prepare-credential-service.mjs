import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'

function run(binary, args) {
  const result = spawnSync(binary, args, { encoding: 'utf8' })
  if (result.error || result.status !== 0) throw new Error(`Credential service: ${binary} failed (${result.status}). ${binary.endsWith('clang') ? result.stderr : ''}`)
  return `${result.stdout}\n${result.stderr}`
}

// A standalone executable has its own Keychain partition. Preserve its signed
// bytes across app rebuilds/updates; only a broker source or signer change renews it.
export async function credentialServiceConfiguration(identity, developerId = false) {
  const source = resolve('electron/main/ai/credentialService.m')
  const parent = developerId
    ? `identifier "com.athena.companion" and anchor apple generic and certificate leaf[subject.OU] = "${identity.teamId}"`
    : `identifier "com.athena.companion" and certificate leaf = H"${identity.fingerprint}"`
  const sourceKey = createHash('sha256').update(await readFile(source)).update(parent).update(process.arch).digest('hex')
  return { source, parent, sourceKey }
}
export async function prepareCredentialService(appPath, identity, developerId = false) {
  const { source, parent, sourceKey } = await credentialServiceConfiguration(identity, developerId)
  const directory = resolve('out-dev/.credential-service', sourceKey)
  const binary = join(directory, 'athena-credential-service')
  const requirement = `identifier "com.athena.companion.credentials" and certificate leaf = H"${identity.fingerprint}"`
  let reusable = false
  try {
    run('/usr/bin/codesign', ['--verify', '--strict', '-R', `=${requirement}`, binary])
    reusable = true
  } catch { /* Compile a new broker only if it is absent or invalid. */ }
  if (!reusable) {
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'credential-requirement.h'), `#define ATHENA_PARENT_REQUIREMENT ${JSON.stringify(parent)}\n`)
    run('/usr/bin/clang', ['-O2', '-fobjc-arc', '-Wno-deprecated-declarations', '-mmacosx-version-min=13.0', '-I', directory, '-framework', 'Foundation', '-framework', 'Security', source, '-o', binary])
    run('/usr/bin/codesign', ['--force', '--sign', identity.fingerprint, ...(identity.keychain ? ['--keychain', identity.keychain] : []),
      '--identifier', 'com.athena.companion.credentials', ...(developerId ? ['--options', 'runtime', '--timestamp'] : ['--timestamp=none']), binary])
    run('/usr/bin/codesign', ['--verify', '--strict', '-R', `=${requirement}`, binary])
  }
  const target = join(appPath, 'Contents/Resources/native/athena-credential-service')
  await mkdir(join(appPath, 'Contents/Resources/native'), { recursive: true })
  await copyFile(binary, target)
  await writeFile(join(appPath, 'Contents/Resources/native/credential-service-version'), sourceKey)
  return target
}
