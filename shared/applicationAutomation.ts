import { z } from 'zod'

export const applicationAutomationSchema = z.object({
  engine: z.enum(['openai', 'native', 'codex']).default('codex'),
  fallback: z.boolean().default(true),
  environment: z.enum(['local', 'self_hosted']).default('local'),
  model: z.enum(['gpt-6.2-sol', 'gpt-6-astra']).default('gpt-6.2-sol'),
  persist: z.boolean().default(true),
  monthlyRequests: z.number().int().min(0).max(5000).default(60),
  monthlyEstimateUSD: z.number().min(0).max(10000).nullable().default(null),
  maxSteps: z.number().int().min(1).max(16).default(8),
}).strict()
export const applicationAutomationDefaults = applicationAutomationSchema.parse({})
export type ApplicationAutomationConfig = z.infer<typeof applicationAutomationSchema>
export const automationControlSchema = z.union([
  z.enum(['status', 'activity', 'test', 'prepare-environment']),
  z.object({ action: z.enum(['pause', 'resume', 'stop']), taskId: z.string().min(1).max(128) }).strict(),
])
export type AutomationControl = z.infer<typeof automationControlSchema>
export interface AutomationEngineStatus {
  credential: boolean
  requests: number
  estimatedUSD: number
  unreported: number
  codex?: { connected: boolean; model: string; available: boolean; version: string | null }
  task?: { id: string; engine: 'OpenAI' | 'Athena Native' | 'Codex'; model?:string; action: string; application?: string; started: number; steps: number; paused: boolean; requests?:number }
  environment?: { session: string; id: string; remote: string; connected: boolean }
}

export interface BrowserSearchRequest {
  query:string
  newTab:boolean
  browser?:'chrome'|'edge'|'firefox'|'safari'
  destination?:string
}

const spokenWebsites:Record<string,string>={
  youtube:'www.youtube.com',google:'www.google.com',bing:'www.bing.com',wikipedia:'www.wikipedia.org',duckduckgo:'duckduckgo.com',
}

function spokenWebsite(label:string):string|undefined {
  const named=spokenWebsites[label.trim().toLowerCase()]
  if(named && typeof named==='string')return 'https://'+named+'/'
  const source=label.trim()
  // DNS and redirect checks still run at execution. Here only an explicitly
  // spoken web hostname/path can authorize navigation. Never guess a domain.
  if(!/^(?:https:\/\/)?(?:[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?\.)+[a-z]{2,63}(?:\/[a-z\d/_~.-]*)?$/i.test(source))return
  const href=/^https:\/\//i.test(source)?source:'https://'+source
  if(!URL.canParse(href))return
  const url=new URL(href)
  if(/\.(?:local|localhost|internal|lan|home|invalid|test|onion)$/i.test(url.hostname) || /(?:^|\/)\.{1,2}(?:\/|$)/.test(source))return
  return url.href
}

const searchClauseSeparator='(?:\\s*[,;.!]\\s*(?:(?:and then|and|then)\\s+)?|\\s+(?:and then|and|then)\\s+)'
const browserNamePattern='(?:(?:google )?chrome|(?:microsoft )?edge|(?:mozilla )?firefox|safari)'

function browserCommandText(text:string):string {
  if(text.length>3000 || /[\u0000-\u001f\u007f]/.test(text))return ''
  let request=text.trim().replace(/\s+/g,' ').replace(/[.!?]+$/,'').trim()
  const preamble=/^(?:(?:hey[, ]+)?athena|ok(?:ay)?|all ?right|yeah|yes|sure|oh|um+|uh+|well|actually|just|please|thanks?|thank you|(?:i )?(?:got it|see it|understand)(?: now)?|(?:it['’]s|it is) (?:already )?open(?: now)?|(?:can|could|would|will) you|i (?:want|need|would like) you to)(?:[,.! ]+|$)/i
  while(preamble.test(request))request=request.replace(preamble,'')
  return request
}

function browserName(value:string):BrowserSearchRequest['browser'] {
  return /(chrome|edge|firefox|safari)$/i.exec(value)?.[1].toLowerCase() as BrowserSearchRequest['browser']
}

/** Return only the explicitly named browser. Consumers must parse the entire
 * remainder themselves before authorizing any navigation or input. */
export function splitBrowserActivationPrefix(text:string):{browser:NonNullable<BrowserSearchRequest['browser']>;remainder:string}|undefined {
  const request=browserCommandText(text)
  const prefix=new RegExp('^(?:open|focus|use|activate|switch to|go to) (?:my |the )?(?:current |existing )?('+browserNamePattern+')(?: browser| window)?'+searchClauseSeparator,'i').exec(request)
  const browser=prefix && browserName(prefix[1])
  if(browser && prefix)return {browser,remainder:request.slice(prefix[0].length)}
}

export interface BrowserTabRequest {
  browser?:BrowserSearchRequest['browser']
  query?:string
  destination?:string
}

/** A named website can authorize its exact URL. A tab title alone authorizes
 * selection only. The executor must resolve a unique, currently observed tab. */
export function parseBrowserTabRequest(text:string):BrowserTabRequest|undefined {
  let request=browserCommandText(text)
  const activation=splitBrowserActivationPrefix(request)
  if(activation)request=activation.remainder
  // A corrected browser name is common in a live transcript, e.g. “in my
  // current uh browser, Chrome browser”. Match it only as a terminal qualifier.
  const qualifier=new RegExp('(?:,? (?:in|on|using) )(?:(?:my|the|current|existing|active|uh|um) )*(?:browser(?:,? +|$))?(?:('+browserNamePattern+')(?: browser)?)?$','i').exec(request)
  const named=qualifier?.[1] && browserName(qualifier[1])
  if(activation && named && activation.browser!==named)return
  const browser=named||activation?.browser
  if(qualifier){
    if(!named && !/\bbrowser$/i.test(qualifier[0]))return
    request=request.slice(0,qualifier.index)
  }
  const tab=/^(?:switch to|select|focus|open|go to) (?:my |the )?(?:(.+?) (?:browser )?tab|tab (?:named|called) (.+))$/iu.exec(request)
  if(tab){
    const query=(tab[1]??tab[2]).replace(/^(?:“([^”]+)”|"([^"]+)")$/u,'$1$2')
    if(!query || query.length>120 || !/^[\p{L}\p{N}][\p{L}\p{N} _.'’&+()–—-]*$/u.test(query)
      || /^(?:new|other|another|current|existing|active|next|previous|last|any|every|all)(?: |$)/i.test(query)
      || /\b(?:and|then|or|except|instead|never|not|unless|don['’]t)\b/i.test(query))return
    return {query,...(browser?{browser}:{})}
  }
  const site=/^(?:open|visit|go to|navigate to|switch to) (.+)$/i.exec(request)?.[1]
  const destination=site && spokenWebsite(site)
  if(destination)return {query:site,destination,...(browser?{browser}:{})}
}

/** Parse only affirmative, fully consumed browser-search instructions. Preamble
 * removal accepts named conversational phrases, never an arbitrary sentence. */
export function parseBrowserSearchRequest(text:string):BrowserSearchRequest|undefined {
  let request=browserCommandText(text)
  const activation=splitBrowserActivationPrefix(request)
  if(activation)request=activation.remainder
  const tab=new RegExp('^(?:open|create) (?:a |another )?new (?:('+browserNamePattern+') )?tab(?: (?:in|on) (?:my |the )?(?:existing |current )?('+browserNamePattern+')(?: browser)?)?'+searchClauseSeparator,'i').exec(request)
  let browser:BrowserSearchRequest['browser']=activation?.browser,destination:string|undefined
  if(tab){
    if(tab[1] && tab[2])return
    const named=browserName(tab[1]??tab[2]??'')
    if(browser && named && browser!==named)return
    browser=named??browser
    request=request.slice(tab[0].length)
  }
  const navigation=new RegExp('^(?:open|visit|navigate to|go to) (.{1,240}?)'+searchClauseSeparator+'(?=(?:search|find|look) )','i').exec(request)
  if(navigation){
    const target=parseBrowserTabRequest('open '+navigation[1])
    if(!target?.destination || browser && target.browser && target.browser!==browser)return
    destination=target.destination
    browser=target.browser??browser
    request=request.slice(navigation[0].length)
  }
  const action=/^(?:search|find|look up|look for) (.+)$/i.exec(request)
  if(!action)return
  let query=action[1],site:string|undefined
  const prefix=/^(?:(?:on|in) )?(.+?) for (.+)$/i.exec(query)
  if(prefix && /^(?:this|the current|the) (?:page|site|website|tab)$/i.test(prefix[1]))query=prefix[2]
  else if(prefix && (site=spokenWebsite(prefix[1])))query=prefix[2]
  else query=query.replace(/^for /i,'')
  const suffix=/^(.+?) (?:on|at) (.+)$/i.exec(query)
  if(suffix){
    const trailing=spokenWebsite(suffix[2])
    if(trailing){if(site && site!==trailing)return;site=trailing;query=suffix[1]}
    else if(/[.:/@\\]/.test(suffix[2]) || /^(?:localhost|my computer)$/i.test(suffix[2]))return
  }
  if(destination && site && destination!==site)return
  query=query.trim().replace(/^(?:"(.*)"|“(.*)”)$/u,'$1$2').trim()
  // A search containing another directive must go to the normal reviewed
  // route. "Rock and roll" remains one query. Never authorize a suffix action.
  if(!query || query.length>2000 || /[;"“”]/u.test(query)
    || /^for$/i.test(query) || /\b(?:and then|then)\b/i.test(query)
    || /^(?:(?:my|the|our|local) )?(?:files|code|projects|conversations|repository|repositories|folders)\b/i.test(query)
    || /\b(?:do not|don['’]t|never mind|instead|unless|but (?:not|don['’]t)|without (?:opening|searching|sending))\b/i.test(request)
    || /(?:[.!?,]\s*|\b(?:and(?: then)?|then|also)\s+)(?:(?:please|just)\s+)?(?:open|close|send|post|click|search|go|play|pause|type|submit|share|visit|navigate|delete|pay|download|upload|switch|look up|find|read|stop|don['’]t|do not)\b/i.test(query))return
  return {query,newTab:!!tab,...(browser?{browser}:{}),...(destination||site?{destination:destination??site}:{})}
}

export function isPageSearchRequest(text:string):boolean {
  return !!parseBrowserSearchRequest(text)
}

export function computerInstruction(text: string): boolean {
  const request = text.trim().replace(/^(?:(?:hey\s+)?athena[, ]+)?(?:please\s+)?/i, '')
  if(isPageSearchRequest(text) || /^(?:what (?:can you see|do you see|is) (?:on )?(?:my|the|this) screen|describe (?:my|the|this|current) (?:screen|window))[?!. ]*$/i.test(request))return true
  if (/^(?:explain|describe|how (?:do|to|would)|write (?:a |the )?(?:script|test|function|program)|show me how)\b/i.test(request)) return false
  if (/^(?:use (?:the |my )?computer to|automate\b|resume (?:my |the )?(?:last )?automation\b)/i.test(request)) return true
  return /^(?:open|launch|switch|focus|visit|navigate|go to|click|press|scroll|type|enter|select|inspect|minimize|maximize|restore|move|drag|close|double.click|check|look at|play|pause|create)\b/i.test(request)
    && /\b(?:app|application|window|screen|browser|tab|button|control|menu|field|desktop|chrome|safari|edge|firefox|finder|explorer|calculator|textedit|notepad|spotify|slack|discord|word|excel|visual studio code|youtube|chat|conversation|second result|current project)\b/i.test(request)
}
