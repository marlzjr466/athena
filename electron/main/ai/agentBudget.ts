/** No content or credentials: a shared, deterministic warning for bounded tool loops. */
export function agentBudgetNotice(round: number, rounds: number, calls: number, limit: number): string | undefined {
  if (round >= rounds || calls >= limit) return `Agent budget reached (${round}/${rounds} iterations; ${calls}/${limit} tool calls). Project permission has NOT been revoked. No further tools may run in this turn. Summarize only confirmed changes and unfinished steps; do not describe this as missing project access. The user can continue from saved Activity or increase limits in Settings → AI → Context & task limits.`
  if (round >= Math.floor(rounds * 0.8) || calls >= Math.floor(limit * 0.8)) return `Approaching agent budget (${round}/${rounds} iterations; ${calls}/${limit} tool calls). Do not start a large new implementation slice. Avoid optional exploration; complete and verify one safe bounded unit, retain a continuation checkpoint, and report unfinished steps honestly. Permissions are unchanged.`
  return undefined
}
