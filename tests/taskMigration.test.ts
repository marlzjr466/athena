// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { ChatController } from '../electron/main/ai/chatController'
import { ConversationRepository } from '../electron/main/ai/conversationRepository'
import { ChatError, type AIProvider, type StreamOptions } from '../electron/main/ai/AIProvider'
vi.mock('../electron/main/logger', () => ({ log: vi.fn() }))
it.each([
 ['chatgpt-subscription','gpt-6-sol','chatgpt-subscription','gpt-6-astra'],
 ['chatgpt-subscription','gpt-6-astra','chatgpt-subscription','gpt-6-luna'],
 ['chatgpt-subscription','source','openai','destination'],
 ['chatgpt-subscription','source','claude-api','destination'],
 ['chatgpt-subscription','source','cursor','destination'],
 ['chatgpt-subscription','source','antigravity','destination'],
])('restores portable checkpoint from %s/%s to %s/%s', async (from, original, to, destination) => {
 const root=await mkdtemp(join(tmpdir(),'athena-migration-')), repository=new ConversationRepository(root)
 let providerId=from, model=original, chat: ChatController, calls=0
 const approvals:string[]=[], received:StreamOptions[]=[]
 const provider: AIProvider={get modelId(){return model}, testConnection:async()=>true, async *streamMessage(messages,options){
  received.push(options!); calls++
  if(calls===1){const id=chat.activity('read_file','Read fixture');chat.finishActivity(id,{status:'complete',summary:'Fixture inspected'});throw new ChatError('Interrupted fixture')}
  expect(messages.at(-1)?.content).toContain('Continue the unfinished request')
  expect(messages.at(-1)?.content).toContain('read_file')
  yield {type:'text',text:'Continued remaining work'};yield {type:'done'}
 }}
 const launch=()=>{chat=new ChatController({provider:async()=>provider,usageProviderId:()=>providerId as never,changed:()=>{},phase:()=>{},approvalChanged:event=>{if(event.action==='required'){approvals.push(event.summary!);queueMicrotask(()=>chat.command({action:'agent-approval',id:event.sessionId,approvalId:event.approvalId,allow:true}))}}},repository)}
 try{
  launch();chat!.current().config.model=original;chat!.send({text:'Inspect the fixture and finish pending work'})
  await vi.waitFor(()=>expect(chat!.snapshot().phase).toBe('idle'));chat!.dispose()
  providerId=to;model=destination;launch();chat!.current().config.model=destination
  expect(chat!.retry().ok).toBe(true);await vi.waitFor(()=>expect(chat!.snapshot().phase).toBe('idle'))
  expect(calls).toBe(2);expect(chat!.snapshot().messages.at(-1)?.status).toBe('complete')
  expect(approvals).toHaveLength(from===to?0:1)
  expect(received[1].checkpoint).toBeUndefined()
  expect(chat!.snapshot().messages.at(-1)?.execution?.taskCheckpoint?.migration).toMatchObject({fromModel:original,fromProvider:from,authorized:true})
 }finally{chat!?.dispose();await rm(root,{recursive:true,force:true})}
})
