import { useEffect, useState } from 'react'
import { Section, SettingRow, Toggle } from '../../components/ui/Controls'
import { CustomSelect } from '../../components/ui/CustomSelect'
import { desktop } from '../../services/desktop'
import { useAthena } from '../../store/athenaStore'
import type { WebSearchStatus } from '../../../shared/webAccess'

export function WebToolsSettings({ openAIConnectionVersion }: { openAIConnectionVersion?: number | null }) {
  const { snapshot, update } = useAthena()
  const [status, setStatus] = useState<WebSearchStatus | null>(null)
  const [key, setKey] = useState('')
  const [timezoneDraft, setTimezoneDraft] = useState('local')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [searchModel, setSearchModel] = useState('')
  const settings = snapshot?.settings
  const web = settings?.webAccess
  useEffect(() => { if (web) setTimezoneDraft(web.timezone) }, [web?.timezone])
  useEffect(() => {
    let live = true
    void desktop.getWebSearchStatus().then((value) => { if (live) setStatus(value) }).catch(() => { if (live) setNotice('Could not read search-provider status.') })
    return () => { live = false }
  }, [web?.searchProvider, web?.webSearchEnabled, web?.openAIModel, settings?.aiMode, openAIConnectionVersion])
  useEffect(() => { setSearchModel(web?.openAIModel ?? status?.model ?? '') }, [web?.openAIModel, status?.model])
  if (!settings || !web) return null
  const change = (patch: Partial<typeof web>) => void update({ webAccess: { ...web, ...patch } })
  const runTest = async () => {
    setBusy(true); setNotice('Testing search connection…')
    try {
      const latest = web.searchProvider === 'openai-built-in' ? await desktop.getWebSearchStatus() : null
      if (latest) setStatus(latest)
      const selectedModel = searchModel || latest?.model || null
      const result = await desktop.testWebSearch(web.searchProvider === 'openai-built-in'
        ? (selectedModel ? { model: selectedModel } : undefined)
        : key.trim() ? { apiKey: key.trim() } : undefined)
      setNotice(result.ok ? `${result.message}${result.resultCount === undefined ? '' : ` (${result.resultCount} live result${result.resultCount === 1 ? '' : 's'} returned).`}` : result.message)
      if (result.ok) setStatus(await desktop.getWebSearchStatus())
    } catch { setNotice('Could not test the search connection.') }
    finally { setBusy(false) }
  }
  const saveKey = async () => {
    setBusy(true); setNotice('Checking and saving the key…')
    try {
      const checked = await desktop.testWebSearch({ apiKey: key.trim() })
      if (!checked.ok) { setNotice(checked.message); return }
      await desktop.saveWebSearchKey({ apiKey: key.trim() })
      setKey(''); setStatus(await desktop.getWebSearchStatus()); setNotice('Brave Search is connected. The key is stored in macOS Keychain.')
    } catch { setNotice('Could not securely save the search key. Unlock macOS Keychain and try again.') }
    finally { setBusy(false) }
  }
  const removeKey = async () => {
    setBusy(true)
    try { const result = await desktop.removeWebSearchKey(); setNotice(result.message); setStatus(await desktop.getWebSearchStatus()) }
    catch { setNotice('Could not remove the saved search key.') }
    finally { setBusy(false) }
  }
  const providerMessage = web.searchProvider === 'brave'
    ? 'Brave Search API uses a separate provider account/key and may be billable. This is separate from Athena’s LLM provider and is never used in Strict Offline Mode.'
    : 'OpenAI Responses web_search may be used for non-local conversations and can incur separate API charges. Local Floating Athena never routes search through OpenAI; select Brave Search for local web search. Athena never silently switches search providers.'
  const selectOpenAIModel = async (model: string) => {
    setBusy(true); setSearchModel(model); setNotice('Saving search model…')
    try {
      await update({ webAccess: { ...web, openAIModel: model || null } })
      if (useAthena.getState().snapshot?.settings.webAccess.openAIModel !== (model || null)) {
        setSearchModel(web.openAIModel ?? status?.model ?? '')
        setNotice('Could not save the search model. Check the settings error and choose it again.')
        return
      }
      setStatus(await desktop.getWebSearchStatus()); setNotice('')
    } catch { setNotice('Could not refresh the search model. Reopen Tools & Web Access and try again.') }
    finally { setBusy(false) }
  }
  return <Section title="Tools & Web Access" description="Configure clock and optional public web access used by authorized conversations. Local Athena also obeys Strict Offline Mode in My Athena.">
    <SettingRow title="Local system information" description="Allow the trusted Electron process to provide the actual Mac date, time, IANA timezone, UTC offset, and uptime. This remains local and works offline."><Toggle label="Enable local system information tools" checked={web.systemInformationEnabled} onChange={(systemInformationEnabled) => change({ systemInformationEnabled })} /></SettingRow>
    <SettingRow title="Local timezone" description="Use “local” to follow macOS, or enter an IANA timezone such as Asia/Tokyo. Invalid zones are rejected when used."><div className="voice-shortcut-setting"><input className="shortcut-input" aria-label="System information timezone" value={timezoneDraft} maxLength={100} onChange={(event) => setTimezoneDraft(event.target.value)} /><button className="button secondary" disabled={timezoneDraft === web.timezone} onClick={() => change({ timezone: timezoneDraft.trim() || 'local' })}>Save</button></div></SettingRow>
    <SettingRow title="Time format" description="Controls how local clock tool results are formatted."><CustomSelect ariaLabel="Clock display format" value={web.timeFormat} options={[{ value: '12h', label: '12-hour' }, { value: '24h', label: '24-hour' }]} onChange={(timeFormat) => change({ timeFormat: timeFormat as '12h' | '24h' })} /></SettingRow>
    <SettingRow title="Internet access" description="Allow Floating Athena and Athena Chat to search the public web and read public pages when requested. Model reasoning stays on your selected local model. Pages are treated as untrusted data; Athena does not use browser cookies or private endpoints."><Toggle label="Enable internet access" checked={web.webSearchEnabled} onChange={(webSearchEnabled) => change({ webSearchEnabled })} /></SettingRow>
    <SettingRow title="Search provider" description={providerMessage}><CustomSelect ariaLabel="Web search provider" value={web.searchProvider} options={[{ value: 'brave', label: 'Brave Search API' }, { value: 'openai-built-in', label: 'OpenAI Responses web search' }]} onChange={(searchProvider) => change({ searchProvider: searchProvider as 'brave' | 'openai-built-in' })} /></SettingRow>
    <SettingRow title="Automatic current-information search" description="When enabled, Athena searches for questions about current or changing facts. Otherwise, search only when you explicitly ask."><Toggle label="Search automatically for current information" checked={web.automaticSearch} disabled={!web.webSearchEnabled} onChange={(automaticSearch) => change({ automaticSearch })} /></SettingRow>
    <SettingRow title="Maximum search results" description={web.searchProvider === 'brave' ? 'Bound the number of results returned to the agent.' : 'Brave-specific. OpenAI built-in search controls its own result selection.'}><CustomSelect ariaLabel="Maximum web search results" value={String(web.maxResults)} disabled={!web.webSearchEnabled || web.searchProvider !== 'brave'} options={[3, 5, 8, 10].map((count) => ({ value: String(count), label: String(count) }))} onChange={(value) => change({ maxResults: Number(value) })} /></SettingRow>
    <SettingRow title="External request timeout" description={web.searchProvider === 'brave' ? 'Brave and page requests are cancelled when this time limit expires.' : 'Applies to page extraction; OpenAI built-in search follows its Responses request timeout.'}><CustomSelect ariaLabel="External search timeout" value={String(web.timeoutSeconds)} disabled={!web.webSearchEnabled} options={[5, 10, 15, 20, 30].map((seconds) => ({ value: String(seconds), label: `${seconds} seconds` }))} onChange={(value) => change({ timeoutSeconds: Number(value) })} /></SettingRow>
    {web.searchProvider === 'openai-built-in' && <>
      <SettingRow title="OpenAI search timeout" description="Chat searches can take longer than the short connection test. Athena cancels a search after this limit; the general external timeout still applies to page extraction."><CustomSelect ariaLabel="OpenAI search timeout" value={String(web.openAIResponseTimeoutSeconds)} disabled={!web.webSearchEnabled} options={[25, 45, 60, 90].map((seconds) => ({ value: String(seconds), label: `${seconds} seconds` }))} onChange={(value) => change({ openAIResponseTimeoutSeconds: Number(value) })} /></SettingRow>
      <SettingRow title="OpenAI API connection" description={status?.note ?? 'The OpenAI API key remains in macOS Keychain. This connection is independent of the provider that writes the chat response.'}><span className={`ai-status ${status?.validated ? 'ai-active' : ''}`}>{status?.validated ? '● Search verified' : status?.hasKey ? '○ Not verified' : '○ API key required'}</span></SettingRow>
      <SettingRow title="OpenAI search model" description="Choose from models available to this API key. Listing a model does not prove web-search support; Test Search Connection verifies it. This selection never changes your chat provider or conversation model."><CustomSelect ariaLabel="OpenAI search model" value={searchModel} disabled={busy || !status?.hasKey || !status.availableModels?.length} options={[{ value: '', label: 'Select a search model' }, ...(searchModel && !status?.availableModels?.includes(searchModel) ? [{ value: searchModel, label: `${searchModel} · unavailable`, disabled: true }] : []), ...(status?.availableModels ?? []).map(model => ({ value: model, label: model }))]} onChange={model => void selectOpenAIModel(model)} /></SettingRow>
      <div className="ai-actions"><button className="button secondary" disabled={busy} onClick={() => void runTest()}>Test Search Connection</button></div>
    </>}
    {web.searchProvider === 'brave' && <>
      <SettingRow title="Brave connection" description={status?.note ?? 'Search credentials are held by the Electron main process and stored in Keychain.'}><span className={`ai-status ${status?.hasKey ? 'ai-active' : ''}`}>{status?.hasKey ? '● Key saved' : '○ Not configured'}</span></SettingRow>
      <div className="ai-key-field"><label htmlFor="brave-search-key">Brave Search API key</label><input id="brave-search-key" type="password" autoComplete="off" spellCheck={false} autoCapitalize="none" maxLength={512} placeholder={status?.hasKey ? 'Saved in macOS Keychain' : 'Enter Brave Search API key'} value={key} disabled={busy} onChange={(event) => setKey(event.target.value)} /><p className="card-description">Only sent to api.search.brave.com for searches you request. The saved key is never returned to this screen, chat, logs, or the renderer after saving.</p></div>
      <div className="ai-actions"><button className="button secondary" disabled={busy || (!key.trim() && !status?.hasKey)} onClick={() => void runTest()}>Test Search Connection</button>{key.trim() && <button className="button primary" disabled={busy} onClick={() => void saveKey()}>Test & Save Key</button>}{status?.hasKey && <button className="button secondary" disabled={busy} onClick={() => void removeKey()}>Remove Key</button>}</div>
    </>}
    {notice && <p className="chat-message-note" role="status" aria-live="polite">{notice}</p>}
  </Section>
}
