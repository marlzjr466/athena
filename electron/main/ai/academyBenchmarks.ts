import type { EvaluationComparison, EvaluationExample, EvaluationJudgement, EvaluationTrack, EvaluationVariant } from '../../../shared/academyTraining'

export const evaluationTracks: EvaluationTrack[] = ['coding', 'git', 'jira']
export const noRecommendationWarning = 'No checkpoint has a verified task-correctness improvement with non-worse held-out loss across all three tracks. Review ambiguous answers; no adapter was deployed.'
export const normalizeReference = (value: string) => value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en')

export function scoreReference(example: EvaluationExample, answer: string): EvaluationJudgement {
  const normalized = normalizeReference(answer)
  if (!normalized) return { status: 'fail', reason: 'The model returned an empty answer.' }
  if (example.required?.length) {
    const missing = example.required.filter(phrase => !normalized.includes(normalizeReference(phrase)))
    const forbidden = (example.forbidden ?? []).filter(phrase => normalized.includes(normalizeReference(phrase)))
    if (missing.length || forbidden.length) return { status: 'fail', reason: [missing.length ? `Missing reference facts: ${missing.join('; ')}` : '', forbidden.length ? `Prohibited claims: ${forbidden.join('; ')}` : ''].filter(Boolean).join('. ') }
    return { status: 'pass', reason: 'All required reference facts were present; no prohibited claims were found. Review meaning manually where wording is ambiguous.' }
  }
  const matched = example.expected.some(reference => normalizeReference(reference) === normalized)
  return { status: matched ? 'pass' : 'needs-review', reason: matched ? 'Answer matches a reference answer.' : 'Answer differs from the reference; manual semantic review is needed.' }
}

function interval(correct: number, total: number): { low: number; high: number } {
  if (!total) return { low: 0, high: 1 }
  const z = 1.96, p = correct / total, den = 1 + z * z / total
  const center = (p + z * z / (2 * total)) / den
  const range = z * Math.sqrt(p * (1 - p) / total + z * z / (4 * total * total)) / den
  return { low: Math.max(0, center - range), high: Math.min(1, center + range) }
}

export function effectiveStatus(example: EvaluationExample, variantId: string): EvaluationJudgement['status'] {
  return example.reviews?.[variantId]?.decision ?? example.judgements?.[variantId]?.status ?? (example.correct[variantId] ? 'pass' : 'fail')
}

export function refreshComparison(comparison: EvaluationComparison): void {
  comparison.warnings = comparison.warnings.filter(warning => warning !== noRecommendationWarning)
  for (const variant of comparison.variants) {
    for (const track of evaluationTracks) {
      const rows = comparison.examples.filter(example => example.track === track)
      const correct = rows.filter(example => effectiveStatus(example, variant.id) === 'pass').length
      const needsReview = rows.filter(example => effectiveStatus(example, variant.id) === 'needs-review').length
      variant.taskScores[track] = { correct, total: rows.length, rate: rows.length ? correct / rows.length : 0, ...interval(correct, rows.length), needsReview }
      for (const row of rows) row.correct[variant.id] = effectiveStatus(row, variant.id) === 'pass'
    }
  }
  comparison.recommendation = undefined
  if (comparison.selectionBasis === 'validation') {
    comparison.recommendation = comparison.variants.filter(v => v.id !== 'base' && Number.isFinite(v.validationLoss)).sort((a, b) => a.validationLoss - b.validationLoss)[0]?.id
    return
  }
  const base = comparison.variants.find(variant => variant.id === 'base')
  if (!comparison.evaluationDatasetId || !base || evaluationTracks.some(track => !base.taskScores[track].total) || comparison.examples.some(example => example.track === 'coding' && !example.tests?.length)) {
    comparison.warnings.push(noRecommendationWarning)
    return
  }
  const macro = (variant: EvaluationVariant) => evaluationTracks.reduce((sum, track) => sum + variant.taskScores[track].rate, 0) / evaluationTracks.length
  const baseMacro = macro(base)
  const candidates = comparison.variants.filter(variant => variant.id !== 'base' && evaluationTracks.every(track => variant.taskScores[track].needsReview === 0))
    .filter(variant => macro(variant) > baseMacro && (variant.testLoss ?? Infinity) <= (base.testLoss ?? -Infinity))
    .sort((a, b) => macro(b) - macro(a) || (a.testLoss ?? Infinity) - (b.testLoss ?? Infinity))
  if (evaluationTracks.every(track => base.taskScores[track].needsReview === 0)) comparison.recommendation = candidates[0]?.id
  if (!comparison.recommendation) comparison.warnings.push(noRecommendationWarning)
}
