import { createHash } from 'node:crypto'
import type { ResponseFunctionToolCall } from 'openai/resources/responses/responses'
import type { StreamOptions, ProjectToolDefinition } from './AIProvider'
import type { ToolCallSession } from './toolCallSession'
import type { InferenceConnection } from '../../../shared/thirdPartyInference'
import { log } from '../logger'

type CompletionStatus = 'complete' | 'failed' | 'cancelled'

/**
 * Credential-free protocol diagnostics. This records identifiers, tool names,
 * counters and lifecycle state only; arguments, results, prompts and paths are
 * deliberately excluded.
 */
export class ThirdPartyToolDiagnostics {
  private readonly startedAt = performance.now()
  private completed = false
  private executed = 0
  private returned = 0
  private readonly common: Record<string, string | number | boolean>

  constructor(profile: InferenceConnection, model: string, options: StreamOptions, definitions: ProjectToolDefinition[]) {
    this.common = {
      connectionId: profile.id,
      provider: profile.provider,
      protocol: profile.protocol,
      model,
      activeProject: options.context?.projectName ? 'authorized-project-selected' : 'none',
      projectRef: options.context?.projectName ? createHash('sha256').update(options.context.projectName).digest('hex').slice(0, 12) : 'none',
      permissionMode: options.permissionMode ?? 'chat',
      registeredToolCount: definitions.length,
      registeredToolNames: definitions.map(tool => tool.name).sort().join(',').slice(0, 4000),
    }
  }

  request(round: number, sent: ProjectToolDefinition[]): void {
    log('ai.third_party_tools.request', {
      ...this.common,
      round,
      sentToolCount: sent.length,
      sentToolNames: sent.map(tool => tool.name).sort().join(',').slice(0, 4000),
    })
  }

  response(round: number, blockTypes: string[], stopReason: string, parsedToolCalls: number): void {
    log('ai.third_party_tools.response', {
      ...this.common,
      round,
      responseBlockTypes: [...new Set(blockTypes)].sort().join(',').slice(0, 1000),
      stopReason: stopReason.slice(0, 120) || 'unspecified',
      parsedToolCallCount: parsedToolCalls,
    })
  }

  async executeBatch(session: ToolCallSession, calls: ResponseFunctionToolCall[], maxOutputChars: number, round: number): Promise<string[]> {
    const startedAt = performance.now()
    const outputs = await session.executeBatch(calls, maxOutputChars)
    this.executed += calls.length
    this.returned += outputs.length
    log('ai.third_party_tools.execution', {
      ...this.common,
      round,
      toolNames: calls.map(call => call.name).join(',').slice(0, 4000),
      executedToolCount: calls.length,
      toolResultsReturned: outputs.length,
      durationMs: Math.round(performance.now() - startedAt),
    })
    return outputs
  }

  complete(status: CompletionStatus): void {
    if (this.completed) return
    this.completed = true
    log('ai.third_party_tools.complete', {
      ...this.common,
      executedToolCount: this.executed,
      toolResultsReturned: this.returned,
      durationMs: Math.round(performance.now() - this.startedAt),
      finalStatus: status,
    })
  }
}
