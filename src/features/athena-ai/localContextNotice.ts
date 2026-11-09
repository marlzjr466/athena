const LEGACY_WEB_NOTICE = 'Web search is disabled in Settings → AI → Tools & Web Access. Local clock tools remain available.'
const LEGACY_SCREEN_NOTICE = 'Screen awareness requires a model with verified vision and function-calling support. No screen is captured with this model.'

/** Older local sessions may contain generic notices emitted before local/online isolation. */
export function localContextNotice(notice: string | undefined, lastUserMessage: string): string {
  if (!notice) return ''
  const screenRequested = /\b(?:screen|screenshot|desktop|display)\b/i.test(lastUserMessage)
  return notice
    .replace(LEGACY_WEB_NOTICE, '')
    .replace(screenRequested ? '' : LEGACY_SCREEN_NOTICE, '')
    .replace(/\s+/g, ' ')
    .trim()
}
