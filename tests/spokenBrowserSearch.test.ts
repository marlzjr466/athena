import {expect,it} from 'vitest'
import {parseBrowserSearchRequest,parseBrowserTabRequest} from '../shared/applicationAutomation'
import {dictatedBrowserText,voiceDesktopActions} from '../electron/main/ai/voiceDesktopActions'

const youtube='https://www.youtube.com/'
it.each([
  ['Okay, got it now. Um, search music on YouTube.',{query:'music',newTab:false,destination:youtube}],
  ['Hey Athena, all right, I got it. Uh, can you please search for relaxing music?',{query:'relaxing music',newTab:false}],
  ['Oh, okay. Got it now. Search for rock and roll.',{query:'rock and roll',newTab:false}],
  ['Open a new tab in Chrome, go to YouTube and search for relaxing piano music.',{query:'relaxing piano music',newTab:true,browser:'chrome',destination:youtube}],
  ['Switch to my Chrome browser and open YouTube and search for piano',{query:'piano',newTab:false,browser:'chrome',destination:youtube}],
  ['Go to my Chrome browser, open a new tab, open YouTube, then search for piano.',{query:'piano',newTab:true,browser:'chrome',destination:youtube}],
  ['Create a new Safari tab. Then visit example.org/Music and look up “Piano Concerto”.',{query:'Piano Concerto',newTab:true,browser:'safari',destination:'https://example.org/Music'}],
  ['open youtube and search for piano',{query:'piano',newTab:false,destination:youtube}],
  ['search on YouTube for relaxing piano music',{query:'relaxing piano music',newTab:false,destination:youtube}],
  ['Search for compositions on violin',{query:'compositions on violin',newTab:false}],
  ['Can you please search this page for R&B?',{query:'R&B',newTab:false}],
] as const)('parses the complete spoken request %s',(speech,result)=>{
  expect(parseBrowserSearchRequest(speech)).toEqual(result)
  expect(dictatedBrowserText(speech,result.query,true)).toBe(true)
  expect(dictatedBrowserText(speech,result.query+' something else',true)).toBe(false)
})

it.each([
  'Do not open a new tab in Chrome, visit YouTube and search for piano.',
  'Okay, do not search for music on YouTube.',
  'If I tell you to later, search for my song.',
  'Explain how to open a new tab and search for music',
  'Open Chrome settings, click a button, then search YouTube for piano.',
  'Open YouTube and search piano on Bing.',
  'Search piano, then send it to Jane.',
  'Search piano and close the browser.',
  'Search my files for piano.',
  'Open https://admin:password@example.org/ and search for music.',
  'Open http://127.0.0.1/ and search for music.',
  'Open example.org/../logout and search music.',
  'Search for music on example.local',
  'Open a new Safari tab in Chrome, search music',
  'Go to my Chrome browser, open a new tab in Edge, then search music',
  'Search for piano and then transfer funds',
])('withholds standing authorization for %s',speech=>expect(parseBrowserSearchRequest(speech)).toBeUndefined())

it('authorizes only the navigation, new tab and destination from the actual search instruction',()=>{
  const action=voiceDesktopActions({} as never,{} as never).find(tool=>tool.id==='athena.browser.action')!
  const spoken='Okay, got it now. Um, search for relaxing music on YouTube.'
  expect(action.intent!(spoken,{action:'window',operation:'navigate',url:youtube})).toBe(true)
  expect(action.intent!(spoken,{action:'open',url:youtube})).toBe(true)
  for(const input of [{action:'open',url:'https://other.example/'},{action:'window',operation:'new-tab',url:youtube},
    {action:'window',operation:'navigate',browser:'edge',url:youtube},{action:'window',operation:'navigate',url:youtube+'watch'}])
    expect(action.intent!(spoken,input)).toBe(false)
  const tab='Open a new tab in Chrome, go to YouTube and search for music.'
  expect(action.intent!(tab,{action:'window',operation:'new-tab',browser:'chrome',url:youtube})).toBe(true)
  expect(action.intent!(tab,{action:'window',operation:'new-tab',url:'https://other.example/'})).toBe(false)
  expect(action.intent!('Search for music',{action:'open',url:youtube})).toBe(false)
})


it.each([
  ['Open YouTube in my current uh browser, Chrome browser.',{query:'YouTube',browser:'chrome',destination:youtube}],
  ['Um, switch to the YouTube tab',{query:'YouTube'}],
  ['Select the Release notes tab in my existing Safari browser.',{query:'Release notes',browser:'safari'}],
  ['Select the tab called “Release notes” in Firefox',{query:'Release notes',browser:'firefox'}],
  ['Open YouTube in my current browser.',{query:'YouTube',destination:youtube}],
  ['Use Microsoft Edge and open example.org/Articles',{query:'example.org/Articles',browser:'edge',destination:'https://example.org/Articles'}],
])('consumes the named site or real tab in %s',(speech,expected)=>expect(parseBrowserTabRequest(speech)).toEqual(expected))

it.each([
  'Do not switch to the YouTube tab','Switch to the new tab','Select another tab','Select the tab then send a message',
  'Switch to the YouTube tab and close the other tab','Open a new Chrome window and go to YouTube','Open YouTube in a new window',
  'Use Chrome and open YouTube in Edge','Open YouTube in my current uh browser, Chrome browser, then buy a ticket',
  'Open http://localhost in Chrome','Open YouTube in my current','Search for music on YouTube',
])('withholds existing-tab scope for %s',text=>expect(parseBrowserTabRequest(text)).toBeUndefined())

it('accepts the requested tab only and distinguishes selecting it from navigating by title',()=>{
  const metadata=voiceDesktopActions({} as never,{} as never).find(a=>a.id==='athena.browser.action')!
  const request='Switch to the Release notes tab in Chrome'
  expect(metadata.intent!(request,{action:'select',query:'Release notes'})).toBe(true)
  expect(metadata.intent!(request,{action:'select',query:'Release'})).toBe(false)
  expect(metadata.intent!(request,{action:'open',url:'https://example.com/'})).toBe(false)
  expect(metadata.intent!(request,{action:'window',operation:'new-tab',browser:'chrome'})).toBe(false)
  expect(parseBrowserSearchRequest('Open YouTube in my current uh browser, Chrome browser, then search for music')).toEqual({query:'music',newTab:false,browser:'chrome',destination:youtube})
})
