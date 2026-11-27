import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {win32} from 'node:path'
import type {AppIdentifier,VisualGesture} from '../../../shared/desktopActions'
import {ChatError} from '../ai/AIProvider'

// Native screen pixels are mapped from the approved capture after opting into
// per-monitor DPI awareness. Foreground, process, bounds and occlusion must match.
const program=String.raw`
$ErrorActionPreference='Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class PointerTarget {
  [StructLayout(LayoutKind.Sequential)] public struct Rect {public int L,T,R,B;}
  [StructLayout(LayoutKind.Sequential)] public struct Pt {public int X,Y;}
  [DllImport("user32")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr dpi);
  [DllImport("user32")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32")] public static extern bool GetCursorPos(out Pt point);
  [DllImport("user32")] public static extern IntPtr WindowFromPoint(Pt p);
  [DllImport("user32")] public static extern IntPtr GetAncestor(IntPtr hwnd,uint flag);
  [DllImport("user32")] public static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
  [DllImport("dwmapi")] public static extern int DwmGetWindowAttribute(IntPtr hwnd,uint attr,out Rect rect,int n);
  [StructLayout(LayoutKind.Sequential)] struct Mouse {public int dx,dy; public uint data,flags,time; public UIntPtr extra;}
  [StructLayout(LayoutKind.Sequential)] struct Input {public uint type;public Mouse m;}
  [DllImport("user32")] static extern uint SendInput(uint n,Input[] inputs,int size);
  [DllImport("user32")] static extern int GetSystemMetrics(int index);
  public static void MoveOrPress(int x,int y,uint flags,int data=0) {
    int w=GetSystemMetrics(78),h=GetSystemMetrics(79);
    if(w<=1||h<=1)throw new Exception();
    var input=new Input{m=new Mouse{dx=(int)Math.Round((x-GetSystemMetrics(76))*65535.0/(w-1)),dy=(int)Math.Round((y-GetSystemMetrics(77))*65535.0/(h-1)),data=unchecked((uint)data),flags=flags|1U|32768U|16384U}};
    if(SendInput(1,new[]{input},Marshal.SizeOf(typeof(Input)))!=1)throw new Exception();
  }
}
'@
[void][PointerTarget]::SetThreadDpiAwarenessContext([IntPtr](-4))
$h=[IntPtr][long]$q.id
[uint32]$owner=0
[void][PointerTarget]::GetWindowThreadProcessId($h,[ref]$owner)
if((Get-Process -Id $owner).ProcessName -ne $q.process){throw 'Unexpected owner'}
function Bounds {$r=New-Object PointerTarget+Rect;if([PointerTarget]::DwmGetWindowAttribute($h,9,[ref]$r,16)-ne 0){throw 'No bounds'};$r}
$rect=Bounds;$w=$rect.R-$rect.L;$height=$rect.B-$rect.T
if($w -le 0 -or $height -le 0 -or [math]::Abs(($w/$height)/($q.width/$q.height)-1) -gt .015){throw 'Capture dimensions changed'}
function Position($v){
 if($v.x -lt 0 -or $v.y -lt 0 -or $v.x -ge $q.width -or $v.y -ge $q.height){throw 'Outside window'}
 $p=New-Object PointerTarget+Pt;$p.X=$rect.L+[math]::Floor(($v.x+.5)*$w/$q.width);$p.Y=$rect.T+[math]::Floor(($v.y+.5)*$height/$q.height);$p
}
function Check($p){
 if([IO.File]::Exists($q.cancelFile)){throw "Cancelled"}
 $r=Bounds
 if($r.L -ne $rect.L -or $r.R -ne $rect.R -or $r.T -ne $rect.T -or $r.B -ne $rect.B -or [PointerTarget]::GetForegroundWindow() -ne $h -or [PointerTarget]::GetAncestor([PointerTarget]::WindowFromPoint($p),2) -ne $h){throw 'Window changed or is obscured'}
}
$p=Position $q.from;Check $p
$path=@()
if($q.to){
 $end=Position $q.to
 foreach($i in 1..10){$pt=New-Object PointerTarget+Pt;$pt.X=$p.X+($end.X-$p.X)*$i/10;$pt.Y=$p.Y+($end.Y-$p.Y)*$i/10;Check $pt;$path+=$pt}
}
if($q.expected -and ($rect.L -ne $q.expected.x -or $rect.T -ne $q.expected.y -or $w -ne $q.expected.width -or $height -ne $q.expected.height)){throw 'The window moved after highlighting'}
if($q.preview){@{ok=$true;frame=@{x=$rect.L;y=$rect.T;width=$w;height=$height};point=@{x=$p.X;y=$p.Y}} | ConvertTo-Json -Depth 3 -Compress;exit}
if($q.path){if($q.path.Count -gt 100){throw 'Drag too long'};$path=@(foreach($v in $q.path){$pt=Position $v;Check $pt;$pt})}
if($q.operation -eq 'move'){
 Check $p;[PointerTarget]::MoveOrPress($p.X,$p.Y,0,0)
 $actual=New-Object PointerTarget+Pt
 if(![PointerTarget]::GetCursorPos([ref]$actual) -or [Math]::Abs($actual.X-$p.X) -gt 2 -or [Math]::Abs($actual.Y-$p.Y) -gt 2){throw 'The pointer could not be verified'}
 exit
}
if($q.operation -eq 'scroll'){
 foreach($v in @($q.scrollX,$q.scrollY)){if([Math]::Abs([int]$v) -gt 2400){throw 'Unsupported scroll distance'}}
 Check $p
 if($q.scrollY){[PointerTarget]::MoveOrPress($p.X,$p.Y,2048,-[int]$q.scrollY)}
 if($q.scrollX){Check $p;[PointerTarget]::MoveOrPress($p.X,$p.Y,4096,[int]$q.scrollX)}
 exit
}
if($q.operation -eq 'double_click'){Check $p;[PointerTarget]::MoveOrPress($p.X,$p.Y,2,0);[PointerTarget]::MoveOrPress($p.X,$p.Y,4,0)}
$pressed=$false
try{Check $p;[PointerTarget]::MoveOrPress($p.X,$p.Y,2,0);$pressed=$true;foreach($pt in $path){Check $pt;[PointerTarget]::MoveOrPress($pt.X,$pt.Y,0,0);$p=$pt}}
finally{if($pressed){[PointerTarget]::MoveOrPress($p.X,$p.Y,4,0)}}
`
export async function pointAtWindowsWindow(app:AppIdentifier,input:{id:number;width:number;height:number;from:VisualGesture['from'];to?:VisualGesture['to'];cancelFile:string;preview?:boolean;expected?:import('../../../shared/desktopActions').DesktopRect}) {
  const processNames:Partial<Record<AppIdentifier,string>>={vscode:'Code',edge:'msedge',chrome:'chrome',firefox:'firefox',finder:'explorer',calculator:'CalculatorApp',cursor:'Cursor',teams:'ms-teams',excel:'EXCEL',word:'WINWORD',slack:'slack',spotify:'Spotify',discord:'Discord'}
  const name=processNames[app]
  if(!name)throw new ChatError('Visual input is unavailable for this application.')
  const data=Buffer.from(JSON.stringify({...input,process:name})).toString('base64')
  const source="$q=([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('"+data+"'))|ConvertFrom-Json)\n"+program
  const executable=win32.join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe')
  const {stdout}=await promisify(execFile)(executable,['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(source,'utf16le').toString('base64')],{timeout:6500,windowsHide:true,maxBuffer:4096})
    .catch(()=>{throw new ChatError('Windows could not verify input on the selected foreground window. Inspect it before continuing.')})
  return input.preview?JSON.parse(stdout):{ok:true}
}
