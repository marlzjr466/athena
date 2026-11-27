// @vitest-environment node
import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rootCertificates } from 'node:tls'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:https'
import { describe, expect, it } from 'vitest'
import { AgentCommands, commandProfile } from '../electron/main/ai/agentCommands'
import { commandCertificateFailure, commandCertificatePaths, installedCertificatePath, publicCertificateBundle } from '../electron/main/ai/commandCertificates'

describe('command certificate access', () => {
  it('recognizes certificate-only public bundles, never keys or mixed payloads', () => {
    const certificate = rootCertificates[0]
    expect(publicCertificateBundle(certificate)).toBe(true)
    expect(publicCertificateBundle('# certificate authority bundle\n' + certificate)).toBe(true)
    for (const text of ['', 'private data', certificate + '\npassword=value', certificate + '\n-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----', '-----BEGIN CERTIFICATE-----\ninvalid\n-----END CERTIFICATE-----', 'x'.repeat(2 * 1024 * 1024 + 1)]) {
      expect(publicCertificateBundle(text)).toBe(false)
    }
  })
  it('does not accept arbitrary PEM paths, traversal or user/project lookalikes', () => {
    for (const path of ['/project/site-packages/certifi/cacert.pem', '/Users/user/certifi/cacert.pem', '/opt/homebrew/private.pem', '/opt/homebrew/etc/../private.pem', '/opt/homebrew-evil/etc/ca-certificates/cert.pem']) expect(installedCertificatePath(path)).toBe(false)
    expect(installedCertificatePath('/opt/homebrew/lib/python3.15/site-packages/pip/_vendor/certifi/cacert.pem')).toBe(true)
    expect(installedCertificatePath('/usr/local/lib/python3.12/site-packages/certifi/cacert.pem')).toBe(true)
  })
  it('distinguishes trust-store access from server verification and unrelated permission errors', () => {
    expect(commandCertificateFailure('ctx.load_verify_locations(certifi.where())\nPermissionError: [Errno 1] Operation not permitted')).toMatchObject({ kind: 'trust_store_access', stage: 'tls_initialization' })
    expect(commandCertificateFailure('SSL: CERTIFICATE_VERIFY_FAILED')).toMatchObject({ kind: 'certificate_verification', stage: 'tls_verification' })
    expect(commandCertificateFailure('PermissionError: database file denied')).toBeUndefined()
    expect(commandCertificateFailure('ECONNREFUSED')).toBeUndefined()
  })
  it('allows DNS and native certificate validation only with network authorization', () => {
    const request = { executable: 'python3', args: [], network: false, install: false, gitWrite: false }
    const offline = commandProfile('/project', '/scratch', request)
    expect(offline).not.toContain('com.apple.trustd')
    expect(offline).not.toContain('com.apple.SystemConfiguration.DNSConfiguration')
    const online = commandProfile('/project', '/scratch', { ...request, network: true })
    expect(online).toContain('com.apple.trustd.agent')
    expect(online).toContain('com.apple.SystemConfiguration.DNSConfiguration')
    expect(online).not.toContain('com.apple.SecurityServer')
    expect(online).toContain('|Keychains|')
    const local = commandProfile('/project', '/scratch', { ...request, loopback: true })
    expect(local).toContain('com.apple.trustd')
    expect(local).not.toContain('(allow network-outbound)')
  })
  it.runIf(process.env.ATHENA_SANDBOX_TEST === '1')('initializes the installed pip trust store without installation or network access', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'athena-pip-certificates-')))
    try {
      const commands = new AgentCommands()
      const probe = await commands.execute(root, { executable: 'python3', args: ['-I', '-B', '-c', 'import pip._vendor.certifi as c,os; p=c.where(); print(p,os.path.realpath(p)); print(len(open(os.path.realpath(p)).read())); print(len(open(p).read()))'], network: false, install: false, gitWrite: false }, AbortSignal.timeout(15000))
      expect(probe.exitCode, probe.output).toBe(0)
      const result = await commands.execute(root, {
        executable: 'python3', args: ['-I', '-B', '-c', 'from pip._internal.cli.index_command import _create_truststore_ssl_context; import ssl; ctx = _create_truststore_ssl_context(); assert ctx is not None and ctx.verify_mode == ssl.CERT_REQUIRED; print("pip TLS initialized with verification required")'],
        network: false, install: false, gitWrite: false,
      }, AbortSignal.timeout(15000))
      expect(result.exitCode, result.output).toBe(0)
      expect(result.output).toContain('pip TLS initialized with verification required')
    } finally { await rm(root, { recursive: true, force: true }) }
  }, 20000)
  it.runIf(process.env.ATHENA_SANDBOX_TEST === '1')('rejects an untrusted TLS server and accepts only an explicitly supplied public CA', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'athena-pip-tls-')))
    const cert = join(root, 'test-ca.crt'), caKey = join(root, 'ca-private.key'), key = join(root, 'server-private.key')
    const csr = join(root, 'server.csr'), leaf = join(root, 'server.crt'), extensions = join(root, 'server-ext.cnf')
    const openssl = (args: string[]) => execFileSync('/usr/bin/openssl', args, { stdio: 'ignore' })
    openssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', caKey, '-out', cert, '-days', '1', '-subj', '/CN=Athena Test CA', '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign'])
    openssl(['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', csr, '-subj', '/CN=localhost'])
    await writeFile(extensions, 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:127.0.0.1\n')
    openssl(['x509', '-req', '-in', csr, '-CA', cert, '-CAkey', caKey, '-CAcreateserial', '-out', leaf, '-days', '1', '-extfile', extensions])
    const server = createServer({ key: await readFile(key), cert: await readFile(leaf) }, (_req, res) => res.end('verified-test-server'))
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    try {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('No server address')
      const url = 'https://127.0.0.1:' + address.port
      const script = 'from pip._internal.cli.index_command import _create_truststore_ssl_context; from pip._internal.network.session import PipSession; import sys,ssl; ctx=_create_truststore_ssl_context(); assert ctx.verify_mode == ssl.CERT_REQUIRED; ' +
        's=PipSession(ssl_context=ctx); print(s.get(sys.argv[1],timeout=5,verify=sys.argv[2] if len(sys.argv)>2 else True).text)'
      const commands = new AgentCommands()
      const request = { executable: 'python3', args: ['-I', '-B', '-c', script, url], network: false, loopback: true, install: false, gitWrite: false }
      const denied = await commands.execute(root, request, AbortSignal.timeout(10000))
      expect(denied.exitCode).not.toBe(0)
      expect(denied.output).toMatch(/certificate verify failed|CERTIFICATE_VERIFY_FAILED|SSLVerificationError/i)
      expect(denied.certificateFailure?.kind).toBe('certificate_verification')
      const trusted = await commands.execute(root, { ...request, args: [...request.args, cert] }, AbortSignal.timeout(10000))
      expect(trusted.exitCode, trusted.output).toBe(0)
      expect(trusted.output).toContain('verified-test-server')
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
      await rm(root, { recursive: true, force: true })
    }
  }, 30000)
  it.runIf(process.env.ATHENA_SANDBOX_TEST === '1')('keeps arbitrary PEMs, symlink escapes, certificate writes and network access denied', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'athena-certificate-boundaries-')))
    try {
      await writeFile(join(root, 'private.pem'), 'private fixture')
      await writeFile(join(root, 'public.pem'), rootCertificates[0])
      await symlink(join(root, 'private.pem'), join(root, 'alias.crt'))
      const commands = new AgentCommands()
      const run = (code: string) => commands.execute(root, { executable: 'python3', args: ['-I', '-B', '-c', code], network: false, install: false, gitWrite: false, filesystemMode: 'full-read-write' }, AbortSignal.timeout(15000))
      for (const file of ['private.pem', 'public.pem', 'alias.crt']) expect((await run('open(' + JSON.stringify(join(root, file)) + ').read()')).exitCode).not.toBe(0)
      const bundle = commandCertificatePaths(commands.executable('python3')).find(path => !path.includes('site-packages'))
      expect(bundle).toBeDefined()
      const before = await readFile(bundle!)
      // O_WRONLY alone does not truncate or write even if a future regression grants it.
      expect((await run('import os; fd=os.open(' + JSON.stringify(bundle) + ',os.O_WRONLY); os.close(fd)')).exitCode).not.toBe(0)
      expect(await readFile(bundle!)).toEqual(before)
      expect((await run('import socket; socket.create_connection(("127.0.0.1",9), timeout=1)')).output).toMatch(/Operation not permitted|Permission denied/)
    } finally { await rm(root, { recursive: true, force: true }) }
  }, 20000)
  it.runIf(process.env.ATHENA_PIP_INDEX_TEST === '1')('reads the public PyPI index with TLS verification enabled and no install', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'athena-pip-index-')))
    try {
      const result = await new AgentCommands().execute(root, {
        executable: 'python3', args: ['-I', '-B', '-m', 'pip', '-vvv', '--disable-pip-version-check', '--no-cache-dir', '--retries', '0', '--timeout', '15', 'index', 'versions', '--index-url', 'https://pypi.org/simple', 'pg8000'],
        network: true, install: false, gitWrite: false,
      }, AbortSignal.timeout(25000))
      expect(result.exitCode, result.output).toBe(0)
      expect(result.output).toContain('Available versions:')
    } finally { await rm(root, { recursive: true, force: true }) }
  }, 30000)
})
