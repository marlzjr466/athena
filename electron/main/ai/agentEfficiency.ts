import { createHash } from 'node:crypto'

export type AgentPhase = 'exploration' | 'implementation' | 'verification' | 'other'
export interface AgentEfficiencySummary {
  iterations: number
  toolCalls: number
  phases: Record<AgentPhase, { iterations: number; toolCalls: number; durationMs: number }>
  repeatedReads: number
  repeatedSearches: number
  successfulModifications: number
  failedOperations: number
  compactionAttempts: number
  durationMs: number
}

const readTools = new Set(['read_file', 'list_directory', 'get_file_metadata', 'get_project_structure', 'analyze_project', 'inspect_dependencies', 'inspect_imports', 'retrieve_relevant_context', 'git_status', 'git_log', 'git_diff'])
const searchTools = new Set(['search_files', 'search_code', 'find_symbol', 'find_references'])
const writeTools = new Set(['create_file', 'write_file', 'edit_file', 'apply_patch', 'delete_file', 'rename_file', 'move_file', 'create_directory', 'delete_directory', 'revert_change', 'git_add', 'git_commit'])
const verificationTools = new Set(['run_tests', 'run_linter', 'run_typecheck', 'run_build', 'inspect_errors', 'execute_command'])
export const agentPhase = (name: string): AgentPhase => writeTools.has(name) ? 'implementation' : verificationTools.has(name) ? 'verification' : readTools.has(name) || searchTools.has(name) ? 'exploration' : 'other'
const batchPhase = (names: string[]): AgentPhase => names.some(name => agentPhase(name) === 'implementation') ? 'implementation'
  : names.some(name => agentPhase(name) === 'verification') ? 'verification'
    : names.some(name => agentPhase(name) === 'exploration') ? 'exploration' : 'other'

/** Content-free, request-local accounting. The model still sees every actual tool result. */
export class AgentEfficiencyTracker {
  private started = Date.now()
  private seen = new Set<string>()
  private stagnant = 0
  private statistics: AgentEfficiencySummary = {
    iterations: 0, toolCalls: 0,
    phases: { exploration: { iterations: 0, toolCalls: 0, durationMs: 0 }, implementation: { iterations: 0, toolCalls: 0, durationMs: 0 }, verification: { iterations: 0, toolCalls: 0, durationMs: 0 }, other: { iterations: 0, toolCalls: 0, durationMs: 0 } },
    repeatedReads: 0, repeatedSearches: 0, successfulModifications: 0, failedOperations: 0, compactionAttempts: 0, durationMs: 0,
  }
  constructor(private noProgressWindow = 10) { this.noProgressWindow = Math.max(6, Math.min(30, Math.floor(noProgressWindow) || 10)) }
  get shouldStop(): boolean { return this.stagnant >= this.noProgressWindow }
  get warning(): string | undefined {
    return this.stagnant >= Math.max(4, Math.floor(this.noProgressWindow * 0.6))
      ? `The last ${this.stagnant} tool operations found no new evidence or verified change. Do not repeat reads, searches or failed actions. Use existing results to implement or verify one bounded unit; if blocked, explain the blocker and stop.`
      : undefined
  }
  /** A compacted context may genuinely need fresh evidence; retain totals but reset stall detection. */
  contextReset(): void { this.seen.clear(); this.stagnant = 0 }
  observe(name: string, args: string, output: string): void {
    const phase = agentPhase(name)
    this.statistics.toolCalls++
    this.statistics.phases[phase].toolCalls++
    let result: Record<string, unknown> = {}
    try { const parsed = JSON.parse(output); if (parsed && typeof parsed === 'object') result = parsed } catch { /* Count unparseable results as failures. */ }
    const inner = result.result && typeof result.result === 'object' ? result.result as Record<string, unknown> : result
    const failed = Boolean(result.error || inner.error || inner.ok === false || (typeof inner.exitCode === 'number' && inner.exitCode !== 0))
    if (failed) this.statistics.failedOperations++
    const changes = Array.isArray(inner.changes) ? inner.changes as Array<{ status?: string }> : []
    const changed = phase === 'implementation' && !failed && (changes.some(change => change.status === 'applied') || inner.ok === true)
    if (changed) this.statistics.successfulModifications += Math.max(1, changes.filter(change => change.status === 'applied').length)
    const digest = createHash('sha256').update(`${name}\0${args}\0${output}`).digest('hex')
    const repeated = this.seen.has(digest) || Boolean(result.notice)
    this.seen.add(digest)
    if (repeated && readTools.has(name)) this.statistics.repeatedReads++
    if (repeated && searchTools.has(name)) this.statistics.repeatedSearches++
    const newEvidence = !failed && !repeated
    if (changed || newEvidence) this.stagnant = 0
    else this.stagnant++
  }
  round(names: string[], durationMs: number): void {
    const phase = batchPhase(names)
    this.statistics.iterations++
    this.statistics.phases[phase].iterations++
    this.statistics.phases[phase].durationMs += Math.max(0, durationMs)
  }
  toolDuration(names: string[], durationMs: number): void { this.statistics.phases[batchPhase(names)].durationMs += Math.max(0, durationMs) }
  finish(compactionAttempts = 0): AgentEfficiencySummary {
    return { ...this.statistics, phases: structuredClone(this.statistics.phases), compactionAttempts, durationMs: Date.now() - this.started }
  }
}
