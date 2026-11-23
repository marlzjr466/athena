import { useEffect, useMemo, useRef, useState } from 'react'
import { Bot, Check, ChevronDown, Cloud, Code2, Github, Search, Sparkles, X } from 'lucide-react'
import { accountKey, type ModelSelection, type UnifiedAccountCatalog } from '../../../shared/unifiedAccounts'

interface Props { catalog: UnifiedAccountCatalog; value?: ModelSelection; disabled?: boolean; onChange(selection: ModelSelection): void }
export function UnifiedModelSelect({ catalog, value, disabled, onChange }: Props) {
  const [open, setOpen] = useState(false), [query, setQuery] = useState(''), [highlight, setHighlight] = useState(0)
  const search = useRef<HTMLInputElement>(null), root = useRef<HTMLDivElement>(null)
  const selected = catalog.accounts.flatMap(account => account.models.map(model => ({ account, model }))).find(item => value && accountKey(item.account.route, item.model.id) === accountKey(value, value.model) || value && item.account.route.provider === value.provider && item.account.route.accountId === value.accountId && (Object.values(item.model.effortModelIds ?? {}).includes(value.model) || Object.values(item.model.fastModelIds ?? {}).some(pair => pair.enabled === value.model || pair.disabled === value.model)))
  const groups = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    return catalog.accounts.map(account => {
      const matches = account.models.filter(model => {
        const haystack = [model.label, model.id, ...(model.aliases ?? []), account.name, account.plan ?? ''].join(' ').toLocaleLowerCase()
        return !needle || haystack.includes(needle)
      })
      return { account, models: matches.slice(0, 200), more: matches.length > 200 }
    }).filter(group => group.account.enabled && group.models.length)
  }, [catalog, query])
  const choices = groups.flatMap(group => group.models.filter(model => model.available).map(model => ({ ...group.account.route, model: model.id })))
  useEffect(() => { if (open) { search.current?.focus(); setHighlight(0) } else setQuery('') }, [open])
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => { if (root.current && !root.current.contains(event.target as Node)) setOpen(false) }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [open])
  const choose = (selection: ModelSelection) => { onChange(selection); setOpen(false) }
  const keyboard = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') { event.preventDefault(); setOpen(false) }
    if (event.key === 'ArrowDown') { event.preventDefault(); setHighlight(index => Math.min(choices.length - 1, index + 1)) }
    if (event.key === 'ArrowUp') { event.preventDefault(); setHighlight(index => Math.max(0, index - 1)) }
    if (event.key === 'Enter' && choices[highlight]) { event.preventDefault(); choose(choices[highlight]) }
  }
  return <div ref={root} className="unified-model-select" onKeyDown={keyboard}>
    <button type="button" className="unified-model-trigger" aria-label="Conversation model" aria-expanded={open} aria-haspopup="listbox" disabled={disabled} onClick={() => setOpen(value => !value)}>
      <span>{selected ? `${selected.model.label} · ${selected.account.name}${selected.account.enabled ? '' : ' · account disabled'}` : value ? 'Selected model unavailable' : 'Choose model'}</span><ChevronDown size={15} />
    </button>
    {open && <div className="unified-model-menu" role="listbox" aria-label="Models from connected accounts">
      <div className="unified-model-search"><Search size={15} /><input ref={search} aria-label="Search models" placeholder="Search models..." value={query} onChange={event => { setQuery(event.target.value); setHighlight(0) }} />{query && <button type="button" aria-label="Clear model search" onClick={() => { setQuery(''); search.current?.focus() }}><X size={14} /></button>}</div>
      <div className="unified-model-results">{groups.length ? groups.map(({ account, models, more }) => <div className="unified-model-group" key={accountKey(account.route, '')}>
        <div className="unified-model-heading">{account.route.provider === 'copilot' ? <Github size={14}/> : account.route.provider === 'cursor' ? <Code2 size={14}/> : account.route.provider === 'cloud' || account.route.provider === 'third-party' ? <Cloud size={14}/> : account.route.provider === 'antigravity' ? <Sparkles size={14}/> : <Bot size={14}/>}<span>{account.name}{account.plan ? ` (${account.plan})` : ''}</span><small>{account.state !== 'connected' ? account.state : ''}</small></div>
        {models.map(model => { const option = { ...account.route, model: model.id }, active = Boolean(value && value.provider === account.route.provider && value.accountId === account.route.accountId && (value.model === model.id || Object.values(model.effortModelIds ?? {}).includes(value.model) || Object.values(model.fastModelIds ?? {}).some(pair => pair.enabled === value.model || pair.disabled === value.model))), index = choices.findIndex(item => accountKey(item, item.model) === accountKey(option, option.model)); return <button key={model.id} type="button" role="option" aria-label={model.label} aria-selected={active} className={`unified-model-option ${index === highlight ? 'is-highlighted' : ''}`} disabled={!model.available} onMouseEnter={() => { if (index >= 0) setHighlight(index) }} onClick={() => choose(option)}><span><strong>{model.label}</strong></span>{active && <Check size={15} />}{!model.available && <small>Unavailable</small>}</button> })}
        {more && <p className="unified-model-more">Showing the first 200 models. Search to find more.</p>}
      </div>) : <p className="unified-model-empty">No models match your search.</p>}</div>
    </div>}
  </div>
}
