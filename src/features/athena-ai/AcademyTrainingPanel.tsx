import { useState } from 'react'
import { CustomSelect } from '../../components/ui/CustomSelect'
import { type EvaluationComparison, type EvaluationExample, type EvaluationVariant } from '../../../shared/academyTraining'

const percent = (value: number) => `${Math.round(value * 100)}%`
export const benchmarkFormat = [
  { track: 'coding', language: 'javascript', prompt: 'Write JavaScript function solve(a, b) that adds two integers.', reference: 'Return a + b.', tests: [{ name: 'positive', args: [1, 2], expected: 3 }, { name: 'negative', args: [-2, 1], expected: -1 }] },
  { track: 'git', prompt: 'How would you inspect changes before committing?', reference: 'Check status and review the diff.', required: ['git status', 'git diff'], forbidden: ['force push'] },
  { track: 'jira', prompt: 'What should a completion report include?', reference: 'Acceptance criteria and test evidence.', required: ['acceptance criteria', 'test evidence'] },
].map(row => JSON.stringify(row)).join('\n')
function ReviewControls({ example, variantId, onReview }: { example: EvaluationExample; variantId: string; onReview: (exampleId: string, variantId: string, decision: 'pass' | 'fail' | 'needs-review' | 'reset', note: string) => void }) {
  const [note, setNote] = useState(example.reviews?.[variantId]?.note ?? '')
  const current = example.reviews?.[variantId]
  return <div className="academy-manual-review"><p className="chat-message-note">Automatic result: {example.judgements?.[variantId]?.status ?? (example.correct[variantId] ? 'pass' : 'fail')} · {example.judgements?.[variantId]?.reason ?? 'Legacy exact-match score.'}</p>
    {example.judgements?.[variantId]?.cases?.map(test => <p className="chat-message-note" key={test.name}>{test.passed ? 'Pass' : 'Fail'} · {test.name}: {test.detail}</p>)}
    <label>Manual review note <input value={note} maxLength={1000} onChange={event => setNote(event.target.value)} placeholder="Why this answer passes or fails" /></label>
    <div className="academy-review-buttons"><button type="button" className="button secondary" onClick={() => onReview(example.id, variantId, 'pass', note)}>Mark pass</button><button type="button" className="button secondary" onClick={() => onReview(example.id, variantId, 'fail', note)}>Mark fail</button><button type="button" className="button secondary" onClick={() => onReview(example.id, variantId, 'needs-review', note)}>Needs review</button>{current && <button type="button" className="button secondary" onClick={() => onReview(example.id, variantId, 'reset', '')}>Clear review</button>}</div>
    {current && <p className="chat-message-note">Reviewed {current.decision} · {current.note || 'No note'} · {new Date(current.reviewedAt).toLocaleString()}</p>}
  </div>
}
export function ComparisonResults({ result, selectedAdapter, onReview }: { result: EvaluationComparison; selectedAdapter?: string; onReview: (exampleId: string, variantId: string, decision: 'pass' | 'fail' | 'needs-review' | 'reset', note: string) => void }) {
  const [reviewId, setReviewId] = useState(selectedAdapter ?? result.variants[1]?.id ?? '')
  const [limit, setLimit] = useState(20)
  const base = result.variants[0]
  const reviewed = result.variants.find(variant => variant.id === reviewId) ?? result.variants[1]
  const delta = (value: number, original: number) => `${value - original > 0 ? '+' : ''}${(value - original).toFixed(3)}`
  const score = (variant: EvaluationVariant, track: 'coding' | 'git' | 'jira') => {
    const item = variant.taskScores[track]
    if (!item.total) return 'Not measured'
    const difference = variant === base ? '' : ` · ${item.rate > base.taskScores[track].rate ? 'improved' : item.rate < base.taskScores[track].rate ? 'regressed' : 'unchanged'} ${(item.rate - base.taskScores[track].rate) * 100 >= 0 ? '+' : ''}${Math.round((item.rate - base.taskScores[track].rate) * 100)} pp`
    return `${percent(item.rate)} (${item.correct}/${item.total}${item.needsReview ? `; ${item.needsReview} need review` : ''}; 95% interval ${percent(item.low)}–${percent(item.high)})${difference}`
  }
  return <div className="academy-training-comparison">
    <p className="chat-message-note">Same source tokenizer, independent tasks, and held-out split for every row · 1,024-token loss window · greedy answers capped at {result.settings.maxOutputTokens} tokens · lower loss is better · no retraining or deployment.</p>
    <div className="academy-comparison-scroll"><table><thead><tr><th>Model</th><th>Validation loss</th><th>Held-out test loss</th><th>AI Coding</th><th>Git</th><th>Jira</th></tr></thead><tbody>
      {result.variants.map(variant => <tr key={variant.id}><th>{variant.label}{result.recommendation === variant.id ? ' · recommended for review' : ''}</th><td>{variant.validationLoss.toFixed(3)}{variant !== base ? ` (${delta(variant.validationLoss, base.validationLoss)})` : ''}</td><td>{variant.testLoss?.toFixed(3) ?? 'Reserved for final evaluation'}{variant !== base && variant.testLoss !== undefined && base.testLoss !== undefined ? ` (${delta(variant.testLoss, base.testLoss)})` : ''}</td><td>{score(variant, 'coding')}</td><td>{score(variant, 'git')}</td><td>{score(variant, 'jira')}</td></tr>)}
    </tbody></table></div>
    {result.examples.length > 0 && <div className="academy-benchmark-charts" aria-label="Task correctness by checkpoint">{(['coding', 'git', 'jira'] as const).map(track => <div className="academy-benchmark-chart" key={track}>
      <h4>{track === 'coding' ? 'AI Coding' : track === 'git' ? 'Git Intelligence' : 'Jira Intelligence'}</h4>
      {result.variants.map(variant => {
        const item = variant.taskScores[track]
        const difference = variant.id === 'base' ? '' : ` (${(item.rate - base.taskScores[track].rate) * 100 >= 0 ? '+' : ''}${Math.round((item.rate - base.taskScores[track].rate) * 100)} pp)`
        return <div className="academy-benchmark-row" key={variant.id}><span title={variant.label}>{variant.label}</span><div className="academy-benchmark-track"><div className={item.rate < base.taskScores[track].rate ? 'academy-benchmark-fill regression' : 'academy-benchmark-fill'} style={{ width: `${Math.round(item.rate * 100)}%` }} /></div><strong>{item.total ? `${percent(item.rate)}${difference}` : 'N/A'}</strong></div>
      })}
    </div>)}</div>}
    {result.warnings.map(warning => <p className="chat-message-note" key={warning}>{warning}</p>)}
    {result.examples.length > 0 && reviewed && <>
      <div className="academy-inline-actions"><span>Review base answers beside</span><CustomSelect ariaLabel="Checkpoint to review against the base model" value={reviewed.id} options={result.variants.slice(1).map(variant => ({ value: variant.id, label: variant.label }))} onChange={setReviewId} /></div>
      <p className="chat-message-note">Coding runs supplied tests in an isolated local process. Git/Jira check reference facts; ambiguous wording needs manual review. These checks cannot establish broad real-world correctness.</p>
      {result.examples.slice(0, limit).map(example => <details className="academy-studio-record" key={example.id}><summary>{example.track.toUpperCase()} · Example {example.id} · Base {example.reviews?.base?.decision ?? example.judgements?.base?.status ?? (example.correct.base ? 'pass' : 'fail')} · {reviewed.label} {example.reviews?.[reviewed.id]?.decision ?? example.judgements?.[reviewed.id]?.status ?? (example.correct[reviewed.id] ? 'pass' : 'fail')}</summary><p>{example.prompt}</p><p className="chat-message-note">Reference: {example.expected.join(' / ')}{example.required?.length ? ` · Required: ${example.required.join('; ')}` : ''}{example.forbidden?.length ? ` · Forbidden: ${example.forbidden.join('; ')}` : ''}</p><div className="academy-answer-grid"><div><strong>Original base</strong><pre>{example.answers.base}</pre><ReviewControls example={example} variantId="base" onReview={onReview} /></div><div><strong>{reviewed.label}</strong><pre>{example.answers[reviewed.id]}</pre><ReviewControls key={reviewed.id} example={example} variantId={reviewed.id} onReview={onReview} /></div></div></details>)}
      {limit < result.examples.length && <button type="button" className="button secondary" onClick={() => setLimit(value => value + 20)}>Show 20 more answers</button>}
    </>}
  </div>
}

export { AcademyFineTuningView as AcademyTrainingPanel } from './AcademyFineTuningView'
