// Filter the authenticated catalog, never invent model availability. Model IDs do
// not contain retirement metadata: this is a latest-generation display policy.
// Keep the newest release in each tier of the newest GPT generation, plus the
// current GPT-5.6 family when the authenticated account exposes it.
export function latestConversationModels(models: string[]): string[] {
  const parsed = [...new Set(models)].flatMap((id) => {
    const match = /^gpt-(\d+)(?:\.(\d+))?((?:-(?:astra|sol|terra|luna|mini|nano|pro))?)(?:-(\d{4}-\d{2}-\d{2}))?$/.exec(id)
    return match ? [{ id, major: Number(match[1]), minor: Number(match[2] ?? 0), tier: match[3], date: match[4] ?? '' }] : []
  })
  if (!parsed.length) return []
  const generation = Math.max(...parsed.map((model) => model.major))
  const latest = new Map<string, typeof parsed[number]>()
  for (const model of parsed.filter((entry) => entry.major === generation || (entry.major === 5 && entry.minor === 6))) {
    const family = model.major === 5 && model.minor === 6 ? '5.6' : String(model.major)
    const key = `${family}:${model.tier}`
    const previous = latest.get(key)
    if (!previous || model.minor > previous.minor || (model.minor === previous.minor && previous.date && (!model.date || model.date > previous.date))) latest.set(key, model)
  }
  const selected = [...latest.values()]
  const hasExplicitSol = selected.some((model) => model.id === 'gpt-5.6-sol')
  return selected.filter((model) => !(hasExplicitSol && model.id === 'gpt-5.6')).sort((a, b) => b.major - a.major || b.minor - a.minor || a.id.localeCompare(b.id)).map((model) => model.id)
}
