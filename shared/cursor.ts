import { z } from 'zod'

export interface CursorModel {
  /** Exact identifier accepted by the installed Cursor CLI's --model option. */
  id: string
  /** Presentation label reported by the CLI, or a readable form of the ID. */
  label: string
  family?: string
  releasedAt?: string
  recommended?: boolean
  isDefault?: boolean
}

export interface CursorStatus {
  installed: boolean
  authenticated: boolean
  /** Unknown means `agent status` could not prove either state; ACP must still authenticate before prompting. */
  authenticationStatus?: 'authenticated' | 'unauthenticated' | 'unknown'
  identity: string | null
  version: string | null
  message: string
  models: CursorModel[]
  modelCatalogAvailable: boolean
  modelConfigurations?: CursorModelConfiguration[]
}

export interface CursorConfigOption {
  id: string
  name: string
  category?: string
  currentValue: string
  options: { value: string; name: string }[]
}
export interface CursorModelConfiguration { id: string; name: string; options: CursorConfigOption[] }
export interface CursorSelection { model: CursorModelConfiguration; values: Record<string, string> }

export function parseCursorConfigurationCatalog(value: unknown): CursorModelConfiguration[] {
  const option = z.object({
    id: z.string().regex(/^[\w-]+$/), name: z.string(), category: z.string().optional(), type: z.literal('select'),
    currentValue: z.string(), options: z.array(z.object({ value: z.string().regex(/^[\w.-]+$/), name: z.string() })).min(1),
  })
  const models = z.array(z.object({ value: z.string().regex(/^[\w./:-]+$/), name: z.string(), configOptions: z.array(option) })).safeParse(value)
  if (!models.success) return []
  return models.data.map((model) => ({ id: model.value, name: model.name, options: model.configOptions }))
}

export function cursorConfigurationId(model: CursorModelConfiguration, values: Record<string, string>): string {
  return model.options.length ? `${model.id}[${model.options.map((option) => `${option.id}=${values[option.id]}`).join(',')}]` : model.id
}

/** Resolve persisted CLI slugs or explicit parameter selections against live capabilities. */
export function cursorSelection(id: string, configurations: CursorModelConfiguration[], catalog: CursorModel[] = []): CursorSelection | null {
  const compound = /^([^\[\]]+)\[([^\]]+)\]$/.exec(id)
  if (compound) {
    const model = configurations.find((entry) => entry.id === compound[1])
    if (!model) return null
    const pairs = compound[2].split(',').map((part) => part.split('='))
    if (pairs.some((pair) => pair.length !== 2) || new Set(pairs.map(([key]) => key)).size !== pairs.length) return null
    const values = Object.fromEntries(pairs)
    if (pairs.length !== model.options.length || model.options.some((option) => !option.options.some((entry) => entry.value === values[option.id]))) return null
    return { model, values }
  }
  const variant = cursorModelVariant(id)
  const base = (variant?.baseId ?? id.replace(/-fast$/, '')).replace(/^cursor-/, '')
  const model = configurations.find((entry) => entry.id === base)
    ?? (id === 'auto' || id === 'auto/model' ? configurations.find((entry) => entry.name === 'Auto' && ['default', 'auto'].includes(entry.id)) : undefined)
  if (!model) return null
  const values = Object.fromEntries(model.options.map((option) => [option.id, option.currentValue]))
  const effort = model.options.find((option) => option.category === 'thought_level')
  if (effort && variant?.effort) values[effort.id] = variant.effort
  if (model.options.some((option) => option.id === 'fast')) values.fast = id.endsWith('-fast') ? 'true' : 'false'
  const context = model.options.find((option) => option.id === 'context')
  const labelContext = catalog.find((entry) => entry.id === id)?.label.match(/\b(\d+(?:\.\d+)?[km])\b/i)?.[1].toLowerCase()
  if (context && labelContext && context.options.some((entry) => entry.value === labelContext)) values.context = labelContext
  if (model.options.some((option) => !option.options.some((entry) => entry.value === values[option.id]))) return null
  return { model, values }
}

export function cursorConfigurationLabel(selection: CursorSelection): string {
  const effort = selection.model.options.find((option) => option.category === 'thought_level' && /effort|reasoning|thought_level/i.test(option.id))
  const effortLabel = effort?.options.find((option) => option.value === selection.values[effort.id])?.name
  return `${selection.model.name}${effortLabel ? ` ${effortLabel}` : ''}${selection.values.fast === 'true' ? ' Fast' : ''}`
}

export function cursorModelAvailable(status: Pick<CursorStatus, 'models' | 'modelConfigurations'>, id: string): boolean {
  const selection = cursorSelection(id, status.modelConfigurations ?? [])
  return status.models.some((entry) => entry.id === id)
    || Boolean(selection && (id.includes('[') || selection.model.options.length === 0))
}

export type CursorEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export interface CursorModelVariant { baseId: string; effort: CursorEffort | null; fast: boolean | null }

/** Effort and speed are part of Cursor's exact model ID, not ACP request options. */
export function cursorModelVariant(id: string): CursorModelVariant | null {
  const match = /^(.*?)(?:-(none|low|medium|high|xhigh|max))(-fast)?$/i.exec(id)
  if (!match) return null
  return { baseId: match[1], effort: match[2].toLowerCase() as CursorEffort, fast: Boolean(match[3]) }
}

export function cursorReportedModelVariant(id: string | null): CursorModelVariant | null {
  if (!id) return null
  const catalogVariant = cursorModelVariant(id)
  if (catalogVariant) return catalogVariant
  const match = /^([^\[\]]+)\[([^\]]*)\]$/.exec(id.trim())
  if (!match) return null
  const parameters = new Map<string, string>(match[2].split(',').map((item): [string, string] => {
    const separator = item.indexOf('=')
    return separator < 0
      ? [item.trim().toLowerCase(), '']
      : [item.slice(0, separator).trim().toLowerCase(), item.slice(separator + 1).trim().toLowerCase()]
  }))
  const rawEffort = parameters.get('effort') ?? parameters.get('reasoning_effort') ?? parameters.get('reasoning')
  const supportedEfforts: CursorEffort[] = ['none', 'low', 'medium', 'high', 'xhigh', 'max']
  const effort = supportedEfforts.find((item) => item === rawEffort) ?? null
  const fastValue = parameters.get('fast')
  return {
    baseId: match[1].trim(),
    effort,
    fast: fastValue === 'true' ? true : fastValue === 'false' ? false : null,
  }
}

/**
 * Cursor ACP reports an internal variant string (for example
 * `grok-4.6[effort=high,fast=true]`) while `agent models` exposes the exact
 * `--model` ID (`cursor-grok-4.6-high-fast`). Resolve only when the reported
 * parameters identify one unambiguous entry in the installed CLI catalog.
 */
export function cursorCatalogModelFromEffective(effective: string | null, models: CursorModel[]): string | null {
  if (!effective?.trim()) return null
  const reported = effective.trim()
  const exact = models.find((model) => model.id === reported)
  if (exact) return exact.id

  const expectedVariant = cursorReportedModelVariant(reported)
  if (!expectedVariant?.effort) return null
  const baseId = expectedVariant.baseId.replace(/^cursor-/i, '').toLowerCase()
  const candidates = models.filter((model) => {
    const candidateVariant = cursorModelVariant(model.id)
    return candidateVariant?.baseId.replace(/^cursor-/i, '').toLowerCase() === baseId
      && candidateVariant.effort === expectedVariant.effort
      && (expectedVariant.fast === null || candidateVariant.fast === expectedVariant.fast)
  })
  return candidates.length === 1 ? candidates[0].id : null
}

export function cursorEffectiveSelectionMatches(requested: string | null, effective: string | null, models: CursorModel[]): boolean {
  if (!requested || requested === 'cursor-managed') return true
  return cursorCatalogModelFromEffective(effective, models) === requested
}

export function cursorModelEffortOptions(models: CursorModel[], selectedId: string): CursorEffort[] {
  const selected = cursorModelVariant(selectedId)
  if (!selected) return []
  return [...new Set(models.flatMap((model) => {
    const variant = cursorModelVariant(model.id)
    return variant?.baseId === selected.baseId && variant.effort ? [variant.effort] : []
  }))].sort((a, b) => ['none', 'low', 'medium', 'high', 'xhigh', 'max'].indexOf(a) - ['none', 'low', 'medium', 'high', 'xhigh', 'max'].indexOf(b))
}

export function cursorModelVariantId(models: CursorModel[], currentId: string, effort: CursorEffort, fast?: boolean): string | null {
  const current = cursorModelVariant(currentId)
  if (!current) return null
  return models.find((model) => {
    const variant = cursorModelVariant(model.id)
    return variant?.baseId === current.baseId && variant.effort === effort && (fast === undefined || variant.fast === fast)
  })?.id ?? null
}

export function cursorModelFastPairAvailable(models: CursorModel[], id: string): boolean {
  const selected = cursorModelVariant(id)
  return Boolean(selected && [false, true].every((fast) => models.some((model) => {
    const variant = cursorModelVariant(model.id)
    return variant?.baseId === selected.baseId && variant.effort === selected.effort && variant.fast === fast
  })))
}

export function cursorModelDisplayLabel(model: CursorModel): string {
  const variant = cursorModelVariant(model.id)
  if (!variant) return model.label
  const baseLabel = model.label
    .replace(/\s+(?:none|low|medium|high|extra high|max)(?:\s+fast)?$/i, '')
    .replace(/\s+fast$/i, '')
  const effortLabel = variant.effort === 'xhigh' ? 'Extra High' : variant.effort === 'none' ? 'None' : variant.effort ? variant.effort[0].toUpperCase() + variant.effort.slice(1) : 'Effort unavailable'
  return `${baseLabel} · ${effortLabel}${variant.fast ? ' · Fast' : ''}`
}

export function cursorSelectableModels(models: CursorModel[], modelCatalogAvailable = true): CursorModel[] {
  if (!modelCatalogAvailable) return models.filter((model) => model.id === 'cursor-managed')
  return models.filter((model) => model.id !== 'cursor-managed')
}

export function cursorModelFamily(model: CursorModel): string {
  if (model.family?.trim()) return model.family.trim()
  const id = model.id.replace(/^cursor-/, '')
  const prefix = id.split(/[\s._:/-]/)[0] || model.label.split(/\s/)[0] || 'Other'
  return prefix.toLowerCase() === 'auto' ? 'Auto' : prefix.toUpperCase() === 'GPT' ? 'GPT' : prefix[0].toUpperCase() + prefix.slice(1)
}

export function groupCursorModels(models: CursorModel[]): { name: string; models: CursorModel[] }[] {
  const groups = new Map<string, CursorModel[]>()
  for (const model of models) {
    const family = cursorModelFamily(model)
    groups.set(family, [...(groups.get(family) ?? []), model])
  }
  return [...groups].map(([name, entries]) => ({ name, models: entries }))
}

export function defaultCursorModel(status: CursorStatus): string | null {
  if (!status.authenticated) return null
  // Auto remains valid for saved conversations, but it is not an explicit
  // model choice to assign to newly created conversations.
  const models = cursorSelectableModels(status.models, status.modelCatalogAvailable)
    .filter((model) => model.id.toLowerCase() !== 'auto' && model.id.toLowerCase() !== 'auto/model')
  if (!status.modelCatalogAvailable) return models[0]?.id ?? null
  const dated = models.filter((model) => model.releasedAt && Number.isFinite(Date.parse(model.releasedAt)))
  if (dated.length === models.length && dated.length) return dated.reduce((latest, model) => Date.parse(model.releasedAt!) > Date.parse(latest.releasedAt!) ? model : latest).id
  return models.find((model) => model.isDefault)?.id ?? models.find((model) => model.recommended)?.id ?? null
}

/** Uses the selected account's exact model ID, or Cursor's managed default when discovery is unavailable. */
export function resolveCursorModel(status: CursorStatus, selectedModel: string | null | undefined): string | null {
  if (!status.modelCatalogAvailable) return selectedModel && selectedModel !== 'cursor-managed' ? selectedModel : null
  if (selectedModel && cursorModelAvailable(status, selectedModel)) return selectedModel
  return defaultCursorModel(status)
}
/** Cursor CLI accepts a model name as one --model argument, including spaces. */
export const cursorModelIdSchema = z.string().trim().min(1).max(200).regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:/ -]*(?:\[[a-zA-Z0-9_-]+=[a-zA-Z0-9_.-]+(?:,[a-zA-Z0-9_-]+=[a-zA-Z0-9_.-]+)*\])?$/)
