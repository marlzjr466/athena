import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import {backgroundSearchScript,observeBackgroundSearchScript} from '../electron/main/desktop/backgroundBrowserDOM'

const form='<form action="/search" method="get" role="search"><input type="search" name="q" aria-label="Search"></form>'
const observe=()=>window.eval(observeBackgroundSearchScript(location.href))
const run=(action:'type'|'submit-search',text='quiet piano')=>window.eval(backgroundSearchScript(location.href,'Search',text,action))

beforeEach(()=>{
  document.body.innerHTML=form
  vi.spyOn(Element.prototype,'getClientRects').mockReturnValue([{width:100,height:30}] as unknown as DOMRectList)
  vi.spyOn(document,'hasFocus').mockReturnValue(false)
})
afterEach(()=>{document.body.innerHTML='';vi.restoreAllMocks()})

it('uses only the observed search field and real form destination without focusing, key events, or duplicate input',()=>{
  const field=document.querySelector('input')!,input=vi.fn(),keydown=vi.fn(),submit=vi.fn()
  const focus=vi.spyOn(field,'focus')
  field.addEventListener('input',input);field.addEventListener('keydown',keydown)
  field.form!.addEventListener('submit',submit)
  expect(observe()).toBe(true)
  expect(run('submit-search')).toMatchObject({ok:false})
  expect(run('type')).toMatchObject({ok:true})
  expect(run('type')).toMatchObject({ok:true})
  expect(input).toHaveBeenCalledTimes(1)
  expect(focus).not.toHaveBeenCalled();expect(keydown).not.toHaveBeenCalled();expect(submit).not.toHaveBeenCalled()
  expect(run('submit-search')).toEqual({ok:true,destination:new URL('/search?q=quiet+piano',location.href).href})
})

it.each([
  ['changed element',()=>{document.body.innerHTML=form}],
  ['different destination',()=>{document.querySelector('form')!.action='/results'}],
  ['cross-site destination',()=>{document.querySelector('form')!.action='https://example.org/search'}],
  ['POST submission',()=>{document.querySelector('form')!.method='POST'}],
  ['other form data',()=>{document.querySelector('form')!.insertAdjacentHTML('beforeend','<input type="hidden" name="account" value="x">')}],
  ['new window',()=>{document.querySelector('form')!.target='_blank'}],
  ['sensitive field',()=>{document.querySelector('input')!.type='password'}],
  ['field disabled',()=>{document.querySelector('input')!.disabled=true}],
])('withholds input for %s',(_cause,change)=>{
  observe();change()
  expect(run('type')).toMatchObject({ok:false})
  expect(document.querySelector('input')!.value).toBe('')
})

it('rejects ambiguous duplicate search labels and form endpoints outside search',()=>{
  document.body.innerHTML=form+form
  observe()
  expect(run('type')).toMatchObject({ok:false})
  document.body.innerHTML=form.replace('/search','/account/delete')
  observe()
  expect(run('type')).toMatchObject({ok:false})
})

it('recognizes a combobox in a GET form inside a search landmark, even if the submit button is outside the form',()=>{
  document.body.innerHTML='<div role="search"><form action="/results"><input type="text" role="combobox" aria-label="Search" name="terms"></form><button>Search</button></div>'
  observe()
  expect(run('type')).toMatchObject({ok:true})
  expect(run('submit-search')).toMatchObject({ok:true,destination:new URL('/results?terms=quiet+piano',location.href).href})
})
