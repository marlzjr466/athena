import { createHash } from 'node:crypto'
import { app } from 'electron'
import { academyRepositorySchema, type AcademyCodeHost, type AcademyIntegrationStatus, type AcademyReviewEvidence } from '../../../shared/academyIntegrations'

export interface IntegrationSecretStore {
  read(provider: AcademyCodeHost): Promise<string | null>
  write(provider: AcademyCodeHost, token: string): Promise<void>
  remove(provider: AcademyCodeHost): Promise<void>
}

/** Secrets never enter Academy's JSON profile store or return through IPC. */
export class KeychainIntegrationSecretStore implements IntegrationSecretStore {
  private async entry(provider: AcademyCodeHost) {
    if (process.platform !== 'darwin') throw new Error('Code-host credential storage currently requires macOS Keychain.')
    const { AsyncEntry } = await import('@napi-rs/keyring')
    const profile = app.isPackaged ? '' : `.dev.${createHash('sha256').update(app.getPath('userData')).digest('hex').slice(0, 24)}`
    return new AsyncEntry(`com.athena.companion.academy.${provider}${profile}`, 'read-only-code-host')
  }
  async read(provider: AcademyCodeHost): Promise<string | null> { return await (await this.entry(provider)).getPassword() ?? null }
  async write(provider: AcademyCodeHost, token: string): Promise<void> { await (await this.entry(provider)).setPassword(token) }
  async remove(provider: AcademyCodeHost): Promise<void> { await (await this.entry(provider)).deleteCredential() }
}

const hosts = { github: 'https://api.github.com', gitlab: 'https://gitlab.com/api/v4' } as const
const text = (value: unknown, max = 200) => typeof value === 'string' ? value.slice(0, max) : ''
const statusError = (status: number): string => status === 401 ? 'Credential rejected or expired.'
  : status === 403 ? 'Access denied or API quota reached; check token permissions and the account.'
    : status === 404 ? 'Review not found or this account cannot access it.'
      : status === 429 ? 'The code host is rate limiting requests. Try later.'
        : `Code host returned HTTP ${status}.`

/** Fixed official API hosts, GET-only requests, no redirect following or arbitrary URL input. */
export class AcademyIntegrations {
  private identities = new Map<AcademyCodeHost, { account: string; verifiedAt: string }>()
  constructor(private secrets: IntegrationSecretStore = new KeychainIntegrationSecretStore(), private request: typeof fetch = fetch) {}
  private async get(provider: AcademyCodeHost, path: string, token: string): Promise<Record<string, unknown>> {
    let response: Response
    try {
      response = await this.request(`${hosts[provider]}${path}`, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(12_000), headers: provider === 'github'
        ? { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' }
        : { 'PRIVATE-TOKEN': token } })
    } catch { throw new Error('Code-host connection failed or timed out. No credential was changed.') }
    if (!response.ok) throw new Error(statusError(response.status))
    if (Number(response.headers.get('content-length')) > 256_000) throw new Error('Code-host response was too large.')
    const body = await response.text()
    if (body.length > 256_000) throw new Error('Code-host response was too large.')
    let payload: unknown
    try { payload = JSON.parse(body) }
    catch { throw new Error('Code host returned invalid JSON.') }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Code host returned an invalid response.')
    return payload as Record<string, unknown>
  }
  async statuses(): Promise<AcademyIntegrationStatus[]> {
    return Promise.all((['github', 'gitlab'] as const).map(async provider => {
      const token = await this.secrets.read(provider)
      if (!token) return { provider, connected: false }
      try {
        const user = await this.get(provider, '/user', token)
        const account = text(provider === 'github' ? user.login : user.username, 100)
        if (!account) throw new Error('The code host did not identify this account.')
        const verifiedAt = new Date().toISOString()
        this.identities.set(provider, { account, verifiedAt })
        return { provider, connected: true, account, verifiedAt }
      } catch (error) {
        this.identities.delete(provider)
        return { provider, connected: true, error: error instanceof Error ? error.message : 'Account verification failed.' }
      }
    }))
  }
  async connect(provider: AcademyCodeHost, token: string): Promise<AcademyIntegrationStatus> {
    const cleaned = token.trim()
    if (cleaned.length < 8 || cleaned.length > 500 || /[\r\n]/.test(cleaned)) throw new Error('Enter a valid code-host access token.')
    const user = await this.get(provider, '/user', cleaned)
    const account = text(provider === 'github' ? user.login : user.username, 100)
    if (!account) throw new Error('The code host did not identify the authenticated account. Nothing was saved.')
    try { await this.secrets.write(provider, cleaned) }
    catch { throw new Error('macOS Keychain could not save the code-host credential.') }
    const verifiedAt = new Date().toISOString()
    this.identities.set(provider, { account, verifiedAt })
    return { provider, connected: true, account, verifiedAt }
  }
  async disconnect(provider: AcademyCodeHost): Promise<void> {
    try { await this.secrets.remove(provider) }
    catch { throw new Error('macOS Keychain could not remove the code-host credential.') }
    this.identities.delete(provider)
  }
  async inspectReview(provider: AcademyCodeHost, repository: string, number: number): Promise<AcademyReviewEvidence> {
    const repo = academyRepositorySchema.parse(repository.trim())
    if (!Number.isSafeInteger(number) || number < 1 || number > 1_000_000_000) throw new Error('Enter a valid pull or merge request number.')
    const token = await this.secrets.read(provider)
    if (!token) throw new Error(`Connect ${provider === 'github' ? 'GitHub' : 'GitLab'} before inspecting private reviews.`)
    const path = provider === 'github'
      ? `/repos/${repo.split('/').map(encodeURIComponent).join('/')}/pulls/${number}`
      : `/projects/${encodeURIComponent(repo)}/merge_requests/${number}`
    const item = await this.get(provider, path, token)
    const author = item.user && typeof item.user === 'object' ? item.user as Record<string, unknown> : item.author && typeof item.author === 'object' ? item.author as Record<string, unknown> : {}
    const result = {
      provider, repository: repo, number, title: text(item.title, 300), state: text(item.state, 80),
      author: text(provider === 'github' ? author.login : author.username, 100), updatedAt: text(item.updated_at, 80),
      url: text(provider === 'github' ? item.html_url : item.web_url, 500), description: text(provider === 'github' ? item.body : item.description, 4000),
      ...(provider === 'gitlab' && item.head_pipeline && typeof item.head_pipeline === 'object' ? { pipelineStatus: text((item.head_pipeline as Record<string, unknown>).status, 80) } : {}),
    }
    if (!result.title || !result.url.startsWith(provider === 'github' ? 'https://github.com/' : 'https://gitlab.com/')) throw new Error('Code host response lacked a usable review title or URL.')
    return result
  }
}
