import { accountPreferenceKey, type UnifiedAccountCatalog, type ConnectedAccount, type AccountRoute } from '../../../shared/unifiedAccounts'
import type { ReasoningEffort } from '../../../shared/conversations'
import type { AIConfiguration } from './aiConfiguration'
import type { ChatGPTAuth } from './chatGPTAuth'
import type { CursorACPService } from './cursorACP'
import type { CopilotService } from './copilotService'
import type { ClaudeAPIConfiguration } from './claudeAPI'
import type { AntigravityACPService } from './antigravityACP'
import type { ThirdPartyInferenceService } from './thirdPartyInference'
import { cursorConfigurationId, cursorModelVariant, cursorSelectableModels, type CursorModelConfiguration } from '../../../shared/cursor'
import { knownReasoningDefault, knownReasoningEfforts, resolveReasoningEfforts, verifiedModelCapabilities } from '../../../shared/modelCapabilities'
import { inferenceCatalogSelectable, inferenceModelEfforts } from '../../../shared/thirdPartyInference'
import { openAIAPIGptModels } from '../../../shared/modelCatalog'
import { openAIContext } from '../../../shared/modelLimits'

const cursorEffortValues: ReasoningEffort[] = ['auto', 'low', 'medium', 'high', 'xhigh', 'max']
const cursorEffortOption = (model: CursorModelConfiguration) => model.options.find(option => option.category === 'thought_level' || /effort|reason|thought[_ -]?level/i.test(`${option.id} ${option.name}`))
const cursorBaseId = (id: string) => (cursorModelVariant(id)?.baseId ?? id).replace(/^cursor-/i, '').toLowerCase()
class ProviderStatusTimeoutError extends Error {}

export class UnifiedAccounts {
  private cached: UnifiedAccountCatalog = { accounts: [], refreshedAt: 0 }
  private pending: Promise<UnifiedAccountCatalog> | null = null
  private pendingIsRefresh = false
  constructor(private services: { ai: AIConfiguration; chatGPT: ChatGPTAuth; cursor: CursorACPService; copilot: CopilotService; claude: ClaudeAPIConfiguration; antigravity: AntigravityACPService; thirdParty: ThirdPartyInferenceService }, private enabledPreferences: () => Record<string, boolean> = () => ({}), private statusTimeoutMs = 8_000) {}
  async list(refresh = false): Promise<UnifiedAccountCatalog> {
    // Keep the account/model snapshot stable while users move between screens
    // and conversations. Account mutations invalidate it; Settings also has
    // an explicit refresh action for provider-side changes made elsewhere.
    const cacheIsFresh = () => this.cached.refreshedAt > 0 && !this.cached.incomplete && Date.now() - this.cached.refreshedAt < 5 * 60_000
    if (!refresh && cacheIsFresh()) return this.cached
    if (this.pending) {
      const inFlight = this.pending
      const inFlightIsRefresh = this.pendingIsRefresh
      const result = await inFlight
      if (!refresh || inFlightIsRefresh) return result
    }
    if (!refresh && cacheIsFresh()) return this.cached
    // A refresh requested while a cached read is in flight must not be
    // swallowed by that older request. Wait for it, then collect fresh data.
    if (this.pending) return this.pending
    this.pendingIsRefresh = refresh
    let request: Promise<UnifiedAccountCatalog>
    request = this.collect(refresh).finally(() => {
      if (this.pending === request) {
        this.pending = null
        this.pendingIsRefresh = false
      }
    })
    this.pending = request
    return request
  }
  invalidate(): void { this.cached.refreshedAt = 0 }
  isEnabled(route: AccountRoute): boolean { return this.enabledPreferences()[accountPreferenceKey(route)] !== false }
  private bounded<T>(read: () => Promise<T>, timeoutMs = this.statusTimeoutMs): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new ProviderStatusTimeoutError('Provider status timed out.')), timeoutMs)
      void Promise.resolve().then(read).then(value => { clearTimeout(timer); resolve(value) }, error => { clearTimeout(timer); reject(error) })
    })
  }
  model(route: AccountRoute, id: string) { return this.cached.accounts.find(account => account.route.provider === route.provider && account.route.accountId === route.accountId)?.models.find(model => model.id === id || Object.values(model.effortModelIds ?? {}).includes(id) || Object.values(model.fastModelIds ?? {}).some(pair => pair.enabled === id || pair.disabled === id)) }
  private async collect(refresh: boolean): Promise<UnifiedAccountCatalog> {
    const s = this.services
    const previous = new Map(this.cached.accounts.map(account => [`${account.route.provider}:${account.route.accountId}`, account]))
    const reads: Array<() => Promise<unknown>> = [
      () => s.chatGPT.status(), () => s.cursor.status(refresh), () => s.copilot.aiStatus(refresh), () => s.copilot.command({ action: 'status' }),
      () => s.ai.getStatus(), () => s.claude.getStatus(), () => s.antigravity.status(), () => s.thirdParty.list(),
    ]
    const firstPass = await Promise.allSettled(reads.map(read => this.bounded(read)))
    // Keychain and provider SDK startup can exceed the first status deadline.
    // Resolve timed-out reads again before caching a catalog that would hide
    // connected accounts until the user clicks Refresh.
    const timedOut = (result: PromiseSettledResult<unknown>) => result.status === 'rejected' && result.reason instanceof ProviderStatusTimeoutError
    const sources = firstPass.some(timedOut)
      ? await Promise.allSettled(reads.map((read, index) => timedOut(firstPass[index])
        ? this.bounded(read, this.statusTimeoutMs * 2)
        : firstPass[index].status === 'fulfilled'
          ? Promise.resolve((firstPass[index] as PromiseFulfilledResult<unknown>).value)
          : Promise.reject((firstPass[index] as PromiseRejectedResult).reason)))
      : firstPass
    const value = <T>(index: number): T | undefined => sources[index].status === 'fulfilled' ? (sources[index] as PromiseFulfilledResult<T>).value : undefined
    const accounts: ConnectedAccount[] = []
    const chatgpt = value<Awaited<ReturnType<typeof s.chatGPT.status>>>(0)
    for (const account of chatgpt?.accounts ?? []) {
      const route = { provider: 'subscription' as const, accountId: account.id }
      const canUseAccount = account.active && account.connected && account.planEnabled && account.enabled
      accounts.push({
        route, name: 'ChatGPT', identity: account.email ?? undefined,
        enabled: this.isEnabled(route),
        state: account.connected && account.planEnabled ? 'connected' : 'expired',
        message: account.active ? account.message : `${account.message} Select this account in Settings → AI before using its models.`,
        models: account.models.map(model => ({ id: model.slug, label: model.displayName, ...(model.contextWindow ? { contextLimits: { contextWindow: model.contextWindow, source: 'reported' as const } } : {}), available: canUseAccount, ...(knownReasoningEfforts('subscription', model.slug) ? { efforts: knownReasoningEfforts('subscription', model.slug)! } : {}) })),
      })
    }
    const cursor = value<Awaited<ReturnType<typeof s.cursor.status>>>(1)
    if (cursor?.authenticated || previous.has('cursor:cursor')) {
      const cliModels = cursor?.authenticated ? cursorSelectableModels(cursor.models, cursor.modelCatalogAvailable).filter(model => !/^auto(?:\/model)?$/i.test(model.id)) : []
      // The composer exposes only verified Grok agent models. Cursor's CLI
      // catalog includes chat models the Athena ACP adapter cannot safely use
      // for project tools, plus many parameter variants of each base model.
      const grokCliModels = cliModels.filter(model => verifiedModelCapabilities(model.id, 'cursor-acp').capabilities.has('tool-calling'))
      const availableBases = new Set(grokCliModels.map(model => cursorBaseId(model.id)))
      const configured = cursor?.modelConfigurations?.filter(model => {
        const baseId = cursorBaseId(model.id)
        return /^grok-4\.(?:6|7)$/.test(baseId) && availableBases.has(baseId)
      }).map(model => {
        const values = Object.fromEntries(model.options.map(option => [option.id, option.currentValue]))
        const effort = cursorEffortOption(model)
        const fast = model.options.find(option => option.id === 'fast' && option.options.some(entry => entry.value === 'true') && option.options.some(entry => entry.value === 'false'))
        // Cursor's catalog can report Fast as the current choice. Keep the
        // default neutral; users opt into the faster usage tier explicitly.
        if (fast) values[fast.id] = 'false'
        const effortModelIds: Partial<Record<ReasoningEffort, string>> = {}
        const fastModelIds: NonNullable<ConnectedAccount['models'][number]['fastModelIds']> = {}
        for (const option of effort?.options ?? []) {
          const normalized = option.value.toLowerCase() as ReasoningEffort
          if (!cursorEffortValues.includes(normalized)) continue
          const effortValues = { ...values, [effort!.id]: option.value }
          effortModelIds[normalized] = cursorConfigurationId(model, effortValues)
          if (fast) fastModelIds[normalized] = {
            enabled: cursorConfigurationId(model, { ...effortValues, [fast.id]: 'true' }),
            disabled: cursorConfigurationId(model, { ...effortValues, [fast.id]: 'false' }),
          }
        }
        if (!effort && fast) fastModelIds.auto = {
          enabled: cursorConfigurationId(model, { ...values, [fast.id]: 'true' }),
          disabled: cursorConfigurationId(model, { ...values, [fast.id]: 'false' }),
        }
        return {
          id: cursorConfigurationId(model, values),
          label: model.name,
          available: true,
          ...(Object.keys(effortModelIds).length ? { efforts: Object.keys(effortModelIds) as ReasoningEffort[], effortModelIds } : {}),
          ...(Object.keys(fastModelIds).length ? { fastModelIds } : {}),
          capabilities: ['text-input', 'tool-calling', 'image-input', 'file-input'],
        }
      }) ?? []
      const fallbackByBase = new Map<string, { id: string; label: string; available: boolean; efforts?: ReasoningEffort[]; effortModelIds?: Partial<Record<ReasoningEffort, string>>; fastModelIds?: NonNullable<ConnectedAccount['models'][number]['fastModelIds']>; capabilities: string[] }>()
      const fallbackFastPairs = new Map<string, Partial<Record<ReasoningEffort, Partial<{ enabled: string; disabled: string }>>>>()
      for (const model of grokCliModels) {
        const variant = cursorModelVariant(model.id)
        const baseId = cursorBaseId(model.id)
        const label = model.label.replace(/\s+(?:none|low|medium|extra high|max)(?:\s+fast)?$/i, '').replace(/\s+fast$/i, '')
        const group = fallbackByBase.get(baseId) ?? { id: model.id, label, available: true, capabilities: ['text-input', 'tool-calling', 'image-input', 'file-input'] }
        const effort = cursorEffortValues.find(value => value === variant?.effort)
        if (effort) {
          group.efforts = [...new Set([...(group.efforts ?? []), effort])]
          const existingEffortId = group.effortModelIds?.[effort]
          const existingVariant = existingEffortId ? cursorModelVariant(existingEffortId) : null
          if (!existingEffortId || existingVariant?.fast === true && variant?.fast === false) group.effortModelIds = { ...(group.effortModelIds ?? {}), [effort]: model.id }
          if (variant?.fast !== null && variant?.fast !== undefined) {
            const pairs = fallbackFastPairs.get(baseId) ?? {}
            const pair = pairs[effort] ?? {}
            const next = { ...pair, [variant.fast ? 'enabled' : 'disabled']: model.id }
            fallbackFastPairs.set(baseId, { ...pairs, [effort]: next })
            if (next.enabled && next.disabled) group.fastModelIds = { ...(group.fastModelIds ?? {}), [effort]: { enabled: next.enabled, disabled: next.disabled } }
          }
          if (variant?.fast === false && cursorModelVariant(group.id)?.fast === true) group.id = model.id
          if ((model.recommended || model.isDefault) && variant?.fast !== true) group.id = model.id
        }
        fallbackByBase.set(baseId, group)
      }
      const fallback = [...fallbackByBase.values()]
      const route = { provider: 'cursor' as const, accountId: 'cursor' }; accounts.push({ route, name: 'Cursor', identity: cursor?.identity ?? undefined, enabled: this.isEnabled(route), state: cursor?.authenticated ? 'connected' : 'expired', message: cursor?.message, models: configured.length ? configured : fallback })
    }
    const copilot = value<Awaited<ReturnType<typeof s.copilot.aiStatus>>>(2)
    const copilotDetails = value<Awaited<ReturnType<typeof s.copilot.command>>>(3)
    const copilotAccount = copilotDetails?.accounts.find(account => account.id === copilotDetails.activeId)
    if (copilotAccount) { const route = { provider: 'copilot' as const, accountId: copilotAccount.id }; accounts.push({ route, name: 'GitHub Copilot', identity: copilotAccount.login, enabled: this.isEnabled(route), state: copilot?.status.active ? 'connected' : 'expired', models: (copilot?.status.models ?? []).map(id => ({ id, label: copilot?.status.modelLabels?.[id] ?? id, available: Boolean(copilot?.status.active), ...(copilot?.status.modelEfforts?.[id] !== undefined ? { efforts: copilot.status.modelEfforts[id] } : {}), capabilities: copilot?.status.modelCapabilities?.[id] })) }) }
    const openai = value<Awaited<ReturnType<typeof s.ai.getStatus>>>(4)
    if (openai?.status.hasKey) { const route = { provider: 'cloud' as const, accountId: 'openai-api' }; accounts.push({ route, name: 'OpenAI API', enabled: this.isEnabled(route), state: openai.status.active ? 'connected' : 'expired', lastVerifiedAt: openai.status.lastVerifiedAt, models: openAIAPIGptModels(openai.status.models).map(id => ({ id, label: id, available: openai.status.active, ...(resolveReasoningEfforts('cloud', id, openai.status.modelEfforts?.[id]) !== undefined ? { efforts: resolveReasoningEfforts('cloud', id, openai.status.modelEfforts?.[id])! } : {}) })) }) }
    const claude = value<Awaited<ReturnType<typeof s.claude.getStatus>>>(5)
    if (claude?.status.hasKey) { const route = { provider: 'claude-api' as const, accountId: 'claude-api' }; accounts.push({ route, name: 'Claude API', enabled: this.isEnabled(route), state: claude.status.active ? 'connected' : 'expired', lastVerifiedAt: claude.status.lastVerifiedAt, models: claude.status.models.map(id => ({ id, label: id, ...(claude.status.modelContextLimits?.[id] ? { contextLimits: { ...claude.status.modelContextLimits[id], maxRequestBytes: 500_000, source: 'reported' as const } } : {}), available: claude.status.active, ...(resolveReasoningEfforts('claude-api', id, claude.status.modelEfforts?.[id]) ? { efforts: resolveReasoningEfforts('claude-api', id, claude.status.modelEfforts?.[id])! } : {}), ...((claude.status.modelEffortDefaults?.[id] ?? knownReasoningDefault('claude-api', id)) ? { effortDefault: claude.status.modelEffortDefaults?.[id] ?? knownReasoningDefault('claude-api', id)! } : {}) })) }) }
    const antigravity = value<Awaited<ReturnType<typeof s.antigravity.status>>>(6)
    if (antigravity?.authState === 'authenticated' || previous.has('antigravity:antigravity')) { const route = { provider: 'antigravity' as const, accountId: 'antigravity' }; accounts.push({ route, name: 'Google Antigravity', enabled: this.isEnabled(route), state: antigravity?.authState === 'authenticated' ? 'connected' : 'unavailable', lastVerifiedAt: antigravity?.lastCheckedAt, message: antigravity?.message, models: (antigravity?.models ?? []).map(model => ({ id: model.id, label: model.name, available: antigravity?.authState === 'authenticated', ...(antigravity?.modelEfforts[model.id] !== undefined ? { efforts: antigravity.modelEfforts[model.id] } : {}), ...(antigravity?.modelEffortDefaults[model.id] ? { effortDefault: antigravity.modelEffortDefaults[model.id] } : {}) })) }) }
    const profiles = value<Awaited<ReturnType<typeof s.thirdParty.list>>>(7)
    for (const profile of profiles ?? []) {
      const route = { provider: 'third-party' as const, accountId: profile.id }, selectable = inferenceCatalogSelectable(profile)
      accounts.push({ route, name: profile.name, enabled: profile.enabled && this.isEnabled(route), state: profile.status === 'connected' ? 'connected' : inferenceCatalogSelectable(profile) ? 'limited' : 'unavailable', message: profile.statusMessage, lastVerifiedAt: profile.lastSuccessfulTestAt, models: profile.models.map(model => { const capabilities = { ...model.reportedCapabilities, ...model.configuredCapabilities }; const effortDefault = capabilities.reasoningDefault as ReasoningEffort | undefined; const efforts = inferenceModelEfforts(model); return { contextLimits: { ...(profile.protocol === 'anthropic-messages' ? { maxRequestBytes: 500_000 } : {}), contextWindow: capabilities.contextWindow && model.reportedCapabilities?.contextWindow ? Math.min(capabilities.contextWindow, model.reportedCapabilities.contextWindow) : capabilities.contextWindow, maxOutputTokens: capabilities.maxOutputTokens, source: model.configuredCapabilities?.contextWindow ? 'configured' as const : capabilities.contextWindow ? 'reported' as const : 'fallback' as const }, id: model.id, label: model.displayName ?? model.id, available: selectable && model.enabled, ...(efforts !== undefined ? { efforts } : {}), ...(effortDefault ? { effortDefault } : {}), capabilities: Object.entries(capabilities).filter(([, enabled]) => enabled === true).map(([name]) => name) } }) })
    }
    for (const account of accounts) if (account.state !== 'connected' && !account.models.length) {
      const old = previous.get(`${account.route.provider}:${account.route.accountId}`)
      if (old) account.models = old.models.filter(model => account.route.provider !== 'cloud' || account.route.accountId !== 'openai-api' || openAIAPIGptModels([model.id]).length > 0).map(model => ({ ...model, available: false }))
    }
    for (const [key, old] of previous) if (!accounts.some(account => `${account.route.provider}:${account.route.accountId}` === key)) accounts.push({ ...old, enabled: this.isEnabled(old.route), state: 'unavailable', models: old.models.filter(model => old.route.provider !== 'cloud' || old.route.accountId !== 'openai-api' || openAIAPIGptModels([model.id]).length > 0).map(model => ({ ...model, available: false })) })
    for (const account of accounts) if (account.route.provider === 'cloud' || account.route.provider === 'subscription') {
      for (const model of account.models) {
        const { limits, source } = openAIContext(model.id, account.route.provider === 'subscription', model.contextLimits?.source === 'reported' ? model.contextLimits.contextWindow : undefined)
        model.contextLimits = { contextWindow: limits.context, maxOutputTokens: limits.output, source }
      }
    }
    this.cached = { accounts, refreshedAt: Date.now(), incomplete: sources.some(result => result.status === 'rejected') }
    return this.cached
  }
}
