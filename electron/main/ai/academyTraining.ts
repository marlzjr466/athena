import { createHash, randomUUID } from 'node:crypto'
import { spawn, execFile } from 'node:child_process'
import { homedir, totalmem } from 'node:os'
import { basename, join, sep } from 'node:path'
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statfsSync, statSync, writeFileSync } from 'node:fs'
import { promisify } from 'node:util'
import type { LocalModel } from '../../../shared/localAI'
import { mlxFamilyCandidate, type EvaluationComparison, type EvaluationExample, type EvaluationTrack, type EvaluationVariant, type TrainingJob, type TrainingProfile, type TrainingProgress, type TrainingRuntime, type TrainingSnapshot } from '../../../shared/academyTraining'
import { CodingPracticeRunner } from './codingPractice'
import { evaluationTracks, refreshComparison, scoreReference } from './academyBenchmarks'
import { defaultTrainingSettings, trainingSettingsSchema, type TrainingSettings } from '../../../shared/academyTraining'
import JSZip from 'jszip'
import type { MLXInference } from './mlxInference'
import type { MLXActivationSource } from '../../../shared/mlxInference'
import { parseDataset, checkDatasetOverlap, datasetHash } from './academyDatasets'
import type { DatasetMode, DatasetSplit, DatasetSelection, DatasetProvenance } from '../../../shared/academyTraining'

const exec = promisify(execFile)
const runtimePython = join(homedir(), '.athena', 'models', 'training', 'runtime', 'bin', 'python3')
const fallbackTypes = new Set(['qwen2', 'qwen3', 'llama', 'mistral', 'mixtral', 'gemma', 'gemma2', 'phi', 'phi3', 'olmo', 'minicpm', 'internlm2'])
interface Store { version: 1; profiles: TrainingProfile[]; jobs: TrainingJob[]; comparisons?: EvaluationComparison[] }
const emptyStore = (): Store => ({ version: 1, profiles: [], jobs: [], comparisons: [] })
const pythonProbe = 'import json, platform, importlib.metadata as m, pkgutil; import mlx.core as mx; import mlx_lm.models as models; print(json.dumps({"python":platform.python_version(),"mlx":m.version("mlx"),"mlx_lm":m.version("mlx-lm"),"metal":mx.metal.is_available(),"architectures":[x.name for x in pkgutil.iter_modules(models.__path__)]}))'
const downloadScript = `import sys, json, shutil
from huggingface_hub import HfApi, snapshot_download
repo, target = sys.argv[1], sys.argv[2]
info = HfApi().model_info(repo_id=repo, files_metadata=True, token=False)
weight_bytes = sum((item.size or 0) for item in info.siblings if item.rfilename.endswith('.safetensors'))
if not weight_bytes: raise RuntimeError('ATHENA_SOURCE_SIZE_UNKNOWN')
if weight_bytes > 12 * 1024**3: raise RuntimeError('ATHENA_SOURCE_TOO_LARGE')
if shutil.disk_usage(target).free < weight_bytes * 1.25 + 2 * 1024**3: raise RuntimeError('ATHENA_SOURCE_DISK_LOW')
print(json.dumps({'stage':'downloading','bytes':weight_bytes}), flush=True)
snapshot_download(repo_id=repo, local_dir=target, token=False, allow_patterns=['*.safetensors','*.json','*.model','*.tiktoken','*.txt','*.md'], ignore_patterns=['*.gguf','*.bin','*.pt','*.pth','*.onnx'])
print(json.dumps({'stage':'complete'}), flush=True)`
// One subprocess per variant releases MLX memory before the next checkpoint is loaded.
// The same tokenizer, local dataset objects, loss function and greedy generation settings are used for every variant.
const comparisonScript = `import sys, json, types
from pathlib import Path
from mlx_lm import load, generate
from mlx_lm.sample_utils import greedy_sampler
from mlx_lm.tuner.datasets import load_local_dataset, CacheDataset
from mlx_lm.tuner.trainer import evaluate
source, data_path, adapter_path, evaluation_path = sys.argv[1:5]
model, tokenizer = load(source, adapter_path=None if adapter_path == '-' else adapter_path, trust_remote_code=False)
_, validation, test = load_local_dataset(Path(data_path), tokenizer, types.SimpleNamespace(mask_prompt=False))
validation_only = len(sys.argv) > 5 and sys.argv[5] == 'validation-only'
if not validation or (not validation_only and not test): raise ValueError('Required evaluation datasets must be nonempty.')
def measured_loss(dataset):
    return float(evaluate(model, CacheDataset(dataset), batch_size=1, num_batches=-1, max_seq_length=1024))
validation_loss = measured_loss(validation)
test_loss = measured_loss(test) if len(sys.argv) < 6 or sys.argv[5] != 'validation-only' else None
answers = []
if evaluation_path != '-':
    with open(evaluation_path, encoding='utf-8') as stream:
        for line in stream:
            row = json.loads(line)
            prompt = tokenizer.apply_chat_template([{'role':'user','content':row['prompt']}], tokenize=False, add_generation_prompt=True)
            answers.append({'id':row['id'], 'answer':generate(model, tokenizer, prompt, max_tokens=384, sampler=greedy_sampler, verbose=False)})
print('ATHENA_EVAL_JSON:' + json.dumps({'validationLoss':validation_loss,'testLoss':test_loss,'answers':answers}, ensure_ascii=False), flush=True)`

export class AcademyTraining {
  private data: Store
  private loadError = false
  mlx?: MLXInference
  private runtime: TrainingRuntime = { ready: false, metalAvailable: false, message: 'Training runtime has not been checked.' }
  private runtimeCheckedAt = 0
  private active?: { process: ReturnType<typeof spawn>; model: string; stage: 'installing' | 'downloading' | 'training' | 'evaluating'; cancelled: boolean; iteration: number; iterations: number; message: string }
  private comparisonAbort?: AbortController
  private comparisonStatus?: TrainingSnapshot['active']
  constructor(private directory: string, private python = runtimePython, private codeRunner: Pick<CodingPracticeRunner, 'runCases'> = new CodingPracticeRunner()) {
    try {
      const input = JSON.parse(readFileSync(join(directory, 'training.json'), 'utf8')) as Store
      if (input.version !== 1 || !Array.isArray(input.profiles) || !Array.isArray(input.jobs)) throw new Error('Invalid training store')
      this.data = input
    } catch (error) { this.data = emptyStore(); this.loadError = (error as NodeJS.ErrnoException).code !== 'ENOENT' }
    for (const job of this.data.jobs) if (job.stage === 'training' || job.stage === 'evaluating' || job.stage === 'downloading') {
      job.stage = 'interrupted'; job.error = 'Athena stopped while this job was active. Saved adapters remain available for inspection.'; job.finishedAt = new Date().toISOString()
      job.adapterFiles = this.adapterFiles(job); job.selectedAdapter ??= job.adapterFiles.at(-1)
    }
    if (!this.loadError && this.data.jobs.some(job => job.stage === 'interrupted')) this.save()
  }
  private save() {
    if (this.loadError) throw new Error('Training metadata could not be read; existing data was preserved.')
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    const target = join(this.directory, 'training.json'), temporary = `${target}.tmp`
    writeFileSync(temporary, JSON.stringify(this.data, null, 2), { mode: 0o600 })
    renameSync(temporary, target)
  }
  async inspectRuntime(): Promise<TrainingRuntime> {
    // Progress polling must not launch another Python/Metal probe every two seconds.
    if (this.runtime.ready && (this.active || Date.now() - this.runtimeCheckedAt < 60_000)) return this.runtime
    if (!existsSync(this.python)) return this.runtime = { ready: false, metalAvailable: false, message: 'Dedicated MLX training environment is missing. Install mlx-lm[train] in Athena’s training runtime.' }
    try {
      const result = await exec(this.python, ['-c', pythonProbe], { timeout: 30_000, maxBuffer: 30_000 })
      const found = JSON.parse(result.stdout) as { python: string; mlx: string; mlx_lm: string; metal: boolean; architectures?: string[] }
      this.runtime = { ready: found.metal, metalAvailable: found.metal, pythonVersion: found.python, mlxVersion: found.mlx, mlxLmVersion: found.mlx_lm, architectures: found.architectures, message: found.metal ? 'Dedicated MLX-LM training runtime is ready.' : 'MLX installed, but a Metal device is unavailable.' }
    } catch { this.runtime = { ready: false, metalAvailable: false, message: 'MLX-LM could not start in the dedicated training environment.' } }
    this.runtimeCheckedAt = Date.now()
    return this.runtime
  }
  async installRuntime(onProgress: (progress: TrainingProgress) => void): Promise<TrainingRuntime> {
    this.ensureIdle()
    if (!existsSync(this.python)) {
      const source = [join(homedir(), '.local', 'bin', 'python3.11'), '/opt/homebrew/opt/python@3.11/bin/python3.11', '/usr/local/bin/python3.11'].find(existsSync)
      if (!source) throw new Error('Python 3.11 is not installed. Athena cannot safely create its MLX training environment without a compatible Python interpreter.')
      mkdirSync(join(homedir(), '.athena', 'models', 'training'), { recursive: true, mode: 0o700 })
      await this.runProcess('runtime', 'installing', 0, source, ['-m', 'venv', join(homedir(), '.athena', 'models', 'training', 'runtime')], onProgress)
    }
    await this.runProcess('runtime', 'installing', 0, this.python, ['-m', 'pip', 'install', 'mlx-lm[train]==0.32.0', 'huggingface-hub>=0.34,<2', 'datasets>=3,<5'], onProgress)
    const status = await this.inspectRuntime()
    if (!status.ready) throw new Error(status.message)
    return status
  }
  snapshot(): TrainingSnapshot {
    return structuredClone({ mlxModels: this.mlx?.list(), mlxDiagnostics: this.mlx?.status(), runtime: this.runtime, profiles: this.data.profiles, jobs: this.data.jobs, comparisons: this.data.comparisons ?? [],
      active: this.active ? { model: this.active.model, stage: this.active.stage, iteration: this.active.iteration, iterations: this.active.iterations, message: this.active.message } : this.comparisonStatus })
  }
  private profile(model: LocalModel): TrainingProfile {
    if (!model.digest) throw new Error('Ollama did not provide a stable model digest; training cannot be associated with this model version.')
    let profile = this.data.profiles.find(item => item.model === model.name && item.modelDigest === model.digest)
    if (!profile) { profile = { model: model.name, modelDigest: model.digest }; this.data.profiles.push(profile); this.save() }
    return profile
  }
  private ensureIdle() { if (this.active || this.comparisonAbort) throw new Error(`A ${this.active?.stage ?? 'comparison'} job is already running. Cancel or finish it first.`) }
  configure(model: LocalModel, settings: TrainingSettings) { this.ensureIdle(); this.profile(model).settings = trainingSettingsSchema.parse(settings); this.save() }
  activationSource(model: LocalModel, jobId: string, adapter: string): MLXActivationSource {
    this.ensureIdle()
    const job = this.data.jobs.find(item => item.id === jobId && item.model === model.name && item.modelDigest === model.digest)
    const profile = this.profile(model)
    if (!job || job.stage !== 'completed' || !this.adapterFiles(job).includes(adapter)) throw new Error('Choose a completed training job and an existing adapter checkpoint.')
    if (!profile.checkpointPath || profile.checkpointId !== job.checkpointId || this.validateCheckpoint(profile.checkpointPath, model).id !== job.checkpointId) throw new Error('Exact source checkpoint identity no longer matches this training job.')
    return { checkpointPath: profile.checkpointPath, checkpointId: job.checkpointId, baseModel: model.name, baseDigest: model.digest!, adapterPath: join(this.directory, 'jobs', job.id, adapter), adapterConfigPath: join(this.directory, 'jobs', job.id, 'adapter_config.json'), adapterName: adapter, jobId: job.id }
  }
  async exportAdapter(model: LocalModel, jobId: string): Promise<Buffer> {
    const job = this.data.jobs.find(item => item.id === jobId && item.model === model.name && item.modelDigest === model.digest)
    if (!job?.selectedAdapter || !this.adapterFiles(job).includes(job.selectedAdapter)) throw new Error('Select an existing saved adapter to export.')
    const folder = join(this.directory, 'jobs', job.id)
    const configPath = join(folder, 'adapter_config.json')
    if (!existsSync(configPath) || lstatSync(configPath).isSymbolicLink()) throw new Error('Adapter configuration is missing or invalid.')
    const zip = new JSZip()
    zip.file('adapters.safetensors', readFileSync(join(folder, job.selectedAdapter)))
    zip.file('adapter_config.json', readFileSync(configPath))
    zip.file('athena-adapter.json', JSON.stringify({ model: model.name, digest: model.digest, checkpointId: job.checkpointId, jobId, datasetProvenance: job.datasetProvenance, adapter: job.selectedAdapter, format: 'mlx-lora', deployment: 'Requires a compatible MLX runtime; not a direct Ollama import.' }, null, 2))
    return zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' })
  }
  private validateCheckpoint(path: string, model: LocalModel) {
    const actual = realpathSync(path)
    if (actual.includes(`${sep}.ollama${sep}models${sep}`)) throw new Error('Ollama inference blobs are not training checkpoints.')
    if (!statSync(actual).isDirectory()) throw new Error('Choose a checkpoint folder, not an inference file.')
    const files = readdirSync(actual)
    if (!files.includes('config.json') || !files.some(name => name.endsWith('.safetensors')) || !files.some(name => /^tokenizer(?:\.json|\.model|_config\.json)$/.test(name))) throw new Error('Checkpoint must contain config.json, tokenizer files, and safetensors weights. GGUF and Ollama blobs cannot be trained.')
    if (statSync(join(actual, 'config.json')).size > 1024 * 1024) throw new Error('Checkpoint configuration is unexpectedly large.')
    const configText = readFileSync(join(actual, 'config.json'), 'utf8')
    const config = JSON.parse(configText) as { model_type?: string; quantization?: unknown; quantization_config?: unknown }
    const family = String(config.model_type ?? '').toLowerCase()
    if (!(this.runtime.architectures?.includes(family) ?? fallbackTypes.has(family))) throw new Error(`MLX training is not verified for checkpoint architecture ${family || '(unknown)'}. Knowledge and skills training remain available.`)
    const ollamaFamily = (model.family ?? '').toLowerCase()
    if (!mlxFamilyCandidate(ollamaFamily, this.runtime.architectures) || family.replace(/[^a-z0-9]/g, '') !== ollamaFamily.replace(/[^a-z0-9]/g, '')) throw new Error(`Checkpoint architecture ${family} does not match Ollama's reported ${model.family ?? 'unknown'} family.`)
    const weights = files.filter(name => name.endsWith('.safetensors')).map(name => {
      const file = join(actual, name)
      if (lstatSync(file).isSymbolicLink() || realpathSync(file).includes(`${sep}.ollama${sep}models${sep}`)) throw new Error('Checkpoint weight symlinks or Ollama inference blobs are not accepted.')
      const details = statSync(file)
      return { name, bytes: details.size, modifiedAt: details.mtimeMs }
    })
    if (weights.some(item => item.bytes < 1000)) throw new Error('Checkpoint contains an incomplete weights file.')
    const id = createHash('sha256').update(JSON.stringify({ actual, configText, weights })).digest('hex')
    return { path: actual, id, family, quantized: Boolean(config.quantization || config.quantization_config), weightBytes: weights.reduce((sum, item) => sum + item.bytes, 0) }
  }
  registerCheckpoint(model: LocalModel, path: string, label = basename(path)) {
    this.ensureIdle()
    const found = this.validateCheckpoint(path, model), profile = this.profile(model)
    Object.assign(profile, { checkpointPath: found.path, checkpointId: found.id, checkpointLabel: label, checkpointFamily: found.family, checkpointQuantized: found.quantized })
    this.save()
  }
  async downloadCheckpoint(model: LocalModel, repository: string, onProgress: (progress: TrainingProgress) => void): Promise<void> {
    this.ensureIdle()
    if (!this.runtime.ready) throw new Error(this.runtime.message)
    if (!mlxFamilyCandidate(model.family, this.runtime.architectures)) throw new Error('This Ollama model family is not a verified MLX-LM candidate. Knowledge and skills training remain available.')
    const profile = this.profile(model)
    const target = join(this.directory, 'checkpoints', createHash('sha256').update(`${model.name}:${model.digest}:${repository}`).digest('hex').slice(0, 24))
    mkdirSync(target, { recursive: true, mode: 0o700 })
    const volume = statfsSync(target)
    if (volume.bavail * volume.bsize < 8 * 1024 ** 3) throw new Error('At least 8 GB of free disk space is required before downloading a source checkpoint.')
    await this.runProcess(model.name, 'downloading', 0, this.python, ['-c', downloadScript, repository, target], onProgress)
    const found = this.validateCheckpoint(target, model)
    Object.assign(profile, { checkpointPath: found.path, checkpointId: found.id, checkpointLabel: repository, checkpointFamily: found.family, checkpointQuantized: found.quantized })
    this.save()
  }
  importDataset(model: LocalModel, path: string) {
    this.ensureIdle()
    const actual = realpathSync(path), size = statSync(actual).size
    const fileName = basename(actual)
    try { return this.importDatasetText(model, fileName, readFileSync(actual, 'utf8'), size) }
    catch (error) { throw new Error(`${fileName}: ${error instanceof Error ? error.message : 'Dataset validation failed.'}`) }
  }
  importDatasetText(model: LocalModel, fileName: string, content: string, byteLength = Buffer.byteLength(content, 'utf8')) {
    this.ensureIdle()
    const profile = this.profile(model)
    if (profile.datasetMode === 'manual') return this.importSplitText(model, 'train', fileName, content)
    const safeName = this.datasetName(fileName)
    if (byteLength > 20 * 1024 * 1024) throw new Error('JSONL must be 20 MB or smaller.')
    const rows = parseDataset(content, 10).map((row, index) => ({ ...row, order: datasetHash(`${index}:${row.line}`) })).sort((a, b) => a.order.localeCompare(b.order))
    const valid = Math.max(1, Math.floor(rows.length * .1)), test = Math.max(1, Math.floor(rows.length * .1)), train = rows.length - valid - test
    const sets = { train: rows.slice(0, train), valid: rows.slice(train, train + valid), test: rows.slice(train + valid) }
    const warnings = checkDatasetOverlap(sets), id = randomUUID(), location = join(this.directory, 'datasets', id)
    mkdirSync(location, { recursive: true, mode: 0o700 })
    const selection: DatasetSelection = { id, files: {}, warnings }
    for (const split of ['train', 'valid', 'test'] as const) {
      const serialized = sets[split].map(row => row.line).join('\n') + '\n'
      writeFileSync(join(location, `${split}.jsonl`), serialized, { mode: 0o600 })
      selection.files[split] = { name: safeName, count: sets[split].length, hash: datasetHash(serialized), sourceHash: datasetHash(content), importedAt: new Date().toISOString(), status: 'valid', origin: 'automatic-split' }
    }
    this.commitDataset(profile, 'automatic', selection)
    return { fileName: safeName, exampleCount: rows.length, train, valid, test }
  }
  private datasetName(fileName: string) {
    const name = basename(fileName.trim())
    if (!name.toLowerCase().endsWith('.jsonl')) throw new Error('Select a file with the .jsonl extension.')
    return name
  }
  private activateDataset(profile: TrainingProfile, mode: DatasetMode, selection?: DatasetSelection) {
    profile.datasetSelections ??= {}
    if (selection) profile.datasetSelections[mode] = selection
    profile.datasetMode = mode
    const chosen = profile.datasetSelections[mode]
    profile.datasetId = chosen?.id
    profile.datasetName = chosen?.files.train?.name
    profile.datasetCounts = chosen ? { train: chosen.files.train?.count ?? 0, valid: chosen.files.valid?.count ?? 0, test: chosen.files.test?.count ?? 0 } : undefined
  }
  private commitDataset(profile: TrainingProfile, mode: DatasetMode, selection?: DatasetSelection) {
    const previous = structuredClone(this.data)
    try { this.activateDataset(profile, mode, selection); this.save() }
    catch (error) { this.data = previous; throw error }
  }
  setDatasetMode(model: LocalModel, mode: DatasetMode) {
    this.ensureIdle()
    const profile = this.profile(model)
    // Legacy automatic splits remain selectable, with hashes captured on first use.
    if (profile.datasetId && !profile.datasetSelections?.[profile.datasetMode ?? 'automatic']) {
      const provenance = this.datasetProvenance(profile.datasetId, profile.datasetMode ?? 'automatic', profile.datasetName)
      profile.datasetSelections = { ...profile.datasetSelections, [provenance.mode]: provenance }
    }
    this.commitDataset(profile, mode)
  }
  importSplitText(model: LocalModel, split: DatasetSplit, fileName: string, content: string) {
    this.ensureIdle()
    const profile = this.profile(model)
    if (profile.datasetMode !== 'manual') throw new Error('Select Manual Split before importing a separate dataset.')
    const name = this.datasetName(fileName), rows = parseDataset(content)
    const previous = profile.datasetSelections?.manual
    const sets: Partial<Record<DatasetSplit, ReturnType<typeof parseDataset>>> = { [split]: rows }
    for (const key of ['train', 'valid', 'test'] as const) if (key !== split && previous?.files[key]) {
      const path = join(this.directory, 'datasets', previous.id, `${key}.jsonl`)
      const stored = readFileSync(path, 'utf8')
      if (datasetHash(stored) !== previous.files[key]!.hash) throw new Error(`${key} dataset changed on disk. Replace that file before continuing.`)
      sets[key] = parseDataset(stored)
    }
    const warnings = checkDatasetOverlap(sets), id = randomUUID(), folder = join(this.directory, 'datasets', id)
    mkdirSync(folder, { recursive: true, mode: 0o700 })
    const selection: DatasetSelection = { id, files: { ...previous?.files }, warnings }
    for (const key of ['train', 'valid', 'test'] as const) if (sets[key]) {
      const serialized = sets[key]!.map(row => row.line).join('\n') + '\n'
      writeFileSync(join(folder, `${key}.jsonl`), serialized, { mode: 0o600 })
      if (key === split) selection.files[key] = { name, count: rows.length, hash: datasetHash(serialized), sourceHash: datasetHash(content), importedAt: new Date().toISOString(), status: 'valid', origin: 'imported' }
    }
    this.commitDataset(profile, 'manual', selection)
    return { fileName: name, exampleCount: rows.length, ...profile.datasetCounts! }
  }
  private datasetProvenance(id: string, mode: DatasetMode, name = 'Legacy automatic dataset', expected?: DatasetSelection): DatasetProvenance {
    const files = {} as DatasetProvenance['files']
    const sets: Partial<Record<DatasetSplit, ReturnType<typeof parseDataset>>> = {}
    for (const split of ['train', 'valid', 'test'] as const) {
      const path = join(this.directory, 'datasets', id, `${split}.jsonl`)
      if (!existsSync(path)) throw new Error(`Import the required ${split} dataset before training.`)
      if (lstatSync(path).isSymbolicLink()) throw new Error(`${split} dataset must be a private regular file.`)
      const content = readFileSync(path, 'utf8'), hash = datasetHash(content), stored = expected?.files[split]
      if (expected && (!stored || stored.hash !== hash)) throw new Error(`${split} dataset identity changed after import or training started. Restore the original file or import a new dataset.`)
      sets[split] = parseDataset(content)
      files[split] = stored ?? { name, count: sets[split]!.length, hash, sourceHash: hash, importedAt: statSync(path).mtime.toISOString(), status: 'valid', origin: 'automatic-split' }
      if (files[split].count !== sets[split]!.length) throw new Error(`${split} dataset count changed.`)
    }
    return { mode, id, files, warnings: checkDatasetOverlap(sets) }
  }
  private verifyJobDataset(job: TrainingJob) {
    try {
      const saved = job.datasetProvenance
      const result = this.datasetProvenance(job.datasetId, saved?.mode ?? 'automatic', undefined, saved)
      return result
    } catch (error) {
      job.datasetIntegrityError = error instanceof Error ? error.message : 'Dataset identity changed.'
      this.save(); throw error
    }
  }
  importEvaluationText(model: LocalModel, fileName: string, content: string) {
    this.ensureIdle()
    const name = basename(fileName.trim())
    if (!name.toLowerCase().endsWith('.jsonl')) throw new Error('Choose an independent .jsonl evaluation file.')
    if (Buffer.byteLength(content, 'utf8') > 8 * 1024 * 1024) throw new Error('Evaluation JSONL must be 8 MB or smaller.')
    const lines = content.split(/\r?\n/).filter(line => line.trim())
    if (lines.length < 1 || lines.length > 300) throw new Error('Provide 1–300 labeled evaluation examples; 30 or more per track is recommended.')
    const counts = { coding: 0, git: 0, jira: 0 }
    const rows = lines.map((line, index) => {
      let row: unknown
      try { row = JSON.parse(line) } catch { throw new Error(`Invalid evaluation JSONL at line ${index + 1}.`) }
      if (!row || typeof row !== 'object') throw new Error(`Line ${index + 1} must be an object.`)
      const item = row as Record<string, unknown>
      if (!evaluationTracks.includes(item.track as EvaluationTrack)) throw new Error(`Line ${index + 1} needs track: coding, git or jira.`)
      if (typeof item.prompt !== 'string' || !item.prompt.trim() || item.prompt.length > 4000) throw new Error(`Line ${index + 1} needs a prompt of 1–4,000 characters.`)
      const reference = item.reference ?? item.expected
      const expected = typeof reference === 'string' ? [reference] : reference
      if (!Array.isArray(expected) || !expected.length || expected.length > 10 || expected.some(value => typeof value !== 'string' || !value.trim() || value.length > 2000)) throw new Error(`Line ${index + 1} needs one or more nonempty reference answers.`)
      const phrases = (key: 'required' | 'forbidden') => {
        const values = item[key]
        if (values === undefined) return undefined
        if (!Array.isArray(values) || values.length > 20 || values.some(value => typeof value !== 'string' || !value.trim() || value.length > 160)) throw new Error(`Line ${index + 1} has invalid ${key} reference phrases.`)
        return values as string[]
      }
      const required = phrases('required'), forbidden = phrases('forbidden')
      let tests: EvaluationExample['tests']
      if (item.track === 'coding' && item.tests !== undefined) {
        if (item.language !== undefined && item.language !== 'javascript') throw new Error(`Line ${index + 1}: executable benchmarks currently support language: javascript only.`)
        if (!Array.isArray(item.tests) || !item.tests.length || item.tests.length > 20 || JSON.stringify(item.tests).length > 20_000) throw new Error(`Line ${index + 1} needs 1–20 bounded coding tests.`)
        tests = item.tests.map((test, testIndex) => {
          if (!test || typeof test !== 'object' || typeof test.name !== 'string' || !test.name.trim() || test.name.length > 80 || !Array.isArray(test.args) || !('expected' in test)) throw new Error(`Line ${index + 1} has an invalid coding test ${testIndex + 1}; use name, args array, and expected JSON value.`)
          return { name: test.name, args: test.args, expected: test.expected }
        })
        if (new Set(tests.map(test => test.name)).size !== tests.length) throw new Error(`Line ${index + 1} repeats a coding test name.`)
      } else if (item.tests !== undefined) throw new Error(`Line ${index + 1}: executable tests are supported only for coding tasks.`)
      if (item.track === 'coding' && !tests?.length) throw new Error(`Line ${index + 1}: coding tasks require executable tests for independent correctness scoring.`)
      if (item.track !== 'coding' && !required?.length) throw new Error(`Line ${index + 1}: Git and Jira tasks require verified reference facts in required[].`)
      counts[item.track as EvaluationTrack]++
      return { id: String(index + 1), track: item.track as EvaluationTrack, prompt: item.prompt, expected: expected as string[], ...(tests ? { language: 'javascript' as const, tests } : {}), ...(required ? { required } : {}), ...(forbidden ? { forbidden } : {}) }
    })
    const id = randomUUID(), folder = join(this.directory, 'evaluation-datasets')
    mkdirSync(folder, { recursive: true, mode: 0o700 })
    const serialized = rows.map(row => JSON.stringify(row)).join('\n') + '\n'
    writeFileSync(join(folder, `${id}.jsonl`), serialized, { mode: 0o600 })
    this.profile(model).evaluationDataset = { id, name, count: rows.length, counts, digest: createHash('sha256').update(serialized).digest('hex') }
    this.save()
    return { name, count: rows.length, counts }
  }
  private async runProcess(model: string, stage: 'installing' | 'downloading' | 'training' | 'evaluating', iterations: number, command: string, args: string[], onProgress: (progress: TrainingProgress) => void, job?: TrainingJob, onLine?: (line: string) => void, comparison = false) {
    if (this.active || (this.comparisonAbort && !comparison)) this.ensureIdle()
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, HF_HUB_DISABLE_TELEMETRY: '1', PYTHONUNBUFFERED: '1' } })
    this.active = { process: child, model, stage, cancelled: false, iteration: 0, iterations, message: `${stage} started` }
    let recentError = ''
    const line = (value: string) => {
      const clean = value.replace(/\x1b\[[0-9;]*m/g, '')
      onLine?.(clean)
      if (stage === 'downloading' && clean.startsWith('{') && this.active) {
        try { const metadata = JSON.parse(clean) as { bytes?: number }; if (metadata.bytes && Number.isFinite(metadata.bytes)) { this.active.message = `Downloading approximately ${(metadata.bytes / 1024 ** 3).toFixed(1)} GiB of source weights`; onProgress({ model, stage, iteration: 0, iterations: 0, message: this.active.message }) } } catch { /* Ignore non-progress output. */ }
      }
      const progress = clean.match(/^\s*(\d+)\s+(?:val\s+)?\d+\.\d+/i) ?? clean.match(/Iter\s+(\d+):/i)
      if (progress && this.active) { this.active.iteration = Math.min(iterations, Number(progress[1])); if (job) job.iteration = this.active.iteration }
      const loss = clean.match(/^\s*\d+\s+val\s+(\d+\.\d+)/i) ?? clean.match(/Val loss\s+([\d.]+)/i)
      if (loss && job) job.validationLoss = Number(loss[1])
      const trainLoss = clean.match(/Train loss\s+([\d.]+)/i) ?? clean.match(/^\s*\d+\s+(\d+\.\d+)/)
      if (trainLoss && job) job.trainingLoss = Number(trainLoss[1])
      const memory = clean.match(/Peak mem\s+([\d.]+)\s*GB/i)
      if (memory && job) job.peakMemoryGB = Number(memory[1])
      const test = clean.match(/(?:Test loss)\s*[:=]?\s*([\d.]+)/i)
      if (test && job) job.testLoss = Number(test[1])
      if (this.active) {
        this.active.message = stage === 'training' ? `Iteration ${this.active.iteration}/${iterations}` : stage === 'evaluating' ? 'Evaluating held-out examples' : stage === 'installing' ? 'Installing dedicated MLX-LM training runtime' : 'Downloading source checkpoint'
        if ((stage === 'training' && progress) || (stage === 'evaluating' && test)) { if (job) { job.adapterFiles = this.adapterFiles(job); this.save() } onProgress({ model, stage, iteration: this.active.iteration, iterations, message: this.active.message, trainingLoss: job?.trainingLoss, validationLoss: job?.validationLoss, peakMemoryGB: job?.peakMemoryGB }) }
      }
      if (/GatedRepoError/i.test(clean)) recentError = 'The repository requires license acceptance or supported authentication. Review its model card.'
      else if (/RepositoryNotFoundError/i.test(clean)) recentError = 'Source checkpoint repository was not found or is not accessible.'
      else if (/ATHENA_SOURCE_SIZE_UNKNOWN/i.test(clean)) recentError = 'Repository weight size is unavailable; Athena did not start an unbounded download.'
      else if (/ATHENA_SOURCE_TOO_LARGE/i.test(clean)) recentError = 'Source weights exceed the 12 GiB download limit for this 24 GB training preset.'
      else if (/ATHENA_SOURCE_DISK_LOW/i.test(clean)) recentError = 'Insufficient free disk space for the source checkpoint and working files.'
      else if (/out of memory|MemoryError/i.test(clean)) recentError = 'MLX training ran out of memory. Use a smaller or quantized source checkpoint.'
      else if (/error|traceback|failed/i.test(clean) && !recentError) recentError = `${stage} reported an error. Check source compatibility, local disk and memory.`
    }
    for (const pipe of [child.stdout, child.stderr]) { let buffer = ''; pipe?.on('data', (chunk: Buffer) => { buffer += chunk.toString('utf8'); const lines = buffer.split(/[\r\n]/); buffer = lines.pop() ?? ''; for (const value of lines) line(value) }); pipe?.once('end', () => { if (buffer) line(buffer) }) }
    onProgress({ model, stage, iteration: 0, iterations, message: this.active.message })
    let code: number | null
    let cancelled = false
    try { code = await new Promise<number | null>((done, reject) => { child.once('error', reject); child.once('close', done) }); cancelled = this.active?.cancelled ?? false }
    finally { this.active = undefined }
    if (cancelled) throw new Error('Operation cancelled; any completed checkpoints were preserved.')
    if (code !== 0) throw new Error(recentError || `${stage} exited with status ${code}. Review checkpoint format, dataset, and available memory.`)
  }
  cancel(): boolean {
    if (!this.active && !this.comparisonAbort) return false
    this.comparisonAbort?.abort()
    if (this.active) { this.active.cancelled = true; this.active.process.kill('SIGTERM') }
    return true
  }
  private ready(model: LocalModel, job?: TrainingJob) {
    if (!this.runtime.ready) throw new Error(this.runtime.message)
    const current = this.profile(model)
    const profile = job ? { ...current, datasetId: job.datasetId, datasetMode: job.datasetProvenance?.mode ?? 'automatic', datasetCounts: job.datasetProvenance ? { train: job.datasetProvenance.files.train.count, valid: job.datasetProvenance.files.valid.count, test: job.datasetProvenance.files.test.count } : current.datasetCounts } : current
    if (!profile.checkpointPath || !profile.checkpointId || !profile.datasetId) throw new Error('Select a validated source checkpoint and import a training dataset first.')
    const actual = this.validateCheckpoint(profile.checkpointPath, model)
    if (actual.id !== profile.checkpointId) throw new Error('Checkpoint files changed after validation. Select the checkpoint again.')
    if (!actual.quantized && totalmem() <= 28 * 1024 ** 3 && actual.weightBytes > 8 * 1024 ** 3) throw new Error('This full-precision checkpoint is too large for Athena’s 24 GB training preset. Choose a compatible MLX-quantized source checkpoint for QLoRA.')
    const dataPath = join(this.directory, 'datasets', profile.datasetId)
    if (!job && profile.datasetMode === 'manual' && !profile.datasetSelections?.manual) throw new Error('Manual dataset assignments are missing. Reimport all three files.')
    const provenance = job ? this.verifyJobDataset(job) : this.datasetProvenance(profile.datasetId, profile.datasetMode ?? 'automatic', profile.datasetName, profile.datasetSelections?.[profile.datasetMode ?? 'automatic'])
    return { profile, dataPath, provenance }
  }
  private runtimeDataset(folder: string, dataPath: string, splits: DatasetSplit[]) {
    const target = join(folder, 'data')
    mkdirSync(target, { recursive: true, mode: 0o700 })
    for (const split of splits) copyFileSync(join(dataPath, `${split}.jsonl`), join(target, `${split}.jsonl`))
    return target
  }
  private adapterFiles(job: TrainingJob): string[] {
    const folder = join(this.directory, 'jobs', job.id)
    return existsSync(folder) ? readdirSync(folder).filter(name => /^[\w.-]+\.safetensors$/.test(name) && !lstatSync(join(folder, name)).isSymbolicLink() && statSync(join(folder, name)).size > 1000).sort() : []
  }
  async train(model: LocalModel, iterations: number, onProgress: (progress: TrainingProgress) => void, resume?: TrainingJob): Promise<TrainingJob> {
    this.ensureIdle()
    const { profile, dataPath, provenance } = this.ready(model)
    if (resume && (resume.model !== model.name || resume.modelDigest !== model.digest || resume.checkpointId !== profile.checkpointId || resume.datasetId !== profile.datasetId || !resume.selectedAdapter)) throw new Error('Selected checkpoint cannot be resumed for this model version.')
    if (resume) this.verifyJobDataset(resume)
    const settings = { ...defaultTrainingSettings, ...profile.settings, ...(resume?.settings ?? {}), iterations }
    if (provenance.files.train.count < settings.batchSize || provenance.files.valid.count < settings.batchSize) throw new Error('Training and validation datasets must each contain at least one full batch. Reduce batch size or import more examples.')
    const job: TrainingJob = { id: randomUUID(), model: model.name, modelDigest: model.digest!, checkpointId: profile.checkpointId!, datasetId: profile.datasetId!, datasetProvenance: provenance, stage: 'training', startedAt: new Date().toISOString(), iteration: 0, iterations, adapterFiles: [], settings }
    this.data.jobs.push(job); this.save()
    const folder = join(this.directory, 'jobs', job.id); mkdirSync(folder, { recursive: true, mode: 0o700 })
    const runtimeData = provenance.mode === 'manual' ? this.runtimeDataset(folder, dataPath, ['train', 'valid']) : dataPath
    const config = join(folder, 'training-config.json')
    writeFileSync(config, JSON.stringify({ lora_parameters: { rank: settings.rank, dropout: 0, scale: 20 } }), { mode: 0o600 })
    const args = ['-m', 'mlx_lm', 'lora', '--config', config, '--model', profile.checkpointPath!, '--train', '--data', runtimeData, '--fine-tune-type', 'lora', '--num-layers', '8', '--batch-size', String(settings.batchSize), '--learning-rate', String(settings.learningRate), '--iters', String(iterations), '--grad-checkpoint', '--max-seq-length', '1024', '--steps-per-report', '5', '--steps-per-eval', '25', '--val-batches', '-1', '--save-every', String(settings.checkpointEvery), '--adapter-path', folder]
    if (resume) args.push('--resume-adapter-file', join(this.directory, 'jobs', resume.id, resume.selectedAdapter!))
    try {
      await this.runProcess(model.name, 'training', iterations, this.python, args, onProgress, job)
      this.verifyJobDataset(job)
      job.stage = 'completed'; job.iteration = iterations
    } catch (error) { job.stage = /cancelled/i.test(String(error)) ? 'cancelled' : 'failed'; job.error = error instanceof Error ? error.message : 'Training failed.' }
    job.finishedAt = new Date().toISOString(); job.adapterFiles = this.adapterFiles(job)
    if (job.adapterFiles.length) job.selectedAdapter = job.adapterFiles.at(-1)
    if (job.stage === 'completed' && job.selectedAdapter) { profile.selectedJobId = job.id; profile.selectedAdapter = job.selectedAdapter }
    this.save(); onProgress({ model: model.name, stage: job.stage, iteration: job.iteration, iterations, message: job.error ?? 'Adapter training finished; Ollama deployment is not automatic.' })
    return job
  }
  async evaluate(model: LocalModel, jobId: string, onProgress: (progress: TrainingProgress) => void) {
    this.ensureIdle()
    const job = this.data.jobs.find(item => item.id === jobId && item.model === model.name && item.modelDigest === model.digest)
    if (!job) throw new Error('Training job was not found for this model version.')
    const { profile, dataPath } = this.ready(model, job)
    if (!job?.selectedAdapter || job.checkpointId !== profile.checkpointId || job.datasetId !== profile.datasetId) throw new Error('Choose an adapter trained with this model, checkpoint and dataset.')
    const jobFolder = join(this.directory, 'jobs', job.id), adapterPath = join(jobFolder, job.selectedAdapter)
    if (!existsSync(adapterPath) || !existsSync(join(jobFolder, 'adapter_config.json'))) throw new Error('Selected adapter checkpoint or its configuration is missing.')
    const evaluationFolder = join(this.directory, 'evaluations', `${job.id}-${job.selectedAdapter.replace('.safetensors', '')}`)
    mkdirSync(evaluationFolder, { recursive: true, mode: 0o700 })
    copyFileSync(adapterPath, join(evaluationFolder, 'adapters.safetensors'))
    copyFileSync(join(jobFolder, 'adapter_config.json'), join(evaluationFolder, 'adapter_config.json'))
    const runtimeData = job.datasetProvenance?.mode === 'manual' ? this.runtimeDataset(evaluationFolder, dataPath, ['test']) : dataPath
    const measured = structuredClone(job); delete measured.testLoss
    await this.runProcess(model.name, 'evaluating', 0, this.python, ['-m', 'mlx_lm', 'lora', '--model', profile.checkpointPath!, '--data', runtimeData, '--adapter-path', evaluationFolder, '--test', '--test-batches', '-1', '--batch-size', '1', '--max-seq-length', '1024'], onProgress, measured)
    this.verifyJobDataset(job)
    if (!Number.isFinite(measured.testLoss)) throw new Error('Final evaluation did not report a measured test loss.')
    job.testLoss = measured.testLoss
    this.save()
  }
  async compare(model: LocalModel, jobId: string, onProgress: (progress: TrainingProgress) => void): Promise<EvaluationComparison> {
    this.ensureIdle()
    const job = this.data.jobs.find(item => item.id === jobId && item.model === model.name && item.modelDigest === model.digest)
    if (!job) throw new Error('Training job was not found for this model version.')
    const { profile, dataPath } = this.ready(model, job)
    if (!job || job.checkpointId !== profile.checkpointId || job.datasetId !== profile.datasetId) throw new Error('This job does not match the selected model, source checkpoint and training dataset.')
    const adapters = this.adapterFiles(job)
    if (!adapters.length) throw new Error('No saved adapter checkpoints are available to compare.')
    const jobFolder = join(this.directory, 'jobs', job.id)
    if (!existsSync(join(jobFolder, 'adapter_config.json'))) throw new Error('Adapter configuration is missing.')
    const manual = job.datasetProvenance?.mode === 'manual'
    const comparisonData = manual ? this.runtimeDataset(join(jobFolder, 'validation-comparison'), dataPath, ['valid']) : dataPath
    const evaluation = manual ? undefined : profile.evaluationDataset
    const evaluationPath = evaluation ? join(this.directory, 'evaluation-datasets', `${evaluation.id}.jsonl`) : undefined
    if (evaluationPath && (!existsSync(evaluationPath) || createHash('sha256').update(readFileSync(evaluationPath)).digest('hex') !== evaluation?.digest)) throw new Error('Independent evaluation dataset is missing or has changed.')
    const examples: EvaluationExample[] = evaluationPath ? readFileSync(evaluationPath, 'utf8').split(/\r?\n/).filter(Boolean).map(line => ({ ...JSON.parse(line) as Pick<EvaluationExample, 'id' | 'track' | 'prompt' | 'expected'>, answers: {}, correct: {} })) : []
    const privateSets = ['valid', 'test'].map(name => join(dataPath, `${name}.jsonl`))
    const privateDigests = privateSets.map(path => createHash('sha256').update(readFileSync(path)).digest('hex'))
    const adapterDetails = adapters.map(name => { const info = statSync(join(jobFolder, name)); return { name, size: info.size, modified: info.mtimeMs } })
    const adapterConfigDigest = createHash('sha256').update(readFileSync(join(jobFolder, 'adapter_config.json'))).digest('hex')
    const variants: EvaluationVariant[] = []
    const definitions = [{ id: 'base', label: 'Original base model' }, ...adapters.map(name => ({ id: name, label: name }))]
    mkdirSync(join(this.directory, 'evaluations'), { recursive: true, mode: 0o700 })
    const abort = new AbortController()
    this.comparisonAbort = abort
    this.comparisonStatus = { model: model.name, stage: 'evaluating', iteration: 0, iterations: definitions.length, message: 'Preparing independent task comparison' }
    try {
    for (const [index, definition] of definitions.entries()) {
      abort.signal.throwIfAborted()
      this.comparisonStatus = { model: model.name, stage: 'evaluating', iteration: index, iterations: definitions.length, message: `Comparing ${definition.label} (${index + 1}/${definitions.length})` }
      onProgress({ model: model.name, stage: 'evaluating', iteration: index, iterations: definitions.length, message: `Comparing ${definition.label} (${index + 1}/${definitions.length})` })
      let temporary: string | undefined
      let adapterPath = '-'
      try {
        if (definition.id !== 'base') {
          temporary = mkdtempSync(join(this.directory, 'evaluations', 'compare-'))
          copyFileSync(join(jobFolder, definition.id), join(temporary, 'adapters.safetensors'))
          copyFileSync(join(jobFolder, 'adapter_config.json'), join(temporary, 'adapter_config.json'))
          adapterPath = temporary
        }
        let result: { validationLoss: number; testLoss?: number; answers: Array<{ id: string; answer: string }> } | undefined
        await this.runProcess(model.name, 'evaluating', definitions.length, this.python, ['-c', comparisonScript, profile.checkpointPath!, comparisonData, adapterPath, evaluationPath ?? '-', manual ? 'validation-only' : 'full'], onProgress, undefined, line => {
          if (line.startsWith('ATHENA_EVAL_JSON:')) {
            try { result = JSON.parse(line.slice('ATHENA_EVAL_JSON:'.length)) as typeof result }
            catch { result = undefined }
          }
        }, true)
        abort.signal.throwIfAborted()
        if (!result || !Number.isFinite(result.validationLoss) || (!manual && !Number.isFinite(result.testLoss)) || !Array.isArray(result.answers)) throw new Error(`${definition.label} did not produce valid measured losses and answers.`)
        const answerMap = new Map(result.answers.map(answer => [answer.id, answer.answer]))
        if (answerMap.size !== examples.length) throw new Error(`${definition.label} did not generate an answer for every independent example.`)
        for (const [exampleIndex, example] of examples.entries()) {
          abort.signal.throwIfAborted()
          if (exampleIndex % 10 === 0) {
            const message = `Scoring ${definition.label}: task ${exampleIndex + 1}/${examples.length}`
            this.comparisonStatus = { model: model.name, stage: 'evaluating', iteration: index, iterations: definitions.length, message }
            onProgress({ model: model.name, stage: 'evaluating', iteration: index, iterations: definitions.length, message })
          }
          const answer = answerMap.get(example.id)
          if (typeof answer !== 'string') throw new Error(`${definition.label} omitted an evaluation answer.`)
          example.answers[definition.id] = answer
          let judgement
          if (example.track === 'coding' && example.tests?.length) {
            const fenced = /```(?:javascript|js)?\s*([\s\S]*?)```/i.exec(answer)
            const source = (fenced?.[1] ?? answer).trim()
            try {
              const cases = await this.codeRunner.runCases(source, example.tests, abort.signal)
              const failed = cases.filter(item => !item.passed)
              judgement = { status: failed.length ? 'fail' as const : 'pass' as const, reason: failed.length ? `Failed ${failed.length}/${cases.length} isolated tests: ${failed.map(item => `${item.name}: expected ${JSON.stringify(example.tests?.find(test => test.name === item.name)?.expected)}, received ${item.detail}`).join('; ')}` : `Passed all ${cases.length} isolated tests.`, cases }
            } catch (error) {
              if (abort.signal.aborted) throw error
              if (/sandbox did not pass|unavailable|Could not start isolated practice/i.test(String(error))) throw new Error('Executable benchmark verification is unavailable: the isolated macOS sandbox did not pass its safety probe. No comparison was saved.')
              judgement = { status: 'fail' as const, reason: `Generated solution failed in the isolated runner: ${error instanceof Error ? error.message : String(error)}` }
            }
          } else if (example.track === 'coding') judgement = { status: 'needs-review' as const, reason: 'This legacy coding example has no executable tests. Import a benchmark with tests for measured correctness.' }
          else judgement = scoreReference(example, answer)
          example.judgements ??= {}
          example.judgements[definition.id] = judgement
          example.correct[definition.id] = judgement.status === 'pass'
        }
        variants.push({ id: definition.id, label: definition.label, validationLoss: result.validationLoss, testLoss: manual ? undefined : result.testLoss, taskScores: {} as EvaluationVariant['taskScores'] })
      } finally { if (temporary) rmSync(temporary, { recursive: true, force: true }) }
      if (privateSets.some((path, index) => createHash('sha256').update(readFileSync(path)).digest('hex') !== privateDigests[index])) throw new Error('Training held-out data changed during comparison; results were not saved.')
      if (evaluationPath && createHash('sha256').update(readFileSync(evaluationPath)).digest('hex') !== evaluation?.digest) throw new Error('Independent evaluation data changed during comparison; results were not saved.')
      if (adapterDetails.some(item => { const info = statSync(join(jobFolder, item.name)); return info.size !== item.size || info.mtimeMs !== item.modified })) throw new Error('A saved adapter changed during comparison; results were not saved.')
      if (createHash('sha256').update(readFileSync(join(jobFolder, 'adapter_config.json'))).digest('hex') !== adapterConfigDigest || this.validateCheckpoint(profile.checkpointPath!, model).id !== profile.checkpointId) throw new Error('The source checkpoint or adapter configuration changed during comparison; results were not saved.')
    }
    this.verifyJobDataset(job)
    const base = variants[0]
    const counts = profile.datasetCounts
    const warnings: string[] = []
    if ((counts?.test ?? 0) < 30) warnings.push(`Held-out test split has only ${counts?.test ?? 0} examples; loss ranking is uncertain. Import a larger independent evaluation set before deployment decisions.`)
    if (!evaluation) warnings.push('No independent labeled evaluation set is imported; task-level correctness and answer review are unavailable.')
    else for (const track of evaluationTracks) if (evaluation.counts[track] < 30) warnings.push(`${track} has only ${evaluation.counts[track]} independent examples; its 95% score interval is wide.`)
    for (const variant of variants.slice(1)) if (variant.validationLoss < base.validationLoss && (variant.testLoss ?? 0) > (base.testLoss ?? 0)) warnings.push(`${variant.label} improves validation loss but worsens held-out test loss: possible overfitting or distribution mismatch.`)
    for (const variant of variants.slice(1)) if ((variant.testLoss ?? 0) > variant.validationLoss + 0.5) warnings.push(`${variant.label} has a large validation-to-test loss gap; investigate possible overfitting or a harder test distribution.`)
    if (examples.some(example => example.track === 'coding' && !example.tests?.length)) warnings.push('Coding rows without executable tests are unverified and cannot support a checkpoint recommendation.')
    if (examples.some(example => example.track !== 'coding' && !example.required?.length)) warnings.push('Git/Jira rows without required reference facts use exact-match screening; differing answers need manual review.')
    const comparison: EvaluationComparison = { id: randomUUID(), jobId, model: model.name, modelDigest: model.digest, createdAt: new Date().toISOString(), trainingDatasetId: job.datasetId, evaluationDatasetId: evaluation?.id, evaluationDatasetDigest: evaluation?.digest,
      ...(manual ? { selectionBasis: 'validation' as const } : {}),
      settings: { maxSequenceLength: 1024, maxOutputTokens: 384, batchSize: 1, scoring: manual ? 'full validation split token-weighted cross-entropy; independent test reserved for final evaluation' : 'full-split token-weighted cross-entropy loss; isolated JavaScript tests; Git/Jira required/forbidden reference facts; greedy generation', tokenizerCheckpointId: profile.checkpointId! },
      variants, examples, warnings }
    if (manual) comparison.warnings = ['Checkpoint comparison uses validation loss only. Run final evaluation on the selected adapter to measure the independent test dataset.']
    refreshComparison(comparison)
    this.data.comparisons ??= []
    this.data.comparisons.push(comparison)
    this.save()
    onProgress({ model: model.name, stage: 'completed', iteration: definitions.length, iterations: definitions.length, message: 'Base and saved checkpoints compared; no adapter was deployed.' })
    return comparison
    } finally { this.comparisonAbort = undefined; this.comparisonStatus = undefined }
  }
  reviewExample(model: LocalModel, comparisonId: string, exampleId: string, variantId: string, decision: 'pass' | 'fail' | 'needs-review' | 'reset', note: string) {
    this.ensureIdle()
    const comparison = this.data.comparisons?.find(item => item.id === comparisonId && item.model === model.name)
    const job = comparison && this.data.jobs.find(item => item.id === comparison.jobId && item.modelDigest === model.digest)
    if (!comparison || !job) throw new Error('Comparison does not belong to the selected local model version.')
    const example = comparison.examples.find(item => item.id === exampleId)
    if (!example || !comparison.variants.some(item => item.id === variantId)) throw new Error('Benchmark example or checkpoint was not found.')
    example.judgements ??= Object.fromEntries(comparison.variants.map(variant => [variant.id, { status: example.correct[variant.id] ? 'pass' : 'fail', reason: 'Original legacy exact-answer score.' }]))
    example.reviews ??= {}
    if (decision === 'reset') delete example.reviews[variantId]
    else example.reviews[variantId] = { decision, note: note.trim(), reviewedAt: new Date().toISOString() }
    refreshComparison(comparison)
    this.save()
  }
  selectAdapter(model: LocalModel, jobId: string, name: string) {
    this.ensureIdle()
    const profile = this.profile(model), job = this.data.jobs.find(item => item.id === jobId && item.model === model.name && item.modelDigest === model.digest)
    if (!job || job.checkpointId !== profile.checkpointId || !this.adapterFiles(job).includes(name)) throw new Error('Adapter checkpoint is unavailable or belongs to another model version.')
    job.selectedAdapter = name; profile.selectedJobId = job.id; profile.selectedAdapter = name; this.save()
  }
}
