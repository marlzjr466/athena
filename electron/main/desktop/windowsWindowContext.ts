// A fixed UIA/Win32 program. The main process supplies typed JSON data in $request.
export const windowsWindowContext = String.raw`
Add-Type 'using System; using System.Runtime.InteropServices; public class AthenaWin { [DllImport("user32.dll")]public static extern bool IsIconic(IntPtr h); [DllImport("user32.dll")]public static extern bool IsZoomed(IntPtr h); [DllImport("user32.dll")]public static extern bool IsWindowVisible(IntPtr h); [DllImport("user32.dll")]public static extern bool ShowWindowAsync(IntPtr h,int state); [DllImport("user32.dll")]public static extern uint GetWindowThreadProcessId(IntPtr h,out int pid); [DllImport("user32.dll")]public static extern IntPtr GetTopWindow(IntPtr h); [DllImport("user32.dll")]public static extern IntPtr GetWindow(IntPtr h,int cmd); }'
function Owner($h) { $ownerId=0; [void][AthenaWin]::GetWindowThreadProcessId($h,[ref]$ownerId); return $ownerId }
function Windows($ids) {
  $h=[AthenaWin]::GetTopWindow([IntPtr]::Zero); $seen=@{}; $count=0
  while ($h -ne [IntPtr]::Zero -and -not $seen.ContainsKey($h) -and $count -lt 2048) {
    $seen[$h]=$true; $count++; if ($ids -contains (Owner $h) -and [AthenaWin]::IsWindowVisible($h) -and [AthenaWin]::GetWindow($h,4) -eq [IntPtr]::Zero) {$h}
    $h=[AthenaWin]::GetWindow($h,2)
  }
}
function ChromeControls($w, $includeDocument=$false) {
  $queue=New-Object System.Collections.Queue; $queue.Enqueue($w); $walker=[System.Windows.Automation.TreeWalker]::ControlViewWalker; $count=0
  while ($queue.Count -gt 0 -and $count -lt 1300) {
    $e=$queue.Dequeue(); $count++; $kind=$e.Current.ControlType.ProgrammaticName
    if ($e.Current.IsPassword) {continue}
    if ($kind -eq 'ControlType.Document') {if($includeDocument -and -not $e.Current.IsOffscreen){$e};continue}
    if ($kind -eq 'ControlType.TabItem' -or $kind -eq 'ControlType.Edit') {$e}
    for ($c=$walker.GetFirstChild($e); $null -ne $c; $c=$walker.GetNextSibling($c)) {$queue.Enqueue($c)}
  }
}
function TabId($e) {return ($e.GetRuntimeId() -join '.')}
function Tabs($handle) {
  $root=[System.Windows.Automation.AutomationElement]::FromHandle($handle)
  @(ChromeControls $root) | Where-Object {$_.Current.ControlType -eq [System.Windows.Automation.ControlType]::TabItem}
}
function IsSelected($e) { return $e.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Current.IsSelected }
function WaitState($test) { $sw=[Diagnostics.Stopwatch]::StartNew(); do {if (& $test){return $true}; Start-Sleep -Milliseconds 35} while($sw.ElapsedMilliseconds -lt 1800); return $false }
function Fail($message) { @{error=$message}|ConvertTo-Json -Compress; exit }
$r=$request.workspace; $front=[AthenaWindow]::GetForegroundWindow()
$targets=@(Get-Process | Where-Object {if($r.path){$_.Path -eq $r.path}else{$_.ProcessName -eq $names[$request.app]}})
$ids=@($targets | ForEach-Object {$_.Id})
$handles=@(Windows $ids)
if($r.pid) {$handles=@($handles | Where-Object {(Owner $_) -eq $r.pid})}
$preferred=$handles | Select-Object -First 1
if($handles -contains $front) {$preferred=$front}
$ownerId=if($preferred){Owner $preferred}else{0}
if($r.operation -eq 'observe'){
  $views=@(foreach($h in $handles){if((Owner $h) -ne $ownerId){continue}
    $v=@{id="$h";captureId=("window:"+$h+":0");focused=($preferred -eq $h);minimized=[AthenaWin]::IsIconic($h);maximized=[AthenaWin]::IsZoomed($h);hidden=$false}
    if($r.details) {
      $el=[System.Windows.Automation.AutomationElement]::FromHandle($h);$b=$el.Current.BoundingRectangle
      if($b.Width -gt 0 -and $b.Height -gt 0){$v.bounds=@{x=$b.X;y=$b.Y;width=$b.Width;height=$b.Height}}
    }
    if($r.tabs){
      $items=@(ChromeControls ([System.Windows.Automation.AutomationElement]::FromHandle($h)) ($h -eq $front))
      $v.tabs=@(foreach($e in ($items | Where-Object {$_.Current.ControlType -eq [System.Windows.Automation.ControlType]::TabItem})){$tab=@{id=(TabId $e);title=$e.Current.Name;selected=(IsSelected $e)};$b=$e.Current.BoundingRectangle;if($b.Width -gt 0 -and $b.Height -gt 0){$tab.bounds=@{x=$b.X;y=$b.Y;width=$b.Width;height=$b.Height}};$tab})
      if($h -eq $front){
        $docs=@($items | Where-Object {$_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Document})
        $selected=@($items | Where-Object {$_.Current.ControlType -eq [System.Windows.Automation.ControlType]::TabItem -and (IsSelected $_)})
        if($docs.Count -eq 1 -and $selected.Count -eq 1){try{
          $address=$docs[0].GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value
          $uri=$null
          if($address.Length -le 2048 -and [Uri]::TryCreate($address,[UriKind]::Absolute,[ref]$uri) -and $uri.Scheme -in @('https','http') -and -not $uri.UserInfo -and [AthenaWindow]::GetForegroundWindow() -eq $h -and (IsSelected $selected[0])){$v.address=$address}
        }catch{}}
      }
    }
    $v
  })
  $role=if($r.details -and $handles -contains $front){[System.Windows.Automation.AutomationElement]::FocusedElement.Current.ControlType.ProgrammaticName}else{''}
  @{running=($ids.Count -gt 0);pid=$ownerId;foreground=(Owner $front);focused=($handles -contains $front);windows=$views;focusRole=$role}|ConvertTo-Json -Depth 7 -Compress;exit
}
if($r.foregroundWindow -and $r.foregroundWindow -ne "$preferred"){Fail 'The active window changed. Inspect the new window.'}
if($r.foreground -ne (Owner $front)){Fail 'The foreground application changed. Reassess the active window.'}
$h=$preferred
if($r.window){$h=$handles | Where-Object {"$_" -eq $r.window} | Select-Object -First 1}
if(-not $h){Fail 'The requested application window is unavailable.'}
if($r.tab -and -not (@(Tabs $h) | Where-Object {(TabId $_) -eq $r.tab -and (IsSelected $_)})){Fail 'The active tab changed. Inspect the current window again.'}
if([AthenaWin]::IsIconic($h)){[void][AthenaWin]::ShowWindowAsync($h,9)}
if($front -ne $h){[void][AthenaWindow]::SetForegroundWindow($h)}
if(-not (WaitState {([AthenaWindow]::GetForegroundWindow() -eq $h) -and -not [AthenaWin]::IsIconic($h)})){Fail 'The requested window did not gain focus.'}
function SendFixed($keys){if([AthenaWindow]::GetForegroundWindow() -ne $h){Fail 'Focus changed before input.'}; [System.Windows.Forms.SendKeys]::SendWait($keys)}
$old=@(Tabs $h)
switch($r.operation) {
  'new-tab' {if(-not $old.Count){Fail 'The browser does not expose its tab bar.'};SendFixed '^t';if(-not (WaitState {([AthenaWindow]::GetForegroundWindow() -eq $h) -and (@(Tabs $h).Count -eq $old.Count+1) -and (@(Windows $ids).Count -eq $handles.Count)})){Fail 'Tab creation was submitted once and could not be verified.'}}
  'new-window' {SendFixed '^n';if(-not (WaitState {$new=[AthenaWindow]::GetForegroundWindow();($ids -contains (Owner $new)) -and ($handles -notcontains $new)})){Fail 'The new browser window could not be verified.'};$h=[AthenaWindow]::GetForegroundWindow()}
  'select' {$matches=@($old | Where-Object {(TabId $_) -eq $r.query});if($matches.Count -ne 1){Fail 'The requested tab changed.'}; $matches[0].GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Select();if(-not (WaitState {(IsSelected $matches[0])})){Fail 'Tab selection could not be verified.'}}
  'close-tab' {if($old.Count -lt 2){Fail 'The last tab would close the window.'}; SendFixed '^w';if(-not (WaitState {@(Tabs $h).Count -eq $old.Count-1})){Fail 'Closing the tab could not be verified.'}}
  {$_ -in 'back','forward'} {$before=[System.Windows.Automation.AutomationElement]::FromHandle($h).Current.Name; if($_ -eq 'back'){SendFixed '%{LEFT}'}else{SendFixed '%{RIGHT}'};if(-not (WaitState {[System.Windows.Automation.AutomationElement]::FromHandle($h).Current.Name -ne $before})){Fail 'Navigation could not be verified.'}}
  {$_ -in 'activate','current','navigate'} {}
  default {Fail 'Unsupported browser window action.'}
}
if($r.url) {
  SendFixed '^l'
  $f=[System.Windows.Automation.AutomationElement]::FocusedElement
  if($f.Current.IsPassword -or $f.Current.ControlType -ne [System.Windows.Automation.ControlType]::Edit -or $f.Current.Name -notmatch 'address|location|search bar' -or ((@(ChromeControls ([System.Windows.Automation.AutomationElement]::FromHandle($h))) | Where-Object {(TabId $_) -eq (TabId $f)}).Count -ne 1)){Fail 'The browser address field could not be verified.'}
  $v=$f.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern);$v.SetValue($r.url)
  if($v.Current.Value -ne $r.url){Fail 'The requested address could not be verified.'};SendFixed '{ENTER}'
  if(-not (WaitState {([AthenaWindow]::GetForegroundWindow() -eq $h) -and -not $f.Current.HasKeyboardFocus -and ($v.Current.Value -eq $r.url -or ('https://'+$v.Current.Value+'/') -eq $r.url)})){Fail 'The address was submitted but the new page could not be verified.'}
}
@{ok=$true;message='Verified the requested action in the selected window.'}|ConvertTo-Json -Compress;exit
`
