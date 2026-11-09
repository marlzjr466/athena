import { modelCapabilities, type ReasoningEffort } from '../../../shared/conversations'
import type { AIStatus } from '../../../shared/ai'
import { latestConversationModels } from '../../../shared/modelCatalog'
import { useChat } from '../../store/chatStore'
import { CustomSelect } from '../../components/ui/CustomSelect'
import { agentModes, type AgentMode } from '../../../shared/agent'
import { cursorModelDisplayLabel, cursorModelVariant, cursorSelectableModels } from '../../../shared/cursor'
import { CursorModelSelect } from './CursorModelSelect'
import { CursorConfiguredModelSelect } from './CursorConfiguredModelSelect'

export function ConversationControls({ config }: { config: AIStatus }) {
  const { snapshot, command, pending } = useChat()
  const settings = snapshot.config
  const supportsReasoning = config.provider !== 'Cursor Subscription'
  const allCursorModels = config.provider === 'Cursor Subscription'
    ? cursorSelectableModels(config.models.map((id) => ({ id, label: config.modelLabels?.[id] ?? id })), config.modelCatalogAvailable !== false)
    : []
  // The CLI catalog can contain models that ACP exposes for text-only use. The
  // composer is an agent surface, so only models whose complete Athena path
  // verifies tool calling are offered here. Keep the full catalog in status for
  // diagnostics and provider refreshes; this is presentation/execution gating.
  const cursorModels = allCursorModels.filter((model) => {
    const capabilities = config.modelCapabilities?.[model.id]
    return !config.modelCapabilities || capabilities?.includes('tool-calling') === true || model.id === 'cursor-managed'
  })
  const supportedCursorConfigurations = config.cursorModelConfigurations?.filter((configuration) => {
    if (!config.modelCapabilities) return true
    const configurationBase = configuration.id.replace(/^cursor-/i, '').toLowerCase()
    return allCursorModels.some((model) => {
      const variant = cursorModelVariant(model.id)
      const base = (variant?.baseId ?? model.id).replace(/^cursor-/i, '').toLowerCase()
      return base === configurationBase && (config.modelCapabilities?.[model.id]?.includes('tool-calling') === true)
    })
  }) ?? []
  const models = config.provider === 'OpenAI'
    ? latestConversationModels(config.models)
    : config.provider === 'Cursor Subscription'
      ? cursorModels
        .filter((model) => model.id.toLowerCase() !== 'auto' && model.id.toLowerCase() !== 'auto/model').map((model) => model.id)
      : config.models
  const cursorModelId = settings?.cursorPendingModel ?? settings?.cursorModel ?? settings?.model ?? ''
  const executionStatus = snapshot.sessions?.find((session) => session.id === snapshot.sessionId)?.executionStatus
  const disabled = pending || snapshot.phase !== 'idle' || executionStatus === 'running' || executionStatus === 'queued' || !config.active || !snapshot.sessionId
  const names: Record<ReasoningEffort, string> = { auto: 'Auto', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra High' }
  const modelOptions = [...(settings?.model && !models.includes(settings.model) && config.provider !== 'Cursor Subscription' ? [{ value: settings.model, label: `${settings.model} · saved`, disabled: true }] : []), ...models.map((model) => ({ value: model, label: config.modelLabels?.[model] ?? model }))]
  const selectedModel = settings?.model && models.includes(settings.model) ? settings.model : config.model && models.includes(config.model) ? config.model : models[0] ?? ''
  const supportedEfforts = config.modelEfforts?.[selectedModel] ?? modelCapabilities(selectedModel || null).efforts
  return <div className="conversation-selectors">
    {!!snapshot.workspaces?.length && <CustomSelect ariaLabel="Coding agent permissions" value={settings?.agentMode ?? 'ask'} disabled={disabled} options={Object.entries(agentModes).map(([value, label]) => ({ value, label }))} onChange={(mode) => { if (snapshot.sessionId) void command({ action: 'agent-mode', id: snapshot.sessionId, mode: mode as AgentMode }) }} menuPlacement="up" />}
    {config.provider === 'Cursor Subscription'
      ? supportedCursorConfigurations.length ? <CursorConfiguredModelSelect value={cursorModelId} models={cursorModels} configurations={supportedCursorConfigurations}
        pending={Boolean(settings?.cursorPendingModel)} disabled={disabled}
        onChange={(model) => { if (snapshot.sessionId) void command({ action: 'configure-model', id: snapshot.sessionId, model }) }} /> : <>
        <CursorModelSelect value={cursorModelId} pending={Boolean(settings?.cursorPendingModel)} catalogAvailable={config.modelCatalogAvailable !== false} disabled={disabled} models={cursorModels.filter((model) => model.id.toLowerCase() !== 'auto' && model.id.toLowerCase() !== 'auto/model').map((model) => ({ id: model.id, label: cursorModelDisplayLabel(model), family: config.modelFamilies?.[model.id] ?? model.id.split(/[\s._:/-]/)[0] }))} onChange={(model) => { if (snapshot.sessionId) void command({ action: 'configure-model', id: snapshot.sessionId, model }) }} />
      </>
      : <CustomSelect ariaLabel="Conversation model" value={selectedModel} disabled={disabled} options={modelOptions} onChange={(model) => { if (snapshot.sessionId) void command({ action: 'configure-model', id: snapshot.sessionId, model }) }} menuPlacement="up" className="conversation-model-selector" />}
    {supportsReasoning && supportedEfforts.length > 0 && <CustomSelect ariaLabel="Reasoning effort" value={settings?.effort ?? 'auto'} disabled={disabled} options={supportedEfforts.map((effort) => ({ value: effort, label: names[effort] }))} onChange={(effort) => { if (snapshot.sessionId) void command({ action: 'configure-effort', id: snapshot.sessionId, effort: effort as ReasoningEffort }) }} menuPlacement="up" className="reasoning-select" />}
  </div>
}
