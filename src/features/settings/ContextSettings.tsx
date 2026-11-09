import { useState } from 'react'
import { contextDefaults, contextSettingsSchema } from '../../../shared/context'
import { useChat } from '../../store/chatStore'
import { Section } from '../../components/ui/Controls'
import { ProjectAccessSettings } from './ProjectAccessSettings'

export function ContextSettings({ disabled, localMode = false, subscriptionMode = false }: { disabled: boolean; localMode?: boolean; subscriptionMode?: boolean }) {
  const { snapshot, command, issue } = useChat(), [error, setError] = useState(''), [saved, setSaved] = useState(false)
  const settings = snapshot.config?.contextSettings ?? contextDefaults()
  const title = snapshot.sessions?.find((session) => session.id === snapshot.sessionId)?.title ?? 'current conversation'
  const numbers = [
    ['utilizationThreshold', 'Optimize at (fraction of model window)', 0.3, 0.85, 0.05],
    ['maxToolOutputChars', 'Tool output (characters)', 2000, 24000, 1000],
    ['maxFileReadChars', 'File range (characters)', 1000, 20000, 1000],
    ['maxSearchResults', 'Search results per call', 5, 100, 1],
    ['maxContinuations', 'Automatic continuations per task', 0, 8, 1],
    ['maxAgentIterations', 'Agent iterations per task', 8, 128, 1],
    ['maxToolCalls', 'Tool calls per task', 16, 400, 1],
    ['noProgressWindow', 'Stop after no-progress tool calls', 6, 30, 1],
    ['maxExecutionMinutes', 'Task deadline (minutes)', 2, 60, 1],
    ['streamInactivitySeconds', 'ChatGPT stream inactivity (seconds)', 30, 600, 10],
    ['maxStreamRecoveries', 'ChatGPT stream recoveries per request', 0, 4, 1],
  ] as const
  return <><ProjectAccessSettings /><Section title="Context & task limits" description={`Applies to “${title}”. Switch conversations to configure another session; saved limits are preserved independently.`}>
    <form className="ai-context-settings" key={`${snapshot.sessionId}-${JSON.stringify(settings)}`} onChange={() => setSaved(false)} onSubmit={async (event) => {
      event.preventDefault(); if (!snapshot.sessionId || disabled) return
      const data = new FormData(event.currentTarget)
      const parsed = contextSettingsSchema.safeParse({ ...settings, ...Object.fromEntries(numbers.map(([key]) => [key, Number(data.get(key))])), automaticCompaction: data.has('automaticCompaction'), showUsage: data.has('showUsage'), taskSpendLimitUsd: data.get('spend') ? Number(data.get('spend')) : null })
      if (!parsed.success) { setError('Check the allowed ranges.'); return }
      setError(''); setSaved(await command({ action: 'configure-context', id: snapshot.sessionId, settings: parsed.data }))
    }}>
      <fieldset disabled={disabled || !snapshot.sessionId}>
        <label><span>Automatic compaction</span><input type="checkbox" name="automaticCompaction" defaultChecked={settings.automaticCompaction} /></label>
        <label><span>Show context usage</span><input type="checkbox" name="showUsage" defaultChecked={settings.showUsage} /></label>
        {numbers.map(([key, label, min, max, step]) => <label key={key}><span>{label}</span><input aria-label={label} name={key} type="number" min={min} max={max} step={step} defaultValue={settings[key]} required /></label>)}
        <label><span>Cloud task API budget (USD, optional)</span><input name="spend" type="number" min="0.01" max="100" step="0.01" placeholder="No dollar cap" defaultValue={settings.taskSpendLimitUsd ?? ''} /></label>
        <p>History stays saved. Tool calls and continuations are bounded. {localMode ? 'The dollar cap applies to the API-key provider only; local inference uses no paid API credits.' : subscriptionMode ? 'The dollar cap applies to the API-key provider only. ChatGPT usage is controlled by OpenAI.' : 'Cloud budgets use standard model rates and a safety reserve, not your provider invoice. Unknown pricing blocks capped requests.'}</p>
        {(error || issue) && <p role="alert">{error || issue}</p>}
        {saved && <p role="status">Context limits saved for this conversation.</p>}
        <button className="button secondary" type="submit">Save limits</button>
      </fieldset>
    </form>
  </Section></>
}
