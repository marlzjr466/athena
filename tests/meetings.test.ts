// @vitest-environment node
import { describe,it,expect } from 'vitest'
import { mkdtemp,appendFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { MeetingRepository } from '../electron/main/meetings/meetingRepository'
import { meetingCommandSchema, meetingDocument, detectedQuestion, meetingPreferencesSchema } from '../shared/meetings'
import { pcmWav } from '../src/features/meetings/meetingCapture'

describe('Meeting Intelligence persistence and audio',()=>{
  it('starts with all capture and cloud capabilities off',()=>{const p=meetingPreferencesSchema.parse({});for(const key of ['microphone','system','screenConsent','aiConsent','cloudConsent','retainAudio','retainScreens'] as const)expect(p[key]).toBe(false);expect(p.provider).toBe('local')})
  it('journals segments, recovers interrupted recordings and preserves source labels independently of chat',async()=>{
    const root=await mkdtemp(join(tmpdir(),'athena-meetings-')),repo=new MeetingRepository(root),s=await repo.create('Design review','technical')
    s.status='recording';s.draft='Unsent question';await repo.save(s)
    const v={id:randomUUID(),source:'system' as const,start:1000,end:7000,text:'',speaker:'Remote',status:'pending' as const,audio:'clip.wav'}
    await repo.segment(s.id,v);await repo.segment(s.id,{...v,status:'complete',text:'Use mocks until the API is ready.'})
    const restored=await new MeetingRepository(root).load(s.id)
    expect(restored.status).toBe('interrupted');expect(restored.draft).toBe('Unsent question');expect(restored.segments).toHaveLength(1);expect(restored.segments[0].text).toContain('Use mocks')
    expect(meetingDocument(restored)).toContain('1970-01-01T00:00:01.000Z');expect((await repo.list())[0].id).toBe(s.id)
  })
  it('recovers a partial trailing journal write without discarding good segments',async()=>{
    const repo=new MeetingRepository(await mkdtemp(join(tmpdir(),'athena-journal-'))),s=await repo.create('Recovery','general')
    await repo.segment(s.id,{id:randomUUID(),source:'microphone',start:1,end:2,text:'Preserved',speaker:'Me',status:'complete'})
    await appendFile(repo.path(s.id,'transcript.jsonl'),'{"id":')
    expect((await repo.load(s.id)).segments[0].text).toBe('Preserved')
  })
  it('serializes concurrent saves without corrupting session metadata',async()=>{const repo=new MeetingRepository(await mkdtemp(join(tmpdir(),'athena-save-'))),s=await repo.create('One','general');const a=repo.save({...s,title:'Two'}),b=repo.save({...s,title:'Three'});await Promise.all([a,b]);expect((await repo.load(s.id)).title).toBe('Three')})
  it('rejects traversal, unbounded audio, and invalid provider preferences',()=>{
    const repo=new MeetingRepository('/tmp/meeting-test');expect(()=>repo.path('../outside','session.json')).toThrow();expect(()=>repo.path(randomUUID(),'../secret')).toThrow()
    expect(meetingCommandSchema.safeParse({action:'audio',id:randomUUID(),source:'system',start:0,end:1,bytes:new Uint8Array(600001)}).success).toBe(false)
    expect(meetingCommandSchema.safeParse({action:'preferences',patch:{provider:'unknown'}}).success).toBe(false)
  })
  it('writes valid 16 kHz PCM WAV with resampling and clipping',()=>{const bytes=pcmWav(new Float32Array(48000).fill(1.5),48000),v=new DataView(bytes.buffer);expect(Buffer.from(bytes.subarray(0,4)).toString()).toBe('RIFF');expect(v.getUint32(24,true)).toBe(16000);expect(v.getUint32(40,true)).toBe(32000);expect(v.getInt16(44,true)).toBe(32767)})
  it('extracts questions without treating ordinary statements as questions',()=>{expect(detectedQuestion('We need a fix. What is useMemo?')).toBe('What is useMemo?');expect(detectedQuestion('We agreed to use mocks.')).toBeUndefined()})
})

import { groundedNotes } from '../shared/meetingNotes'
it('rejects unsupported notes and strips invented owners or deadlines',()=>{
  const source={id:randomUUID(),source:'system' as const,start:1,end:2,text:'We agreed to use mocks.',speaker:'Remote',status:'complete' as const}
  expect(()=>groundedNotes(JSON.stringify({items:[{category:'decision',text:'Ship Friday',quote:'Ship Friday',owner:null,deadline:null}]}),[source])).toThrow('absent')
  expect(groundedNotes(JSON.stringify({items:[{category:'action',text:'Use mocks',quote:'We agreed to use mocks.',owner:'Alex',deadline:'Friday'}]}),[source])[0]).toMatchObject({owner:null,deadline:null,confirmed:false})
})

it('repairs an interrupted journal tail before accepting new transcript events',async()=>{
  const repo=new MeetingRepository(await mkdtemp(join(tmpdir(),'athena-repair-'))),s=await repo.create('Recovery','general')
  const first={id:randomUUID(),source:'system' as const,start:1,end:2,text:'First',speaker:'Remote',status:'complete' as const}
  await repo.segment(s.id,first);await appendFile(repo.path(s.id,'transcript.jsonl'),'{"truncated":')
  await repo.load(s.id)
  await repo.segment(s.id,{...first,id:randomUUID(),start:3,end:4,text:'Second'})
  expect((await repo.load(s.id)).segments.map(v=>v.text)).toEqual(['First','Second'])
})
it('accepts an exact displayed speaker prefix but does not treat the label as an assigned owner',()=>{
  const source={id:randomUUID(),source:'system' as const,start:1,end:2,text:'We agreed to use mocks.',speaker:'Remote',status:'complete' as const}
  expect(groundedNotes('{"items":[{"category":"decision","text":"Use mocks","quote":"Remote: We agreed to use mocks.","owner":"Remote","deadline":null}]}',[source])[0]).toMatchObject({quote:'We agreed to use mocks.',owner:null})
})
