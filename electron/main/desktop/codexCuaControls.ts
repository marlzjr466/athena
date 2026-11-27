import { setTimeout as delay } from 'node:timers/promises'
import { APPLICATIONS } from '../../../shared/desktopActions'
import type { CodexBrowserTarget } from './codexComputerTools'
import { ChatError } from '../ai/AIProvider'
import type { CuaCall } from '../ai/codexCua'

type Target=Pick<CodexBrowserTarget,'app'|'pid'|'window'|'tab'|'url'> & {uniqueTitle?:string;uniqueWindowTitle?:string}
type Row={id:number;role:string;label:string;value?:string;url?:string;line:string}
type HistoryDirection='back'|'forward'
interface Frame {root:string; document?:string; focused?:string; rows:Row[]; history?:Partial<Record<HistoryDirection,number>>; headingLinks?:[number,number][]}
type Action={name:string;args:Record<string,unknown>}
export interface CuaControlContext {
  target:Target
  current():Promise<Target|undefined>
  call:CuaCall
  allowDestination?(url:string):Promise<void>
  resolveLink?(label:string):Promise<string|undefined>
  historyDestination?(direction:HistoryDirection):string|undefined
  confirm(detail:string):Promise<boolean>
  signal:AbortSignal
}
const roles='scroll bar|secure text field|search text field|search field|text field|text area|combo box|pop up button|radio button|check box|menu item|disclosure triangle|button|link|heading|slider|row|tab|cell|static text|text'
const rowPattern=new RegExp('^\\s*(\\d+) ('+roles+')\\b(?: \\(([^)]*)\\))? ?(.*)$','i')
const sensitive=/\b(?:buy|purchase|checkout|payment|subscribe|send|post|publish|delete|erase|remove|password|credential|login|log in|sign in|account|transfer|confirm|permission|token|allow access)\b/i
const editable=/^(?:search (?:text )?field|text field|text area|combo box)$/i
const readCode='await athenaApp.getAXState({emit:false,disableDiffing:true})'

// Only the native browser toolbar may supply history buttons. Page content can
// advertise identical accessible names and roles.
const historyControls=`const history={},parents=[],ambiguous=new Set();
for(const line of lines){
  const m=line.match(/^(\\s*)(\\d+) (.+)$/);if(!m)continue;
  const depth=m[1].length,role=m[3];
  while(parents.length && parents.at(-1).depth>=depth)parents.pop();
  const button=role.match(/^button (?:Go )?(Back|Forward)(?:,|$)/i);
  if(button && parents.some(p=>/^tool ?bar\\b/i.test(p.role)) && !parents.some(p=>/^(HTML content|web area)\\b/i.test(p.role))){
    const name=button[1].toLowerCase();
    if(name in history)ambiguous.add(name);
    history[name]=Number(m[2]);
  }
  parents.push({depth,role});
}
for(const name of ambiguous)delete history[name];`

// Only return the selected document subtree for a browser. Other tab titles,
// toolbar values and native REPL documentation stay out of model input.
const frameCode=(browser:boolean)=>`const tree=${readCode}; const lines=tree.split("\\n");
const root=lines.find(x=>/^0 .*window/i.test(x))||"";
const doc=lines.findIndex(x=>/^\\s*\\d+ (HTML content|web area)\\b/i.test(x));
const indent=x=>x.match(/^\\s*/)[0].length;
const rows=[],headingLinks=[],titleAncestors=[];let size=0;
if (${browser?'doc>=0':'true'}) {for(let n=${browser?'doc+1':'0'}; n<lines.length && rows.length<400 && size<24000; n++){
 const x=lines[n];if(!/^\\s*\\d+ /.test(x))continue;
 if(${browser?'indent(x)<=indent(lines[doc])':'false'})break;
 ${browser?`const depth=indent(x);
 while(titleAncestors.length && titleAncestors.at(-1).depth>=depth)titleAncestors.pop();
 const titleNode=x.match(/^\\s*(\\d+) (heading|link)\\b/i);
 if(titleNode){
   const id=Number(titleNode[1]),role=titleNode[2].toLowerCase(),parent=titleAncestors.at(-1);
   if(parent && parent.role!==role)headingLinks.push(role==='link'?[id,parent.id]:[parent.id,id]);
   titleAncestors.push({depth,id,role});
 }`:''}
 if(/secure text|password|one.time (?:code|password)|credit card|authentication token/i.test(x))continue;
 if(/\\b(button|link|heading|text field|text area|search field|combo box|scroll bar|slider|row|tab|cell|menu item|check box|radio button|static text|text)\\b/i.test(x)){const row=x.slice(0,560);rows.push(row);size+=row.length}
}}
const focused=lines.find(x=>/^The focused UI element is /i.test(x));
${browser?historyControls:''}
nodeRepl.write(JSON.stringify({root,document:doc<0?undefined:lines[doc],focused,lines:rows${browser?',history,headingLinks':''}}));`

function accessibleName(description:string) {
  return description.split(/(?:^|, )(?:Value|URL|Details|Description|ID|Placeholder|Secondary Actions): /i)[0].trim() ||
    description.match(/(?:^|, )Description: (.*?)(?=, (?:ID|Value|URL|Details|Secondary Actions): |$)/i)?.[1]?.trim() ||
    description.match(/(?:^|, )Placeholder: ([^,]+)/i)?.[1]?.trim() || ''
}

// Opening autocomplete changes the AX indices in Chrome. Resolve the newly
// focused element inside the same document and compare its role and accessible name.
function verifyFieldFocus(frame:Frame,row:Row) {
  return `{let matched=false;
    for(let observation=0;observation<4 && !matched;observation++){
    const xs=(${readCode}).split("\\n");
    const root=${JSON.stringify(frame.root)};
    if(!xs.includes(root))throw Error("Target changed: window");
    const focused=xs.find(x=>x.startsWith("The focused UI element is "));
    const focus=focused?.match(/is (\\d+) /)?.[1];
    if(!focus)continue;
    const document=xs.findIndex(x=>/^\\s*\\d+ (HTML content|web area)\\b/i.test(x));
    const candidates=[];
    for(let n=${frame.document?'document+1':'0'};n<xs.length;n++){
      const x=xs[n],m=x.match(/^(\\s*)(\\d+) (.+)$/);if(!m)continue;
      if(${frame.document?'document<0 || m[1].length<=xs[document].match(/^\\s*/)[0].length':'false'})break;
      const role=${JSON.stringify(row.role)};
      if(!m[3].toLowerCase().startsWith(role+" "))continue;
      const description=m[3].slice(role.length).trim().replace(/^\\([^)]*\\)\\s*/,"");const name=description.split(/(?:^|, )(?:Value|URL|Details|Placeholder|Secondary Actions): /i)[0].trim() || description.match(/(?:^|, )Placeholder: ([^,]+)/i)?.[1]?.trim();
      if(name===${JSON.stringify(row.label)})candidates.push(m[2]);
    }
    matched=candidates.length===1 && candidates[0]===focus;
    if(!matched && /is \\d+ (?:secure text field|text field|text area|combo box|search field)\\b/i.test(focused))break;
    }
    if(!matched)throw Error("Target changed: editor focus");}`
}

function address(line:string|undefined, base?:string) {
  const raw=line?.match(/(?:^|,? )(?:URL|Value): ([^,\s]+)/i)?.[1]
  if(!raw || raw.includes('…'))return
  if(base && /^[/?#]/.test(raw)){try{return new URL(raw,base)}catch{return}}
  try {const url=new URL(/^https?:\/\//i.test(raw)?raw:(base?new URL(base).protocol:'https:')+'//'+raw)
    if(['http:','https:'].includes(url.protocol) && !url.username && !url.password)return url
  }catch{ /* Not a web address. */ }
}
const normalized=(u:URL)=>u.hostname.replace(/^www\./,'')+':'+u.port+u.pathname+u.search+u.hash
function sameAddress(observed:URL|undefined,expected:string|undefined) {
  if(!observed||!expected)return false
  try{const url=new URL(expected);return observed.protocol===url.protocol && normalized(observed)===normalized(url)}catch{return false}
}
function documentIdentity(line?:string) {
  const body=line?.match(/^\s*\d+ (?:HTML content|web area) (.+)$/i)?.[1]
  if(!body)return
  const first=body.match(/^URL: ([^, ]+), (.+)$/i)
  if(first)return {title:first[2],address:first[1]}
  const last=body.match(/^(.+?), URL: ([^, ]+)/i)
  if(last)return {title:last[1],address:last[2]}
}
function sameDocument(raw:{root:string;document?:string},target:Target) {
  if(!target.url || !raw.document)return false
  if(sameAddress(address(raw.document,target.url),target.url))return true
  // Large native trees elide URLs. Pair the independently resolved OS tab ID and
  // full URL with its unique tab title and the native window, never a prefix alone.
  const doc=documentIdentity(raw.document)
  const root=raw.root.match(/^0 standard window (.+)$/i)?.[1]?.replace(/^URL: [^, ]+, (?:Secondary Actions: [^,]+, )?/i,'')
  const title=target.uniqueTitle
  if(!title || !doc || doc.title!==title || !root)return false
  // After Back, Chrome can keep the preceding accessibility document title
  // while immediately updating its real window title and committed URL.
  if(target.uniqueWindowTitle){
    const expected=target.uniqueWindowTitle
    if(!(root===expected || root.startsWith(expected+', URL:') || root.startsWith(expected+', Secondary Actions:')))return false
  }else if(!(root===title || root.startsWith(title+' - ') || root.startsWith(title+', URL:')))return false
  const shown=doc.address
  if(!shown.endsWith('…')){
    const visible=address(raw.document,target.url),expected=new URL(target.url)
    return !!visible && !visible.search && !visible.hash && !!(expected.search || expected.hash) &&
      visible.protocol===expected.protocol && visible.port===expected.port &&
      visible.hostname.replace(/^www\./,'')===expected.hostname.replace(/^www\./,'') && visible.pathname===expected.pathname
  }
  const prefix=shown.slice(0,-1).replace(/^https?:\/\/(?:www\.)?|^www\./i,'')
  return target.url.replace(/^https?:\/\/(?:www\.)?/i,'').startsWith(prefix)
}
class PageChanging extends ChatError {}
function parseFrame(text:string,expected:Target):Frame {
  let raw:{root:string;document?:string;focused?:string;lines:string[];history?:Frame['history'];headingLinks?:Frame['headingLinks']}
  try{raw=JSON.parse(text)}catch{throw new ChatError('Codex returned an unreadable accessibility observation. No further input was issued.')}
  if(!raw.root || !Array.isArray(raw.lines))throw new ChatError('Codex could not observe this window.')
  if(expected.tab && !sameDocument(raw,expected))
    throw new PageChanging('The document seen by Codex differs from the authorized tab. Inspect the intended tab again.')
  const rows:Row[]=[]
  for(const line of raw.lines){
    const m=rowPattern.exec(line)
    if(!m || /disabled|secure/i.test(m[2]+' '+(m[3]??'')))continue
    // Native trees can put a heading level or link URL first, then its title.
    const reordered=['heading','link'].includes(m[2].toLowerCase()) ? m[4].replace(/^Value: [^,]+, /i,'') : m[4]
    const name=editable.test(m[2]) ? reordered.split(/(?:^|, )(?:Value|URL|Details|Placeholder|Secondary Actions): /i)[0].trim() || m[4].match(/(?:^|, )Placeholder: ([^,]+)/i)?.[1]?.trim() || '' : accessibleName(reordered)
    const value=m[4].match(/(?:^|, )Value: (.*?)(?=, (?:Details|URL|Placeholder|Secondary Actions): |$)/)?.[1]
    const link=m[2].toLowerCase()==='link'?address(line,expected.url):undefined
    rows.push({id:Number(m[1]),role:m[2].toLowerCase(),label:name,value,url:link?.href,line})
  }
  return {root:raw.root,document:raw.document,focused:raw.focused,rows,history:raw.history,headingLinks:raw.headingLinks}
}
function find(rows:Row[],label:unknown,filter:(r:Row)=>boolean=()=>true) {
  const matches=rows.filter(r=>filter(r) && (r.label===label || 'control '+r.id===label))
  if(matches.length!==1)throw new ChatError('Inspect the current controls and select one exact label or control number.')
  return matches[0]
}
function playback(frame:Frame) {
  const controls=frame.rows.filter(row=>row.role==='button' && /^(?:play|pause)(?:$|\s*(?:\(k\)|keyboard shortcut k)$)/i.test(row.label))
  if(controls.length===1)return /^pause/i.test(controls[0].label)?'playing':'paused'
}
function sameWindow(a:Target,b:Target|undefined){return !!b && a.app===b.app && a.pid===b.pid && a.window===b.window && a.tab===b.tab}
export class UnsupportedCuaControl extends ChatError {}
function resultLink(frame:Frame,ordinal:number) {
  const headings=new Map(frame.rows.filter(r=>r.role==='heading' && r.label).map(r=>[r.id,r.label]))
  const links=frame.rows.filter(r=>r.role==='link' && r.label && !/^(?:sponsored|advertisement)\b/i.test(r.label))
  // A sidebar link can have the same name as a section heading elsewhere.
  // Only a link in the heading's own subtree (or enclosing that heading) is a result.
  const unique=new Map<string,Row>()
  for(const link of links){
    const heading=frame.headingLinks?.some(([linkId,headingId])=>{
      const title=headings.get(headingId)
      return linkId===link.id && !!title && (title.startsWith(link.label)||link.label.startsWith(title.replace(/…$/,'')))
    })
    // Native accessibility may omit the query for several different media links.
    const identity=JSON.stringify([link.url,link.label])
    if(heading && !sensitive.test(link.label) && !unique.has(identity))unique.set(identity,link)
  }
  const match=[...unique.values()][ordinal-1]
  if(!match)throw new ChatError('The page did not expose that numbered result as a titled link. Inspect the results and select a specific link.')
  return match
}
const observeNames=new Set(['inspect','read','athena_desktop_inspect_accessible_ui'])
const supported=new Set([...observeNames,'click','type','submit-search','back','forward','scroll','media','first-video','video-result','navigate',
  'athena_desktop_click_accessible_element','athena_desktop_set_accessible_text','athena_desktop_scroll'])
export function cuaOperation(name:string,args:Record<string,unknown>):string|undefined {
  const operation=name==='athena_browser_action'?args.action==='open' || args.action==='window' && args.operation==='navigate'?'navigate':String(args.action):name
  if(!supported.has(operation) || operation==='media' && !['play','pause'].includes(String(args.operation)))return
  return operation
}

/** The planner supplies labels/data. Only these fixed, target-checked native calls can enter the REPL. */
export class CodexCuaControls {
  private previous?:{target:Target;frame:Frame}
  private edit?:{target:Target;label:string;field:string;text:string}
  private uncertain=false
  get hasUnverifiedInput(){return this.uncertain}

  async run(action:Action,ctx:CuaControlContext) {
    const {target,call,signal}=ctx
    const operation=cuaOperation(action.name,action.args)
    if(!operation)throw new ChatError('This action is unsupported by the Codex accessibility interface.')
    const {label,text,direction}=action.args
    const assertTarget=async(allowNavigation=false)=>{
      signal.throwIfAborted()
      const live=await ctx.current()
      if(!live || !sameWindow(target,live) || !allowNavigation && live.url!==target.url)
        throw new ChatError('The authorized window or tab changed. The operation stopped.')
      return live
    }
    let destinationOrigin=target.url?new URL(target.url).origin:undefined
    const observe=async(allowNavigation=false)=>{
      const live=await assertTarget(allowNavigation)
      if(live.url && destinationOrigin!==new URL(live.url).origin)
        throw new ChatError('Navigation reached another website. Authorize its window before sharing its contents.')
      const value=await call('{'+frameCode(!!live.tab)+'}','Inspecting the selected window')
      const frame=parseFrame(value,live)
      const after=await assertTarget(allowNavigation)
      if(after.url!==live.url)throw new PageChanging('The page changed during observation.')
      return {target:after,frame}
    }
    const before=await observe()
    const frame=before.frame
    if(observeNames.has(operation)){
      this.previous=before
      const elements=frame.rows.filter(r=>r.label).map(r=>({label:r.label.slice(0,155),role:r.role,enabled:true,ref:'control '+r.id}))
      const media=playback(frame)
      return {ok:true,verified:true,message:`Observed ${elements.length} controls in ${APPLICATIONS[target.app].name}.`+(media?' Playback is '+media+'.':''),data:{controls:elements,playback:media}}
    }
    if(this.uncertain)throw new ChatError('An input in this turn has an uncertain outcome. Observe the current state before giving a new instruction.')
    const needsPrior=['click','type','submit-search','athena_desktop_click_accessible_element','athena_desktop_set_accessible_text'].includes(operation)
    const snapshot=this.previous && sameWindow(target,this.previous.target) && target.url===this.previous.target.url ? this.previous : undefined
    if(needsPrior && !snapshot)
      throw new ChatError('Inspect this window before interacting with it.')
    let row:Row|undefined, command:string, message:string
    let resolvedLink:string|undefined
    let expectedAddress:string|undefined
    let check:(next:Frame,live:Target)=>boolean
    let navigation=false
    const targetLabel=String(label??'')
    const searchField=(r:Row)=>editable.test(r.role) && /search/i.test(r.label+' '+r.role)
    const get=(select:(f:Frame)=>Row)=>{
      const old=select(snapshot?.frame??frame),fresh=select(frame)
      if(old.role!==fresh.role || old.label!==fresh.label || old.url!==fresh.url || old.value!==fresh.value)
        throw new ChatError('The selected control changed since inspection.')
      return fresh
    }
    if(operation==='type' || operation==='athena_desktop_set_accessible_text'){
      if(typeof text!=='string' || /[\r\n\u0000]/.test(text))throw new ChatError('Use one line of plain text for this field.')
      row=get(f=>find(f.rows,label,r=>editable.test(r.role)))
      if(!searchField(row) && !await ctx.confirm('Replace the value of “'+row.label+'” in '+APPLICATIONS[target.app].name+'?'))throw new ChatError('Computer input was declined.')
      const focusCheck=verifyFieldFocus(frame,row)
      command='await athenaApp.click(idx);'+focusCheck+'await athenaApp.pressKey("super+a");'+focusCheck+'await athenaApp.typeText('+JSON.stringify(text)+');'
      const field=row
      check=f=>f.rows.some(r=>r.role===field.role && r.label===field.label && r.value===text)
      message='Verified the new text in the selected field.'
    }else if(operation==='submit-search'){
      if(!this.edit || !sameWindow(target,this.edit.target) || this.edit.target.url!==target.url || this.edit.text!==text || label!==this.edit.label || typeof text!=='string')throw new ChatError('Verify the exact edited search field before submitting.')
      row=find(frame.rows,this.edit.field,searchField)
      if(row.value!==text)throw new ChatError('The search field changed before submission.')
      command='await athenaApp.click(idx);'+verifyFieldFocus(frame,row)+'await athenaApp.pressKey("Return");'
      navigation=true
      check=(_f,t)=>!!t.url && t.url!==target.url && new URL(t.url).origin===new URL(target.url!).origin && Array.from(new URL(t.url).searchParams.values()).some(v=>v===text)
      message='Verified the submitted search in the results URL.'
    }else if(operation==='media'){
      const desired=action.args.operation==='pause'?'paused':'playing'
      message='Verified that playback is '+desired+'.'
      if(playback(frame)===desired)return {ok:true,verified:true,message}
      row=get(f=>{const candidates=f.rows.filter(r=>r.role==='button'&&new RegExp('^'+(desired==='paused'?'Pause':'Play')+'(?:$| keyboard shortcut k$| *\\(k\\)$)','i').test(r.label));if(candidates.length!==1)throw new ChatError('The current media control is ambiguous or unavailable.');return candidates[0]})
      command='await athenaApp.click(idx);'
      check=f=>playback(f)===desired
    }else if(operation==='navigate'){
      const destination=new URL(String(action.args.url))
      if(!['https:','http:'].includes(destination.protocol) || destination.username || destination.password)throw new ChatError('Select an HTTP or HTTPS destination without credentials.')
      await ctx.allowDestination?.(destination.href)
      destinationOrigin=destination.origin
      if(target.url && sameAddress(destination,target.url))return {ok:true,verified:true,message:'Verified that the requested page is already open.'}
      // Only a verified browser location field may receive a URL. The authorization
      // and inventory checks in the caller also pin the existing window and tab.
      command='await athenaApp.pressKey("super+l");const active=('+readCode+').split("\\n").find(x=>x.startsWith("The focused UI element is "));if(!active || !/address|location|URL field/i.test(active))throw Error("Target changed");await athenaApp.typeText('+JSON.stringify(destination.href)+');await athenaApp.pressKey("Return");'
      navigation=true;check=(_f,t)=>sameAddress(destination,t.url)
      message='Verified the requested address in the selected tab.'
    }else if(operation==='back'||operation==='forward'){
      const id=frame.history?.[operation]
      if(id===undefined)throw new UnsupportedCuaControl('The browser has no unique enabled '+operation+' toolbar button. No navigation input was sent.')
      command=historyControls+'if(history.'+operation+'!=='+id+')throw Error("Target changed: navigation toolbar");await athenaApp.click('+id+');'
      expectedAddress=ctx.historyDestination?.(operation)
      navigation=true;check=(_f,t)=>!!t.url && t.url!==target.url && (!expectedAddress || t.url===expectedAddress);message='Verified navigation in the selected tab.'
    }else if(operation==='scroll'||operation==='athena_desktop_scroll'){
      const scrollbars=frame.rows.filter(r=>r.role==='scroll bar' && Number.isFinite(Number(r.value)))
      if(scrollbars.length!==1)throw new UnsupportedCuaControl('Native accessibility exposes no unique scroll position to verify. No scroll input was sent.')
      const bar=scrollbars[0]
      row=label?get(f=>find(f.rows,label)):bar
      command='await athenaApp.scroll(idx,'+JSON.stringify(direction==='up'?'up':'down')+',1);'
      message='Verified the changed scroll position.'
      check=f=>f.rows.some(r=>r.role===bar.role && r.label===bar.label && Number.isFinite(Number(r.value)) && (direction==='up'?Number(r.value)<Number(bar.value):Number(r.value)>Number(bar.value)))
    }else{
      const ordinal=operation==='video-result'||operation==='first-video'
      row=ordinal ? get(f=>resultLink(f,Number(action.args.index??1))) : get(f=>find(f.rows,label))
      if(target.tab && row.role==='link' && row.label && (!row.url || new URL(row.url).origin!==new URL(target.url!).origin))
        resolvedLink=await ctx.resolveLink?.(row.label)
      const href=resolvedLink??row.url, chosen=row
      const link=href && target.url && new URL(href).origin===new URL(target.url).origin
      if(operation!=='athena_desktop_click_accessible_element' && (!link || sensitive.test(row.label+' '+(href??'')))){
        if(!await ctx.confirm('Click “'+row.label+'” in '+APPLICATIONS[target.app].name+'?'))throw new ChatError('Computer input was declined.')
      }
      command='await athenaApp.click(idx);'
      const selectedMedia=(after:Frame,t:Target)=>{
        const title=documentIdentity(after.document)?.title.toLowerCase()??''
        const label=chosen.label.toLowerCase()
        const heading=after.rows.some(r=>r.role==='heading' && r.label.length>8 && label.startsWith(r.label.toLowerCase()))
        return !!t.url && t.url!==target.url && !!playback(after) && (heading || title.length>8 && title.includes(label))
      }
      if(href){
        await ctx.allowDestination?.(href)
        destinationOrigin=new URL(href).origin
        const wanted=new URL(href)
        navigation=true;check=(f,t)=>{
          if(!t.url || t.url===target.url)return false
          if(sameAddress(wanted,t.url))return true
          const actual=new URL(t.url)
          const matchesResource=actual.origin===wanted.origin && actual.pathname===wanted.pathname &&
            actual.hash===wanted.hash && [...wanted.searchParams.keys()].every(k=>
              JSON.stringify(actual.searchParams.getAll(k))===JSON.stringify(wanted.searchParams.getAll(k)))
          return matchesResource && selectedMedia(f,t)
        }
        message='Verified the selected result in the active tab.'
      }else if(ordinal){
        navigation=true;check=selectedMedia
        message='Verified the selected result and its media controls in the active tab.'
      }else{
        const focusChanged=(f:Frame)=>f.focused!==frame.focused && f.rows.some(r=>r.role===chosen.role && r.label===chosen.label && f.focused?.startsWith('The focused UI element is '+r.id+' '))
        const valueChanged=(f:Frame)=>/^[0-9]$/.test(chosen.label) && f.rows.some(r=>['text','static text','text area','text field'].includes(r.role) &&
          !/settable/i.test(r.line) && (r.value??r.label)===chosen.label && frame.rows.some(old=>old.id===r.id && old.role===r.role && (old.value??old.label)!==chosen.label))
        check=f=>focusChanged(f)||valueChanged(f)
        message='Verified the selected control’s focus or corresponding display value.'
      }
    }
    if(resolvedLink && row && (await ctx.resolveLink?.(row.label))!==resolvedLink)
      throw new ChatError('The selected link destination changed. Inspect the tab again before clicking.')
    await assertTarget()
    // Re-read the exact AX row inside the REPL immediately before native input.
    // The root check also catches a window switch between the host check and dispatch.
    const guard='const lines=('+readCode+').split("\\n");if(!lines.includes('+JSON.stringify(frame.root)+'))throw Error("Target changed: window");'
    const match=row?'const idx='+row.id+';if(!lines.includes('+JSON.stringify(row.line)+'))throw Error("Target changed: row");':''
    this.uncertain=true
    await call('{'+guard+match+command+'}',operation==='submit-search'?'Submitting the verified search':'Operating the selected control')
    let next:Awaited<ReturnType<typeof observe>>|undefined
    const deadline=Date.now()+6000
    do {
      // Chrome can commit a history traversal before replacing its accessibility
      // tree. The signed window service independently reads the selected document URL.
      if(expectedAddress && expectedAddress!==target.url && new URL(expectedAddress).origin===destinationOrigin){
        const actual=await assertTarget(true)
        if(actual.url===expectedAddress){
          this.uncertain=false
          this.previous=undefined
          this.edit=undefined
          return {ok:true,verified:true,message}
        }
      }
      try{next=await observe(navigation)}catch(error){
        if(!(navigation && error instanceof PageChanging))throw error
        await delay(100,undefined,{signal})
        continue
      }
      if(check(next.frame,next.target)){
        this.uncertain=false
        this.previous=next
        this.edit=operation==='type' && row && searchField(row)?{target:next.target,label:targetLabel,field:row.label,text:String(text)}:undefined
        return {ok:true,verified:true,verifiedDestination:operation==='click' && !!(row?.url??resolvedLink),message}
      }
      if(signal.aborted)signal.throwIfAborted()
      await delay(150,undefined,{signal})
    }while(Date.now()<deadline)
    this.previous=next
    throw new ChatError('Codex delivered the input, but its intended effect could not be verified. No repeat was sent.')
  }
}
