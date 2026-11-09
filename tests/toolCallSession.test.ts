// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import type { ResponseFunctionToolCall } from 'openai/resources/responses/responses'
import { ChatError, type ProjectTools } from '../electron/main/ai/AIProvider'
import { ToolCallSession } from '../electron/main/ai/toolCallSession'

const call = (id = 'one', name = 'open_application', args = '{}'): ResponseFunctionToolCall => ({ type: 'function_call', call_id: id, name, arguments: args, status: 'completed' })
function setup(limit = 3) {
  const abort = new AbortController()
  const tools: ProjectTools = { definitions: [{ name: 'open_application', description: 'Open app', parameters: {} }],
    assertAccess: vi.fn(), execute: vi.fn(async () => '{"ok":true,"message":"Confirmed"}') }
  return { abort, tools, session: new ToolCallSession(tools, abort.signal, limit) }
}

describe('request-scoped tool dispatch', () => {
  const hooks = () => ({ prepareRequest: vi.fn(() => ({ finalize: false, instruction: '' })), toolAttempt: vi.fn(), batchLimited: vi.fn(), toolResult: vi.fn() })
  it('admits only the remaining independent reads from a child batch and returns explicit deferred results', async () => {
    const f = setup(1), budget = hooks()
    f.tools.executionBudget = budget; f.tools.parallelSafe = () => true
    const batch = [call('a'), call('b'), call('c')]
    f.session.validateBatch(batch)
    const results = await Promise.all(batch.map(item => f.session.execute(item, 4000)))
    expect(f.tools.execute).toHaveBeenCalledTimes(1)
    expect(budget.toolAttempt).toHaveBeenCalledTimes(1)
    expect(budget.toolResult).toHaveBeenCalledTimes(1)
    expect(budget.batchLimited).toHaveBeenCalledWith(3, 1)
    expect(results.slice(1).map(output => JSON.parse(output).error.code)).toEqual(['tool_budget_deferred', 'tool_budget_deferred'])
    expect(f.session.used).toBe(1)
  })
  it('never partially dispatches a dependent or mutating batch', async () => {
    const f = setup(1), budget = hooks()
    f.tools.executionBudget = budget; f.tools.parallelSafe = () => false
    const batch = [call('a'), call('b')]
    f.session.validateBatch(batch)
    for (const item of batch) expect(await f.session.execute(item, 4000)).toContain('tool_budget_deferred')
    expect(budget.batchLimited).toHaveBeenCalledWith(2, 0)
    expect(f.tools.execute).not.toHaveBeenCalled(); expect(budget.toolAttempt).not.toHaveBeenCalled()
    expect(f.session.used).toBe(0)
  })
  it('counts malformed, unknown and failed dispatched attempts once, never a rejected batch', async () => {
    const f = setup(3), budget = hooks(); f.tools.executionBudget = budget
    await f.session.execute(call('bad', 'open_application', '{'), 4000)
    await f.session.execute(call('unknown', 'not_advertised'), 4000)
    vi.mocked(f.tools.execute).mockRejectedValue(new Error('Failure'))
    await f.session.execute(call('failed'), 4000)
    expect(budget.toolAttempt).toHaveBeenCalledTimes(3); expect(budget.toolResult).toHaveBeenCalledTimes(3)
    expect(f.session.used).toBe(3)
    expect(() => f.session.validateBatch([call('duplicate'), call('duplicate')])).toThrow('repeated')
    expect(budget.batchLimited).not.toHaveBeenCalled()
  })
  it('rejects duplicate call IDs before executing any item in a batch', () => {
    const f = setup()
    expect(() => f.session.validateBatch([call(), call()])).toThrow('repeated')
    expect(f.tools.execute).not.toHaveBeenCalled()
    f.session.validateBatch([call()])
    expect(() => f.session.validateBatch([call()])).toThrow('repeated')
  })
  it.each(['incomplete', 'in_progress', 'invalid'])('rejects %s calls before dispatch', (status) => {
    const f = setup()
    expect(() => f.session.validateBatch([{ ...call(), status } as ResponseFunctionToolCall])).toThrow('unfinished')
    expect(f.tools.execute).not.toHaveBeenCalled()
  })
  it('blocks unknown tools without reaching the executor', async () => {
    const f = setup()
    expect(JSON.parse(await f.session.execute(call('one', 'unrestricted_shell'), 4000)).error.code).toBe('unknown_tool')
    expect(f.tools.execute).not.toHaveBeenCalled()
  })
  it.each(['{', 'null', '[]', 'true', '"text"'])('blocks invalid argument object %s', async (args) => {
    const f = setup()
    expect(JSON.parse(await f.session.execute(call('one', 'open_application', args), 4000)).error.code).toBe('invalid_arguments')
    expect(f.tools.execute).not.toHaveBeenCalled()
  })
  it('enforces UTF-8 bytes, not JavaScript character count', async () => {
    const f = setup(); f.tools.maxArgumentBytes = 20
    expect(JSON.parse(await f.session.execute(call('one', 'open_application', '{"app":"你好你好你好"}'), 4000)).error.code).toBe('invalid_arguments')
    expect(f.tools.execute).not.toHaveBeenCalled()
  })
  it('checks access immediately before dispatch and after execution', async () => {
    const f = setup()
    await f.session.execute(call(), 4000)
    expect(f.tools.assertAccess).toHaveBeenCalledTimes(3)
    vi.mocked(f.tools.assertAccess).mockImplementation(() => { throw new ChatError('Access revoked') })
    await expect(f.session.execute(call('two'), 4000)).rejects.toThrow('revoked')
    expect(f.tools.execute).toHaveBeenCalledTimes(1)
  })
  it('sanitizes unexpected errors but stops on explicit access failures', async () => {
    const f = setup()
    vi.mocked(f.tools.execute).mockRejectedValueOnce(new Error('secret OS path'))
    const result = await f.session.execute(call(), 4000)
    expect(result).toContain('execution_failed'); expect(result).not.toContain('secret')
    vi.mocked(f.tools.execute).mockRejectedValueOnce(new ChatError('Session changed'))
    await expect(f.session.execute(call('two'), 4000)).rejects.toThrow('Session changed')
  })
  it('enforces a cumulative call budget across batches', async () => {
    const f = setup(1)
    await f.session.execute(call(), 4000)
    expect(f.session.exhausted).toBe(true)
    expect(JSON.parse(await f.session.execute(call('two'), 4000)).error.code).toBe('tool_limit')
    expect(f.tools.execute).toHaveBeenCalledTimes(1)
  })
  it('blocks uncertain replay of the same mutation after stream recovery, even with a new call ID', async () => {
    const f = setup()
    await f.session.execute(call('first', 'open_application', '{"app":"Athena"}'), 4000)
    f.session.guardRecovery()
    const repeated = await f.session.execute(call('new-id', 'open_application', '{"app":"Athena"}'), 4000)
    expect(JSON.parse(repeated).error.code).toBe('uncertain_replay')
    expect(f.tools.execute).toHaveBeenCalledTimes(1)
    expect(f.session.used).toBe(2)
  })
  it('cancels before dispatch and rejects late results', async () => {
    const f = setup()
    vi.mocked(f.tools.execute).mockImplementation(async () => { f.abort.abort(); return '{"ok":true}' })
    await expect(f.session.execute(call(), 4000)).rejects.toThrow('cancelled')
    await expect(f.session.execute(call('two'), 4000)).rejects.toThrow('cancelled')
    expect(f.tools.execute).toHaveBeenCalledTimes(1)
  })
})
