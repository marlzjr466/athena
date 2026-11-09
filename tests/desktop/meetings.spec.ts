import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtemp,writeFile,readFile,chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import mammoth from 'mammoth'
import { createCanvas } from '@napi-rs/canvas'

test('meeting panel captures a synthetic microphone, transcribes through local CLI, analyzes, exports and survives main-window closure',async()=>{
  const profile=await mkdtemp(join(tmpdir(),'athena-meetings-desktop-')),model=join(profile,'fixture-model.bin'),binary=join(profile,'fixture-whisper')
  await writeFile(model,'fixture')
  await writeFile(binary,'#!/bin/sh\nwhile [ "$#" -gt 0 ]; do\nif [ "$1" = "-of" ]; then shift; target="$1"; fi\nshift\ndone\nprintf "%s\\n" "We agreed to use mock APIs. Who owns the frontend adapter?" > "$target.txt"\n')
  await chmod(binary,0o700)
  let screenRequestSeen=false
  const server=createServer(async(request,response)=>{
    response.setHeader('Content-Type','application/json')
    if(request.url==='/api/tags')response.end(JSON.stringify({models:[{name:'qwen2.5-coder:3b',size:1}]}))
    else if(request.url==='/api/show')response.end(JSON.stringify({capabilities:['completion'],model_info:{'general.architecture':'qwen2','qwen2.context_length':32768}}))
    else if(request.url==='/api/chat'){
      let body='';for await(const chunk of request)body+=chunk.toString()
      if(body.includes('Counter')&&body.includes('testOnly')){screenRequestSeen=true;response.end(JSON.stringify({message:{content:'The Counter component increments count by one.'},done:true})+'\n')}
      else response.end(JSON.stringify({message:{content:JSON.stringify({items:[{category:'decision',text:'Use mock APIs.',quote:'We agreed to use mock APIs.',owner:null,deadline:null},{category:'question',text:'Frontend adapter owner: not specified.',quote:'Who owns the frontend adapter?',owner:null,deadline:null}]})},done:true})+'\n')
    }
    else response.end(JSON.stringify({models:[]}))
  })
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
  const address=server.address(); if(!address||typeof address==='string')throw new Error('No fixture server address')
  const endpoint=`http://127.0.0.1:${address.port}`
  const canvas=createCanvas(1200,600),ctx=canvas.getContext('2d')
  ctx.fillStyle='#ffffff';ctx.fillRect(0,0,1200,600);ctx.fillStyle='#000000';ctx.font='32px monospace'
  ctx.fillText('Counter component',40,80);ctx.fillText('const [count, setCount] = useState(0);',40,150);ctx.fillText('setCount(count + 1);',40,220)
  const screenFixture=canvas.toDataURL('image/png')
  const app=await electron.launch({args:['.','--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream'],env:{...process.env,ATHENA_TEST_DATA:profile}})
  try {
    await expect.poll(()=>app.windows().length).toBe(3)
    const control=app.windows().find(p=>p.url().includes('surface=control'))!
    await app.evaluate(({systemPreferences,dialog,desktopCapturer,nativeImage,screen},{profile,screenFixture})=>{
      systemPreferences.getMediaAccessStatus=()=> 'granted'
      desktopCapturer.getSources=async()=>[{id:'screen:fixture:0',name:'Fixture display',display_id:String(screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).id),thumbnail:nativeImage.createFromDataURL(screenFixture),appIcon:nativeImage.createEmpty()}]
      systemPreferences.askForMediaAccess=async()=>true
      dialog.showSaveDialog=async options=>({canceled:false,filePath:profile+'/'+String('defaultPath' in options ? options.defaultPath : 'meeting').split('/').at(-1)})
      const original=globalThis.fetch
      globalThis.fetch=async(input,init)=>{
        const url=String(input)
        if(url.includes('api.openai.com')&&url.endsWith('/models'))return new Response(JSON.stringify({object:'list',data:[{id:'gpt-4.1'}]}))
        if(url.includes('api.openai.com')&&url.endsWith('/responses'))return new Response('data: '+JSON.stringify({type:'response.output_text.delta',delta:'Ordinary chat remains independent.'})+'\n\ndata: '+JSON.stringify({type:'response.completed',response:{output:[]}})+'\n\n',{headers:{'content-type':'text/event-stream'}})

        if(url.includes('/api/tags'))return new Response(JSON.stringify({models:[{name:'qwen2.5-coder:3b',size:1}]}))
        if(url.includes('/api/show'))return new Response(JSON.stringify({capabilities:['completion'],model_info:{'general.architecture':'qwen2','qwen2.context_length':32768}}))
        if(url.includes('/api/ps'))return new Response(JSON.stringify({models:[]}))
        if(url.includes('/api/chat')&&String(init?.body).includes('Counter'))return new Response(JSON.stringify({message:{content:'The Counter component increments count by one.'},done:true})+'\n')
        if(url.includes('/api/chat'))return new Response(JSON.stringify({message:{content:JSON.stringify({items:[{category:'decision',text:'Use mock APIs.',quote:'We agreed to use mock APIs.',owner:null,deadline:null},{category:'question',text:'Frontend adapter owner: not specified.',quote:'Who owns the frontend adapter?',owner:null,deadline:null}]})},done:true})+'\n')
        return original(input,init)
      }
    },{profile,screenFixture})
    await control.evaluate(async endpoint=>{const current=await window.athena!.getSnapshot();await window.athena!.updateSettings({localAI:{...current.settings.localAI,endpoint}})},endpoint)
    await control.getByRole('button',{name:'My Athena',exact:true}).click()
    await control.getByRole('button',{name:'Meeting Intelligence',exact:true}).click()
    await expect(control.getByRole('heading',{name:'Meeting Intelligence'})).toBeVisible()
    expect(await control.locator('.meeting-page-shell').evaluate(el=>getComputedStyle(el).paddingTop)).toBe('33px')
    await control.getByRole('combobox',{name:'Meeting template',exact:true}).hover()
    await control.getByRole('option',{name:'Technical discussion',exact:true}).click()
    await control.screenshot({path:join(profile,'meeting-page.png')})
    await control.getByLabel('New meeting title').fill('Integration fixture')
    await control.getByRole('button',{name:'New Meeting',exact:true}).click()
    await control.evaluate(async({binary,model})=>{
      await window.meetings!.command({action:'preferences',patch:{microphone:true,partialTranscripts:true,whisperBinary:binary,whisperModel:model,aiConsent:true,retainAudio:true}})
      await window.meetings!.command({action:'panel',mode:'show'})
    },{binary,model})
    await expect.poll(()=>app.windows().length).toBe(4)
    const panel=app.windows().find(p=>p.url().includes('surface=meeting'))!
    await expect(panel.getByText('Integration fixture',{exact:true})).toBeVisible()
    await expect(panel.getByRole('button',{name:'Stop recording',exact:true})).toBeDisabled()
    await panel.getByLabel('I have authorization to record',{exact:false}).check()
    await panel.getByRole('button',{name:'Start recording',exact:true}).click()
    await expect.poll(async()=>{const r=await panel.evaluate(()=>window.meetings!.command({action:'get'}));return r.snapshot?.session?.segments.some(s=>s.provisional&&s.status==='complete')},{timeout:15000,intervals:[100]}).toBe(true)
    await expect.poll(async()=>{const r=await panel.evaluate(()=>window.meetings!.command({action:'get'}));return r.snapshot?.session?.segments.some(s=>!s.provisional&&s.status==='complete'&&s.text.includes('mock APIs'))},{timeout:30000}).toBe(true)
    await panel.evaluate(async()=>{const id=(await window.meetings!.command({action:'get'})).snapshot!.session!.id;await window.meetings!.command({action:'attach-paste',sessionId:id,text:'export const testOnly = true'});})
    await expect(panel.getByText('Pasted text.txt',{exact:false})).toBeVisible()
    await panel.getByRole('button',{name:'Pause recording',exact:true}).click()
    await panel.getByRole('button',{name:'Resume recording',exact:true}).click()
    await panel.getByRole('button',{name:'Stop recording',exact:true}).click()
    await panel.getByRole('button',{name:'More meeting controls',exact:true}).click()
    await panel.getByRole('button',{name:'Meeting notes',exact:true}).click()
    await expect(panel.getByRole('button',{name:'More meeting controls',exact:true})).toHaveAttribute('aria-pressed','false')
    await panel.getByRole('button',{name:'Update notes',exact:true}).click()
    await expect(panel.getByText('Frontend adapter owner: not specified.',{exact:true})).toBeVisible({timeout:10000})
    const id=(await panel.evaluate(()=>window.meetings!.command({action:'get'}))).snapshot!.session!.id
    await panel.evaluate(()=>window.meetings!.command({action:'preferences',patch:{protection:true}}))
    const bounds=await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('surface=meeting'))!;w.setBounds({x:100,y:120,width:420,height:580});return w.getBounds()})
    await expect.poll(async()=>JSON.parse(await readFile(join(profile,'meetings','panel.json'),'utf8').catch(()=>'{}')).x).toBe(bounds.x)
    await panel.screenshot({path:join(profile,'panel.png')})
    await panel.evaluate(()=>window.meetings!.command({action:'panel',mode:'safe'}))
    expect(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('surface=meeting'))!.isVisible())).toBe(false)
    await control.evaluate(()=>window.meetings!.command({action:'panel',mode:'restore'}))
    for(const format of ['md','txt','json','pdf','docx','audio'] as const){const result=await panel.evaluate(format=>window.meetings!.command({action:'export',format}),format);expect(result.ok,JSON.stringify(result)).toBe(true)}
    const pdfTask=getDocument({data:new Uint8Array(await readFile(join(profile,'Integration fixture.pdf'))),useSystemFonts:true})
    const pdf=await pdfTask.promise
    let pdfText=''
    try {for(let n=1;n<=pdf.numPages;n++){const page=await pdf.getPage(n);pdfText+=(await page.getTextContent()).items.map(item=>'str' in item?item.str:'').join(' ')+'\n'}} finally {await pdfTask.destroy()}
    const docx=await mammoth.extractRawText({path:join(profile,'Integration fixture.docx')})
    for(const [format,content] of [['PDF',pdfText],['DOCX',docx.value]]){
      const normalized=content.replace(/\s+/g,' ')
      expect(normalized,format+' contains transcript').toContain('We agreed to use mock APIs. Who owns the frontend adapter?')
      expect(normalized,format+' contains structured notes').toContain('Frontend adapter owner: not specified.')
      expect(normalized,format+' includes transcript heading').toContain('Transcript')
    }
    await panel.getByRole('button',{name:'Screen Context',exact:true}).click()
    await expect(panel.locator('.meeting-screen-access summary')).toHaveText('Screen access · Allowed')
    await panel.locator('.meeting-screen-access summary').click()
    await expect(panel.getByRole('button',{name:'Show this Athena app',exact:true})).toBeVisible()
    await expect(panel.getByRole('button',{name:'Restart Athena',exact:true})).toBeEnabled()
    await panel.locator('.meeting-screen-access summary').click()
    expect(await panel.locator('select').count()).toBe(0)
    await panel.getByLabel('Allow screen access for my requests',{exact:true}).click()
    await expect(panel.getByLabel('Allow screen access for my requests',{exact:true})).toBeChecked()
    await panel.getByRole('button',{name:'Analyze active screen',exact:true}).click()
    await expect(panel.getByRole('button',{name:'Cancel capture',exact:true})).toBeVisible()
    await expect(panel.getByText('The Counter component increments count by one.',{exact:true})).toBeVisible({timeout:20000})
    const screenResult=await panel.evaluate(async()=> (await window.meetings!.command({action:'get'})).snapshot!.session!)
    expect(screenResult.answers.at(-1)?.screenContext?.method).toBe('local-text')
    expect(screenResult.screenReferences).toEqual([])
    expect(screenRequestSeen).toBe(true)
    await panel.screenshot({path:join(profile,'screen-context.png')})
    await control.evaluate(async()=>{await window.athena!.activateAI({apiKey:'sk-meeting-regression-fixture-not-real'});await window.athena!.selectAIModel({model:'gpt-4.1'});await window.athena!.updateSettings({aiMode:'cloud',minimizeToTray:true});await window.athena!.sendChat({text:'Hello from ordinary chat'})})
    await expect.poll(async()=>control.evaluate(()=>window.athena!.getChat()).then(c=>c.messages.at(-1)?.content)).toContain('Ordinary chat remains independent')
    expect((await control.evaluate(()=>window.athena!.getChat())).messages.some(m=>m.content.includes('mock APIs'))).toBe(false)
    expect(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().some(w=>w.webContents.getURL().includes('surface=floating')&&!w.isDestroyed()))).toBe(true)

    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('surface=control'))!.close())
    expect(await panel.evaluate(()=>window.meetings!.command({action:'get'})).then(r=>r.ok)).toBe(true)
    await expect.poll(async()=>JSON.parse(await readFile(join(profile,'meetings',id,'session.json'),'utf8')).notes).toContain('Use mock APIs')
    console.log('Meeting integration artifacts:',profile)
  } finally {await app.close();await new Promise<void>(resolve=>server.close(()=>resolve()))}
})
