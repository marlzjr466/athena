import { useEffect, useState } from 'react'
import { Section } from '../../components/ui/Controls'
import { subagentDefaults, subagentSettingsSchema } from '../../../shared/subagents'
import { useAthena } from '../../store/athenaStore'
import { useChat } from '../../store/chatStore'
import { desktop } from '../../services/desktop'
import { CustomSelect } from '../../components/ui/CustomSelect'

export function SubagentSettings() {
  const { snapshot, update } = useAthena()
  const phase = useChat((state) => state.snapshot.phase)
  const conversationModel = useChat((state) => state.snapshot.config?.cursorPendingModel ?? state.snapshot.config?.cursorModel ?? state.snapshot.config?.model)
  const [cursorEffectiveModel, setCursorEffectiveModel] = useState<string | null>(null)
  const settings = snapshot?.settings
  const value = settings?.subagents ?? subagentDefaults()
  const [models, setModels] = useState<string[]>([])
  const [availability, setAvailability] = useState('Checking configured provider…')
  const [error, setError] = useState('')
  const [efforts, setEfforts] = useState({ default: value.defaultEffort, coldRead: value.coldReadEffort })
  const [modelValues, setModelValues] = useState({ default: value.defaultModel ?? '', coldRead: value.coldReadModel ?? '' })
  useEffect(() => setEfforts({ default: value.defaultEffort, coldRead: value.coldReadEffort }), [value.defaultEffort, value.coldReadEffort])
  useEffect(() => setModelValues({ default: value.defaultModel ?? '', coldRead: value.coldReadModel ?? '' }), [value.defaultModel, value.coldReadModel])
  useEffect(() => {
    if (settings?.aiMode !== 'cursor') return
    let live = true
    const use = (config?: { cursorPendingModel?: string; cursorModel?: string | null; model?: string | null }) => { if (live) setCursorEffectiveModel(config?.cursorPendingModel ?? config?.cursorModel ?? config?.model ?? null) }
    const off = desktop.onChat((snapshot) => use(snapshot.config))
    void desktop.getChat().then((snapshot) => use(snapshot.config)).catch(() => {})
    return () => { live = false; off() }
  }, [settings?.aiMode])
  useEffect(() => {
    let active = true
    setModels([]); setAvailability('Checking configured provider…')
    const load = async () => {
      let available: string[] = [], connected = false
      if (settings?.aiMode === 'cursor') {
        if (active) setAvailability('Unavailable: the current Cursor adapter cannot enforce Athena’s isolated child-tool scopes.')
        return
      }
      if (settings?.aiMode === 'local' || settings?.aiMode === 'unconfigured') {
        if (active) setAvailability('Choose an online provider for online sub-agents. Local companion inference is configured separately.')
        return
      } else if (settings?.aiMode === 'subscription') {
        if (settings.chatGPTCodingBackend === 'codex-cli') {
          const status = await desktop.getCodexCLIStatus()
          available = status.models.map((model) => model.id); connected = status.authenticated
          if (active) setAvailability(connected
            ? `Codex CLI · ${available.length} models. Independent child agents are unavailable because the app-server does not expose Athena’s bounded per-request iteration and output-token controls. Required cold-read gates remain incomplete; no parent-agent substitute will be used.`
            : status.message)
        } else {
          const status = await desktop.getChatGPTStatus()
          available = status.models.map((model) => model.slug); connected = status.connected && status.planEnabled
        }
      } else {
        const result = await (settings?.aiMode === 'claude-api' ? desktop.getClaudeStatus() : desktop.getAIStatus())
        available = result.status.models; connected = result.status.active
      }
      if (active) {
        setModels(available)
        if (!(settings?.aiMode === 'subscription' && settings.chatGPTCodingBackend === 'codex-cli')) setAvailability(connected ? `${settings?.aiMode ?? 'cloud'} · ${available.length} model candidates. Tool support, account and reasoning compatibility are checked again at launch.` : 'Connect the selected provider before starting sub-agents.')
      }
    }
    void load().catch(() => { if (active) setAvailability('Provider availability could not be checked. Reopen AI Settings to retry.') })
    return () => { active = false }
  }, [settings?.aiMode, settings?.chatGPTCodingBackend, settings?.strictOffline])
  if (!settings) return null
  const numbers = [
    ['maxConcurrent', 'Maximum concurrent sub-agents', 1, 4, 1],
    ['maxIterations', 'Default iteration limit', 2, 48, 1],
    ['maxToolCalls', 'Default tool-call limit', 2, 100, 1],
    ['timeoutMinutes', 'Default timeout (minutes)', 1, 20, 1],
    ['contextTokens', 'Context budget (estimated tokens)', 2000, 64000, 1000],
    ['tokenBudget', 'Total token budget per child', 8000, 1000000, 1000],
  ] as const
  return <Section title="Agent execution · Sub-agents" description="Independent, bounded executions through the selected conversation provider. Cold Read receives only explicit artifacts and review instructions. No account or provider is switched silently.">
    <p className="card-description" role="status">{availability}</p>
    {settings.aiMode === 'cursor' && <p className="card-description">Effective sub-agent model: {cursorEffectiveModel ?? conversationModel ?? 'Select a Cursor model in Chat Conversation'} · Cold-read model: {cursorEffectiveModel ?? conversationModel ?? 'Select a Cursor model in Chat Conversation'}. Both inherit the conversation choice. Execution remains unavailable because Cursor ACP cannot enforce isolated child-tool scopes.</p>}
    <p className="card-description">New workers inherit these limits unless a task or workflow explicitly sets a lower cap. Activity shows the effective allocation. Continuing a saved worker preserves its original ceiling and used calls. One iteration is reserved for its final assessment; each tool in a batch counts separately.</p>
    <form className="ai-context-settings" key={JSON.stringify(value)} onSubmit={async (event) => {
      event.preventDefault()
      if (phase !== 'idle') return
      const form = new FormData(event.currentTarget)
      const parsed = subagentSettingsSchema.safeParse({ ...value, ...Object.fromEntries(numbers.map(([key]) => [key, Number(form.get(key))])),
        enabled: form.has('enabled'), parallelReadOnly: form.has('parallelReadOnly'), requireWriteApproval: form.has('requireWriteApproval'),
        defaultModel: modelValues.default.trim() || null, coldReadModel: modelValues.coldRead.trim() || null,
        defaultEffort: efforts.default, coldReadEffort: efforts.coldRead,
      })
      if (!parsed.success) { setError('Check the model names and allowed budget ranges.'); return }
      setError(''); await update({ subagents: parsed.data })
    }}>
      <fieldset disabled={phase !== 'idle'}>
        <label><span>Enable sub-agents</span><input type="checkbox" name="enabled" defaultChecked={value.enabled} /></label>
        {settings.aiMode !== 'cursor' && (['default', 'coldRead'] as const).map((kind) => <div key={kind}>
          <label className="custom-select-field"><span>{kind === 'default' ? 'Default sub-agent model' : 'Cold-read model'}</span><CustomSelect ariaLabel={kind === 'default' ? 'Default sub-agent model' : 'Cold-read model'} value={modelValues[kind]} options={[{ value: '', label: 'Inherit parent model' }, ...(modelValues[kind] && !models.includes(modelValues[kind]) ? [{ value: modelValues[kind], label: `${modelValues[kind]} · saved` }] : []), ...models.map((model) => ({ value: model, label: model }))]} onChange={(next) => setModelValues((current) => ({ ...current, [kind]: next }))} /></label>
          <label className="custom-select-field"><span>{kind === 'default' ? 'Default reasoning effort' : 'Cold-read reasoning effort'}</span><CustomSelect ariaLabel={kind === 'default' ? 'Default reasoning effort' : 'Cold-read reasoning effort'} value={efforts[kind]} options={['inherit', 'auto', 'low', 'medium', 'high', 'xhigh'].map((effort) => ({ value: effort, label: effort === 'inherit' ? 'Inherit parent' : effort === 'xhigh' ? 'Extra High' : effort[0].toUpperCase() + effort.slice(1) }))} onChange={(next) => setEfforts((current) => ({ ...current, [kind]: next as typeof current[typeof kind] }))} /></label>
        </div>)}
        {numbers.map(([key, label, min, max, step]) => <label key={key}><span>{label}</span><input aria-label={label} name={key} type="number" min={min} max={max} step={step} defaultValue={value[key]} required /></label>)}
        <label><span>Allow parallel read-only workers</span><input name="parallelReadOnly" type="checkbox" defaultChecked={value.parallelReadOnly} /></label>
        <label><span>Require approval for write-capable sub-agents</span><input name="requireWriteApproval" type="checkbox" defaultChecked={value.requireWriteApproval} /></label>
        <p>Writes run exclusively. Turning off delegation approval does not remove existing file, terminal, Git or browser permissions. Child tools remain project-scoped even with Full Mac Access. API workers share the parent’s dollar cap; subscription limits remain provider-managed. The total token budget covers input and output across all requests, not one context window. Children inherit it unless explicitly allocated a lower cap; Activity shows both. Completed requests use provider-reported usage when available; unreported requests retain labelled conservative estimates.</p>
        {settings.aiMode === 'claude-api' && <p>The Claude adapter currently requires Auto effort and cannot run dollar-capped children. Unsupported configurations stop with an explanation.</p>}
        {phase !== 'idle' && <p>Stop the active task before changing delegation settings. Individual workers can be cancelled in Activity.</p>}
        {error && <p role="alert">{error}</p>}
        <button className="button secondary" type="submit">Save sub-agent settings</button>
      </fieldset>
    </form>
  </Section>
}
