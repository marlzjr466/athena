// @vitest-environment node
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage } from '../shared/chat'
import type { PromptBudget } from '../shared/context'
import { openAIContext } from '../shared/modelLimits'
import { AgentTools } from '../electron/main/ai/agentTools'
import { WorkspaceService } from '../electron/main/ai/workspaceService'
import type { ChatController } from '../electron/main/ai/chatController'
import { estimateTokens } from '../electron/main/ai/contextManager'
import { OpenAIProvider } from '../electron/main/ai/OpenAIProvider'
import { requestTools } from '../electron/main/ai/requestTools'
import { fitProtocolContext } from '../electron/main/ai/protocolContext'
import { contextDefaults } from '../shared/context'

const message: ChatMessage = { id: 'user', role: 'user', status: 'complete', content: 'Hello', createdAt: 1 }
const folders: string[] = []
afterEach(async () => { for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true }) })
async function project() {
  const folder = await mkdtemp(join(tmpdir(), 'athena-context-test-')); folders.push(folder)
  const root = join(folder, 'project')
  await mkdir(root)
  await writeFile(join(root, 'sample.txt'), 'Evidence from fixture')
  const workspaces = new WorkspaceService(() => true)
  const workspace = await workspaces.connect(root)
  const chat = { beforeAction: vi.fn(), activity: vi.fn(), finishActivity: vi.fn() } as unknown as ChatController
  return new AgentTools(workspaces, folder).create(chat, 'fixture', workspace.id, workspace.name, 'full-access', [], () => true)
}
function response(output: unknown[]) {
  return new Response('data: '+JSON.stringify({ type: 'response.completed', response: { status: 'completed', output } })+'\n\n', { headers: { 'content-type': 'text/event-stream' } })
}
const call = (name: string, args: unknown, id: string) => ({ type: 'function_call', name, arguments: JSON.stringify(args), call_id: id, id: 'fc_'+id, status: 'completed' })
const answer = { type: 'message', id: 'msg_fixture', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Done', annotations: [] }] }

describe('integration capacity and progressive tool registration', () => {
  it.each(['gpt-6.2-astra', 'gpt-6.2-sol'])('starts %s through subscription and discovers and executes the scoped real read tool', async model => {
    const tools = await project(), metrics: PromptBudget[] = []
    const fullTokens = estimateTokens([{ type: 'namespace', name: 'athena', description: 'Authorized desktop and project tools. Every call is validated and permission-gated locally.', tools: tools.definitions.map(tool => ({ type: 'function', ...tool, strict: false })) }])
    let rounds = 0
    const request = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body))
      expect(body.model).toBe(model)
      const names = body.tools[0].tools.map((tool: { name: string }) => tool.name)
      if (++rounds === 1) {
        expect(names).toEqual(['discover_athena_tools'])
        return response([call('discover_athena_tools', { query: 'read_file' }, 'discover')])
      }
      if (rounds === 2) {
        expect(names).toContain('read_file')
        return response([call('read_file', { path: 'sample.txt', start_line: 1, end_line: 2 }, 'read')])
      }
      expect(body.input.find((entry: {call_id?: string; type?: string}) => entry.call_id === 'read' && entry.type === 'function_call_output').output).toContain('Evidence from fixture')
      return response([answer])
    })
    for await (const _ of new OpenAIProvider('fixture', model, request, undefined, true).streamMessage([message], {
      context: { projectTools: tools, attachments: [], sources: [], repositoryText: '', projectName: 'fixture' }, onPromptBudget: budget => metrics.push(budget),
    })) { /* consume all output */ }
    expect(rounds).toBe(3)
    expect(metrics[0]).toMatchObject({ documented: 1_050_000, effective: 16_384, output: 4096, safeInput: 9830, registered:tools.definitions.length, loaded:1 })
    expect(metrics[0].tools).toBeLessThan(fullTokens)
    console.info('Fixture registration', { model, registered: tools.definitions.length, fullTokens, loadedTokens: metrics[0].tools, prompt:metrics[0].prompt })
  })
  it('keeps account capacity, documented model limits and configured caps independent', () => {
    for (const model of ['gpt-6.2-astra','gpt-6.2-sol','gpt-6-sol','gpt-5.6-terra']) {
      expect(openAIContext(model,true,272000).limits.context).toBe(272000)
      expect(openAIContext(model,true,272000,512000).limits.context).toBe(272000)
      expect(openAIContext(model,true,272000,128000).limits.context).toBe(128000)
      expect(openAIContext(model,false).limits.context).toBe(1050000)
      expect(openAIContext(model,true).limits.verified).toBe(false)
    }
    expect(openAIContext('future-account-model',true,512000).limits.context).toBe(512000)
    expect(openAIContext('unverified',false,undefined,512000).limits.context).toBe(16384)
  })
  it('uses documented hosted discovery on a supporting API route', async () => {
    const tools = await project()
    const request = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body))
      expect(body.tools).toContainEqual({type:'tool_search'})
      expect(body.tools[0].tools.some((tool:{defer_loading:boolean})=>tool.defer_loading)).toBe(true)
      return response([answer])
    })
    for await (const _ of new OpenAIProvider('fixture','gpt-6.2-astra',request).streamMessage([message],{context:{projectTools:tools,attachments:[],sources:[],repositoryText:''}})) {}
    expect(request).toHaveBeenCalledTimes(1)
  })
  it('keeps tool discovery downstream of scope and revocation', async () => {
    const base = await project()
    const signal = new AbortController().signal
    const tools = requestTools({...base,definitions:base.definitions.filter(tool=> tool.name !== 'delete_file')}, 'inspect project')
    const result=await tools.project!.execute('discover_athena_tools',{query:'delete_file'},signal)
    expect(JSON.parse(result).matches).not.toContain('delete_file')
    expect(tools.advance().map(tool=>tool.name)).not.toContain('delete_file')
    const revoked = requestTools({...base,assertAccess(){throw new Error('Revoked')}},'hello')
    await expect(revoked.project!.execute('discover_athena_tools',{query:''},signal)).rejects.toThrow('Revoked')
  })
  it('allows pinned content between the optimization trigger and the safe input ceiling', () => {
    for (const automaticCompaction of [true,false]) {
      expect(fitProtocolContext([{role:'user',content:'x'.repeat(16000)}],'chat',{system:'policy'},{contextSettings:{...contextDefaults(), utilizationThreshold:.3,automaticCompaction}},16000,2000)).toBe(false)
    }
  })
})
