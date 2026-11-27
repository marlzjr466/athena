// @vitest-environment node
import { expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { AgentCommands } from '../electron/main/ai/agentCommands'
import { limitToolOutput } from '../electron/main/ai/toolOutput'
import { operationOutcome } from '../electron/main/ai/toolOutcome'
import { AgentTools } from '../electron/main/ai/agentTools'
import { ChatController } from '../electron/main/ai/chatController'
import { ChatError, type AIProvider } from '../electron/main/ai/AIProvider'
import { ContinuationController } from '../electron/main/ai/continuationController'
import { WorkspaceService } from '../electron/main/ai/workspaceService'
import { ConversationRepository } from '../electron/main/ai/conversationRepository'
import { provisioningWorkspace } from './fixtures/provisioningWorkspace'

it('attributes overlapping identical operations to their own invocation and detects repeated failures across unrelated reads', () => {
  const tracker = new ContinuationController({ noProgressWindow: 3 }, undefined, undefined, { taskId: 'fixture' })
  const one = tracker.operationStarted('inspect', {}, true), two = tracker.operationStarted('inspect', {}, true)
  tracker.operationFinished(two, '{"error":"Permission denied"}')
  tracker.operationFinished(one, '{"ok":true}')
  expect(tracker.state.operations.map(op => [op.id, op.runId, op.outcome])).toEqual([[one, 'fixture', 'success'], [two, 'fixture', 'permission-denied']])
  for (let n = 0; n < 3; n++) {
    tracker.operationFinished(tracker.operationStarted('inspect', {n}, true), '{}')
    const id = tracker.operationStarted('run_tests', {}, false)
    const finish = () => tracker.operationFinished(id, '{"result":{"exitCode":2,"output":"Missing secure input"}}')
    if (n === 2) expect(finish).toThrow(/same run_tests invocation failed 3 times/)
    else finish()
  }
})

it.skipIf(process.platform !== 'darwin')('provisions once through the real command sandbox, resumes from disk and authenticates against a loopback service', async () => {
  const f = await provisioningWorkspace()
  const spaces = new WorkspaceService(() => true), workspace = await spaces.connect(f.root)
  const tools = new AgentTools(spaces, f.profile), repo = new ConversationRepository(f.profile)
  const sha = (text: string) => createHash('sha256').update(text).digest('hex')
  let chat: ChatController, run = 0, handoff = ''
  const outputs: string[] = [], approvals: string[] = []
  const objective = 'Provision and verify one fixture user. ' + 'Keep verified work. '.repeat(380) + 'Retain the final invariant.'
  const provider: AIProvider = { modelId: 'test-controller', testConnection: async () => true, async *streamMessage(messages, options) {
    const invoke = async (name: string, args: object) => {
      const result = await options!.context!.projectTools!.execute(name, args, options!.signal!)
      outputs.push(result); return JSON.parse(result)
    }
    if (!run++) {
      const { credential_environment: _source, ...ordinary } = f.command('create')
      await invoke('execute_command', ordinary)
      await invoke('execute_command', f.command('create'))
      await invoke('create_file', {path:'receipt.md', content:'first'})
      throw new ChatError('Fixture transport interruption after creation')
    }
    handoff = messages.at(-1)!.content
    await invoke('execute_command', f.command('create'))
    await invoke('execute_command', f.command('verify'))
    await invoke('read_file', { path:'receipt.md', start_line:1, end_line:20 })
    await invoke('write_file', { path:'receipt.md', expected_version:sha('user changed'), content:'replacement' })
    await invoke('create_file', {path:'part.md', content:'one'})
    await invoke('write_file', {path:'part.md', expected_version:sha('one'), content:'two'})
    yield { type:'text', text:'Reviewed recorded outcomes.' }; yield { type:'done' }
  }}
  const launch = () => new ChatController({ provider: async () => provider, changed: () => {}, phase: () => {}, authorized: id => spaces.authorized(id), workspaceRoot: id => spaces.authorizedRoot(id), workspaceOnly: () => true,
    prepare: async session => ({ attachments:[], repositoryText:'', sources:[], projectTools:tools.create(chat,session.id,workspace.id,workspace.name,'full-access',[],()=>true) }),
    approvalChanged: event => {
      if (event.action !== 'required') return
      approvals.push(event.summary!)
      queueMicrotask(() => chat.command({action:'agent-approval',id:event.sessionId,approvalId:event.approvalId,allow:event.summary === 'Allow command to read these files?' || event.summary === 'Run isolated command'}))
    },
  },repo)
  try {
    chat = launch(); chat.addWorkspace(chat.current().id, workspace)
    chat.command({action:'agent-mode',id:chat.current().id,mode:'full-access',confirmed:true})
    chat.send({text:objective}); await vi.waitFor(() => expect(chat.snapshot().phase).toBe('idle'), {timeout:20000})
    expect(outputs[0]).toContain('Missing secure input'); expect(f.counts.creates).toBe(1)
    chat.dispose()
    await writeFile(join(f.root,'receipt.md'),'user changed')
    chat = launch(); chat.send({text:'continue'}); await vi.waitFor(() => expect(chat.snapshot().phase).toBe('idle'),{timeout:20000})
    expect(f.counts).toEqual({creates:1,attempts:1,logins:1,verified:1})
    expect(handoff).toContain(objective); expect(handoff).toContain('provision-credentials.json')
    expect(approvals.filter(a => a === 'Allow command to read these files?')).toHaveLength(2)
    expect(approvals).toContain('Confirm repeat of a saved operation')
    expect(await readFile(join(f.root,'receipt.md'),'utf8')).toBe('user changed')
    expect(await readFile(join(f.root,'part.md'),'utf8')).toBe('two')
    const serialized = JSON.stringify(repo.load()); expect(serialized).not.toContain(f.credential)
    const receipts = chat.snapshot().messages.at(-1)?.execution?.taskCheckpoint?.control?.operations ?? []
    expect(receipts.filter(op => op.credentialSource)).toHaveLength(2)
    expect(receipts.every(op => op.id && op.runId && op.finishedAt)).toBe(true)
    expect(receipts.some(op => op.outcome === 'missing-input' && op.exitCode === 2)).toBe(true)
  } finally { chat!?.dispose(); await tools.dispose(); await f.close() }
}, 50000)

it('retains the process failure when a large tool result is shortened for the model', () => {
  const shortened = limitToolOutput(JSON.stringify({result:{exitCode:12,output:'x'.repeat(9000)}}), 1200)
  expect(operationOutcome(shortened)).toEqual({outcome:'failed',exitCode:12})
})

it.skipIf(process.platform !== 'darwin')('drains verbose commands to their real exit without retaining excess output', async () => {
  const f = await provisioningWorkspace()
  try {
    const result = await new AgentCommands().execute(f.root,{executable:'python3',args:['-c','import sys,time; print("x"*100000,flush=True); time.sleep(.2); sys.exit(7)'], install:false,gitWrite:false,network:false}, new AbortController().signal)
    expect(result).toMatchObject({exitCode:7,truncated:true,timedOut:false})
    expect(result.output.length).toBeLessThan(65000)
  } finally { await f.close() }
})
