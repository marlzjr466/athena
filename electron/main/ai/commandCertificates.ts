import { spawnSync } from 'node:child_process'
import { X509Certificate } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readlinkSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, normalize, resolve } from 'node:path'

const systemBundles = ['/etc/ssl/cert.pem', '/private/etc/ssl/cert.pem', '/opt/homebrew/etc/ca-certificates/cert.pem', '/usr/local/etc/ca-certificates/cert.pem']
const runtimeRoots = ['/System/', '/usr/', '/opt/homebrew/', '/Library/Developer/CommandLineTools/', '/Applications/Xcode.app/Contents/Developer/']
const discovery = new Map<string, { identity: string; paths: string[] }>()

/** No project, user-configured CA or arbitrary PEM path becomes an implicit grant. */
export function installedCertificatePath(path: string): boolean {
  if (!isAbsolute(path) || normalize(path) !== path || path.includes('\0')) return false
  return systemBundles.includes(path) || runtimeRoots.some(root => path.startsWith(root)) && (
    /\/site-packages\/(?:pip\/_vendor\/)?certifi\/cacert\.pem$/.test(path)
    || /\/etc\/(?:openssl(?:@[\d.]+)?|ca-certificates)\/cert\.pem$/.test(path)
  )
}

/** PEM is a container format, not proof of a private key. Accept certificates
 * only: reject keys, arbitrary trailing data, malformed and oversized bundles. */
export function publicCertificateBundle(text: string): boolean {
  if (Buffer.byteLength(text) > 2 * 1024 * 1024) return false
  const clean = text.replace(/^\s*#[^\r\n]*/gm, '')
  const certificates = clean.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g)
  if (!certificates?.length || certificates.length > 1000 || clean.replace(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g, '').trim()) return false
  try { for (const certificate of certificates) new X509Certificate(certificate); return true } catch { return false }
}

function pythonBundles(executable: string): string[] {
  try {
    if (!runtimeRoots.some(root => executable.startsWith(root))) return []
    const info = statSync(executable), identity = [info.dev, info.ino, info.mtimeMs].join(':')
    const cached = discovery.get(executable)
    if (cached?.identity === identity) return cached.paths
    // Standard-library-only metadata query: no project imports, sitecustomize,
    // inherited Python environment, package execution, network or shell.
    const result = spawnSync(executable, ['-I', '-S', '-B', '-c', 'import json,sysconfig,ssl; p=sysconfig.get_paths(); print(json.dumps([p.get("purelib"),p.get("platlib"),ssl.get_default_verify_paths().cafile]))'], {
      cwd: '/', env: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' }, encoding: 'utf8', timeout: 3000, maxBuffer: 16000,
    })
    if (result.status !== 0) return []
    const values: unknown = JSON.parse(result.stdout)
    if (!Array.isArray(values) || values.length !== 3) return []
    const paths = values.slice(0, 2).flatMap(value => typeof value === 'string' ? [join(value, 'pip/_vendor/certifi/cacert.pem'), join(value, 'certifi/cacert.pem')] : [])
    if (typeof values[2] === 'string') paths.push(values[2])
    discovery.set(executable, { identity, paths })
    return paths
  } catch { return [] }
}

/** Revalidate content and canonical targets for every command, even when the
 * interpreter's installation paths were cached. Returned grants are exact reads. */
export function commandCertificatePaths(pythonExecutable?: string): string[] {
  const paths = new Set<string>()
  const verified = new Map<string, boolean>()
  for (const candidate of [...systemBundles, ...(pythonExecutable ? pythonBundles(pythonExecutable) : [])]) {
    let fd: number | undefined
    try {
      if (!installedCertificatePath(candidate)) continue
      // Homebrew chains cacert.pem through its Cellar before the shared bundle.
      // Seatbelt checks each symlink read as well as the final canonical file.
      const aliases = new Set<string>([candidate])
      let canonical = candidate
      for (let hop = 0; hop < 16; hop++) {
        canonical = join(realpathSync(dirname(canonical)), basename(canonical))
        if (!installedCertificatePath(canonical) || aliases.has(canonical) && hop > 0) throw new Error('Unverified certificate path')
        aliases.add(canonical)
        if (!lstatSync(canonical).isSymbolicLink()) break
        canonical = resolve(dirname(canonical), readlinkSync(canonical))
        if (hop === 15) throw new Error('Certificate symlink cycle')
      }
      if (!verified.has(canonical)) {
        fd = openSync(canonical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
        const info = fstatSync(fd)
        verified.set(canonical, info.isFile() && info.size <= 2 * 1024 * 1024 && publicCertificateBundle(readFileSync(fd, 'utf8')))
      }
      if (!verified.get(canonical)) continue
      for (const alias of aliases) paths.add(alias)
    } catch { /* A missing, inaccessible or unverified bundle stays denied. */ }
    finally { if (fd !== undefined) closeSync(fd) }
  }
  return [...paths]
}

export function commandCertificateFailure(output: string) {
  if (/load_verify_locations|load_default_certs|cafile|CA (?:certificate|bundle)|cacert\.pem/i.test(output)
    && /PermissionError|EPERM|EACCES|Operation not permitted|Permission denied/i.test(output)) {
    return {
      kind: 'trust_store_access' as const, stage: 'tls_initialization' as const,
      message: 'The command could not read its TLS trust store. This is local certificate initialization, not evidence of a database connection failure.',
      recovery: 'Athena grants read-only access to validated installed public CA bundles. If this persists, inspect the exact runtime certificate path and sandbox/OS denial. Broader filesystem access does not override protected-file rules. Do not disable TLS verification, change file permissions, or suggest read_paths for arbitrary PEM files. Dependency installation and live database access keep their separate approval requirements.',
    }
  }
  if (/CERTIFICATE_VERIFY_FAILED|certificate verify failed|SSL certificate problem|SSLVerificationError|ssl-verification-failed/i.test(output)) return {
    kind: 'certificate_verification' as const, stage: 'tls_verification' as const,
    message: 'TLS certificate verification failed. Reading the trust store is distinct from trusting the remote certificate.',
    recovery: 'Inspect the server certificate chain and approved trust configuration. Do not disable certificate verification or broaden filesystem access.',
  }
  return undefined
}
