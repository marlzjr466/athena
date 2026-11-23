import { useEffect, useState } from 'react'
import { Section } from '../../components/ui/Controls'
import { subagentDefaults, subagentSettingsSchema, type SubagentSettings as Preferences } from '../../../shared/subagents'
import { accountKey, type ModelSelection, type UnifiedAccountCatalog } from '../../../shared/unifiedAccounts'
import { subagentContextAllocation } from '../../../shared/subagentContext'
import { contextModelKey } from '../../../shared/context'
import { openAIContext } from '../../../shared/modelLimits'
import { resolveReasoningEfforts } from '../../../shared/modelCapabilities'
import { useAthena } from '../../store/athenaStore'
import { connectChat, useChat } from '../../store/chatStore'
import { CustomSelect } from '../../components/ui/CustomSelect'

const numbers = [
  ['maxConcurrent', 'Maximum concurrent sub-agents', 1, 4, 1],
  ['maxIterations', 'Default iteration limit', 2, 48, 1],
  ['maxToolCalls', 'Default tool-call limit', 2, 100, 1],
  ['timeoutMinutes', 'Default timeout (minutes)', 1, 20, 1],
  ['contextTokens', 'Per-request context budget (tokens, including output)', 2000, undefined, 1],
  ['tokenBudget', 'Total token budget per child (all requests)', 8000, 1000000, 1],
] as const
const emptyCatalog: UnifiedAccountCatalog = { accounts: [], refreshedAt: 0 }
export function SubagentSettings({ catalog = emptyCatalog }: { catalog?: UnifiedAccountCatalog }) {
  const { snapshot, update } = useAthena()
  const parent = useChat(state => state.snapshot.config)
  useEffect(connectChat, [])
  const value = snapshot?.settings.subagents ?? subagentDefaults()
  const [draft, setDraft] = useState<Preferences>(() => structuredClone(value))
  const [numeric, setNumeric] = useState(() => Object.fromEntries(numbers.map(([key]) => [key, String(value[key])])) as Record<typeof numbers[number][0], string>)
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [saving, setSaving] = useState(false)
  const saved = JSON.stringify(value)
  useEffect(() => { const next = JSON.parse(saved) as Preferences; setDraft(next); setNumeric(Object.fromEntries(numbers.map(([key]) => [key, String(next[key])])) as typeof numeric) }, [saved])
  if (!snapshot?.settings) return null
  const choices = [...new Map(catalog.accounts.flatMap(account => account.models.map(model => [accountKey(account.route, model.id), { account, model }] as const))).entries()]
  const margin = draft.contextSafetyMargin ?? snapshot.settings.aiContext.contextSafetyMargin
  const change = (patch: Partial<Preferences>) => { setDraft(current => ({ ...current, ...patch })); setNotice(''); setError('') }
  return <Section title="Agent execution · Sub-agents" description="Independent, bounded executions using Unified Models. Choose an account and model explicitly, or inherit the parent. Authentication and isolated tool support are checked when a worker starts.">
    <p className="card-description">Preferences remain editable while a task is running or an account is disconnected. Changes apply to new workers. Running and resumed workers retain their saved allocations and consumed tokens.</p>
    <form className="ai-context-settings" onSubmit={async event => {
      event.preventDefault()
      if (saving) return
      const parsed = subagentSettingsSchema.safeParse({ ...draft, ...Object.fromEntries(numbers.map(([key]) => [key, Number(numeric[key])])) })
      if (!parsed.success) { setError(parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join(' ')); return }
      setSaving(true); setError(''); setNotice('')
      try { await update({ subagents: parsed.data }); const failure = useAthena.getState().error; if (failure) setError(failure); else setNotice('Sub-agent settings saved. New workers will use these preferences.') }
      catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not save sub-agent settings.') }
      finally { setSaving(false) }
    }}>
      <fieldset disabled={saving}>
        <label><span>Enable sub-agents</span><input type="checkbox" checked={draft.enabled} onChange={event => change({ enabled: event.target.checked })}/></label>
        {(['default', 'coldRead'] as const).map(kind => {
          const selectionKey = kind === 'default' ? 'defaultSelection' : 'coldReadSelection'
          const modelKey = kind === 'default' ? 'defaultModel' : 'coldReadModel'
          const effortKey = kind === 'default' ? 'defaultEffort' : 'coldReadEffort'
          const selection = draft[selectionKey], legacy = draft[modelKey]
          const key = selection ? accountKey(selection, selection.model) : legacy ? `legacy:${legacy}` : ''
          const route = selection ?? parent?.accountRoute
          const modelId = selection?.model ?? legacy ?? parent?.model
          const candidate = choices.find(([, item]) => item.account.route.provider === route?.provider && item.account.route.accountId === route?.accountId && item.model.id === modelId)?.[1]
          const provider = route?.provider ?? snapshot.settings.aiMode
          const levels = candidate?.model.efforts ?? resolveReasoningEfforts(provider, modelId ?? '') ?? []
          const currentEffort = draft[effortKey]
          const effortOptions = [...new Set(['inherit', 'auto', ...levels, ...(currentEffort !== 'inherit' && currentEffort !== 'auto' && !levels.includes(currentEffort) ? [currentEffort] : [])])]
          const known = !candidate?.model.contextLimits && (provider === 'cloud' || provider === 'subscription') && modelId ? openAIContext(modelId, provider === 'subscription').limits : undefined
          const capacity = candidate?.model.contextLimits ?? (known ? { contextWindow: known.context, maxOutputTokens: known.output, source: known.verified ? 'documented' as const : 'fallback' as const } : undefined)
          const override = snapshot.settings.aiContext.modelContextWindows[contextModelKey(modelId ?? '', route)]
          const effectiveCapacity = override ? { ...capacity, contextWindow: capacity?.contextWindow ?? override, runtimeContextWindow: Math.min(capacity?.runtimeContextWindow ?? Infinity, override), source: capacity?.source ?? 'configured' as const } : capacity
          const allocation = subagentContextAllocation(Number(numeric.contextTokens) || 0, effectiveCapacity, margin)
          const label = kind === 'default' ? 'Default sub-agent model' : 'Cold-read model'
          return <div key={kind}>
            <label className="custom-select-field"><span>{label}</span><CustomSelect ariaLabel={label} value={key} options={[
              { value: '', label: 'Inherit parent model' },
              ...(key && !choices.some(([id]) => id === key) ? [{ value: key, label: `${modelId} · saved ${selection ? 'account unavailable' : 'parent account'}` }] : []),
              ...choices.map(([id, { account, model }]) => ({ value: id, label: `${model.label} · ${account.name}${account.identity ? ` · ${account.identity}` : ''}${!model.available || !account.enabled ? ' · unavailable at launch' : ''}` })),
            ]} onChange={next => {
              const chosen = choices.find(([id]) => id === next)?.[1]
              if (!next) change({ [selectionKey]: null, [modelKey]: null, [effortKey]: 'inherit' })
              else if (chosen) {
                const selection: ModelSelection = { ...chosen.account.route, model: chosen.model.id }
                const supported = chosen.model.efforts ?? resolveReasoningEfforts(chosen.account.route.provider, chosen.model.id) ?? []
                const effort = currentEffort === 'inherit' || currentEffort === 'auto' || supported.includes(currentEffort) ? currentEffort : chosen.model.effortDefault ?? 'auto'
                change({ [selectionKey]: selection, [modelKey]: chosen.model.id, [effortKey]: effort })
              }
            }}/></label>
            <label className="custom-select-field"><span>{kind === 'default' ? 'Default reasoning effort' : 'Cold-read reasoning effort'}</span><CustomSelect ariaLabel={kind === 'default' ? 'Default reasoning effort' : 'Cold-read reasoning effort'} value={currentEffort} options={effortOptions.map(effort => ({ value: effort, label: effort === 'inherit' ? 'Inherit parent reasoning effort' : effort === 'auto' ? 'Auto · model default' : `${effort === 'xhigh' ? 'Extra High' : effort[0].toUpperCase() + effort.slice(1)}${!levels.includes(effort as typeof currentEffort & Exclude<typeof currentEffort, 'inherit'>) ? ' · saved, verify at launch' : ''}` }))} onChange={next => change({ [effortKey]: next as Preferences[typeof effortKey] })}/></label>
            <p className="card-description">{label}: {modelId ?? 'inherit at launch'} · Configured context budget: {allocation.configured.toLocaleString()} tokens · Effective context budget: {allocation.effective.toLocaleString()} tokens · Model context window: {allocation.modelContext?.toLocaleString() ?? 'unverified'}. {allocation.reason} Output reserve: up to {allocation.outputReserve.toLocaleString()} tokens. Actual serialized instructions, tools, attachments and results are checked before every request.</p>
            {['cursor', 'copilot', 'antigravity'].includes(provider) && <p className="card-description">This native runtime cannot currently enforce Athena’s isolated child-tool and budget interface. Preferences can be saved; an unsupported child launch will stop with an explanation.</p>}
          </div>
        })}
        {numbers.map(([key, label, min, max, step]) => <label key={key}><span>{label}</span><input aria-label={label} type="number" min={min} max={max} step={step} value={numeric[key]} onChange={event => { setNumeric(current => ({ ...current, [key]: event.target.value })); setNotice(''); setError('') }} required/></label>)}
        <label><span>Context safety margin (%)</span><input aria-label="Context safety margin (%)" type="number" min={5} max={50} step={1} value={Math.round(margin * 100)} onChange={event => change({ contextSafetyMargin: Number(event.target.value) / 100 })}/></label>
        <label><span>Allow parallel read-only workers</span><input type="checkbox" checked={draft.parallelReadOnly} onChange={event => change({ parallelReadOnly: event.target.checked })}/></label>
        <label><span>Require approval for write-capable sub-agents</span><input type="checkbox" checked={draft.requireWriteApproval} onChange={event => change({ requireWriteApproval: event.target.checked })}/></label>
        <p>Increasing context and lifetime token budgets can consume API spending or subscription allowances faster. Per-request context includes input and output; total token consumption accumulates across requests and compactions. Writes remain exclusive and all tools retain project permissions and explicit file scopes. Task-specific lower allocations and runtime limits still apply. Unavailable models are preserved, never silently replaced.</p>
        {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
        <button className="button secondary" type="submit">{saving ? 'Saving…' : 'Save sub-agent settings'}</button>
      </fieldset>
    </form>
  </Section>
}
