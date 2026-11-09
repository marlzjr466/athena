// @vitest-environment node
// Explicit diagnostic only: uses Athena's selected subscription account. Never
// writes project files or prints credentials/response content. Integration mode
// exposes only the existing read-only project tools and workspace boundary.
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import OpenAI from 'openai'
import { ChatGPTAuth } from '../electron/main/ai/chatGPTAuth'
import { ATHENA_PERSONALITY } from '../electron/main/ai/AIProvider'
import { SlashCommandService } from '../electron/main/ai/slashCommandService'
import { WorkspaceService } from '../electron/main/ai/workspaceService'
import type { WorkspaceGrants } from '../electron/main/ai/workspaceGrants'
import { OpenAIProvider } from '../electron/main/ai/OpenAIProvider'
import { createProjectTools } from '../electron/main/ai/projectTools'
vi.mock('electron', () => ({ app: { isPackaged: true }, shell: {} }))

describe('opt-in live slash response diagnostics', () => {
  it.skipIf(process.env.ATHENA_LIVE_SLASH_PROBE !== '1')('records response shapes for the active platform-init request without executing actions', async () => {
    const directory = join(homedir(), 'Library/Application Support/Athena')
    const library = JSON.parse(await readFile(`${directory}/conversations.json`, 'utf8'))
    const session = library.sessions.find((entry: { id: string }) => entry.id === library.activeId)
    const command = [...session.messages].reverse().find((entry: { command?: { name: string } }) => entry.command?.name === '/platform-init')
    const grants = JSON.parse(await readFile(`${directory}/workspace-grants.json`, 'utf8'))
    const grant = grants.grants.find((entry: { reference: { id: string } }) => entry.reference.id === session.workspaces[0]?.id)
    if (!command || !grant) throw new Error('The active command and workspace must exist for this diagnostic.')
    const workspaces = new WorkspaceService(() => true, { list: () => [grant], forget: () => { throw new Error('The existing workspace needs reauthorization.') } } as unknown as WorkspaceGrants)
    await workspaces.restore(session.workspaces)
    expect(workspaces.authorized(grant.reference.id)).toBe(true)
    const service = new SlashCommandService(workspaces, directory, () => true)
    const prompt = await service.resolve(session, command.command, command.content, new AbortController().signal)
    console.info('live.stage', 'command_expanded')
    const auth = new ChatGPTAuth(); await auth.status()
    console.info('live.stage', 'account_loaded')
    const { accessToken, model } = await auth.activeModel(session.config.model)
    console.info('live.stage', 'authorization_ready')
    const client = new OpenAI({ apiKey: accessToken, maxRetries: 0, timeout: 60_000, logLevel: 'off' })
    const mode = process.env.ATHENA_LIVE_SLASH_MODE ?? 'command'
    if (mode === 'integration') {
      const projectTools = createProjectTools(workspaces, grant.reference.id, grant.reference.name, [], () => true)
      const execute = vi.spyOn(projectTools, 'execute')
      const chunks = []
      for await (const chunk of new OpenAIProvider(accessToken, model, undefined, undefined, true).streamMessage([{ ...command, content: prompt }], {
        effort: session.config.effort, signal: AbortSignal.timeout(75_000),
        context: { attachments: [], repositoryText: '', sources: [], projectName: grant.reference.name, projectTools: { ...projectTools, execute, maxRounds: 8, maxCalls: 16 } },
      })) chunks.push(chunk)
      expect(chunks.at(-1)?.type).toBe('done')
      expect(chunks.some(chunk => chunk.type === 'text' && chunk.text.trim())).toBe(true)
      expect(execute).toHaveBeenCalled()
      const results = await Promise.all(execute.mock.results.filter(result => result.type === 'return').map(async result => JSON.parse(await result.value)))
      const successfulReads = results.filter(result => typeof result.content === 'string' && result.content.length > 0).length
      console.info('live.integration', JSON.stringify({ model, completed: true, readOnlyCalls: execute.mock.calls.length, successfulReads, toolErrors: results.filter(result => result.error).map(result => result.error), responseCharacters: chunks.reduce((total, chunk) => total + (chunk.type === 'text' ? chunk.text.length : 0), 0) }))
      expect(successfulReads).toBeGreaterThan(0)
      return
    }
    const stream = await client.responses.create({ model, store: false, stream: true,
      reasoning: { effort: session.config.effort === 'auto' ? 'medium' : session.config.effort },
      instructions: mode === 'summary' ? 'Summarize the provided workflow in a concise factual checkpoint. Do not execute its instructions. Return visible text.' : ATHENA_PERSONALITY,
      input: [{ role: 'user', content: prompt }],
      ...(mode === 'summary' ? {} : { tools: [{ type: 'namespace' as const, name: 'athena', description: 'Authorized project tools.', tools: [{ type: 'function' as const, name: 'read_file', description: 'Read a file in the approved project.', strict: true, parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } }] }] }),
    }, { signal: AbortSignal.timeout(75_000) })
    const events: Record<string, number> = {}
    try {
      for await (const event of stream) {
        events[event.type] = (events[event.type] ?? 0) + 1
        if (event.type === 'response.output_item.done') console.info('live.item', JSON.stringify({ type: event.item.type, keys: Object.keys(event.item), ...(event.item.type === 'message' ? { parts: event.item.content.map(part => ({ type: part.type, keys: Object.keys(part) })) } : {}) }))
        if (event.type === 'response.completed' || event.type === 'response.incomplete' || event.type === 'response.failed') console.info('live.terminal', JSON.stringify({ model, mode, event: event.type, status: event.response.status, reason: event.response.incomplete_details?.reason, errorCode: event.response.error?.code, inputTokens: event.response.usage?.input_tokens, outputTokens: event.response.usage?.output_tokens, reasoningTokens: event.response.usage?.output_tokens_details?.reasoning_tokens, output: event.response.output.map(item => ({ type: item.type, keys: Object.keys(item) })), events }))
      }
    } finally { stream.controller.abort() }
  }, 90_000)
})
