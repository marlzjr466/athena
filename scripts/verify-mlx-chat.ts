import { readFileSync } from 'node:fs'
import { MLXInference } from '../electron/main/ai/mlxInference'
import { OllamaService } from '../electron/main/ai/ollamaService'
import { localChatProvider } from '../electron/main/ai/localCompanion'
import { defaultSettings } from '../shared/settings'
const mlx = new MLXInference(process.argv[2])
const service = new OllamaService(() => 'http://127.0.0.1:11434'); service.mlx = mlx
const model = mlx.list()[0]
if (!model?.toolsVerified) throw new Error('Structured tool-call probe has not passed.')
const provider = await localChatProvider(service, { ...defaultSettings, localAI: { ...defaultSettings.localAI, model: model.id, maxOutputTokens: 256, temperature: 0 } }, { model: model.id, effort: 'auto' } as Parameters<typeof localChatProvider>[2])
let calls = 0, answer = ''
for await (const event of provider.streamMessage([{ id: 'request', role: 'user', content: 'Call read_file with path "README.md". Then quote the tool result.', createdAt: Date.now(), status: 'complete' }], { context: { attachments: [], repositoryText: '', sources: [], projectName: 'Athena verification fixture', projectTools: {
  definitions: [{ name: 'read_file', description: 'Read the authorized README.md file.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }],
  assertAccess() {},
  async execute(name, input) { if (name !== 'read_file' || (input as { path: string }).path !== 'README.md') throw new Error('Only README.md is authorized for this probe.'); calls++; return readFileSync('docs/academy-finetuning-datasets.md', 'utf8').split('\n')[0] },
} } })) if (event.type === 'text') answer += event.text
const toolUseVerified = calls > 0 && answer.includes('Fine-tuning dataset modes')
const abort = new AbortController()
const response = await mlx.call({ model: model.id, stream: true, messages: [{ role: 'user', content: 'Write a long explanation of recursion.' }] }, abort.signal)
const reader = response.body!.getReader(); await reader.read(); abort.abort()
try { await reader.read(); throw new Error('Expected cancellation') } catch (error) { if (String(error).includes('Expected cancellation')) throw error }
console.log(JSON.stringify({ model: model.label, nativeToolCalls: calls, toolUseVerified, response: answer, cancellationVerified: true, diagnostics: mlx.status() }, null, 2))
