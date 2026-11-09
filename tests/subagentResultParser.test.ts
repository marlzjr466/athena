// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { access, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseSubagentResult } from '../electron/main/ai/subagentResultParser'
import { subagentRequestSchema } from '../shared/subagents'

const request = subagentRequestSchema.parse({
  taskKey: 'mbm-11400-cold-read',
  role: 'Independent cold-read reviewer',
  task: 'Review the explicitly selected artifacts.',
  criteria: 'Check every required criterion and cite concrete evidence.',
  mode: 'cold_read',
  files: ['docs/tickets/MBM-11400/define.md', 'docs/tickets/MBM-11400/tds.md', 'skills/platform-spec/prompt.md'],
})

const mbmRoot = process.env.ATHENA_MBM_ROOT ?? '/Users/mariojrlangomez/Desktop/projects/mbtc/web/map-governance-ui'
const mbmFiles = ['docs/tickets/MBM-11400/artifacts/define.md', 'docs/tickets/MBM-11400/artifacts/tds-azure-devops-trace.md', 'skills/platform-spec/prompt.md']
const existingMbmFiles = await Promise.all(mbmFiles.map(async (file) => { try { await access(join(mbmRoot, file)); return true } catch { return false } }))

describe('independent sub-agent result parsing', () => {
  it.skipIf(!existingMbmFiles.every(Boolean))('accepts a focused cold-read assessment grounded in the existing MBM-11400 artifacts', async () => {
    const contents = await Promise.all(mbmFiles.map((file) => readFile(join(mbmRoot, file), 'utf8')))
    const evidence = mbmFiles.map((file, index) => `${file}:1-${Math.max(1, contents[index].split('\n').length)}`)
    const focusedRequest = subagentRequestSchema.parse({ ...request, files: mbmFiles })
    const parsed = parseSubagentResult(JSON.stringify({
      status: 'completed', assessment: 'PASS', summary: 'The selected MBM-11400 artifacts were independently reviewed.', findings: [], blockers: [], evidence,
      filesReviewed: mbmFiles, checksPerformed: ['Read each explicitly selected MBM-11400 artifact and compared it with the declared criteria'], limitations: [], nextActions: [],
    }), focusedRequest)
    expect(parsed.result?.assessment).toBe('PASS')
    expect(parsed.result?.filesReviewed).toEqual(mbmFiles)
    expect(parsed.diagnostics.terminationReason).toBe('parsed_completed')
  })

  it('accepts a valid PASS result and ignores harmless provider metadata', () => {
    const parsed = parseSubagentResult(JSON.stringify({
      status: 'completed', assessment: 'PASS', summary: 'All selected artifacts satisfy the review criteria.',
      findings: [], blockers: [], evidence: ['docs/tickets/MBM-11400/define.md:12-18'], filesReviewed: ['docs/tickets/MBM-11400/define.md'],
      checksPerformed: ['Compared the acceptance criteria with the selected artifact'], limitations: [], nextActions: [], provider_metadata: { request_id: 'fixture' },
    }), request)
    expect(parsed.result?.assessment).toBe('PASS')
    expect(parsed.result?.status).toBe('completed')
    expect(parsed.diagnostics.terminationReason).toBe('parsed_completed')
    expect(parsed.diagnostics.validationErrors).toEqual([])
  })

  it('accepts a valid FAIL result with findings and references', () => {
    const parsed = parseSubagentResult(JSON.stringify({
      status: 'blocked', assessment: 'FAIL', summary: 'One criterion is contradicted by the artifact.',
      findings: [{ severity: 'error', description: 'The failure state is not specified.', evidence: ['docs/tickets/MBM-11400/define.md:44'] }],
      blockers: ['The missing contract must be clarified.'], evidence: ['docs/tickets/MBM-11400/define.md:44'], filesReviewed: ['docs/tickets/MBM-11400/define.md'],
      checksPerformed: ['Checked the failure-state requirement'], limitations: [], nextActions: ['Clarify the contract'],
    }), request)
    expect(parsed.result?.assessment).toBe('FAIL')
    expect(parsed.result?.status).toBe('blocked')
    expect(parsed.result?.findings).toHaveLength(1)
  })

  it('returns a structured INCOMPLETE result when the assessment has no auditable evidence', () => {
    const parsed = parseSubagentResult(JSON.stringify({
      status: 'completed', assessment: 'PASS', summary: 'Looks good.', findings: [], blockers: [], evidence: [], filesReviewed: [],
      checksPerformed: [], limitations: [], nextActions: [],
    }), request)
    expect(parsed.result?.assessment).toBe('INCOMPLETE')
    expect(parsed.result?.status).toBe('blocked')
    expect(parsed.diagnostics.terminationReason).toBe('incomplete_review_missing_evidence')
    expect(parsed.diagnostics.missingFields).toEqual(expect.arrayContaining(['checks/checksPerformed', 'evidence or file/line references']))
  })

  it('does not turn prose or an ambiguous response into PASS', () => {
    const parsed = parseSubagentResult('Everything passed. I reviewed the files.', request)
    expect(parsed.result).toBeUndefined()
    expect(parsed.diagnostics.terminationReason).toBe('incomplete_review_malformed_output')
    expect(parsed.diagnostics.missingFields).toEqual(expect.arrayContaining(['valid JSON result object', 'file/line references']))
  })
})
