import { aiKeyInputSchema, aiModelInputSchema, emptyAIStatus, type AIResult, type AIStatus } from '../../../shared/ai'
import type { AICredential, CredentialStore } from './credentialStore'
import type { ConnectionTester } from './openAIConnection'
import { ChatError, NOT_CONFIGURED } from './AIProvider'
import { openAIAPIGptModels, isSelectableOpenAIAPIGptModel } from '../../../shared/modelCatalog'
import { knownReasoningEfforts } from '../../../shared/modelCapabilities'
import { apiUsageAccount } from './usageLedger'

export class AIConfiguration {
  private credential: AICredential | null = null
  private loaded = false
  private connection: AIStatus['connection'] = 'not-tested'
  private queue: Promise<unknown> = Promise.resolve()
  constructor(private vault: CredentialStore, private connectionTester: ConnectionTester, private changed: () => void = () => {}) {}
  private status(): AIStatus {
    const models = openAIAPIGptModels(this.credential?.models ?? [])
    return { ...emptyAIStatus(), active: Boolean(this.credential?.verifiedAt), hasKey: Boolean(this.credential),
      model: this.credential?.model ?? null, models,
      modelEfforts: Object.fromEntries(models.flatMap(model => {
        const efforts = knownReasoningEfforts('cloud', model)
        return efforts ? [[model, efforts]] : []
      })),
      lastVerifiedAt: this.credential?.verifiedAt ?? null, connection: this.connection }
  }
  private result(ok: boolean, message: string): AIResult { return { ok, status: this.status(), message } }
  private run(work: () => Promise<AIResult>): Promise<AIResult> {
    const operation = this.queue.then(work).catch(() => this.result(false, 'Secure credential storage is unavailable. Unlock macOS Keychain and try again.'))
    this.queue = operation
    return operation
  }
  private async load(): Promise<void> {
    if (this.loaded) return
    this.credential = await this.vault.read()
    this.loaded = true
  }
  getStatus(): Promise<AIResult> {
    return this.run(async () => { await this.load(); return this.result(true, '') })
  }
  async mediaCredential(): Promise<string | undefined> {
    await this.queue
    await this.load()
    return this.credential?.verifiedAt ? this.credential.apiKey : undefined
  }
  async usageAccountId(): Promise<string | null> {
    await this.queue; await this.load()
    return this.credential ? apiUsageAccount(this.credential.apiKey) : null
  }
  // Main-process only. This method is deliberately absent from the preload/IPC API.
  async getActiveConfiguration(selectedModel: string | null): Promise<{ apiKey: string; model: string }> {
    await this.queue
    try { await this.load() }
    catch { throw new ChatError('Unlock macOS Keychain, then reopen Settings → AI.') }
    if (!this.credential?.verifiedAt) throw new ChatError(NOT_CONFIGURED)
    const model = selectedModel
    if (!model) throw new ChatError('Select a text model in Settings → AI before chatting.')
    if (!isSelectableOpenAIAPIGptModel(model) || !this.credential.models.includes(model)) throw new ChatError('This OpenAI API model is no longer selectable. Choose an available GPT-5.6 or newer model in Chat Conversation.')
    return { apiKey: this.credential.apiKey, model }
  }
  test(input?: unknown): Promise<AIResult> {
    return this.run(async () => {
      await this.load()
      const parsed = input === undefined ? null : aiKeyInputSchema.safeParse(input)
      if (parsed && !parsed.success) return this.result(false, 'Enter a valid API key.')
      const key = parsed?.success ? parsed.data.apiKey : this.credential?.apiKey
      if (!key) return this.result(false, 'Enter an API key first.')
      const result = await this.connectionTester.test(key)
      this.connection = result.ok ? 'successful' : result.kind
      if (input === undefined && this.credential) {
        if (result.ok) {
          const next = { ...this.credential, models: openAIAPIGptModels(result.models), verifiedAt: Date.now() }
          // Keep the saved ID for display and conversation history. It is no
          // longer selectable, but changing credentials must not silently pick
          // a different model for a saved or currently running conversation.
          await this.vault.write(next)
          if (next.model !== this.credential.model) this.changed()
          this.credential = next
        } else if (result.kind === 'invalid-key') {
          this.credential = { ...this.credential, verifiedAt: null }
          this.changed()
          await this.vault.write(this.credential)
        }
      }
      return this.result(result.ok, result.ok ? 'Connection successful.' : result.message)
    })
  }
  activate(input: unknown): Promise<AIResult> {
    return this.run(async () => {
      const parsed = aiKeyInputSchema.safeParse(input)
      if (!parsed.success) return this.result(false, 'Enter a valid API key.')
      await this.load()
      // Always verify this exact key again; a prior test cannot authorize a different key.
      const result = await this.connectionTester.test(parsed.data.apiKey)
      this.connection = result.ok ? 'successful' : result.kind
      if (!result.ok) return this.result(false, result.message)
      const models = openAIAPIGptModels(result.models)
      const credential: AICredential = { version: 1, apiKey: parsed.data.apiKey,
        model: this.credential?.model && models.includes(this.credential.model) ? this.credential.model : null,
        models, verifiedAt: Date.now() }
      await this.vault.write(credential)
      this.credential = credential
      this.changed()
      return this.result(true, 'Connection successful. OpenAI is active.')
    })
  }
  selectModel(input: unknown): Promise<AIResult> {
    return this.run(async () => {
      await this.load()
      const parsed = aiModelInputSchema.safeParse(input)
      if (!parsed.success || !this.credential?.verifiedAt || !isSelectableOpenAIAPIGptModel(parsed.data.model) || !openAIAPIGptModels(this.credential.models).includes(parsed.data.model)) return this.result(false, 'Choose an available GPT-5.6 or newer model returned by your successful connection test.')
      const next = { ...this.credential, model: parsed.data.model }
      await this.vault.write(next)
      this.credential = next
      this.changed()
      return this.result(true, 'Model preference saved. Open Conversation to chat.')
    })
  }
  remove(): Promise<AIResult> {
    return this.run(async () => {
      // Removal must also work when a stored record is malformed/unreadable.
      await this.vault.remove()
      this.credential = null
      this.loaded = true
      this.connection = 'not-tested'
      this.changed()
      return this.result(true, 'API key removed. AI is not configured.')
    })
  }
}
