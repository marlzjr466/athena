import { mkdir, writeFile, readFile, rm, access } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'

if (process.platform !== 'darwin') throw new Error('Local macOS signing requires macOS.')
process.umask(0o077)
const directory = join(homedir(), 'Library/Application Support/AthenaBuild/signing')
const keychain = join(directory, 'athena-build.keychain-db')
await mkdir(directory, { recursive: true, mode: 0o700 })
if (await access(keychain).then(() => true, () => false)) {
  await readFile(join(directory, 'identity.json'))
  console.log('Existing Athena signing identity preserved.')
  process.exit(0)
}
function run(binary, args) {
  const result = spawnSync(binary, args, { encoding: 'utf8' })
  if (result.error || result.status !== 0) throw new Error(`${binary} failed (exit ${result.status}); signing setup stopped.`)
  return result.stdout
}
const password = randomBytes(32).toString('hex'), passwordFile = join(directory, 'keychain-password')
const config = join(directory, 'certificate.cnf'), key = join(directory, 'private.pem'), certificate = join(directory, 'certificate.pem'), p12 = join(directory, 'identity.p12')
await writeFile(passwordFile, password, { mode: 0o600, flag: 'wx' })
await writeFile(config, '[req]\ndistinguished_name=dn\nx509_extensions=code\nprompt=no\n[dn]\nCN=Athena Local Development\n[code]\nbasicConstraints=critical,CA:false\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=critical,codeSigning\n', { mode: 0o600 })
const original = [...run('/usr/bin/security', ['list-keychains', '-d', 'user']).matchAll(/"([^"]+)"/g)].map(match => match[1])
try {
  run('/usr/bin/openssl', ['req', '-new', '-x509', '-newkey', 'rsa:3072', '-sha256', '-days', '3650', '-nodes', '-config', config, '-keyout', key, '-out', certificate])
  run('/usr/bin/openssl', ['pkcs12', '-export', '-inkey', key, '-in', certificate, '-out', p12, '-passout', `file:${passwordFile}`])
  run('/usr/bin/security', ['create-keychain', '-p', password, keychain])
  run('/usr/bin/security', ['unlock-keychain', '-p', password, keychain])
  run('/usr/bin/security', ['import', p12, '-k', keychain, '-P', password, '-T', '/usr/bin/codesign'])
  run('/usr/bin/security', ['set-key-partition-list', '-S', 'apple-tool:,apple:', '-s', '-k', password, keychain])
  const fingerprint = run('/usr/bin/openssl', ['x509', '-in', certificate, '-noout', '-fingerprint', '-sha1']).trim().split('=').at(-1).replaceAll(':', '')
  await writeFile(join(directory, 'identity.json'), JSON.stringify({ fingerprint, keychain }), { mode: 0o600, flag: 'wx' })
  console.log('Persistent local Athena signing identity created. No certificate trust or OS privacy grants were changed.')
} finally {
  run('/usr/bin/security', ['list-keychains', '-d', 'user', '-s', ...original])
  await Promise.all([key, p12, config].map(path => rm(path, { force: true })))
}
