# HANDOFF — ZCode Remote for Apple Watch

> Status snapshot for whoever picks this up next (human or agent).
> Last updated: 2026-10-04 (session 1 — feature-complete first cut).

## What this project is

A GitHub project that lets an **Apple Watch** remotely drive **ZCode** agent
sessions running on your computer. Two halves plus tooling:

| Part | Path | Language | State |
|---|---|---|---|
| Bridge (runs on the PC) | `bridge/` | Node.js, **zero dependencies** | ✅ implemented, 34/34 e2e tests pass, verified against a real ZCode install |
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

## Verified by testing

- **34/34** assertions in `bridge/test/e2e.mjs` (mock app-server): pairing, PIN
  lockout, auth, session list, create, prompt streaming, tool start/done mapping,
  turn result, approval round-trip, interrupt, mode switch, token reconnect,
  transcript replay, HTTP hook push, cross-process takeover, bad-token rejection.
- **Real-CLI smoke test**: bridge + `F:/zcode/resources/glm/zcode.cjs` →
  `appServer: "up"` and 7 real sessions listed with correct titles/projects.
- `tools/check-pbxproj.mjs` (41 objects, all references resolve, every Swift file
  in the Sources phase) and `tools/check-swift.mjs` (11 files structurally sound).

## Unverified — the next person's first job

1. **Compile the watch app.** It has never seen a Swift compiler. Expect a
   handful of nits (most likely: `@MainActor` isolation around `App.init`,
   `URLSessionWebSocketTask.CloseCode` comparisons, and `@AppStorage` + `didSet`
   combinations). CI's `watchos-build` job runs `xcodebuild` on macOS and will
   tell you exactly what to fix:
   `xcodebuild build -project watch/ZCodeRemote.xcodeproj -scheme ZCodeRemote -destination 'generic/platform=watchOS' CODE_SIGNING_ALLOWED=NO`
2. **One real turn with `debugEvents: true`.** The exact live `session/event`
   payload shape is unknown (sandbox had no network; cross-process subscription is
   refused). Run a turn, then read `~/.zcode-watch-remote/events-debug.jsonl` and
   tighten `_classifyEvent()` in `bridge/src/hub.js` — it is deliberately tolerant
   today and may under-report.
3. **Confirm the live approval trigger.** Default mode is `build`, which should
   prompt for risky tools. If approvals never reach the watch, try
   `deliveryKind: "desktop-continuous"` in `_ensureSubscribed()`.
4. **Real-hardware latency/keepalive**: the bridge pings every 25 s and drops a
   client after 2 missed pongs; watchOS suspends background apps, so expect
   reconnect-on-wrist-raise behaviour to need tuning.

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
