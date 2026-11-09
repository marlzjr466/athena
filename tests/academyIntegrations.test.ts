// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { AcademyIntegrations, type IntegrationSecretStore } from '../electron/main/ai/academyIntegrations'
import { academyIntegrationCommandSchema } from '../shared/academyIntegrations'

vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => '/unused-test-profile' } }))

function setup() {
  const passwords = new Map<string, string>()
  const store: IntegrationSecretStore = {
    read: async provider => passwords.get(provider) ?? null,
    write: async (provider, token) => { passwords.set(provider, token) },
    remove: async provider => { passwords.delete(provider) },
  }
  const request = vi.fn<typeof fetch>()
  return { service: new AcademyIntegrations(store, request), request, passwords }
}
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status })

describe('Phase 6 read-only code-host connections', () => {
  it('validates GitHub identity before storing and never returns the token', async () => {
    const { service, request, passwords } = setup()
    request.mockResolvedValue(json({ login: 'octocat' }))
    const status = await service.connect('github', 'github_test_secret')
    expect(status).toMatchObject({ provider: 'github', connected: true, account: 'octocat' })
    expect(JSON.stringify(status)).not.toContain('github_test_secret')
    expect(passwords.get('github')).toBe('github_test_secret')
    expect(request).toHaveBeenCalledWith('https://api.github.com/user', expect.objectContaining({ method: 'GET', redirect: 'error', headers: expect.objectContaining({ Authorization: 'Bearer github_test_secret' }) }))
    request.mockResolvedValue(json({ login: 'octocat' }))
    expect((await service.statuses()).find(item => item.provider === 'github')?.account).toBe('octocat')
  })
  it('rejects invalid credentials without overwriting an existing connection', async () => {
    const { service, request, passwords } = setup()
    passwords.set('github', 'existing_secret')
    request.mockResolvedValue(json({ message: 'bad credentials' }, 401))
    await expect(service.connect('github', 'new_invalid_secret')).rejects.toThrow('Credential rejected')
    expect(passwords.get('github')).toBe('existing_secret')
    expect(await service.statuses()).toContainEqual(expect.objectContaining({ provider: 'github', connected: true, error: expect.stringContaining('Credential rejected') }))
  })
  it('uses fixed GitHub and GitLab review endpoints without redirects, writes or token-bearing results', async () => {
    const { service, request, passwords } = setup()
    passwords.set('github', 'github_test_secret')
    passwords.set('gitlab', 'gitlab_test_secret')
    request.mockResolvedValueOnce(json({ title: 'Fix it', state: 'open', body: 'Review the change', user: { login: 'dev' }, html_url: 'https://github.com/team/repo/pull/12', updated_at: '2026-10-19T01:00:00Z' }))
      .mockResolvedValueOnce(json({ title: 'Merge it', state: 'opened', description: 'MR description', author: { username: 'dev2' }, web_url: 'https://gitlab.com/team/repo/-/merge_requests/8', head_pipeline: { status: 'success' } }))
    const github = await service.inspectReview('github', 'team/repo', 12)
    const gitlab = await service.inspectReview('gitlab', 'team/repo', 8)
    expect(github).toMatchObject({ number: 12, author: 'dev' })
    expect(gitlab).toMatchObject({ number: 8, pipelineStatus: 'success' })
    expect(request.mock.calls.map(call => call[0])).toEqual(['https://api.github.com/repos/team/repo/pulls/12', 'https://gitlab.com/api/v4/projects/team%2Frepo/merge_requests/8'])
    expect(request.mock.calls.every(call => (call[1] as RequestInit).method === 'GET' && (call[1] as RequestInit).redirect === 'error')).toBe(true)
    expect(JSON.stringify([github, gitlab])).not.toMatch(/(?:github|gitlab)_test_secret/)
  })
  it('rejects path traversal, missing credentials and malformed remote responses', async () => {
    const { service, request, passwords } = setup()
    expect(academyIntegrationCommandSchema.safeParse({ action: 'inspect-review', provider: 'github', repository: '../private', number: 1 }).success).toBe(false)
    await expect(service.inspectReview('github', 'team/repo', 1)).rejects.toThrow('Connect GitHub')
    passwords.set('github', 'github_test_secret')
    request.mockResolvedValue(json({ title: 'Missing URL' }))
    await expect(service.inspectReview('github', 'team/repo', 1)).rejects.toThrow('lacked a usable')
    request.mockResolvedValue(json({ title: 'Huge' }, 429))
    await expect(service.inspectReview('github', 'team/repo', 1)).rejects.toThrow('rate limiting')
  })
  it('removes only the chosen provider credential', async () => {
    const { service, passwords } = setup()
    passwords.set('github', 'github_test_secret'); passwords.set('gitlab', 'gitlab_test_secret')
    await service.disconnect('github')
    expect(passwords.has('github')).toBe(false)
    expect(passwords.has('gitlab')).toBe(true)
  })
})
