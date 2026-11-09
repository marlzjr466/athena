import { useEffect, useState } from 'react'
import { Section, SettingRow, Slider, Toggle } from '../../components/ui/Controls'
import { CustomSelect } from '../../components/ui/CustomSelect'
import { desktop } from '../../services/desktop'
import { useAthena } from '../../store/athenaStore'
import { allocationNotice, contextProfiles, resolveLocalContext } from '../../../shared/contextEngine'
import { localChatCompatibility, localContextCeiling, localOutputCeiling, type LocalAIPreset, type LocalPullProgress, type LocalStatus, type LocalAISettings, type LocalInferenceSettings } from '../../../shared/localAI'
import { applyResponsePreset, generationLimitFor, generationLimitLabel } from '../../../shared/localResponse'
import { resolveLlamaWindow } from '../../../shared/llamaLongContext'

const size = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GB`
export function LocalAISettings() {
  const { snapshot, update } = useAthena()
  const settings = snapshot?.settings
  const [status, setStatus] = useState<LocalStatus | null>(null)
  const [endpoint, setEndpoint] = useState('')
  const [speechPath, setSpeechPath] = useState('')
  const [download, setDownload] = useState('')
  const [progress, setProgress] = useState<LocalPullProgress | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  useEffect(() => { if (settings) { setEndpoint(settings.localAI.endpoint); setSpeechPath(settings.localAI.speechModelPath) } }, [settings?.localAI.endpoint, settings?.localAI.speechModelPath])
  useEffect(() => {
    let live = true
    const off = desktop.onLocalProgress((event) => { if (live) { setProgress(event); if (event.done) void desktop.getLocalStatus().then((result) => { if (live) setStatus(result) }).catch(() => {}) } })
    void desktop.getLocalStatus().then((result) => { if (live) setStatus(result) }).catch(() => {})
    return () => { live = false; off() }
  }, [settings?.localAI.endpoint])
  const local = settings?.localAI
  const selected = status?.models.find((model) => model.name === local?.model)
  const trainedContext = selected?.contextLength
  const modelContextLimit = selected?.provider === 'mlx' ? Math.min(localContextCeiling, trainedContext ?? 32768) : localContextCeiling
  const outputLimit = selected?.provider === 'mlx' ? 8192 : localOutputCeiling
  const modelSupportsThinking = Boolean(selected?.capabilities.includes('thinking'))
  const supportsExtraHigh = Boolean(selected?.capabilities.some((capability) => /xhigh/i.test(capability)))
  const generationLimit = selected ? generationLimitFor(selected) : { tokens: null, source: 'unreported' as const }
  const clampInference = (value: LocalInferenceSettings): LocalInferenceSettings => {
    const contextLength = Math.max(2048, Math.min(modelContextLimit, value.contextLength))
    const outputCap = Math.min(outputLimit, generationLimit.tokens ?? outputLimit, contextLength)
    return { ...value, reasoning: modelSupportsThinking ? value.reasoning : 'auto', contextLength, maxOutputTokens: Math.max(256, Math.min(outputCap, value.maxOutputTokens)) }
  }
  useEffect(() => {
    if (!selected || !local) return
    const contextLength = Math.max(2048, Math.min(modelContextLimit, local.contextLength))
    if (contextLength !== local.contextLength) void update({ localAI: { ...local, contextLength, customInference: { ...local.customInference, contextLength } } })
    // A model refresh can lower the context ceiling. Response presets stay untouched.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.name, selected?.contextLength, modelContextLimit])
  if (!settings || !local) return null
  const change = (patch: Partial<LocalAISettings>) => void update({ localAI: { ...local, ...patch } })
  const refresh = async () => { setBusy(true); try { setStatus(await desktop.getLocalStatus()); setNotice('Model list refreshed.') } catch { setNotice('Could not refresh local model status.') } finally { setBusy(false) } }
  const memoryWarning = selected && selected.size > (status?.totalMemoryBytes ?? Infinity) * 0.7
  const appliedReasoning = !modelSupportsThinking ? 'auto' : local.reasoning === 'xhigh' && !selected?.capabilities.some((capability) => /xhigh/i.test(capability)) ? 'high' : local.reasoning
  const presetDetails: Array<{ id: LocalAIPreset; label: string; description: string; disabled?: boolean }> = [
    { id: 'fast', label: 'Fast', description: 'Shorter replies for quick conversations.' },
    { id: 'balanced', label: 'Balanced', description: 'Everyday replies for general tasks.' },
    { id: 'coding', label: 'Coding', description: 'Lower temperature and a longer code reply.' },
    { id: 'deep-reasoning', label: 'Deep Reasoning', description: modelSupportsThinking ? (supportsExtraHigh ? 'Low temperature and the advertised Extra High effort.' : 'Low temperature and High, the highest advertised effort.') : 'Unavailable. This model does not advertise reasoning effort.', disabled: !modelSupportsThinking },
    { id: 'custom', label: 'Custom', description: 'Temperature, output length, and keep-alive you set.' },
  ]
  const changeInference = (patch: Partial<LocalInferenceSettings>) => {
    const next = clampInference({ reasoning: local.reasoning, contextLength: local.contextLength, maxOutputTokens: local.maxOutputTokens, temperature: local.temperature, keepAliveMinutes: local.keepAliveMinutes, autoUnload: local.autoUnload, ...patch })
    void update({ localAI: { ...local, ...next, preset: 'custom', customInference: next } })
  }
  const changeContext = (contextLength: number) => {
    const next = Math.max(2048, Math.min(modelContextLimit, contextLength))
    void update({ localAI: { ...local, contextLength: next, customInference: { ...local.customInference, contextLength: next } } })
  }
  const measuredAllocation = status?.contextAllocations?.find((allocation) => allocation.model === selected?.name)
  const contextDecision = selected && status ? resolveLocalContext({
    requestedTokens: local.contextLength, reportedContextTokens: selected.contextLength, rope: selected.ropeScaling,
    engine: selected.provider === 'mlx' ? 'mlx' : 'ollama', mlxAppliesYarn: false, architecture: selected.architecture, weightBytes: selected.size,
    totalMemoryBytes: status.totalMemoryBytes, freeMemoryBytes: status.freeMemoryBytes, confirmedTokens: measuredAllocation?.tokens,
  }) : null
  const allocatedTokens = contextDecision?.allocatedTokens ?? trainedContext ?? local.contextLength
  const outputCeiling = Math.max(256, Math.min(generationLimit.tokens ?? outputLimit, Math.max(256, allocatedTokens - 256)))
  const effectiveOutput = Math.max(256, Math.min(local.maxOutputTokens, outputCeiling))
  const promptUsage = status?.lastPromptUsage && status.lastPromptUsage.model === selected?.name ? status.lastPromptUsage : null
  const allocation = contextDecision ? allocationNotice(contextDecision) : null
  const runtimeName = (provider?: string) => provider === 'mlx' ? 'MLX' : provider === 'llama.cpp' ? 'llama.cpp' : 'Ollama'
  const usingLlama = selected?.provider === 'llama.cpp'
  const llamaWindow = usingLlama ? resolveLlamaWindow(local.contextLength, status?.llamaValidation ?? null) : null
  const passedTokens = new Set((status?.llamaValidation?.levels ?? []).filter((level) => level.passed).map((level) => level.requestedTokens))
  const applyPreset = (preset: LocalAIPreset) => {
    const current = preset === 'custom'
      ? { ...local.customInference, contextLength: local.contextLength }
      : { reasoning: local.reasoning, contextLength: local.contextLength, maxOutputTokens: local.maxOutputTokens, temperature: local.temperature, keepAliveMinutes: local.keepAliveMinutes, autoUnload: local.autoUnload }
    const result = applyResponsePreset({ preset, current, supportsThinking: modelSupportsThinking, supportsExtraHigh, generationTokens: generationLimit.tokens, allocatedTokens })
    if (!result.ok) { setNotice(result.reason); return }
    const next = clampInference(result.next)
    if (result.note) setNotice(result.note)
    void update({ localAI: { ...local, ...next, contextLength: local.contextLength, preset, customInference: preset === 'custom' ? next : local.customInference } })
  }
  const measureContext = async () => {
    if (!selected) return
    setBusy(true)
    try { const result = await desktop.probeLocalContext({ model: selected.name, tokens: local.contextLength }); setNotice(result.message); setStatus(await desktop.getLocalStatus()) }
    catch { setNotice('Context measurement failed. The installed model was not changed.') }
    finally { setBusy(false) }
  }
  const voiceOptions = (status?.macVoices ?? []).filter((voice) => voice.locale.startsWith('en_')).map((voice) => ({ value: voice.name, label: `${voice.name} · ${voice.locale.replace('_', '-')}` }))
  if (local.speechVoice && !voiceOptions.some((voice) => voice.value === local.speechVoice)) voiceOptions.unshift({ value: local.speechVoice, label: `${local.speechVoice} · saved` })
  const previewVoice = () => {
    const selectedVoice = speechSynthesis.getVoices().find((voice) => voice.name === local.speechVoice)
    if (!selectedVoice) { setNotice('This voice is installed for macOS speech, but its preview is unavailable in this window.'); return }
    speechSynthesis.cancel()
    const utterance = new SpeechSynthesisUtterance('Hey, I am Athena. What can I help you with?')
    utterance.voice = selectedVoice
    speechSynthesis.speak(utterance)
  }
  return <>
    <Section title="Local models" description="Use Ollama models or verified native MLX adapters on this Mac; large downloads only start when you request them.">
      <SettingRow title="Strict Offline Mode" description="Applies only to local Athena. Blocks local live search and page retrieval; online chat is independent."><Toggle label="Strict Offline Mode" checked={settings.strictOffline} onChange={(strictOffline) => void update({ strictOffline })} /></SettingRow>
      <SettingRow title="Local inference" description={status?.message ?? 'Checking local server…'}><span className={`ai-status ${status?.connected ? 'ai-active' : ''}`}>{status?.connected ? '● Connected' : '○ Unavailable'}</span></SettingRow>
      <div className="ai-key-field"><label htmlFor="ollama-endpoint">Local server endpoint</label><div className="voice-shortcut-setting"><input id="ollama-endpoint" value={endpoint} onChange={(event) => setEndpoint(event.target.value)} spellCheck={false} /><button className="button secondary" disabled={endpoint === local.endpoint} onClick={() => change({ endpoint })}>Save</button></div><p className="card-description">Only loopback HTTP endpoints (localhost or 127.0.0.1) are allowed.</p></div>
      <div className="ai-actions"><button className="button secondary" disabled={busy} onClick={() => void refresh()}>Test Connection / Refresh Models</button></div>
      <SettingRow title="Active companion model" description="Powers floating Athena only. Does not change the selected online provider."><CustomSelect ariaLabel="Active companion model" value={local.model ?? ''} options={[{ value: '', label: 'Select an installed local model' }, ...(local.model && !status?.models.some(model => model.name === local.model) ? [{ value: local.model, label: `${local.model} · ${status?.connected ? 'not currently installed' : 'availability unknown'}`, disabled: true }] : []), ...(status?.models ?? []).map(model => ({ value: model.name, label: `${model.label ?? model.name} · ${runtimeName(model.provider)}${localChatCompatibility(model) === 'unsupported' ? ' · no chat support' : localChatCompatibility(model) === 'unknown' ? ' · capability unknown' : ''}`, disabled: localChatCompatibility(model) === 'unsupported' }))]} onChange={model => change({ model: model || null })} /></SettingRow>
      {status?.connected && local.model && !selected && <p className="chat-message-note" role="status">The saved companion model is not installed in this Ollama instance. Install it or choose another local model; Athena will not switch to an online provider.</p>}
      {selected && localChatCompatibility(selected) === 'unsupported' && <p className="chat-message-note" role="status">{selected.name} does not advertise chat completion. Select a chat-capable model for Floating Athena.</p>}
      <p className="chat-message-note">Ollama’s advertised capabilities may not guarantee reliable structured tool calls. GPT-OSS 20B passed Athena’s local tool-call check on this Mac; test other models before using them for file changes.</p>
      <SettingRow title="Local vision model" description="Used for authorized screenshots and image attachments when the conversation model lacks vision."><CustomSelect ariaLabel="Local vision model" value={local.visionModel ?? ''} options={[{ value: '', label: 'None' }, ...(local.visionModel && !status?.models.some((model) => model.name === local.visionModel && model.capabilities.includes('vision')) ? [{ value: local.visionModel, label: `${local.visionModel} · vision not verified`, disabled: true }] : []), ...(status?.models.filter((model) => model.capabilities.includes('vision')) ?? []).map((model) => ({ value: model.name, label: model.name }))]} onChange={(visionModel) => change({ visionModel: visionModel || null })} /></SettingRow>
      {memoryWarning && <p className="chat-message-note" role="status">This model is large for this Mac’s {size(status?.totalMemoryBytes ?? 0)} of memory. It may load slowly or fail under memory pressure.</p>}
      <div className="ai-key-field"><label htmlFor="ollama-download">Download a model</label><div className="voice-shortcut-setting"><input id="ollama-download" value={download} onChange={(event) => setDownload(event.target.value)} placeholder="e.g. gpt-oss:20b" spellCheck={false} /><button className="button secondary" disabled={!download.trim() || Boolean(progress && !progress.done)} onClick={async () => { try { const result = await desktop.pullLocalModel({ model: download.trim() }); setNotice(result.message); if (result.ok) setProgress({ model: download.trim(), status: 'Starting download' }) } catch { setNotice('Download could not start. Check the model name and Ollama connection.') } }}>Download</button>{progress && !progress.done && <button className="button secondary" onClick={() => void desktop.cancelLocalPull()}>Cancel</button>}</div><p className="card-description">A one-time Ollama download uses the internet, even in Strict Offline Mode. You will be asked to confirm before it starts.</p>{progress && <p className="card-description" role="status">{progress.model}: {progress.status}{progress.total ? ` · ${Math.round((progress.completed ?? 0) / progress.total * 100)}%` : ''}</p>}</div>
      {(status?.models ?? []).map((model) => <SettingRow key={model.name} title={`${model.label ?? model.name} · ${runtimeName(model.provider)}`} description={`${size(model.size)} · ${model.family ? `${model.family} · ` : ''}${model.contextLength ? `${model.contextLength.toLocaleString()} trained context · ` : ''}${model.capabilities.join(', ') || 'Capabilities not reported'}`}><span className="ai-status">{localChatCompatibility(model) === 'supported' ? 'Chat ready' : localChatCompatibility(model) === 'unsupported' ? 'No chat completion' : 'Chat support unverified'}</span><button className="button secondary" disabled={model.provider === 'mlx' || model.provider === 'llama.cpp' || model.name === local.model || model.name === local.visionModel} onClick={async () => { if (!window.confirm(`Remove ${model.name} from Ollama? The model can be downloaded again later.`)) return; try { const result = await desktop.deleteLocalModel({ model: model.name }); setNotice(result.message); if (result.ok) await refresh() } catch { setNotice('Model removal failed.') } }}>Remove</button></SettingRow>)}
      {status?.mlxDiagnostics?.map(item => <div className="ac-inset" key={item.id}><strong>{item.label} · Native MLX</strong><p>Status: {item.status} · Peak memory: {item.memoryGB?.toFixed(2) ?? 'not measured'} GB</p><p>Base checkpoint: {item.baseCheckpoint}</p><p>Adapter: {item.adapterCheckpoint}</p>{item.error && <p role="alert">{item.error}</p>}</div>)}
      {status && <p className="chat-message-note">Hardware: {status.arch === 'arm64' ? 'Apple Silicon' : status.arch} · {size(status.totalMemoryBytes)} installed memory. Ollama manages its GPU acceleration; native MLX uses Apple Metal.</p>}
      {notice && <p className="chat-message-note" role="status">{notice}</p>}
    </Section>
    <Section title="Response Behavior" description="Choose how your local model prioritizes speed, general performance, coding, or reasoning.">
      <div className="local-ai-presets" role="group" aria-label="Response behavior presets">
        {presetDetails.map((preset) => <button key={preset.id} type="button" className={`local-ai-preset ${local.preset === preset.id ? 'is-selected' : ''}`} aria-pressed={local.preset === preset.id} disabled={preset.disabled} onClick={() => applyPreset(preset.id)}><span className="local-ai-preset-label">{preset.label}</span><span className="local-ai-preset-description">{preset.description}</span></button>)}
      </div>
      <p className="local-ai-applied-note" role="status">{local.preset === 'deep-reasoning' && !modelSupportsThinking ? 'Deep Reasoning is selected, but this model does not advertise a reasoning-effort control. Athena is not sending one.' : local.preset === 'custom' ? 'Custom response settings are active. Context capacity is unchanged.' : `${presetDetails.find((preset) => preset.id === local.preset)?.label ?? 'Balanced'} response settings are active. Context capacity is unchanged.`} {modelSupportsThinking && local.reasoning === 'xhigh' && appliedReasoning !== 'xhigh' ? 'This model does not advertise Extra High, so Athena sends High.' : ''}</p>
      {modelSupportsThinking && <SettingRow title="Reasoning effort" description={`Applied value: ${appliedReasoning === 'xhigh' ? 'Extra High (xhigh)' : appliedReasoning[0].toUpperCase() + appliedReasoning.slice(1)}.`}><CustomSelect ariaLabel="Local reasoning effort" value={appliedReasoning} options={['auto', 'low', 'medium', 'high', 'xhigh'].map((value) => ({ value, label: value === 'xhigh' ? 'Extra High (xhigh)' : value[0].toUpperCase() + value.slice(1), disabled: value === 'xhigh' && !supportsExtraHigh }))} onChange={(reasoning) => changeInference({ reasoning: reasoning as LocalAISettings['reasoning'] })} /></SettingRow>}
      <Slider label="Maximum output tokens" value={effectiveOutput} min={256} max={outputCeiling} step={256} onChange={(maxOutputTokens) => changeInference({ maxOutputTokens })} ends={['256', generationLimit.tokens ? 'Generation limit' : 'Allocated context']} />
      {generationLimit.tokens && local.maxOutputTokens > generationLimit.tokens && <p className="chat-message-note" role="status">Saved output is {local.maxOutputTokens.toLocaleString('en-US')} tokens. Runtime generation uses {generationLimit.tokens.toLocaleString('en-US')}. {generationLimitLabel(generationLimit)}</p>}
      <Slider label="Temperature" value={local.temperature} min={0} max={2} step={0.05} onChange={(temperature) => changeInference({ temperature })} ends={['Precise', 'Creative']} />
      {selected?.provider === 'mlx' ? <p className="card-description">Native MLX releases model memory after each response. Each request loads the verified checkpoint and adapter.</p> : usingLlama ? <p className="card-description">llama.cpp stays loaded for the selected validated window until you quit Athena or choose another validated window. Keep-alive applies to the original Ollama model.</p> : <><Slider label="Keep model loaded" value={local.keepAliveMinutes} min={0} max={120} step={1} unit=" min" onChange={(keepAliveMinutes) => changeInference({ keepAliveMinutes })} ends={['Unload now', '2 hours']} />
      <SettingRow title="Automatically unload idle model" description="Releases model memory after the keep-alive period."><Toggle label="Automatically unload idle model" checked={local.autoUnload} onChange={(autoUnload) => changeInference({ autoUnload })} /></SettingRow></>}
    </Section>
    <Section title="Context Capacity" description="These profiles set the context window. They do not change response behavior.">
      <div className="local-ai-presets" role="group" aria-label="Context capacity profiles">
        {contextProfiles.map((profile) => {
          const available = usingLlama ? passedTokens.has(profile.tokens) : profile.id === 'standard'
          return <button key={profile.id} type="button" className={`local-ai-preset ${local.contextLength === profile.tokens ? 'is-selected' : ''}`} aria-pressed={local.contextLength === profile.tokens} disabled={!available} onClick={() => changeContext(profile.tokens)}><span className="local-ai-preset-label">{profile.label}</span><span className="local-ai-preset-description">{profile.tokens.toLocaleString('en-US')} tokens · {available ? (usingLlama ? 'retrieval passed' : 'trained window') : 'unavailable'}</span></button>
        })}
      </div>
      <Slider label="Context length" value={Math.min(local.contextLength, modelContextLimit)} min={2048} max={modelContextLimit} step={1024} onChange={changeContext} ends={['2K tokens', selected?.provider === 'mlx' ? 'Model limit' : '250K']} />
      {usingLlama && llamaWindow && <div className={llamaWindow.available ? 'ac-inset' : 'local-ai-allocation-alert'} role={llamaWindow.available ? 'status' : 'alert'}>
        <strong>Status: {llamaWindow.available ? 'Validated window is active' : 'Profile unavailable'}</strong>
        <p>Selected inference engine: llama.cpp {status?.llamaValidation?.runtime.version ?? ''}</p>
        <p>Selected model: {selected?.label ?? selected?.name}</p>
        <p>Configured context: {local.contextLength.toLocaleString('en-US')}</p>
        <p>Validated maximum context: {llamaWindow.validatedMaximum.toLocaleString('en-US')}</p>
        <p>Active allocated context: {llamaWindow.allocated ? llamaWindow.allocated.toLocaleString('en-US') : 'None'}</p>
        {!llamaWindow.available && <>
          <p>Why allocation failed: This profile has not passed a llama.cpp load and a start, middle, and end retrieval test.</p>
          <p>Missing capability: A passing retrieval result at this length. Loading the model is not enough.</p>
          <p>Inference engine: llama.cpp</p>
          <p>Active context profile: {llamaWindow.allocated ? `${llamaWindow.allocated.toLocaleString('en-US')} validated tokens` : 'No validated window'}</p>
        </>}
        {status?.llamaValidation?.levels.map((level) => <p key={level.id}>Benchmark {level.id}: {level.passed ? 'passed' : 'not passed'}{level.promptTokens ? ` · ${level.promptTokens.toLocaleString('en-US')} prompt tokens` : ''}{level.retrieval ? ` · start ${level.retrieval.start ? 'yes' : 'no'}, middle ${level.retrieval.middle ? 'yes' : 'no'}, end ${level.retrieval.end ? 'yes' : 'no'}` : ''}{level.error ? ` · ${level.error}` : ''}</p>)}
      </div>}
      {!usingLlama && contextDecision && allocation && <div className={allocation.prominent ? 'local-ai-allocation-alert' : 'ac-inset'} role={allocation.prominent ? 'alert' : 'status'}>
        <strong>Status: {allocation.status}</strong>
        <p>Selected inference engine: {selected?.provider === 'mlx' ? 'MLX' : 'Ollama'}</p>
        <p>Selected model: {selected?.label ?? selected?.name ?? 'None'}</p>
        <p>Validated maximum context: {trainedContext ? `${trainedContext.toLocaleString('en-US')} trained tokens` : 'Not reported'}</p>
        <p>Configured context: {contextDecision.requestedTokens.toLocaleString('en-US')}</p>
        <p>Runtime allocated context: {contextDecision.allocatedTokens.toLocaleString('en-US')}</p>
        {allocation.prominent && <>
          <p>Why allocation failed: {allocation.why}</p>
          <p>Missing capability: {allocation.missingCapability}</p>
          <p>Inference engine: {allocation.engine}</p>
          <p>Active context profile: {allocation.activeProfile}</p>
        </>}
        <p>{contextDecision.explanation}</p>
      </div>}
      <div className="local-ai-usage" role="status">
        <p>Actual input tokens: {promptUsage ? `${promptUsage.promptTokens.toLocaleString('en-US')} measured by the inference engine` : 'No measured reply yet'}</p>
        <p>System prompt tokens: {promptUsage?.systemTokens != null ? `${promptUsage.systemTokens.toLocaleString('en-US')} measured by the GGUF tokenizer` : 'Not measured'}</p>
        <p>Conversation history tokens: {promptUsage?.historyTokens != null ? `${promptUsage.historyTokens.toLocaleString('en-US')} measured by the GGUF tokenizer` : 'Not measured'}</p>
        <p>Reserved maximum output tokens: {(promptUsage?.reservedOutputTokens ?? effectiveOutput).toLocaleString('en-US')}</p>
        <p>Remaining available context: {promptUsage ? Math.max(0, promptUsage.contextWindow - promptUsage.promptTokens - promptUsage.reservedOutputTokens).toLocaleString('en-US') : 'Not measured until a reply reports input tokens'}</p>
        <p>Actual generated output tokens: {promptUsage ? `${promptUsage.outputTokens.toLocaleString('en-US')} measured by the inference engine` : 'No measured reply yet'}</p>
      </div>
      <div className="local-ai-measure">
        <button className="button secondary" disabled={!selected || usingLlama || !allocation?.measureAllowed || busy} onClick={() => void measureContext()}>Measure allocation</button>
        <p>{usingLlama ? 'This model uses the llama.cpp benchmark above. The button does not load an unvalidated window.' : allocation?.measureReason ?? 'Select a model to measure its trained context window.'}</p>
        {measuredAllocation && <p>Last trained-window check: {measuredAllocation.promptTokens.toLocaleString('en-US')} tokens in {(measuredAllocation.durationMs / 1000).toFixed(1)}s. That check is not a 128K or 250K retrieval test.</p>}
      </div>
      {selected && <div className="ac-inset">
        <p>Configurable reasoning effort: {modelSupportsThinking ? 'Advertised by this model' : 'Not advertised by this model'}</p>
        <p>RoPE scaling: {selected.ropeScaling ? `${selected.ropeScaling.type}${selected.ropeScaling.factor ? `, factor ${selected.ropeScaling.factor}` : ''}` : 'Not in the model card'}</p>
        <p>YaRN: {selected.ropeScaling?.type === 'yarn' ? `Advertised${selected.ropeScaling.factor ? `, factor ${selected.ropeScaling.factor}` : ''}` : 'Not in the model card'}</p>
        <p>KV-cache quantization: Not reported</p>
        <p>Flash Attention: Not reported</p>
        <p>Maximum supported output tokens: {generationLimitLabel(generationLimit)}</p>
        <p>Maximum validated context: {trainedContext ? `${trainedContext.toLocaleString('en-US')} tokens reported by the model card` : 'Not reported'}. Longer profiles are not validated.</p>
      </div>}
      {status?.longContextNote && <p className="local-ai-engine-note">{status.longContextNote}</p>}
      {status?.engineFindings?.map((finding) => <div className="local-ai-engine" key={finding.engine}><strong>{finding.engine}</strong><p>{finding.presence} {finding.chat}</p><p>YaRN: {finding.yarn}</p></div>)}
    </Section>
    <Section title="Local voice" description="Offline speech recognition needs whisper.cpp's whisper-cli and a model file installed on this Mac. Spoken replies use macOS built-in voices.">
      <SettingRow title="Offline voice availability" description={status?.whisperInstalled ? 'whisper.cpp CLI detected. Configure a local model file below.' : 'whisper.cpp CLI not found in standard Homebrew locations. Install it before using offline transcription.'}><span className={`ai-status ${status?.macSpeechAvailable ? 'ai-active' : ''}`}>{status?.macSpeechAvailable ? '● macOS speech ready' : '○ macOS speech unavailable'}</span></SettingRow>
      <SettingRow title="Speech recognition" description="whisper-cli runs locally; no audio is sent to OpenAI."><CustomSelect ariaLabel="Local speech recognition engine" value={local.speechEngine} options={[{ value: 'whisper-cli', label: 'whisper.cpp CLI' }, { value: 'unavailable', label: 'Disabled' }]} onChange={(speechEngine) => change({ speechEngine: speechEngine as LocalAISettings['speechEngine'] })} /></SettingRow>
      <div className="ai-key-field"><label htmlFor="whisper-model">Whisper model file</label><div className="voice-shortcut-setting"><input id="whisper-model" value={speechPath} onChange={(event) => setSpeechPath(event.target.value)} placeholder="/absolute/path/to/ggml-base.en.bin" spellCheck={false} /><button className="button secondary" disabled={speechPath === local.speechModelPath} onClick={() => change({ speechModelPath: speechPath })}>Save</button></div></div>
      <SettingRow title="macOS voice" description="Choose an installed English voice. Karen is the new default; your saved choice stays until you change it."><div className="voice-shortcut-setting"><CustomSelect ariaLabel="macOS voice" value={local.speechVoice} options={voiceOptions} onChange={(speechVoice) => change({ speechVoice })} /><button className="button secondary" onClick={previewVoice}>Preview</button></div></SettingRow>
    </Section>
  </>
}
