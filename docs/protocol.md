# Wire protocol — Watch ⇄ Bridge

Two protocols live in this project. Don't confuse them.

```
┌──────────────┐   Protocol A: JSON over WebSocket    ┌──────────────┐   Protocol B: ZCode Protocol   ┌────────────┐
│ watchOS app  │ ───────────────────────────────────► │    bridge    │ ─────────────────────────────► │   zcode    │
│ (SwiftUI)    │ ◄─────────────────────────────────── │  (Node.js)   │ ◄───────────────────────────── │ app-server │
└──────────────┘                                      └──────────────┘      newline-delimited JSON     └────────────┘
```

- **Protocol A** (this document, first half) is stable and defined by this repo.
- **Protocol B** (second half) is ZCode's own stdio protocol, reconstructed by
  probing the CLI. It may change with CLI releases; the bridge is written to
  tolerate that.

---

## Protocol A — watch ⇄ bridge (WebSocket, `ws://host:8788/ws`)

Messages are JSON text frames. Every message has a `type`.

### Handshake

The bridge must be paired once. The PIN is printed by the bridge on startup
(`~/.zcode-watch-remote/config.json`).

Watch → bridge, first time:

```json
{ "type": "pair", "pin": "123456", "device": "Apple Watch" }
```

Bridge → watch on success (store `token` in the keychain/AppStorage):

```json
{
  "type": "paired",
  "token": "…64 hex chars…",
  "bridgeName": "macbook",
  "bridgeVersion": "0.1.0",
  "projects": [{ "name": "api", "path": "/Users/me/code/api" }],
  "sessions": [ /* SessionSummary[] */ ]
}
```

On later launches the watch authenticates with the token instead of the PIN:

```json
{ "type": "hello", "token": "…", "device": "Apple Watch" }
```

Bridge → watch: `{"type":"welcome","bridgeName":…,"projects":[…],"sessions":[…]}`.

Both handshakes are followed by a `sessions` message, so clients can handle the
list in exactly one place.

Failures: `{"type":"error","error":"bad-pin"|"bad-token"|"unauthorized"|"approval-failed", "message":"…"}`.
Three bad PINs close the socket with code `4003`; a bad token closes with `4001`.

### SessionSummary

```json
{
  "id": "sess_…",
  "title": "Fix the login bug",
  "status": "idle",              // idle | running | waiting | stopped | failed | unknown
  "mode": "build",               // plan | build | edit | yolo
  "projectName": "web",
  "projectPath": "/Users/me/code/web",
  "updatedAt": 1790952774158,
  "lastText": "Looking at auth.ts now…",
  "waitingApproval": false
}
```

### Watch → bridge

| Message | Payload | Effect |
|---|---|---|
| `sessions-list` | — | Ask for a fresh `sessions` message |
| `new-session` | `projectPath` | Create a session in that project (must be listed in the bridge's `allowedProjects`) |
| `session-open` | `sessionId` | Subscribe and replay the transcript |
| `session-close` | — | Stop viewing (nothing to release server-side) |
| `prompt` | `sessionId`, `text` | Send a user message |
| `interrupt` | `sessionId` | Stop the current turn |
| `permission-response` | `sessionId`, `requestId`, `allow` | Approve/deny a tool call |
| `set-mode` | `sessionId`, `mode` | Switch permission mode |
| `remove-session` | `sessionId` | Drop a session from the list |
| `ping` | — | Liveness check |

### Bridge → watch

| Message | Payload |
|---|---|
| `sessions` | `sessions: SessionSummary[]` (sent on any change, and after handshake) |
| `session-created` | `sessionId` |
| `session-state` | `sessionId`, `status`, `summary?`, `events: TranscriptEvent[]` |
| `session-event` | `sessionId`, `ev: TranscriptEvent` |
| `prompt-accepted` | `sessionId` |
| `permission-accepted` | `sessionId`, `requestId` |
| `external-event` | `event`, `message`, `project` (from the HTTP `/hook` endpoint; see below) |
| `pong` | — |

### TranscriptEvent

A small, normalized view of ZCode's rich event stream:

```json
{ "kind": "text",       "role": "assistant", "text": "Here's what I found…" }
{ "kind": "tool",       "tool": "Bash", "state": "started", "detail": "npm test" }
{ "kind": "tool",       "tool": "Bash", "state": "done",    "detail": "12 tests passed" }
{ "kind": "permission", "requestId": "ap_123", "tool": "Bash", "summary": "rm -rf build" }
{ "kind": "result",     "text": "Turn complete", "isError": false }
{ "kind": "error",      "message": "…" }
{ "kind": "status",     "status": "running" }
```

`kind: "permission"` is the important one: the watch shows Allow/Deny buttons and
sends back `permission-response` with the same `requestId`.

### HTTP endpoints (same port)

| Endpoint | Purpose |
|---|---|
| `GET /` | Status page: bridge name, PIN, watch URL, live session table |
| `GET /health` | `{"ok":true,"appServer":"up"}` — use it in scripts |
| `GET|POST /hook?token=…&event=stop&message=…` | Push a notification to every connected watch |

The `/hook` endpoint is how ZCode hooks can buzz your wrist, e.g. a `Stop` hook:

```json
{
  "hooks": {
    "Stop": [{ "type": "command", "command": "curl -s 'http://127.0.0.1:8788/hook?token=YOUR_TOKEN&event=stop&message=Task%20finished' >/dev/null" }]
  }
}
```

---

## Protocol B — bridge ⇄ zcode app-server (stdio)

Newline-delimited JSON over the child process's stdin/stdout.

```
client → server   {"id":"c1","method":"session/send","params":{…}}
server → client   {"id":"c1","result":{…}}  |  {"id":"c1","error":{"code":-32602,"message":"…"}}
server → client   {"method":"session/event","params":{…}}                  ← notification
server → client   {"id":"server-1","method":"session/requestRuntimePreferences","params":{…}}  ← REQUEST: must answer
```

### Methods used by the bridge

| Method | Params | Notes |
|---|---|---|
| `session/list` | `{}` | `{sessions:[…]}` — includes sessions owned by other ZCode frontends |
| `session/create` | `{workspace:{workspacePath,workspaceKey}, mode?}` | Strict schema; can take seconds; triggers a reverse request (below) |
| `session/subscribe` | `{sessionId, deliveryKind}` | `deliveryKind`: `web-remote-replayable` \| `desktop-continuous` |
| `session/resume` | `{sessionId}` | Take over a session owned by another process |
| `session/send` | `{sessionId, content}` | `content`: string **or array of message items** |
| `session/read` | `{sessionId}` | Strict schema — no `limit` |
| `session/stop` | `{sessionId}` | Interrupt the turn |
| `session/setMode` | `{sessionId, mode}` | `plan` \| `build` \| `edit` \| `yolo` |

### Reverse requests (server → client)

`session/requestRuntimePreferences` arrives mid-`session/create`. If it is not
answered, the create **times out after 15 s**. The bridge answers:

```json
{"nativeSearchEnhancementsEnabled":false,"memoryEnabled":false,
 "askUserQuestionAutoResolutionEnabled":true,"modelContextBudgetStrategy":"preflight-v1"}
```

### Approvals

A decision travels back as a message item in `session/send`:

```json
{"sessionId":"sess_…","content":[{"type":"tool-approval-response","approvalId":"ap_…","approved":true,"reason":"Approved from Apple Watch"}]}
```

The bridge tries this first, then a stringified variant, then
`session/approvalResponse`, so it keeps working if the upstream shape shifts.

### Known limitations

- Subscribing to a session **owned by another process** fails with
  `-32004 Session is not active`. The bridge falls back to `session/resume`.
- `session/event` payload shapes vary by CLI version. The bridge classifies them
  tolerantly; with `"debugEvents": true` in the config every raw event is
  appended to `~/.zcode-watch-remote/events-debug.jsonl` for inspection.
