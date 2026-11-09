import { afterEach, describe, expect, it } from 'vitest'
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AcademyTraining } from '../electron/main/ai/academyTraining'
import { defaultTrainingSettings, mlxFamilyCandidate, suggestedCheckpoint, trainingCommandSchema } from '../shared/academyTraining'
import JSZip from 'jszip'
import type { LocalModel } from '../shared/localAI'

const roots: string[] = []
const fixture = () => { const path = mkdtempSync(join(tmpdir(), 'athena-train-')); roots.push(path); return path }
const model: LocalModel = { name: 'qwen2.5:3b', digest: 'digest-one', family: 'qwen2', size: 2_000_000_000, capabilities: ['completion'] }
const checkpoint = (root: string, quantized = true) => {
  const path = join(root, 'checkpoint'); mkdirSync(path)
  writeFileSync(join(path, 'config.json'), JSON.stringify({ model_type: 'qwen2', ...(quantized ? { quantization: { group_size: 64, bits: 4 } } : {}) }))
  writeFileSync(join(path, 'tokenizer.json'), '{}')
  writeFileSync(join(path, 'model.safetensors'), Buffer.alloc(1200))
  return path
}
const dataset = (root: string) => {
  const path = join(root, 'examples.jsonl')
  writeFileSync(path, Array.from({ length: 20 }, (_, i) => JSON.stringify({ text: `Example ${i} with a verified answer.` })).join('\n'))
  return path
}
const fakeRuntime = (root: string, slow = false) => {
  const path = join(root, 'fake-python')
  writeFileSync(path, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const dataPath = args.includes('--data') ? args[args.indexOf('--data')+1] : args[0] === '-c' && args[1].includes('ATHENA_EVAL_JSON:') ? args[3] : undefined;
if (dataPath) fs.appendFileSync(${JSON.stringify(join(root, 'runtime-inputs.jsonl'))}, JSON.stringify({args, datasets:Object.fromEntries(fs.readdirSync(dataPath).filter(f=>f.endsWith('.jsonl')).map(f=>[f,fs.readFileSync(dataPath+'/'+f,'utf8').trim().split('\\n').map(JSON.parse)]))})+'\\n');
if (args[0] === '-c' && args[1].includes('ATHENA_EVAL_JSON:')) {
  const adapter = args[4] === '-' ? 'base' : fs.readFileSync(args[4]+'/adapters.safetensors','utf8').slice(0,1);
  const rows = args[5] === '-' ? [] : fs.readFileSync(args[5],'utf8').trim().split('\\n').map(JSON.parse);
  const losses = adapter === 'base' ? [1.5,2.5] : adapter === 'B' ? [1.1,1.8] : [1.3,2.1];
  console.log('ATHENA_EVAL_JSON:'+JSON.stringify({validationLoss:losses[0],testLoss:losses[1],answers:rows.map(row=>({id:row.id,answer:adapter === 'B' ? (row.track === 'coding' ? 'function solve(a,b) { return a+b }' : row.expected[0]) : 'wrong'}))}));
}
else if (args[0] === '-c') console.log(JSON.stringify({python:'3.11.16',mlx:'0.32.4',mlx_lm:'0.32.0',metal:true}));
else if (args.includes('--train')) { const folder=args[args.indexOf('--adapter-path')+1]; fs.writeFileSync(folder+'/adapters.safetensors',Buffer.alloc(1200)); fs.writeFileSync(folder+'/adapter_config.json','{}'); console.log('   5    1.000'); console.log('  10    val 0.900'); ${slow ? 'setTimeout(()=>{},5000);' : ''} }
else if (args.includes('--test')) { const folder=args[args.indexOf('--adapter-path')+1]; if(!fs.existsSync(folder+'/adapters.safetensors')||!fs.existsSync(folder+'/adapter_config.json')) process.exit(3); console.log('Test loss 0.700, Test ppl 2.014.'); }
else process.exit(2);
`)
  chmodSync(path, 0o700)
  return path
}
const conversations = (prefix: string, count: number) => Array.from({ length: count }, (_, i) => JSON.stringify({ messages: [{ role: 'user', content: `${prefix} question ${i}` }, { role: 'assistant', content: `${prefix} verified answer ${i}` }] })).join('\n')
const importManual = (service: AcademyTraining) => {
  service.setDatasetMode(model, 'manual')
  service.importSplitText(model, 'train', 'train.jsonl', conversations('training', 52))
  service.importSplitText(model, 'valid', 'valid.jsonl', conversations('validation', 6))
  service.importSplitText(model, 'test', 'test.jsonl', conversations('testing', 7))
}
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }) })

describe('Academy MLX training setup', () => {
  it('persists bounded per-model settings and writes the actual MLX rank configuration without changing datasets', async () => {
    const root = fixture(), storage = join(root, 'private'), service = new AcademyTraining(storage, fakeRuntime(root))
    await service.inspectRuntime(); service.registerCheckpoint(model, checkpoint(root)); service.importDataset(model, dataset(root))
    const settings = { ...defaultTrainingSettings, iterations: 10, rank: 16, learningRate: .00002, checkpointEvery: 5 }
    service.configure(model, settings)
    expect(new AcademyTraining(storage).snapshot().profiles[0].settings).toEqual(settings)
    const job = await service.train(model, 10, () => {})
    expect(job.settings).toEqual(settings)
    expect(job.trainingLoss).toBe(1)
    expect(JSON.parse(readFileSync(join(storage, 'jobs', job.id, 'training-config.json'), 'utf8')).lora_parameters.rank).toBe(16)
    const archive = await JSZip.loadAsync(await service.exportAdapter(model, job.id))
    expect(Object.keys(archive.files)).toEqual(['adapters.safetensors', 'adapter_config.json', 'athena-adapter.json'])
    expect(JSON.parse(await archive.file('athena-adapter.json')!.async('string'))).toMatchObject({ model: model.name, format: 'mlx-lora' })
    await expect(service.exportAdapter({ ...model, digest: 'different' }, job.id)).rejects.toThrow('existing saved adapter')
    expect(trainingCommandSchema.safeParse({ action: 'configure', model: model.name, settings: { ...settings, batchSize: 20 } }).success).toBe(false)
  })
  it('classifies architecture candidates without treating Ollama blobs as checkpoints', () => {
    expect(mlxFamilyCandidate('qwen2')).toBe(true)
    expect(mlxFamilyCandidate('unsupported-family')).toBe(false)
    expect(mlxFamilyCandidate('gptoss', ['gpt_oss', 'qwen2'])).toBe(true)
    expect(mlxFamilyCandidate('other', ['gpt_oss', 'qwen2'])).toBe(false)
    expect(suggestedCheckpoint('qwen2.5-coder:3b')).toBe('Qwen/Qwen2.5-Coder-3B-Instruct')
    expect(trainingCommandSchema.safeParse({ action: 'checkpoint-download', model: model.name, repository: '../private' }).success).toBe(false)
  })
  it('keeps checkpoints and dataset associations independent by Ollama digest', () => {
    const root = fixture(), service = new AcademyTraining(join(root, 'private'))
    service.registerCheckpoint(model, checkpoint(root))
    service.importDataset(model, dataset(root))
    const saved = service.snapshot().profiles[0]
    expect(saved.checkpointQuantized).toBe(true)
    expect(saved.datasetCounts).toEqual({ train: 16, valid: 2, test: 2 })
    expect(readFileSync(join(root, 'private', 'datasets', saved.datasetId!, 'train.jsonl'), 'utf8').split('\n').filter(Boolean)).toHaveLength(16)
    const next = new AcademyTraining(join(root, 'private')).snapshot()
    expect(next.profiles[0].checkpointId).toBe(saved.checkpointId)
    expect(next.profiles.find(item => item.modelDigest === 'different')).toBeUndefined()
  })
  it('rejects incompatible architectures and missing tokenizer data', () => {
    const root = fixture(), path = checkpoint(root), service = new AcademyTraining(join(root, 'private'))
    writeFileSync(join(path, 'config.json'), JSON.stringify({ model_type: 'unknown' }))
    expect(() => service.registerCheckpoint(model, path)).toThrow('not verified')
    writeFileSync(join(path, 'config.json'), JSON.stringify({ model_type: 'llama' }))
    expect(() => service.registerCheckpoint(model, path)).toThrow('does not match')
  })
  it('runs bounded training, records progress and held-out evaluation, and selects an older adapter without changing Ollama', async () => {
    const root = fixture(), service = new AcademyTraining(join(root, 'private'), fakeRuntime(root))
    expect((await service.inspectRuntime()).ready).toBe(true)
    service.registerCheckpoint(model, checkpoint(root))
    service.importDataset(model, dataset(root))
    const progress: number[] = []
    const job = await service.train(model, 10, value => progress.push(value.iteration))
    expect(job.stage).toBe('completed')
    expect(job.adapterFiles).toContain('adapters.safetensors')
    expect(progress).toContain(5)
    expect(job.validationLoss).toBe(.9)
    await service.evaluate(model, job.id, () => {})
    expect(service.snapshot().jobs[0].testLoss).toBe(.7)
    service.selectAdapter(model, job.id, 'adapters.safetensors')
    expect(service.snapshot().profiles[0].selectedAdapter).toBe('adapters.safetensors')
    expect(() => service.selectAdapter({ ...model, digest: 'different' }, job.id, 'adapters.safetensors')).toThrow()
  })
  it('cancels a running training process and preserves its saved checkpoint for a later resume', async () => {
    const root = fixture(), service = new AcademyTraining(join(root, 'private'), fakeRuntime(root, true))
    await service.inspectRuntime()
    service.registerCheckpoint(model, checkpoint(root))
    service.importDataset(model, dataset(root))
    const running = service.train(model, 50, () => {})
    await new Promise(resolve => setTimeout(resolve, 150))
    expect(service.cancel()).toBe(true)
    const job = await running
    expect(job.stage).toBe('cancelled')
    expect(job.adapterFiles).toContain('adapters.safetensors')
    expect(new AcademyTraining(join(root, 'private')).snapshot().jobs[0].stage).toBe('cancelled')
  })
  it('compares the base and every saved adapter on unchanged held-out data without retraining or selecting a checkpoint', async () => {
    const root = fixture(), service = new AcademyTraining(join(root, 'private'), fakeRuntime(root), { runCases: async code => [{ name: 'sum', passed: code.includes('function solve'), detail: code.includes('function solve') ? '3' : 'No solve function' }] })
    await service.inspectRuntime()
    service.registerCheckpoint(model, checkpoint(root))
    service.importDataset(model, dataset(root))
    const job = await service.train(model, 10, () => {})
    const jobFolder = join(root, 'private', 'jobs', job.id)
    writeFileSync(join(jobFolder, '0000025_adapters.safetensors'), Buffer.alloc(1200, 'B'))
    const validBefore = readFileSync(join(root, 'private', 'datasets', job.datasetId, 'valid.jsonl'), 'utf8')
    const testBefore = readFileSync(join(root, 'private', 'datasets', job.datasetId, 'test.jsonl'), 'utf8')
    const imported = service.importEvaluationText(model, 'independent.jsonl', [
      { track: 'coding', prompt: 'Write JavaScript function solve(a,b) to add two numbers.', expected: 'function solve(a,b) { return a+b }', tests: [{ name: 'sum', args: [1, 2], expected: 3 }] },
      { track: 'git', prompt: 'Answer git', expected: 'git answer', required: ['git answer'] },
      { track: 'jira', prompt: 'Answer jira', expected: 'jira answer', required: ['jira answer'] },
    ].map(row => JSON.stringify(row)).join('\n'))
    expect(imported.counts).toEqual({ coding: 1, git: 1, jira: 1 })
    const comparison = await service.compare(model, job.id, () => {})
    expect(comparison.variants.map(item => item.id)).toEqual(['base', '0000025_adapters.safetensors', 'adapters.safetensors'])
    expect(comparison.variants[0].testLoss).toBe(2.5)
    expect(comparison.variants[1].taskScores.coding.correct).toBe(1)
    expect(comparison.recommendation).toBe('0000025_adapters.safetensors')
    expect(comparison.warnings.some(warning => warning.includes('only 2 examples'))).toBe(true)
    expect(comparison.examples[0].answers.base).toBe('wrong')
    expect(comparison.examples[0].answers['0000025_adapters.safetensors']).toBe('function solve(a,b) { return a+b }')
    expect(comparison.examples[0].judgements?.['0000025_adapters.safetensors'].cases?.[0].passed).toBe(true)
    expect(service.snapshot().jobs[0].validationLoss).toBe(.9)
    expect(service.snapshot().jobs[0].selectedAdapter).toBe('adapters.safetensors')
    expect(readFileSync(join(root, 'private', 'datasets', job.datasetId, 'valid.jsonl'), 'utf8')).toBe(validBefore)
    expect(readFileSync(join(root, 'private', 'datasets', job.datasetId, 'test.jsonl'), 'utf8')).toBe(testBefore)
    expect(new AcademyTraining(join(root, 'private')).snapshot().comparisons[0].id).toBe(comparison.id)
    service.reviewExample(model, comparison.id, '2', '0000025_adapters.safetensors', 'needs-review', 'Reference answer may miss a required caveat.')
    expect(service.snapshot().comparisons[0].recommendation).toBeUndefined()
    expect(service.snapshot().comparisons[0].examples[1].reviews?.['0000025_adapters.safetensors'].note).toContain('caveat')
    service.reviewExample(model, comparison.id, '2', '0000025_adapters.safetensors', 'reset', '')
    expect(service.snapshot().comparisons[0].recommendation).toBe('0000025_adapters.safetensors')
    expect(trainingCommandSchema.safeParse({ action: 'compare', model: model.name, jobId: job.id }).success).toBe(true)
  })
  it('rejects malformed independent evaluation rows without changing the training dataset', () => {
    const root = fixture(), service = new AcademyTraining(join(root, 'private'))
    service.registerCheckpoint(model, checkpoint(root))
    service.importDataset(model, dataset(root))
    const original = service.snapshot().profiles[0].datasetId
    expect(() => service.importEvaluationText(model, 'bad.jsonl', '{"track":"coding","prompt":"x"}')).toThrow('reference')
    expect(() => service.importEvaluationText(model, 'bad.jsonl', JSON.stringify({ track: 'coding', prompt: 'x', reference: 'solution' }))).toThrow('executable tests')
    expect(() => service.importEvaluationText(model, 'bad.jsonl', JSON.stringify({ track: 'coding', language: 'python', prompt: 'x', reference: 'solution', tests: [{ name: 'case', args: [], expected: 1 }] }))).toThrow('javascript only')
    expect(() => service.importEvaluationText(model, 'bad.jsonl', JSON.stringify({ track: 'git', prompt: 'x', reference: 'solution' }))).toThrow('required[]')
    expect(() => service.importEvaluationText(model, 'bad.txt', '{}')).toThrow('.jsonl')
    expect(service.snapshot().profiles[0].datasetId).toBe(original)
  })
})


describe('manual dataset isolation and provenance', () => {
  it('routes 52/6/7 independently, restores selections, and preserves old runs after replacing files', async () => {
    const root = fixture(), storage = join(root, 'private'), python = fakeRuntime(root)
    let service = new AcademyTraining(storage, python)
    await service.inspectRuntime(); service.registerCheckpoint(model, checkpoint(root))
    service.importDataset(model, dataset(root))
    const automatic = service.snapshot().profiles[0].datasetId
    importManual(service)
    expect(service.snapshot().profiles[0].datasetCounts).toEqual({ train: 52, valid: 6, test: 7 })
    const original = service.snapshot().profiles[0].datasetSelections!.manual!
    service = new AcademyTraining(storage, python)
    expect(service.snapshot().profiles[0].datasetSelections!.manual).toEqual(original)
    await service.inspectRuntime()
    const job = await service.train(model, 10, () => {})
    expect(job.stage).toBe('completed')
    expect(job.datasetProvenance).toMatchObject({ mode: 'manual', files: { train: { name: 'train.jsonl', count: 52 }, valid: { count: 6 }, test: { count: 7 } } })
    await service.compare(model, job.id, () => {})
    const comparison = service.snapshot().comparisons[0]
    expect(comparison.selectionBasis).toBe('validation')
    expect(comparison.variants.every(v => v.testLoss === undefined)).toBe(true)
    expect(comparison.examples).toEqual([])
    await service.evaluate(model, job.id, () => {})
    const inputs = readFileSync(join(root, 'runtime-inputs.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line) as { args: string[]; datasets: Record<string, Array<{ messages: Array<{ content: string }> }>> })
    const training = inputs.find(input => input.args.includes('--train'))!
    expect(Object.keys(training.datasets).sort()).toEqual(['train.jsonl', 'valid.jsonl'])
    expect(training.datasets['train.jsonl']).toHaveLength(52)
    expect(training.datasets['train.jsonl'].every(row => row.messages[0].content.startsWith('training'))).toBe(true)
    expect(training.datasets['valid.jsonl']).toHaveLength(6)
    expect(training.datasets['valid.jsonl'].every(row => row.messages[0].content.startsWith('validation'))).toBe(true)
    expect(training.args[training.args.indexOf('--val-batches') + 1]).toBe('-1')
    const comparisons = inputs.filter(input => input.args.includes('validation-only'))
    expect(comparisons).toHaveLength(2)
    for (const input of comparisons) { expect(Object.keys(input.datasets)).toEqual(['valid.jsonl']); expect(input.datasets['valid.jsonl']).toHaveLength(6) }
    const evaluation = inputs.find(input => input.args.includes('--test'))!
    expect(Object.keys(evaluation.datasets)).toEqual(['test.jsonl'])
    expect(evaluation.datasets['test.jsonl']).toHaveLength(7)
    expect(evaluation.datasets['test.jsonl'].every(row => row.messages[0].content.startsWith('testing'))).toBe(true)
    const history = service.snapshot().jobs, adapter = readFileSync(join(storage, 'jobs', job.id, 'adapters.safetensors'))
    service.importSplitText(model, 'test', 'replacement.jsonl', conversations('replacement', 8))
    expect(service.snapshot().jobs).toEqual(history)
    expect(readFileSync(join(storage, 'jobs', job.id, 'adapters.safetensors'))).toEqual(adapter)
    expect(readFileSync(join(storage, 'datasets', original.id, 'test.jsonl'), 'utf8').trim().split('\n')).toHaveLength(7)
    await service.evaluate(model, job.id, () => {})
    service.setDatasetMode(model, 'automatic')
    expect(service.snapshot().profiles[0].datasetId).toBe(automatic)
    expect(service.snapshot().profiles[0].datasetCounts).toEqual({ train: 16, valid: 2, test: 2 })
    service.setDatasetMode(model, 'manual')
    expect(service.snapshot().profiles[0].datasetCounts).toEqual({ train: 52, valid: 6, test: 8 })
    expect(new AcademyTraining(storage).snapshot().jobs).toEqual(service.snapshot().jobs)
  })
  it('rejects malformed messages and duplicates, and warns about similar prompts without replacing valid files', () => {
    const root = fixture(), service = new AcademyTraining(join(root, 'private'))
    importManual(service)
    const original = service.snapshot()
    const invalid = [
      ['{bad', 'Invalid JSONL'],
      [JSON.stringify({ messages: [{ role: 'user', content: 'question' }, { role: 'tool', content: 'answer' }] }), 'unsupported message role'],
      [JSON.stringify({ messages: [{ role: 'user', content: 'question' }, { role: 'assistant', content: ' ' }] }), 'nonempty'],
      [conversations('unique', 1) + '\n' + conversations('unique', 1), 'Duplicate'],
      [conversations('training', 1), 'overlap'],
    ]
    for (const [content, error] of invalid) expect(() => service.importSplitText(model, 'test', 'invalid.jsonl', content)).toThrow(error)
    expect(service.snapshot()).toEqual(original)
    service.importSplitText(model, 'train', 'train.jsonl', conversations('Explain how safely validating an incoming network request prevents unwanted changes', 1))
    service.importSplitText(model, 'valid', 'valid.jsonl', conversations('Explain how safely validating an incoming network request prevents unwanted errors', 1))
    expect(service.snapshot().profiles[0].datasetSelections!.manual!.warnings.join(' ')).toContain('Potential semantic overlap')
  })
  it('flags dataset changes during a run and preserves adapter files without recording completion', async () => {
    const root = fixture(), storage = join(root, 'private'), service = new AcademyTraining(storage, fakeRuntime(root))
    await service.inspectRuntime(); service.registerCheckpoint(model, checkpoint(root)); importManual(service)
    let changed = false
    const id = service.snapshot().profiles[0].datasetId!
    const job = await service.train(model, 10, progress => {
      if (!changed && progress.iteration === 5) {
        changed = true
        writeFileSync(join(storage, 'datasets', id, 'train.jsonl'), conversations('tampered', 52))
      }
    })
    expect(changed).toBe(true)
    expect(job.stage).toBe('failed')
    expect(job.datasetIntegrityError).toContain('identity changed')
    expect(job.adapterFiles).toContain('adapters.safetensors')
  })
  it('requires every manual split and rejects on-disk identity changes before training or evaluation', async () => {
    const root = fixture(), storage = join(root, 'private'), service = new AcademyTraining(storage, fakeRuntime(root))
    await service.inspectRuntime(); service.registerCheckpoint(model, checkpoint(root)); service.setDatasetMode(model, 'manual')
    service.importSplitText(model, 'train', 'train.jsonl', conversations('training', 52))
    await expect(service.train(model, 10, () => {})).rejects.toThrow('required valid')
    expect(service.snapshot().jobs).toHaveLength(0)
    service.importSplitText(model, 'valid', 'valid.jsonl', conversations('validation', 6))
    service.importSplitText(model, 'test', 'test.jsonl', conversations('testing', 7))
    const job = await service.train(model, 10, () => {})
    writeFileSync(join(storage, 'datasets', job.datasetId, 'test.jsonl'), conversations('changed', 7))
    await expect(service.evaluate(model, job.id, () => {})).rejects.toThrow('identity changed')
    expect(service.snapshot().jobs[0].datasetIntegrityError).toContain('identity changed')
    expect(new AcademyTraining(storage).snapshot().jobs[0].datasetIntegrityError).toContain('identity changed')
  })
})
