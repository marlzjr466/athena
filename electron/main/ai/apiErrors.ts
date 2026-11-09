// Error codes, never raw provider messages, determine safe user-facing guidance.
export function billingErrorMessage(code: string | null | undefined): string | undefined {
  if (code === 'organization_spend_limit_exceeded' || code === 'project_spend_limit_exceeded') return 'An OpenAI organization or project spending limit was reached. Review API spend limits before retrying; this is not a context or temporary rate-limit error.'
  if (code === 'credit_balance_exhausted') return 'Your API credit balance is exhausted. Check your API billing. Test Connection checks authentication, not available generation credits.'
  if (code === 'insufficient_quota') return 'OpenAI credits or quota are unavailable. Check your API billing and limits before retrying.'
}
