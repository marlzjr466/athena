export interface EngineCheck {
  ollamaVersion: string | null
  ollamaConnected: boolean
  modelName: string | null
  modelHasYarn: boolean
  yarnFactor: number | null
  trainedTokens: number | null
  llamaVersion: string | null
  llamaYarnFlag: boolean
  vllmInstalled: boolean
}

export interface EngineFinding {
  engine: 'Ollama' | 'llama.cpp' | 'MLX' | 'vLLM'
  presence: string
  yarn: string
  chat: string
}

export function describeLocalEngines(check: EngineCheck): EngineFinding[] {
  const model = check.modelName ?? 'the selected model'
  const trained = check.trainedTokens ? `${check.trainedTokens.toLocaleString('en-US')} tokens` : 'its trained context'
  const ollamaYarn = check.modelHasYarn
    ? `${model} reports YaRN${check.yarnFactor ? ` factor ${check.yarnFactor}` : ''} in its model card. That metadata is not a passed retrieval test, so Athena does not allocate 128K or 250K.`
    : `${model} has no YaRN metadata. Its trained context is ${trained}. Raising num_ctx does not enable YaRN.`
  return [
    {
      engine: 'Ollama',
      presence: check.ollamaConnected ? `Running${check.ollamaVersion ? ` ${check.ollamaVersion}` : ''}.` : 'Not reachable.',
      yarn: ollamaYarn,
      chat: 'This is the engine Athena uses for local chat.',
    },
    {
      engine: 'llama.cpp',
      presence: check.llamaVersion ? `Installed (${check.llamaVersion}).` : 'Not installed in Homebrew.',
      yarn: check.llamaVersion && check.llamaYarnFlag
        ? 'This build accepts YaRN runtime flags. Retrieval results for the separate long-context model are listed in Context Capacity. A flag by itself is not a passing test.'
        : check.llamaVersion
          ? 'This build did not report a YaRN runtime flag. No long-context test was run.'
          : 'YaRN was not verified because llama.cpp is not installed.',
      chat: 'The separate long-context model can use llama-server. The original Ollama model stays on Ollama. A profile stays unavailable until its retrieval test passes.',
    },
    {
      engine: 'MLX',
      presence: 'Athena includes an MLX worker for verified qwen2 adapters. A separate mlx-lm server was not found on the default Python path.',
      yarn: 'The worker keeps the checkpoint context, at most 32,768 tokens, and does not apply YaRN.',
      chat: 'MLX is not the engine for the installed Ollama model.',
    },
    {
      engine: 'vLLM',
      presence: check.vllmInstalled ? 'A vLLM binary is installed.' : 'Not installed.',
      yarn: check.vllmInstalled ? 'YaRN was not verified. No model was loaded and no retrieval test was run.' : 'YaRN was not verified because vLLM is not installed. Its usual server path is NVIDIA CUDA.',
      chat: 'Athena does not send local chat through vLLM.',
    },
  ]
}

export function longContextModelNote(modelName: string | null): string {
  if (modelName === 'llama.cpp:qwen2.5-coder-3b') return 'This is a separate llama.cpp configuration. It reads the existing Qwen2.5-Coder GGUF and does not copy, overwrite, or modify qwen2.5-coder:3b. A profile stays unavailable until that length passes a load and retrieval benchmark.'
  const model = modelName ?? 'The selected model'
  return `${model} was not copied or modified. Long context uses the separate model llama.cpp:qwen2.5-coder-3b. An Ollama Modelfile cannot add YaRN to a GGUF that does not already contain it. A profile stays unavailable until its retrieval benchmark passes.`
}
