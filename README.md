# ⌚ ZCode Remote — control ZCode from your Apple Watch

**English** · [简体中文](README.zh-CN.md)

Run an agent on your computer, walk away, and steer it from your wrist. ZCode
Remote is a watchOS app plus a tiny bridge that exposes your local
[ZCode](https://z.ai) sessions over your LAN — start sessions, send prompts,
read replies, and **approve or deny tool calls with a tap** instead of walking
back to your desk.

```
   Apple Watch                          your computer
┌────────────────┐   WebSocket   ┌──────────────────────┐   stdio   ┌──────────────┐
│  ZCode Remote  │ ────────────► │  zcode-watch-bridge  │ ────────► │    zcode     │
│   (SwiftUI)    │ ◄──────────── │  (Node, no deps)     │ ◄──────── │  app-server  │
└────────────────┘               └──────────────────────┘           └──────────────┘
```

## What you get

- **See every session** — the desktop app's sessions *and* ones you start from
  the watch, with live status (`idle` / `running` / `approval`).
- **Tap to approve** — when the agent wants to run a risky tool, the watch buzzes
  and shows Allow / Deny. No more guessing whether it's still waiting.
- **Dictate prompts** — watchOS dictation and Scribble, straight into the session.
- **Stop anything** — interrupt a runaway turn from your wrist.
- **Switch permission mode** — `plan` / `build` / `edit` / `yolo` per session.
- **Hook notifications** — ZCode hooks can curl the bridge to buzz your wrist
  when a task finishes (`Stop` hook, `Notification` hook, anything).
- **No cloud, no account** — everything stays on your LAN. Pair once with a PIN.

## Quick start

### 1. Run the bridge (on your computer)

Needs Node.js 18+. **No dependencies, no install step**

```bash
git clone https://github.com/<you>/zcode-watch-remote.git
cd zcode-watch-remote/bridge
node src/index.js
```

It prints everything you need:

```
  ZCode Watch Bridge v0.1.0
  ──────────────────────────────────────────
  Bridge name : macbook
  Pairing PIN : 481920   (token: 3f9a1c…)
  Config file : /Users/me/.zcode-watch-remote/config.json
  App-server  : connected
  Watch URL   :
                ws://192.168.1.24:8788
  ──────────────────────────────────────────
```

The bridge finds the zcode CLI on its own (desktop app bundle or `PATH`). If
yours lives somewhere unusual:

```bash
ZCODE_BIN=/path/to/zcode node src/index.js
```

### 2. Build the watch app (on a Mac)

```bash
open watch/ZCodeRemote.xcodeproj
```

Pick the `ZCodeRemote` scheme, set your team under *Signing & Capabilities*,
then run on your Apple Watch (or the watch simulator). Prefer XcodeGen?

```bash
cd watch && xcodegen generate     # regenerates the project from project.yml
```

### 3. Pair

In the app, type the address the bridge printed (`192.168.1.24:8788` — port 8788
is assumed if you omit it) and the 6-digit PIN. The watch stores a token, so you
only do this once. Pairing data lives in
`~/.zcode-watch-remote/config.json`; `--reset-pin` rotates it.

## Notifications from ZCode hooks

Make your wrist buzz when a turn finishes. Add to your ZCode hook config:

```json
{
  "hooks": {
    "Stop": [
      { "type": "command",
        "command": "curl -s 'http://127.0.0.1:8788/hook?token=YOUR_TOKEN&event=stop&message=Task%20finished' >/dev/null" }
    ]
  }
}
```

Your token is in the bridge config file (`token`). Whether the hook runs on the
same machine as the bridge matters — `127.0.0.1` is only right if it does.

## Configuration

`~/.zcode-watch-remote/config.json` (created on first run):

| Key | Default | Meaning |
|---|---|---|
| `port` | `8788` | WebSocket + HTTP port |
| `bind` | `0.0.0.0` | Interface to listen on |
| `bridgeName` | hostname | Shown on the watch |
| `pin` / `token` | random | Pairing secrets (`node src/index.js --reset-pin` rotates both) |
| `command` | `""` | Explicit path to the zcode CLI (or set `ZCODE_BIN`) |
| `mode` | `build` | Permission mode for sessions created from the watch |
| `allowedProjects` | `[]` | Projects the watch may start sessions in. **Empty means "no new sessions from the watch"** — add paths to enable the + button |
| `maxSessions` | `8` | Cap on simultaneously running sessions |
| `debugEvents` | `false` | Append every raw ZCode event to `events-debug.jsonl` (for protocol debugging) |

Flags: `--port N`, `--config path`, `--reset-pin`, `--help`.

## Security model

- **LAN only by design.** The bridge binds `0.0.0.0` and speaks plain `ws://` —
  do not expose it to the internet. Use a VPN (Tailscale, WireGuard) if you need
  remote access.
- **PIN for pairing, token afterwards.** Three wrong PINs drop the connection.
  The token is a 48-hex-char shared secret; `--reset-pin` invalidates it.
- **Scoped projects.** The watch can only create sessions in `allowedProjects`.
- **Approvals are relayed, not bypassed.** Approving on the watch is the same
  thing as approving in the ZCode UI — it does not change the session's
  permission mode.

## Status

| Component | State |
|---|---|
| Bridge | ✅ Implemented, 34/34 end-to-end tests pass (`cd bridge && node test/e2e.mjs`), verified against a real ZCode install (lists real sessions, spawns the real `app-server`) |
| Watch app | ⚠️ Source complete (11 Swift files, Xcode project, icon), **not yet compiled** — no macOS in the environment where it was written. Expect to fix a small number of compiler nits on first build. |
| Approval relay | ⚠️ Verified end-to-end against a protocol mock; the exact live approval payload may need the fallback ladder tuned (see `HANDOFF.md`) |

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Cannot find the zcode CLI` | Set `ZCODE_BIN` (e.g. `/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs` or `F:\zcode\resources\glm\zcode.cjs`) |
| Watch shows "Retrying in Ns" | Different Wi-Fi networks, a VPN on either device, or a firewall blocking port 8788. Check `http://<computer-ip>:8788/health` in a browser first |
| "session is busy in another app" | The session is owned by the ZCode desktop app. The bridge tries `session/resume`; if the desktop app is mid-turn, wait for it to go idle |
| Events show as `status` only | The CLI's event shape differs from what the classifier knows. Enable `debugEvents`, run one turn, inspect `~/.zcode-watch-remote/events-debug.jsonl` |
| Nothing in the session list | `curl http://127.0.0.1:8788/health` — if `appServer` is `down`, the CLI failed to start (check the bridge log) |

## Repo layout

```
bridge/         zero-dependency Node bridge (WebSocket server + app-server driver)
  src/          index.js (entry), hub.js (sessions), zcode.js (protocol B), wsserver.js, http.js
  test/         e2e.mjs, mock-appserver.mjs, wsclient.mjs
watch/          watchOS SwiftUI app
  ZCodeRemote/  Models, BridgeClient, SessionStore, Views/…
  ZCodeRemote.xcodeproj
  project.yml   XcodeGen manifest
docs/protocol.md  both wire protocols, in detail
tools/          icon generator + structural checkers (used by CI)
HANDOFF.md      engineering notes: protocol findings, what's verified, what isn't
```

## Development

```bash
cd bridge && node test/e2e.mjs        # 34 assertions against a mock app-server
node tools/check-pbxproj.mjs          # validates the Xcode project structure
node tools/check-swift.mjs            # brace/string sanity check on Swift sources
node tools/generate-icon.mjs          # regenerates the app icon
```

The bridge has **no runtime dependencies** — nothing to audit, nothing to
install, and it runs on a bare Node.

## License

MIT
