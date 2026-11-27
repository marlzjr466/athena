import type { TaskControlState } from '../../../shared/generation'

const outcomes = new Set(['success', 'permission-denied', 'timeout', 'cancelled', 'missing-input', 'conflict', 'not-found', 'failed'])
type Receipt = TaskControlState['operations'][number]
/** Persist only fixed outcome codes and the process exit status. Tool output may contain secrets. */
export function operationOutcome(output: string): Pick<Receipt, 'outcome' | 'exitCode'> {
  let data
  try { data = JSON.parse(output) } catch { return { outcome: 'success' } }
  if (data?.truncated === true && data?.receipt && outcomes.has(data.receipt.outcome)) return { outcome: data.receipt.outcome, ...(Number.isInteger(data.receipt.exitCode) || data.receipt.exitCode === null ? {exitCode: data.receipt.exitCode} : {}) }
  const result = data?.result ?? data
  const exitCode = result && typeof result === 'object' && 'exitCode' in result ? result.exitCode : undefined
  const code = typeof exitCode === 'number' || exitCode === null ? { exitCode } : {}
  const error = result?.error ?? data?.error
  const message = String(error?.message ?? error ?? '')
  if (result?.timedOut || result?.reason === 'timeout' || /timed out/i.test(message)) return { outcome: 'timeout', ...code }
  if (result?.reason === 'file_not_found') return { outcome: 'not-found', ...code }
  if (result?.filesystemDenial || /permission_denied|policy_denied|requires_approval/.test(result?.reason ?? '') || /declined|permission denied|disabled in Settings/i.test(message)) return { outcome: 'permission-denied', ...code }
  if (/cancelled|canceled/i.test(message)) return { outcome: 'cancelled', ...code }
  if (/file (?:version )?changed|changed while awaiting|missing since|conflict/i.test(message)) return { outcome: 'conflict', ...code }
  if (exitCode !== undefined && exitCode !== 0 && /missing secure input/i.test(result?.output ?? '')) return { outcome: 'missing-input', ...code }
  const failed = error || data?.ok === false || result?.ok === false || exitCode !== undefined && exitCode !== 0
  return { outcome: failed ? 'failed' : 'success', ...code }
}
