import { mkdir, readFile, writeFile, rename, readdir, appendFile, rm, truncate } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { meetingPreferencesSchema, type MeetingSession, type MeetingSegment } from '../../../shared/meetings'
export class MeetingRepository {
  private writes = Promise.resolve()
  constructor(readonly root: string) {}
  path(id: string, file: string) { if (!/^[a-f\d-]{36}$/i.test(id) || !/^[a-zA-Z0-9.-]+$/.test(file)) throw new Error('Invalid meeting reference'); return join(this.root, id, file) }
  async create(title: string, template: MeetingSession['preferences']['template']) {
    const s: MeetingSession = { id: randomUUID(), title, createdAt: Date.now(), status: 'ready', preferences: meetingPreferencesSchema.parse({ template }), speakers: { microphone: 'You (microphone)', system: 'Remote audio (speakers unassigned)' }, draft: '', notes: '', segments: [], answers: [], screenReferences: [] }
    await this.save(s); return s
  }
  async save(s: MeetingSession) {
    const { segments: _, ...metadata } = s
    const json = JSON.stringify(metadata), id = s.id
    const write = this.writes.catch(() => {}).then(async () => { await mkdir(join(this.root,id), {recursive:true,mode:0o700}); const p=this.path(id,'session.json'); await writeFile(p+'.tmp',json,{mode:0o600}); await rename(p+'.tmp',p) })
    this.writes = write; return write
  }
  async segment(id: string, value: MeetingSegment) { await appendFile(this.path(id, 'transcript.jsonl'), JSON.stringify(value) + '\n', { mode: 0o600 }) }
  async load(id: string): Promise<MeetingSession> {
    const s = JSON.parse(await readFile(this.path(id, 'session.json'), 'utf8')) as MeetingSession
    if (s.id !== id) throw new Error('Meeting reference mismatch')
    s.preferences = meetingPreferencesSchema.parse(s.preferences)
    const map = new Map<string, MeetingSegment>()
    const journal = await readFile(this.path(id, 'transcript.jsonl'), 'utf8').catch((error: NodeJS.ErrnoException) => { if(error.code==='ENOENT')return ''; throw error })
    const lines = journal.split('\n')
    for (let i = 0; i < lines.length; i++) { if (!lines[i]) continue; try { const v = JSON.parse(lines[i]) as MeetingSegment; map.set(v.id, v) } catch { if (i < lines.length - 2) throw new Error('Transcript journal damaged. Original files preserved.');
      await writeFile(this.path(id, `recovered-tail-${Date.now()}.txt`), lines.slice(i).join('\n'), {mode:0o600});
      await truncate(this.path(id,'transcript.jsonl'),Buffer.byteLength(lines.slice(0,i).join('\n')+(i?'\n':'')));
      break; } }
    if(journal && !journal.endsWith('\n') && lines.at(-1)) { try { JSON.parse(lines.at(-1)!); await appendFile(this.path(id,'transcript.jsonl'),'\n') } catch { /* tail was archived above */ } }
    s.segments = [...map.values()].sort((a,b) => a.start - b.start)
    for (const a of s.answers) if (a.status === 'streaming') a.status = 'stopped'
    if (s.status === 'recording' || s.status === 'paused') s.status = 'interrupted'
    for (const v of s.segments) if (v.status === 'pending') { v.status = 'error'; v.error = 'Interrupted. Retry local transcription.' }
    return s
  }
  async list() { await mkdir(this.root, { recursive: true, mode: 0o700 }); const result = []; for (const id of await readdir(this.root)) { if (!/^[a-f\d-]{36}$/i.test(id)) continue; try { const s = JSON.parse(await readFile(this.path(id,'session.json'),'utf8')); result.push({ id, title: String(s.title), createdAt: Number(s.createdAt), status: s.status as MeetingSession['status'] }) } catch { /* Unreadable sessions remain on disk for recovery. */ } } return result.sort((a,b) => b.createdAt-a.createdAt) }
  async delete(id: string) { await rm(this.path(id, 'session.json').replace(/[/\\]session\.json$/, ''), { recursive: true, force: true }) }
}
