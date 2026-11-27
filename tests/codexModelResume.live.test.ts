// @vitest-environment node
import { expect, it, vi } from 'vitest'
import { mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { CodexCLIService } from '../electron/main/ai/codexCLIService'
import { CodexAppServerProvider } from '../electron/main/ai/CodexAppServerProvider'
import type { StreamOptions } from '../electron/main/ai/AIProvider'
import type { ChatMessage } from '../shared/chat'
import type { NativeCodexThread } from '../shared/codex'

it.skipIf(process.env.ATHENA_CODEX_MODEL_RESUME_LIVE !== '1')('stops Astra 6.2 and continues the same native thread with Astra 6 without replay', async () => {
  const service = new CodexCLIService('athena-model-resume-check')
  let saved: NativeCodexThread | undefined
  try {
    const connection = await service.connection()
    const root = await realpath(await mkdtemp(join(tmpdir(), 'athena-model-resume-')))
    const first = new CodexAppServerProvider(service, 'gpt-6.2-astra')
    const second = new CodexAppServerProvider(service, 'gpt-6-astra')
    const abort = new AbortController()
    const options = (signal: AbortSignal): StreamOptions => ({signal, permissionMode:'read-only', effort:'high', nativeCodex:{state:saved,cwd:root,writableRoots:[root],persist:state=>{saved=state},requestUserInput:async()=>({})},requestApproval:async()=>false})
    const user: ChatMessage = {id:randomUUID(),role:'user',content:'Run the read-only command sleep 15 with exec_command, then reply ready. This is an interruption test. Do not use other tools, access files, or use the network.',status:'complete',createdAt:Date.now()}
    let sawCommand = false
    const interrupted = async () => {
      for await (const chunk of first.streamMessage([user],options(abort.signal))) {
        if(chunk.type==='activity' && chunk.tool==='codex.commandExecution' && chunk.status==='running'){sawCommand=true;abort.abort()}
      }
    }
    await expect(interrupted()).rejects.toThrow(/interrupted|abort/i)
    expect(sawCommand).toBe(true)
    const threadId = saved!.threadId
    await vi.waitFor(async()=>expect((await service.turns(threadId)).data[0].status).toBe('interrupted'),{timeout:15000})
    const followup: ChatMessage = {id:randomUUID(),role:'user',content:'Continue with the new model. Reply exactly resumed. Do not use tools.',status:'complete',createdAt:Date.now()}
    for await (const _chunk of second.streamMessage([user,followup],options(new AbortController().signal))) { /* consume real events */ }
    expect(saved).toMatchObject({threadId,model:'gpt-6-astra',effort:'high',submission:'completed',lastMessageId:followup.id})
    expect((await service.turns(threadId)).data).toHaveLength(2)
    // Reconcile accepted input even when the composer has since selected another model.
    for await (const _chunk of first.streamMessage([user,followup],options(new AbortController().signal))) { /* no new turn */ }
    const turns = (await service.turns(threadId)).data
    expect(turns).toHaveLength(2)
    expect(saved!.model).toBe('gpt-6-astra')
    await writeFile('/private/tmp/athena-model-resume-evidence.json',JSON.stringify({version:connection.version,firstModel:'gpt-6.2-astra',resumedModel:saved!.model,effort:saved!.effort,sameThread:true,turns:turns.map(t=>({status:t.status,error:t.error})),noReplay:true},null,2))
  } finally {
    if(saved?.threadId) await (await service.connection()).rpc.request('thread/archive',{threadId:saved.threadId})
    await service.shutdown()
  }
}, 90000)
