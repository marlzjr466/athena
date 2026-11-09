import { useEffect, useRef } from 'react'
import type { MeetingAPI, MeetingSession, MeetingSource } from '../../../shared/meetings'
import { MeetingCapture } from './meetingCapture'

/** Each source owns its lifecycle so a disconnected microphone cannot restart system capture. */
export function useMeetingCapture(api: MeetingAPI | undefined, source: MeetingSource, session: MeetingSession | undefined, floating: boolean, onLevel: (level: number) => void, onError: (error: string) => void) {
  const callbacks=useRef({onLevel,onError});callbacks.current={onLevel,onError}
  const id=session?.id, enabled=floating&&session?.status==='recording'&&session.preferences[source]
  const device=source==='microphone'?session?.preferences.deviceId:'default'
  const display=source==='system'?session?.preferences.systemSource:''
  const partial=session?.preferences.partialTranscripts
  useEffect(()=>{
    if(!api||!id||!enabled)return
    const capture=new MeetingCapture(api,source,id,n=>callbacks.current.onLevel(n),e=>callbacks.current.onError(e))
    void capture.start(device||'default',partial)
    return()=>capture.stop()
  },[api,source,id,enabled,device,display,partial])
}
