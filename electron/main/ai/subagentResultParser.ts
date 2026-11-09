import { subagentResultSchema, type SubagentRequest, type SubagentResult, type SubagentResultDiagnostics } from '../../../shared/subagents'

type UnknownRecord = Record<string, unknown>
export type ParsedSubagentResult = { result?: SubagentResult; diagnostics: SubagentResultDiagnostics }

const text = (value: unknown): string => typeof value === 'string' ? value.trim() : ''
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : []
const stringList = (value: unknown): string[] => list(value).map(item => typeof item === 'string' ? item.trim() : '').filter(Boolean).slice(0, 40)
const severity = (value: unknown): 'info' | 'warning' | 'error' => {
  const normalized = text(value).toLowerCase()
  return normalized === 'error' || normalized === 'fail' || normalized === 'failure' ? 'error' : normalized === 'warning' || normalized === 'warn' ? 'warning' : 'info'
}

function references(value: unknown): string[] {
  return list(value).map(item => {
    if (typeof item === 'string') return item.trim()
    if (!item || typeof item !== 'object') return ''
    const entry = item as UnknownRecord
    const path = text(entry.path ?? entry.file ?? entry.filename)
    const start = entry.start ?? entry.line ?? entry.startLine
    const end = entry.end ?? entry.endLine
    if (!path) return ''
    if (typeof start === 'number' && typeof end === 'number' && end !== start) return `${path}:${start}-${end}`
    if (typeof start === 'number') return `${path}:${start}`
    return path
  }).filter(Boolean).slice(0, 40)
}

function findings(value: unknown): SubagentResult['findings'] {
  return list(value).map(item => {
    if (typeof item === 'string') return { severity: 'warning' as const, description: item.slice(0, 900), evidence: [] }
    if (!item || typeof item !== 'object') return null
    const entry = item as UnknownRecord
    const description = text(entry.description ?? entry.message ?? entry.finding)
    if (!description) return null
    return { severity: severity(entry.severity ?? entry.level), description: description.slice(0, 900), evidence: references(entry.evidence ?? entry.references ?? entry.files).slice(0, 4) }
  }).filter((item): item is SubagentResult['findings'][number] => !!item).slice(0, 30)
}

/** Extract complete JSON objects from prose/fenced output without trusting text as an assessment. */
function jsonCandidates(raw: string): UnknownRecord[] {
  const candidates: UnknownRecord[] = []
  for (let start = 0; start < raw.length; start++) {
    if (raw[start] !== '{') continue
    let depth = 0, quoted = false, escaped = false
    for (let index = start; index < raw.length; index++) {
      const character = raw[index]
      if (quoted) { if (escaped) escaped = false; else if (character === '\\') escaped = true; else if (character === '"') quoted = false; continue }
      if (character === '"') { quoted = true; continue }
      if (character === '{') depth++
      if (character === '}') depth--
      if (depth === 0) {
        try { const parsed: unknown = JSON.parse(raw.slice(start, index + 1)); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) candidates.push(parsed as UnknownRecord) } catch { /* Continue scanning for a later complete object. */ }
        break
      }
    }
  }
  return candidates
}

function normalized(value: UnknownRecord): { value: UnknownRecord; explicitAssessment: 'PASS' | 'FAIL' | 'INCOMPLETE' | null } {
  const rawStatus = text(value.assessment ?? value.status ?? (typeof value.pass === 'boolean' ? (value.pass ? 'PASS' : 'FAIL') : ''))
  const upper = rawStatus.toUpperCase()
  const explicitAssessment = upper === 'PASS' || upper === 'COMPLETED' || upper === 'APPROVED' ? 'PASS' : upper === 'FAIL' || upper === 'FAILED' || upper === 'REJECTED' ? 'FAIL' : upper === 'INCOMPLETE' || upper === 'BLOCKED' || upper === 'PARTIAL' ? 'INCOMPLETE' : null
  const checks = stringList(value.checksPerformed ?? value.checks ?? value.completedChecks)
  const evidence = references(value.evidence ?? value.references ?? value.fileReferences ?? value.citations)
  const files = [...stringList(value.filesReviewed ?? value.files ?? value.artifactsReviewed), ...references(value.fileReferences ?? value.references)].slice(0, 100)
  const normalizedValue: UnknownRecord = {
    status: explicitAssessment === 'PASS' ? 'completed' : 'blocked',
    assessment: explicitAssessment ?? undefined,
    summary: text(value.summary ?? value.assessmentSummary ?? value.conclusion) || (explicitAssessment === 'PASS' ? 'Independent review completed.' : explicitAssessment === 'FAIL' ? 'Independent review found blocking issues.' : 'Independent review is incomplete.'),
    findings: findings(value.findings ?? value.issues ?? value.gaps),
    blockers: stringList(value.blockers ?? value.blockingIssues),
    evidence,
    filesReviewed: files,
    checksPerformed: checks,
    limitations: stringList(value.limitations ?? value.knownLimitations),
    nextActions: stringList(value.nextActions ?? value.recommendedActions),
  }
  return { value: normalizedValue, explicitAssessment }
}

export function parseSubagentResult(raw: string, request: SubagentRequest): ParsedSubagentResult {
  const candidates = jsonCandidates(raw)
  const validationErrors: string[] = []
  const missingFields: string[] = []
  for (const candidate of candidates.reverse()) {
    const normalizedCandidate = normalized(candidate)
    // Balanced nested JSON objects (for example provider metadata) can look
    // like candidates. Do not treat an object without an explicit, recognized
    // assessment/status as a completed result merely because it can be filled
    // with defaults.
    if (!normalizedCandidate.explicitAssessment) {
      continue
    }
    const parsed = subagentResultSchema.safeParse(normalizedCandidate.value)
    if (!parsed.success) { validationErrors.push(...parsed.error.issues.slice(0, 4).map(issue => `${issue.path.join('.') || 'result'}: ${issue.message}`)); continue }
    const result = parsed.data
    const requiredEvidence = result.evidence.length > 0 || result.findings.some(finding => finding.evidence.length > 0)
    const completeChecks = result.checksPerformed.length > 0
    // The coordinator derives the authoritative reviewed-file list from the
    // successful read coverage. A child may therefore omit filesReviewed as a
    // safe equivalent, but it may never omit the concrete evidence/checks that
    // make an assessment auditable.
    const explicitPass = normalizedCandidate.explicitAssessment === 'PASS'
    const explicitFail = normalizedCandidate.explicitAssessment === 'FAIL'
    if (request.mode === 'cold_read' && (explicitPass || explicitFail || result.status === 'completed') && (!completeChecks || !requiredEvidence)) {
      if (!completeChecks) missingFields.push('checks/checksPerformed')
      if (!requiredEvidence) missingFields.push('evidence or file/line references')
      return { diagnostics: { validationErrors, missingFields, candidateCount: candidates.length, terminationReason: 'incomplete_review_missing_evidence' }, result: { ...result, status: 'blocked', assessment: 'INCOMPLETE', summary: 'Independent review incomplete: its assessment did not include the required checks and file/line evidence.', blockers: [...result.blockers, 'Required cold-read checks or file/line references are missing.'], limitations: [...result.limitations, `Missing required fields: ${missingFields.join(', ')}`] } }
    }
    // Older/concise children used status=completed without the optional
    // assessment field. Treat that as the unambiguous PASS equivalent only
    // after the auditable checks and evidence above have been validated.
    const completed = result.status === 'completed' && !result.assessment ? { ...result, assessment: 'PASS' as const } : result
    return { diagnostics: { validationErrors, missingFields, candidateCount: candidates.length, terminationReason: completed.status === 'completed' ? 'parsed_completed' : 'parsed_incomplete' }, result: completed }
  }
  missingFields.push('valid JSON result object', 'status or PASS/FAIL assessment', 'findings', 'checks/checksPerformed', 'file/line references')
  return { diagnostics: { validationErrors, missingFields, candidateCount: candidates.length, terminationReason: 'incomplete_review_malformed_output' } }
}
