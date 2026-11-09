import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

test('native platform-spec delegates an isolated cold read through secure IPC and shows its structured Activity result', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'athena-child-desktop-')), project = join(profile, 'project')
  await mkdir(join(project, '.claude/commands'), { recursive: true })
  await writeFile(join(project, 'spec.md'), '# Fixture specification\nShow an empty state when no results exist.\n')
  await writeFile(join(project, '.claude/commands/platform-spec.md'), '---\ndescription: Review fixture spec\nsubagents: [{"id":"review","role":"Cold-read reviewer","files":["spec.md"],"criteria":"Verify explicit empty-state requirements"}]\n---\nPARENT_PRIVATE_HISTORY_MARKER\nRead the saved spec through a required cold-read sub-agent, await findings and reconcile them. Do not mutate files.')
  const app = await electron.launch({ args: ['.'], env: { ...process.env, ATHENA_TEST_DATA: profile } })
  try {
    await expect.poll(() => app.windows().length).toBe(3)
    const control = app.windows().find((page) => page.url().includes('surface=control'))!
    await app.evaluate(({ dialog }, project) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [project] })
      const state = globalThis as unknown as { childBodies: string[]; parentRound: number; childId: string }
      state.childBodies = []; state.parentRound = 0; state.childId = ''
      const sse = (events: unknown[]) => new Response(events.map((entry) => `data: ${JSON.stringify(entry)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
      const usage = { input_tokens: 1000, output_tokens: 200, total_tokens: 1200, input_tokens_details: { cached_tokens: 100 }, output_tokens_details: { reasoning_tokens: 100 } }
      const action = (name: string, args: unknown, id: string) => sse([{ type: 'response.completed', response: { usage, output: [{ type: 'function_call', name, arguments: JSON.stringify(args), call_id: id, id: `fc_${id}`, status: 'completed' }] } }])
      const answer = (text: string) => sse([{ type: 'response.output_text.delta', delta: text }, { type: 'response.completed', response: { usage, output: [] } }])
      // Deterministic provider transport only. Production IPC, provider adapters,
      // child contexts, scoped project tools, persistence and renderer all run normally.
      globalThis.fetch = async (url, init) => {
        if (String(url).endsWith('/models')) return new Response(JSON.stringify({ object: 'list', data: [{ id: 'gpt-4.1' }] }))
        const body = JSON.parse(init!.body as string)
        const child = String(body.instructions).includes('You are an isolated cold_read sub-agent')
        if (child) {
          state.childBodies.push(JSON.stringify(body))
          if (!body.input.some((entry: { type: string }) => entry.type === 'function_call_output')) return action('read_file', { path: 'spec.md', start_line: 1, end_line: 100 }, 'read-spec')
          return answer(JSON.stringify({ status: 'completed', summary: 'The empty-state requirement is explicit.', findings: [], blockers: [], evidence: ['spec.md:2'], filesReviewed: ['spec.md'], checksPerformed: ['Read specification'], limitations: ['No runtime test requested'], nextActions: [] }))
        }
        state.parentRound++
        if (state.parentRound === 1) return action('spawn_subagent', { taskKey: 'spec-review', gateId: 'review', role: 'Cold-read reviewer', task: 'Review the artifact independently.', criteria: 'Verify empty states', files: ['spec.md'], tokenBudget: 12000 }, 'spawn-review')
        if (state.parentRound === 2) {
          const output = body.input.find((entry: { type: string; call_id?: string }) => entry.type === 'function_call_output' && entry.call_id === 'spawn-review')
          state.childId = JSON.parse(output.output).id
          return action('wait_subagents', { ids: [state.childId] }, 'wait-review')
        }
        if (state.parentRound === 3) return action('get_subagent', { id: state.childId }, 'get-review')
        if (state.parentRound === 4) return action('reconcile_subagent', { id: state.childId, accepted: true, summary: 'Compared the independent finding with the required empty-state criterion.' }, 'accept-review')
        return answer('The independent reviewer confirmed the empty-state requirement. No file changes were needed.')
      }
    }, project)
    await control.evaluate(async () => {
      await window.athena!.updateSettings({ randomMovement: false, randomActions: false, voiceEnabled: false })
      await window.athena!.activateAI({ apiKey: 'sk-isolated-child-fixture-not-a-real-key' })
      await window.athena!.selectAIModel({ model: 'gpt-4.1' })
      await window.athena!.setPermissionEnabled({ permission: 'personalFiles', enabled: true })
      const session = (await window.athena!.getChat()).sessionId!
      await window.athena!.chatContext({ action: 'connect', sessionId: session })
      await window.athena!.chatSession({ action: 'agent-mode', id: (await window.athena!.getChat()).sessionId!, mode: 'read-only' })
    })
    await control.getByRole('button', { name: 'AI', exact: true }).click()
    await expect(control.getByRole('heading', { name: 'Agent execution · Sub-agents' })).toBeVisible()
    await expect(control.getByLabel('Maximum concurrent sub-agents')).toHaveValue('2')
    await control.getByLabel('Default iteration limit').fill('20')
    await control.getByLabel('Default tool-call limit').fill('60')
    await control.getByRole('button', { name: 'Save sub-agent settings' }).click()
    await expect.poll(() => control.evaluate(() => window.athena!.getSnapshot().then(snapshot => snapshot.settings.subagents.maxToolCalls))).toBe(60)
    await control.getByRole('button', { name: 'Conversation', exact: true }).click()
    const sent = await control.evaluate(async () => window.athena!.sendChat({ text: '/platform-spec fixture', sessionId: (await window.athena!.getChat()).sessionId! }))
    expect(sent, JSON.stringify(sent)).toMatchObject({ ok: true })
    await expect.poll(async () => (await control.evaluate(() => window.athena!.getChat())).messages.at(-1)?.status).toBe('complete')
    const saved = await control.evaluate(() => window.athena!.getChat())
    const execution = saved.messages.at(-1)!.execution!
    expect(execution.subagentRequirements?.[0].id).toBe('review')
    const child = execution.activities.find((entry) => entry.subagent)!.subagent!
    expect(child.status).toBe('completed'); expect(child.reviewAccepted).toBe(true)
    expect(child.rawResponse).toContain('The empty-state requirement is explicit.')
    expect(child.resultDiagnostics).toMatchObject({ terminationReason: 'parsed_completed', candidateCount: 1, validationErrors: [], missingFields: [] })
    expect(child.result?.filesReviewed).toEqual(['spec.md'])
    expect(child.executionBudget).toMatchObject({ configuredToolCalls: 60, requestedToolCalls: null, effectiveToolCalls: 60, remainingToolCalls: 59, configuredIterations: 20, effectiveIterations: 20, remainingIterations: 18 })
    expect(child.budget).toMatchObject({ configuredTokens: 250000, requestedTokens: 12000, effectiveTokens: 12000, consumedTokens: 2400, remainingTokens: 9600, reservedInput: 0, reservedOutput: 0, measuredInput: 2000, measuredOutput: 400, reasoningTokens: 200, estimatedInput: 0, estimatedOutput: 0, settledRequests: 2 })
    const bodies = await app.evaluate(() => (globalThis as unknown as { childBodies: string[] }).childBodies)
    expect(bodies).toHaveLength(2)
    expect(bodies.join('')).not.toContain('PARENT_PRIVATE_HISTORY_MARKER')
    const activityGroups = control.locator('.agent-inline-activity-group')
    await expect(activityGroups.first()).toBeVisible()
    for (let index = 0; index < await activityGroups.count(); index++) {
      const group = activityGroups.nth(index)
      if (!(await group.evaluate((element) => (element as HTMLDetailsElement).open))) await group.locator(':scope > summary').click()
    }
    const activity = activityGroups.filter({ hasText: 'Cold-read reviewer' }).first()
    await expect(activity).toBeVisible()
    await expect(activity.getByLabel('Sub-agent: Cold-read reviewer (complete)', { exact: true })).toBeVisible()
    await expect(control.getByText(/The empty-state requirement is explicit\./).first()).toBeVisible()
    await expect(control.getByText(/Parent review · Accepted/)).toBeVisible()
    const budget = control.getByLabel('Sub-agent token budget')
    await expect(budget).toContainText('Configured 250,000 · Child allocation 12,000 · Effective 12,000')
    await expect(budget).toContainText('Consumed 2,400 · Remaining 9,600')
    await expect(budget).toContainText('Provider-reported 2,400')
    await expect(control.getByLabel('Sub-agent execution limits')).toContainText('Tool calls: Settings 60 · Inherited allocation · Effective 60 · Consumed 1 · Remaining 59')
    await control.screenshot({ path: 'test-results/subagents-native.png' })
    expect(await control.evaluate(() => window.athena!.getChat().then((value) => value.workspaces?.length))).toBe(1)
  } finally {
    const control = app.windows().find((page) => page.url().includes('surface=control'))
    await control?.evaluate(() => window.athena!.removeAIKey()).catch(() => {})
    await app.close()
  }
})
