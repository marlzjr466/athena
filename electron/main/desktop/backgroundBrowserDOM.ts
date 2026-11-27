/** Serialized only into the already-authorized page's isolated CDP world. */
function backgroundSearch(url:string,label:string,query:string,action:'type'|'submit-search',resolve:typeof searchForm,submitTo?:string){
  if(location.href!==url || window.top!==window)return {ok:false}
  // Bind input to the exact element and search contract from the most recent
  // inspection of this document. Replacing either invalidates the observation.
  const state=globalThis as unknown as {athenaSearchFields?:Map<HTMLInputElement,{label:string;destination:string}>}
  const matches=[...state.athenaSearchFields??[]].filter(([,value])=>value.label===label)
  if(matches.length!==1)return {ok:false}
  const [field,observed]=matches[0]
  const contract=resolve(field)
  if(!contract || contract.label!==label || contract.destination!==observed.destination)return {ok:false}
  const destination=new URL(contract.destination)
  destination.searchParams.set(field.name,query)
  if(action==='submit-search'){
    if(field.value!==query || submitTo && destination.href!==submitTo)return {ok:false}
    if(submitTo && location.href!==submitTo)location.assign(submitTo)
    return {ok:true,destination:destination.href}
  }
  if(field.value===query)return {ok:true}
  const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')?.set
  if(!setter)return {ok:false}
  setter.call(field,query)
  field.dispatchEvent(new Event('input',{bubbles:true}))
  return {ok:location.href===url && field.isConnected && field.value===query}
}

function searchForm(field:HTMLInputElement){
  const form=field.form
  if(!field.isConnected || !form || !field.name || field.readOnly || field.matches(':disabled') || field.closest('[inert],[aria-hidden="true"]') ||
      !['search','text'].includes(field.type) || !field.getClientRects().length)return
  if(form.method.toLowerCase()!=='get' || form.target && form.target!=='_self')return
  const action=new URL(form.action,document.baseURI)
  if(action.origin!==location.origin || action.username || action.password || action.hash || action.search)return
  const semantic=!!form.closest('search,[role="search"]') || field.type==='search' || field.getAttribute('role')==='searchbox'
  const searchPath=/\/(?:search|results)\/?$/i.test(action.pathname)
  const queryName=/^(?:q|query|search|search_query|searchterm|keyword)$/i.test(field.name)
  if(!(searchPath && (queryName || semantic) || action.pathname==='/' && semantic && queryName))return
  if([...form.elements].some(control=>control!==field && !!control.getAttribute('name')))return
  const by=field.getAttribute('aria-labelledby')?.split(/\s+/).map(id=>document.getElementById(id)?.textContent??'').join(' ').trim()
  const label=(by || field.getAttribute('aria-label') || field.placeholder || field.labels?.[0]?.textContent || '').trim().slice(0,160)
  if(label && !/password|credential|secret|token|payment|credit.card/i.test(label+' '+field.name))return {label,destination:action.href}
}

/** Each script has a private lexical scope, independent of page-defined globals. */
export function observeBackgroundSearchScript(url:string):string {
  return `(()=>{if(location.href!==${JSON.stringify(url)})return false;const resolve=${searchForm.toString()};const observed=new Map();for(const field of Array.from(document.querySelectorAll('input')).slice(0,150)){const contract=resolve(field);if(contract)observed.set(field,contract)}globalThis.athenaSearchFields=observed;return true})()`
}
export function backgroundSearchScript(url:string,label:string,query:string,action:'type'|'submit-search',submitTo?:string):string{
  return `(${backgroundSearch.toString()})(${[url,label,query,action].map(value=>JSON.stringify(value)).join(',')},${searchForm.toString()},${JSON.stringify(submitTo)})`
}
