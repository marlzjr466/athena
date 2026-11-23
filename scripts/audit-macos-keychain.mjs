// Metadata only: never pass -g, -w, -d, or -r to security.
import { spawnSync } from 'node:child_process'
import { readdirSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'

const app = resolve(process.argv[2] ?? 'release/mac-arm64/Athena.app')
function command(binary, args) {
  const result = spawnSync(binary, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() }
}
const frameworks = join(app, 'Contents/Frameworks')
const bundles = [app, ...readdirSync(frameworks).filter(name => name.endsWith('.app')).map(name => join(frameworks, name))]
const signatures = bundles.map(bundle => ({ bundle,
  details: command('/usr/bin/codesign', ['-dv', '--verbose=4', bundle]),
  requirement: command('/usr/bin/codesign', ['-dr', '-', bundle]),
  validation: command('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', bundle]),
}))
const broker = join(app, 'Contents/Resources/native/athena-credential-service')
if (existsSync(broker)) signatures.push({ bundle: broker, details: command('/usr/bin/codesign', ['-dv', '--verbose=4', broker]), requirement: command('/usr/bin/codesign', ['-dr', '-', broker]), validation: command('/usr/bin/codesign', ['--verify', '--strict', broker]) })
// An unsigned/unrelated parent must be rejected before any Keychain lookup.
const callerProbe = existsSync(broker) ? spawnSync(broker, [], { input: '{}', encoding: 'utf8' }) : null
const callerIsolation = callerProbe ? { exit: callerProbe.status, rejected: callerProbe.status === 1 && callerProbe.stdout.includes('"status":-25293') } : null
const keychains = [...command('/usr/bin/security', ['list-keychains', '-d', 'user']).output.matchAll(/"([^"]+)"/g)].map(match => match[1])
const items = []
for (const keychain of keychains) {
  const dump = command('/usr/bin/security', ['dump-keychain', '-a', keychain])
  if (dump.status !== 0) { items.push({ keychain, error: 'Metadata inspection failed', status: dump.status }); continue }
  for (const record of dump.output.split(/(?=^keychain:)/m)) {
    const service = record.match(/"svce"<blob>="([^"]+)"/)?.[1]
    if (!service?.startsWith('com.athena.companion.')) continue
    const account = record.match(/"acct"<blob>="([^"]+)"/)?.[1]
    const created = record.match(/^.*"cdat".*$/m)?.[0]?.trim()
    const modified = record.match(/^.*"mdat".*$/m)?.[0]?.trim()
    const aclStart = record.indexOf('access:')
    items.push({ keychain, service, account, created, modified, access: aclStart >= 0 ? record.slice(aclStart).trim() : 'No access metadata returned' })
  }
}
if (process.argv[3]) {
  const output = resolve(process.argv[3]); mkdirSync(dirname(output), { recursive: true })
  writeFileSync(output, JSON.stringify({ signatures, items, callerIsolation }, null, 2), { mode: 0o600 })
}
console.log(JSON.stringify({ callerIsolation, signatures: signatures.map(s => ({ bundle: s.bundle, valid: s.validation.status === 0,
  identifier: s.details.output.match(/^Identifier=(.+)$/m)?.[1], signer: s.details.output.match(/^Authority=(.+)$/m)?.[1],
  hash: s.details.output.match(/^CDHash=(.+)$/m)?.[1], requirement: s.requirement.output.match(/^designated => (.+)$/m)?.[1],
})), items: items.map(i => ({ service: i.service, account: i.account, created: i.created, modified: i.modified,
  trusted: i.access?.split('\n').filter(line => /requirement:|: .*\(OK\)/.test(line)),
  partitions: i.access?.match(/authorizations \(1\): partition_id[\s\S]*?description: (.*)/)?.[1],
})) }, null, 2))
