import { mkdtempSync,readFileSync,readdirSync,rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach,expect,it,vi } from 'vitest'
import { VoiceMemory } from '../electron/main/voice/voiceMemory'
import { LiveHistory } from '../src/services/speech/liveHistory'
const dirs:string[]=[]
const dir=()=>{const p=mkdtempSync(join(tmpdir(),'voice-memory-'));dirs.push(p);return p}
afterEach(()=>{for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true})})
const cipher={seal:(s:string)=>Buffer.from(s).toString('base64'),open:(s:string)=>Buffer.from(s,'base64').toString()}
it('restores bounded native input roles, explicit notes and a logical ID across restarts and isolates accounts and conversations',()=>{
  const path=dir(),m=new VoiceMemory(path,cipher)
  m.open('a',7);const original=m.id
  m.manage('save-note',undefined,'Use short replies')
  for(let i=0;i<60;i++)m.append([{id:String(i),role:i%2?'assistant':'user',offset:i,text:i===2?'Which framework should I choose?':'Project topic '+i}])
  const restarted=new VoiceMemory(path,cipher);restarted.open('a',7)
  expect(restarted.id).toBe(original)
  expect(restarted.view().compacted).toBeGreaterThan(0)
  expect(JSON.stringify(restarted.seed())).toContain('Which framework')
  expect(restarted.seed().at(-1)).toMatchObject({role:'assistant',content:[{type:'output_text',text:'Project topic 59'}]})
  expect(readFileSync(join(path,readdirSync(path)[0]),'utf8')).not.toContain('Project topic')
  restarted.manage('new');expect(restarted.id).not.toBe(original)
  expect(JSON.stringify(restarted.seed())).not.toContain('Project topic')
  expect(JSON.stringify(restarted.seed())).toContain('Use short replies')
  restarted.manage('select',original);restarted.forgetLast()
  expect(JSON.stringify(restarted.seed())).not.toContain('Project topic 59')
  restarted.open('b',7);expect(restarted.seed()).toEqual([])
  restarted.open('a',0);expect(readdirSync(path).length).toBe(1)
})
it('omits credentials, and holds volatile history when secure storage is unavailable',()=>{
  const path=dir(),m=new VoiceMemory(path);m.open('person',7)
  m.append([{id:'1',role:'user',offset:0,text:'My password is sensitive.'}]);expect(m.seed()).toEqual([])
  expect(m.privateTurn("Don’t remember this")).toBe(true)
  expect(readdirSync(path)).toEqual([])
})
it('retains the played prefix and independent user interruption, dropping overlapping and silent assistant output',()=>{
  const h=new LiveHistory()
  h.add('assistant',20,200,'Heard.',200);h.sample(135)
  h.add('assistant',220,390,' Cancelled.',300);h.interrupt(230)
  h.add('user',240,520,'Actually, wait.',530);h.resume(560)
  expect(h.drain(3000)).toMatchObject([{role:'assistant',text:'Heard.',partial:true},{role:'user',text:'Actually, wait.'}])
  expect(h.drain(3500)).toEqual([])
  h.add('assistant',4100,4600,'Unplayed.',4710);expect(h.drain(7000)).toEqual([])
})

it('matches output from a late-starting Live engine to local playout and leaves the interrupted tail out',()=>{
  const history=new LiveHistory()
  history.add('assistant',4800,5000,'Violet',12931)
  history.add('assistant',5200,5400,' Lantern',13366)
  history.add('assistant',5600,5800,' is ready.',13740)
  for(const t of [13174,13334,13494,13654])history.sample(t)
  history.interrupt(13850)
  expect(history.drain(16000)).toMatchObject([{role:'assistant',text:'Violet Lantern',partial:true}])
})
it('expires inactive conversations and preserves only explicitly saved preferences across the expiry',()=>{
  const directory=dir(),normalized=new VoiceMemory(directory,cipher)
  normalized.open('a',1)
  const original=normalized.id
  const now=Date.now()
  normalized.rememberExplicit('Remember that I like brief answers')
  normalized.append([{id:'user',role:'user',text:'Fictional project',offset:now}])
  vi.spyOn(Date,'now').mockReturnValue(now+2*86400000)
  try{
    const next=new VoiceMemory(directory,cipher)
    next.open('a',1)
    expect(next.id).not.toBe(original)
    expect(next.view().recent).toEqual([])
    expect(next.view().notes.map(n=>n.text)).toEqual(['I like brief answers'])
  }finally{vi.restoreAllMocks()}
})

it('retains the leading word when WebRTC plays a short answer after its last caption',()=>{
  const h=new LiveHistory()
  h.add('assistant',3000,3200,' Blue',4659)
  h.add('assistant',3200,3400,' Moon.',4811)
  for(const t of [5056,5217,5377,5536])h.sample(t)
  expect(h.drain(6800)).toMatchObject([{role:'assistant',text:' Blue Moon.',partial:false}])
})
