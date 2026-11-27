import { randomUUID, createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { ChatError } from './AIProvider'
import { modelLimits, tokenCost } from '../../../shared/modelLimits'

const receiptSchema = z.object({ key: z.string(), name: z.string(), outcome: z.enum(['pending', 'verified', 'blocked']) })
const taskSchema = z.object({
  id: z.string(), owner: z.string(), objective: z.string(), session: z.string().optional(),
  receipts: z.array(receiptSchema).max(32), finished: z.boolean(), started: z.number(),
  context: z.string().max(1_000_000).optional(),
  planningAttempts: z.number().int().nonnegative().default(0),
  binding: z.string().optional(),
  interruptedVisualApp:z.string().optional(),
  interruptedWindowDigest:z.string().optional(),
})
const database = z.object({
  month: z.string(), requests: z.number(), unreported: z.number(), cost: z.number(),
  tasks: z.array(taskSchema).max(128),
  environment: z.object({ account: z.string(), model: z.string(), session: z.string() }).optional(),
})
export type AutomationRecord = z.infer<typeof taskSchema>
export const fingerprint = (text: string) => createHash('sha256').update(text).digest('hex')
const month = () => new Date().toISOString().slice(0, 7)

export class AutomationBudgetReached extends ChatError {}

/** Raw task context is only persisted through the OS-protected codec. */
export class AutomationJournal {
  private memory?: z.infer<typeof database>
  private volatile = new Map<string, AutomationRecord>()
  constructor(private directory: string, private codec?: {seal(text:string):string; open(text:string):string}) {}
  private get file() { return join(this.directory, 'application-automation.json') }
  private state() {
    if (!this.memory) this.memory = existsSync(this.file)
      ? database.parse(JSON.parse(readFileSync(this.file, 'utf8')))
      : { month: month(), requests: 0, unreported: 0, cost: 0, tasks: [] }
    if (this.memory.month !== month()) Object.assign(this.memory, { month: month(), requests: 0, unreported: 0, cost: 0 })
    return this.memory
  }
  private write() {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    const temp = this.file + '.' + randomUUID()
    writeFileSync(temp, JSON.stringify(this.state()), { flag: 'wx', mode: 0o600 })
    renameSync(temp, this.file)
  }
  usage() {
    const { requests, cost, unreported } = this.state()
    return { requests, estimatedUSD: cost, unreported }
  }
  budgetReason(limit:number,estimatedLimit?:number|null):string|undefined {
    const state = this.state()
    if(state.requests>=limit)return 'The monthly OpenAI automation request budget has been reached.'
    if(estimatedLimit!=null && state.cost>=estimatedLimit)return 'The monthly estimated-cost threshold for OpenAI automation has been reached.'
    if(estimatedLimit!=null && state.unreported)return 'An earlier OpenAI request has unreported usage. Further requests are held under the estimated-cost threshold.'
  }
  reserve(limit: number,estimatedLimit?:number|null) {
    const reason=this.budgetReason(limit,estimatedLimit)
    if(reason)throw new AutomationBudgetReached(reason)
    const state=this.state()
    const period = state.month
    state.requests++
    state.unreported++
    this.write()
    let settled = false
    return (model: string, usage?: { input_tokens: number; output_tokens: number } | null) => {
      if (settled || !usage || this.state().month !== period) return
      settled = true
      state.cost += tokenCost(modelLimits(model), usage.input_tokens, usage.output_tokens) ?? 0
      state.unreported--
      this.write()
    }
  }
  get environment() { return this.state().environment }
  setEnvironment(account: string, model: string, session: string) {
    this.state().environment = { account, model, session }; this.write()
  }
  releaseEnvironment(session: string) {
    if (this.state().environment?.session === session) { delete this.state().environment; this.write() }
  }
  pending(owner: string) {
    return this.state().tasks.filter(task => task.owner===owner && !task.finished && !!task.context).at(-1)
  }
  claimed(session: string, except: string) {
    return [...this.state().tasks,...this.volatile.values()].some(t=>t.session===session && t.id!==except)
  }
  checkpoint(task: AutomationRecord, objective:string, results: string[]) {
    if (this.codec && this.state().tasks.includes(task)) task.context = this.codec.seal(JSON.stringify({objective, results}))
    this.save(task)
  }
  recover(task: AutomationRecord): {objective:string; results:string[]} | undefined {
    if (this.codec && task.context) return z.object({objective:z.string().max(12000),results:z.array(z.string().max(14000)).max(32)}).parse(JSON.parse(this.codec.open(task.context)))
  }
  begin(id: string, owner: string, objective: string, persist: boolean): AutomationRecord {
    const state = this.state()
    const existing = state.tasks.find(t => t.id === id) ?? this.volatile.get(id)
    if (existing) {
      if (existing.owner !== owner || existing.objective !== fingerprint(objective)) throw new ChatError('The automation task identity changed.')
      return existing
    }
    const task: AutomationRecord = { id, owner, objective: fingerprint(objective), receipts: [], started: Date.now(), finished: false, planningAttempts:0 }
    if (persist) {
      if (state.tasks.length >= 128) {
        const oldest = state.tasks.findIndex(t => t.finished || !t.receipts.length)
        if (oldest < 0) throw new ChatError('The automation journal is full of interrupted tasks. Review them before starting another.')
        state.tasks.splice(oldest, 1)
      }
      state.tasks.push(task); this.write()
    } else {
      if (this.volatile.size >= 128) this.volatile.delete(this.volatile.keys().next().value!)
      this.volatile.set(id, task)
    }
    return task
  }
  save(task: AutomationRecord) { if (this.state().tasks.includes(task)) this.write() }
}
