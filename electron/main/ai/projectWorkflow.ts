import { randomUUID, createHash } from 'node:crypto'
import { mkdir, writeFile, readFile, rename, lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { Conversation } from './conversationRepository'
import type { ProjectTools } from './AIProvider'
import { sensitiveContent } from './workspaceService'
import type { SlashCommandService } from './slashCommandService'

export function verifiedToolResult(output: string): boolean {
  try {
    const envelope = JSON.parse(output)
    if (!envelope || typeof envelope !== 'object' || envelope.error || envelope.truncated) return false
    const result = envelope.result ?? envelope
    return !!result && typeof result === 'object' && !result.error && result.ok !== false && !result.timedOut &&
      (!('exitCode' in result) || result.exitCode === 0) && !['failed', 'error', 'cancelled', 'not-run'].includes(result.status)
  } catch { return false }
}
const activeWorkflows = new Set<string>()
const stepSchema = z.object({ title: z.string().min(1).max(200), tool: z.string().max(100), input: z.record(z.string(), z.unknown()), dependsOn: z.array(z.number().int().min(0)).max(30).default([]), status: z.enum(['pending', 'running', 'complete', 'failed', 'cancelled']).default('pending'), output: z.string().optional() }).strict()
const planSchema = z.object({ id: z.string().uuid(), session: z.string(), workspace: z.string(), model: z.string(), identity: z.string(), command: z.string(), arguments: z.string(), hash: z.string(), summary: z.string(), steps: z.array(stepSchema).min(1).max(30) }).strict()
/** Plans never expand the executor's permissions. Every step uses the existing guarded tool. */
export function projectWorkflowTools(session: Conversation, base: ProjectTools, commands: SlashCommandService, storage: string, identity: () => Promise<string> = async () => session.config.model ?? ''): ProjectTools {
  const directory = join(storage, 'project-workflows')
  const save = async (plan: z.infer<typeof planSchema>) => {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const file = join(directory, `${plan.id}.json`), temp = `${file}.${randomUUID()}.tmp`
    await writeFile(temp, JSON.stringify(plan), { mode: 0o600, flag: 'wx' }); await rename(temp, file)
  }
  const request = z.object({ command_id: z.string().max(500), arguments: z.string().max(12000).default(''), summary: z.string().min(1).max(4000), steps: z.array(stepSchema.omit({ status: true, output: true })).min(1).max(30) }).strict()
  const run = z.object({ plan_id: z.string().uuid(), step: z.number().int().min(0).max(29) }).strict()
  const inspect = z.object({ plan_id: z.string().uuid() }).strict()
  const specs = [
    { name: 'plan_project_workflow', description: 'Preview a discovered command as ordered structured tool steps. Explain effects and prerequisites. Planning executes nothing. Only tools currently available in this conversation may be planned. Use read_file first to obtain versions; plan dependent edits after those reads.', schema: request },
    { name: 'execute_project_workflow_step', description: 'Execute one pending step from a previously previewed plan through Athena guarded tools. Existing confirmations, diffs and recovery apply. Never rerun completed or failed steps; inspect evidence and create a revised plan. Cancellation is recorded.', schema: run },
    { name: 'inspect_project_workflow', description: 'Read a saved plan and actual step results from this conversation/project/model. Pending or failed steps are not successful executions.', schema: inspect },
  ]
  return { definitions: specs.map(({ name, description, schema }) => { const { $schema: _, ...parameters } = z.toJSONSchema(schema); return { name, description, parameters } }), assertAccess: base.assertAccess,
    execute: async (name, input, signal) => {
      base.assertAccess(); signal.throwIfAborted()
      if (name === 'plan_project_workflow') {
        const args = request.parse(input)
        if (sensitiveContent(JSON.stringify(args))) throw new Error('Workflow plan contains possible credentials.')
        const preview = await commands.inspect(session, args.command_id, args.arguments, signal)
        if (!preview.executable) throw new Error(preview.limitation)
        if (preview.references?.some(r => /missing|excluded|requires explicit/.test(r.status))) throw new Error('Resolve missing or unauthorized command references before planning execution.')
        args.steps.forEach((step, i) => {
          if (!base.definitions.some(d => d.name === step.tool) || step.dependsOn.some(n => n >= i)) throw new Error('Unknown tool or invalid dependency order.')
        })
        const plan = planSchema.parse({ id: randomUUID(), session: session.id, workspace: session.workspaces[0].id, model: session.config.model ?? '', identity: await identity(), command: args.command_id, arguments: args.arguments, hash: preview.definition.contentHash, summary: args.summary, steps: args.steps })
        base.assertAccess(); signal.throwIfAborted(); await save(plan)
        return JSON.stringify({ ...plan, note: 'Preview only; no steps have executed. Show this plan before requesting execution.' })
      }
      const args = name === 'execute_project_workflow_step' ? run.parse(input) : inspect.parse(input)
      const file = join(directory, `${args.plan_id}.json`), info = await lstat(file)
      if (!info.isFile() || info.isSymbolicLink() || info.size > 4_000_000) throw new Error('Invalid workflow record.')
      const plan = planSchema.parse(JSON.parse(await readFile(file, 'utf8')))
      if (plan.session !== session.id || plan.workspace !== session.workspaces[0]?.id || plan.model !== (session.config.model ?? '') || plan.identity !== await identity()) throw new Error('Workflow belongs to another conversation, project, model, or digest.')
      if (name === 'inspect_project_workflow') return JSON.stringify(plan)
      const definition = (await commands.list(session)).commands.find(d => d.id === plan.command)
      if (definition?.contentHash !== plan.hash) throw new Error('Command changed or was removed. Preview a fresh plan.')
      if (activeWorkflows.has(file)) throw new Error('A step in this workflow is already running.')
      const index = (args as z.infer<typeof run>).step, step = plan.steps[index]
      if (!step || step.status !== 'pending' || step.dependsOn.some(i => plan.steps[i].status !== 'complete') || plan.steps.slice(0, index).some(s => s.status !== 'complete')) throw new Error('Prior steps must complete; this step must be pending.')
      activeWorkflows.add(file)
      try {
        // Persist before execution: after a crash, a running step needs inspection,
        // never an automatic replay of a potentially completed external action.
        step.status = 'running'; await save(plan)
        const output = await base.execute(step.tool, step.input, signal)
        signal.throwIfAborted(); base.assertAccess()
        if (plan.identity !== await identity()) throw new Error('Model identity changed during execution. Inspect actual file and tool evidence before recovery.')
        step.status = verifiedToolResult(output) ? 'complete' : 'failed'
        step.output = output.slice(0, 100_000)
      } catch (error) { step.status = signal.aborted ? 'cancelled' : 'failed'; step.output = String(error).slice(0, 4000) }
      finally { try { await save(plan) } finally { activeWorkflows.delete(file) } }
      return JSON.stringify({ plan_id: plan.id, step: index, ...step, complete: plan.steps.every(s => s.status === 'complete'), evidenceHash: createHash('sha256').update(step.output ?? '').digest('hex') })
    } }
}
