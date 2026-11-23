import type { ChatMessage } from '../../../shared/chat'

function textFingerprint(value?: string): string {
  if (!value) return '0:0'
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index++) hash = Math.imul(hash ^ value.charCodeAt(index), 0x01000193)
  return `${value.length}:${hash >>> 0}`
}

/**
 * Changes only when rendered transcript content changes. Approval IDs and
 * execution timestamps are intentionally excluded so resolving one permission
 * does not restart follow-to-bottom scrolling.
 */
export function conversationScrollKey(messages: readonly ChatMessage[]): string {
  const visible = messages.map(message => {
    const execution = message.execution
    const activities = execution?.activities.map(activity => [
      activity.id,
      activity.status,
      textFingerprint(activity.label),
      textFingerprint(activity.summary),
      activity.changes?.map(change => [change.id, change.status, textFingerprint(change.path)]),
      activity.subagent ? [activity.subagent.status, textFingerprint(activity.subagent.progress), textFingerprint(activity.subagent.result?.summary)] : undefined,
    ])
    const timeline = execution?.timeline
    const latestTimeline = timeline?.at(-1)
    return [
      message.id,
      message.role,
      message.status,
      textFingerprint(message.content),
      message.artifacts?.map(artifact => [artifact.id, artifact.status]),
      message.sources?.length,
      execution?.status,
      activities,
      timeline?.length,
      latestTimeline ? [latestTimeline.kind, latestTimeline.activityId, textFingerprint(latestTimeline.text)] : undefined,
    ]
  })
  return JSON.stringify(visible)
}
