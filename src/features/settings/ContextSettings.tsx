import { useState } from 'react'
import { outputBudget } from '../../../shared/outputPolicy'
import { openAIContext } from '../../../shared/modelLimits'
import type { UnifiedAccountCatalog } from '../../../shared/unifiedAccounts'
import { contextDefaults, contextModelKey, contextSettingsSchema } from '../../../shared/context'
import { useChat } from '../../store/chatStore'
import { Section } from '../../components/ui/Controls'
import { ProjectAccessSettings } from './ProjectAccessSettings'
import { useAthena } from '../../store/athenaStore'

export function ContextSettings({ disabled, localMode = false, subscriptionMode = false, catalog, provider }: { catalog?: UnifiedAccountCatalog; provider?: string; disabled: boolean; localMode?: boolean; subscriptionMode?: boolean }) {
  const { snapshot, command, issue } = useChat(), [error, setError] = useState(''), [saved, setSaved] = useState(false)
  const globalSettings = useAthena(state => state.snapshot?.settings.aiContext)
  const configuredOutput = useAthena(state => state.snapshot?.settings.aiGeneration?.outputTokens ?? null)
  const update = useAthena(state => state.update)
  const settings = snapshot.config?.contextSettings ?? globalSettings ?? contextDefaults()
  const modelKey = contextModelKey(snapshot.config?.model ?? '', snapshot.config?.accountRoute)
  const model = snapshot.config?.model
  const route = snapshot.config?.accountRoute
  const entry = catalog?.accounts.find(account => route && account.route.provider === route.provider && account.route.accountId === route.accountId)?.models.find(entry => entry.id === model)
  const configured = settings.modelContextWindows?.[modelKey]
  const recent = snapshot.messages?.map(message => message.execution?.promptBudget).filter(budget => budget?.routeKey === modelKey).at(-1)
  const openAI = model && (provider === 'cloud' || provider === 'subscription' || subscriptionMode)
    ? openAIContext(model, subscriptionMode, entry?.contextLimits?.source === 'reported' ? entry.contextLimits.contextWindow : undefined, configured) : undefined
  const window = openAI?.limits.context ?? entry?.contextLimits?.runtimeContextWindow ?? entry?.contextLimits?.contextWindow
  const reserve = openAI && model ? outputBudget(model, configuredOutput, 0, openAI.limits) : undefined
  const safeInput = openAI && reserve !== undefined ? Math.floor(Math.min(openAI.limits.maxInput ?? Infinity, openAI.limits.context * (1-settings.contextSafetyMargin) - reserve)) : undefined
  const number = (value?: number) => value === undefined ? 'Unreported' : value.toLocaleString()
  const title = snapshot.sessions?.find((session) => session.id === snapshot.sessionId)?.title ?? 'current conversation'
  const numbers = [
    ['utilizationThreshold', 'Optimize at (fraction of model window)', 0.3, 0.85, 0.05],
    ['contextSafetyMargin', 'Context safety margin (fraction)', 0.05, 0.4, 0.05],
    ['maxToolOutputChars', 'Tool output (characters)', 2000, 24000, 1000],
    ['maxFileReadChars', 'File range (characters)', 1000, 20000, 1000],
    ['maxSearchResults', 'Search results per call', 5, 100, 1],
    ['maxContinuations', 'Automatic continuations per task', 0, 32, 1],
    ['maxAgentIterations', 'Agent iterations per task', 8, 128, 1],
    ['maxToolCalls', 'Tool calls per task', 16, 400, 1],
    ['noProgressWindow', 'Stop after no-progress tool calls', 6, 30, 1],
    ['maxExecutionMinutes', 'Task timeout (minutes, idle for project work)', 2, 60, 1],
    ['acpInactivityMinutes', 'ACP model inactivity (minutes)', 2, 120, 1],
    ['acpToolInactivityMinutes', 'ACP native tool inactivity (minutes)', 2, 120, 1],
    ['socketConnectionSeconds', 'API socket connection timeout (seconds)', 5, 120, 5],
    ['responseConnectionSeconds', 'API response headers timeout (seconds)', 10, 300, 10],
    ['responseFirstEventSeconds', 'API first response activity timeout (seconds)', 30, 600, 10],
    ['streamInactivitySeconds', 'API stream inactivity (seconds)', 30, 600, 10],
    ['maxStreamRecoveries', 'API transport recoveries per request', 0, 4, 1],
  ] as const
  const toggles = [['automaticContinuation', 'Enable Automatic Continuation'], ['automaticCompaction', 'Automatic compaction'], ['stopOnRepeatedActions', 'Stop on Repeated Actions'], ['stopOnNoProgress', 'Stop on No Progress'], ['taskCheckpoints', 'Enable Task Checkpoints'], ['safeTaskRecovery', 'Enable Safe Task Recovery'], ['showUsage', 'Show context usage']] as const
  return <><ProjectAccessSettings /><Section title="Automatic Continuation & Context Management" description={`Applies across providers in “${title}”. Global defaults apply to conversations without saved overrides; existing preferences are preserved.`}>
    {model && <div className="ai-context-settings">
      <p><strong>{model}</strong> · Configured window {configured === undefined ? 'Auto' : number(configured)} · Effective window {number(window === undefined ? recent?.effective : Math.min(window, configured ?? Infinity))} · Documented API model window {number(openAI?.documentedWindow ?? recent?.documented)}</p>
      <p>{openAI?.reason ?? recent?.reason ?? (entry?.contextLimits?.source ? `Context source: ${entry.contextLimits.source}` : 'The selected runtime manages its context window.')}</p>
      {reserve !== undefined && <p>Safe input {number(safeInput)} tokens · Output reserve {number(reserve)}</p>}
      {!recent && <p>Request measurements appear after Athena assembles a prompt. Native agents manage their own prompts and tool schemas.</p>}
      {recent && <details><summary>Last request budget</summary>
        <p>Estimated prompt {number(recent.prompt)} tokens · Safe input {number(recent.safeInput)} · Output reserve {number(recent.output)} · Effective window {number(recent.effective)}</p>
        <p>System {number(recent.system)} · Developer and tool policies {number(recent.developer)} · Project instructions {number(recent.project)} · Tool definitions {number(recent.tools)} · History, attachments and tool results {number(recent.history)}</p>
        {recent.loaded !== undefined && <p>{recent.loaded} tools loaded · {recent.registered} registered</p>}
        <p>{recent.reason}</p>
      </details>}
    </div>}
    <form className="ai-context-settings" key={`${snapshot.sessionId}-${JSON.stringify(settings)}`} onChange={() => setSaved(false)} onSubmit={async (event) => {
      event.preventDefault(); if (!snapshot.sessionId || disabled) return
      const data = new FormData(event.currentTarget)
      const modelContextWindows = { ...settings.modelContextWindows }
      if (snapshot.config?.model && data.get('modelWindow')) modelContextWindows[modelKey] = Number(data.get('modelWindow'))
      else delete modelContextWindows[modelKey]
      const parsed = contextSettingsSchema.safeParse({ ...settings, modelContextWindows, ...Object.fromEntries(numbers.map(([key]) => [key, Number(data.get(key))])), ...Object.fromEntries(toggles.map(([key]) => [key, data.has(key)])), taskSpendLimitUsd: data.get('spend') ? Number(data.get('spend')) : null })
      if (!parsed.success) { setError('Check the allowed ranges.'); return }
      setError(''); setSaved(await command({ action: 'configure-context', id: snapshot.sessionId, settings: parsed.data }))
      if (data.has('globalDefaults')) await update({ aiContext: parsed.data })
    }}>
      <fieldset disabled={disabled || !snapshot.sessionId}>
        {toggles.map(([key, label]) => <label key={key}><span>{label}</span><input type="checkbox" name={key} defaultChecked={settings[key]} /></label>)}
        <label><span>Also save as global defaults</span><input type="checkbox" name="globalDefaults" /></label>
        {snapshot.config?.model && <label><span>Conversation context cap for {snapshot.config.model} (optional tokens)</span><input name="modelWindow" type="number" min="2048" max="10000000" step="1" placeholder="Use integration capacity" defaultValue={settings.modelContextWindows?.[modelKey] ?? ''} /></label>}
        {numbers.map(([key, label, min, max, step]) => <label key={key}><span>{label}</span><input aria-label={label} name={key} type="number" min={min} max={max} step={step} defaultValue={settings[key]} required /></label>)}
        <label><span>Cloud task API budget (USD, optional)</span><input name="spend" type="number" min="0.01" max="100" step="0.01" placeholder="No dollar cap" defaultValue={settings.taskSpendLimitUsd ?? ''} /></label>
        <p>History stays saved. Tool calls and continuations are bounded. {localMode ? 'The dollar cap applies to the API-key provider only; local inference uses no paid API credits.' : subscriptionMode ? 'The dollar cap applies to the API-key provider only. ChatGPT usage is controlled by OpenAI.' : 'Cloud budgets use standard model rates and a safety reserve, not your provider invoice. Unknown pricing blocks capped requests.'}</p>
        <p>Higher continuation allowances can consume more provider usage. Compaction and successful tool rounds do not consume continuation rounds. Native CLI and ACP agents retain their own execution loops. Resume Task rechecks access and guards against replaying recorded mutations.</p>
        <p>API socket connection, response headers, first activity, and stream inactivity have separate deadlines. Only received network activity resets the stream timer. Native CLI and ACP runtimes keep their own startup and activity limits. Higher deadlines allow slower reasoning but also take longer to detect a stalled request.</p>
        {(error || issue) && <p role="alert">{error || issue}</p>}
        {saved && <p role="status">Context limits saved for this conversation.</p>}
        <button className="button secondary" type="submit">Save limits</button>
      </fieldset>
    </form>
  </Section></>
}
