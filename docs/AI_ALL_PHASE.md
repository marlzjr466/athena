# ATHENA — AI IMPLEMENTATION BY PHASE

Implement Athena’s AI system in clear phases.

Important rules:

- Only work on the current phase.
- Do not implement future phases early.
- When the current phase is complete, stop.
- Summarize what was implemented.
- List files created or modified.
- List tests performed.
- Clearly state:

```text
PHASE X COMPLETE
Ready for the next phase.
```

Then wait for me to say:

```text
Proceed to next phase
```

Do not continue automatically.

Keep Athena’s existing:
- 3D model
- animations
- Superman-style flying
- tornado curve movement
- Free to Wander
- random actions
- position controls
- settings
- Electron floating behavior

unchanged unless the current phase specifically requires integration.

---

# PHASE 1 — OPENAI API KEY & AI ACTIVATION

Implement only the OpenAI configuration and activation system.

## Requirements

Add:

```text
Settings
→ AI
```

UI:

```text
AI Provider
OpenAI

Status
○ Not configured

API Key
[ Enter OpenAI API key ]

[ Test Connection ]
[ Save & Activate ]
```

After activation:

```text
Status
● Active

API Key
sk-••••••••••••••

Model
[ Select model ]

[ Test Connection ]
[ Replace API Key ]
[ Remove API Key ]
```

## Security

- Do not hardcode the API key.
- Do not store it in localStorage.
- Do not expose it to the React renderer after saving.
- Do not log it.
- Store it securely using the OS keychain/credential storage.
- Keep secret handling in the Electron main process.

Architecture:

```text
React Settings UI
→ typed IPC
→ Electron Main Process
→ secure credential storage
→ OpenAI service
```

## Test Connection

Implement:

```text
Test Connection
```

States:

```text
Not configured
Testing...
Connection successful
Invalid API key
Connection failed
```

Do not activate AI until the OpenAI connection succeeds.

## Remove Key

When removed:

```text
AI Status = Not configured
```

AI features remain disabled.

## Phase 1 Done When

- User can enter an API key.
- User can test it.
- Valid key activates AI.
- Invalid key does not activate AI.
- Key is securely stored.
- Key survives restart.
- Saved key is masked.
- User can replace/remove it.

Stop after Phase 1.

Restart my current running app to reflect the changes

---

# PHASE 2 — OPENAI PROVIDER & TEXT CHAT

Start this phase only when I say:

```text
Proceed to next phase
```

Implement Athena text conversation.

## Requirements

Create:

```ts
interface AIProvider {
  testConnection(): Promise<boolean>

  streamMessage(
    messages: ChatMessage[]
  ): AsyncIterable<AIChunk>
}
```

Create:

```text
OpenAIProvider
```

Support:

- user messages
- AI responses
- streaming
- conversation history
- stop generation
- retry
- clear conversation
- Markdown
- code blocks
- loading/error states

## Chat Flow

```text
User message
→ Athena thinking
→ OpenAI request
→ streamed response
→ Athena speaking
→ complete
→ Athena idle
```

If AI is not configured:

```text
Athena AI is not configured.

Add your OpenAI API key in:
Settings → AI
```

## Athena Personality

Use:

```text
You are Athena, an intelligent desktop AI companion.

You are friendly, calm, intelligent, concise, helpful, and proactive.

You live on the user's desktop and can communicate naturally.

Never claim to have performed a desktop action unless an Athena tool confirms it.

Never bypass Athena's permission system.
```

## Phase 2 Done When

- User can chat with Athena.
- Real OpenAI response is returned.
- Response streams.
- Chat history works.
- Thinking/speaking/idle state integration works.
- Existing Athena movement is not broken.

Stop after Phase 2.

Restart my current running app to reflect the changes

---

# PHASE 3 — PERMISSION SYSTEM FOUNDATION

Start only after:

```text
Proceed to next phase
```

Implement Athena's central permission architecture.

## Permissions

Support:

```text
Microphone
Screen Capture & Awareness
Application Detection
Desktop Automation
Personal File Access
```

Create:

```ts
type AthenaPermission =
  | 'microphone'
  | 'screenCapture'
  | 'applicationDetection'
  | 'desktopAutomation'
  | 'personalFiles'
```

Status:

```ts
type PermissionStatus =
  | 'not-requested'
  | 'allowed'
  | 'denied'
  | 'restricted'
  | 'unavailable'
```

Create APIs:

```text
getPermissionStatus()
requestPermission()
openPermissionSettings()
isCapabilityAllowed()
```

Keep application preference separate from OS permission.

## Permissions UI

Replace placeholder rows with real functional states.

Example:

```text
Microphone Access
Allowed
[ ON ]

Screen Capture & Awareness
Not requested
[ OFF ]
```

## Phase 3 Done When

- Permission service exists.
- Permissions page is functional.
- Real states are displayed.
- Permission checks are centralized.
- No fake OS permission state is shown.

Stop after Phase 3.

Restart my current running app to reflect the changes

---

# PHASE 4 — MICROPHONE & SPEECH-TO-TEXT

Start only after:

```text
Proceed to next phase
```

Implement voice input.

## Requirements

Add:

```text
Push-to-talk
```

Flow:

```text
User presses microphone
→ check microphone permission
→ start listening
→ speech-to-text
→ transcript appears in chat
```

Athena state:

```text
listening
```

When speech ends:

```text
transcript
→ same chat system used by text
```

Do not create separate conversation logic for voice.

## Phase 4 Done When

- Microphone permission works.
- Push-to-talk works.
- Speech converts to text.
- Transcript enters normal Athena chat.
- Listening animation/state works.

Stop after Phase 4.

Restart my current running app to reflect the changes

---

# PHASE 5 — TEXT-TO-SPEECH

Start only after:

```text
Proceed to next phase
```

Implement Athena voice output.

## Requirements

Athena should speak AI responses.

Add:

```text
Enable Voice
Voice Selection
Speech Speed
Volume
Mute
```

Flow:

```text
OpenAI response
→ text displayed
→ text-to-speech
→ Athena speaking state
→ speech completes
→ Athena idle
```

Voice and text must stay synchronized.

## Phase 5 Done When

- Athena can speak responses.
- User can mute speech.
- Voice/speed/volume settings work.
- Speaking state works correctly.

Stop after Phase 5.

Restart my current running app to reflect the changes

---

# PHASE 6 — APPLICATION DETECTION

Start only after:

```text
Proceed to next phase
```

Implement controlled application awareness.

Create:

```ts
interface ApplicationDetectionService {
  getActiveApplication(): Promise<AppInfo>
  getRunningApplications(): Promise<AppInfo[]>
}
```

Only allow access when:

```text
Application Detection = ON
```

Prepare tools:

```text
get_active_app
get_running_apps
```

Example:

```text
User:
What app am I using?

Athena
→ permission check
→ get_active_app
→ return result
```

## Phase 6 Done When

- Active app detection works.
- Running app detection works.
- Disabled permission blocks access.
- No unrestricted OS API is exposed to React.

Stop after Phase 6.

Restart my current running app to reflect the changes

---

# PHASE 7 — DESKTOP AUTOMATION & TOOL SYSTEM

Start only after:

```text
Proceed to next phase
```

Implement safe desktop actions.

Create:

```ts
interface AthenaTool {
  name: string
  description: string
  execute(input: unknown): Promise<ToolResult>
}
```

Initial tools:

```text
open_application
focus_application
open_url
show_notification
```

Flow:

```text
OpenAI requests tool
→ validate input
→ permission check
→ execute tool
→ return result
→ Athena responds
```

Never execute raw AI-generated shell commands.

Use Zod for tool input validation.

## Example

```text
User:
Open VS Code.

OpenAI:
open_application("Visual Studio Code")

Permission:
Desktop Automation = ON

Electron:
open VS Code

Athena:
VS Code is open.
```

## Phase 7 Done When

- Structured tool system works.
- Desktop automation permission gates tools.
- Open/focus application works.
- Open URL works.
- Tool results return to AI.
- Athena never claims success without tool confirmation.

Stop after Phase 7.

Restart my current running app to reflect the changes

---

# PHASE 8 — OPENAI TOOL CALLING

Start only after:

```text
Proceed to next phase
```

Connect OpenAI structured tool calls to Athena tools.

Flow:

```text
User
→ OpenAI
→ tool request
→ Athena permission gate
→ tool execution
→ result returned to OpenAI
→ final Athena response
```

Support basic multi-step tool flow where necessary.

Do not create a fully autonomous agent yet.

## Phase 8 Done When

- OpenAI can request Athena tools.
- Tool result is sent back to OpenAI.
- Final response uses the real result.
- Permission checks always run first.

Stop after Phase 8.

Restart my current running app to reflect the changes

---

# PHASE 9 — SCREEN CAPTURE & AWARENESS

Start only after:

```text
Proceed to next phase
```

Implement:

```text
Screen Capture & Awareness
```

When OFF:

Athena cannot inspect the screen.

When ON:

- request OS permission;
- capture only when needed;
- do not continuously record;
- provide the captured image to the AI only for approved requests.

Prepare:

```text
capture_screen
read_screen
```

Example:

```text
User:
What is on my screen?

→ permission check
→ capture screen
→ send image/context to OpenAI
→ Athena responds
```

## Phase 9 Done When

- Screen permission works.
- Screenshot capture works.
- Disabled permission blocks capture.
- Athena can reason about approved screen captures.
- No continuous capture happens.

Stop after Phase 9.

Restart my current running app to reflect the changes

---

# PHASE 10 — PERSONAL FILE ACCESS

Start only after:

```text
Proceed to next phase
```

Implement controlled file access.

Support:

```text
Choose File
Choose Folder
Read Approved File
```

Do not grant unrestricted filesystem access just because the permission is ON.

Prepare tools:

```text
open_file
read_file
```

Only operate on user-approved paths.

## Phase 10 Done When

- User can authorize a file/folder.
- Athena can read approved files.
- Disabled permission blocks access.
- File contents are only sent to AI when necessary and approved.

Stop after Phase 10.

Restart my current running app to reflect the changes

---

# PHASE 11 — AI + VOICE + TOOLS INTEGRATION

Start only after:

```text
Proceed to next phase
```

Combine:

```text
Text
Voice
OpenAI
Permissions
Tools
Desktop actions
```

Expected:

```text
User speaks:
"Open Chrome"

→ microphone
→ speech-to-text
→ OpenAI
→ open_application
→ permission check
→ Chrome opens
→ Athena says:
"Chrome is open."
```

Everything must use the same conversation and tool architecture.

## Phase 11 Done When

- Text commands work.
- Voice commands work.
- Tools work from both.
- Permissions are respected everywhere.
- Athena speaks real tool results.

Stop after Phase 11.

Restart my current running app to reflect the changes

---

# PHASE 12 — HARDENING & FINAL REVIEW

Start only after:

```text
Proceed to next phase
```

Review the entire AI system.

Check:

- API key security
- no secret logging
- typed IPC
- no unrestricted Node access
- no raw AI shell execution
- permission enforcement
- error handling
- network failures
- OpenAI rate limits
- invalid API key handling
- voice failures
- denied OS permissions
- tool failures
- state cleanup
- timer cleanup
- existing Athena animations still work

Add/update tests for all important flows.

## Final Acceptance

Athena should support:

```text
OpenAI API activation
Text conversation
Streaming
Voice input
Voice output
Permissions
Application detection
Desktop automation
Tool calling
Screen awareness
Controlled file access
```

without breaking the existing Athena character experience.

When complete, report:

```text
ATHENA AI IMPLEMENTATION COMPLETE
```

Restart my current running app to reflect the changes