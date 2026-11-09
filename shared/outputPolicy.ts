import { modelCapabilities, type ReasoningEffort } from './conversations'
import { modelLimits } from './modelLimits'

export function effectiveEffort(model: string, selected: ReasoningEffort, recovery = 0): ReasoningEffort {
  if (selected !== 'auto') return selected
  const supported = modelCapabilities(model).efforts
  if (recovery > 0 && supported.includes('low')) return 'low'
  return supported.includes('medium') ? 'medium' : 'auto'
}
export function outputBudget(model: string, configured: number | null, recovery = 0): number {
  const limits = modelLimits(model)
  // A 32K starting allowance covers the documented 25K reasoning/output reserve.
  // Automatic mode may expand on exhaustion; an explicit cap is never raised.
  const initial = modelCapabilities(model).efforts.includes('medium') ? 32768 : 8192
  return Math.min(limits.output, Math.floor(limits.context / 2), configured ?? initial * 2 ** Math.min(recovery, 3))
}
