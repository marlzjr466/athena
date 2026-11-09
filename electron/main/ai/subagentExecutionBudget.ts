import { createHash } from 'node:crypto'
import type { SubagentRun, SubagentSettings } from '../../../shared/subagents'
import { ChatError } from './AIProvider'

/** Child-local lifetime counters; independent of parent rounds and provider batches. */
export class SubagentExecutionBudget {
  readonly state
  private finishing = false
  private results = new Set<string>()
  constructor(private run: SubagentRun, settings: SubagentSettings) {
    const previous = run.executionBudget
    this.state = run.executionBudget = {
      configuredIterations: settings.maxIterations, requestedIterations: run.request.maxIterations ?? null,
      effectiveIterations: Math.min(settings.maxIterations, run.request.maxIterations ?? Infinity, previous?.effectiveIterations ?? Infinity),
      configuredToolCalls: settings.maxToolCalls, requestedToolCalls: run.request.maxToolCalls ?? null,
      effectiveToolCalls: Math.min(settings.maxToolCalls, run.request.maxToolCalls ?? Infinity, previous?.effectiveToolCalls ?? Infinity),
      remainingIterations: 0, remainingToolCalls: 0,
      deferredToolCalls: previous?.deferredToolCalls ?? 0, repeatedResults: previous?.repeatedResults ?? 0,
      noProgressCalls: previous?.noProgressCalls ?? 0, finalization: previous?.finalization, lastBatch: previous?.lastBatch,
    }
    // Continuations only have their retained observations, not a hidden copy of
    // evicted raw evidence. Do not certify coverage that is no longer supplied.
    if (run.attempts > 1) {
      run.readCoverage = {}
      for (const observation of run.observations) this.coverage(observation.tool, observation.output)
    }
    for (const observation of run.observations) this.results.add(this.digest(observation.tool, observation.output))
    this.sync()
  }
  sync(): void {
    this.state.remainingIterations = Math.max(0, this.state.effectiveIterations - this.run.iterations)
    this.state.remainingToolCalls = Math.max(0, this.state.effectiveToolCalls - this.run.toolCalls)
  }
  private finalize(reason: NonNullable<typeof this.state.finalization>['reason'], message: string): void {
    this.state.finalization ??= { reason, message }
  }
  prepareRequest(): { finalize: boolean; instruction: string } {
    this.sync()
    if (!this.state.remainingIterations) throw new ChatError('Sub-agent iteration budget reached. No additional model request is authorized; observations remain saved.')
    if (!this.state.remainingToolCalls) this.finalize('tools', 'Tool-call allowance consumed. Returning a final assessment without tools.')
    if (this.state.remainingIterations === 1) this.finalize('iterations', 'The last model-request slot is reserved for a final assessment without tools.')
    this.finishing = Boolean(this.state.finalization)
    return { finalize: this.finishing, instruction: `Child budget: ${this.run.toolCalls}/${this.state.effectiveToolCalls} tool attempts (${this.state.remainingToolCalls} left), ${this.run.iterations}/${this.state.effectiveIterations} model requests. One request slot is reserved for your final JSON assessment. Each call in a batch consumes one slot. Read pagination must follow the ACTUAL returned end line + 1, not the requested end; do not skip truncated ranges or re-read unchanged evidence. Artifact coverage: ${JSON.stringify(this.coverageSummary())}. ${this.finishing ? `TOOLS ARE NOW DISABLED: ${this.state.finalization!.message} Return the required structured assessment from collected evidence now. If any essential evidence/check is missing, status MUST be blocked with specific missing ranges/checks and next actions. Never claim PASS on an incomplete review.` : 'Use only necessary unread evidence. Keep batches within the remaining calls. Once evidence is sufficient, return the assessment instead of further exploration.'}` }
  }
  toolAttempt(): void {
    this.sync()
    if (this.finishing || !this.state.remainingToolCalls) throw new ChatError('Sub-agent tool-call budget reached or final assessment is active. No tool was executed.')
    this.run.toolCalls++
    this.sync()
  }
  batchLimited(requested: number, executed: number): void {
    this.state.deferredToolCalls += requested - executed
    this.state.lastBatch = { requested, executed, deferred: requested - executed }
    this.finalize('batch_limit', `Provider requested ${requested} calls; ${executed} independent reads fit and ${requested - executed} calls were deferred without execution. Return an assessment, not another tool batch.`)
  }
  private digest(name: string, output: string): string { return createHash('sha256').update(name + output).digest('hex') }
  private coverage(name: string, output: string): boolean {
    if (name !== 'read_file') return false
    let data
    try { data = JSON.parse(output) } catch { return false }
    if (data.error || typeof data.path !== 'string' || typeof data.version !== 'string' || typeof data.content !== 'string' || !this.run.request.files.some(path => path === data.path || (this.run.request.mode !== 'cold_read' && (path === '.' || data.path.startsWith(path + '/')))) || ![data.start, data.end, data.totalLines].every(Number.isInteger) || data.start < 1 || data.end < data.start || data.end > data.totalLines) return false
    const before = JSON.stringify(this.run.readCoverage[data.path])
    this.run.fileVersions[data.path] = data.version
    const coverage = this.run.readCoverage[data.path]?.version === data.version ? this.run.readCoverage[data.path] : { version: data.version, total: data.totalLines, ranges: [] as [number, number][] }
    const ranges = [...coverage.ranges, [data.start, data.end] as [number, number]].sort((a, b) => a[0] - b[0])
    coverage.ranges = []
    for (const range of ranges) {
      const last = coverage.ranges.at(-1)
      if (last && range[0] <= last[1] + 1) last[1] = Math.max(last[1], range[1])
      else coverage.ranges.push(range)
    }
    this.run.readCoverage[data.path] = coverage
    return before !== JSON.stringify(coverage)
  }
  toolResult(name: string, input: string, output: string): void {
    const newCoverage = this.coverage(name, output), key = this.digest(name, output)
    let failed = false, reused = false
    try { const parsed = JSON.parse(output); failed = Boolean(parsed.error || parsed.ok === false || parsed.result?.ok === false); reused = Boolean(parsed.notice) } catch { /* Non-JSON evidence is still bounded and fingerprinted. */ }
    const repeated = this.results.has(key) || reused || (name === 'read_file' && !newCoverage && !failed)
    if (repeated) this.state.repeatedResults++
    this.state.noProgressCalls = failed || repeated ? this.state.noProgressCalls + 1 : 0
    this.results.add(key)
    this.run.observations.push({ tool: name, input: input.slice(0, 6000), output: output.slice(0, 12000) })
    while (this.run.observations.length > 100 || JSON.stringify(this.run.observations).length > 24000) this.run.observations.shift()
    if (this.state.noProgressCalls >= 4) this.finalize('no_progress', 'Four consecutive tool results added no new usable evidence. Stop retrying/re-reading and return findings with explicit limitations.')
  }
  coverageSummary(): Array<{ path: string; missing: string }> {
    return this.run.request.files.map(path => {
      const coverage = this.run.readCoverage[path]
      if (!coverage) return { path, missing: 'not read' }
      const missing: string[] = []; let next = 1
      for (const [start, end] of coverage.ranges) { if (start > next) missing.push(`${next}-${start - 1}`); next = end + 1 }
      if (next <= coverage.total) missing.push(`${next}-${coverage.total}`)
      return { path, missing: missing.join(', ') || 'none' }
    })
  }
}
