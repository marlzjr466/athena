/** Local context allocation. This is inference configuration, separate from Academy training. */

export const contextProfiles = [
  { id: 'standard', label: 'Standard', tokens: 32_768, yarnFactor: null },
  { id: 'extended', label: 'Extended', tokens: 65_536, yarnFactor: 2 },
  { id: 'long', label: 'Long', tokens: 131_072, yarnFactor: 4 },
  { id: 'experimental', label: 'Experimental', tokens: 196_608, yarnFactor: 6 },
  { id: 'maximum', label: 'Maximum', tokens: 250_000, yarnFactor: 250_000 / 32_768 },
] as const

export type ContextProfileId = (typeof contextProfiles)[number]['id']
export type ContextAllocationState = 'trained-window' | 'measured' | 'unmeasured' | 'fallback'

export interface ContextArchitecture {
  blocks: number
  kvHeads: number
  headDim: number
}

export interface ContextRopeScaling {
  type: string
  factor?: number
  originalContext?: number
}

export interface ContextRequest {
  requestedTokens: number
  reportedContextTokens?: number
  rope?: ContextRopeScaling
  engine: 'ollama' | 'mlx'
  /** Athena's MLX worker does not apply runtime YaRN. A checkpoint can still report scaling. */
  mlxAppliesYarn?: boolean
  architecture?: ContextArchitecture
  weightBytes?: number
  totalMemoryBytes: number
  freeMemoryBytes: number
  /** Highest context a live probe has already allocated for this model. */
  confirmedTokens?: number
  /** Set only after a long-context retrieval test passes. A short load does not qualify. */
  retrievalValidated?: boolean
  kvBytesPerElement?: number
}

export interface ContextDecision {
  profile: ContextProfileId
  requestedTokens: number
  trainedTokens: number
  allocatedTokens: number
  allocationState: ContextAllocationState
  experimental: boolean
  documentedYarn: boolean
  staticYarnInModel: boolean
  yarnRequired: boolean
  yarnFactor: number | null
  modelYarnFactor: number | null
  eligible: boolean
  memoryBytes: number | null
  weightBytes: number
  overheadBytes: number
  budgetBytes: number
  kvCache: 'f16-estimate' | 'unknown'
  flashAttention: 'not-reported'
  engine: 'ollama' | 'mlx'
  explanation: string
}

const gib = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GB`
const tokensLabel = (value: number) => value.toLocaleString('en-US')

export interface AllocationNotice {
  prominent: boolean
  status: string
  why: string
  missingCapability: string
  engine: string
  activeProfile: string
  measureAllowed: boolean
  measureReason: string
}

export function allocationNotice(decision: ContextDecision): AllocationNotice {
  const engine = decision.engine === 'mlx' ? 'MLX' : 'Ollama'
  const exact = contextProfiles.find((profile) => profile.tokens === decision.allocatedTokens)
  const activeProfile = exact ? `${exact.label} (${decision.allocatedTokens.toLocaleString('en-US')} tokens)` : decision.allocatedTokens <= decision.trainedTokens ? `Custom ${decision.allocatedTokens.toLocaleString('en-US')}-token window inside the trained context` : `${decision.allocatedTokens.toLocaleString('en-US')} tokens`
  const configured = contextProfiles.find((profile) => profile.id === decision.profile)?.label ?? decision.profile
  const measureAllowed = decision.requestedTokens <= decision.trainedTokens
  const measureReason = measureAllowed
    ? `This measures the ${decision.requestedTokens.toLocaleString('en-US')}-token window, which is within the trained context. It does not test 128K or 250K.`
    : `Measurement is disabled. ${decision.requestedTokens.toLocaleString('en-US')} tokens is above the trained ${decision.trainedTokens.toLocaleString('en-US')}-token window. Athena will not load it to test it.`
  if (!decision.yarnRequired) {
    return { prominent: false, status: allocationStatusLabel(decision), why: 'The configured window fits the trained context.', missingCapability: 'None. This request does not need YaRN.', engine, activeProfile, measureAllowed, measureReason }
  }
  const factorCovers = decision.modelYarnFactor !== null && decision.yarnFactor !== null && decision.modelYarnFactor + 1e-6 >= decision.yarnFactor
  let missingCapability: string
  let why: string
  if (decision.engine === 'mlx') {
    missingCapability = 'MLX runtime YaRN. Athena’s MLX worker does not apply YaRN.'
    why = `The configured ${configured} profile is above the checkpoint window. The MLX worker keeps the trained context and does not scale RoPE.`
  } else if (!decision.staticYarnInModel) {
    missingCapability = 'YaRN scaling in the loaded model. This card reports a trained context and RoPE base frequency, not a YaRN factor.'
    why = `The configured ${configured} profile cannot be allocated. Ollama does not enable YaRN by raising num_ctx, and this model card has no YaRN metadata.`
  } else if (!factorCovers) {
    missingCapability = 'A YaRN factor that covers the configured profile. The factor in the model card is too small.'
    why = `The configured ${configured} profile needs a larger YaRN factor than the model card contains. Card metadata is not a passing retrieval test.`
  } else if (!decision.eligible) {
    missingCapability = 'Enough memory for the estimated KV cache of the configured profile.'
    why = `The configured ${configured} profile fits the card’s YaRN factor on paper, and the memory estimate does not fit the current budget.`
  } else {
    missingCapability = 'A passed long-context retrieval test. YaRN metadata in the model file is not runtime support.'
    why = `The configured ${configured} profile stays unloaded. GGUF YaRN metadata does not prove that this engine can retrieve across that window.`
  }
  return { prominent: true, status: allocationStatusLabel(decision), why, missingCapability, engine, activeProfile, measureAllowed, measureReason }
}

export function allocationStatusLabel(decision: Pick<ContextDecision, 'allocationState' | 'requestedTokens' | 'allocatedTokens'>): string {
  if (decision.requestedTokens > decision.allocatedTokens && (decision.allocationState === 'fallback' || decision.allocationState === 'unmeasured')) {
    return decision.allocatedTokens === contextProfiles[0].tokens ? 'Falling back to Standard' : 'Falling back to the trained window'
  }
  if (decision.allocationState === 'measured' && decision.requestedTokens === decision.allocatedTokens) return 'Measured allocation is active'
  if (decision.requestedTokens === decision.allocatedTokens) return 'Configured context is active'
  return 'Trained window is active'
}

export function contextProfileFor(tokens: number): ContextProfileId {
  return contextProfiles.find((profile) => tokens <= profile.tokens)?.id ?? 'maximum'
}

export function estimateKvCacheBytes(architecture: ContextArchitecture, tokens: number, bytesPerElement = 2): number {
  return 2 * architecture.blocks * architecture.kvHeads * architecture.headDim * tokens * bytesPerElement
}

/** Qwen's published YaRN recipe: factor 4.0 stretches a 32,768-token Qwen2.5 model to 131,072. */
export function documentedYarnFactor(trainedTokens: number, requestedTokens: number): number | null {
  if (trainedTokens !== 32_768 || requestedTokens !== 131_072) return null
  return 4
}

export function resolveLocalContext(request: ContextRequest): ContextDecision {
  const reported = request.reportedContextTokens && request.reportedContextTokens > 0 ? Math.floor(request.reportedContextTokens) : 32_768
  const trainedTokens = request.rope?.type === 'yarn' && request.rope.originalContext && request.rope.originalContext > 0
    ? Math.floor(request.rope.originalContext)
    : reported
  const requestedTokens = Math.max(1, Math.floor(request.requestedTokens))
  const profile = contextProfileFor(requestedTokens)
  const staticYarnInModel = request.rope?.type === 'yarn'
  const modelYarnFactor = staticYarnInModel && request.rope?.factor && request.rope.factor > 1 ? request.rope.factor : null
  const yarnRequired = requestedTokens > trainedTokens
  const yarnFactor = yarnRequired ? requestedTokens / trainedTokens : null
  const documentedYarn = documentedYarnFactor(trainedTokens, requestedTokens) === 4
  const experimental = yarnRequired && !documentedYarn
  const bytesPerElement = request.kvBytesPerElement ?? 2
  const memoryBytes = request.architecture ? estimateKvCacheBytes(request.architecture, requestedTokens, bytesPerElement) : null
  const weightBytes = request.weightBytes && request.weightBytes > 0 ? request.weightBytes : 0
  const overheadBytes = Math.floor(1.5 * 1024 ** 3)
  const reserveBytes = Math.max(6 * 1024 ** 3, Math.floor(request.totalMemoryBytes * 0.25))
  const budgetBytes = Math.max(0, request.totalMemoryBytes - reserveBytes)
  const neededBytes = weightBytes + (memoryBytes ?? Number.POSITIVE_INFINITY) + overheadBytes
  // macOS reports little "free" memory while purgeable cache can still be reclaimed.
  // The hard gate is the total-memory budget. Very low free memory is reported, not treated as proof that a fitting estimate is impossible.
  const memoryAllows = memoryBytes !== null && neededBytes <= budgetBytes
  const memoryPressure = request.freeMemoryBytes < 2 * 1024 ** 3
  const runtimeCanScale = request.engine === 'ollama' || request.mlxAppliesYarn === true
  const yarnCovers = modelYarnFactor !== null && yarnFactor !== null && modelYarnFactor + 1e-6 >= yarnFactor
  const yarnOk = !yarnRequired || (runtimeCanScale && yarnCovers)
  const eligible = !yarnRequired || (yarnOk && memoryAllows)
  const confirmed = request.confirmedTokens !== undefined && request.confirmedTokens >= requestedTokens
  const retrievalValidated = request.retrievalValidated === true
  let allocationState: ContextAllocationState
  let allocatedTokens: number
  if (!yarnRequired) {
    allocatedTokens = requestedTokens
    allocationState = confirmed ? 'measured' : 'trained-window'
  } else if (eligible && confirmed && retrievalValidated) {
    allocatedTokens = requestedTokens
    allocationState = 'measured'
  } else if (eligible) {
    allocatedTokens = trainedTokens
    allocationState = 'unmeasured'
  } else {
    allocatedTokens = Math.min(requestedTokens, trainedTokens)
    allocationState = 'fallback'
  }
  return {
    profile, requestedTokens, trainedTokens, allocatedTokens, allocationState, experimental, documentedYarn, staticYarnInModel,
    yarnRequired, yarnFactor, modelYarnFactor, eligible, memoryBytes, weightBytes, overheadBytes, budgetBytes,
    kvCache: memoryBytes === null ? 'unknown' : 'f16-estimate', flashAttention: 'not-reported', engine: request.engine,
    explanation: explain({
      profile, requestedTokens, trainedTokens, allocatedTokens, allocationState, experimental, documentedYarn, staticYarnInModel,
      yarnRequired, yarnFactor, modelYarnFactor, memoryBytes, weightBytes, overheadBytes, budgetBytes, memoryAllows, memoryPressure,
      freeMemoryBytes: request.freeMemoryBytes, engine: request.engine, runtimeCanScale, yarnOk,
    }),
  }
}

function explain(input: {
  profile: ContextProfileId
  requestedTokens: number
  trainedTokens: number
  allocatedTokens: number
  allocationState: ContextAllocationState
  experimental: boolean
  documentedYarn: boolean
  staticYarnInModel: boolean
  yarnRequired: boolean
  yarnFactor: number | null
  modelYarnFactor: number | null
  memoryBytes: number | null
  weightBytes: number
  overheadBytes: number
  budgetBytes: number
  memoryAllows: boolean
  memoryPressure: boolean
  freeMemoryBytes: number
  engine: 'ollama' | 'mlx'
  runtimeCanScale: boolean
  yarnOk: boolean
}): string {
  const configured = `Configured context is ${tokensLabel(input.requestedTokens)} tokens (${contextProfiles.find((profile) => profile.id === input.profile)?.label ?? input.profile}).`
  const trained = `The model was trained for ${tokensLabel(input.trainedTokens)} tokens.`
  if (!input.yarnRequired) {
    const baked = input.staticYarnInModel ? ' This model file already contains static YaRN. Athena does not add a second scaling pass for a short request.' : ' YaRN is not applied.'
    return `${configured} ${trained} Athena allocates ${tokensLabel(input.allocatedTokens)} tokens.${baked}`
  }
  const factor = input.yarnFactor === null ? 'unknown' : input.yarnFactor.toFixed(2)
  const kind = input.documentedYarn
    ? `The documented Qwen YaRN configuration is factor 4.0, which stretches 32,768 tokens to 131,072.`
    : `This profile is experimental. Reaching it needs YaRN factor ${factor}, past the documented factor 4.0 / 128K recipe.`
  const cache = input.memoryBytes === null
    ? 'The model card did not include enough architecture data to estimate the KV cache.'
    : `Estimated fp16 KV cache is ${gib(input.memoryBytes)}, plus ${gib(input.weightBytes)} of weights and ${gib(input.overheadBytes)} of overhead. The safe budget is ${gib(input.budgetBytes)}.${input.memoryPressure ? ` Free memory is ${gib(input.freeMemoryBytes)}; macOS may reclaim cached memory before this fits.` : ''} Flash Attention and quantized KV cache were not reported.`
  if (!input.runtimeCanScale) return `${configured} ${trained} ${kind} ${cache} Athena's MLX runtime keeps the checkpoint context and does not apply YaRN. Allocated context is ${tokensLabel(input.allocatedTokens)} tokens. The original model was not modified.`
  if (!input.yarnOk) return `${configured} ${trained} ${kind} ${cache} This Ollama model card has no YaRN factor that covers the request. Setting num_ctx does not enable YaRN. Allocated context stays ${tokensLabel(input.allocatedTokens)} tokens. The installed model was not modified, and no second model was created.`
  if (!input.memoryAllows) return `${configured} ${trained} ${kind} ${cache} The estimate does not fit the current memory budget, so Athena did not allocate it.`
  if (input.allocationState === 'unmeasured') return `${configured} ${trained} ${kind} ${cache} YaRN metadata is not runtime support. No long-context retrieval test has passed, so Athena keeps allocating ${tokensLabel(input.allocatedTokens)} tokens.`
  return `${configured} ${trained} A long-context retrieval test passed for ${tokensLabel(input.allocatedTokens)} tokens. ${kind}`
}

export interface ContextNeedle { place: 'start' | 'middle' | 'end'; token: string }

/** Deterministic long-prompt fixture. Each whitespace-separated word is one test token. */
export function buildContextNeedle(tokens: number): { prompt: string; tokenCount: number; needles: ContextNeedle[] } {
  const count = Math.max(3, Math.floor(tokens))
  const words = Array.from({ length: count }, () => 'pad')
  const needles: ContextNeedle[] = [
    { place: 'start', token: 'needle-start-alpha' },
    { place: 'middle', token: 'needle-middle-bravo' },
    { place: 'end', token: 'needle-end-charlie' },
  ]
  words[0] = needles[0].token
  words[Math.floor((count - 1) / 2)] = needles[1].token
  words[count - 1] = needles[2].token
  return { prompt: words.join(' '), tokenCount: words.length, needles }
}

export function recallNeedles(answer: string, needles: readonly ContextNeedle[]): Array<ContextNeedle & { recalled: boolean }> {
  return needles.map((needle) => ({ ...needle, recalled: answer.includes(needle.token) }))
}
