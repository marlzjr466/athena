import type { ReasoningEffort } from './conversations'

/** Safe, renderer-visible metadata only. Never contains Codex credentials or local auth paths. */
export interface CodexCLIModel {
  id: string
  displayName: string
  efforts: ReasoningEffort[]
  defaultEffort: ReasoningEffort | null
  isDefault: boolean
}

export interface CodexCLIStatus {
  installed: boolean
  authenticated: boolean
  version: string | null
  identity: string | null
  models: CodexCLIModel[]
  defaultModel: string | null
  checkedAt: number | null
  message: string
}

export const emptyCodexCLIStatus = (): CodexCLIStatus => ({
  installed: false,
  authenticated: false,
  version: null,
  identity: null,
  models: [],
  defaultModel: null,
  checkedAt: null,
  message: 'Codex CLI has not been checked.',
})

