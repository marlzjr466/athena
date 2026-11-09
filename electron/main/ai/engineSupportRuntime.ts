import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { promisify } from 'node:util'
import { describeLocalEngines, longContextModelNote, type EngineFinding } from '../../../shared/engineSupport'
import type { LocalModel } from '../../../shared/localAI'
import type { OllamaService } from './ollamaService'

const run = promisify(execFile)
const llamaBinary = ['/opt/homebrew/bin/llama-cli', '/usr/local/bin/llama-cli'].find((path) => existsSync(path))
const vllmBinary = ['/opt/homebrew/bin/vllm', '/usr/local/bin/vllm'].find((path) => existsSync(path))

let cached: { at: number; findings: EngineFinding[]; note: string } | null = null

async function commandOutput(binary: string, args: string[]): Promise<string | null> {
  try {
    const { stdout, stderr } = await run(binary, args, { timeout: 5000, maxBuffer: 1_000_000 })
    return `${stdout}\n${stderr}`
  } catch { return null }
}

export async function localEngineReport(service: OllamaService, model: LocalModel | null, connected: boolean): Promise<{ findings: EngineFinding[]; note: string }> {
  if (cached && Date.now() - cached.at < 60_000 && cached.note.includes(model?.name ?? 'The selected model')) return cached
  const [ollamaVersion, llamaVersionText, llamaHelp] = await Promise.all([
    service.call('api/version', undefined, undefined, 3000).then(async (response) => {
      const body = await response.json() as { version?: string }
      return typeof body.version === 'string' ? body.version : null
    }).catch(() => null),
    llamaBinary ? commandOutput(llamaBinary, ['--version']) : Promise.resolve(null),
    llamaBinary ? commandOutput(llamaBinary, ['--help']) : Promise.resolve(null),
  ])
  const llamaVersion = llamaVersionText?.match(/version:\s*([0-9][^\s]*)/)?.[1] ?? (llamaVersionText ? 'installed' : null)
  const findings = describeLocalEngines({
    ollamaVersion,
    ollamaConnected: connected,
    modelName: model?.name ?? null,
    modelHasYarn: model?.ropeScaling?.type === 'yarn',
    yarnFactor: model?.ropeScaling?.factor ?? null,
    trainedTokens: model?.contextLength ?? null,
    llamaVersion,
    llamaYarnFlag: Boolean(llamaHelp?.includes('--rope-scaling') && llamaHelp.includes('yarn')),
    vllmInstalled: Boolean(vllmBinary),
  })
  const note = longContextModelNote(model?.name ?? null)
  cached = { at: Date.now(), findings, note }
  return cached
}
