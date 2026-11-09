import type { CourseResult } from '../../../shared/academyCourses'
import { formatCourseScore } from '../../../shared/academyCourses'
import { AcademyStatus } from './AcademyDesign'

export function AcademyCourseResults({ results, busy, onRetry, onDelete }: {
  /** Newest attempt first, for one stage of one model version. */
  results: CourseResult[]; busy: boolean; onRetry?: (resultId: string, exerciseId: string) => void; onDelete?: (resultId: string) => void
}) {
  return <>{results.map((result, resultIndex) => {
    const assessed = result.stage === 'practical' || result.stage === 'evaluation'
    const retry = result.attemptKind === 'practice-retry'
    const failedExercises = new Set(result.checks.filter(check => !check.passed).map(check => check.exerciseId))
    return <details className="ac-result" key={result.id}>
      <summary><AcademyStatus tone={result.passed ? 'success' : 'danger'}>{assessed ? `${formatCourseScore(result.score)} · ${result.passed ? 'Passed' : 'Failed'}` : result.passed ? 'Completed' : 'Needs Review'}</AcademyStatus><time dateTime={result.completedAt}>{new Date(result.completedAt).toLocaleString()}</time></summary>
      {assessed && <p className="ac-attempt-label">{result.stage === 'evaluation' ? 'Independent final evaluation · all checks run afresh.' : retry ? 'Practice retry · retained results from other exercises. This is not an independent final evaluation.' : 'Practical training · full practice attempt, not a final evaluation.'}{result.threshold !== undefined && ` Passing threshold: ${formatCourseScore(result.threshold)}.`} {result.checks.filter(check => check.passed).length} / {result.checks.length} checks passed.</p>}
      {!result.passed && <p>Needs improvement: {result.checks.filter(check => !check.passed).map(check => check.name).join('; ')}.</p>}
      {result.checks.map((check, index) => {
        const checkStatus = check.status ?? (check.passed ? 'passed' : 'failed')
        const statusLabel = checkStatus === 'passed' ? 'Pass' : checkStatus === 'failed' ? 'Fail' : checkStatus === 'execution-error' ? 'Execution Error' : 'Not Run'
        const carried = Boolean(check.sourceResultId && check.sourceResultId !== result.id)
        const firstOfExercise = result.checks.findIndex(item => item.exerciseId === check.exerciseId) === index
        const canRetry = Boolean(onRetry && result.stage === 'practical' && resultIndex === 0 && check.exerciseId && firstOfExercise && failedExercises.has(check.exerciseId))
        return <details className="ac-check" key={`${check.exerciseId ?? check.name}-${index}`}>
          <summary className="ac-check-summary"><span>{check.name}</span><AcademyStatus tone={checkStatus === 'passed' ? 'success' : checkStatus === 'not-run' ? 'warning' : 'danger'}>{statusLabel}</AcademyStatus></summary>
          <article className="ac-exercise-report" aria-label={check.name}>
            <header><h3>{check.name}</h3><AcademyStatus tone={checkStatus === 'passed' ? 'success' : checkStatus === 'not-run' ? 'warning' : 'danger'}>{statusLabel}</AcademyStatus></header>
            {carried && <p className="ac-evidence-note">Retained from a previous attempt · not rerun{check.evaluatedAt && ` · ${new Date(check.evaluatedAt).toLocaleString()}`}</p>}
            {check.legacyMetadata && <p className="ac-evidence-note">Historical result: task details restored from the original exercise definition. The saved verdict and score have not been changed.</p>}
            {assessed ? <>
              <section><h4>Original question / task</h4><pre>{check.prompt ?? 'Not recorded in this historical result.'}</pre></section>
              <div className="ac-answer-comparison">
                <section><h4>Expected answer</h4><pre>{check.expectedAnswer ?? 'Not recorded in this historical result.'}</pre></section>
                <section><h4>Actual local model response</h4><pre>{check.response || 'No response was returned.'}</pre></section>
              </div>
              <section><h4>{check.passed ? 'Why it passed' : 'Reason for failure'}</h4><p>{check.reason ?? check.detail ?? 'No additional diagnostic details were saved.'}</p></section>
              <section><h4>Test execution details</h4><p>{check.execution?.details ?? check.detail ?? 'No execution details were saved.'}</p>
                {check.execution && <dl className="ac-execution-details">
                  {check.execution.input !== undefined && <><dt>Input arguments</dt><dd><code>{check.execution.input}</code></dd></>}
                  {check.execution.expectedOutput !== undefined && <><dt>Expected output</dt><dd><code>{check.execution.expectedOutput}</code></dd></>}
                  {check.execution.actualOutput !== undefined && <><dt>Actual output</dt><dd><code>{check.execution.actualOutput}</code></dd></>}
                  {check.execution.durationMs !== undefined && <><dt>Exercise execution time</dt><dd>{check.execution.durationMs.toLocaleString()} ms</dd></>}
                  {check.execution.error && <><dt>Execution error</dt><dd>{check.execution.error}</dd></>}
                </dl>}
                {check.execution?.code && check.execution.code.trim() !== check.response.trim() && <details><summary>Code executed in sandbox</summary><pre>{check.execution.code}</pre></details>}
              </section>
              <section><h4>Recommended improvements</h4>{check.recommendations?.length ? <ul>{check.recommendations.map((recommendation, i) => <li key={i}>{recommendation}</li>)}</ul> : <p>Review the task and recorded result against your approved learning sources.</p>}</section>
              {canRetry && <div className="ac-actions"><button className="button secondary" disabled={busy} onClick={() => onRetry?.(result.id, check.exerciseId!)}>Retry failed exercise</button><span>Only this exercise is regenerated. All tests of its new solution run together.</span></div>}
            </> : <>
              <p>{check.detail}</p>
              {check.prompt && <p>{check.prompt}</p>}
              <pre>{check.response}</pre>
              {check.reason && <p>{check.reason}</p>}
              {check.execution && <details><summary>View lesson evidence</summary><p>{check.execution.details}</p><pre>{check.execution.actualOutput}</pre>{check.execution.error && <p>{check.execution.error}</p>}</details>}
            </>}
          </article>
        </details>
      })}
      {result.evidence.length > 0 && <p>Evidence: {result.evidence.join(' · ')}</p>}
      {!result.passed && onDelete && <div className="ac-actions"><button className="button secondary" disabled={busy} onClick={() => onDelete(result.id)}>Delete failed result</button></div>}
    </details>
  })}</>
}
