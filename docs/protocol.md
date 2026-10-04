# Wire protocol — Watch ⇄ Bridge ⇄ ZCode

Two protocols live in this project. Don't confuse them.

```
┌──────────────┐   Protocol A: JSON over WebSocket    ┌──────────────┐   Protocol B: ZCode Protocol   ┌────────────┐
│ watchOS app  │ ───────────────────────────────────► │    bridge    │ ─────────────────────────────► │   zcode    │
│ (SwiftUI)    │ ◄─────────────────────────────────── │  (Node.js)   │ ◄───────────────────────────── │ app-server │
└──────────────┘                                      └──────────────┘      newline-delimited JSON     └────────────┘
```

Protocol A is stable and defined by this repo. Protocol B is ZCode's own stdio
protocol, reconstructed by probing CLI v0.16.9 and cross-checked against the
session database (`.zcode/cli/db/db.sqlite`) and the bundled `zcode.cjs`.

---

## Protocol A — watch ⇄ bridge (WebSocket, `ws://host:8788/ws`)

Messages are JSON text frames, each with a `type`.

### Handshake

Pair once with the 6-digit PIN the bridge prints at startup; the bridge returns
a token the watch stores.

```json
{ "type": "pair", "pin": "123456", "device": "Apple Watch" }
```
```json
{ "type": "paired", "token": "…48 hex…", "bridgeName": "macbook",
  "bridgeVersion": "0.1.0", "projects": [{"name":"api","path":"/code/api"}],
  "sessions": [ /* SessionSummary[] */ ] }
```

Later launches reuse the token:

```json
{ "type": "hello", "token": "…", "device": "Apple Watch" }
```
```json
{ "type": "welcome", "bridgeName": "macbook", "projects": [...], "sessions": [...] }
```

Both handshakes are followed by a `sessions` message so clients handle the list
in one place. Errors arrive as
`{"type":"error","error":"bad-pin"|"bad-token"|"unauthorized"|"approval-failed"|"answer-failed","message":"…"}`.
Three bad PINs close the socket with code `4003`; a bad token closes with `4001`.

### SessionSummary

```json
{ "id": "sess_…", "title": "Fix the login bug",
  "status": "idle",          // idle | running | waiting | paused | completed | error | stopped
  "mode": "build",           // plan | build | edit | yolo | auto
  "projectName": "web", "projectPath": "/code/web",
  "updatedAt": 1790952774158, "lastText": "Looking at auth.ts now…",
  "waitingApproval": false }
```

### Watch → bridge

| Message | Payload | Effect |
|---|---|---|
| `sessions-list` | — | Request a fresh `sessions` message |
| `new-session` | `projectPath` | Create a session (must be in the bridge's `allowedProjects`) |
| `session-open` | `sessionId` | Subscribe and replay the transcript |
| `session-close` | — | Stop viewing |
| `prompt` | `sessionId`, `text` | Send a user message |
| `interrupt` | `sessionId` | Stop the current turn |
| `permission-response` | `sessionId`, `requestId`, `allow`, `optionId?` | Approve/deny a tool call. **Send `optionId` when the card offered options** — the bridge then relays ZCode's own prepared response verbatim |
| `answer-input` | `sessionId`, `requestId`, `text?`, `cancelled?` | Answer an AskUserQuestion prompt |
| `set-mode` | `sessionId`, `mode` | plan / build / edit / yolo / auto |
| `remove-session` | `sessionId` | Drop a session from the list |
| `ping` | — | Liveness check |

### Bridge → watch

| Message | Payload |
|---|---|
| `sessions` | `sessions: SessionSummary[]` (on any change, and after the handshake) |
| `session-created` | `sessionId` |
| `session-state` | `sessionId`, `status`, `summary?`, `events: TranscriptEvent[]` |
| `session-event` | `sessionId`, `ev: TranscriptEvent` |
| `prompt-accepted` | `sessionId` |
| `permission-accepted` / `input-accepted` | `sessionId`, `requestId` |
| `external-event` | `event`, `message`, `project` (from the HTTP `/hook` endpoint) |
| `pong` | — |

### TranscriptEvent

A compact view of ZCode's event stream.

```json
{ "kind": "text",       "role": "assistant", "text": "Here's what I found…", "streaming": true }
{ "kind": "thinking",   "text": "Checking the config first…" }
{ "kind": "tool",       "tool": "Bash", "state": "started", "detail": "npm test", "callId": "call_1" }
{ "kind": "tool",       "tool": "Bash", "state": "done",    "detail": "12 tests passed", "callId": "call_1" }
{ "kind": "permission", "requestId": "ap_7", "tool": "Bash", "riskLevel": "high",
  "summary": "rm -rf build deletes files",
  "options": [ { "id": "allow", "name": "Allow once", "description": "" },
               { "id": "deny",  "name": "Deny",       "description": "" } ] }
{ "kind": "question",   "requestId": "q_3", "prompt": "Which database?",
  "questions": [ { "header": "DB", "question": "Which database?", "multiSelect": false,
                   "options": [ { "label": "Postgres", "description": "server" } ] } ] }
{ "kind": "result",     "text": "Turn complete", "isError": false }
{ "kind": "error",      "message": "…" }
{ "kind": "status",     "status": "running", "note": "permission allow" }
```

Two flags keep the transcript tidy:

- **`streaming: true`** — the assistant is still typing. The watch replaces its
  previous streaming bubble of the same kind instead of appending.
- **`replace: true`** — this card supersedes the earlier card with the same
  `requestId` (the bridge may emit a placeholder from the event stream and then
  upgrade it with the details from the authoritative reverse request).

`kind: "permission"` and `kind: "question"` are the actionable ones: show
Allow/Deny (or the offered options) and reply with the same `requestId`.

### HTTP endpoints (same port)

| Endpoint | Purpose |
|---|---|
| `GET /` | Status page: bridge name, PIN, watch URL, live session table |
| `GET /health` | `{"ok":true,"appServer":"up"}` |
| `GET\|POST /hook?token=…&event=stop&message=…` | Push a notification to every connected watch |

A ZCode hook can buzz your wrist, e.g.:

```json
{ "hooks": { "Stop": [ { "type": "command",
  "command": "curl -s 'http://127.0.0.1:8788/hook?token=YOUR_TOKEN&event=stop&message=Task%20finished' >/dev/null" } ] } }
```

---

## Protocol B — bridge ⇄ zcode app-server (stdio)

`zcode app-server --stdio`, newline-delimited JSON.

```
client → server   {"id":"c1","method":"session/send","params":{…}}
server → client   {"id":"c1","result":{…}}  |  {"id":"c1","error":{"code":-32602,"message":"…"}}
server → client   {"method":"session/event","params":{…}}                 ← notification
server → client   {"id":"server-1","method":"interaction/requestPermission","params":{…}}  ← REQUEST: the agent blocks until answered
```

### Client → server methods (the ones the bridge uses)

| Method | Params | Notes |
|---|---|---|
| `session/list` | `{}` | `{sessions:[{sessionId,title,status,mode,sessionKind,createdAt,updatedAt,workspace:{workspacePath,workspaceKey}}]}` — includes sessions owned by other frontends |
| `session/create` | `{workspace:{workspacePath,workspaceKey}, mode?}` | Strict schema; takes seconds; triggers a reverse request (below) |
| `session/subscribe` | `{sessionId, deliveryKind}` | `deliveryKind`: `web-remote-replayable` \| `desktop-continuous` |
| `session/resume` | `{sessionId}` | Take over a session owned by another process |
| `session/send` | `{sessionId, content}` | `content` is a string |
| `session/read` | `{sessionId}` | Strict schema — **no `limit` parameter** |
| `session/stop` | `{sessionId}` | Interrupt the turn |
| `session/setMode` | `{sessionId, mode}` | `plan` \| `build` \| `edit` \| `yolo` \| `auto` |

Others present in the CLI: `session/messages`, `session/events`, `session/compact`,
`session/fork`, `session/setModel`, `session/usage`, `session/goal`,
`session/subagents`, `session/close`, `session/cancelBackgroundTask`,
`workspace/readPresentation`, `usage/stats`.

### The session event envelope

Every `session/event` notification has exactly this shape:

```json
{ "method": "session/event", "params": {
  "sessionId": "sess_…", "seq": 412, "type": "part.upserted",
  "deliveryKind": "web-remote-replayable", "eventId": "…", "traceId": "…",
  "turnId": "turn_…", "timestamp": 1790952774158,
  "payload": { … type-specific … } } }
```

`type` values the bridge understands:

| `type` | `payload` | Bridge maps to |
|---|---|---|
| `turn.started` | — | `status: running` |
| `turn.completed` | `{response, tokenCount, toolCallCount, duration, usage, …}` | `result` (uses `response`) + `status: idle` |
| `turn.failed` | `{message?, error?}` | `error` + `status: error` |
| `model.streaming` | `{kind: text_delta\|reasoning_delta\|…, delta, partId}` | accumulated `text` / `thinking` |
| `part.started` / `part.upserted` | `{part: {type, …}}` | see part types below |
| `part.delta` / `part.removed` | — | ignored |
| `tool.updated` | `{kind: scheduled\|started\|progress\|result\|error\|batch, toolCallId, toolName, input?, result?, error?}` | `tool` events |
| `permission.requested` | `{requestId?, toolCallId, toolName, riskLevel, reason, input, options[]}` | `permission` (deduped with the reverse request) |
| `permission.resolved` | `{requestId?, toolCallId, decision, reason?}` | `status` note |
| `message.upserted` | `{content, type?, toolCalls?, attachments?}` | user `text` |
| `userInput.requested` | `{requestId, prompt, inputType?, choices?}` | `question` |
| `userInput.resolved` | `{requestId, value?, cancelled?}` | `status` note |
| `session.created/updated/titleUpdated/resumed` | — | refresh the session list |
| `session.closed` | `{reason?}` | `status: stopped` |

Part types inside `part.started` / `part.upserted` (same objects the CLI persists
in `part.data` of the session database):

```json
{ "type": "text",      "text": "…", "synthetic"?: true, "metadata"?: { "visibility": "model-only" } }
{ "type": "reasoning", "text": "…", "metadata"?: {…} }
{ "type": "tool",      "callID": "call_…", "tool": "Bash",
  "state": { "status": "pending", "input": …, "raw": "…" } |
           { "status": "running", "input": …, "title"?, "metadata"?, "startedAt" } |
           { "status": "completed", "input": …, "output": "…", "title": "…", "startedAt", "completedAt" } |
           { "status": "error", "input": …, "error": "…", "startedAt", "completedAt" } }
{ "type": "step-start"  } 
{ "type": "step-finish", "reason": "…", "cost": 0.01, "tokens": {…} }
{ "type": "file",       "mime": "…", "url": "…", "filename"?: "…" }
```

`synthetic: true` and `metadata.visibility === "model-only"` parts are internal
reminders — the bridge drops them so they never reach the watch.

### Reverse requests: the agent blocks until you answer

`session/create` asks one mid-flight; getting it wrong makes create time out:

```json
{ "id": "server-1", "method": "session/requestRuntimePreferences",
  "params": { "sessionId": "sess_…", "scope": "runtime-materialization" } }
```
Answer:
```json
{ "nativeSearchEnhancementsEnabled": false, "memoryEnabled": false,
  "askUserQuestionAutoResolutionEnabled": true, "modelContextBudgetStrategy": "preflight-v1" }
```

**Tool approvals and questions arrive the same way** — as requests, not events:

```json
{ "id": "server-2", "method": "interaction/requestPermission", "params": {
  "sessionId": "sess_…", "requestId": "ap_…", "toolCallId": "call_…", "turnId": "turn_…",
  "toolName": "Bash", "riskLevel": "low|medium|high|critical",
  "reason": "rm -rf build deletes files", "input": { "command": "rm -rf build" },
  "options": [ { "optionId": "allow", "kind": "allow", "name": "Allow once",
                 "description": "…", "response": { "decision": "allow" } },
               { "optionId": "deny", "kind": "deny", "name": "Deny",
                 "response": { "decision": "deny", "reason": "…" } } ] } }
```

Answer by replying to that request id with a decision:

```json
{ "decision": "allow" | "deny" | "modify" | "escalate",
  "reason": "Approved from Apple Watch", "modifiedInput": {…}, "resolvedAt": "…" }
```

The bridge prefers the ready-made `options[].response` object that matches the
option the user tapped, and only synthesises a decision when a request carries
no options. `AskUserQuestion` / `ExitPlanMode` arrive through the same door
(`interaction/requestUserInput` carries `questions[]`); answers travel as
`{decision: "modify", modifiedInput: {...input, answers: {"<question>": "<answer>"}}}`.

#### Fallback policy (so a turn can never hang forever)

Nobody may be wearing the watch when the agent asks. The bridge then applies
`permissionFallback` from its config:

| Value | Behaviour |
|---|---|
| `deny` (default) | Refuse immediately and tell the agent why |
| `allow` | Approve — for unattended runs |
| `wait` | Never answer; leave it to the desktop app or terminal |

With a watch attached the request waits up to `permissionTimeoutMs`
(default 5 min) before the fallback applies.

### Known limitations

- Subscribing to a session **owned by another process** fails with
  `-32004 Session is not active`; the bridge falls back to `session/resume`.
- `session/event` payloads evolve between CLI releases. `_classify()` in
  `bridge/src/hub.js` is tolerant, and with `"debugEvents": true` every raw
  envelope is appended to `~/.zcode-watch-remote/events-debug.jsonl`.
