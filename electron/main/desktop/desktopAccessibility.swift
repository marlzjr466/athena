import AppKit
import ApplicationServices
import CryptoKit
import Foundation

// Bounded native AX observation/action helper. No scripts, shell, coordinates,
// arbitrary key sequences, or OS permission changes are accepted.
struct Failure: Error { let message: String }
struct WindowTargetFailure: Error { let code: String; let message: String }
func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
}
func text(_ value: CFTypeRef?) -> String {
    if let value = value as? NSAttributedString { return value.string }
    if let value = value as? String { return value }
    if let value = value as? NSNumber { return value.stringValue }
    return ""
}
func label(_ element: AXUIElement) -> String {
    for key in ["AXTitle", "AXDescription", "AXAttributedDescription", "AXIdentifier", "AXRoleDescription"] {
        let value = text(attribute(element, key))
        if !value.isEmpty { return String(value.prefix(160)) }
    }
    return ""
}
func secure(_ element: AXUIElement) -> Bool {
    let role = text(attribute(element, "AXRole")) + text(attribute(element, "AXSubrole"))
    return role.contains("Secure") || (label(element)+" "+text(attribute(element,"AXPlaceholderValue"))).range(of: "password|secret|token|credential", options: [.regularExpression, .caseInsensitive]) != nil
}
func pageTextRole(_ role:String) -> Bool {
    ["AXTextField","AXTextArea","AXSearchField","AXComboBox"].contains(role)
}
func pageFieldLabel(_ element:AXUIElement) -> String {
    for key in ["AXTitle","AXDescription","AXPlaceholderValue"] {
        let name=text(attribute(element,key)).trimmingCharacters(in:.whitespacesAndNewlines)
        if !name.isEmpty { return String(name.prefix(160)) }
    }
    if let owner=axElement(element,"AXTitleUIElement"),!secure(owner) {
        let name=text(attribute(owner,"AXTitle"))
        if !name.isEmpty {return String(name.prefix(160))}
        if text(attribute(owner,"AXRole"))=="AXStaticText" {
            let name=text(attribute(owner,"AXValue"))
            if !name.isEmpty {return String(name.prefix(160))}
        }
    }
    // This opaque reference is re-resolved in the same observed document.
    return "Unlabeled "+text(attribute(element,"AXRole")).replacingOccurrences(of:"AX",with:"")+" · "+String(CFHash(element),radix:16)
}
func searchForm(_ element:AXUIElement, _ document:AXUIElement) -> AXUIElement? {
    var parent=axElement(element,"AXParent")
    for _ in 0..<24 {
        guard let owner=parent,!CFEqual(owner,document) else {break}
        if text(attribute(owner,"AXSubrole"))=="AXLandmarkSearch" || text(attribute(owner,"AXARIARole")).lowercased()=="search" {return owner}
        parent=axElement(owner,"AXParent")
    }
    return nil
}
func isSearchField(_ element:AXUIElement, _ document:AXUIElement) -> Bool {
    if text(attribute(element,"AXRole"))=="AXSearchField" || text(attribute(element,"AXSubrole"))=="AXSearchField" {return true}
    if text(attribute(element,"AXDOMInputType")).lowercased()=="search" || text(attribute(element,"AXARIARole")).lowercased()=="searchbox" {return true}
    return searchForm(element,document) != nil
}
// Stays within the local executor. The planner receives neither the field's
// previous text nor its fingerprint. A changed draft invalidates the edit.
func searchValueStamp(_ element:AXUIElement) -> String? {
    guard let value=attribute(element,"AXValue") as? String else {return nil}
    var pid:pid_t=0
    guard AXUIElementGetPid(element,&pid) == .success else {return nil}
    let scope=String(pid)+":"+String(CFHash(element))+":"
    return SHA256.hash(data:Data((scope+value).utf8)).map{String(format:"%02x",$0)}.joined()
}
func within(_ element:AXUIElement, _ owner:AXUIElement, _ document:AXUIElement) -> Bool {
    var current:AXUIElement?=element
    for _ in 0..<24 {
        guard let node=current else {break}
        if CFEqual(node,owner) {return true}
        if CFEqual(node,document) {break}
        current=axElement(node,"AXParent")
    }
    return false
}
func searchButton(in form:AXUIElement, document:AXUIElement, items:[(AXUIElement,[String:Any])]) -> (AXUIElement,[String:Any])? {
    let buttons=items.filter { pair in
        guard pair.1["role"] as? String=="AXButton",pair.1["enabled"] as? Bool==true,
              ["search","submit search","submit search query"].contains((pair.1["label"] as? String ?? "").trimmingCharacters(in:.whitespacesAndNewlines).lowercased()),
              let owner=searchForm(pair.0,document),CFEqual(form,owner) else {return false}
        var actions:CFArray?
        return AXUIElementCopyActionNames(pair.0,&actions) == .success && (actions as? [String])?.contains(kAXPressAction as String)==true
    }
    return buttons.count==1 ? buttons[0] : nil
}
func controls(_ window: AXUIElement, documentOnly: Bool = false) -> [(AXUIElement, [String: Any])] {
    var queue = [window], offset = 0, output: [(AXUIElement, [String: Any])] = [], seen = Set<CFHashCode>()
    while offset < queue.count && offset < 1000 && output.count < 120 {
        let element = queue[offset]; offset += 1
        guard seen.insert(CFHash(element)).inserted else { continue }
        // Never traverse secure controls or return their contents.
        if secure(element) { continue }
        if documentOnly && !CFEqual(element,window) && ["AXWebArea","AXDocument","AXHTMLContent"].contains(text(attribute(element,"AXRole"))) {continue}
        if let children = attribute(element, "AXChildren") as? [AXUIElement] { queue.append(contentsOf: children.prefix(200)) }
        let role = text(attribute(element, "AXRole"))
        // Traverse browser layout containers without letting them consume the
        // 120 exported controls before reaching links, fields and readable text.
        if documentOnly && ["AXGroup","AXScrollArea","AXWebArea","AXDocument","AXHTMLContent"].contains(role) { continue }
        let name = documentOnly && pageTextRole(role) ? pageFieldLabel(element) : label(element)
        guard !name.isEmpty else { continue }
        var item: [String: Any] = ["label": name, "role": role, "enabled": (attribute(element, "AXEnabled") as? Bool) ?? true]
        if documentOnly && pageTextRole(role) && isSearchField(element,window) {
            item["searchField"]=true
            if let stamp=searchValueStamp(element) {
                item["searchFieldId"]=String(CFHash(element))
                item["searchValueStamp"]=stamp
            }
        }
        if (attribute(element,"AXFocused") as? Bool)==true {item["focused"]=true}
        if let frame=elementFrame(element) {item["bounds"]=rectData(frame)}
        if !pageTextRole(role) {
            let value = text(attribute(element, "AXValue"))
            if !value.isEmpty { item["value"] = String(value.prefix(500)) }
        }
        output.append((element, item))
    }
    return output
}
func json(_ value: Any) throws -> String { String(data: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), encoding: .utf8)! }
struct VisualPoint: Decodable { let x: Double; let y: Double }
struct SearchScope: Decodable {
    let pid:Int32
    let window:String
    let tab:String
    let url:String
    let document:String?
    let field:String?
    let searchValueStamp:String?
    let passiveFocus:String?
    let submitControl:String?
    let paintedBounds:GestureFrame?
    let capture:String?
}
struct GestureFrame:Decodable {let x:Double;let y:Double;let width:Double;let height:Double}
struct WindowGesture: Decodable {
    let operation:String?
    let scrollX:Int32?
    let scrollY:Int32?
    let path:[VisualPoint]?
    let expected:GestureFrame?
    let overlay:UInt32?
    let id: UInt32
    let width: Double
    let height: Double
    let cancelFile: String
    let from: VisualPoint
    let to: VisualPoint?
}
// CoreGraphics/AX use global, top-left display points. AppKit's hit test uses
// global, bottom-left points on the primary display, including for other displays.
func mouseHitPoint(_ point: CGPoint, primary: CGRect) -> CGPoint {
    CGPoint(x: point.x, y: primary.maxY - point.y)
}
func verifyMouseHit(target: UInt32, hit: Int, hitPid: pid_t?, targetPid: pid_t,
                    athenaPid: pid_t, overlay: UInt32?) throws {
    guard hit > 0, let hitPid else {
        throw WindowTargetFailure(code:"window-target-hit-unavailable",message:"macOS could not identify a visible window at the requested point. Inspect the window again.")
    }
    if hit == Int(target), hitPid == targetPid { return }
    if hitPid == athenaPid {
        if overlay.map({Int($0)==hit}) == true {
            throw WindowTargetFailure(code:"window-target-overlay-intercepts",message:"The Athena cursor overlay intercepted the target. Input was stopped.")
        }
        throw WindowTargetFailure(code:"window-target-athena-obscured",message:"An Athena window covers the requested point. Move it aside and inspect again.")
    }
    if hitPid == targetPid {
        throw WindowTargetFailure(code:"window-target-sibling-obscured",message:"A different window or dialog from the same application covers the requested point. Inspect it before continuing.")
    }
    throw WindowTargetFailure(code:"window-target-obscured",message:"Another application or system control covers the requested point. Expose the authorized window and inspect again.")
}
func visualInput(_ bundle: String, _ data: String, _ preview:Bool) throws -> [String:Any] {
    let gesture = try JSONDecoder().decode(WindowGesture.self, from: Data(data.utf8))
    guard AXIsProcessTrusted() else {throw WindowTargetFailure(code:"window-target-accessibility-denied",message:"The input helper does not have macOS Accessibility access.")}
    guard CGPreflightScreenCaptureAccess() else {throw WindowTargetFailure(code:"window-target-capture-denied",message:"The input helper does not have macOS Screen Recording access.")}
    guard let app=NSWorkspace.shared.frontmostApplication, app.bundleIdentifier==bundle else {throw WindowTargetFailure(code:"window-target-focus-changed",message:"The authorized application is no longer in the foreground. Refocus it before continuing.")}
    guard gesture.width>0,gesture.height>0 else {throw WindowTargetFailure(code:"window-target-image-invalid",message:"The observed window image has invalid dimensions.")}
    // This is a headless command-line helper. AppKit must initialize its
    // window-server connection for cross-process hit testing; never activate it.
    let helper=NSApplication.shared
    helper.setActivationPolicy(.prohibited)
    func visibleWindows() -> [[String:Any]] {
        CGWindowListCopyWindowInfo([.optionOnScreenOnly,.excludeDesktopElements],kCGNullWindowID) as? [[String:Any]] ?? []
    }
    func frame(_ row:[String:Any]) -> CGRect? {
        guard let bounds=row[kCGWindowBounds as String] as? NSDictionary else {return nil}
        return CGRect(dictionaryRepresentation:bounds as CFDictionary)
    }
    guard let selected=visibleWindows().first(where:{ ($0[kCGWindowNumber as String] as? NSNumber)?.uint32Value==gesture.id }),
          (selected[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value==app.processIdentifier,
          let rect=frame(selected),rect.width>0,rect.height>0 else {throw WindowTargetFailure(code:"window-target-closed",message:"The authorized window closed or changed identity. Select it again.")}
    guard abs((rect.width/rect.height)/(gesture.width/gesture.height)-1)<0.015 else {throw WindowTargetFailure(code:"window-target-resized",message:"The authorized window changed dimensions since observation. Inspect it again.")}
    if let expected=gesture.expected,rect != CGRect(x:expected.x,y:expected.y,width:expected.width,height:expected.height){throw WindowTargetFailure(code:"window-target-moved",message:"The window moved after target highlighting. Inspect it again.")}
    func position(_ point:VisualPoint) throws -> CGPoint {
        guard point.x>=0,point.y>=0,point.x<gesture.width,point.y<gesture.height else {throw Failure(message:"The point is outside the approved window.")}
        return CGPoint(x:rect.minX+(point.x+0.5)*rect.width/gesture.width,y:rect.minY+(point.y+0.5)*rect.height/gesture.height)
    }
    func verify(_ point:CGPoint) throws {
        guard !FileManager.default.fileExists(atPath:gesture.cancelFile) else {throw WindowTargetFailure(code:"window-target-cancelled",message:"Window input was cancelled.")}
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier==app.processIdentifier else {throw WindowTargetFailure(code:"window-target-focus-changed",message:"The foreground application changed before input. Refocus the authorized window.")}
        // NSWindow identifies the actual mouseDown recipient across applications,
        // including transparent, non-interactive system surfaces over this point.
        // Exclude no windows. An interactive Athena window must block just like any other.
        let hit=NSWindow.windowNumber(at:mouseHitPoint(point,primary:CGDisplayBounds(CGMainDisplayID())),belowWindowWithWindowNumber:0)
        let windows=visibleWindows()
        func window(_ id:Int)->[String:Any]? {windows.first{($0[kCGWindowNumber as String] as? NSNumber)?.intValue==id}}
        guard let current=window(Int(gesture.id)), (current[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value==app.processIdentifier else {throw WindowTargetFailure(code:"window-target-closed",message:"The authorized window closed before input. Select it again.")}
        guard frame(current)==rect else {throw WindowTargetFailure(code:"window-target-moved",message:"The authorized window moved before input. Inspect it again.")}
        try verifyMouseHit(target:gesture.id,hit:hit,hitPid:(window(hit)?[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value,
                           targetPid:app.processIdentifier,athenaPid:getppid(),overlay:gesture.overlay)
    }
    func post(_ type:CGEventType,_ point:CGPoint,_ count:Int64=1) throws {
        guard let event=CGEvent(mouseEventSource:nil,mouseType:type,mouseCursorPosition:point,mouseButton:.left) else {throw Failure(message:"Could not form pointer input.")}
        event.setIntegerValueField(.mouseEventClickState,value:count)
        event.postToPid(app.processIdentifier)
    }
    let start=try position(gesture.from), end=try gesture.to.map(position) ?? start
    try verify(start);try verify(end)
    // Validate the entire drag path before pressing, then recheck each point.
    let path:[CGPoint]
    if let supplied=gesture.path {
        guard supplied.count<=100 else {throw Failure(message:"The drag path exceeds the supported limit.")}
        path=try supplied.map(position)
    } else {
        path=(1...10).map { index in
            let fraction=CGFloat(index)/10.0
            return CGPoint(x:start.x+(end.x-start.x)*fraction,y:start.y+(end.y-start.y)*fraction)
        }
    }
    guard path.count<=100 else {throw Failure(message:"The drag path exceeds the supported limit.")}
    if gesture.to != nil {for point in path {try verify(point)}}
    if preview {return ["ok":true,"frame":rectData(rect),"point":["x":start.x,"y":start.y]]}
    try verify(start)
    if gesture.operation=="move" {
        guard CGWarpMouseCursorPosition(start) == .success else {throw Failure(message:"The pointer could not be moved.")}
        try post(.mouseMoved,start)
        guard let actual=CGEvent(source:nil)?.location, hypot(actual.x-start.x,actual.y-start.y)<2 else {throw Failure(message:"Pointer movement was interrupted.")}
        return ["ok":true]
    }
    if gesture.operation=="scroll" {
        let x=gesture.scrollX ?? 0,y=gesture.scrollY ?? 0
        guard abs(Int(x))<=2400,abs(Int(y))<=2400,let event=CGEvent(scrollWheelEvent2Source:nil,units:.pixel,wheelCount:2,wheel1:-y,wheel2:-x,wheel3:0) else {throw Failure(message:"Unsupported scroll distance.")}
        event.location=start;event.postToPid(app.processIdentifier);return ["ok":true]
    }
    if gesture.operation=="double_click" {
        try post(.leftMouseDown,start);try post(.leftMouseUp,start)
        try verify(start);try post(.leftMouseDown,start,2);try post(.leftMouseUp,start,2);return ["ok":true]
    }
    var last=start
    try post(.leftMouseDown,start)
    defer {try? post(.leftMouseUp,last)}
    if gesture.to != nil {for point in path {try verify(point);try post(.leftMouseDragged,point);last=point;Thread.sleep(forTimeInterval:0.012)}}
    return ["ok":true]
}

func axElement(_ owner: AXUIElement, _ key: String) -> AXUIElement? {
    guard let value = attribute(owner, key), CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
    return unsafeBitCast(value, to: AXUIElement.self)
}
func elementFrame(_ element: AXUIElement) -> CGRect? {
    var point = CGPoint.zero, size = CGSize.zero
    guard let p = attribute(element,"AXPosition"), CFGetTypeID(p) == AXValueGetTypeID(),
          let s = attribute(element,"AXSize"), CFGetTypeID(s) == AXValueGetTypeID(),
          AXValueGetValue(unsafeBitCast(p,to:AXValue.self), .cgPoint, &point),
          AXValueGetValue(unsafeBitCast(s,to:AXValue.self), .cgSize, &size),
          size.width > 0, size.height > 0 else { return nil }
    return CGRect(origin:point,size:size)
}
func rectData(_ r:CGRect) -> [String:Double] { ["x":r.minX,"y":r.minY,"width":r.width,"height":r.height] }
// Browser chrome and embedded frames are outside the selected page's control scope.
func pageDocument(_ window:AXUIElement) -> AXUIElement? {
    var queue=[window],offset=0,seen=Set<CFHashCode>(),documents=[AXUIElement]()
    while offset < queue.count && offset < 1000 {
        let element=queue[offset];offset += 1
        guard seen.insert(CFHash(element)).inserted else {continue}
        let role=text(attribute(element,"AXRole"))
        if ["AXWebArea","AXDocument","AXHTMLContent"].contains(role) {
            if let rect=elementFrame(element),let win=elementFrame(window),rect.intersects(win){documents.append(element)}
            continue
        }
        if !["AXMenu","AXMenuBar","AXToolbar"].contains(role), let children=attribute(element,"AXChildren") as? [AXUIElement] {queue.append(contentsOf:children.prefix(256))}
    }
    return documents.count==1 ? documents[0] : nil
}
func documentURL(_ document:AXUIElement) -> String? {
    let raw=attribute(document,"AXURL")
    let url=(raw as? URL) ?? URL(string:text(raw))
    guard let url,["https","http"].contains(url.scheme?.lowercased() ?? ""),url.host != nil,url.user==nil,url.password==nil else{return nil}
    return url.absoluteString
}
// Resolve only the selected accessible link. Chromium can abbreviate URLs in
// the CUA tree. A repeated title is safe only when every match goes to the same URL.
func linkDestination(_ doc:AXUIElement, named name:String) -> String? {
    guard !name.isEmpty, name.count <= 560 else { return nil }
    var queue=[doc], offset=0, visited=Set<CFHashCode>(), destination:String?
    while offset < queue.count && offset < 3500 {
        let node=queue[offset]; offset += 1
        guard visited.insert(CFHash(node)).inserted else {continue}
        let role=text(attribute(node,"AXRole"))
        if !CFEqual(node,doc), ["AXWebArea","AXDocument","AXHTMLContent"].contains(role) {continue}
        if role=="AXLink", ["AXTitle","AXDescription"].contains(where:{text(attribute(node,$0))==name}) {
            guard let url=documentURL(node),url.utf16.count<=4096,destination==nil || destination==url else {return nil}
            destination=url
        }
        if !["AXTextField","AXTextArea","AXComboBox","AXSecureTextField"].contains(role),
           let children=attribute(node,"AXChildren") as? [AXUIElement] {queue.append(contentsOf:children)}
    }
    return offset==queue.count ? destination:nil
}
func sameWebDestination(_ first:String, _ second:String) -> Bool {
    guard let a=URLComponents(string:first),let b=URLComponents(string:second) else{return false}
    func port(_ url:URLComponents)->Int? {url.port ?? (url.scheme?.lowercased()=="https" ? 443 : 80)}
    return a.scheme?.lowercased()==b.scheme?.lowercased() && a.host?.lowercased()==b.host?.lowercased()
        && port(a)==port(b) && (a.percentEncodedPath.isEmpty ? "/":a.percentEncodedPath)==(b.percentEncodedPath.isEmpty ? "/":b.percentEncodedPath)
        && a.percentEncodedQuery==b.percentEncodedQuery && a.percentEncodedFragment==b.percentEncodedFragment
}
// A focused address bar is safe to leave alone only when it still displays
// the committed document. Compare locally, without returning its contents.
func displaysCommittedAddress(_ value:String, _ url:String, browser:String="", fullySelected:Bool=false) -> Bool {
    guard let parts=URLComponents(string:url),let scheme=parts.scheme,
          ["http","https"].contains(scheme),parts.host != nil,parts.user==nil,parts.password==nil,
          url.hasPrefix(scheme+"://"),!value.isEmpty else {return false}
    if value==url {return true}
    let display=String(url.dropFirst(scheme.utf8.count+3)),rootSlash=parts.percentEncodedPath=="/" && parts.query==nil && parts.fragment==nil
    if value==display || (rootSlash && (value==String(display.dropLast()) || value==String(url.dropLast()))) {return true}
    // Chrome exposes the selected address without its scheme and leading
    // www. Only recognize this display form with the entire value selected.
    // A typed candidate URL (caret), partial selection or different suffix is
    // not evidence that the omnibox still reflects the committed document.
    if fullySelected,["com.google.Chrome","com.microsoft.edgemac"].contains(browser),
       parts.host?.hasPrefix("www.")==true,display.hasPrefix("www.") {
        let elided=String(display.dropFirst(4))
        return value==elided || (rootSlash && value==String(elided.dropLast()))
    }
    return false
}
func unchangedAddressEditor(_ editor:AXUIElement, _ url:String, browser:String) -> Bool {
    guard !secure(editor),(attribute(editor,"AXExpanded") as? Bool) != true else {return false}
    let value=text(attribute(editor,"AXValue"))
    var fullySelected=false
    if let marked=attribute(editor,"AXMarkedTextRange") {
        var range=CFRange()
        guard CFGetTypeID(marked)==AXValueGetTypeID(),
              AXValueGetValue(unsafeBitCast(marked,to:AXValue.self),.cfRange,&range),range.length==0 else {return false}
    }
    if let selected=attribute(editor,"AXSelectedTextRange") {
        var range=CFRange()
        guard CFGetTypeID(selected)==AXValueGetTypeID(),
              AXValueGetValue(unsafeBitCast(selected,to:AXValue.self),.cfRange,&range),
              range.length==0 || (range.location==0 && range.length==value.utf16.count) else {return false}
        fullySelected=range.location==0 && range.length>0 && range.length==value.utf16.count
    }
    return displaysCommittedAddress(value,url,browser:browser,fullySelected:fullySelected)
}
func passiveSearchContainer(_ focused:AXUIElement, document:AXUIElement, field:AXUIElement, window:AXUIElement) -> Bool {
    // Chrome can expose a structural view above the web document (or the
    // document's own layout group around the search field) as focused.
    let role=text(attribute(focused,"AXRole")),subrole=text(attribute(focused,"AXSubrole"))
    guard ["AXGroup","AXScrollArea","AXLayoutArea","AXSplitGroup","AXHTMLContent","AXWebArea","AXDocument"].contains(role),
          ["","AXUnknown","AXLandmarkMain","AXDocument"].contains(subrole),
          !secure(focused),(attribute(focused,"AXEditable") as? Bool) != true,
          within(document,focused,window) || within(field,focused,document) else {return false}
    var actions:CFArray?,writable=DarwinBoolean(false)
    let actionStatus=AXUIElementCopyActionNames(focused,&actions)
    guard [.success,.noValue,.actionUnsupported].contains(actionStatus),
          !(actions as? [String] ?? []).contains(kAXPressAction as String),
          AXUIElementIsAttributeSettable(focused,kAXValueAttribute as CFString,&writable) != .success || !writable.boolValue else {return false}
    return true
}
// Chromium's application-level AXFocusedUIElement can still name its address
// bar while an editor in the page itself reports AXFocused. Check the page
// independently before accepting any browser-chrome or passive focus state.
func conflictingPageFocus(_ document:AXUIElement, search:AXUIElement) -> String? {
    let keys=["AXRole","AXSubrole","AXFocused","AXEditable","AXProtectedContent","AXDOMInputType","AXChildren"] as CFArray
    let composite=text(attribute(search,"AXRole"))=="AXComboBox"
    var queue=[document],offset=0,seen=Set<CFHashCode>()
    while offset<queue.count {
        guard seen.count<6000 else {return "The page is too large to verify the active editor. No further input was issued."}
        let node=queue[offset];offset+=1
        guard seen.insert(CFHash(node)).inserted else {continue}
        var values:CFArray?
        let status=AXUIElementCopyMultipleAttributeValues(node,keys,[],&values)
        if status == .invalidUIElement {continue}
        guard status == .success,let fields=values as? [Any],fields.count==7,let role=fields[0] as? String else {
            return "The browser did not expose the page focus state. Inspect again before continuing."
        }
        if !CFEqual(node,document) && ["AXWebArea","AXDocument","AXHTMLContent"].contains(role) {continue}
        let protected=role.contains("Secure") || (fields[1] as? String)?.contains("Secure")==true ||
            fields[4] as? Bool==true || (fields[5] as? String)?.lowercased()=="password"
        if fields[2] as? Bool==true && (protected || pageTextRole(role) || fields[3] as? Bool==true) {
            if protected || (!CFEqual(node,search) && !(composite && within(node,search,document))) {
                return "Focus moved outside the authorized search form to another editable control."
            }
        }
        // Never descend into a protected field or read any editor's name,
        // selection or value to determine whether another editor is focused.
        if !protected,let children=fields[6] as? [AXUIElement] {queue.append(contentsOf:children)}
    }
    return nil
}
func selectedTab(_ tab:AXUIElement)->Bool {
    (attribute(tab,"AXSelected") as? Bool)==true || (attribute(tab,"AXValue") as? NSNumber)?.boolValue==true
}
func until(timeout:TimeInterval=1.8, interval:TimeInterval=0.025, _ predicate:() -> Bool) -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    repeat {
        if predicate() { return true }
        RunLoop.current.run(until:Date().addingTimeInterval(interval))
    } while Date() < deadline
    return predicate()
}
// Search browser chrome only. Web documents can contain fake tab bars and address fields.
func browserChrome(_ win:AXUIElement,findAddress:Bool=true) -> (tabs:[AXUIElement], address:AXUIElement?) {
    var queue=[win], seen=Set<CFHashCode>(), tabs=[AXUIElement](), address:AXUIElement?
    var i=0
    while i < queue.count && i < 1400 {
        let e=queue[i]; i+=1
        guard seen.insert(CFHash(e)).inserted else {continue}
        let role=text(attribute(e,"AXRole"))
        if ["AXWebArea","AXHTMLContent","AXDocument","AXMenuBar","AXMenu"].contains(role) {continue}
        if role == "AXRadioButton" || role == "AXTab" {
            let parent = axElement(e,"AXParent")
            let desc=text(attribute(e,"AXRoleDescription")).lowercased()
            if role == "AXTab" || desc == "tab" || parent.map({text(attribute($0,"AXRole"))=="AXTabGroup"}) == true {tabs.append(e)}
        }
        if findAddress && (role == "AXTextField" || role == "AXComboBox") {
            let name=(label(e)+" "+text(attribute(e,"AXIdentifier"))).lowercased()
            if name.contains("address") || name.contains("urlbar") || name.contains("smart search") {address=e}
        }
        if let children=attribute(e,"AXChildren") as? [AXUIElement] {queue.append(contentsOf:children.prefix(256))}
    }
    return (tabs,address)
}
struct WorkspaceRequest: Decodable {
    var operation:String
    var pid:Int32?
    var window:String?
    var foreground:Int32?
    var foregroundWindow:String?
    var tab:String?
    var url:String?
    var query:String?
    var linkLabel:String?
    var tabs:Bool?
    var details:Bool?
    var path:String?
}
func containsSubmittedQuery(_ address:String, from initialURL:String, query input:String)->Bool {
    guard address != initialURL,let initial=URLComponents(string:initialURL),let next=URLComponents(string:address),
          initial.scheme==next.scheme,initial.host==next.host,initial.port==next.port,let query=next.percentEncodedQuery else {return false}
    return query.split(separator:"&").contains { pair in
        let parts=pair.split(separator:"=",maxSplits:1,omittingEmptySubsequences:false)
        return parts.count==2 && !parts[0].isEmpty && String(parts[1]).replacingOccurrences(of:"+",with:" ").removingPercentEncoding==input
    }
}

// A pinned background interaction only uses attributes and AX actions on the
// explicitly authorized objects. It never activates a window or posts input events.
struct BackgroundWindowScope:Decodable {
    let pid:Int32
    let window:String
    let tab:String
    let capture:String
    let foreground:Int32?
    let url:String?
    let document:String?
}
func backgroundBrowser(_ bundle:String,_ action:String,_ selector:String,_ query:String,_ expected:String) throws -> [String:Any] {
    let scope=try JSONDecoder().decode(BackgroundWindowScope.self,from:Data(expected.utf8))
    let binding=action=="background-bind",capture=scope.capture
    guard AXIsProcessTrusted(),let process=NSRunningApplication(processIdentifier:scope.pid),process.bundleIdentifier==bundle,!process.isTerminated,!process.isHidden,
          binding || (scope.document != nil && scope.url != nil) else {throw Failure(message:"The authorized background browser process or document reference is unavailable.")}
    let app=AXUIElementCreateApplication(scope.pid)
    AXUIElementSetMessagingTimeout(app,0.65)
    let rows=(attribute(app,"AXWindows") as? [AXUIElement] ?? []).filter{String(CFHash($0))==scope.window}
    guard rows.count==1 else {throw Failure(message:"The authorized background browser window is unavailable.")}
    let win=rows[0]
    func pinnedDocument(_ requirePrior:Bool) throws -> (AXUIElement,String) {
        guard !process.isTerminated,!process.isHidden,(attribute(win,"AXMinimized") as? Bool) != true,let frame=elementFrame(win),
              let list=CGWindowListCopyWindowInfo([.optionOnScreenOnly,.excludeDesktopElements],kCGNullWindowID) as? [[String:Any]],
              list.contains(where:{ row in
                  guard let id=row[kCGWindowNumber as String] as? NSNumber,capture=="window:"+id.stringValue+":0",
                        (row[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value==scope.pid,
                        (row[kCGWindowLayer as String] as? Int)==0,let bounds=row[kCGWindowBounds as String] as? NSDictionary else {return false}
                  return CGRect(dictionaryRepresentation:bounds as CFDictionary)==frame
              }) else {throw Failure(message:"The authorized background window is hidden, minimized, closed or has a different capture identity.")}
        if binding {
            let workspace=NSWorkspace.shared
            guard let observed=scope.foreground,observed>0,observed != scope.pid,
                  let front=workspace.frontmostApplication,front.processIdentifier==observed,!front.isTerminated,
                  let frontBundle=front.bundleURL else {throw Failure(message:"The foreground application changed before browser selection.")}
            if front.processIdentifier != getppid() || front.bundleIdentifier != "com.athena.companion" {
                let browsers=workspace.urlsForApplications(toOpen:URL(string:"https://example.com")!)
                guard !browsers.contains(where:{$0.standardizedFileURL==frontBundle.standardizedFileURL}) else {
                    throw Failure(message:"A different browser is in front. Select the browser tab you want to use.")
                }
            }
            // Compare only native process IDs and on-screen window geometry,
            // never the titles or contents of other windows or profiles.
            let peers=Set(NSRunningApplication.runningApplications(withBundleIdentifier:bundle)
                .filter{!$0.isTerminated && !$0.isHidden && $0.activationPolicy == .regular}.map{$0.processIdentifier})
            let browserWindows=list.filter{ row in
                guard let owner=row[kCGWindowOwnerPID as String] as? NSNumber,peers.contains(owner.int32Value),
                      (row[kCGWindowLayer as String] as? Int)==0,let data=row[kCGWindowBounds as String] as? NSDictionary,
                      let bounds=CGRect(dictionaryRepresentation:data as CFDictionary) else {return false}
                return bounds.width>0 && bounds.height>0
            }
            guard browserWindows.count==1 else {throw Failure(message:"Multiple visible browser windows or profiles are available. Select the intended tab before searching.")}
            let matchingWindows=(attribute(app,"AXWindows") as? [AXUIElement] ?? []).filter{
                text(attribute($0,"AXRole"))=="AXWindow" && (attribute($0,"AXMinimized") as? Bool) != true && elementFrame($0)==frame
            }
            guard matchingWindows.count==1,CFEqual(matchingWindows[0],win) else {
                throw Failure(message:"The visible browser window could not be uniquely identified through Accessibility.")
            }
        }
        let tabs=browserChrome(win,findAddress:false).tabs.filter(selectedTab)
        guard tabs.count==1,String(CFHash(tabs[0]))==scope.tab else {throw Failure(message:"The selected tab in the authorized background window changed.")}
        guard let doc=pageDocument(win),let url=documentURL(doc) else {throw Failure(message:"The background browser did not expose this tab’s top-level web document.")}
        if requirePrior && (String(CFHash(doc)) != scope.document || url != scope.url) {throw Failure(message:"The pinned page or URL changed. Inspect and authorize the intended page in the foreground.")}
        return (doc,url)
    }
    let (doc,url)=try pinnedDocument(!binding)
    if binding {
        let (current,address)=try pinnedDocument(false)
        guard CFEqual(doc,current),address==url,NSWorkspace.shared.frontmostApplication?.processIdentifier==scope.foreground else {
            throw Failure(message:"The background browser selection changed before it could be bound.")
        }
        // The host validates the committed destination and owner authorization
        // before a separate call may read any page controls or send input.
        return ["app":bundle,"window":"","verified":true,"changed":false,"inputIssued":false,"elements":[],
                "message":"Identified the selected background browser document.","pageURL":url,"pageReference":String(CFHash(doc))]
    }
    func reply(_ ok:Bool,_ message:String,_ issued:Bool=false,_ items:[[String:Any]]=[],_ observed:AXUIElement?=nil,_ address:String?=nil)->[String:Any] {
        ["app":bundle,"window":text(attribute(win,"AXTitle")),"verified":ok,"changed":ok && issued,"inputIssued":issued,"message":message,
         "pageURL":address ?? url,"pageReference":String(CFHash(observed ?? doc)),"elements":items,"windowToken":expected]
    }
    let items=controls(doc,documentOnly:true)
    if action=="background-inspect" {
        _=try pinnedDocument(true)
        return reply(true,"Read the authorized background browser document.",false,items.map{$0.1})
    }
    let fields=items.filter{$0.1["label"] as? String==selector && $0.1["searchField"] as? Bool==true && $0.1["enabled"] as? Bool==true}
    guard fields.count==1,!secure(fields[0].0),!query.isEmpty,query.rangeOfCharacter(from:.controlCharacters)==nil else {
        return reply(false,"No background input was sent. One enabled, non-sensitive search field with the observed name is required.")
    }
    let field=fields[0].0
    var writable=DarwinBoolean(false)
    guard AXUIElementIsAttributeSettable(field,kAXValueAttribute as CFString,&writable) == .success,writable.boolValue else {
        return reply(false,"This search field requires foreground text input. Nothing was sent in the background.")
    }
    if action=="background-set-text" {
        _=try pinnedDocument(true)
        guard text(attribute(field,"AXValue")) != query else {return reply(true,"The authorized background field already contains the requested query.")}
        guard AXUIElementSetAttributeValue(field,kAXValueAttribute as CFString,query as CFString) == .success else {return reply(false,"The browser rejected background editing of this search field.")}
        let matches=until(timeout:0.7,{text(attribute(field,"AXValue"))==query})
        _=try pinnedDocument(true)
        return reply(matches,matches ? "The authorized background search field contains the requested text. No form was submitted." : "Background text entry was requested once. Its resulting value could not be verified.",true)
    }
    guard action=="background-submit-search",text(attribute(field,"AXValue"))==query else {return reply(false,"The observed background field does not contain the exact requested search query.")}
    guard let form=searchForm(field,doc) else {return reply(false,"No verified search form owns this field. Focus the browser to submit the query.")}
    guard let (button,item)=searchButton(in:form,document:doc,items:items) else {return reply(false,"The same search form must expose exactly one enabled Search button. Focus the browser to submit with Enter.")}
    _=try pinnedDocument(true)
    guard text(attribute(field,"AXValue"))==query,!secure(field),let fieldOwner=searchForm(field,doc),CFEqual(fieldOwner,form),
          let buttonOwner=searchForm(button,doc),CFEqual(buttonOwner,form),(attribute(button,"AXEnabled") as? Bool) != false,
          label(button)==item["label"] as? String else {return reply(false,"The background form, query or search button changed before activation.")}
    guard AXUIElementPerformAction(button,kAXPressAction as CFString) == .success else {return reply(false,"The browser rejected the background search button press. Inspect before trying another action.",true)}
    let deadline=Date().addingTimeInterval(3)
    repeat {
        if let (next,address)=try? pinnedDocument(false),containsSubmittedQuery(address,from:url,query:query) {
            return reply(true,"The authorized tab navigated with the exact submitted query. Inspect the page to verify the results.",true,[],next,address)
        }
        RunLoop.current.run(until:Date().addingTimeInterval(0.08))
    } while Date()<deadline
    return reply(false,"The background search button was pressed once. The expected navigation could not be verified. Inspect the target before continuing.",true)
}
func workspaceAction(_ bundle:String,_ data:String) throws -> [String:Any] {
    let r=try JSONDecoder().decode(WorkspaceRequest.self,from:Data(data.utf8))
    let workspace=NSWorkspace.shared
    func front() -> Int32 {workspace.frontmostApplication?.processIdentifier ?? 0}
    if r.operation == "foreground" {return ["pid":front(),"bundle":workspace.frontmostApplication?.bundleIdentifier ?? ""]}
    if r.operation=="running" {
        let selected=front()
        let regular=workspace.runningApplications.filter{$0.activationPolicy == .regular && !$0.isTerminated}
        let ordered=regular.filter{$0.processIdentifier==selected}+regular.filter{$0.processIdentifier != selected}
        return ["apps":ordered.prefix(200).map{["app":$0.bundleIdentifier ?? "","name":$0.localizedName ?? "","active":$0.processIdentifier==selected] as [String:Any]}]
    }
    let browserBundles=["com.google.Chrome","com.microsoft.edgemac","com.apple.Safari","org.mozilla.firefox"]
    let isBrowser=browserBundles.contains(bundle)
    let candidates=NSRunningApplication.runningApplications(withBundleIdentifier:bundle).filter { a in
        a.activationPolicy == .regular && (r.pid == nil || r.pid == a.processIdentifier) && (r.path == nil || a.bundleURL?.path==r.path)
    }
    let onScreen=CGWindowListCopyWindowInfo([.optionOnScreenOnly,.excludeDesktopElements],kCGNullWindowID) as? [[String:Any]] ?? []
    let livePids=onScreen.filter { ($0[kCGWindowLayer as String] as? Int)==0 }.compactMap { ($0[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value }
    guard let target=candidates.first(where:{$0.processIdentifier==front()}) ?? livePids.compactMap({ p in candidates.first(where:{$0.processIdentifier==p}) }).first ?? candidates.sorted(by:{$0.processIdentifier<$1.processIdentifier}).first else {
        if r.operation=="observe" {return ["running":false,"foreground":front(),"windows":[],"focused":false,"pid":0]}
        throw Failure(message:"That application instance closed. Inspect the current window again.")
    }
    let app=AXUIElementCreateApplication(target.processIdentifier)
    AXUIElementSetMessagingTimeout(app,0.65)
    func windows()->[AXUIElement] { (attribute(app,"AXWindows") as? [AXUIElement] ?? []).filter { text(attribute($0,"AXRole"))=="AXWindow" } }
    func focused(_ list:[AXUIElement])->AXUIElement? {
        axElement(app,"AXFocusedWindow") ?? axElement(app,"AXMainWindow") ?? list.first
    }
    func key(_ e:AXUIElement)->String {String(CFHash(e))}
    func isFront(_ w:AXUIElement)->Bool {front()==target.processIdentifier && focused(windows()).map({CFEqual($0,w)}) == true}
    let list=r.details==false ? [] : windows(), chosen=r.details==false ? nil : focused(list)
    if r.operation=="observe" {
        let info=list.map { w -> [String:Any] in
            var item:[String:Any]=["id":key(w),"focused":chosen.map({CFEqual($0,w)}) ?? false,"minimized":(attribute(w,"AXMinimized") as? Bool) ?? false,"hidden":target.isHidden,"maximized":attribute(w,"AXZoomed") as? Bool as Any? ?? NSNull()]
            if let rect=elementFrame(w) {
                item["bounds"]=rectData(rect)
                let matches=onScreen.filter { row in
                    guard (row[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value==target.processIdentifier,
                          (row[kCGWindowLayer as String] as? Int)==0,
                          let data=row[kCGWindowBounds as String] as? NSDictionary,
                          let frame=CGRect(dictionaryRepresentation:data as CFDictionary) else{return false}
                    return frame.equalTo(rect)
                }
                if matches.count==1,let number=matches[0][kCGWindowNumber as String] as? NSNumber {
                    item["captureId"]="window:\(number.uint32Value):0"
                }
            }
            if isBrowser && r.tabs==true {
                let chrome=browserChrome(w)
                item["tabs"]=chrome.tabs.map { tab in var info:[String:Any]=["id":key(tab),"title":label(tab),"selected":selectedTab(tab)];if let frame=elementFrame(tab){info["bounds"]=rectData(frame)};return info }
                // The omnibox can be absent, elide the origin, or hold an unsent
                // edit. Only the currently selected tab's committed document is
                // usable for scoping access to page content and project previews.
                let selected=chrome.tabs.filter(selectedTab)
                func matchesRequestedTab() -> Bool {
                    guard let expectedPid=r.pid, expectedPid==target.processIdentifier,
                          r.window==key(w), selected.count==1, r.tab==key(selected[0]),
                          !target.isHidden, !((attribute(w,"AXMinimized") as? Bool) ?? false),
                          let active=focused(windows()), CFEqual(active,w) else { return false }
                    return selectedTab(selected[0])
                }
                if selected.count==1, isFront(w) || matchesRequestedTab(),
                   let doc=pageDocument(w),let address=documentURL(doc),address.utf16.count<=2048,
                   isFront(w) || matchesRequestedTab(),selectedTab(selected[0]) {
                    item["address"]=address
                    // Chrome's tab label includes memory usage. The committed document title
                    // corresponds to the native CUA web area, including its notification count.
                    item["documentTitle"]=String(text(attribute(doc,"AXTitle")).prefix(512))
                    let windowTitle=text(attribute(w,"AXTitle"))
                    if !windowTitle.isEmpty,windowTitle.utf16.count<=1024,
                       list.filter({text(attribute($0,"AXTitle"))==windowTitle}).count==1 {
                        item["uniqueWindowTitle"]=windowTitle
                    }
                    if let name=r.linkLabel,r.url==address,matchesRequestedTab(),
                       let destination=linkDestination(doc,named:name),matchesRequestedTab(),documentURL(doc)==address {
                        item["linkDestination"]=destination
                    }
                }
            }
            return item
        }
        return ["running":true,"pid":target.processIdentifier,"foreground":front(),"focused":front()==target.processIdentifier,"windows":info,"focusRole":r.details==false ? "" : axElement(app,"AXFocusedUIElement").map({text(attribute($0,"AXRole"))}) ?? ""]
    }
    if let previous=r.foregroundWindow,chosen.map(key) != previous {throw Failure(message:"The active window changed. Reassess the selected window.")}
    if let f=r.foreground, front() != f { throw Failure(message:"The foreground application changed. Check the current target and continue.") }
    guard r.operation=="activate" || (AXIsProcessTrusted() && isBrowser) else {throw Failure(message:"Allow Athena under macOS Accessibility to control an existing browser window.")}
    let window=r.window.flatMap { id in list.first(where:{key($0)==id}) } ?? (r.window==nil ? chosen : nil)
    if r.window != nil && window==nil {throw Failure(message:"The selected window closed. Select a window again.")}
    if let w=window, let tab=r.tab, !browserChrome(w).tabs.contains(where:{key($0)==tab && selectedTab($0)}) {throw Failure(message:"The active tab changed. Check the current tab and continue.")}
    let already=front()==target.processIdentifier && !target.isHidden && (window.map({isFront($0) && (attribute($0,"AXMinimized") as? Bool) != true}) ?? true)
    if !already {
        if let w=window, (attribute(w,"AXMinimized") as? Bool)==true {guard AXUIElementSetAttributeValue(w,kAXMinimizedAttribute as CFString,kCFBooleanFalse)==AXError.success else {throw Failure(message:"The selected window could not be restored.")}}
        if target.isHidden {target.unhide()}
        if front() != target.processIdentifier {target.activate(options:[.activateIgnoringOtherApps])}
        if let w=window { _=AXUIElementPerformAction(w,kAXRaiseAction as CFString) }
        guard until({front()==target.processIdentifier && (window.map(isFront) ?? true)}) else {throw Failure(message:"The requested window did not gain focus. Bring it to the foreground and try again.")}
    }
    if r.operation=="activate" || r.operation=="current" {
        return ["ok":true,"message":already ? "The requested application is already in the foreground." : "The selected application window is in the foreground."]
    }
    func keyboard(_ code:CGKeyCode,_ modifiers:CGEventFlags,_ w:AXUIElement?) throws {
        guard front()==target.processIdentifier, w.map(isFront) ?? true else {throw Failure(message:"Focus changed before keyboard input. The action stopped.")}
        for down in [true,false] {
            guard let event=CGEvent(keyboardEventSource:nil,virtualKey:code,keyDown:down) else {throw Failure(message:"Could not send the browser shortcut.")}
            event.flags=modifiers;event.postToPid(target.processIdentifier)
        }
    }
    var destination=window
    if r.operation=="new-window" || (list.isEmpty && ["new-tab","navigate"].contains(r.operation)) {
        try keyboard(45,.maskCommand,window)
        guard until({let ws=windows();return ws.count==list.count+1 && focused(ws).map({new in !list.contains(where:{CFEqual(new,$0)})})==true}) else {throw Failure(message:"The new window could not be verified. Inspect the browser before repeating the request.")}
        destination=focused(windows())
    } else if let w=window, r.operation=="new-tab" {
        let old=browserChrome(w).tabs
        guard !old.isEmpty else {throw Failure(message:"The browser did not expose its tab bar. Show the tab bar or authorize a Chromium connection.")}
        try keyboard(17,.maskCommand,w)
        guard until({guard isFront(w),windows().count==list.count else{return false};let current=browserChrome(w).tabs;return current.count==old.count+1 && current.contains(where:{t in selectedTab(t) && !old.contains(where:{CFEqual($0,t)})})}) else {throw Failure(message:"The tab shortcut was sent once. The new tab could not be verified in the same window.")}
    } else if let w=window, r.operation=="select" {
        let tabs=browserChrome(w).tabs.filter{key($0)==r.query}
        guard isFront(w),tabs.count==1 else {throw Failure(message:"The requested tab changed. Inspect the tab list again.")}
        if !selectedTab(tabs[0]) {
            guard AXUIElementPerformAction(tabs[0],kAXPressAction as CFString) == .success, until({isFront(w) && selectedTab(tabs[0])}) else {throw Failure(message:"Tab selection could not be verified.")}
        }
    } else if let w=window, ["back","forward","close-tab"].contains(r.operation) {
        let before=browserChrome(w), selected=before.tabs.filter(selectedTab)
        let previous=r.operation=="close-tab" ? nil : pageDocument(w).flatMap(documentURL)
        guard selected.count==1,r.operation=="close-tab" || previous != nil else {throw Failure(message:"The selected tab or its current document could not be verified before navigation.")}
        if r.operation=="close-tab" && before.tabs.count<2 {throw Failure(message:"Closing the last tab would close its window. Close the window explicitly.")}
        try keyboard(r.operation=="back" ? 33 : r.operation=="forward" ? 30 : 13,.maskCommand,w)
        guard until({
            guard isFront(w) else {return false}
            let tabs=browserChrome(w).tabs
            if r.operation=="close-tab" {return tabs.count==before.tabs.count-1 && !tabs.contains(where:{CFEqual($0,selected[0])})}
            let current=tabs.filter(selectedTab)
            guard current.count==1,CFEqual(current[0],selected[0]),let address=pageDocument(w).flatMap(documentURL) else{return false}
            return address != previous
        }) else {throw Failure(message:"The browser action was sent once. Its result could not be verified.")}
    } else if r.operation != "navigate" {throw Failure(message:"The browser has no suitable window for that action.")}
    if let url=r.url {
        guard let w=destination, let address=URL(string:url),["http","https"].contains(address.scheme?.lowercased() ?? ""),address.host != nil,address.user==nil,address.password==nil else {throw Failure(message:"Choose a public web address.")}
        let initialTabs=browserChrome(w).tabs.filter(selectedTab)
        guard initialTabs.count==1 else {throw Failure(message:"The selected browser tab could not be identified. No address was entered.")}
        let selected=initialTabs[0]
        func sameTab() -> Bool {
            guard isFront(w) else {return false}
            let current=browserChrome(w).tabs.filter(selectedTab)
            return current.count==1 && CFEqual(current[0],selected)
        }
        // Browsers can put keyboard focus on a text child of the native address combo box.
        func focusedAddress() -> AXUIElement? {
            guard sameTab(),let field=browserChrome(w).address else {return nil}
            var node=axElement(app,"AXFocusedUIElement")
            for _ in 0..<5 {
                guard let current=node else {break}
                if CFEqual(current,field){return field}
                node=axElement(current,"AXParent")
            }
            return nil
        }
        try keyboard(37,.maskCommand,w)
        guard until({focusedAddress() != nil}),let field=focusedAddress() else {throw Failure(message:"The browser address bar did not receive focus. Select the intended tab and try again.")}
        guard AXUIElementSetAttributeValue(field,kAXValueAttribute as CFString,url as CFString) == .success else {throw Failure(message:"The browser did not accept the address in its address bar.")}
        guard until({focusedAddress().map({CFEqual($0,field)})==true && text(attribute(field,"AXValue"))==url}),
              focusedAddress().map({CFEqual($0,field)})==true else {throw Failure(message:"The address bar changed before navigation. Check the current tab before continuing.")}
        try keyboard(36,[],w)
        guard until(timeout:8,{
            guard sameTab(),let doc=pageDocument(w),let actual=documentURL(doc) else{return false}
            // Chrome elides schemes and "www." in its address-bar display. The
            // document URL is the navigation evidence; do not equate distinct
            // hosts or retry a submitted navigation based on display formatting.
            return sameWebDestination(actual,url) && sameTab()
        }) else {throw Failure(message:"The address was submitted. Navigation could not be verified; inspect the tab before retrying.")}
    }
    return ["ok":true,"message":r.operation=="new-tab" ? "Opened a tab in the selected browser window." : r.operation=="new-window" ? "Opened the requested browser window." : r.operation=="select" ? "Selected the requested browser tab." : "Verified the browser action in the selected window."]
}

func monitorForeground() {
    let workspace=NSWorkspace.shared
    var observer:AXObserver?
    var last=""
    func report(){
        guard let front=workspace.frontmostApplication else{return}
        let app=AXUIElementCreateApplication(front.processIdentifier)
        AXUIElementSetMessagingTimeout(app,0.15)
        let window=axElement(app,"AXFocusedWindow")
        var record:[String:Any]=["pid":front.processIdentifier,"window":window.map{String(CFHash($0))} ?? ""]
        if let w=window,let r=elementFrame(w) {record["bounds"]=rectData(r)}
        guard let line=try? json(record),last != line else{return}
        last=line;print(line);fflush(stdout)
    }
    var emit:()->Void=report
    withUnsafeMutablePointer(to:&emit){ ptr in
        func subscribe(){
            if let old=observer{CFRunLoopRemoveSource(CFRunLoopGetCurrent(),AXObserverGetRunLoopSource(old),.defaultMode)}
            observer=nil
            guard let front=workspace.frontmostApplication else{return}
            let handler:AXObserverCallback={_,_,_,ctx in ctx?.assumingMemoryBound(to:(()->Void).self).pointee() }
            if AXIsProcessTrusted(),AXObserverCreate(front.processIdentifier,handler,&observer) == .success,let obs=observer {
                let app=AXUIElementCreateApplication(front.processIdentifier)
                for key in ["AXFocusedWindowChanged","AXMainWindowChanged","AXWindowMoved","AXWindowResized"] {
                    _=AXObserverAddNotification(obs,app,key as CFString,UnsafeMutableRawPointer(ptr))
                }
                CFRunLoopAddSource(CFRunLoopGetCurrent(),AXObserverGetRunLoopSource(obs),.defaultMode)
            }
            report()
        }
        subscribe()
        let token=workspace.notificationCenter.addObserver(forName:NSWorkspace.didActivateApplicationNotification,object:nil,queue:.main){_ in subscribe()}
        defer{workspace.notificationCenter.removeObserver(token)}
        RunLoop.current.run(until:Date().addingTimeInterval(120))
    }
}

func result() throws -> [String: Any] {
    let args = Array(CommandLine.arguments.dropFirst())
    if args==["watch-focus"] {monitorForeground();return [:]}
    if args.count==3 && args[1]=="workspace" && args[0].count<200 && args[2].utf8.count<=16384 {return try workspaceAction(args[0],args[2])}
    guard [5,6].contains(args.count), args[0].count < 200, args[2].count <= 160, args[3].count <= 2000 else { throw Failure(message: "Invalid desktop action.") }
    let bundle = args[0], pageOnly=args[1].hasPrefix("web-"), action = pageOnly ? String(args[1].dropFirst(4)) : args[1], selector = args[2], input = args[3], expected = args[4]
    let browsers=["com.google.Chrome","com.microsoft.edgemac","com.apple.Safari","org.mozilla.firefox"]
    if pageOnly && browsers.contains(bundle) && ["background-bind","background-inspect","background-set-text","background-submit-search"].contains(action) {
        return try backgroundBrowser(bundle,action,selector,input,expected)
    }
    let checkingSearch=pageOnly && ["set-search-text","prepare-search","submit-search"].contains(action)
    if pageOnly && (!browsers.contains(bundle) || !["inspect","click","set-text","scroll","set-search-text","prepare-search","submit-search"].contains(action)){throw Failure(message:"Unsupported browser page action.")}
    if action == "visual" || action == "visual-preview" { return try visualInput(bundle,input,action == "visual-preview") }
    guard ["inspect", "click", "set-text", "scroll", "shortcut", "window"].contains(action) || checkingSearch else { throw Failure(message: "Unsupported desktop action.") }
    guard AXIsProcessTrusted() else { throw Failure(message: "macOS denied Accessibility for Athena's desktop helper. Review the running Athena copy in System Settings.") }
    func inForeground(_ candidate:NSRunningApplication) -> Bool {
        NSWorkspace.shared.frontmostApplication?.processIdentifier == candidate.processIdentifier
    }
    let candidates = NSRunningApplication.runningApplications(withBundleIdentifier: bundle).filter {
        $0.activationPolicy == .regular && !$0.isTerminated && (args.count == 5 || $0.bundleURL?.path == args[5])
    }
    guard !candidates.isEmpty else {throw Failure(message:"The selected application is not running.")}
    guard let running=candidates.first(where:inForeground) ?? (args.count==5 && candidates.count==1 ? candidates.first : nil) else {
        throw Failure(message:"Focus the intended application window, then try the instruction again.")
    }
    let application = AXUIElementCreateApplication(running.processIdentifier)
    AXUIElementSetMessagingTimeout(application, 1)
    func window() throws -> AXUIElement {
        if let target=axElement(application,"AXFocusedWindow") ?? axElement(application,"AXMainWindow") {return target}
        guard let windows = attribute(application, "AXWindows") as? [AXUIElement], let first = windows.first else { throw Failure(message: "The selected application has no accessible window.") }
        return first
    }
    let target = try window(), title = text(attribute(target, "AXTitle"))
    if action=="inspect" && inForeground(running) && ["com.google.Chrome","com.microsoft.edgemac"].contains(bundle) && pageDocument(target)==nil {
        // Chromium exposes its renderer tree on demand to authorized assistive clients.
        // The AX setter can return notImplemented while Chrome asynchronously enables its tree.
        _=AXUIElementSetAttributeValue(application,"AXEnhancedUserInterface" as CFString,kCFBooleanTrue)
        _=until(timeout:3.5,interval:0.12){pageDocument(target) != nil || !inForeground(running)}
    }
    let document=pageOnly ? pageDocument(target) : nil
    let url=document.flatMap(documentURL)
    if pageOnly && (!inForeground(running) || url==nil) {throw Failure(message:"The browser did not expose a single focused HTTP or HTTPS document. Select a public page and inspect it again.")}
    func token(_ window: AXUIElement) throws -> String {
        var point = CGPoint.zero, size = CGSize.zero
        if let v = attribute(window, "AXPosition"), CFGetTypeID(v) == AXValueGetTypeID() { AXValueGetValue(unsafeBitCast(v, to: AXValue.self), .cgPoint, &point) }
        if let v = attribute(window, "AXSize"), CFGetTypeID(v) == AXValueGetTypeID() { AXValueGetValue(unsafeBitCast(v, to: AXValue.self), .cgSize, &size) }
        var values:[String:Any]=["pid": running.processIdentifier, "id": CFHash(window), "title": text(attribute(window, "AXTitle")), "focus": axElement(application,"AXFocusedUIElement").map {String(CFHash($0))} ?? "", "x": point.x, "y": point.y, "w": size.width, "h": size.height]
        if pageOnly,let doc=pageDocument(window) {values["document"]=CFHash(doc);values["url"]=documentURL(doc)}
        return try json(values)
    }
    let identity = try token(target), before = controls(document ?? target, documentOnly:pageOnly)
    func response(_ items: [(AXUIElement, [String: Any])], _ verified: Bool, _ changed: Bool, _ message: String) -> [String: Any] {
        var data:[String:Any]=["app": bundle, "window": title, "windowToken": identity, "elements": items.map { $0.1 }, "verified": verified, "changed": changed, "message": message]
        if let url {data["pageURL"]=url}
        if let document {data["pageReference"]=String(CFHash(document))}
        if checkingSearch && action=="submit-search" {data["inputIssued"]=false}
        if action=="inspect",let document,let frame=elementFrame(document) {data["pageBounds"]=rectData(frame)}
        return data
    }
    if action == "inspect" { return response(before, true, false, "Accessible controls were read.") }
    guard checkingSearch || expected == identity else { throw Failure(message: "The application window changed or has not been observed. Inspect it again before acting.") }
    if action == "window" {
        func minimized() -> Bool { (attribute(target, "AXMinimized") as? Bool) == true }
        guard try token(window()) == expected else { throw Failure(message: "The target window changed.") }
        if selector == "close" {
            guard let button=axElement(target,"AXCloseButton"),AXUIElementPerformAction(button,kAXPressAction as CFString) == .success else {throw Failure(message:"The window did not accept the close request.")}
            let closed=until {running.isTerminated || (attribute(application,"AXWindows") as? [AXUIElement]).map({!$0.contains(where:{CFEqual($0,target)})})==true}
            return response([],closed,closed,closed ? "The observed window closed." : "The window remains open. Review any save dialog.")
        }
        if selector == "minimize" || selector == "restore" {
            let desired = selector == "minimize"
            let result = AXUIElementSetAttributeValue(target, kAXMinimizedAttribute as CFString, desired ? kCFBooleanTrue : kCFBooleanFalse)
            Thread.sleep(forTimeInterval: 0.2)
            return response([], result == .success && minimized() == desired, false, "Checked the window’s minimized state.")
        }
        if selector == "move" {
            let coordinates = input.split(separator: ",").compactMap { Double($0) }
            guard coordinates.count == 2, coordinates.allSatisfy({ $0.isFinite && abs($0) <= 32768 }) else { throw Failure(message: "Invalid window position.") }
            var point = CGPoint(x: coordinates[0], y: coordinates[1]), observed = CGPoint.zero
            let displays = NSScreen.screens
            guard let primary = displays.first, displays.contains(where:{ screen in
                CGRect(x:screen.frame.minX,y:primary.frame.maxY-screen.frame.maxY,width:screen.frame.width,height:screen.frame.height).contains(point)
            }), let value=AXValueCreate(.cgPoint,&point) else { throw Failure(message: "Choose a position on a connected display.") }
            let result = AXUIElementSetAttributeValue(target,kAXPositionAttribute as CFString,value)
            Thread.sleep(forTimeInterval:0.2)
            guard let actual=attribute(target,"AXPosition"), CFGetTypeID(actual)==AXValueGetTypeID() else { throw Failure(message:"Could not verify window position.") }
            AXValueGetValue(unsafeBitCast(actual,to:AXValue.self),.cgPoint,&observed)
            return response([],result == .success && abs(observed.x-point.x)<2 && abs(observed.y-point.y)<2,false,"Checked the window position.")
        }
        guard selector == "maximize", let zoom=attribute(target,"AXZoomButton"), CFGetTypeID(zoom)==AXUIElementGetTypeID() else { throw Failure(message:"This window does not expose native zoom.") }
        // Zoom is a toggle. Never invoke it without an observable current state.
        guard let zoomed=attribute(target,"AXZoomed") as? Bool else { throw Failure(message:"This application does not expose its zoom state.") }
        if !zoomed {guard AXUIElementPerformAction(unsafeBitCast(zoom,to:AXUIElement.self), kAXPressAction as CFString) == .success else { throw Failure(message:"The application rejected zoom.") }}
        Thread.sleep(forTimeInterval:0.25)
        return response([],attribute(target,"AXZoomed") as? Bool == true,false,"Checked the window’s zoom state.")
    }
    let matches = before.filter { item in
        guard item.1["label"] as? String == selector else {return false}
        if pageOnly && (action=="set-text" || checkingSearch) {return pageTextRole(item.1["role"] as? String ?? "")}
        if pageOnly && action=="click" {
            let role=(item.1["role"] as? String ?? "").lowercased()
            return ["button","link","menuitem","checkbox","radio"].contains(where:role.contains)
        }
        return true
    }
    if action != "shortcut" && matches.count != 1 { return response(before, false, false, matches.isEmpty ? "No accessible control has that exact label." : "More than one accessible control has that exact label.") }
    let element = matches.first?.0
    if let element, (attribute(element, "AXEnabled") as? Bool) == false { throw Failure(message: "The control is disabled.") }
    // Recheck the target immediately before issuing the single action.
    guard inForeground(running), try (checkingSearch || token(window()) == identity) else { throw Failure(message: "The target window changed. Inspect it again.") }
    let clickingPageLink = pageOnly && action=="click" && element.map{text(attribute($0,"AXRole"))=="AXLink"}==true
    let destination = clickingPageLink ? element.flatMap(documentURL) : nil
    let selectedTabs = clickingPageLink ? browserChrome(target).tabs.filter(selectedTab) : []
    if clickingPageLink {
        guard inForeground(running),try token(window())==identity,element.flatMap(documentURL)==destination else {
            throw Failure(message:"The selected link or tab changed before activation. Inspect the page again.")
        }
    }
    var status = AXError.success
    var priorScroll:Double?
    if action == "click", let element { status = AXUIElementPerformAction(element, kAXPressAction as CFString) }
    else if pageOnly,let document,let initialURL=url,let element,action=="set-text" || checkingSearch {
        func currentDocument() -> Bool {
            guard inForeground(running),let win=try? window(),CFEqual(win,target),
                  let active=pageDocument(win),CFEqual(document,active),documentURL(active)==initialURL else {return false}
            return true
        }
        func focusedField() -> AXUIElement? {
            guard inForeground(running),let win=try? window(),CFEqual(win,target),
                  let focused=axElement(application,"AXFocusedUIElement"),!secure(focused) else {return nil}
            if CFEqual(focused,element) {return focused}
            // Chromium may place layout groups between an editable combobox and
            // its real text editor. A selected suggestion is never a key target.
            if text(attribute(element,"AXRole"))=="AXComboBox",pageTextRole(text(attribute(focused,"AXRole"))),
               within(focused,element,document) {return focused}
            return nil
        }
        func postKey(_ key:CGKeyCode, field:AXUIElement, string:[UniChar]=[]) throws {
            guard let focused=focusedField(),CFEqual(focused,field),let down=CGEvent(keyboardEventSource:nil,virtualKey:key,keyDown:true),
                  let up=CGEvent(keyboardEventSource:nil,virtualKey:key,keyDown:false) else {throw Failure(message:"The approved field lost focus. Inspect it before retrying.")}
            for event in [down,up] {
                event.flags=[]
                if !string.isEmpty {event.keyboardSetUnicodeString(stringLength:string.count,unicodeString:string)}
            }
            down.postToPid(running.processIdentifier)
            up.postToPid(running.processIdentifier)
        }
        func writeFocusedText(_ field:AXUIElement,_ prior:String,_ stillValid:()->Bool) throws {
            // Unicode key events invoke the page's ordinary editing/input listeners.
            // Replace the selection only after AX confirms that it covers this field.
            if !prior.isEmpty {
                var range=CFRange(location:0,length:prior.utf16.count),observed=CFRange()
                guard let selection=AXValueCreate(.cfRange,&range),AXUIElementSetAttributeValue(field,kAXSelectedTextRangeAttribute as CFString,selection) == .success,
                      let actual=attribute(field,"AXSelectedTextRange"),CFGetTypeID(actual)==AXValueGetTypeID(),
                      AXValueGetValue(unsafeBitCast(actual,to:AXValue.self),.cfRange,&observed),observed.location==0,observed.length==range.length else {
                    throw Failure(message:"The browser could not select the exact field contents for replacement. No text was sent.")
                }
            }
            guard stillValid(),let current=focusedField(),CFEqual(current,field),text(attribute(field,"AXValue"))==prior else {throw Failure(message:"The field changed before text entry.")}
            if input.isEmpty {try postKey(51,field:field)}
            else if input.rangeOfCharacter(from:.controlCharacters) != nil {
                guard text(attribute(field,"AXRole"))=="AXTextArea",AXUIElementSetAttributeValue(field,kAXValueAttribute as CFString,input as CFString) == .success else {throw Failure(message:"This field accepts single-line text only.")}
            } else {
                var batch=[UniChar]()
                for scalar in input.unicodeScalars {
                    let units=String(scalar).utf16
                    if batch.count+units.count>16 {try postKey(0,field:field,string:batch);batch.removeAll(keepingCapacity:true)}
                    batch.append(contentsOf:units)
                }
                if !batch.isEmpty {try postKey(0,field:field,string:batch)}
            }
        }
        guard !secure(element),pageTextRole(text(attribute(element,"AXRole"))),currentDocument() else {throw Failure(message:"The observed text field or its document changed.")}
        func fieldReceipt(_ tab:AXUIElement,_ button:AXUIElement?=nil,_ prepared:Bool=false,passiveFocus:String?=nil)throws->String {
            var data:[String:Any]=["pid":running.processIdentifier,"window":String(CFHash(target)),"tab":String(CFHash(tab)),
                                   "url":initialURL,"document":String(CFHash(document)),"field":String(CFHash(element))]
            if prepared {data["submitControl"]=button.map{String(CFHash($0))} ?? "enter"}
            if let passiveFocus {data["passiveFocus"]=passiveFocus}
            return try json(data)
        }
        if checkingSearch {
            func withheld(_ reason:String) -> [String:Any] {
                var result=response([],false,false,(action=="set-search-text" ? "No text was entered. " : "No Enter key was sent. ")+reason)
                result["inputIssued"]=false
                return result
            }
            guard !input.isEmpty,input.rangeOfCharacter(from:.controlCharacters)==nil,isSearchField(element,document) else {return withheld("The observed control does not expose search-field or search-form semantics. Inspect the search button instead.")}
            guard let scope=try? JSONDecoder().decode(SearchScope.self,from:Data(expected.utf8)) else {return withheld("The approved search scope is unavailable.")}
            guard running.processIdentifier==scope.pid else {return withheld("The browser process changed.")}
            guard String(CFHash(target))==scope.window else {return withheld("The selected browser window changed.")}
            guard initialURL==scope.url else {return withheld("The selected page address changed.")}
            let docID=String(CFHash(document)),elementID=String(CFHash(element))
            guard scope.document == nil || scope.document==docID else {return withheld("The browser document was replaced.")}
            guard scope.field == nil || scope.field==elementID else {return withheld("The search input was replaced.")}
            let chrome=browserChrome(target),tabs=chrome.tabs.filter(selectedTab)
            guard tabs.count==1,String(CFHash(tabs[0]))==scope.tab else {return withheld("The selected browser tab changed.")}
            let pinnedEdit=scope.document==docID && scope.field==elementID
            let field:AXUIElement
            if action=="set-search-text" {field=element}
            else if let focused=focusedField(),text(attribute(focused,"AXValue"))==input {field=focused}
            else if text(attribute(element,"AXValue"))==input {field=element}
            else {
                let editors=before.filter { item in
                    pageTextRole(item.1["role"] as? String ?? "") && !CFEqual(item.0,element) &&
                    within(item.0,element,document) && text(attribute(item.0,"AXValue"))==input
                }
                guard editors.count==1 else {return withheld("The observed search field no longer contains the exact requested query.")}
                field=editors[0].0
            }
            var writable=DarwinBoolean(false)
            let acceptsText=AXUIElementIsAttributeSettable(field,kAXValueAttribute as CFString,&writable) == .success && writable.boolValue
            guard !secure(field),acceptsText || (attribute(field,"AXEditable") as? Bool)==true else {return withheld("The search field is secure or read-only.")}
            let form=searchForm(element,document)
            let button=form.flatMap{searchButton(in:$0,document:document,items:before)}
            let targetControl=button?.0 ?? element
            let route=button.map{String(CFHash($0.0))} ?? "enter"
            // A directed AXValue write can leave browser focus on its selected
            // tab or on nonediting page content. Bind that object to the edit
            // receipt so selecting another control later is still a conflict.
            func retainedPageFocus(_ focused:AXUIElement) -> String? {
                guard button != nil,!secure(focused) else {return nil}
                if CFEqual(focused,tabs[0]) {return String(CFHash(focused))}
                let role=text(attribute(focused,"AXRole"))
                guard ["AXGroup","AXScrollArea","AXLayoutArea","AXStaticText","AXHeading","AXImage","AXLink","AXButton"].contains(role),
                      within(focused,document,document) else {return nil}
                var current:AXUIElement?=focused
                for _ in 0..<24 {
                    guard let node=current else {break}
                    if CFEqual(node,document) {return String(CFHash(focused))}
                    let role=text(attribute(node,"AXRole"))
                    if pageTextRole(role) || ["AXMenu","AXMenuBar","AXDialog","AXSheet","AXListBox","AXWebArea","AXDocument","AXHTMLContent"].contains(role) ||
                       secure(node) || (attribute(node,"AXEditable") as? Bool)==true {return nil}
                    current=axElement(node,"AXParent")
                }
                return nil
            }
            // Manually selecting another input, app, window or tab invalidates
            // this command. A suggestion inside this field's own search form
            // or popup may legitimately receive focus as the page processes input.
            func focusConflict() -> String? {
                if let conflict=conflictingPageFocus(document,search:element) {return conflict}
                if let focused=focusedField(),CFEqual(focused,field) || (action=="set-search-text" && within(focused,element,document)) {return nil}
                guard pinnedEdit else {return "Focus changed without a recent verified edit of this exact search field."}
                guard inForeground(running),let win=try? window(),CFEqual(win,target) else {return "The verified browser window is no longer focused."}
                let noButton="Focus left the search field and its landmark has no unique accessible Search button."
                guard let focused=axElement(application,"AXFocusedUIElement") else {return button==nil ? noButton : nil}
                if CFEqual(focused,target) || CFEqual(focused,document) || CFEqual(focused,application) {return button==nil ? noButton : nil}
                if let address=chrome.address,within(focused,address,target) {
                    guard button != nil else {return noButton}
                    guard unchangedAddressEditor(address,initialURL,browser:bundle),
                          CFEqual(address,focused) || unchangedAddressEditor(focused,initialURL,browser:bundle) else {
                        return "The address bar has an edit, selection, or suggestion. Finish it before submitting the page search."
                    }
                    return nil
                }
                if secure(focused) || pageTextRole(text(attribute(focused,"AXRole"))) || (attribute(focused,"AXEditable") as? Bool)==true {
                    return "Focus moved outside the authorized search form to another editable control."
                }
                // The focused AX node may be a text run inside another editor.
                // Stop even when that editor is a second field in the same form.
                var ancestor=axElement(focused,"AXParent")
                for _ in 0..<24 {
                    guard let node=ancestor,!CFEqual(node,element),!CFEqual(node,document),!CFEqual(node,target) else {break}
                    if secure(node) || pageTextRole(text(attribute(node,"AXRole"))) || (attribute(node,"AXEditable") as? Bool)==true {
                        return "Focus moved outside the authorized search form into another editor."
                    }
                    ancestor=axElement(node,"AXParent")
                }
                if let retained=retainedPageFocus(focused),action=="set-search-text" || scope.passiveFocus==retained {return nil}
                if passiveSearchContainer(focused,document:document,field:element,window:target) {return button==nil ? noButton : nil}
                if let form,within(focused,form,document) {return nil}
                for key in ["AXOwns","AXLinkedUIElements"] {
                    let related=attribute(element,key) as? [AXUIElement] ?? []
                    if related.contains(where:{within($0,document,document) && within(focused,$0,document)}) {return nil}
                }
                return "Focus moved outside the authorized search form to another control. Select the intended field before submitting."
            }
            // A preflight returns here. Mutating operations repeat the focus
            // check at their own input boundary after target validation.
            if action=="prepare-search",let conflict=focusConflict() {return withheld(conflict)}
            if action=="set-search-text" {
                guard pinnedEdit,let stamp=scope.searchValueStamp,let bounds=scope.paintedBounds else {return withheld("The field, previous value or highlighted bounds were not observed.")}
                let frame=CGRect(x:bounds.x,y:bounds.y,width:bounds.width,height:bounds.height)
                func liveTarget() -> Bool {
                    guard currentDocument(),selectedTab(tabs[0]),elementFrame(element)==frame,!secure(element),
                          (attribute(element,"AXEnabled") as? Bool) != false,within(element,document,document) else {return false}
                    if let form,let (control,_)=button {
                        return searchForm(element,document).map{CFEqual($0,form)}==true &&
                            searchForm(control,document).map{CFEqual($0,form)}==true && (attribute(control,"AXEnabled") as? Bool) != false
                    }
                    return focusedField() != nil
                }
                if button==nil && focusedField()==nil {return withheld("This search field has no unique Search button and is not focused.")}
                if button != nil && !acceptsText {return withheld("The identified search field does not support targeted editing.")}
                guard liveTarget(),searchValueStamp(element)==stamp else {return withheld("The observed search field, its contents or its position changed before editing.")}
                if let conflict=focusConflict() {return withheld(conflict)}
                let initialFocus=axElement(application,"AXFocusedUIElement").flatMap(retainedPageFocus)
                guard searchValueStamp(element)==stamp else {return withheld("The existing search text changed before editing.")}
                let alreadyMatches=(attribute(element,"AXValue") as? String)==input
                var issued=false
                if !alreadyMatches {
                    issued=true
                    if !acceptsText {
                        // Retain keyboard-only forms only when the original
                        // search field genuinely owns input. Never acquire focus.
                        guard button==nil,let editor=focusedField(),let prior=attribute(editor,"AXValue") as? String,
                              prior==attribute(element,"AXValue") as? String else {return withheld("The original search field does not own keyboard focus.")}
                        try writeFocusedText(editor,prior,liveTarget)
                    } else if AXUIElementSetAttributeValue(element,kAXValueAttribute as CFString,input as CFString) != .success {
                        // Never switch to keyboard input after an uncertain AX write.
                        var result=response([],false,false,"The search-field write was requested once. The browser did not confirm it; inspect the field.")
                        result["inputIssued"]=true
                        return result
                    }
                }
                // Suggestions can move/resize this field as an immediate
                // consequence of the edit. Verify the object and its value
                // after editing. Submission has its own target/geometry check.
                _=until(timeout:0.7,{(attribute(element,"AXValue") as? String)==input})
                func postEditConflict() -> String? {
                    guard inForeground(running),let currentWindow=try? window(),CFEqual(currentWindow,target) else {return "The browser window is no longer the foreground target."}
                    let currentTabs=browserChrome(currentWindow).tabs.filter(selectedTab)
                    guard currentTabs.count==1,CFEqual(currentTabs[0],tabs[0]) else {return "The selected tab changed."}
                    guard let doc=pageDocument(currentWindow),CFEqual(doc,document) else {return "The browser document changed."}
                    guard documentURL(doc)==initialURL else {return "The committed page address changed."}
                    guard within(element,doc,doc),pageFieldLabel(element)==selector,isSearchField(element,doc) else {return "The original labeled search field is no longer present in the verified document."}
                    guard !secure(element),(attribute(element,"AXEnabled") as? Bool) != false else {return "The field became secure or disabled."}
                    guard let value=attribute(element,"AXValue") as? String else {return "The field no longer exposes a text value."}
                    return value==input ? nil : "The original field does not contain the exact requested text."
                }
                let conflict=postEditConflict(),matches=conflict==nil
                var result=response([],matches,matches && issued,conflict.map{"Search-field verification failed. "+$0+" Inspect before continuing."} ?? "The observed search field contains the requested text. No form was submitted.")
                result["inputIssued"]=issued
                if matches {
                    let finalFocus=axElement(application,"AXFocusedUIElement").flatMap(retainedPageFocus)
                    result["windowToken"]=try fieldReceipt(tabs[0],passiveFocus:initialFocus==finalFocus ? initialFocus : nil)
                }
                return result
            }
            guard scope.submitControl==nil || scope.submitControl==route else {return withheld("The verified search submit control changed.")}
            if let bounds=scope.paintedBounds {
                guard elementFrame(targetControl)==CGRect(x:bounds.x,y:bounds.y,width:bounds.width,height:bounds.height) else {return withheld("The search target moved after it was highlighted.")}
            }
            if action=="prepare-search" {
                var checked=response(button.map{[$0]} ?? matches,true,false,"Verified the search field, query and submit target.")
                checked["windowToken"]=try fieldReceipt(tabs[0],button?.0,true,passiveFocus:scope.passiveFocus)
                return checked
            }
            guard pinnedEdit,scope.submitControl==route else {return withheld("A verified search target is required before submission.")}
            let selectedNow=browserChrome(target).tabs.filter(selectedTab)
            guard selectedNow.count==1,CFEqual(selectedNow[0],tabs[0]) else {return withheld("The selected tab changed at the point of submission.")}
            guard currentDocument(),text(attribute(field,"AXValue"))==input else {return withheld("The field or page changed at the point of submission.")}
            if let conflict=focusConflict() {return withheld(conflict)}
            if let (control,item)=button,let form {
                guard searchForm(control,document).map({CFEqual($0,form)})==true,(attribute(control,"AXEnabled") as? Bool) != false,
                      label(control)==item["label"] as? String else {return withheld("The search button changed before activation.")}
                if AXUIElementPerformAction(control,kAXPressAction as CFString) != .success {
                    var uncertain=response([],false,false,"The browser did not confirm the search button press. Inspect the page before continuing.")
                    uncertain["inputIssued"]=true
                    return uncertain
                }
            } else {
                if focusedField().map({CFEqual($0,field)}) != true {
                    guard AXUIElementSetAttributeValue(field,kAXFocusedAttribute as CFString,kCFBooleanTrue) == .success,
                          until(timeout:0.65,{focusedField().map({CFEqual($0,field)})==true}) else {return withheld("The browser could not restore focus to the verified search field.")}
                }
                guard currentDocument(),text(attribute(field,"AXValue"))==input,selectedTab(tabs[0]) else {return withheld("The search context changed while restoring field focus.")}
                let selectedSuggestions=attribute(element,"AXSelectedChildren") as? [AXUIElement] ?? []
                guard selectedSuggestions.isEmpty else {return withheld("A suggestion is selected and could receive Enter. Use the observed search control instead.")}
                try postKey(36,field:field)
            }
            let deadline=Date().addingTimeInterval(4)
            repeat {
                guard inForeground(running),let win=try? window(),CFEqual(win,target),
                      browserChrome(win).tabs.contains(where:{CFEqual($0,tabs[0]) && selectedTab($0)}) else {break}
                if let doc=pageDocument(win),let address=documentURL(doc),containsSubmittedQuery(address,from:initialURL,query:input) {
                    var result=response([],true,true,"The same browser tab navigated with the exact submitted search query. Inspect the page to verify its results.")
                    result["pageURL"]=address
                    result["inputIssued"]=true
                    result["windowToken"]=try token(win)
                    return result
                }
                RunLoop.current.run(until:Date().addingTimeInterval(0.08))
            } while Date()<deadline
            var uncertain=response([],false,false,"The verified search target was activated once. A results address containing the query was not observed. Inspect the page before continuing.")
            uncertain["inputIssued"]=true
            return uncertain
        }
        if focusedField()==nil {
            guard AXUIElementSetAttributeValue(element,kAXFocusedAttribute as CFString,kCFBooleanTrue) == .success,
                  until(timeout:0.6,{focusedField() != nil}) else {throw Failure(message:"The browser did not focus the observed field. No text was entered.")}
        }
        guard let field=focusedField(),currentDocument(),let prior=attribute(field,"AXValue") as? String else {throw Failure(message:"The browser did not expose an editable text value.")}
        var writable=DarwinBoolean(false)
        let valueIsSettable=AXUIElementIsAttributeSettable(field,kAXValueAttribute as CFString,&writable) == .success && writable.boolValue
        guard valueIsSettable || (attribute(field,"AXEditable") as? Bool)==true else {throw Failure(message:"The browser did not expose a writable text field. No text was sent.")}
        func editResponse(_ verified:Bool,_ changed:Bool,_ message:String)throws->[String:Any] {
            var result=response([],verified,changed,message)
            if verified,isSearchField(element,document),currentDocument() {
                let tabs=browserChrome(target).tabs.filter(selectedTab)
                if tabs.count==1 {result["windowToken"]=try fieldReceipt(tabs[0])}
            }
            return result
        }
        if prior==input {return try editResponse(true,false,"The observed field already contains the requested text.")}
        try writeFocusedText(field,prior,currentDocument)
        let verified=until(timeout:1,{focusedField().map{CFEqual($0,field)}==true && text(attribute(field,"AXValue"))==input}) && currentDocument()
        return try editResponse(verified,verified,verified ? "The observed field contains the requested text. No form was submitted." : "Input was sent once, but the resulting field value could not be verified. Inspect before retrying.")
    }
    else if action == "set-text", let element {
        guard !secure(element), ["AXTextField", "AXTextArea"].contains(text(attribute(element, "AXRole"))) else { throw Failure(message: "Select a non-secure accessible text control.") }
        status = AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, input as CFString)
    } else if action == "scroll", let element {
        guard text(attribute(element, "AXRole")) == "AXScrollBar", ["up", "down"].contains(input), let value = attribute(element, "AXValue") as? NSNumber else { throw Failure(message: "Select an accessible scrollbar.") }
        priorScroll=value.doubleValue
        status = AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, NSNumber(value: max(0, min(1, value.doubleValue + (input == "down" ? 0.2 : -0.2)))))
    } else if action == "shortcut" {
        let keys: [String: (CGKeyCode, CGEventFlags)] = ["editor-terminal": (50, .maskControl), "copy": (8, .maskCommand), "paste": (9, .maskCommand), "select-all": (0, .maskCommand), "save": (1, .maskCommand), "undo": (6, .maskCommand), "redo": (6, [.maskCommand, .maskShift]), "enter": (36, []), "escape": (53, []), "tab": (48, [])]
        guard let (key, flags) = keys[selector] else { throw Failure(message: "Unsupported shortcut.") }
        for _ in 0..<10 where NSWorkspace.shared.frontmostApplication?.processIdentifier != running.processIdentifier { Thread.sleep(forTimeInterval: 0.05) }
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier == running.processIdentifier, try token(window()) == identity else { throw Failure(message: "Target application did not gain focus or its window changed.") }
        if let focused = attribute(application, "AXFocusedUIElement"), CFGetTypeID(focused) == AXUIElementGetTypeID(), secure(unsafeBitCast(focused, to: AXUIElement.self)) { throw Failure(message: "Shortcuts in secure controls are unavailable.") }
        for down in [true, false] { guard let event = CGEvent(keyboardEventSource: nil, virtualKey: key, keyDown: down) else { throw Failure(message: "Unable to create the selected shortcut.") }; event.flags = flags; event.postToPid(running.processIdentifier) }
    }
    guard status == .success else { throw Failure(message: "The application rejected the accessible action (AX error \(status.rawValue)).") }
    if clickingPageLink {
        guard let destination,let url,!sameWebDestination(url,destination),selectedTabs.count==1 else {
            return response([],false,false,"The link was activated once. Its destination or selected tab could not be verified. Inspect the current page before retrying.")
        }
        // A matching destination must appear in the same, still-selected tab. An
        // advertisement changing, an unrelated redirect, or a new tab is not proof.
        let tab=selectedTabs[0], deadline=Date().addingTimeInterval(4)
        repeat {
            guard inForeground(running),let current=try? window(),CFEqual(current,target),
                  browserChrome(current).tabs.contains(where:{CFEqual($0,tab) && selectedTab($0)}) else {break}
            if let active=pageDocument(current),let address=documentURL(active),sameWebDestination(address,destination) {
                var verified=response([],true,true,"The selected link's destination loaded in the same browser tab.")
                verified["windowToken"]=try token(current)
                verified["pageURL"]=address
                return verified
            }
            RunLoop.current.run(until:Date().addingTimeInterval(0.08))
        } while Date()<deadline
        return response([],false,false,"The link was activated once. Its expected destination was not observed in the same tab. Inspect the current page before retrying.")
    }
    // Observe only; never repeat an action while waiting for its effect.
    let beforeJSON = try json(before.map { $0.1 })
    var after = before
    for _ in 0..<12 {
        Thread.sleep(forTimeInterval: 0.05)
        guard let current = try? window(), CFEqual(target, current) else { return response([], false, false, "The action changed or closed the window. Inspect the new target before continuing.") }
        if let document {
            guard let active=pageDocument(current),CFEqual(active,document),documentURL(active)==url else {return response([],false,false,"The page changed after the action. Inspect the new page before continuing.")}
        }
        after = controls(document ?? current, documentOnly:pageOnly)
        if action == "set-text", let element, text(attribute(element, "AXValue")) == input { return response(after, true, true, "The accessible text value matches the requested text.") }
        if let priorScroll,let element,let observed=attribute(element,"AXValue") as? NSNumber,
           input=="down" ? observed.doubleValue>priorScroll : observed.doubleValue<priorScroll {
            return response(after,true,true,"The observed scrollbar moved in the requested direction.")
        }
        if action != "set-text" && action != "scroll", try json(after.map { $0.1 }) != beforeJSON { return response(after, true, true, "The accessible application state changed after the action.") }
    }
    return response(after, false, false, "The action was invoked, but Athena could not verify a visible state change.")
}
#if !ATHENA_WINDOW_HIT_TEST
do { print(try json(result())) }
catch let failure as WindowTargetFailure { print((try? json(["error":failure.message,"code":failure.code])) ?? "{}") }
catch let failure as Failure { print((try? json(["error": failure.message])) ?? "{}") }
catch { print("{\"error\":\"Native accessibility inspection failed.\"}") }
#endif
