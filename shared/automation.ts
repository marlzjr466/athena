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
  projectManagement: z.boolean().default(false),
  gitOperations: z.boolean().default(false),
  browserInteraction: z.boolean().default(false),
  desktopUIInteraction: z.boolean().default(false),
  screenObservation: z.boolean().default(false),
}).strict()

export type AutomationPermissions = z.infer<typeof automationPermissionsSchema>
export const automationPermissionDefaults = automationPermissionsSchema.parse({})
export type AutomationPermission = keyof AutomationPermissions

export interface ComputerUseStatus {
  automation?: import('./applicationAutomation').AutomationEngineStatus
  installed?: Array<{key:string;name:string}>
  browser: string
  locked: boolean
  recent: Array<{actionId:string;createdAt:string;status:string;durationMs?:number;diagnostics?:Record<string,string>}>
  test?: {ok:boolean;message:string}
  checks?:Array<{name:string;status:'passed'|'failed'|'not-tested';message:string}>
}

export interface AutomationProgressStep {
  id: string
  label: string
  status: 'running' | 'complete' | 'failed' | 'cancelled'
  startedAt: number
  finishedAt?: number
  message?: string
}

export interface AutomationProgress {
  engine?: 'OpenAI' | 'Athena Native' | 'Codex'
  application?: string
  paused?:boolean
  verifiedSteps?:number
  apiRequests?:number
  id: string
  task: string
  phase: 'running' | 'complete' | 'failed' | 'cancelled'
  cancelTarget?: 'voice' | 'chat'
  startedAt: number
  updatedAt: number
  steps: AutomationProgressStep[]
  message?: string
}
