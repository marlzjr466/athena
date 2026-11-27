import type { ChatSnapshot } from '../../../shared/chat'
import { APPLICATIONS } from '../../../shared/desktopActions'

export type VoiceActionStep = { name: string; input: Record<string, unknown> | ((previous: Record<string, unknown>) => Record<string, unknown>) }
export type VoiceActionPlan = { kind: string; steps: VoiceActionStep[] }
const commandText = (text: string) => text.trim().replace(/^(?:hey[, ]+)?athena[,! ]*/i, '').replace(/^(?:(?:can|could|would) you |please |I (?:want|need) you to )+/i, '').replace(/[.!?]+$/, '').replace(/,? please$/i, '').trim()
const one = (name: string, input: Record<string, unknown> = {}): VoiceActionPlan => ({ kind: name, steps: [{ name, input }] })
const application = (name: string) => Object.entries(APPLICATIONS).find(([id, value]) => [id, value.name.toLowerCase(), id === 'vscode' ? 'vs code' : ''].includes(name.toLowerCase()))?.[0]
const observedDesktopAction = (app: string, name: string, input: Record<string, unknown>): VoiceActionPlan => ({ kind: name, steps: [
  { name: 'athena_desktop_inspect_accessible_ui', input: { app } }, { name, input: { app, ...input } },
] })
const sessionInput = (previous: Record<string, unknown>) => ({ sessionId: String(previous.sessionId ?? '') })
const withoutWake = (request: string) => request.trim().replace(/^(?:hey[, ]+)?athena[,! ]*/i, '')
function dictatedConversation(request: string) {
  const text = withoutWake(request)
  const active = /^(?:please )?(send|submit|draft|type|replace)(?: (?:a |the |my )?(?:message|draft))? (?:asking (?:it|Athena) to |saying |with |in (?:the |my )?active chat[:,] *|: *)([\s\S]+)$/i.exec(text)
  if (active) return [active[0], active[1], 'active chat', active[2]]
  // Speech recognition need not emit quotation marks or a colon. "Saying"
  // establishes a clear boundary; active/current is also an unambiguous target.
  return /^(?:please )?(send|submit|draft|type|put) (?:this |a message )?(?:to|in|into) (?:my |the )?(.+?(?:chat|conversation|session))\s*(?::\s*|,?\s+saying\s+)([\s\S]+)$/i.exec(text)
    ?? /^(?:please )?(send|submit|draft|type|put) (?:this |a message )?(?:to|in|into) (?:my |the )?((?:active|current) (?:chat|conversation|session))[, ]+([\s\S]+)$/i.exec(text)
}

/** Parse explicit commands before asking the local model. No external content is an input here. */
export function resolveVoiceActionPlan(request: string, snapshot: ChatSnapshot | Pick<ChatSnapshot,'sessionId'|'sessions'>): VoiceActionPlan | undefined {
  const text = commandText(request).replace(/\bGoogle Chrome\b/gi,'Chrome').replace(/\bMicrosoft Edge\b/gi,'Edge').replace(/\bMozilla Firefox\b/gi,'Firefox')
  // Dictated content is opaque: never split it into automation instructions.
  const send = dictatedConversation(request)
  if (send && /(?:chat|conversation|session)$/i.test(send[2])) {
    const query = send[2].replace(/\s*(?:chat|conversation|session)$/i, '').trim() || 'active'
    const steps: VoiceActionStep[] = [
      { name: 'athena_chat_resolve_session', input: { query } },
      ...(query === 'active' || query === 'current' ? [] : [{ name: 'athena_chat_open_session', input: sessionInput }]),
      { name: 'athena_chat_set_composer_text', input: previous => ({ ...sessionInput(previous), text: send[3].trim() }) },
    ]
    if (/send|submit/i.test(send[1])) steps.push({ name: 'athena_chat_send_message', input: sessionInput })
    return { kind: 'dictated-conversation-message', steps }
  }
  if (!/["“”]|\b(?:send|submit|type|enter)\b/i.test(text) && /\s+(?:and then|then)\s+/i.test(text)) {
    const parts = text.split(/\s+(?:and then|then)\s+/i)
    if (parts.length > 8) return undefined
    const plans = parts.map(part => resolveVoiceActionPlan(part, snapshot))
    if (plans.every((plan): plan is VoiceActionPlan => !!plan)) return { kind: 'multi-step-voice-command', steps: plans.flatMap(plan => plan.steps) }
  }
  if (/^(?:what(?:'s| is)|read|show|check) (?:my |the )?(?:current )?task status$/i.test(text)) return one('athena_chat_task_status')
  if (/^(?:what did you (?:just do|do last)|what was (?:your|the) (?:last|previous) (?:automation )?action)$/i.test(text)) return one('athena_last_action')
  if (/^(?:is there (?:an? )?(?:unsent (?:message|draft)|draft)|do I have (?:an? )?(?:unsent (?:message|draft)|draft))(?: in (?:the |this |my )?(?:current |active )?(?:chat|conversation|composer))?$/i.test(text)) return one('athena_chat_target')
  if (/^(?:list|show|find) (?:my |existing )?(?:conversations|chats|sessions)(?: (?:called|named|matching) (.+))?$/i.test(text)) return one('athena_chat_find_sessions', { query: /(?:called|named|matching) (.+)$/i.exec(text)?.[1] ?? '' })
  const about = /^(?:open|find|switch to) (?:my |the )?(?:previous |existing )?(?:chat|conversation|session) (?:about|called|named) (.+)$/i.exec(text)
  if (about) return { kind: 'open-conversation', steps: [{ name: 'athena_chat_resolve_session', input: { query: about[1] } }, { name: 'athena_chat_open_session', input: sessionInput }] }
  if (/^(?:please )?(?:read|repeat) (?:me )?(?:the |my )?(?:latest|last) (?:assistant )?(?:response|reply|answer)(?: to me| aloud)?$/i.test(text)) return one('athena_chat_read_response')
  if (/^(?:send|submit) (?:this|the|my) (?:draft|drafted message)$/i.test(text) && snapshot.sessionId) return one('athena_chat_send_message', { sessionId: snapshot.sessionId })
  if (/^(?:what|which|show|identify).{0,20}\b(?:model|project)\b.{0,35}(?:selected|active|using|current|open)\b|^(?:show|identify) (?:my |the )?current (?:model|project)$/i.test(text)) return one('athena_chat_target')
  if (/^(?:list|show) (?:the )?(?:chats|conversations) (?:in|for) (?:this|my current|the active) project$/i.test(text)) return one('athena_project_conversations')
  const effort = /^(?:use|set|change) (?:the )?(?:reasoning (?:effort )?(?:to )?)?(low|medium|high|xhigh|max|minimal|none|auto)(?: reasoning(?: effort)?)?$/i.exec(text)
  if (effort && snapshot.sessionId) return one('athena_chat_change_effort', { sessionId: snapshot.sessionId, effort: effort[1].toLowerCase() })
  const accountModel=/^(?:select|use|switch to) (?:the )?(?:model )?(.+?) (?:on|through|using) (.+?)(?: with (low|medium|high|xhigh|max|minimal|none|auto) reasoning)?$/i.exec(text)
  if (accountModel && snapshot.sessionId) return one('athena_chat_choose_model',{sessionId:snapshot.sessionId, model:accountModel[1],provider:accountModel[2],...(accountModel[3]?{effort:accountModel[3].toLowerCase()}:{})})
  const model = /^(?:use|switch to|select) (?:the )?(?:model )?(.+?) with (low|medium|high|xhigh|max|minimal|none|auto) reasoning(?: effort)?$/i.exec(text)
  if (model && snapshot.sessionId) return one('athena_chat_choose_model', { sessionId: snapshot.sessionId, model: model[1], effort: model[2].toLowerCase() })
  const explicitModel = /^(?:use|switch to|select) (?:the )?model (.+)$/i.exec(text)
  if (explicitModel && snapshot.sessionId) return one('athena_chat_choose_model', { sessionId: snapshot.sessionId, model: explicitModel[1] })
  if (/^hide (?:the |my )?(?:main (?:Athena )?window|Athena)$/i.test(text)) return one('athena_navigate', {page:'hide'})
  if(/^(?:what|which) (?:Athena |settings )?page (?:am I on|is (?:currently )?open)\b/i.test(text))return one('athena_navigation_location')
  const direction = /^(?:go |navigate )?(back|forward) (?:in|inside) Athena$/i.exec(text)
  if (direction) return one('athena_navigate', {page:direction[1].toLowerCase()})
  if (/^(?:open|show) (?:my |the )?(?:projects|project management|conversations|conversation management)$/i.test(text)) return one('athena_navigate', {page:'online-chat'})
  if (/^(?:summarize|recap) (?:my |this |the )?(?:current |active )?(?:chat|conversation|session)$/i.test(text)) return one('athena_chat_recap')
  const page = /^(?:open|show|go to) (?:the |my )?(voice|privacy|appearance|general|ai|shortcuts|notifications) settings$/i.exec(text)?.[1]?.toLowerCase()
  if (page) return one('athena_navigate', {page: page === 'ai' ? 'ai-settings' : page === 'general' ? 'settings' : page})
  if (/^(?:open|show) (?:the )?(?:main (?:Athena )?window|Athena|home screen)$/i.test(text)) return one('athena_navigate', {page:'companion'})
  const openChat = /^(?:please )?(?:open|switch to|go back to|return to|show) (?:my |the )?(.+?) (?:conversation|chat|session)$/i.exec(text)
  if (openChat && !/\bnew\b/i.test(openChat[1])) return { kind: 'open-conversation', steps: [{ name: 'athena_chat_resolve_session', input: { query: openChat[1] } }, { name: 'athena_chat_open_session', input: sessionInput }] }
  const rename = /^(?:rename|call) (?:this|the current|my active) (?:chat|conversation|session) (?:to|as) (.+)$/i.exec(text)
  if (rename && snapshot.sessionId) return one('athena_chat_rename_session', { sessionId: snapshot.sessionId, title: rename[1] })
  if (/^(?:please )?(?:stop|cancel)(?: (?:the |my )?(?:current )?(?:task|automation))?$/i.test(text)) return one('athena_chat_stop_generation')
  if (/^(?:create|start|open) (?:a )?new (?:normal |non-project )?(?:chat|conversation|session)$/i.test(text)) return one('athena_chat_create_session')
  if (/^(?:list|show) (?:my )?(?:recent )?projects$/i.test(text)) return one('athena_project_list')
  if (/^(?:open|select|choose) (?:another|a new|a|new) project(?: (?:directory|folder))?$/i.test(text)) return one('athena_project_choose')
  const createProject = /^(?:create|make) (?:a )?(?:new )?project (?:folder |directory )?(?:named |called )(.+)$/i.exec(text)
  if (createProject) return one('athena_project_create', { name: createProject[1] })
  if (/^(?:open|show|reveal) (?:this|the active|my current) project(?: folder)? in (?:VS\s*Code|Visual Studio Code)$/i.test(text)) return one('athena_project_open_editor')
  if (/^(?:open|show|reveal) (?:this|the active|my current) project(?: folder)? in (?:Finder|(?:Windows )?Explorer)$/i.test(text)) return one('athena_project_reveal')
  const editorProject = /^(?:open|launch) (?:VS\s*Code|Visual Studio Code) and open (?:my |the )?(.+?) project$/i.exec(text)
  if (editorProject) return {kind:'open-project-in-editor',steps:[{name:'athena_project_open',input:{query:editorProject[1]}},{name:'athena_project_open_editor',input:{}}]}
  const openProject = /^(?:open|switch to|use) (?:my |the )?(.+?)(?: project)?$/i.exec(text)
  if (openProject && (/(?: project)$/i.test(text) || snapshot.sessions?.some(session => session.project?.name.toLowerCase() === openProject[1].toLowerCase()))) return one('athena_project_open', { query: snapshot.sessions?.some(session => session.project?.name.toLowerCase() === text.replace(/^(?:open|switch to|use) (?:my |the )?/i, '').toLowerCase()) ? text.replace(/^(?:open|switch to|use) (?:my |the )?/i, '') : openProject[1] })
  if (/^(?:what (?:branch am I on|is (?:my |the )?(?:current )?branch)|(?:show|report|check|get) (?:my |the )?(?:current branch|git status|working.tree changes|project changes))$/i.test(text)) return one('athena_git_status')
  const branches = /^(?:list|show|search|find) (?:my |the )?(?:local )?(?:git )?branches(?: (?:matching|called|named|containing) (.+))?$/i.exec(text)
  if (branches) return one('athena_git_branches', { query: branches[1] ?? '' })
  const createBranch = /^(?:create|make)(?: and switch to)? (?:a )?(?:new )?branch (?:named |called )?(.+)$/i.exec(text)
  if (createBranch) return one('athena_git_create', { branch: createBranch[1] })
  if (/^(?:open|show) (?:the |my )?(?:integrated )?terminal(?: panel)?(?: in (?:VS Code|Visual Studio Code|Cursor))?$/i.test(text))
    return one('athena_editor_show_terminal', {})
  const browserName = /\b(chrome|edge|safari|firefox)\b/i.exec(text)?.[1].toLowerCase()
  const browserHint = browserName ? { browser: browserName } : {}
  const addressFor = (name: string) => /^youtube$/i.test(name) ? 'https://www.youtube.com/' : /^google$/i.test(name) ? 'https://www.google.com/' : name
  const newSurface = /^(?:open|create|add)(?: up)? (?:a |another |one )?(?:new )?(?:(?:chrome|safari|firefox|edge|browser) )?(tab|window)(?: (?:in|on|of) (?:my |the |this )?(?:(?:current|existing|running|active) )?(?:(?:chrome|edge|safari|firefox|browser)(?: browser)? ?)?(?:window)?)?(?: (?:to|at|for) (https?:\/\/\S+|YouTube|Google))?$/i.exec(text)
  if (newSurface) return one('athena_browser_action', {action:'window', operation: newSurface[1].toLowerCase()==='tab'?'new-tab':'new-window', ...browserHint, ...(newSurface[2]?{url:addressFor(newSurface[2])}:{})})
  const windowSelection=/^(?:use|select|switch to) (?:my |the )?(current|active|existing|other) (?:(.+?) )?window$/i.exec(text)
  if(windowSelection){
    const other=windowSelection[1].toLowerCase()==='other',name=windowSelection[2]
    if(other || !browserName && name?.toLowerCase()!=='browser')
      return one('athena_desktop_select_window',{selection:other?'other':'current',...(name?{name}:{})})
  }
  if (/^(?:use|select|switch to) (?:the |this |my )?(?:existing|current|active) (?:browser |chrome |safari |edge |firefox )?(?:window|tab)$/i.test(text))
    return one('athena_browser_action', {action:'window',operation:'current',...browserHint})
  const displayWindow=/^(?:use|select|switch to) (?:the )?(?:(.+?) )?window on (?:my |the )?other (?:display|monitor|screen)$/i.exec(text)
  if(displayWindow && !browserName && displayWindow[1]?.toLowerCase()!=='browser')return one('athena_desktop_select_window',{selection:'other-display',...(displayWindow[1]?{name:displayWindow[1]}:{})})
  if (/^(?:use|select|switch to) (?:the )?(?:(?:chrome|safari|edge|firefox|browser) )?window on (?:my |the )?other (?:display|monitor|screen)$/i.test(text))
    return one('athena_browser_action',{action:'window',operation:'other-display',...browserHint})
  const inWindow = /^(?:open|visit|go to|navigate to) (https?:\/\/\S+|YouTube|Google) in (?:a |the |my |this )?(new|current|active|existing|running)? ?(?:(?:chrome|safari|edge|firefox|browser) ?)?(?:tab|window|browser)?$/i.exec(text)
  if (inWindow) return one('athena_browser_action',{action:'window',operation:inWindow[2]?.toLowerCase()==='new'?'new-tab':'navigate',url:addressFor(inWindow[1]),...browserHint})
  const namedBrowser=/^(?:open|focus|launch|switch to) (?:the |my )?(?:current |existing )?(chrome|safari|edge|firefox)(?: browser| window)?$/i.exec(text)
  if(namedBrowser)return one('athena_desktop_open_application',{app:namedBrowser[1].toLowerCase()})
  const namedApp=/^(?:switch to|focus|launch|open) (?:the )?(.+)$/i.exec(text)
  if(namedApp && application(namedApp[1])) return one('athena_desktop_open_application',{app:application(namedApp[1])!})
  const switchBranch = /^(?:switch|change|checkout)(?: (?:branches?|branch))? (?:to )?(?:branch )?([\w][\w./-]*)$/i.exec(text)
  if (switchBranch) return one('athena_git_switch', { branch: switchBranch[1] })
  if (/^(?:list|show) (?:my |the )?running (?:apps|applications)$/i.test(text)) return one('athena_desktop_running_apps')
  if (/^(?:inspect|read|show|check) (?:the |my )?active (?:window|application|app)$/i.test(text)) return one('athena_desktop_inspect_active')
  const targetWindow = /^(minimize|maximize|restore|move|close) (?:the )?(.+?)(?: window)?(?: to (-?\d+)[, ]+(-?\d+))?$/i.exec(text)
  if (targetWindow && application(targetWindow[2])) return observedDesktopAction(application(targetWindow[2])!,'athena_desktop_window',{operation:targetWindow[1].toLowerCase(),...(targetWindow[3]?{x:Number(targetWindow[3]),y:Number(targetWindow[4])}:{})})
  const inspectApp = /^(?:inspect|read|show|check) (.+?)(?: controls| window)?$/i.exec(text)
  const app = inspectApp && application(inspectApp[1])
  if (app) return one('athena_desktop_inspect_accessible_ui', { app })
  const desktopClick = /^(?:click|press|select|activate) ["“]?([^"”]+?)["”]? (?:in|on) (.+)$/i.exec(text)
  if (desktopClick && application(desktopClick[2])) return observedDesktopAction(application(desktopClick[2])!, 'athena_desktop_click_accessible_element', { label: desktopClick[1] })
  const desktopType = /^(?:type|enter) ["“]([^"”]*)["”] (?:into|in) ["“]([^"”]+)["”] (?:in|on) (.+)$/i.exec(text)
  if (desktopType && application(desktopType[3])) return observedDesktopAction(application(desktopType[3])!, 'athena_desktop_set_accessible_text', { label: desktopType[2], text: desktopType[1] })
  const desktopShortcut = /^press (copy|paste|select.all|save|undo|redo|enter|escape|tab) in (.+)$/i.exec(text)
  if (desktopShortcut && application(desktopShortcut[2])) return observedDesktopAction(application(desktopShortcut[2])!, 'athena_desktop_press_shortcut', { shortcut: desktopShortcut[1].toLowerCase().replace(' ', '-') })
  const dictatedField = /^type (.+?) into (.+?) in (.+)$/i.exec(text)
  if (dictatedField && application(dictatedField[3])) return observedDesktopAction(application(dictatedField[3])!,'athena_desktop_set_accessible_text',{text:dictatedField[1],label:dictatedField[2]})
  if (/^(?:click|press) (?:that|the selected) button(?: on (?:the |this )?page)?$/i.test(text)) return one('athena_browser_action',{action:'click-observed'})
  if (/^(?:select|switch to|open) (?:my |the )?other (?:browser )?tab$/i.test(text)) return one('athena_browser_action',{action:'other-tab'})
  const browserClick = /^click ["“]([^"”]+)["”] (?:on|in) (?:the |this )?(?:page|website|browser)$/i.exec(text)
  if (browserClick) return one('athena_browser_action', { action: 'click', label: browserClick[1] })
  const browserType = /^(?:type|enter) ["“]([^"”]*)["”] (?:into|in) ["“]([^"”]+)["”] (?:on|in) (?:the |this )?(?:page|website|browser)$/i.exec(text)
  if (browserType) return one('athena_browser_action', { action: 'type', text: browserType[1], label: browserType[2] })
  const transfer=/^(upload|download) (?:a |the )?file (?:from|to|using) ["“]?([^"”]+?)["”]?(?: on (?:the |this )?page)?$/i.exec(text)
  if(transfer)return {kind:'browser-file-transfer',steps:[{name:'athena_browser_action',input:{action:'inspect'}},{name:'athena_browser_action',input:{action:transfer[1].toLowerCase(),label:transfer[2]}}]}
  const choose=/^(?:choose|select) ["“]([^"”]+)["”] (?:in|from) ["“]([^"”]+)["”](?: on (?:the |this )?page)?$/i.exec(text)
  if(choose)return {kind:'browser-select',steps:[{name:'athena_browser_action',input:{action:'inspect'}},{name:'athena_browser_action',input:{action:'choose',label:choose[2],option:choose[1]}}]}
  if (/^(?:read|summarize) (?:this|the|my) (?:web ?page|page|article)(?: aloud| to me)?$/i.test(text)) return one('athena_browser_action', {action:'read'})
  const browserScroll = /^scroll (?:the |this )?(?:page |website |browser )?(up|down)(?: a little)?(?: (?:on|in) (?:the |this )?(?:page|website|browser))?$/i.exec(text)
  if (browserScroll) return one('athena_browser_action', { action: 'scroll', direction: browserScroll[1].toLowerCase() })
  if (/^(?:what(?:'s| is)|read|show) (?:the )?active (?:page|tab)(?: title)?$/i.test(text)) return one('athena_browser_action', { action: 'inspect' })
  if (/^(?:list|find|show) (?:my |the )?(?:browser )?tabs$/i.test(text)) return one('athena_browser_action', { action: 'tabs' })
  const tab = /^(?:switch to|select|open) (?:my |the )?(.+?) tab$/i.exec(text)
  if (tab) return one('athena_browser_action', { action: 'select', query: tab[1] })
  if (/^(?:go |navigate )?(back|forward)$/i.test(text)) return one('athena_browser_action', { action: /back/i.test(text) ? 'back' : 'forward' })
  const site = /^(?:open|visit|go to) (YouTube|Google)(?: in (?:the |my )?(?:Athena |authorized )?browser)?$/i.exec(text)
  if (site) return one('athena_browser_action', { action: 'open', url: /youtube/i.test(site[1]) ? 'https://www.youtube.com/' : 'https://www.google.com/' })
  const search = /^(?:(?:open )?(Google|YouTube)(?: and search) for|search (Google|YouTube) for|find (?:a )?video (?:about|called)) (.+)$/i.exec(text)
  if (search) return one('athena_browser_action', { action: 'open', url: /google/i.test(search[1] ?? search[2] ?? '') ? `https://www.google.com/search?q=${encodeURIComponent(search[3])}` : `https://www.youtube.com/results?search_query=${encodeURIComponent(search[3])}` })
  if (/^(?:pause|resume|play)(?: (?:the |this )?(?:video|YouTube|it|playback))?$/i.test(text)) return one('athena_browser_action', { action: 'media', operation: /^pause/i.test(text) ? 'pause' : 'play' })
  if (/^(?:play|open) (?:the )?first video$/i.test(text)) return one('athena_browser_action', { action: 'first-video' })
  const numbered = /^(?:play|open|click) (?:the )?(first|second|third|fourth|fifth|\d+)(?:st|nd|rd|th)? (?:video|result)$/i.exec(text)
  if (numbered) return one('athena_browser_action', { action: 'video-result', index: ['first','second','third','fourth','fifth'].indexOf(numbered[1].toLowerCase()) + 1 || Number(numbered[1]) })
  if (/^close (?:the |this |current )*(?:browser )?tab$/i.test(text)) return one('athena_browser_action', {action:'close-tab'})
  const address = /^(?:open|visit|navigate to) (https?:\/\/\S+)$/i.exec(text)
  if (address) return one('athena_browser_action', { action:'open', url:address[1] })
  const seek = /^(?:skip|seek|go) (forward|backward|back)(?: (\d+) seconds?)?$/i.exec(text)
  if (seek) return one('athena_browser_action', { action: 'media', operation: 'seek', value: Math.min(120, Number(seek[2] ?? 10)) * (/forward/i.test(seek[1]) ? 1 : -1) })
  if (/^(?:lower|raise|increase|decrease|mute) (?:the |YouTube )?volume$/i.test(text)) return one('athena_browser_action', { action: 'media', operation: 'volume', value: /^mute/i.test(text) ? 0 : /lower|decrease/i.test(text) ? -0.1 : 0.1 })
  if (/^(?:enable|enter|exit|leave) fullscreen$/i.test(text)) return one('athena_browser_action', { action: 'media', operation: /exit|leave/i.test(text) ? 'exit-fullscreen' : 'fullscreen' })
  const installedSteps=(name:string,action:string,input:Record<string,unknown>):VoiceActionPlan=>({kind:'installed-control',steps:[
    {name:'athena_installed_inspect',input:{name}},{name:'athena_installed_'+action,input:{name,...input}}]})
  const otherField=/^(?:type|enter) ["“]([^"”]+)["”] (?:in|into) ["“]([^"”]+)["”] in (?:the )?(?:app(?:lication)? )?(.+)$/i.exec(text)
  if(otherField)return installedSteps(otherField[3],'set_text',{label:otherField[2],text:otherField[1]})
  const otherScroll=/^scroll ["“]([^"”]+)["”] (up|down) in (?:the )?(?:app(?:lication)? )?(.+)$/i.exec(text)
  if(otherScroll)return installedSteps(otherScroll[3],'scroll',{label:otherScroll[1],direction:otherScroll[2].toLowerCase()})
  if(targetWindow && !application(targetWindow[2]) && (/^(restore|minimize|maximize)$/i.test(targetWindow[1]) || targetWindow[1].toLowerCase()==='close' && / window$/i.test(text)))
    return installedSteps(targetWindow[2].replace(/^(?:app|application) /i,''),'window',{operation:targetWindow[1].toLowerCase()})
  if(desktopShortcut && !application(desktopShortcut[2]))return installedSteps(desktopShortcut[2].replace(/^(?:app|application) /i,''),'shortcut',{shortcut:desktopShortcut[1].toLowerCase().replace(' ','-')})
  const installedClick=/^(?:click|press) ["“]?([^"”]+?)["”]? in (?:the |my )?(?:installed )?(?:application|app) (.+)$/i.exec(text)
  if (installedClick) return {kind:'installed-control',steps:[
    {name:'athena_installed_inspect',input:{name:installedClick[2]}},
    {name:'athena_installed_click',input:{name:installedClick[2],label:installedClick[1]}},
  ]}
  const installed=/^(open|launch|inspect) (?:the )?(?:installed )?(?:application|app) (.+)$/i.exec(text)
  if (installed) return one('athena_installed_'+(installed[1].toLowerCase()==='inspect'?'inspect':'open'),{name:installed[2]})
  return undefined
}

export function contextualControl(request:string){
  const text=commandText(request)
  if(/^(?:click|press) (?:that|the selected) (?:button|control)$/i.test(text))return {operation:'click' as const}
  const click=/^(?:click|press) ["“]([^"”]+)["”]$/i.exec(text)
  if(click)return {operation:'click' as const,label:click[1]}
  const direction=/^scroll (up|down)(?: a little)?$/i.exec(text)
  if(direction)return {operation:'scroll' as const,direction:direction[1].toLowerCase()}
  const field=/^(?:type|enter) ["“]([^"”]+)["”] (?:into|in) ["“]([^"”]+)["”]$/i.exec(text)
  if(field)return {operation:'type' as const,label:field[2],text:field[1]}
}
export function installedVoicePlan(request:string,authorized:readonly string[]):VoiceActionPlan|undefined {
  const text=commandText(request)
  const click=/^(?:click|press) ["“]?([^"”]+?)["”]? (?:in|on) (.+)$/i.exec(text)
  const open=/^(open|launch|focus|switch to|inspect) (.+)$/i.exec(text)
  const name=authorized.find(n=>n.toLowerCase()===(click?.[2]??open?.[2])?.toLowerCase())
  if(!name)return
  if(click)return {kind:'installed-control',steps:[{name:'athena_installed_inspect',input:{name}},{name:'athena_installed_click',input:{name,label:click[1]}}]}
  if(open)return one(open[1].toLowerCase()==='inspect'?'athena_installed_inspect':'athena_installed_open',{name})
}

export function matchesDictatedText(request: string, candidate: string): boolean {
  if (!candidate || candidate !== candidate.trim()) return false
  if ([...request.matchAll(/“([^”]+)”|"([^\"]+)"|‘([^’]+)’|'([^']+)'/g)].some(match => (match[1] ?? match[2] ?? match[3] ?? match[4]) === candidate)) return true
  return dictatedConversation(request)?.[3].trim() === candidate
}
export function hasDictatedSubmitIntent(request: string): boolean { return /^(send|submit)$/i.test(dictatedConversation(request)?.[1] ?? '') }
