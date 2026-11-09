import { lstat, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { basename, extname, relative, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { GeneratedArtifact } from '../../../shared/chat'

const MAX_ARTIFACT_BYTES = 100 * 1024 * 1024
const SAFE_KEY = /^[a-f0-9-]{36}\.[a-z0-9]{1,12}$/i
const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

export class ArtifactService {
  constructor(private readonly root: string) {}
  private readonly assetTokens = new Map<string, { storageKey: string; mimeType: string; expiresAt: number }>()
  private async ready() { await mkdir(this.root, { recursive: true, mode: 0o700 }) }
  private path(storageKey: string): string {
    if (!SAFE_KEY.test(storageKey)) throw new Error('Invalid artifact storage key.')
    const path = resolve(this.root, storageKey), rel = relative(this.root, path)
    if (rel.startsWith('..') || rel.includes('/') || rel.includes('\\')) throw new Error('Invalid artifact storage path.')
    return path
  }
  /**
   * Returns a provider workspace that is both inside the currently authorized
   * project and dedicated to generated assets. Providers may be given this
   * path as a suggested output location, but the provider never receives
   * access to Athena's artifact store itself.
   */
  async prepareProviderOutput(workspaceRoot: string, kind = 'images'): Promise<string> {
    const root = resolve(workspaceRoot)
    const canonicalRoot = await realpath(root)
    const output = resolve(canonicalRoot, '.athena', 'outputs', kind)
    await mkdir(output, { recursive: true, mode: 0o700 })
    const canonicalOutput = await realpath(output)
    const rel = relative(canonicalRoot, canonicalOutput)
    if (rel === '..' || rel.startsWith('../') || rel.includes('\\') || rel.startsWith('/')) throw new Error('Provider output workspace escaped the authorized project.')
    return canonicalOutput
  }
  /** Resolve an Athena-managed artifact only after validating its storage key. */
  location(artifact: GeneratedArtifact): string { return this.path(artifact.storageKey) }

  private imageInfo(mimeType: string, bytes: Uint8Array): { width?: number; height?: number } {
    if (!mimeType.startsWith('image/')) return {}
    if (!IMAGE_MIMES.has(mimeType) && mimeType !== 'image/svg+xml') throw new Error('Generated image format is not supported by Athena.')
    if (!bytes.byteLength) throw new Error('Generated image is empty.')
    const view = Buffer.from(bytes)
    const png = view.length >= 24 && view.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    const jpeg = view.length >= 3 && view[0] === 0xff && view[1] === 0xd8 && view[2] === 0xff
    const gif = view.length >= 10 && (view.subarray(0, 6).toString('ascii') === 'GIF87a' || view.subarray(0, 6).toString('ascii') === 'GIF89a')
    const webp = view.length >= 16 && view.subarray(0, 4).toString('ascii') === 'RIFF' && view.subarray(8, 12).toString('ascii') === 'WEBP'
    const svg = mimeType === 'image/svg+xml' && /<svg(?:\s|>)/i.test(view.toString('utf8', 0, Math.min(view.length, 4096)))
    if (!png && !jpeg && !gif && !webp && !svg) throw new Error('Generated image could not be decoded or has an invalid image signature.')
    if (mimeType === 'image/png' && !png || mimeType === 'image/jpeg' && !jpeg || mimeType === 'image/webp' && !webp || mimeType === 'image/gif' && !gif || mimeType === 'image/svg+xml' && !svg) throw new Error('Generated image MIME type does not match its content.')
    if (png) return { width: view.readUInt32BE(16), height: view.readUInt32BE(20) }
    if (gif) return { width: view.readUInt16LE(6), height: view.readUInt16LE(8) }
    if (webp && view.length >= 30 && view.subarray(12, 16).toString('ascii') === 'VP8X') {
      return { width: 1 + view[24] + (view[25] << 8) + (view[26] << 16), height: 1 + view[27] + (view[28] << 8) + (view[29] << 16) }
    }
    return {}
  }
  async store(name: string, mimeType: string, bytes: Uint8Array, metadata?: { provider?: string }): Promise<GeneratedArtifact> {
    if (bytes.byteLength > MAX_ARTIFACT_BYTES) throw new Error('Generated artifact exceeds Athena’s 100 MB limit.')
    const safeName = basename(name).replace(/[\x00-\x1f\\/:*?"<>|]+/g, '_').trim() || 'athena-artifact'
    const extension = extname(safeName).toLowerCase().replace(/[^a-z0-9.]/g, '').slice(0, 12) || '.bin'
    const id = randomUUID(), storageKey = `${id}${extension}`
    const normalizedMime = mimeType.slice(0, 160) || 'application/octet-stream'
    const image = this.imageInfo(normalizedMime, bytes)
    await this.ready(); await writeFile(this.path(storageKey), bytes, { mode: 0o600 })
    return { id, name: safeName, mimeType: normalizedMime, size: bytes.byteLength, createdAt: Date.now(), storageKey, status: 'ready', ...(metadata?.provider ? { provider: metadata.provider.slice(0, 80) } : {}), ...image }
  }
  async read(artifact: GeneratedArtifact): Promise<Buffer> {
    const file = this.path(artifact.storageKey), link = await lstat(file)
    if (link.isSymbolicLink()) throw new Error('Generated artifact is unavailable or invalid.')
    const info = await stat(file)
    if (!info.isFile() || info.size > MAX_ARTIFACT_BYTES) throw new Error('Generated artifact is unavailable or invalid.')
    return readFile(file)
  }
  /** Mint a short-lived, opaque capability for the renderer's app asset origin. */
  async createAssetToken(artifact: GeneratedArtifact, ttlMs = 5 * 60_000): Promise<string> {
    await this.read(artifact)
    const now = Date.now()
    for (const [token, entry] of this.assetTokens) if (entry.expiresAt <= now) this.assetTokens.delete(token)
    const token = randomUUID()
    this.assetTokens.set(token, { storageKey: artifact.storageKey, mimeType: artifact.mimeType, expiresAt: now + Math.max(10_000, Math.min(ttlMs, 15 * 60_000)) })
    while (this.assetTokens.size > 256) this.assetTokens.delete(this.assetTokens.keys().next().value!)
    return token
  }
  async readAssetToken(token: string): Promise<{ bytes: Buffer; mimeType: string } | null> {
    if (!/^[a-f0-9-]{36}$/i.test(token)) return null
    const entry = this.assetTokens.get(token)
    if (!entry || entry.expiresAt <= Date.now()) { this.assetTokens.delete(token); return null }
    try { return { bytes: await this.read({ storageKey: entry.storageKey } as GeneratedArtifact), mimeType: entry.mimeType } }
    catch { this.assetTokens.delete(token); return null }
  }
  async preview(artifact: GeneratedArtifact): Promise<{ preview?: string; text?: string }> {
    const bytes = await this.read(artifact)
    if (IMAGE_MIMES.has(artifact.mimeType)) return bytes.byteLength <= 8 * 1024 * 1024 ? { preview: `data:${artifact.mimeType};base64,${bytes.toString('base64')}` } : {}
    if (artifact.mimeType.startsWith('text/') || /(?:json|javascript|typescript|csv|markdown|xml|yaml)/i.test(artifact.mimeType)) return { text: bytes.toString('utf8').slice(0, 120_000) }
    return {}
  }
}

/** Explicit name for code that handles provider-created files. */
export class GeneratedArtifactManager extends ArtifactService {}
