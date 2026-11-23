import type { ReasoningEffort } from '../../../shared/conversations'
import { resolveReasoningEfforts } from '../../../shared/modelCapabilities'
import type { AIStatus } from '../../../shared/ai'
import { openAIAPIGptModels, isAvailableOpenAIAPIGptModel } from '../../../shared/modelCatalog'
import { useChat } from '../../store/chatStore'
import { CustomSelect } from '../../components/ui/CustomSelect'
import { agentModes, type AgentMode } from '../../../shared/agent'
import { cursorModelDisplayLabel, cursorModelVariant, cursorSelectableModels } from '../../../shared/cursor'
import { CursorModelSelect } from './CursorModelSelect'
import { CursorConfiguredModelSelect } from './CursorConfiguredModelSelect'
import { desktop } from '../../services/desktop'
import { useEffect, useState } from 'react'
import { UnifiedModelSelect } from './UnifiedModelSelect'
import type { UnifiedAccountCatalog } from '../../../shared/unifiedAccounts'

export function ConversationControls({ config, catalog }: { config: AIStatus; catalog?: UnifiedAccountCatalog }) {
  const { snapshot, command, pending } = useChat()
  const [changingMode, setChangingMode] = useState(false)
  const settings = snapshot.config
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
  // Routed conversations retain the legacy `provider: OpenAI` conversation
  // field. The selected account route is authoritative for provider-specific
  // catalog rules, so GPT-only filtering must apply only to the OpenAI API
  // route (or an unrouted legacy OpenAI API conversation).
  const openAIAPI = settings?.accountRoute ? settings.accountRoute.provider === 'cloud' : config.provider === 'OpenAI' && !config.inferenceProfile
  const routedAccount = catalog?.accounts.find(account => account.route.provider === settings?.accountRoute?.provider && account.route.accountId === settings?.accountRoute?.accountId)
  const models = openAIAPI
    ? openAIAPIGptModels(settings?.accountRoute ? routedAccount?.models.map(model => model.id) ?? [] : config.models)
    : config.provider === 'Cursor Subscription'
      ? cursorModels
        .filter((model) => model.id.toLowerCase() !== 'auto' && model.id.toLowerCase() !== 'auto/model').map((model) => model.id)
      : config.models
  const cursorModelId = settings?.cursorPendingModel ?? settings?.cursorModel ?? settings?.model ?? ''
  const executionStatus = snapshot.sessions?.find((session) => session.id === snapshot.sessionId)?.executionStatus
  const disabled = pending || snapshot.phase !== 'idle' || executionStatus === 'running' || executionStatus === 'queued' || !snapshot.sessionId || (!catalog && !config.active)
  const permissionsDisabled = pending || changingMode || !snapshot.sessionId
  const workspaceId = snapshot.workspaces?.[0]?.id
  useEffect(() => {
    if (settings?.accountRoute || !config.inferenceProfile || !config.active || !snapshot.sessionId || snapshot.phase !== 'idle' || pending || executionStatus === 'running' || executionStatus === 'queued') return
    if (settings?.model && models.includes(settings.model)) return
    const model = config.model && models.includes(config.model) ? config.model : models[0]
    if (model && settings?.model !== model) void command({ action: 'configure-model', id: snapshot.sessionId, model })
  }, [command, config.active, config.inferenceProfile, config.model, executionStatus, models, pending, settings?.accountRoute, settings?.model, snapshot.phase, snapshot.sessionId])
  const changeMode = async (mode: AgentMode) => {
    if (!snapshot.sessionId) return
    if (mode === settings?.agentMode) return
    if ((snapshot.phase !== 'idle' || executionStatus === 'running' || executionStatus === 'queued') && !window.confirm('Changing project permissions will stop the current request. Completed operations remain recorded. Continue?')) return
    if (mode !== 'full-access') { await command({ action: 'agent-mode', id: snapshot.sessionId, mode }); return }
    if (!workspaceId || snapshot.workspaces?.[0]?.authorized !== true) {
      useChat.setState({ issue: 'Reconnect this project before enabling Full Access.' }); return
    }
    setChangingMode(true)
    try {
      const access = (await desktop.getPermissions()).filesystemAccess
      if (!access) throw new Error('Could not verify the current filesystem scope. Open Permissions and try again.')
      const switchToProjectOnly = access.active && access.mode !== 'project-only'
      const needsConfirmation = settings?.fullAccessWorkspaceId !== workspaceId
      if ((needsConfirmation || switchToProjectOnly) && !window.confirm(`Enable Full Access for this conversation and project? ${config.provider === 'Google Antigravity Subscription' ? 'Athena will automatically approve every native Antigravity ACP tool request, including commands that may use host resources or network access. Antigravity starts with its terminal sandbox enabled, but an approved request may run outside that sandbox. Operating-system restrictions still apply.' : 'Athena may automatically modify or overwrite files, delete files, execute terminal commands, install dependencies, change project configuration, and perform other authorized operations. Project boundaries and system permissions still apply.'}${switchToProjectOnly ? ' This will switch the current provider from Full Mac Access to Project Only, including its other conversations. You can restore Full Mac Access in Settings → Permissions.' : ''}`)) return
      if (switchToProjectOnly) {
        const result = await desktop.setFilesystemAccess({ mode: 'project-only' })
        if (!result.ok) { useChat.setState({ issue: result.message || 'Could not switch to Project Only.' }); return }
      }
      await command({ action: 'agent-mode', id: snapshot.sessionId, mode, ...(needsConfirmation ? { confirmed: true as const } : {}) })
    } catch (error) { useChat.setState({ issue: error instanceof Error ? error.message : 'Could not enable Full Access.' }) }
    finally { setChangingMode(false) }
  }
  const names: Record<ReasoningEffort, string> = { auto: 'Auto', none: 'None', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra High', max: 'Max' }
  const antigravity = config.provider === 'Google Antigravity Subscription'
  const modelOptions = [...(settings?.model && !models.includes(settings.model) && config.provider !== 'Cursor Subscription' ? [{ value: settings.model, label: antigravity || openAIAPI ? `${settings.model} · unavailable; choose a model` : `${settings.model} · saved`, disabled: true }] : []), ...models.map((model) => ({ value: model, label: config.modelLabels?.[model] ?? model }))]
  // ACP validates the persisted conversation model. Never display another
  // model as selected until the user has actually changed the conversation.
  const unavailableOpenAIAPIModel = openAIAPI && Boolean(settings?.model && (!settings?.accountRoute || routedAccount) && !isAvailableOpenAIAPIGptModel(settings.model, models))
  const selectedModel = antigravity || unavailableOpenAIAPIModel
    ? settings?.model ?? ''
    : settings?.model && models.includes(settings.model) ? settings.model : config.model && models.includes(config.model) ? config.model : models[0] ?? ''
  const routedModel = routedAccount?.models.find(model => model.id === settings?.model || Object.values(model.effortModelIds ?? {}).includes(settings?.model ?? '') || Object.values(model.fastModelIds ?? {}).some(pair => pair.enabled === settings?.model || pair.disabled === settings?.model))
  const discoveredEfforts = routedModel?.efforts ?? (settings?.accountRoute ? undefined : config.modelEfforts?.[selectedModel])
  const capabilityProvider = settings?.accountRoute?.provider ?? (config.provider === 'OpenAI' ? 'cloud' : config.provider === 'ChatGPT Subscription' ? 'subscription' : config.provider === 'Claude API' ? 'claude-api' : undefined)
  const resolvedEfforts = (settings?.accountRoute ? settings.accountRoute.provider === 'third-party' : Boolean(config.inferenceProfile))
    ? discoveredEfforts
    : resolveReasoningEfforts(capabilityProvider, settings?.model ?? selectedModel, discoveredEfforts)
  const supportedEfforts = resolvedEfforts ?? []
  const supportsReasoning = !unavailableOpenAIAPIModel && supportedEfforts.some(effort => effort !== 'auto')
  const configuredEffortDefault = routedModel?.effortDefault ?? (settings?.accountRoute ? undefined : config.modelEffortDefaults?.[selectedModel])
  const effortLabel = (effort: ReasoningEffort) => effort === 'auto' && configuredEffortDefault
    ? `Auto · ${names[configuredEffortDefault]} ${config.inferenceProfile ? 'configured' : 'runtime'} default`
    : names[effort]
  const cursorSelectedEffort = settings?.accountRoute?.provider === 'cursor' && routedModel
    ? (Object.entries(routedModel.effortModelIds ?? {}).find(([, modelId]) => modelId === settings.model)?.[0]
      ?? Object.entries(routedModel.fastModelIds ?? {}).find(([, pair]) => pair.enabled === settings.model || pair.disabled === settings.model)?.[0]) as ReasoningEffort | undefined
    : undefined
  const selectedEffort = cursorSelectedEffort ?? settings?.effort ?? 'auto'
  const cursorFastVariants = settings?.accountRoute?.provider === 'cursor' ? routedModel?.fastModelIds?.[selectedEffort] : undefined
  const cursorFastEnabled = Boolean(cursorFastVariants && settings?.model === cursorFastVariants.enabled)
  const effortOptions = [
    ...(config.provider === 'Google Antigravity Subscription' && !supportedEfforts.includes(selectedEffort)
      ? [{ value: selectedEffort, label: `${names[selectedEffort]} · unavailable for this model`, disabled: true }]
      : []),
    ...supportedEfforts.map((effort) => ({ value: effort, label: effortLabel(effort) })),
  ]
  return <div className="conversation-selectors">
    {!!snapshot.workspaces?.length && <CustomSelect ariaLabel="Coding agent permissions" value={settings?.agentMode ?? 'ask'} disabled={permissionsDisabled} options={Object.entries(agentModes).map(([value, label]) => ({ value, label, ...(value === 'full-access' ? { description: config.provider === 'Google Antigravity Subscription' ? 'Automatically approve Antigravity tool requests for this conversation.' : 'Automatically allow permission-controlled operations without asking for confirmation.' } : {}) }))} onChange={(mode) => void changeMode(mode as AgentMode)} menuPlacement="up" className={settings?.agentMode === 'full-access' ? 'full-access-active' : ''} />}
    {catalog ? <UnifiedModelSelect catalog={catalog} value={settings?.accountRoute && settings.model ? { ...settings.accountRoute, model: settings.model } : undefined} disabled={disabled} onChange={selection => { if (snapshot.sessionId) void command({ action: 'select-account-model', id: snapshot.sessionId, route: { provider: selection.provider, accountId: selection.accountId }, model: selection.model }) }} /> : config.provider === 'Cursor Subscription'
      ? supportedCursorConfigurations.length ? <CursorConfiguredModelSelect value={cursorModelId} models={cursorModels} configurations={supportedCursorConfigurations}
        pending={Boolean(settings?.cursorPendingModel)} disabled={disabled}
        onChange={(model) => { if (snapshot.sessionId) void command({ action: 'configure-model', id: snapshot.sessionId, model }) }} /> : <>
        <CursorModelSelect value={cursorModelId} pending={Boolean(settings?.cursorPendingModel)} catalogAvailable={config.modelCatalogAvailable !== false} disabled={disabled} models={cursorModels.filter((model) => model.id.toLowerCase() !== 'auto' && model.id.toLowerCase() !== 'auto/model').map((model) => ({ id: model.id, label: cursorModelDisplayLabel(model), family: config.modelFamilies?.[model.id] ?? model.id.split(/[\s._:/-]/)[0] }))} onChange={(model) => { if (snapshot.sessionId) void command({ action: 'configure-model', id: snapshot.sessionId, model }) }} />
      </>
      : <CustomSelect ariaLabel="Conversation model" value={selectedModel} disabled={disabled} options={modelOptions} onChange={(model) => { if (snapshot.sessionId) void command({ action: 'configure-model', id: snapshot.sessionId, model }) }} menuPlacement="up" className="conversation-model-selector" />}
    {supportsReasoning && supportedEfforts.length > 0 && <CustomSelect ariaLabel="Reasoning effort" value={selectedEffort} disabled={disabled} options={effortOptions} onChange={(effort) => {
      if (!snapshot.sessionId) return
      const selectedEffort = effort as ReasoningEffort
      const fastVariants = settings?.accountRoute?.provider === 'cursor' ? routedModel?.fastModelIds?.[selectedEffort] : undefined
      const cursorModel = fastVariants
        ? fastVariants[cursorFastEnabled ? 'enabled' : 'disabled']
        : settings?.accountRoute?.provider === 'cursor' ? routedModel?.effortModelIds?.[selectedEffort] : undefined
      if (cursorModel && settings?.accountRoute) void command({ action: 'select-account-model', id: snapshot.sessionId, route: settings.accountRoute, model: cursorModel })
      else void command({ action: 'configure-effort', id: snapshot.sessionId, effort: selectedEffort })
    }} menuPlacement="up" className="reasoning-select" />}
    {cursorFastVariants && settings?.accountRoute?.provider === 'cursor' && <button type="button" role="switch" aria-label="Cursor Fast mode" aria-checked={cursorFastEnabled} disabled={disabled} className="cursor-fast-control" onClick={() => {
      if (!snapshot.sessionId || !settings.accountRoute || settings.accountRoute.provider !== 'cursor') return
      void command({ action: 'select-account-model', id: snapshot.sessionId, route: settings.accountRoute, model: cursorFastVariants[cursorFastEnabled ? 'disabled' : 'enabled'] })
    }}><span>Fast</span><span className="cursor-picker-switch" data-checked={cursorFastEnabled} /></button>}
  </div>
}
