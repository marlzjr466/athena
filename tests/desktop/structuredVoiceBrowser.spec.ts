import { expect, test } from '@playwright/test'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import { PlaywrightVoiceBrowser } from '../../electron/main/desktop/playwrightVoiceBrowser'

test('visible Playwright browser inspects, edits and verifies controls in an isolated tab',async()=>{
  const html='<title>Automation fixture</title><main><p>Verified fixture text</p></main><input aria-label="Reference" type="file"><a download href="/sample">Save sample</a><input aria-label="Search"><select aria-label="Language"><option>English</option><option>Filipino</option></select><button onclick="this.innerText=\'Clicked\'">Apply</button>'
  const directory=await mkdtemp(join(tmpdir(),'athena-browser-transfer-'))
  const input=join(directory,'input.txt'), output=join(directory,'download.txt')
  await writeFile(input,'Selected upload')
  const server=createServer((req,res)=>{if(req.url==='/sample'){res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Disposition':'attachment; filename="sample.txt"'});res.end('Verified download');return}res.writeHead(200,{'content-type':'text/html'});res.end(html)})
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
  const address=server.address();if(!address||typeof address==='string')throw Error('No fixture address')
  const url='http://127.0.0.1:'+address.port+'/'
  const browser=new PlaywrightVoiceBrowser(()=>true,async()=>true,async candidate=>new URL(candidate).origin===new URL(url).origin,async kind=>kind==='upload'?input:output)
  const signal=AbortSignal.timeout(25000)
  try{
    expect(await browser.run({action:'open',url},signal)).toMatchObject({ok:true,message:'Opened Automation fixture'})
    expect(await browser.run({action:'inspect'},signal)).toMatchObject({ok:true,data:{controls:expect.arrayContaining([expect.objectContaining({label:'Language'})])}})
    expect(await browser.run({action:'choose',label:'Language',option:'Filipino'},signal)).toMatchObject({ok:true})
    await expect(browser.run({action:'click',label:'Apply'},signal)).rejects.toThrow(/inspect/i)
    await browser.run({action:'inspect'},signal)
    expect(await browser.run({action:'type',label:'Search',text:'Fixture search'},signal)).toMatchObject({ok:true})
    await browser.run({action:'inspect'},signal)
    expect(await browser.run({action:'click-observed'},signal)).toMatchObject({ok:true})
    expect(await browser.run({action:'read'},signal)).toMatchObject({ok:true,message:'Page excerpt: Verified fixture text'})
    for (const [action,label] of [['upload','Reference'],['download','Save sample']] as const) {
      await browser.run({action:'inspect'},signal)
      expect(await browser.run({action,label},signal)).toMatchObject({ok:true})
    }
    expect(await readFile(output,'utf8')).toBe('Verified download')
    expect(await browser.run({action:'tabs'},signal)).toMatchObject({ok:true,message:'Automation fixture'})
    expect(await browser.run({action:'close-tab'},signal)).toMatchObject({ok:true})
  } finally {browser.dispose();server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));await rm(directory,{recursive:true,force:true})}
})

test('real YouTube search, second result and verified playback',async()=>{
  test.skip(process.env.ATHENA_LIVE_PLAYWRIGHT_YOUTUBE!=='1','Opens a visible internet browser')
  test.setTimeout(90000)
  const browser=new PlaywrightVoiceBrowser(()=>true,async()=>false,async value=>{
    try { const url=new URL(value);return url.protocol==='https:' && /(^|[.])(youtube[.]com|ytimg[.]com|googlevideo[.]com|google[.]com|gstatic[.]com|googleapis[.]com)$/.test(url.hostname) }catch{return false}
  })
  const signal=AbortSignal.timeout(80000)
  try {
    expect(await browser.run({action:'open',url:'https://www.youtube.com/results?search_query=Unreal+Engine+tutorials'},signal)).toMatchObject({ok:true})
    expect(await browser.run({action:'video-result',index:2},signal)).toMatchObject({ok:true})
    await browser.run({action:'media',operation:'volume',value:0},signal)
    expect(await browser.run({action:'media',operation:'play'},signal)).toMatchObject({ok:true})
    expect(await browser.run({action:'media',operation:'pause'},signal)).toMatchObject({ok:true})
  } finally {browser.dispose()}
})
