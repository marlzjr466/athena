// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { browserActionScript, isPublicBrowserURL } from '../electron/main/desktop/voiceBrowser'
import type { VoiceBrowserAction } from '../shared/voiceBrowser'

vi.mock('electron', () => ({ default: {}, app: {}, BrowserWindow: class {}, session: {} }))
vi.mock('node:dns/promises', () => { const lookup = async (host: string) => [{ address: host === 'public.test' ? '93.184.215.14' : host }]; return { default: { lookup }, lookup } })
afterEach(() => { document.body.innerHTML = ''; vi.restoreAllMocks() })
const run = (command: VoiceBrowserAction) => window.eval(browserActionScript(command, location.href))
function page(html: string) {
  document.body.innerHTML = html
  const controls=Array.from(document.body.children)
  vi.spyOn(Element.prototype,'getBoundingClientRect').mockImplementation(function(this:Element){return {x:0,y:controls.indexOf(this)*24,width:100,height:20} as DOMRect})
  Object.defineProperty(document,'elementFromPoint',{configurable:true,value:(_x:number,y:number)=>controls[Math.floor(y/24)]})
}

describe('bounded browser observation and verification', () => {
  it('resolves the actual DOM target for desktop painting without input and refuses a moved paint target', async () => {
    page('<button>Run</button>')
    vi.spyOn(document,'hasFocus').mockReturnValue(true)
    const click=vi.fn()
    document.querySelector('button')!.addEventListener('click',click)
    const action={action:'click',label:'Run'} as const
    await run({action:'inspect'})
    const target=await window.eval(browserActionScript(action,location.href,undefined,'operation',true))
    expect(target).toMatchObject({x:0,y:0,width:100,height:20,key:expect.any(String)})
    expect(click).not.toHaveBeenCalled()
    vi.spyOn(Element.prototype,'getBoundingClientRect').mockReturnValue({x:20,y:0,width:100,height:20} as DOMRect)
    expect(await window.eval(browserActionScript(action,location.href,undefined,'operation',false,target.key))).toMatchObject({ok:false,message:expect.stringContaining('highlighted')})
    expect(click).not.toHaveBeenCalled()
  })
  it('rejects private addresses and credential-bearing or non-web URLs', async () => {
    for (const url of ['http://127.0.0.1', 'http://10.0.0.2', 'http://[::1]', 'http://localhost', 'http://user:secret@public.test', 'file:///etc/passwd', 'javascript:alert(1)']) expect(await isPublicBrowserURL(url), url).toBe(false)
    expect(await isPublicBrowserURL('https://public.test/')).toBe(true)
  })
  it('keeps passwords and field values out of observations and only types explicitly supplied data', async () => {
    page('<input aria-label="Query" value="private prior value"><input type="password" aria-label="Password" value="secret"><button>Submit</button>')
    const observed = await run({ action: 'inspect' })
    expect(JSON.stringify(observed)).not.toMatch(/private prior value|secret|Password/)
    expect(await run({ action: 'type', label: 'Query', text: 'literal ${nothing}; "no code"' })).toMatchObject({ ok: true })
    expect(document.querySelector('input')!.value).toBe('literal ${nothing}; "no code"')
  })
  it('types into an observed search field beside a like-named button and preserves the input event', async()=>{
    page('<input type="search" role="combobox" aria-label="Search"><button>Search</button>')
    const input=document.querySelector('input')!,change=vi.fn(),clicked=vi.fn()
    input.addEventListener('input',change)
    document.querySelector('button')!.addEventListener('click',clicked)
    await run({action:'inspect'})
    expect(await run({action:'type',label:'Search',text:'example'})).toMatchObject({ok:true})
    expect(document.activeElement).toBe(input)
    expect(change).toHaveBeenCalledOnce()
    expect(clicked).not.toHaveBeenCalled()
  })
  it('gives an unnamed editable field a reference tied to the observed element',async()=>{
    page('<input type="search">')
    const observed=await run({action:'inspect'})
    const label=observed.data.controls[0].label
    expect(label).toMatch(/^Unlabeled field/)
    document.querySelector('input')!.replaceWith(document.createElement('input'))
    expect(await run({action:'type',label,text:'query'})).toMatchObject({ok:false})
  })
  it('refuses unobserved, replaced and ambiguous controls without invoking them', async () => {
    page('<button>Action</button>')
    expect(await run({ action: 'click', label: 'Action' })).toMatchObject({ ok: false })
    await run({ action: 'inspect' })
    const click = vi.fn(); document.querySelector('button')!.outerHTML = '<button>Action</button>'
    document.querySelector('button')!.addEventListener('click', click)
    expect(await run({ action: 'click', label: 'Action' })).toMatchObject({ ok: false, message: expect.stringContaining('changed') })
    expect(click).not.toHaveBeenCalled()
    document.body.insertAdjacentHTML('beforeend', '<button>Action</button>')
    await run({ action: 'inspect' })
    expect(await run({ action: 'click', label: 'Action' })).toMatchObject({ ok: false, message: expect.stringContaining('unique') })
  })
  it('reports an invoked control as unverified if no observable state changed', async () => {
    page('<button>Action</button>')
    await run({ action: 'inspect' })
    expect(await run({ action: 'click', label: 'Action' })).toMatchObject({ ok: false, message: expect.stringContaining('unverified') })
    await run({ action: 'inspect' })
    document.querySelector('button')!.addEventListener('click', event => { (event.target as HTMLElement).textContent = 'Done' })
    expect(await run({ action: 'click', label: 'Action' })).toMatchObject({ ok: true })
  })
  it('does not act after navigation or invent a media result', async () => {
    expect(await window.eval(browserActionScript({ action: 'inspect' }, 'https://different.test/'))).toMatchObject({ ok: false })
    expect(await run({ action: 'media', operation: 'pause' })).toMatchObject({ ok: false, message: expect.stringContaining('No video') })
  })
})
