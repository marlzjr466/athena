import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readdir, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, win32 } from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'
import { ChatError } from '../ai/AIProvider'
import { APPLICATIONS } from '../../../shared/desktopActions'

const execute = promisify(execFile)
export type InstalledOperation='open'|'inspect'|'click'|'set-text'|'scroll'|'shortcut'|'window'
export interface InstalledApplication { key:string; name:string; path:string }
const appName = z.string().trim().min(1).max(120)
export class InstalledApplications {
  private cache?: { at:number; apps:InstalledApplication[] }
  async list(signal:AbortSignal):Promise<InstalledApplication[]> {
    signal.throwIfAborted()
    if (this.cache && Date.now()-this.cache.at<30_000) return this.cache.apps
    const entries:Array<{name:string;path:string}> = []
    if (process.platform==='darwin') {
      const directories=['/Applications','/Applications/Utilities','/System/Applications','/System/Applications/Utilities',join(homedir(),'Applications')]
      for (const dir of directories) {
        signal.throwIfAborted()
        const files = await readdir(dir,{withFileTypes:true}).catch(()=>[])
        for (const entry of files) if (entry.isDirectory() && entry.name.endsWith('.app'))
          entries.push({name:basename(entry.name,'.app'),path:join(dir,entry.name)})
      }
    } else if (process.platform==='win32') {
      // Resolve registered shell applications. Entries without a plain executable target need a dedicated adapter.
      const script = "$ErrorActionPreference='Stop';$apps=(New-Object -ComObject Shell.Application).NameSpace('shell:AppsFolder');@($apps.Items() | ForEach-Object {$p=$_.ExtendedProperty('System.Link.TargetParsingPath');if($p -and [IO.Path]::GetExtension($p) -eq '.exe'){@{name=$_.Name;path=$p}}}) | ConvertTo-Json -Compress"
      const binary=win32.join(process.env.SystemRoot ?? 'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe')
      const {stdout}=await execute(binary,['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{signal,timeout:6000,windowsHide:true,maxBuffer:512*1024})
      const rows=JSON.parse(stdout.trim()||'[]')
      entries.push(...z.array(z.object({name:z.string(),path:z.string()})).parse(Array.isArray(rows)?rows:[rows]).filter(e=>/^[A-Za-z]:\\/.test(e.path)))
    }
    const found=new Map<string,InstalledApplication>()
    for (const entry of entries.slice(0,1000)) {
      signal.throwIfAborted()
      if (!appName.safeParse(entry.name).success || Object.values(APPLICATIONS).some(app=>app.name.toLowerCase()===entry.name.toLowerCase())) continue
      const path=await realpath(entry.path).catch(()=>undefined)
      if (!path || path!==entry.path && process.platform==='darwin') continue
      const identity = await stat(process.platform==='darwin'?join(path,'Contents','Info.plist'):path).catch(()=>undefined)
      if (!identity) continue
      const key=createHash('sha256').update([path,identity.dev,identity.ino,identity.size,identity.mtimeMs].join('|')).digest('hex')
      found.set(key,{key,name:entry.name,path})
    }
    const apps=Array.from(found.values()).sort((a,b)=>a.name.localeCompare(b.name))
    this.cache={at:Date.now(),apps}
    return apps
  }
  async resolve(name:string,allowed:(key:string)=>boolean,signal:AbortSignal) {
    const term=appName.parse(name).toLowerCase()
    const matches=(await this.list(signal)).filter(app=>app.name.toLowerCase()===term && allowed(app.key))
    if(matches.length!==1)throw new ChatError('Choose a unique installed application under AI → Computer use → Authorized applications.')
    const app=matches[0], path=await realpath(app.path)
    const identity=await stat(process.platform==='darwin'?join(path,'Contents','Info.plist'):path)
    const key=createHash('sha256').update([path,identity.dev,identity.ino,identity.size,identity.mtimeMs].join('|')).digest('hex')
    if(key!==app.key)throw new ChatError('The registered application changed. Authorize the updated installation.')
    const info=await stat(path)
    if(path!==app.path || !(process.platform==='darwin'?info.isDirectory():info.isFile()))throw new ChatError('The installed application changed. Check its authorization again.')
    signal.throwIfAborted()
    return app
  }
  async foreground(active:{name:string;app:string},allowed:(key:string)=>boolean,signal:AbortSignal) {
    const names=(await this.list(signal)).filter(target=>allowed(target.key) && (target.name.toLowerCase()===active.name.toLowerCase() ||
      process.platform==='win32' && win32.basename(target.path,'.exe').toLowerCase()===active.app.toLowerCase()))
    return names.length===1 ? this.resolve(names[0].name,allowed,signal) : undefined
  }
}
