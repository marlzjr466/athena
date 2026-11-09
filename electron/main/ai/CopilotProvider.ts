import type { AIChunk, ChatMessage } from '../../../shared/chat'
import { ATHENA_PERSONALITY, ChatError, type AIProvider, type StreamOptions } from './AIProvider'
import type { CopilotService } from './copilotService'

export class CopilotProvider implements AIProvider {
  constructor(private service: CopilotService, readonly modelId: string, private accountId: string) {}
  async testConnection() { return (await this.service.aiStatus()).ok }
  async *streamMessage(messages: ChatMessage[], options: StreamOptions = {}): AsyncIterable<AIChunk> {
    const release = this.service.beginRequest()
    try {
    const { client, account, models } = await this.service.active()
    if (account.id !== this.accountId) throw new ChatError('Copilot account changed before this request. Send again using the selected account.')
    const model = models.find(m=>m.id===this.modelId)
    if (!model) throw new ChatError('This model is unavailable in the selected Copilot account. Refresh the model catalog.')
    if (options.context?.attachments.some(a=>a.kind !== 'text')) throw new ChatError('Copilot image and PDF attachments are not yet enabled in Athena. No attachment was sent.')
    if (options.effort && options.effort !== 'auto' && !model.supportedReasoningEfforts?.includes(options.effort)) throw new ChatError('This Copilot model does not support the selected reasoning effort.')
    const tools = options.context?.projectTools
    const signal = AbortSignal.any([options.signal ?? new AbortController().signal, AbortSignal.timeout(tools?.timeoutMs ?? 300000)])
    let calls = 0
    signal.throwIfAborted()
    const queue: AIChunk[] = []
    let wake: (()=>void) | undefined
    const emit = (chunk: AIChunk) => { queue.push(chunk); wake?.() }
    const session = await client.createSession({
      model: model.id, streaming: true, infiniteSessions: { enabled: false }, enableFileHooks: false,
      // CLI clients use copilot-cli mode so keychain sign-in is visible. Repeat the empty-mode session lockdown here so that mode cannot load host skills, git, memory, plugins, or instructions.
      enableSkills: false, enableHostGitOperations: false, enableSessionStore: false, enableOnDemandInstructionDiscovery: false, enableConfigDiscovery: false, enableSessionTelemetry: false, skipEmbeddingRetrieval: true, embeddingCacheStorage: 'in-memory', mcpOAuthTokenStorage: 'in-memory', memory: { enabled: false }, customAgentsLocalOnly: true, skipCustomInstructions: true, coauthorEnabled: false, manageScheduleEnabled: false, includedBuiltinSkills: [],
      reasoningEffort: options.effort === 'auto' ? undefined : options.effort,
      systemMessage: { mode: 'replace', content: `${ATHENA_PERSONALITY}\n${tools?.policy ?? ''}\n${options.context?.realtimeInstructions ?? ''}` },
      availableTools: (tools?.definitions ?? []).map(t=>`custom:athena_${t.name}`),
      excludedTools: ['builtin:*','mcp:*'],
      onPermissionRequest: () => ({ kind: 'denied-interactively-by-user' }),
      tools: tools?.definitions.map(tool=>({ ...tool, name: `athena_${tool.name}`, skipPermission: true, handler: async (args: unknown) => {
        // SDK permission is skipped only for custom tools: Athena's executor is authoritative.
        signal.throwIfAborted(); tools.assertAccess()
        if (++calls > (tools.maxCalls ?? 80)) throw new ChatError('Copilot reached Athena’s tool-call budget.')
        return tools.execute(tool.name, args, signal)
      } })),
    })
    let error: unknown, finished = false
    const unsubscribe = session.on(event=>{
      if (event.type === 'assistant.message_delta') emit({ type:'text',text:event.data.deltaContent })
      if (event.type === 'session.error') error = new ChatError('Copilot could not complete the request. Check subscription eligibility, usage limits, and connection; no paid fallback was used.')
    })
    const abort = () => { void session.abort().catch(()=>{}); finished = true; wake?.() }
    signal.addEventListener('abort', abort, { once: true })
    const prompt = JSON.stringify({ conversation: messages.map(m=>({role:m.role,content:m.content})), context: options.context?.repositoryText, attachments: options.context?.attachments })
    const reportedLimit = model.capabilities.limits.max_prompt_tokens || model.capabilities.limits.max_context_window_tokens
    try {
      // Auto currently reports a zero window. That is missing metadata, not a conversation that fills the window.
      if (reportedLimit > 0 && Buffer.byteLength(prompt) > reportedLimit) throw new ChatError('This conversation exceeds Athena’s conservative Copilot context bound. Start a new conversation or provide a smaller attachment; no content was truncated.')
      const pending = session.sendAndWait(prompt, 300000).catch(e=>{error=e}).finally(()=>{finished=true;wake?.()})
      while (!finished || queue.length) {
        if (!queue.length) await new Promise<void>(resolve=>{wake=resolve})
        while(queue.length) yield queue.shift()!
      }
      signal.throwIfAborted()
      await pending
      if(error) { await session.abort().catch(()=>{}); throw new ChatError('Copilot generation failed or reached a usage/time limit. No other provider was used. Reconnect or check your Copilot plan before retrying.') }
      await tools?.validateCompletion?.()
      yield { type:'done' }
    } finally { await session.abort().catch(()=>{}); signal.removeEventListener('abort',abort); unsubscribe(); await session.disconnect() }
    } finally { release() }
  }
}
