import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { AcademyTraining } from '../electron/main/ai/academyTraining'
import { MLXInference } from '../electron/main/ai/mlxInference'

const [trainingDirectory, registryDirectory] = process.argv.slice(2)
if (!trainingDirectory || !registryDirectory) throw new Error('Supply training and MLX registry directories.')
const store = JSON.parse(readFileSync(join(trainingDirectory, 'training.json'), 'utf8'))
const profile = store.profiles.find((p: { model: string }) => p.model === 'qwen2.5-coder:3b')
if (!profile?.selectedJobId) throw new Error('Select a completed Qwen Coder job first.')
const academy = new AcademyTraining(trainingDirectory)
const source = academy.activationSource({ name: profile.model, digest: profile.modelDigest, family: profile.checkpointFamily, capabilities: ['completion'], size: 0 }, profile.selectedJobId, '0000100_adapters.safetensors')
const inference = new MLXInference(registryDirectory)
const model = await inference.activate(source, profile.model)
console.log(JSON.stringify({ id: model.id, label: model.label, checkpoint: source.checkpointPath, adapter: source.adapterName, verifiedAt: model.verifiedAt, adapterTensorCount: model.adapterTensorCount, logitDifference: model.logitDifference, toolsVerified: model.toolsVerified, baseResponse: model.baseResponse, adapterResponse: model.adapterResponse, diagnostics: inference.status() }, null, 2))
const response = await inference.call({ model: model.id, stream: true, messages: [{ role: 'user', content: 'Reply with a short greeting.' }], options: { num_predict: 32, temperature: 0 } })
console.log('REGISTERED_MODEL_STREAM:')
console.log(await response.text())
