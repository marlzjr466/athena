// @vitest-environment node
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

it.skipIf(process.platform !== 'darwin')('checks window hit targets, display coordinates and committed browser address text', async () => {
  const dir=await mkdtemp(join(tmpdir(),'athena-window-hit-'))
  try {
    // Compile the shipping decision functions. The normal executable entry is
    // disabled and this harness neither observes the desktop nor sends input.
    const source=await readFile('electron/main/desktop/desktopAccessibility.swift','utf8')
    const harness=`
let primary = CGRect(x:0, y:0, width:1920, height:1080)
precondition(mouseHitPoint(CGPoint(x:-600,y:1350),primary:primary) == CGPoint(x:-600,y:-270))
precondition(mouseHitPoint(CGPoint(x:2200,y:-400),primary:primary) == CGPoint(x:2200,y:1480))
func failure(_ id:Int,_ pid:pid_t?)->String? {
    do { try verifyMouseHit(target:42,hit:id,hitPid:pid,targetPid:10,athenaPid:20,overlay:77); return nil }
    catch let failure as WindowTargetFailure { return failure.code }
    catch { fatalError() }
}
// A click-through surface above 42 is omitted by the AppKit mouse hit test.
precondition(failure(42,10)==nil)
precondition(failure(43,10)=="window-target-sibling-obscured")
precondition(failure(44,30)=="window-target-obscured")
precondition(failure(42,30)=="window-target-obscured")
precondition(failure(76,20)=="window-target-athena-obscured")
precondition(failure(77,20)=="window-target-overlay-intercepts")
precondition(failure(77,30)=="window-target-obscured")
precondition(failure(0,nil)=="window-target-hit-unavailable")
precondition(failure(42,nil)=="window-target-hit-unavailable")
let page="https://www.example.test/"
for display in [page, "https://www.example.test", "www.example.test/", "www.example.test"] {
    precondition(displaysCommittedAddress(display,page))
}
for draft in ["", "draft query", "example.test", "www.example.test/draft", "www.example.test/?q=draft",
              "http://www.example.test/", "https://www.example.test@other.test/", " www.example.test", "www.example.test:8080"] {
    precondition(!displaysCommittedAddress(draft,page))
}
let path="https://www.example.test:8443/lookup?q=1#result"
precondition(displaysCommittedAddress("www.example.test:8443/lookup?q=1#result",path))
precondition(!displaysCommittedAddress("www.example.test:8443/lookup?q=2#result",path))
precondition(!displaysCommittedAddress("www.example.test:8443/lookup?q=1",path))
for chromium in ["com.google.Chrome","com.microsoft.edgemac"] {
    precondition(displaysCommittedAddress("example.test",page,browser:chromium,fullySelected:true))
    precondition(displaysCommittedAddress("example.test:8443/lookup?q=1#result",path,browser:chromium,fullySelected:true))
    precondition(!displaysCommittedAddress("example.test",page,browser:chromium,fullySelected:false))
    for draft in ["","https://example.test","example.test/new","example.test/lookup?q=1","example.test:8443/lookup?q=2#result"] {
        precondition(!displaysCommittedAddress(draft,path,browser:chromium,fullySelected:true))
    }
}
precondition(!displaysCommittedAddress("example.test",page,browser:"com.apple.Safari",fullySelected:true))
precondition(!displaysCommittedAddress("example.test",page,browser:"org.mozilla.firefox",fullySelected:true))
print("ok")`
    const entry=join(dir,'WindowHit.swift')
    await writeFile(entry, source+'\n'+harness)
    const {stdout}=await promisify(execFile)('/usr/bin/xcrun',['swift','-module-cache-path',join(tmpdir(),'athena-window-swift-cache'),'-D','ATHENA_WINDOW_HIT_TEST',entry],{timeout:55000})
    expect(stdout.trim()).toBe('ok')
  } finally {await rm(dir,{recursive:true,force:true})}
},60000)
