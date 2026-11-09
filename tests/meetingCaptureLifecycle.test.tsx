import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { meetingPreferencesSchema, type MeetingAPI, type MeetingSession } from '../shared/meetings'
const captures=vi.hoisted(()=>[] as Array<{source:string;start:ReturnType<typeof vi.fn>;stop:ReturnType<typeof vi.fn>}>)
vi.mock('../src/features/meetings/meetingCapture',()=>({MeetingCapture:class{
  start=vi.fn(async()=>{});stop=vi.fn()
  constructor(_api:unknown,public source:string){captures.push(this)}
}}))
import { useMeetingCapture } from '../src/features/meetings/useMeetingCapture'
beforeEach(()=>{captures.length=0})
describe('independent meeting audio sources',()=>{
  it('keeps system capture running across microphone disconnection and model switching',()=>{
    const api={} as MeetingAPI,level=vi.fn(),error=vi.fn()
    const session:MeetingSession={id:'fixture',createdAt:0,title:'Fixture',status:'recording',preferences:meetingPreferencesSchema.parse({microphone:true,system:true,systemSource:'screen:0:0'}),speakers:{microphone:'You',system:'Remote'},draft:'',notes:'',segments:[],answers:[],screenReferences:[]}
    const {rerender,unmount}=renderHook(({s}:{s:MeetingSession})=>{
      useMeetingCapture(api,'microphone',s,true,level,error)
      useMeetingCapture(api,'system',s,true,level,error)
    },{initialProps:{s:session}})
    const mic=captures.find(c=>c.source==='microphone')!,system=captures.find(c=>c.source==='system')!
    rerender({s:{...session,preferences:{...session.preferences,microphone:false,model:'new-model'}}})
    expect(mic.stop).toHaveBeenCalledTimes(1);expect(system.stop).not.toHaveBeenCalled();expect(captures).toHaveLength(2)
    rerender({s:{...session,status:'paused'}})
    expect(system.stop).toHaveBeenCalledTimes(1);expect(captures).toHaveLength(2)
    unmount()
  })
  it('opening either meeting view never begins audio capture without recording',()=>{
    const api={} as MeetingAPI,callback=vi.fn()
    const {unmount}=renderHook(()=>useMeetingCapture(api,'microphone',undefined,true,callback,callback))
    expect(captures).toHaveLength(0);unmount()
  })
})
