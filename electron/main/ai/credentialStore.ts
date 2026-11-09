import { createHash } from 'node:crypto'
import { app } from 'electron'
import { z } from 'zod'
import { apiKeySchema, modelIdSchema } from '../../../shared/ai'

export const credentialSchema = z.object({
  version: z.literal(1), apiKey: apiKeySchema, model: modelIdSchema.nullable(),
  models: z.array(modelIdSchema).max(2000), verifiedAt: z.number().finite().positive().nullable(),
}).strict()
export type AICredential = z.infer<typeof credentialSchema>
export interface CredentialStore {
  read(): Promise<AICredential | null>
  write(credential: AICredential): Promise<void>
  remove(): Promise<void>
}

export function credentialServiceName(): string {
  // Test/development profiles cannot access the user's packaged-app credential.
  if (app.isPackaged) return 'com.athena.companion.openai'
  return `com.athena.companion.openai.dev.${createHash('sha256').update(app.getPath('userData')).digest('hex').slice(0,24)}`
}
export class KeychainCredentialStore implements CredentialStore {
  private async entry() {
    if (process.platform !== 'darwin') throw new Error('Credential storage is currently supported on macOS only.')
    const { AsyncEntry } = await import('@napi-rs/keyring')
    return new AsyncEntry(credentialServiceName(), 'openai-configuration')
  }
  async read(): Promise<AICredential | null> {
    const raw = await (await this.entry()).getPassword()
    if (raw == null) return null
    // Never propagate parser/native error details: they could contain the secret.
    try { return credentialSchema.parse(JSON.parse(raw)) }
    catch { throw new Error('Stored AI configuration could not be read.') }
  }
  async write(credential: AICredential): Promise<void> {
    await (await this.entry()).setPassword(JSON.stringify(credentialSchema.parse(credential)))
  }
  async remove(): Promise<void> { await (await this.entry()).deleteCredential() }
}
