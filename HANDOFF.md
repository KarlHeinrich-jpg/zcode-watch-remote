# HANDOFF — ZCode Remote for Apple Watch

> Status snapshot for whoever picks this up next (human or agent).
> Last updated: 2026-10-05 (session 3 — pushed to GitHub, watch app compiles on CI).

## What this project is

A GitHub project that lets an **Apple Watch** remotely drive **ZCode** agent
sessions running on your computer. Two halves plus tooling:

| Part | Path | Language | State |
|---|---|---|---|
| Bridge (runs on the PC) | `bridge/` | Node.js, **zero dependencies** | ✅ implemented against the real protocol, 46/46 e2e tests pass, verified against a real ZCode install |
| Watch app (watchOS) | `watch/` | SwiftUI (11 files) | ⚠️ source complete, Xcode project + icon generated, **never compiled** (no macOS available) |
| Tooling | `tools/` | Node.js | ✅ icon generator, pbxproj checker, Swift sanity checker — all wired into CI |
| Docs | `README.md`, `README.zh-CN.md`, `docs/protocol.md`, `HANDOFF.md` | — | ✅ |

Neither half has been run on real hardware yet. The bridge has been run for real
(against the actual `zcode.cjs`); the watch app has only been structurally checked.

## Hard-won environment facts (do not re-derive)

- ZCode on this machine is a **desktop app**: `F:\zcode\ZCode.exe`, CLI bundle at
  `F:\zcode\resources\glm\zcode.cjs` (v0.16.9). `zcode` is **not on PATH**.
- The build sandbox has **no outbound internet** (`curl registry.npmjs.org` → `000`).
  That is why the bridge is zero-dependency — no `npm install`, ever — and why no
  real model turn could be run here.
- Local loopback TCP works fine (parent ↔ child processes), and `npm`/`node` are
  present for tooling.

## The ZCode Protocol (reverse-engineered from `zcode.cjs` + live probing)

Transport: `zcode app-server --stdio`, **newline-delimited JSON**. Full tables in
`docs/protocol.md`. The essentials:

```
client → server   {"id":"c1","method":"session/send","params":{…}}
server → client   {"id":"c1","result":…} | {"id":"c1","error":{code,message}}
server → client   {"method":"session/event","params":{…}}                   # notification
server → client   {"id":"server-1","method":"session/requestRuntimePreferences","params":{…}}  # REQUEST — must answer
```

Gotchas that cost time:

1. `session/create` **hangs and times out** unless the reverse request
   `session/requestRuntimePreferences` is answered. Required answer shape:
   `{"nativeSearchEnhancementsEnabled":false,"memoryEnabled":false,"askUserQuestionAutoResolutionEnabled":true,"modelContextBudgetStrategy":"preflight-v1"}`.
2. Schemas are strict. `session/read` rejects `limit`; `session/create` demands
   `workspace:{workspacePath,workspaceKey}`.
3. `session/subscribe` fails `-32004 "Session is not active"` for sessions owned
   by another process → the bridge falls back to `session/resume`.
4. Approvals travel as a message item: `{type:"tool-approval-response",approvalId,approved,reason}`
   inside `session/send`'s `content`. The bridge tries three upstream shapes.
5. Ignore `startup/storageState` and `process/resourceSample` notifications.

## What changed in session 2 (the big correction)

Session 1 guessed the shape of ZCode's event stream and the approval path. Both
were wrong. Session 2 read the **real** data offline — the CLI's session database
(`~/.zcode/cli/db/db.sqlite`, opened read-only with Node 24's built-in
`node:sqlite`) plus the protocol code inside `zcode.cjs` — and rewrote the bridge
against it:

| Session 1 (guessed) | Reality |
|---|---|
| events live in `params.event` / `params.items` | envelope is `{sessionId, seq, type, payload, deliveryKind, eventId, turnId, timestamp}` |
| event types like `text`, `tool`, `result` | `part.upserted`, `model.streaming`, `tool.updated`, `turn.completed`, `permission.requested`, `userInput.*`, `session.*` |
| approvals appear in the event stream | approvals are a **reverse request** (`interaction/requestPermission`) that the agent blocks on |
| approvals answered via `session/send` with `tool-approval-response` items | answered by replying to that request: `{decision: "allow"\|"deny"\|"modify"\|"escalate", reason?, modifiedInput?, resolvedAt}` |

Consequences now implemented:

- `_classify()` matches real event types; `part.upserted` carries the same part
  objects the CLI persists (`{type:'tool', callID, tool, state:{status, title, output, error}}`).
- Assistant text streams through `model.streaming` deltas, accumulated into one
  growing bubble (`streaming: true` tells the watch to replace, not append).
- Permission cards carry the **options ZCode itself offers** ("Allow once",
  "Deny", …). Tapping one relays ZCode's own prepared `options[].response`
  verbatim, so the bridge cannot drift from the server's expectations.
- `AskUserQuestion` / `ExitPlanMode` are handled too: the watch shows the
  question with its choices and answers with
  `{decision:"modify", modifiedInput:{...input, answers:{"<question>":"<label>"}}}`.
- **Fallback policy**: if nobody is wearing the watch (or nobody taps in
  `permissionTimeoutMs`, default 5 min) the bridge applies `permissionFallback`
  — `deny` by default, `allow` for unattended runs, `wait` to defer to the
  desktop app. A blocked agent can no longer hang forever.
- Mode list now includes `auto`.

`docs/protocol.md` documents all of this, including payload schemas extracted
from the CLI.

## Verified by testing

- **46/46** assertions in `bridge/test/e2e.mjs` (mock app-server that speaks the
  real shapes and blocks on real reverse requests): pairing, PIN lockout, auth,
  session list/create/read, **real event envelope → wire events** (streaming
  accumulation, part.upserted text, tool start/done with title+callId,
  turn.completed `response`), **approval round-trip with options (allow and deny
  paths, unique request ids)**, **AskUserQuestion round-trip** (answer lands in
  `modifiedInput.answers`), placeholder→rich card replacement, interrupt, `auto`
  mode, reconnect + transcript replay, hook push, cross-process takeover,
  bad-token rejection, and **fallback auto-deny with no watch attached**.
- **Real-CLI smoke test**: bridge + `F:/zcode/resources/glm/zcode.cjs` →
  `appServer: "up"`, 10 real sessions listed with correct titles/projects.
- `tools/check-pbxproj.mjs`, `tools/check-swift.mjs`, icon generator: all clean.

## Still unverified — the next person's first job

1. ~~Compile the watch app.~~ **Done** — closing this is what CI is for. The first
   macOS run reported a fake green (the workflow piped `xcodebuild` into `tail`,
   which returns tail's status); after adding `set -o pipefail` it surfaced one
   real error (`TranscriptEvent` was missing the `prompt` field used by the
   question card). With that fixed, the build succeeds on the macOS runner.
   Remaining: **run it** on a simulator or a real watch — nobody has seen the UI
   yet, so layout, dictation and the websocket path are untested on device.
2. **One live turn with `debugEvents: true`.** The sandbox has no network, so no
   real model turn has ever run through the bridge. Shapes are now taken from the
   real protocol, but confirm on hardware: `part.upserted` ordering, whether
   `model.streaming` deltas also arrive as `part.delta`, and whether the CLI
   really routes `interaction/requestPermission` to a remote
   `web-remote-replayable` subscriber while the desktop app is attached.
   If approvals never reach the watch, try `deliveryKind: "desktop-continuous"`
   in `_ensureSubscribed()`.
3. **Two-client question**: if the desktop app and the bridge are both attached,
   confirm who answers an interaction request (the protocol has `ownerClientId` /
   `ownerDeviceLabel` concepts). The fallback policy makes the failure mode safe.
4. **watchOS background suspension**: the bridge pings every 25 s and drops a
   client after 2 missed pongs. Expect reconnect-on-wrist-raise tuning.

## House rules already baked in

- Bridge config lives in `~/.zcode-watch-remote/config.json` (PIN + token
  auto-generated on first run and persisted).
- **No npm dependencies in the bridge** — CI fails the build if any are added.
- Watch-side state lives in `SessionStore` (`@MainActor ObservableObject`);
  `BridgeClient` owns its own queue and hops back to the main actor.
- Haptics fire on exactly three moments: approval needed, turn finished, hook
  notice (`watch/ZCodeRemote/Haptics.swift`).
- Regenerate artefacts with `node tools/generate-icon.mjs`; CI verifies the
  committed icon matches the generator output.

## Backlog (ideas, not commitments)

- Bonjour/`NWBrowser` discovery so nobody types an IP address.
- Multiple bridges (work laptop + home desktop) with a picker.
- Push notifications via APNs for when the app is suspended.
- Attach files/images to prompts from the watch.
- Session `setModel`, `compact`, `fork` — the protocol already supports them.
- Keychain storage for the token instead of `@AppStorage`.
