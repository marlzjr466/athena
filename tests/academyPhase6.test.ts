// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AcademyService } from '../electron/main/ai/academyService'
import { OllamaProvider } from '../electron/main/ai/OllamaProvider'
import { OllamaService } from '../electron/main/ai/ollamaService'
import { academyEvaluationSchema, academyModules } from '../shared/academy'
import { relevantAcademyModules } from '../shared/academyModules'
import { defaultSettings } from '../shared/settings'
import type { LocalModel } from '../shared/localAI'

const directories: string[] = []
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }) })
const directory = async () => { const path = await mkdtemp(join(tmpdir(), 'athena-phase6-')); directories.push(path); return path }
const alpha: LocalModel = { name: 'qwen2.5:3b', size: 1, capabilities: ['completion'], digest: 'digest-a' }
const beta: LocalModel = { ...alpha, name: 'qwen2.5-coder:3b', digest: 'digest-b' }

describe('Phase 6 local guidance and focused checks', () => {
  it('registers unique versioned language, framework, Git and Jira guidance without granting tools', () => {
    const ids = academyModules.map(module => module.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toEqual(expect.arrayContaining(['git-intelligence', 'jira-agile', 'typescript', 'javascript', 'python', 'java', 'go', 'rust', 'c', 'cpp', 'csharp', 'sql', 'html-css', 'bash', 'powershell', 'react', 'react-native-expo', 'nextjs', 'node-express', 'spring-boot', 'api-design', 'testing', 'containers', 'data-services']))
    expect(academyModules.every(module => /^\d+\.\d+\.\d+$/.test(module.version))).toBe(true)
    expect(relevantAcademyModules(['cpp', 'c', 'csharp'], 'Review this C++ source', false).map(module => module.id)).toEqual(['cpp'])
    expect(relevantAcademyModules(['cpp', 'c', 'csharp'], 'Review this C# source', false).map(module => module.id)).toEqual(['csharp'])
    expect(academyEvaluationSchema.parse({ id: '739ee32a-7820-44fb-a118-e63344237666', model: alpha.name, createdAt: '2026-10-19T00:00:00.000Z', completedAt: '2026-10-19T00:00:01.000Z', passed: 1, total: 1, checks: [{ name: 'legacy', passed: true, response: 'ok' }] }).track).toBe('general')
  })
  it('routes only installed, relevant packs to the chosen local model and preserves per-model settings', async () => {
    const path = await directory()
    const ollama = { call: vi.fn(), modelDetails: vi.fn() } as unknown as OllamaService
    const academy = new AcademyService(path, ollama)
    academy.setModule(alpha, 'coding-foundations', true)
    academy.setModule(alpha, 'react', true)
    academy.setModule(alpha, 'jira-agile', true)
    academy.setModule(alpha, 'git-intelligence', true)
    academy.setModule(beta, 'python', true)
    const react = academy.instructionsFor(alpha.name, 'Fix this React component', true)
    expect(react).toContain('Understand → Plan')
    expect(react).toContain('React work')
    expect(react).not.toContain('Jira or Agile')
    expect(react).not.toContain('For Git requests')
    const jira = academy.instructionsFor(alpha.name, 'Explain this Jira ticket', false)
    expect(jira).toContain('Jira or Agile')
    expect(jira).not.toContain('React work')
    expect(academy.instructionsFor(alpha.name, 'What time is it?', false)).toBe('')
    expect(academy.instructionsFor(beta.name, 'Fix this React component', true)).toBe('')
    expect(new AcademyService(path, ollama).profile(alpha).modules).toHaveLength(4)
  })
  it('injects only routed local guidance into the actual Ollama request', async () => {
    const path = await directory()
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(`${JSON.stringify({ message: { content: 'ok' }, done: true })}\n`))
    const ollama = new OllamaService(() => defaultSettings.localAI.endpoint, request)
    const academy = new AcademyService(path, ollama)
    academy.setModule(alpha, 'react', true)
    academy.setModule(alpha, 'jira-agile', true)
    const provider = new OllamaProvider(ollama, alpha.name, defaultSettings.localAI, alpha, (text, project) => academy.instructionsFor(alpha.name, text, project))
    for await (const _chunk of provider.streamMessage([{ id: 'u', role: 'user', content: 'Review my React component', status: 'complete', createdAt: 1 }])) { /* consume */ }
    const body = JSON.parse(request.mock.calls[0][1]?.body as string) as { messages: Array<{ content: string }> }
    expect(body.messages[0].content).toContain('For React work')
    expect(body.messages[0].content).not.toContain('For Jira or Agile')
  })
  it.each([
    ['coding', ['2,3', '4', 'FAIL']],
    ['git', ['git diff --cached', 'YES', 'NO']],
    ['jira', ['DISABLED', 'UNVERIFIED', 'NO']],
  ] as const)('runs the %s track only through local Ollama and stores an honest track-scoped result', async (track, answers) => {
    const path = await directory()
    let index = 0
    const call = vi.fn(async (endpoint: string, body?: unknown) => {
      expect(endpoint).toBe('api/chat')
      expect((body as { model: string; stream: boolean }).model).toBe(alpha.name)
      expect((body as { stream: boolean }).stream).toBe(false)
      return new Response(JSON.stringify({ message: { content: answers[index++] } }))
    })
    const academy = new AcademyService(path, { call, modelDetails: vi.fn() } as unknown as OllamaService)
    const result = await academy.evaluate(alpha, track)
    expect(result).toMatchObject({ track, passed: 3, total: 3 })
    expect(call).toHaveBeenCalledTimes(3)
    expect(new AcademyService(path, { call, modelDetails: vi.fn() } as unknown as OllamaService).snapshot().evaluations[0].track).toBe(track)
  })
})
