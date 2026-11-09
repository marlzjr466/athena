import { RefreshCw } from 'lucide-react'
import type { SlashCommandDefinition } from '../../../shared/slashCommands'

/** Shared command catalog presentation; provider availability is never inferred
 * from a Markdown filename by the UI. */
export function SlashCommandPicker({ entries, index, select, highlight, refresh, globals, globalEnabled }: {
  entries: SlashCommandDefinition[]; index: number; select(entry: SlashCommandDefinition): void
  highlight(index: number): void; refresh(): void; globals(): void; globalEnabled: boolean
}) {
  return <div className="chat-slash-menu" role="listbox" id="local-slash-list" aria-label="Local slash command suggestions">
    <div className="chat-slash-menu-heading"><span>Commands</span><button type="button" className="chat-action" aria-label="Refresh local commands" onClick={refresh}><RefreshCw size={13} /> Refresh</button></div>
    <div className="chat-slash-options">{entries.length ? entries.map((entry, i) => <div key={entry.id} id={`local-slash-option-${i}`} role="option" aria-selected={index === i} className={`chat-slash-option ${index === i ? 'selected' : ''}`} onMouseEnter={() => highlight(i)} onMouseDown={event => event.preventDefault()} onClick={() => select(entry)}>
      <span><strong>{entry.name}</strong><small>{entry.source} · {entry.compatibility === 'native-only' ? 'Native provider required' : entry.execution === 'built-in' ? 'Athena built-in' : 'Available through Athena tools'}</small>{entry.sourceFile && <small>{entry.sourceFile}</small>}{entry.skillPath && <small>Skill: {entry.skillPath}</small>}</span>
      <span className="chat-slash-description">{entry.description}{entry.argumentHint && <em> Arguments: {entry.argumentHint}</em>}</span>
    </div>) : <p className="chat-slash-empty">No matching commands in this project.</p>}</div>
    <button type="button" className="chat-slash-global" onClick={globals}>{globalEnabled ? 'Stop including global commands' : 'Include global Claude/Codex commands…'}</button>
  </div>
}
