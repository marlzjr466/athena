import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, realpathSync, mkdirSync, readFileSync, renameSync, writeFileSync, rmSync } from 'node:fs'
import { lstat, mkdir, readFile, realpath, writeFile, rename, unlink } from 'node:fs/promises'
import { basename, extname, join, resolve, sep } from 'node:path'
import { z } from 'zod'
import { avatarRecordSchema, importedAvatarId, validateModelName, type ImportedAvatar, type ModelPick } from '../../shared/avatarModels'

export const MAX_VRM_BYTES = 150 * 1024 * 1024
/** Inspect the GLB envelope before allowing its content into a renderer. Imported
 * assets must be self-contained: never fetch arbitrary URLs or local paths. */
export function validateVrmBytes(bytes: Uint8Array): string {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (b.length < 24 || b.length > MAX_VRM_BYTES || b.readUInt32LE(0) !== 0x46546c67 || b.readUInt32LE(4) !== 2 || b.readUInt32LE(8) !== b.length) throw new Error('Invalid VRM/GLB file or file exceeds 150 MB.')
  const length = b.readUInt32LE(12)
  if (b.readUInt32LE(16) !== 0x4e4f534a || length > 8 * 1024 * 1024 || 20 + length > b.length) throw new Error('Invalid VRM metadata chunk.')
  const json = JSON.parse(b.subarray(20, 20 + length).toString('utf8'))
  const vrm1 = json.extensions?.VRMC_vrm, vrm0 = json.extensions?.VRM
  if (!vrm1 && !vrm0) throw new Error('This GLB does not contain VRM data.')
  if (vrm1 && vrm1.specVersion !== '1.0') throw new Error('Only VRM 0.x and VRM 1.0 are supported.')
  if (vrm0 && !String(vrm0.specVersion ?? '0.0').startsWith('0.')) throw new Error('Unsupported VRM version.')
  const bones = vrm1 ? Object.entries(vrm1.humanoid?.humanBones ?? {}).map(([bone, data]) => ({ bone, ...(data as object) })) : vrm0.humanoid?.humanBones
  if (!Array.isArray(json.nodes) || !json.meshes?.length || !json.skins?.length || !Array.isArray(bones)) throw new Error('The model is missing its humanoid skeleton or skinned geometry.')
  for (const required of ['hips', 'spine', 'head', 'leftUpperArm', 'rightUpperArm', 'leftUpperLeg', 'rightUpperLeg']) {
    const bone = bones.find((entry: { bone: string }) => entry.bone === required)
    if (!bone || !Number.isInteger(bone.node) || !json.nodes[bone.node]) throw new Error(`Missing humanoid bone: ${required}.`)
  }
  for (const item of [...(json.buffers ?? []), ...(json.images ?? [])]) {
    if (item.uri && !/^data:(image\/(png|jpeg|webp)|application\/octet-stream);base64,/i.test(item.uri)) throw new Error('Import a self-contained VRM with embedded textures and buffers. External asset URLs are not allowed.')
  }
  return vrm1 ? '1.0' : String(vrm0.specVersion ?? '0.0')
}

export class AvatarModelRepository {
  private records: ImportedAvatar[] = []
  private picks = new Map<string, { path: string; expires: number }>()
  private file: string
  readonly loadError?: string
  constructor(private root: string, private changed: () => void = () => {}) {
    this.file = join(root, 'registry.json')
    try { if (existsSync(this.file)) {
      // A corrupt registry is not silently replaced, which could orphan models.
      this.records = z.array(avatarRecordSchema).max(100).parse(JSON.parse(readFileSync(this.file, 'utf8')))
      const ids = new Set<string>()
      for (const model of this.records) {
        if (ids.has(model.id)) throw new Error('Duplicate imported avatar ID in registry.')
        ids.add(model.id)
        model.modelPath = join(model.id, 'model.vrm')
        model.thumbnailPath = model.thumbnailPath ? join(model.id, 'thumbnail.png') : undefined
        if (model.importStatus === 'processing' || !existsSync(join(root, model.modelPath))) {
          model.importStatus = 'error'; model.importError = 'Import interrupted or model file missing. Retry integration; re-import if the source file is missing.'
        }
        if (model.thumbnailPath && existsSync(join(root, model.thumbnailPath))) {
          const path = join(root, model.thumbnailPath)
          if (lstatSync(path).isFile() && lstatSync(path).size < 2_250_000 && realpathSync(path) === resolve(realpathSync(root), model.id, 'thumbnail.png')) model.thumbnail = `data:image/png;base64,${readFileSync(path).toString('base64')}`
        }
      }
    } } catch { this.records = []; this.loadError = 'The imported model registry could not be read. Existing files were preserved. Restore registry.json from backup before importing more models.' }
  }
  list(): ImportedAvatar[] { return this.records.map(model => ({ ...model })) }
  get(id: string): ImportedAvatar { if (this.loadError) throw new Error(this.loadError); const record = this.records.find(model => model.id === importedAvatarId.parse(id)); if (!record) throw new Error('Imported model not found.'); return record }
  private save(): void {
    mkdirSync(this.root, { recursive: true, mode: 0o700 })
    if (this.loadError) throw new Error(this.loadError)
    const temporary = `${this.file}.${randomUUID()}.tmp`
    writeFileSync(temporary, JSON.stringify(this.records.map(({ thumbnail: _thumbnail, ...record }) => record)), { mode: 0o600, flag: 'wx' })
    renameSync(temporary, this.file)
    this.changed()
  }
  pick(path: string): ModelPick {
    if (this.loadError) throw new Error(this.loadError)
    if (extname(path).toLowerCase() !== '.vrm') throw new Error('Choose a .vrm file. Other model formats are not supported yet.')
    // Only native file-picker results enter this capability map, never IPC paths.
    for (const [key, pick] of this.picks) if (pick.expires < Date.now()) this.picks.delete(key)
    if (this.picks.size >= 20) this.picks.clear()
    const token = randomUUID(); this.picks.set(token, { path, expires: Date.now() + 30 * 60_000 })
    const fileName = basename(path)
    return { token, fileName, suggestedName: fileName.slice(0, -4).slice(0, 60) }
  }
  async import(token: string, inputName: string): Promise<ImportedAvatar> {
    if (this.loadError) throw new Error(this.loadError)
    const name = validateModelName(inputName, this.records)
    const pick = this.picks.get(token)
    if (!pick || pick.expires < Date.now()) throw new Error('File selection expired. Choose the VRM file again.')
    if (this.records.length >= 100) throw new Error('The local model limit (100) has been reached.')
    this.picks.delete(token)
    const id = `imported-${randomUUID()}`
    const model: ImportedAvatar = { id, name, sourceFileName: basename(pick.path), modelPath: join(id, 'model.vrm'), importStatus: 'processing', stage: 'Importing VRM file', compatibleAnimations: [], enabledActions: [], animationSettings: { random: true, idleMs: 3000 }, scale: 1, configuration: {} }
    this.records.push(model); this.save()
    try {
      const info = await lstat(pick.path)
      if (!info.isFile() || info.size > MAX_VRM_BYTES) throw new Error('Choose a regular VRM file no larger than 150 MB.')
      const bytes = await readFile(pick.path)
      this.update(id, { stage: 'Validating model' })
      const version = validateVrmBytes(bytes)
      const directory = join(this.root, id)
      await mkdir(directory, { mode: 0o700 })
      await writeFile(join(directory, 'model.vrm.tmp'), bytes, { mode: 0o600, flag: 'wx' })
      await rename(join(directory, 'model.vrm.tmp'), join(directory, 'model.vrm'))
      return this.update(id, { configuration: { version }, stage: 'Loading geometry and textures' })
    } catch (error) {
      await unlink(join(this.root, id, 'model.vrm.tmp')).catch(() => {})
      this.update(id, { importStatus: 'error', importError: error instanceof Error ? error.message : 'Could not import VRM.' })
      return this.get(id)
    }
  }
  update(id: string, patch: Partial<ImportedAvatar>): ImportedAvatar {
    const current = this.get(id)
    const next = avatarRecordSchema.parse({ ...current, ...patch, id: current.id, modelPath: current.modelPath })
    this.records[this.records.indexOf(current)] = next; this.save(); return next
  }
  rename(id: string, name: string) { return this.update(id, { name: validateModelName(name, this.records, id) }) }
  delete(id: string): void {
    const model = this.get(id)
    if (model.importStatus === 'processing') throw new Error('Wait for this import to finish before deleting it.')
    const directory = join(this.root, model.id)
    const present = existsSync(directory)
    if (present && (lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory() || realpathSync(directory) !== resolve(realpathSync(this.root), model.id))) throw new Error('Model storage directory is not authorized.')
    const staged = join(this.root, `.deleted-${model.id}-${randomUUID()}`)
    const previous = this.records
    if (present) renameSync(directory, staged)
    try {
      this.records = previous.filter(record => record.id !== model.id)
      this.save()
      if (present) rmSync(staged, { recursive: true })
    } catch (error) {
      if (present && existsSync(staged)) renameSync(staged, directory)
      this.records = previous
      this.save()
      throw error
    }
  }
  interrupt(): void {
    for (const model of this.records.filter(m => m.importStatus === 'processing')) this.update(model.id, { importStatus: 'error', importError: 'The import window reloaded before integration completed. Retry to continue using the saved model and name.' })
  }
  async replaceFailedSource(id: string, path: string): Promise<ImportedAvatar> {
    const model = this.get(id)
    if (model.importStatus !== 'error') throw new Error('Only failed imports can be retried.')
    if (extname(path).toLowerCase() !== '.vrm') throw new Error('Choose a .vrm file.')
    const info = await lstat(path)
    if (!info.isFile() || info.size > MAX_VRM_BYTES) throw new Error('Choose a regular VRM file no larger than 150 MB.')
    const bytes = await readFile(path), version = validateVrmBytes(bytes)
    const directory = join(this.root, id)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    if (await realpath(directory) !== resolve(await realpath(this.root), id)) throw new Error('Model storage directory is not authorized.')
    const target = join(directory, 'model.vrm'), temporary = `${target}.${randomUUID()}.tmp`
    try { await writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' }); await rename(temporary, target) }
    finally { await unlink(temporary).catch(() => {}) }
    return this.update(id, { sourceFileName: basename(path), configuration: { version }, importStatus: 'processing', stage: 'Loading geometry and textures', importError: undefined })
  }
  async read(id: string): Promise<Uint8Array> {
    this.get(id)
    const path = join(this.root, id, 'model.vrm')
    const canonical = await realpath(path), root = await realpath(this.root)
    if (canonical !== resolve(root, id, 'model.vrm') || !canonical.startsWith(root + sep) || !(await lstat(path)).isFile()) throw new Error('Model asset escapes its authorized storage directory.')
    const info = await lstat(canonical)
    if (info.size > MAX_VRM_BYTES) throw new Error('Model file exceeds 150 MB.')
    const bytes = await readFile(canonical)
    validateVrmBytes(bytes)
    return bytes
  }
  async saveThumbnail(id: string, thumbnail: string) {
    if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(thumbnail) || thumbnail.length > 3_000_000) throw new Error('Invalid thumbnail.')
    const bytes = Buffer.from(thumbnail.split(',')[1], 'base64')
    if (bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('Thumbnail is not a PNG.')
    await this.read(id) // Revalidate storage boundary before writing beside the asset.
    const path = join(this.root, id, 'thumbnail.png')
    const temporary = `${path}.${randomUUID()}.tmp`
    try { await writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' }); await rename(temporary, path) }
    finally { await unlink(temporary).catch(() => {}) }
    return this.update(id, { thumbnailPath: join(id, 'thumbnail.png'), thumbnail, thumbnailVersion: 2 })
  }
  async finish(id: string, thumbnail: string, clips: ImportedAvatar['compatibleAnimations'], scale: number) {
    if (this.get(id).importStatus !== 'processing') throw new Error('This model is not processing.')
    if (!clips.some(clip => clip.id === 'idle' && clip.duration)) throw new Error('A compatible Idle animation is required before activation.')
    await this.saveThumbnail(id, thumbnail)
    return this.update(id, { importStatus: 'ready', stage: 'Ready to use', compatibleAnimations: clips, enabledActions: clips.filter(c => c.duration && c.id !== 'idle').map(c => c.id), scale, importError: undefined })
  }
}
