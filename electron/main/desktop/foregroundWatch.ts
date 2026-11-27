import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { join,win32 } from 'node:path'
import { app } from 'electron'

export interface FocusStamp {pid:number;window:string;bounds?:{x:number;y:number;width:number;height:number}}
const windowsWatch = String.raw`
Add-Type 'using System;using System.Runtime.InteropServices;public class FocusWatch{[DllImport("user32.dll")]public static extern IntPtr GetForegroundWindow();[DllImport("user32.dll")]public static extern uint GetWindowThreadProcessId(IntPtr w,out int p);[StructLayout(LayoutKind.Sequential)]public struct Rect{public int x,y,r,b;}[DllImport("user32.dll")]public static extern bool GetWindowRect(IntPtr w,out Rect rect);}'
$prev='';$clock=[Diagnostics.Stopwatch]::StartNew()
while($clock.Elapsed.TotalSeconds -lt 120){$h=[FocusWatch]::GetForegroundWindow();$p=0;[void][FocusWatch]::GetWindowThreadProcessId($h,[ref]$p);$r=New-Object FocusWatch+Rect;[void][FocusWatch]::GetWindowRect($h,[ref]$r);$line=@{pid=$p;window="$h";bounds=@{x=$r.x;y=$r.y;width=$r.r-$r.x;height=$r.b-$r.y}}|ConvertTo-Json -Compress;if($line -ne $prev){[Console]::WriteLine($line);$prev=$line};Start-Sleep -Milliseconds 120}
`
/** One native observer shared by simultaneous, authorized actions, released with the last listener. */
export class ForegroundWatch {
  private listeners=new Set<(value:FocusStamp)=>void>()
  private stop?:()=>void
  subscribe(listener:(value:FocusStamp)=>void) {
    this.listeners.add(listener)
    if(!this.stop && ['win32','darwin'].includes(process.platform)){
      const mac=process.platform==='darwin'
      const executable=mac?(app.isPackaged?join(process.resourcesPath,'native','athena-desktop-accessibility'):join(app.getAppPath(),'build','native','athena-desktop-accessibility')):
        win32.join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe')
      const child=spawn(executable,mac?['watch-focus']:['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(windowsWatch,'utf16le').toString('base64')],{windowsHide:true,stdio:['ignore','pipe','ignore']})
      const stream=createInterface({input:child.stdout})
      stream.on('line',line=>{try{const value=JSON.parse(line);if(Number.isInteger(value.pid)&&typeof value.window==='string')for(const fn of this.listeners)fn(value)}catch{/* Incomplete native event. */}})
      const stop=()=>{stream.close();if(!child.killed)child.kill();this.stop=undefined}
      this.stop=stop
      child.once('error',()=>{if(this.stop===stop)stop()})
      child.once('exit',()=>{if(this.stop===stop)this.stop=undefined;stream.close()})
    }
    return ()=>{this.listeners.delete(listener);if(!this.listeners.size)this.stop?.()}
  }
  dispose(){this.listeners.clear();this.stop?.()}
}
