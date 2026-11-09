/** Optional authenticated integration seam. No adapters are enabled by default. */
export type MeetingIntegrationProvider = 'google' | 'microsoft'
export type MeetingIntegrationScope = 'calendar-read' | 'mail-draft' | 'document-write'
export interface MeetingEventReference { provider: MeetingIntegrationProvider; accountId: string; eventId: string; title: string; start: string; end: string; joinURL?: string }
export interface MeetingIntegrationAuthorization { accountId: string; scopes: MeetingIntegrationScope[]; expiresAt: number }
export interface MeetingIntegrationAdapter {
  provider: MeetingIntegrationProvider
  status(): Promise<{ authenticated: boolean; accounts: Array<{ id: string; label: string; scopes: MeetingIntegrationScope[] }> }>
  events(authorization: MeetingIntegrationAuthorization, start: string, end: string, signal: AbortSignal): Promise<MeetingEventReference[]>
  /** Build a reviewable local proposal; creating a remote draft/document is a separate explicit approval. */
  prepareFollowup(event: MeetingEventReference, notes: string): Promise<{ recipients: string[]; subject: string; body: string }>
  saveDocument(authorization: MeetingIntegrationAuthorization, proposal: { title: string; content: string; destinationId: string }, explicitApproval: { meetingId: string; approvedAt: number }, signal: AbortSignal): Promise<{ id: string; url: string }>
}
