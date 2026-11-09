import { describe, expect, it, vi } from 'vitest'
import { configureCursorSessionModel } from '../electron/main/ai/cursorACP'
import { cursorConfigurationId, cursorModelAvailable, cursorModelIdSchema, cursorSelection, parseCursorConfigurationCatalog } from '../shared/cursor'

export const cursorConfigurations = parseCursorConfigurationCatalog([
  { value: 'grok-4.6', name: 'Grok 4.6', configOptions: [
    { id: 'effort', name: 'Effort', category: 'thought_level', type: 'select', currentValue: 'high', options: [{ value: 'medium', name: 'Medium' }, { value: 'high', name: 'High' }] },
    { id: 'fast', name: 'Fast', category: 'model_config', type: 'select', currentValue: 'true', options: [{ value: 'false', name: 'Off' }, { value: 'true', name: 'Fast' }] },
  ] },
  { value: 'grok-4.7', name: 'Grok 4.7', configOptions: [
    { id: 'context', name: 'Context', type: 'select', currentValue: '256k', options: [{ value: '256k', name: '256K' }, { value: '500k', name: '500K' }] },
    { id: 'reasoning_effort', name: 'Effort', category: 'thought_level', type: 'select', currentValue: 'high', options: [{ value: 'medium', name: 'Medium' }, { value: 'high', name: 'High' }] },
    { id: 'fast', name: 'Fast', type: 'select', currentValue: 'true', options: [{ value: 'false', name: 'Off' }, { value: 'true', name: 'Fast' }] },
  ] },
])
const catalog = ['cursor-grok-4.6-medium', 'cursor-grok-4.6-high-fast'].map((id) => ({ id, label: id }))

function fakeSession() {
  let base = 'grok-4.6'
  let values: Record<string, string> = { effort: 'high', fast: 'true' }
  const snapshot = () => ({
    sessionId: 'test-session',
    configOptions: [
      { id: 'model', category: 'model', type: 'select', currentValue: base, options: cursorConfigurations.map((model) => ({ value: model.id, name: model.name })) },
      ...cursorConfigurations.find((model) => model.id === base)!.options.map((option) => ({ ...option, currentValue: values[option.id] })),
    ],
  })
  const request = vi.fn(async (_method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> => {
    if (params.configId === 'model') {
      base = String(params.value)
      values = Object.fromEntries(cursorConfigurations.find((model) => model.id === base)!.options.map((option) => [option.id, option.currentValue]))
    } else values[String(params.configId)] = String(params.value)
    return snapshot()
  })
  return { request, snapshot }
}

describe('Cursor parameterized selection', () => {
  it('applies Medium and explicitly disables Fast despite the saved High/Fast setting', async () => {
    const client = fakeSession()
    expect(await configureCursorSessionModel(client, client.snapshot(), catalog[0].id, catalog, cursorConfigurations)).toBe('grok-4.6[effort=medium,fast=false]')
    expect(client.request.mock.calls.map(([method, params]) => [method, params.configId, params.value])).toEqual([
      ['session/set_config_option', 'model', 'grok-4.6'],
      ['session/set_config_option', 'effort', 'medium'],
      ['session/set_config_option', 'fast', 'false'],
    ])
  })
  it('applies independent context, effort and speed choices and restores a saved choice', async () => {
    const client = fakeSession()
    const id = 'grok-4.7[context=500k,reasoning_effort=medium,fast=false]'
    expect(await configureCursorSessionModel(client, client.snapshot(), id, catalog, cursorConfigurations)).toBe(id)
    expect(await configureCursorSessionModel(client, client.snapshot(), catalog[1].id, catalog, cursorConfigurations)).toBe('grok-4.6[effort=high,fast=true]')
  })
  it('does not accept stale settings when Cursor ignores an acknowledged parameter', async () => {
    const client = fakeSession()
    const initial = client.snapshot()
    const stuck = { request: vi.fn(async () => initial) }
    await expect(configureCursorSessionModel(stuck, initial, catalog[0].id, catalog, cursorConfigurations)).rejects.toThrow(/did not confirm.*No prompt was sent/)
  })
  it('does not retry rejected settings or fall back to another model', async () => {
    const client = fakeSession()
    const denied = { request: vi.fn(async () => { throw new Error('unsupported') }) }
    await expect(configureCursorSessionModel(denied, client.snapshot(), catalog[0].id, catalog, cursorConfigurations)).rejects.toThrow(/No prompt was sent/)
    expect(denied.request).toHaveBeenCalledTimes(1)
  })
  it('validates full parameter selections without inventing context or effort options', () => {
    const id = 'grok-4.7[context=500k,reasoning_effort=medium,fast=false]'
    const selection = cursorSelection(id, cursorConfigurations)!
    expect(cursorConfigurationId(selection.model, selection.values)).toBe(id)
    expect(cursorModelIdSchema.safeParse(id).success).toBe(true)
    expect(cursorModelAvailable({ models: catalog, modelConfigurations: cursorConfigurations }, id)).toBe(true)
    for (const bad of [
      'grok-4.7[context=1m,reasoning_effort=medium,fast=false]',
      'grok-4.7[context=500k,reasoning_effort=xhigh,fast=false]',
      'grok-4.7[context=500k,reasoning_effort=medium]',
      'grok-4.7[context=500k,reasoning_effort=medium,fast=false,fast=true]',
    ]) expect(cursorSelection(bad, cursorConfigurations)).toBeNull()
    expect(cursorModelIdSchema.safeParse('grok;echo secret').success).toBe(false)
  })
  it('uses the advertised Auto model and does not treat a bare configurable base as a complete selection', () => {
    const configurations = [...cursorConfigurations, { id: 'default', name: 'Auto', options: [] }]
    expect(cursorSelection('auto', configurations)?.model.id).toBe('default')
    expect(cursorModelAvailable({ models: catalog, modelConfigurations: configurations }, 'default')).toBe(true)
    expect(cursorModelAvailable({ models: catalog, modelConfigurations: configurations }, 'grok-4.7')).toBe(false)
  })
})
