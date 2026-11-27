import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** An ephemeral local service with separate provisioning, sign-in and private API endpoints. */
export async function provisioningWorkspace() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'athena-provision-')))
  const root = join(directory, 'project'), profile = join(directory, 'profile')
  await mkdir(root); await mkdir(profile)
  const credential = randomUUID(), session = randomUUID()
  const counts = { creates: 0, attempts: 0, logins: 0, verified: 0 }
  const server = createServer((req, res) => {
    const authorized = req.headers.authorization === 'Bearer ' + credential
    if (req.url === '/users' && req.method === 'POST' && authorized) {
      counts.attempts++
      if (!counts.creates) { counts.creates++; res.writeHead(201); res.end(); return }
      res.writeHead(409)
    } else if (req.url === '/login' && req.method === 'POST' && authorized && counts.creates) {
      counts.logins++; res.end(session); return
    } else if (req.url === '/private' && req.method === 'GET' && req.headers.authorization === 'Bearer ' + session) {
      counts.verified++; res.end('verified'); return
    } else res.writeHead(403)
    res.end()
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (!address || typeof address === 'string') throw Error('No loopback port')
  const source = { file: 'provision-credentials.json', names: ['E2E_BACKEND_ADMIN_TOKEN'] }
  await writeFile(join(root, source.file), JSON.stringify({ [source.names[0]]: credential }), { mode: 0o600 })
  await writeFile(join(root, 'provision.py'), `import http.client, os, sys
token = os.environ.get("E2E_BACKEND_ADMIN_TOKEN")
if not token:
    sys.stderr.write("Missing secure input: E2E_BACKEND_ADMIN_TOKEN\\n")
    sys.exit(2)
def request(method, path, auth, expected):
    conn = http.client.HTTPConnection("127.0.0.1", ${address.port}, timeout=5)
    conn.request(method, path, headers={"Authorization":"Bearer " + auth})
    response = conn.getresponse()
    if response.status != expected: sys.exit(3)
    data = response.read().decode()
    conn.close()
    return data
if sys.argv[1] == "create":
    request("POST", "/users", token, 201)
elif sys.argv[1] == "verify":
    session = request("POST", "/login", token, 200)
    assert request("GET", "/private", session, 200) == "verified"
else: sys.exit(4)
`)
  const command = (step: 'create' | 'verify') => ({ executable: 'python3', args: ['-B', 'provision.py', step], network: false, local_network: true, workspace_write: false, install_dependencies: false, credential_environment: source })
  return { root, profile, counts, credential, source, command, close: async () => {
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(directory, { recursive: true, force: true })
  } }
}
