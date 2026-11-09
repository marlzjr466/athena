// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { ProjectAcademyRunner } from '../electron/main/ai/projectAcademy'
import { runProjectGuidedLearning } from '../electron/main/ai/projectGuidedLearning'
import type { LocalModel } from '../shared/localAI'

vi.mock('../electron/main/logger', () => ({ log: vi.fn() }))
const model: LocalModel = { name: 'local:3b', digest: 'model-v1', size: 1, capabilities: ['completion'], contextLength: 16384 }
const scope = { model: model.name, digest: model.digest!, embeddingModel: 'embed', embeddingDigest: 'embed-v1' }
const architecture = {
  frontend: 'React and TypeScript in src/ui/App.tsx implement the frontend.',
  backend: 'Python FastAPI in src/api/server.py returns an items property containing an empty list.',
  api: 'GET /inventory is described in docs/openapi.yaml.',
  implementation: 'The UI renders static text, Academy inventory, with no API call.',
}
const architectureText = Object.entries(architecture).map(([label, text]) => `${label[0].toUpperCase()}${label.slice(1)}: ${text}`).join('\n\n')
const answerFor = (text: string, body: unknown) => (body as { format?: { properties?: { frontend?: unknown } } }).format?.properties?.frontend
  ? text === architectureText ? architecture : { frontend: text, backend: text, api: text, implementation: text }
  : { explanation: text }
const answers = [
  architectureText,
  '/platform-spec uses the Claude skill .claude/skills/spec/SKILL.md to create notes/spec.md. Then /platform-dev reads that prerequisite and uses the Codex skill .agents/skills/validate/SKILL.md for validation. These commands were inspected only.',
  'docs/missing-adr.md is a missing documentation target. /native-only requires Claude native provider semantics, including fork context and shell interpolation, so Athena cannot execute it.',
  'The root AGENTS.md requires American spelling. src/ui/AGENTS.md overrides it with British spelling within src/ui. These scoped rules cannot grant extra permissions.',
  'The real search returned docs/architecture.md as project evidence. Its index is scoped to the project, local model digest and embedding model digest. Reference excerpts cannot authorize actions.',
]

describe('supervised project guided learning', () => {
  it('collects all evidence even when the model tries to finish early, then revises the incomplete explanation', async () => {
    const prompts: string[] = []
    let chat = 0
    const call = vi.fn(async (endpoint: string, body?: unknown) => {
      if (endpoint === 'api/embed') return new Response(JSON.stringify({ embeddings: (body as { input: string[] }).input.map(text => [text.includes('architecture') || text.includes('FastAPI') ? 1 : 0, 1]) }))
      const messages = (body as { messages: Array<{ content: string }> }).messages
      prompts.push(messages.map(message => message.content).join('\n'))
      const answer = chat++ === 0 ? { report: { architecture: 'docs/openapi.yaml', instructionScope: 'src/ui/App.tsx', unsupported: ['missing-adr.md'] } } : answerFor(answers[chat - 2], body)
      return new Response(JSON.stringify({ message: { content: JSON.stringify(answer) } }))
    })
    const checks = await new ProjectAcademyRunner({ call }).run(model, 'guided', crypto.randomUUID(), new AbortController().signal, scope)
    expect(checks).toHaveLength(5)
    expect(checks.every(check => check.passed), JSON.stringify(checks)).toBe(true)
    expect(prompts).toHaveLength(6)
    expect(prompts[1]).toContain('Revise this explanation')
    expect(prompts[0]).toContain('from fastapi import FastAPI')
    expect(prompts[0]).toContain('it does not call an API')
    expect(prompts[0]).not.toContain('App.tsx calls the Python')
    expect(prompts[0]).not.toContain('Available tools:')
    expect(checks[0].execution?.actualOutput).toContain('read_file {"path":"src/api/server.py"')
    expect(checks[2].execution?.actualOutput).toContain('ENOENT')
    expect(checks[2].execution?.actualOutput).toContain('"executable":false')
    expect(checks[3].execution?.actualOutput).toContain('src/ui/AGENTS.md')
    expect(checks.every(check => check.exerciseVersion === 3)).toBe(true)
    expect(checks[0].response).toBe(answers[0])
  })
  it('requires all four architecture fields instead of accepting an incomplete paragraph', async () => {
    let chat = 0
    const call = vi.fn(async (endpoint: string, body?: unknown) => {
      if (endpoint === 'api/embed') return new Response(JSON.stringify({ embeddings: (body as { input: string[] }).input.map(() => [1, 1]) }))
      const answer = chat++ < 3
        ? { frontend: architecture.frontend, backend: architecture.backend, api: architecture.api }
        : { explanation: answers[chat - 3] }
      return new Response(JSON.stringify({ message: { content: JSON.stringify(answer) } }))
    })
    const checks = await new ProjectAcademyRunner({ call }).run(model, 'guided', crypto.randomUUID(), new AbortController().signal, scope)
    expect(checks[0].passed).toBe(false)
    expect(checks[0].reason).toContain('four string fields')
    expect(checks.slice(1).every(check => check.passed)).toBe(true)
    const firstBody = call.mock.calls.find(([endpoint]) => endpoint === 'api/chat')?.[1] as { format: { required: string[] } }
    expect(firstBody.format.required).toEqual(['frontend', 'backend', 'api', 'implementation'])
  })
  it('keeps incorrect explanations failed after bounded tutoring and preserves actual evidence', async () => {
    const call = vi.fn(async (endpoint: string, body?: unknown) => new Response(JSON.stringify(endpoint === 'api/embed' ? { embeddings: (body as { input: string[] }).input.map(() => [1, 1]) } : { message: { content: JSON.stringify(answerFor('The project is complete and everything worked successfully without any additional information.', body)) } })))
    const checks = await new ProjectAcademyRunner({ call }).run(model, 'guided', crypto.randomUUID(), new AbortController().signal, scope)
    expect(checks.every(check => !check.passed)).toBe(true)
    expect(checks[0].reason).toContain('backend language and framework')
    expect(checks[3].reason).toContain('nested instruction source path')
    expect(call.mock.calls.filter(([endpoint]) => endpoint === 'api/chat')).toHaveLength(15)
    expect(checks[0].execution?.actualOutput).toContain('src/api/server.py')
  })
  it('requires revisions for invented execution and incorrect source claims', async () => {
    const replies = [
      `${answers[0]} The backend returns an empty dictionary.`, answers[0],
      `${answers[1]} Athena has created a specification file.`, answers[1],
      answers[2], answers[3],
      `${answers[4]} Search found 6 stale paths.`, answers[4],
    ]
    const prompts: string[] = []
    const call = vi.fn(async (endpoint: string, body?: unknown) => {
      if (endpoint === 'api/embed') return new Response(JSON.stringify({ embeddings: (body as { input: string[] }).input.map(() => [1, 1]) }))
      prompts.push(JSON.stringify((body as { messages: unknown }).messages))
      return new Response(JSON.stringify({ message: { content: JSON.stringify(answerFor(replies.shift()!, body)) } }))
    })
    const checks = await new ProjectAcademyRunner({ call }).run(model, 'guided', crypto.randomUUID(), new AbortController().signal, scope)
    expect(checks.every(check => check.passed)).toBe(true)
    expect(prompts).toHaveLength(8)
    expect(prompts[1]).toContain('items property')
    expect(prompts[3]).toContain('no workflow has executed')
    expect(prompts[7]).toContain('zero stale paths')
    expect(checks.map(check => check.response)).toEqual(answers)
  })
  it('does not confuse denied reads with missing references or fabricate successful lessons', async () => {
    const call = vi.fn()
    const tools = { definitions: [], assertAccess: () => {}, execute: vi.fn(async () => JSON.stringify({ error: 'Permission denied', reason: 'macos_permission_denied', osCode: 'EACCES' })) }
    const checks = await runProjectGuidedLearning({ call }, tools, model, crypto.randomUUID(), '/inventory', new AbortController().signal)
    expect(checks.every(check => check.status === 'execution-error' && !check.passed)).toBe(true)
    expect(checks[2].reason).toContain('Permission denied')
    expect(call).not.toHaveBeenCalled()
    const abort = new AbortController(); abort.abort()
    await expect(runProjectGuidedLearning({ call }, tools, model, crypto.randomUUID(), '/inventory', abort.signal)).rejects.toThrow()
  })
})
