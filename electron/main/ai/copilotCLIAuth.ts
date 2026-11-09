import { spawn, execFile } from 'node:child_process'
import { access, realpath, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'
import { promisify, stripVTControlCharacters } from 'node:util'
import { managedProcessLifecycle } from './ownedProcess'
import type { CopilotCLIStatus } from '../../../shared/copilot'
import { ChatError } from './AIProvider'
const run = promisify(execFile)
export function copilotCandidates(env: NodeJS.ProcessEnv): string[] {
  return [...new Set([...(env.PATH ?? '').split(delimiter).filter(isAbsolute), join(homedir(), '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin', ...(process.platform === 'win32' ? [join(env.LOCALAPPDATA ?? homedir(), 'Microsoft/WinGet/Links')] : [])].map(dir=>join(dir, process.platform === 'win32' ? 'copilot.exe' : 'copilot')))]
}
export function loginDeviceCode(output: string): string | undefined {
  return stripVTControlCharacters(output).match(/(?:code[:\s]+)([A-Z0-9]{4}-[A-Z0-9]{4})\b/i)?.[1]
}
export class CopilotCLIAuth {
  status: CopilotCLIStatus = { installed:false, version:null, phase:'idle', message:'Check Copilot CLI installation.' }
  private stop?: ()=>Promise<void>
  private timer?: ReturnType<typeof setTimeout>
  private generation = 0
  constructor(private environment: ()=>NodeJS.ProcessEnv, private connected: ()=>Promise<void>) {}
  get running() { return ['starting','waiting','verifying'].includes(this.status.phase) }
  async discover() {
    for (const path of copilotCandidates(this.environment())) {
      try {
        await access(path,constants.X_OK); const resolved=await realpath(path)
        if (!(await stat(resolved)).isFile()) continue
        const {stdout}=await run(resolved,['--version'],{env:this.environment(),cwd:homedir(),timeout:10000,maxBuffer:8192,windowsHide:true})
        const version=stdout.match(/\b\d+\.\d+\.\d+(?:[-+][\w.-]+)?\b/)?.[0]
        if (!version) continue
        this.status={...this.status,installed:true,version}; return resolved
      } catch { /* Try the next installation; never execute a shell command. */ }
    }
    this.status={...this.status,installed:false,version:null,message:'Copilot CLI is not installed or could not run. Install the official GitHub Copilot CLI, then check again.'}
    throw new ChatError(this.status.message)
  }
  async start(flow:'browser'|'device') {
    if(this.running) throw new ChatError('A Copilot login is already in progress.')
    const executable=await this.discover()
    const {stdout}=await run(executable,['login','--help'],{env:this.environment(),cwd:homedir(),timeout:10000,maxBuffer:16000,windowsHide:true})
    const flag=flow==='browser'?'--web-flow':'--device-code'
    if(!stdout.includes(flag)) throw new ChatError('Installed Copilot CLI does not advertise this login flow. Update the official CLI.')
    const generation=++this.generation
    this.status={...this.status,phase:'starting',code:undefined,url:undefined,message:'Starting official GitHub sign-in…'}
    const child=spawn(executable,['login',flag],{cwd:homedir(),env:this.environment(),stdio:['pipe','pipe','pipe'],shell:false,detached:process.platform!=='win32',windowsHide:true})
    const lifecycle=managedProcessLifecycle(child,()=>{})
    this.stop=async()=>{ if(process.platform==='win32') child.kill(); else await lifecycle.dispose() }
    let output=''
    const receive=(chunk:Buffer)=>{
      if(generation!==this.generation)return
      // Retain only a bounded transient buffer, never persist raw auth output/URLs.
      output=(output+chunk.toString()).slice(-16384)
      const code=loginDeviceCode(output)
      this.status={...this.status,phase:'waiting',message:flow==='browser'?'Complete sign-in in your browser.':'Enter the one-time code on GitHub.',...(code?{code,url:'https://github.com/login/device'}:{})}
    }
    child.stdout?.on('data',receive);child.stderr?.on('data',receive)
    child.once('error',()=>{if(generation===this.generation){clearTimeout(this.timer);this.status={...this.status,phase:'failed',message:'Copilot login process could not start.'}}})
    child.once('close',code=>{
      if(generation!==this.generation)return
      clearTimeout(this.timer);this.stop=undefined;output=''
      if(code!==0){this.status={...this.status,phase:'failed',code:undefined,url:undefined,message:'Copilot login failed or authorization expired. Retry sign-in.'};return}
      this.status={...this.status,phase:'verifying',code:undefined,url:undefined,message:'Verifying GitHub identity…'}
      void this.connected().then(()=>{if(generation===this.generation)this.status={...this.status,phase:'connected',message:'GitHub identity verified. Copilot CLI connected.'}}).catch((error: unknown)=>{if(generation===this.generation)this.status={...this.status,phase:'failed',message:error instanceof ChatError ? error.message : 'Login finished, but SDK identity verification failed. Check the active CLI account and reconnect.'}})
    })
    this.timer=setTimeout(()=>void this.cancel('expired'),300000)
  }
  async cancel(phase:'cancelled'|'expired'='cancelled') {
    ++this.generation;clearTimeout(this.timer)
    const stop=this.stop;this.stop=undefined
    this.status={...this.status,phase,code:undefined,url:undefined,message:phase==='expired'?'GitHub sign-in timed out. Retry when ready.':'GitHub sign-in cancelled. No account connected by this attempt.'}
    await stop?.()
  }
}
