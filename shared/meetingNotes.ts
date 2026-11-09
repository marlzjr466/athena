import { z } from 'zod'
import type { MeetingSegment } from './meetings'
export const meetingNoteSchema=z.object({
  category:z.enum(['purpose','topic','decision','proposal','action','question','risk','blocker','technical','dependency','follow-up']),
  text:z.string().min(1).max(1000), quote:z.string().min(1).max(2000),
  owner:z.string().max(100).nullable().default(null), deadline:z.string().max(100).nullable().default(null),
}).strict()
export type MeetingNote=z.infer<typeof meetingNoteSchema>&{segmentId:string;timestamp:number;confirmed:boolean}
const normalize=(s:string)=>s.toLowerCase().replace(/\s+/g,' ').trim()
/** Require literal source evidence; uncertain paraphrases remain explicitly unconfirmed. */
export function groundedNotes(text:string,segments:MeetingSegment[], labels:Record<string,string>={}):MeetingNote[]{
  const json=text.trim().replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,'')
  const parsed=z.object({items:z.array(meetingNoteSchema).max(80)}).strict().parse(JSON.parse(json))
  return parsed.items.map(item=>{
    let quote=item.quote
    const source=segments.find(s=>{
      if(s.status!=='complete')return false
      const speaker=s.speakerOverride||labels[s.source]||s.speaker
      const prefixes=[`[${new Date(s.start).toISOString()}] ${speaker}: `,`${speaker}: `]
      let candidate=item.quote.trim()
      for(const prefix of prefixes)if(normalize(candidate).startsWith(normalize(prefix))) {candidate=candidate.slice(prefix.trimEnd().length).trimStart();break}
      if(!candidate || !normalize(s.text).includes(normalize(candidate)))return false
      quote=candidate;return true
    })
    if(!source)throw new Error('Notes contained a quote absent from the transcript. Prior notes were preserved. Retry or review the response.')
    return {...item,quote,owner:item.owner&&normalize(quote).includes(normalize(item.owner))?item.owner:null,deadline:item.deadline&&normalize(quote).includes(normalize(item.deadline))?item.deadline:null,segmentId:source.id,timestamp:source.start,confirmed:false}
  })
}
export function renderMeetingNotes(notes:MeetingNote[]):string{
  return notes.map(n=>`### ${n.category.toUpperCase()} — ${n.confirmed?'Confirmed by user':'AI interpretation · review required'}\n${n.text}\n${n.category==='action'?`Owner: ${n.owner||'Unassigned'} · Deadline: ${n.deadline||'Not specified'}\n`:''}> ${n.quote}\nSource: ${new Date(n.timestamp).toISOString()}`).join('\n\n')
}
