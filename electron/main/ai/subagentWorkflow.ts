import { z } from 'zod'
import { subagentRequirementSchema, type SubagentRequirement } from '../../../shared/subagents'
import { ChatError } from './AIProvider'

/** An explicit JSON block keeps workflow declarations portable across existing Markdown loaders. */
export function workflowSubagentRequirements(markdown: string): SubagentRequirement[] {
  const block = /```athena-subagents\s*\n([\s\S]*?)\n```/.exec(markdown)?.[1]
  const inline = /^subagents:\s*(\[[^\n]*\])\s*$/m.exec(markdown)?.[1]
  if (block || inline) {
    try {
      const declarations = z.array(subagentRequirementSchema).max(12).parse(JSON.parse(block ?? inline!))
      if (new Set(declarations.map((entry) => entry.id)).size !== declarations.length) throw new Error()
      return declarations
    } catch { throw new ChatError('Invalid sub-agent workflow declaration. Use an athena-subagents JSON array with unique gate IDs; the required review has not run.') }
  }
  // Existing Claude/Codex workflows predate Athena metadata. Recognize an explicitly
  // prescribed independent cold read, while leaving ordinary review prose alone.
  if (/cold[- ]read[^\n.]{0,100}sub[- ]?agent|sub[- ]?agent[^\n.]{0,100}cold[- ]read/i.test(markdown)) {
    return [{ id: 'cold-read-review', required: true, mode: 'cold_read', role: 'Cold-read reviewer', expectedResultSchema: 'athena-review-v1' }]
  }
  return []
}
