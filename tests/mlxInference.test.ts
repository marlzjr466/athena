// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MLXInference } from '../electron/main/ai/mlxInference'
import { OllamaService, ndjson } from '../electron/main/ai/ollamaService'
import { localChatProvider } from '../electron/main/ai/localCompanion'
import { defaultSettings } from '../shared/settings'
import type { MLXActivationSource } from '../shared/mlxInference'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })))
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'athena-mlx-')); roots.push(root)
  const checkpointPath = join(root, 'source'); mkdirSync(checkpointPath)
  writeFileSync(join(checkpointPath, 'config.json'), JSON.stringify({ model_type: 'qwen2', num_hidden_layers: 8, max_position_embeddings: 32768 }))
  writeFileSync(join(checkpointPath, 'model.safetensors'), 'original checkpoint')
  writeFileSync(join(checkpointPath, 'tokenizer.json'), 'original tokenizer')
  const adapterPath = join(root, '0000100_adapters.safetensors'), adapterConfigPath = join(root, 'adapter_config.json')
  writeFileSync(adapterPath, 'original adapter')
  writeFileSync(adapterConfigPath, JSON.stringify({ model: checkpointPath, fine_tune_type: 'lora', num_layers: 8, lora_parameters: { rank: 8 } }))
  const source: MLXActivationSource = { checkpointPath, checkpointId: 'checkpoint', adapterPath, adapterConfigPath, adapterName: '0000100_adapters.safetensors', baseModel: 'qwen2.5-coder:3b', baseDigest: 'digest', jobId: 'job' }
  const python = join(root, 'python')
  writeFileSync(python, `#!/usr/bin/env node
let data=''; process.stdin.on('data', c=>data+=c); process.stdin.on('end',()=>{
const r=JSON.parse(data); const emit=v=>console.log(JSON.stringify(v));
if(r.verify){emit({verification:{baseResponse:'base',adapterResponse:'adapted',adapterTensorCount:112,logitDifference:1,toolsVerified:true},done:true});return;}
if(r.messages.some(m=>m.content==='slow')){emit({loaded:true});setTimeout(()=>{},10000);return;}
if(r.messages.some(m=>m.content==='error')){emit({error:'Exact tokenizer failure',errorType:'ValueError'});process.exitCode=1;return;}
if(r.tools && !r.messages.some(m=>m.role==='tool')){emit({message:{tool_calls:[{function:{name:'read_file',arguments:{path:'README.md'}}}]} });emit({done:true});return;}
emit({message:{content:r.messages.some(m=>m.role==='tool')?'Read verified content':'Hello adapted model'}});emit({done:true,done_reason:'stop',prompt_eval_count:10,eval_count:3});
});`)
  chmodSync(python, 0o700)
  const registry = join(root, 'registry'), mlx = new MLXInference(registry, python)
  const registration = await mlx.activate(source, source.baseModel)
  return { root, source, python, registry, mlx, registration }
}
describe('verified native MLX model integration', () => {
  it('persists separately, streams without HTTP fallback, and rejects changed tokenizers', async () => {
    const { source, registry, python, registration } = await fixture()
    const mlx = new MLXInference(registry, python)
    const http = vi.fn().mockRejectedValue(new Error('Ollama unavailable'))
    const service = new OllamaService(() => 'http://127.0.0.1:11434', http); service.mlx = mlx
    expect(await service.modelDetails(registration.id)).toMatchObject({ label: 'Athena Coder v2', provider: 'mlx', capabilities: ['completion', 'tools'] })
    const response = await service.call('api/chat', { model: registration.id, stream: true, messages: [{ role: 'user', content: 'Hi' }] })
    const events = []; for await (const event of ndjson(response)) events.push(event)
    expect(events).toContainEqual({ message: { content: 'Hello adapted model' } })
    expect(http).not.toHaveBeenCalled()
    expect(readFileSync(source.adapterPath, 'utf8')).toBe('original adapter')
    expect(mlx.list()[0].previousModel).toBe(source.baseModel)
    writeFileSync(join(source.checkpointPath, 'tokenizer.json'), 'changed tokenizer')
    await expect(service.call('api/chat', { model: registration.id, messages: [] })).rejects.toThrow('changed since activation')
    expect(mlx.status()[0]).toMatchObject({ status: 'error' })
    expect(http).not.toHaveBeenCalled()
  })
  it('uses existing conversation and authorized tool execution with actual tool results', async () => {
    const { mlx, registration } = await fixture()
    const service = new OllamaService(() => 'http://127.0.0.1:11434', vi.fn()); service.mlx = mlx
    const provider = await localChatProvider(service, defaultSettings, { model: registration.id, effort: 'auto' } as Parameters<typeof localChatProvider>[2])
    const execute = vi.fn(async () => 'verified README content'), assertAccess = vi.fn()
    const chunks = []
    for await (const chunk of provider.streamMessage([{ id: 'message', role: 'user', content: 'Use the available tool to open the README', createdAt: Date.now(), status: 'complete' }], { context: { authorizedProject: true, attachments: [], repositoryText: '', sources: [], projectTools: { definitions: [{ name: 'read_file', description: 'Read approved file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }], assertAccess, execute } } })) chunks.push(chunk)
    expect(execute).toHaveBeenCalledWith('read_file', { path: 'README.md' }, expect.any(AbortSignal))
    expect(assertAccess).toHaveBeenCalled()
    expect(chunks).toContainEqual({ type: 'text', text: 'Read verified content' })
  })
  it('cancels a worker, preserves the registration, and reports exact generation errors', async () => {
    const { mlx, registration } = await fixture()
    const abort = new AbortController()
    const response = await mlx.call({ model: registration.id, stream: true, messages: [{ role: 'user', content: 'slow' }] }, abort.signal)
    const reader = response.body!.getReader(); await reader.read(); abort.abort()
    await expect(reader.read()).rejects.toThrow()
    await vi.waitFor(() => expect(mlx.status()[0].status).toBe('idle'))
    const failure = await mlx.call({ model: registration.id, stream: true, messages: [{ role: 'user', content: 'error' }] })
    await expect(failure.text()).rejects.toThrow('Exact tokenizer failure')
    expect(mlx.list()).toHaveLength(1)
  })
  it('refuses incompatible configuration without replacing a verified registration', async () => {
    const { mlx, source, registration } = await fixture()
    writeFileSync(source.adapterConfigPath, JSON.stringify({ model: '/different/source', fine_tune_type: 'lora', lora_parameters: { rank: 8 } }))
    await expect(mlx.activate(source, source.baseModel)).rejects.toThrow('does not match')
    expect(mlx.list()[0]).toEqual(registration)
  })
})
