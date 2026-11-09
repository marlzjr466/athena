import type { ResponseInput, ResponseOutputItem } from 'openai/resources/responses/responses'

export const CONTINUATION_INSTRUCTIONS = `Continue the same unfinished task after an output-token interruption. Prior completed tool results are authoritative. Do not repeat completed or denied operations. Re-read current source before further modifications, review recorded changes if needed, and retain all original user constraints. Tool calls from the interrupted response were not executed, even if their JSON looks complete; request any still-needed operations anew with complete arguments. Resume after the unfinished draft without repeating earlier prose. Prefer small targeted edits and concise summaries. An incomplete draft or unexecuted tool request is never evidence of success.`

export function visibleOutputText(output: ResponseOutputItem[] | undefined): string {
  return (output ?? []).filter((item) => item.type === 'message').flatMap((item) => item.content)
    .map((part) => part.type === 'output_text' ? part.text : part.type === 'refusal' ? part.refusal : '').join('')
}

export function recoverableOutput(output: ResponseOutputItem[], doneItems: Set<string>, streamedText: string): ResponseInput {
  const result: ResponseInput = []
  // Do not replay partial tool JSON or encrypted reasoning tied to discarded
  // function calls. Only done reasoning without such dependencies is reusable.
  if (!output.some((item) => item.type === 'function_call')) {
    for (const item of output) if (item.type === 'reasoning' && doneItems.has(item.id) && item.encrypted_content && item.status !== 'incomplete') result.push(item)
  }
  const text = visibleOutputText(output) || streamedText
  if (text) result.push({ role: 'assistant', content: `[Unfinished response draft; not a completed task]\n${text}` })
  return result
}
