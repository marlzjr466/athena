import { z } from 'zod'
import type { ProjectTools } from './AIProvider'
import { ChatError } from './AIProvider'
import type { ApplicationDetectionController } from '../applicationDetection/applicationDetectionController'

const empty = z.object({}).strict()
const definitions = [
  { name: 'get_active_app', description: 'Read the current frontmost macOS application name and bundle identifier. If Athena is frontmost because the user is chatting, say so; do not infer the app behind Athena. Requires the user-enabled Application Detection permission.', schema: empty },
  { name: 'get_running_apps', description: 'List currently running, user-facing macOS applications by name and bundle identifier. Read-only and on-demand; does not inspect windows or app contents. Requires the user-enabled Application Detection permission.', schema: empty },
] as const

export function createApplicationTools(controller: ApplicationDetectionController, selected: () => boolean, beforeAction?: (name: string, input: unknown, signal: AbortSignal) => Promise<void>): ProjectTools {
  const assertAccess = () => { if (!selected()) throw new ChatError('The conversation changed. Application detection stopped.') }
  return {
    definitions: definitions.map(({ name, description, schema }) => {
      const { $schema: _schema, ...parameters } = z.toJSONSchema(schema)
      return { name, description, parameters }
    }),
    assertAccess,
    parallelSafe: () => true,
    async execute(name, input, signal) {
      assertAccess()
      const definition = definitions.find((entry) => entry.name === name)
      if (!definition) return JSON.stringify({ error: 'Unknown application detection tool.' })
      if (!definition.schema.safeParse(input).success) return JSON.stringify({ error: 'Invalid application detection arguments.' })
      try {
        if (!controller.isAllowed()) throw new ChatError('Application Detection permission is required.')
        await beforeAction?.(name, input, signal)
        assertAccess(); signal.throwIfAborted()
        const result = name === 'get_active_app'
          ? { active: await controller.active(signal) }
          : { running: await controller.running(signal) }
        assertAccess()
        return JSON.stringify(result)
      } catch (error) {
        assertAccess()
        if (signal.aborted) throw new ChatError('Application detection was cancelled.')
        return JSON.stringify({ error: error instanceof ChatError ? error.userMessage : 'Application detection failed.' })
      }
    },
  }
}

export function combineTools(base: ProjectTools | undefined, application: ProjectTools | undefined): ProjectTools | undefined {
  if (!base) return application
  if (!application) return base
  const appNames = new Set(application.definitions.map((entry) => entry.name))
  return {
    ...base,
    policy: [base.policy, application.policy].filter(Boolean).join('\n') || undefined,
    maxRounds: Math.max(base.maxRounds ?? 0, application.maxRounds ?? 0) || undefined,
    maxCalls: Math.max(base.maxCalls ?? 0, application.maxCalls ?? 0) || undefined,
    timeoutMs: Math.max(base.timeoutMs ?? 0, application.timeoutMs ?? 0) || undefined,
    maxArgumentBytes: Math.max(base.maxArgumentBytes ?? 0, application.maxArgumentBytes ?? 0) || undefined,
    definitions: [...base.definitions, ...application.definitions],
    assertAccess: () => { base.assertAccess(); application.assertAccess() },
    parallelSafe: (name) => appNames.has(name) ? application.parallelSafe?.(name) ?? false : base.parallelSafe?.(name) ?? false,
    execute: (name, input, signal) => appNames.has(name) ? application.execute(name, input, signal) : base.execute(name, input, signal),
    formatOutput: (result) => base.formatOutput?.(result) ?? application.formatOutput?.(result),
    hasEphemeralContext: () => Boolean(base.hasEphemeralContext?.() || application.hasEphemeralContext?.()),
    invalidate: () => { base.invalidate?.(); application.invalidate?.() },
    continuation: () => { base.continuation?.(); application.continuation?.() },
    dispose: async () => { await Promise.all([base.dispose?.(), application.dispose?.()]) },
    validateCompletion: async () => { await base.validateCompletion?.(); await application.validateCompletion?.() },
    additionalCostUsd: () => (base.additionalCostUsd?.() ?? 0) + (application.additionalCostUsd?.() ?? 0),
  }
}
