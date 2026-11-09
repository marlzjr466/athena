import { z } from 'zod'

export const automationPermissionsSchema = z.object({
  internalNavigation: z.boolean().default(false),
  conversationManagement: z.boolean().default(false),
  browserAccess: z.boolean().default(false),
  desktopApplicationControl: z.boolean().default(false),
  fileReading: z.boolean().default(false),
  fileModification: z.boolean().default(false),
  terminalExecution: z.boolean().default(false),
  externalMessageSubmission: z.boolean().default(false),
  destructiveOperations: z.boolean().default(false),
}).strict()

export type AutomationPermissions = z.infer<typeof automationPermissionsSchema>
export const automationPermissionDefaults = automationPermissionsSchema.parse({})
export type AutomationPermission = keyof AutomationPermissions

export interface AutomationProgressStep {
  id: string
  label: string
  status: 'running' | 'complete' | 'failed' | 'cancelled'
  startedAt: number
  finishedAt?: number
  message?: string
}

export interface AutomationProgress {
  id: string
  task: string
  phase: 'running' | 'complete' | 'failed' | 'cancelled'
  cancelTarget?: 'voice' | 'chat'
  startedAt: number
  updatedAt: number
  steps: AutomationProgressStep[]
  message?: string
}
