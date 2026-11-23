import { spawn } from 'node:child_process'
import { join } from 'node:path'

type Request = { operation: 'read' | 'write' | 'delete'; service: string; account: string; value?: string }
type Transport = (request: Request) => Promise<string | null>

const nativeTransport: Transport = request => new Promise((resolve, reject) => {
  if (process.platform !== 'darwin' || process.type !== 'browser') {
    reject(new Error('Credential access requires the signed Athena main process.')); return
  }
  const child = spawn(join(process.resourcesPath, 'native', 'athena-credential-service'), [], { stdio: ['pipe', 'pipe', 'pipe'], env: {} })
  let output = '', size = 0
  const fail = () => reject(new Error('macOS Keychain access is unavailable. Allow Athena Credential Service in the macOS dialog, then restart Athena. No credential was changed.'))
  child.on('error', fail)
  child.stdin.on('error', fail)
  child.stderr.resume() // Never forward native error output or credential data to logs.
  child.stdout.on('data', chunk => {
    size += chunk.length
    if (size > 4 * 1024 * 1024) { child.kill(); fail(); return }
    output += chunk.toString('utf8')
  })
  child.on('close', code => {
    try {
      const response = JSON.parse(output)
      if (code !== 0 || response.ok !== true) { fail(); return }
      if (request.operation === 'read' && response.value !== null && typeof response.value !== 'string') { fail(); return }
      resolve(response.value ?? null)
    } catch { fail() }
  })
  child.stdin.end(JSON.stringify(request))
})

/** Process-local caching coalesces startup reads and preserves authorization errors. */
export class SecureCredentialEntries {
  private reads = new Map<string, Promise<string | null>>()
  constructor(private transport: Transport = nativeTransport) {}
  entry(service: string, account: string) {
    const key = JSON.stringify([service, account])
    return {
      getPassword: () => {
        let pending = this.reads.get(key)
        if (!pending) { pending = this.transport({ operation: 'read', service, account }); this.reads.set(key, pending) }
        return pending
      },
      setPassword: async (value: string) => {
        await this.transport({ operation: 'write', service, account, value })
        this.reads.set(key, Promise.resolve(value))
      },
      deleteCredential: async () => {
        await this.transport({ operation: 'delete', service, account })
        this.reads.set(key, Promise.resolve(null))
      },
    }
  }
}
const credentials = new SecureCredentialEntries()
export const credentialEntry = (service: string, account: string) => credentials.entry(service, account)
