import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { verifiedModelCapabilities } from '../shared/modelCapabilities'
import { ArtifactService } from '../electron/main/ai/artifactService'
import { createArtifactTools } from '../electron/main/ai/artifactTools'
import JSZip from 'jszip'

describe('multimodal capability and artifact paths', () => {
  it('verifies Grok vision only through Cursor ACP', () => {
    expect(verifiedModelCapabilities('cursor-grok-4.6-medium', 'cursor-acp').capabilities.has('image-input')).toBe(true)
    expect(verifiedModelCapabilities('cursor-grok-4.7-high', 'cursor-acp').capabilities.has('image-input')).toBe(true)
    expect(verifiedModelCapabilities('cursor-grok-4.6-medium', 'openai-responses').capabilities.has('image-input')).toBe(false)
  })
  it('stores generated artifacts outside chat history and creates a valid PDF', async () => {
    const root = await mkdtemp(join(tmpdir(), 'athena-artifacts-'))
    const service = new ArtifactService(root)
    const tools = createArtifactTools(service, () => true)
    const result = JSON.parse(await tools.execute('create_artifact', { name: 'report.pdf', mimeType: 'application/pdf', content: 'Athena report' }, new AbortController().signal)) as { artifact?: { storageKey: string; size: number } }
    expect(result.artifact?.storageKey).toMatch(/\.pdf$/)
    expect(result.artifact?.size).toBeGreaterThan(100)
    const bytes = await readFile(join(root, result.artifact!.storageKey))
    expect(bytes.subarray(0, 8).toString()).toBe('%PDF-1.4')
  })
  it('creates a project-scoped provider output directory and keeps it inside the grant', async () => {
    const root = await mkdtemp(join(tmpdir(), 'athena-provider-workspace-'))
    const service = new ArtifactService(await mkdtemp(join(tmpdir(), 'athena-artifacts-')))
    const output = await service.prepareProviderOutput(root, 'images')
    expect(output.startsWith(join(await realpath(root), '.athena', 'outputs', 'images'))).toBe(true)
    expect(output).toContain('.athena/outputs/images')
  })
  it('validates image bytes before exposing a ready artifact and records dimensions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'athena-image-artifacts-'))
    const service = new ArtifactService(root)
    const oneByOnePng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
    const artifact = await service.store('generated.png', 'image/png', oneByOnePng)
    expect(artifact.status).toBe('ready')
    expect(artifact.width).toBe(1)
    expect(artifact.height).toBe(1)
    await expect(service.store('bad.png', 'image/png', Buffer.from('not an image'))).rejects.toThrow(/could not be decoded/i)
  })
  it('mints an opaque, expiring renderer capability without exposing the storage path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'athena-image-capability-'))
    const service = new ArtifactService(root)
    const artifact = await service.store('generated.png', 'image/png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'))
    const token = await service.createAssetToken(artifact)
    expect(token).toMatch(/^[a-f0-9-]{36}$/i)
    expect(token).not.toContain(artifact.storageKey)
    const resolved = await service.readAssetToken(token)
    expect(resolved?.mimeType).toBe('image/png')
    expect(resolved?.bytes.byteLength).toBeGreaterThan(0)
  })
  it('creates structured DOCX and XLSX packages instead of renaming text', async () => {
    const root = await mkdtemp(join(tmpdir(), 'athena-office-'))
    const service = new ArtifactService(root), tools = createArtifactTools(service, () => true)
    for (const [name, mime, entry] of [
      ['notes.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'word/document.xml'],
      ['tracker.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'xl/worksheets/sheet1.xml'],
    ] as const) {
      const result = JSON.parse(await tools.execute('create_artifact', { name, mimeType: mime, content: 'Athena\nitem' }, new AbortController().signal)) as { artifact: { storageKey: string } }
      const bytes = await readFile(join(root, result.artifact.storageKey))
      expect(await JSZip.loadAsync(bytes).then((zip) => zip.file(entry))).not.toBeNull()
    }
  })
})
