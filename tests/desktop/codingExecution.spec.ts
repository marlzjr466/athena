import { test, expect, _electron as electron } from '@playwright/test'
import { writeFile, realpath } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { provisioningWorkspace } from '../fixtures/provisioningWorkspace'

for (const backend of ['athena', 'codex-cli'] as const) test(`signed subscription provisioning through ${backend}`, async () => {
  test.skip(process.env.ATHENA_CODING_SUBSCRIPTION_TEST !== '1' || process.env.ATHENA_CODING_LEGACY_BASELINE !== '1' || !process.env.ATHENA_VOICE_TEST_BINARY || process.platform !== 'darwin', 'Historical comparison only: requires an explicit legacy binary. Current native execution is tested in nativeCodex.spec.ts.')
  test.setTimeout(240000)
  const f = await provisioningWorkspace()
  const model = 'gpt-6-astra'
  const baseline = process.env.ATHENA_CODING_LEGACY_BASELINE === '1'
  if (baseline && !process.env.ATHENA_VOICE_TEST_BINARY) throw Error('A legacy baseline requires an explicit signed binary.')
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined
  try {
    await writeFile(join(f.profile,'settings.json'), JSON.stringify({aiMode:'subscription',chatGPTCodingBackend:backend,voiceEnabled:false,floatingEnabled:false,randomMovement:false,randomActions:false,webAccess:{enabled:false,searxngAutoStart:false}}))
    app = await electron.launch({executablePath:process.env.ATHENA_VOICE_TEST_BINARY ?? resolve('release/mac-arm64/Athena.app/Contents/MacOS/Athena'),args:['--mute-audio','--user-data-dir='+f.profile]})
    expect(await realpath(await app.evaluate(({app}) => app.getPath('userData')))).toBe(await realpath(f.profile))
    await expect.poll(() => app!.windows().some(p=>p.url().includes('surface=control'))).toBe(true)
    const page = app.windows().find(p => p.url().includes('surface=control'))!
    await app.evaluate(({dialog},root) => {dialog.showOpenDialog = async () => ({canceled:false,filePaths:[root]})},f.root)
    const id = await page.evaluate(async ({model,backend}) => {
      const api = window.athena!
      const settings = (await api.updateSettings({aiMode:'subscription',chatGPTCodingBackend:backend})).settings
      if (settings.aiMode !== 'subscription' || settings.chatGPTCodingBackend !== backend) throw Error('Could not select fixture transport.')
      if (backend === 'codex-cli') {
        const cli = await api.getCodexCLIStatus({refresh:true}), subscription = await api.getChatGPTStatus()
        if (!cli.authenticated || !cli.identity || cli.identity.toLowerCase() !== subscription.email?.toLowerCase()) throw Error('The authenticated CLI and selected subscription account could not be verified as the same identity.')
        if (!cli.models.some(m=>m.id===model && m.efforts.includes('high'))) throw Error('The Codex CLI catalog does not offer the comparison model and effort.')
      }
      await api.setPermissionEnabled({permission:'personalFiles',enabled:true})
      let chat = await api.getChat()
      const connect = await api.chatContext({action:'connect',sessionId:chat.sessionId!})
      if (!connect.ok) throw Error(connect.message)
      chat = await api.getChat()
      for (const config of [{action:'configure',config:{provider:'OpenAI',model,effort:'high'}},{action:'configure-effort',effort:'high'},{action:'agent-mode',mode:'full-access',confirmed:true}] as const) {
        const result = await api.chatSession({id:chat.sessionId!,...config})
        if (!result.ok) throw Error(result.message)
      }
      return chat.sessionId!
    },{model,backend})
    const prompt = 'In this disposable provisioning project, use execute_command to run python3 -B provision.py create once, then python3 -B provision.py verify once. The second command signs in to the fixture and calls its authenticated private API. Both require local_network=true, network=false, workspace_write=false, install_dependencies=false and credential_environment with file provision-credentials.json and names [E2E_BACKEND_ADMIN_TOKEN]. Never read or print the credential file. Use no other commands, writes, sub-agents, or providers. Report each actual exit status and any blocker. Never retry a create.'
    const started = Date.now()
    expect((await page.evaluate(({id,prompt}) => window.athena!.sendChat({sessionId:id,text:prompt}),{id,prompt})).ok).toBe(true)
    const approvedIds = new Set<string>()
    for (;;) {
      const state = await page.evaluate(async () => {
        const c = await window.athena!.getChat(), m=c.messages.at(-1), e=m?.execution
        return {phase:c.phase, id:m?.id, role:m?.role, error:m?.error, disclosedLimitation: /cannot|can[’']t|unable|unsupported|not (?:available|supported|exposed|run|executed)|does(?: not|n[’']t) (?:include|support|expose)|blocked|unavailable|no .*credential_environment/i.test(m?.content ?? ''), rejectedSchemas:e?.activities.filter(a=>a.status==='error' && /invalid tool arguments/i.test(a.summary ?? '')).length, failedTools:e?.activities.filter(a=>a.status==='error').length, status:e?.status, approval:e?.approval, model:e?.taskCheckpoint?.model, reported:e?.taskCheckpoint?.responseModel, effort:e?.taskCheckpoint?.effort, provider:e?.providerId, outcomes:e?.taskCheckpoint?.control?.operations.map(o=>[o.tool,o.outcome,o.exitCode])}
      })
      if (state.approval && !approvedIds.has(state.approval.id)) {
        const a = state.approval
        const allowed = a.title === 'Allow command to read these files?' && ['create','verify'].some(step=>a.description.startsWith('python3 -B provision.py '+step+'\n')) && a.description.includes(f.root) && a.description.includes('Private command environment: E2E_BACKEND_ADMIN_TOKEN from provision-credentials.json') && a.description.includes('Source-file writes are blocked.')
        await page.evaluate(({id,approvalId,allow})=>window.athena!.chatSession({action:'agent-approval',id,approvalId,allow}),{id,approvalId:a.id,allow:allowed})
        approvedIds.add(a.id)
      }
      if (state.phase==='idle' && state.role==='assistant') {
        console.info('Provisioning measurement',JSON.stringify({backend,baseline,disclosedLimitation:state.disclosedLimitation,rejectedSchemas:state.rejectedSchemas,failedTools:state.failedTools,ms:Date.now()-started,model:state.model,reported:state.reported,provider:state.provider,effort:state.effort,status:state.status,outcomes:state.outcomes,counts:f.counts}))
        if (baseline) {
          expect(state.provider).toBe('chatgpt-subscription'); expect(state.model).toBe(model); expect(state.effort).toBe('high')
          expect(Boolean(state.disclosedLimitation || state.rejectedSchemas || state.error)).toBe(true); expect(f.counts).toEqual({creates:0,attempts:0,logins:0,verified:0})
          break
        }
        if (state.error) throw Error(state.error)
        expect(state.provider).toBe(backend === 'athena' ? 'chatgpt-subscription' : 'codex-subscription'); expect(state.model).toBe(model); expect(state.effort).toBe('high')
        expect(state.status).toBe('complete'); expect(f.counts).toEqual({creates:1,attempts:1,logins:1,verified:1})
        break
      }
      await new Promise(resolve=>setTimeout(resolve,150))
    }
  } finally { await app?.close(); await f.close() }
})
