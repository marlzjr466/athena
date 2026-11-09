export type ProjectCollapseState = Record<string, boolean>

const storageKey = (scope: 'online' | 'local') => `athena.conversation-projects.${scope}.v1`

export function readProjectCollapseState(scope: 'online' | 'local'): ProjectCollapseState {
  if (typeof window === 'undefined') return {}
  try {
    const raw = window.localStorage.getItem(storageKey(scope))
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return Object.fromEntries(Object.entries(parsed).filter(([, value]) => typeof value === 'boolean'))
  } catch { return {} }
}

export function writeProjectCollapseState(scope: 'online' | 'local', state: ProjectCollapseState): void {
  if (typeof window === 'undefined') return
  try { window.localStorage.setItem(storageKey(scope), JSON.stringify(state)) } catch { /* storage may be unavailable */ }
}
