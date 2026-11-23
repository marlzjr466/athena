/** OpenAI API catalog policy. IDs and account availability always come from
 * the authenticated /v1/models response; this only filters and orders them. */
interface ParsedGPTModel { id: string; major: number; minor: number; patch: number; variant: string; snapshot: boolean }

const nonChatVariant = /(?:^|-)(?:audio|realtime|transcri(?:be|ption)|tts|speech|image|images|embedding|embeddings|embed|moderation|search|deep-research|video|safety|guard|classifier|rerank|grader|eval|deprecated|legacy)(?:-|$)/i

function parseGPTModel(id: string): ParsedGPTModel | null {
  // Require an unambiguous numeric generation (and optional numeric minor and patch).
  // Suffixes are preserved, while known task-specific non-chat families are
  // excluded below. Fine-tuned IDs, aliases without versions and other model
  // families do not match.
  const match = /^gpt-(0|[1-9]\d*)(?:\.(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?)?(?:-([a-z0-9][a-z0-9._-]*))?$/i.exec(id)
  if (!match) return null
  const major = Number(match[1])
  const minor = Number(match[2] ?? 0)
  const patch = Number(match[3] ?? 0)
  const variant = match[4] ?? ''
  if (nonChatVariant.test(variant)) return null
  return { id, major, minor, patch, variant, snapshot: /(?:^|-)\d{4}-\d{2}-\d{2}$/.test(variant) }
}

export function isSelectableOpenAIAPIGptModel(id: string): boolean {
  const model = parseGPTModel(id)
  return Boolean(model && (model.major > 5 || model.major === 5 && model.minor >= 6))
}

export function isAvailableOpenAIAPIGptModel(id: string, availableModels: readonly string[]): boolean {
  return isSelectableOpenAIAPIGptModel(id) && availableModels.includes(id)
}

function compareVariant(a: ParsedGPTModel, b: ParsedGPTModel): number {
  // Keep the stable family alias first, then variants in a repeatable order;
  // dated snapshots follow aliases for the same variant family.
  if (!a.variant || !b.variant) return a.variant ? 1 : b.variant ? -1 : 0
  if (a.snapshot !== b.snapshot) return a.snapshot ? 1 : -1
  const aFamily = a.variant.replace(/-\d{4}-\d{2}-\d{2}$/, '')
  const bFamily = b.variant.replace(/-\d{4}-\d{2}-\d{2}$/, '')
  const family = aFamily.localeCompare(bFamily, 'en', { numeric: true, sensitivity: 'base' })
  if (family) return family
  return b.variant.localeCompare(a.variant, 'en', { numeric: true, sensitivity: 'base' })
}

/** Returns every eligible live GPT model, de-duplicated and newest generation first. */
export function openAIAPIGptModels(models: readonly string[]): string[] {
  const parsed = new Map<string, ParsedGPTModel>()
  for (const id of models) {
    const model = parseGPTModel(id)
    if (model && (model.major > 5 || model.major === 5 && model.minor >= 6)) parsed.set(id, model)
  }
  return [...parsed.values()]
    .sort((a, b) => b.major - a.major || b.minor - a.minor || b.patch - a.patch || compareVariant(a, b) || a.id.localeCompare(b.id))
    .map(model => model.id)
}
