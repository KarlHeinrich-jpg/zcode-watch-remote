# ⌚ ZCode Remote —— 用 Apple Watch 遥控 ZCode

[English](README.md) · **简体中文**

在电脑上跑起 agent，然后离开工位，用手表继续指挥它。ZCode Remote 由一个
watchOS App 和一个极简桥接服务组成，把本机的 [ZCode](https://z.ai) 会话
通过局域网暴露出来 —— 启动会话、发送指令、查看回复，并且**抬手就能批准或
拒绝工具调用**，不用再走回电脑前。

```
     Apple Watch                            你的电脑
┌────────────────┐   WebSocket   ┌──────────────────────┐   stdio   ┌──────────────┐
│  ZCode Remote  │ ────────────► │  zcode-watch-bridge  │ ────────► │    zcode     │
│   (SwiftUI)    │ ◄──────────── │  (Node,无依赖)        │ ◄──────── │  app-server  │
└────────────────┘               └──────────────────────┘           └──────────────┘
```

## 能做什么

- **看到所有会话** —— 包括桌面 App 里的会话和你从手表新建的会话，实时状态
  (`idle` / `running` / `approval`) 一目了然。
- **抬手批准** —— agent 要执行有风险的工具时，手表震动，并显示 **ZCode 自己给出的
  那几个选项**（"Allow once"、"Deny" 等），不用再猜它是不是卡在等你确认。
- **回答 agent 的提问** —— AskUserQuestion 会带着选项出现在手表上，点一个选项，
  或者用听写说出你自己的答案。
- **语音输入指令** —— 直接用 watchOS 的听写和涂鸦功能发消息。
- **随时打断** —— 在手腕上终止跑偏的任务。
- **切换权限模式** —— 每个会话可切 `plan` / `build` / `edit` / `yolo`。
- **Hook 通知** —— 用 ZCode hook 调用桥接的 HTTP 接口，任务完成时手表震动
  (支持 `Stop`、`Notification` 等任意 hook 事件)。
- **不走云端、不用账号** —— 全部通信都在局域网内，配对一次即可。

## 快速开始

### 1. 在电脑上启动桥接

需要 Node.js 18+。**零依赖，不需要 install**

```bash
git clone https://github.com/KarlHeinrich-jpg/zcode-watch-remote.git
cd zcode-watch-remote/bridge
node src/index.js
```

启动后会打印所需信息：

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

桥接会自己寻找 zcode CLI(桌面 App 内置包或 `PATH`)。如果位置特殊：

```bash
ZCODE_BIN=/path/to/zcode node src/index.js
```

### 2. 编译手表 App(需要 Mac)

```bash
open watch/ZCodeRemote.xcodeproj
```

选择 `ZCodeRemote` scheme，在 *Signing & Capabilities* 里填上你的开发者团队，
然后运行到 Apple Watch(或手表模拟器)。喜欢 XcodeGen 的话：

```bash
cd watch && xcodegen generate     # 从 project.yml 重新生成工程
```

### 3. 配对

在 App 里输入桥接打印的地址(`192.168.1.24:8788`，省略端口时默认 8788)和
6 位 PIN。手表会保存 token，之后无需再配对。配对信息存放在
`~/.zcode-watch-remote/config.json`，`--reset-pin` 可重置。

## 用 ZCode hook 推送通知

让任务结束时手腕震动。在 ZCode hook 配置里加入：

```json
{
  "hooks": {
    "Stop": [
      { "type": "command",
        "command": "curl -s 'http://127.0.0.1:8788/hook?token=你的TOKEN&event=stop&message=任务完成' >/dev/null" }
    ]
  }
}
```

Token 在桥接配置文件的 `token` 字段里。注意：`127.0.0.1` 只在 hook 与桥接
跑在同一台机器上时适用。

## 配置项

`~/.zcode-watch-remote/config.json`(首次运行自动生成)：

| 键 | 默认值 | 含义 |
|---|---|---|
| `port` | `8788` | WebSocket + HTTP 端口 |
| `bind` | `0.0.0.0` | 监听网卡 |
| `bridgeName` | 主机名 | 手表上显示的名字 |
| `pin` / `token` | 随机 | 配对凭据(`--reset-pin` 可同时轮换两者) |
| `command` | `""` | 指定 zcode CLI 路径(也可用环境变量 `ZCODE_BIN`) |
| `mode` | `build` | 从手表新建会话时使用的权限模式 |
| `allowedProjects` | `[]` | 允许手表新建会话的项目目录。**留空则禁止从手表新建** —— 想启用 + 按钮就加上路径 |
| `maxSessions` | `8` | 同时运行的会话数上限 |
| `permissionFallback` | `deny` | 没人戴手表时 agent 请求授权的处理方式：`deny`（安全默认）、`allow`（无人值守运行）、`wait`（交给桌面 App 处理） |
| `permissionTimeoutMs` | `300000` | 等待用户点击的时长，超时后套用上面的兜底策略 |
| `debugEvents` | `false` | 把每个原始 ZCode 事件追加到 `events-debug.jsonl`(协议调试用) |

命令行参数：`--port N`、`--config path`、`--reset-pin`、`--help`。

## 安全模型

- **设计上只服务局域网。** 桥接监听 `0.0.0.0` 且使用明文 `ws://`,**不要**
  暴露到公网。需要远程访问请套一层 VPN(Tailscale、WireGuard 等)。
- **PIN 用于配对，token 用于日常连接。** 连错 3 次 PIN 会断开连接。Token 是
  48 位十六进制共享密钥，`--reset-pin` 可使其失效。
- **项目范围受限。** 手表只能在 `allowedProjects` 内新建会话。
- **审批是转发而非绕过。** 在手表上批准等同于在 ZCode 界面里批准，不会改变
  会话本身的权限模式。

## 当前状态

| 组件 | 状态 |
|---|---|
| 桥接服务 | ✅ 已按**真实 ZCode 协议**实现(逆向出的真实事件信封与交互请求)，46/46 端到端断言通过(`cd bridge && node test/e2e.mjs`)，并已对真实 ZCode 安装验证(能列出真实会话、驱动真实 `app-server`) |
| 手表 App | ✅ 源码完整且**编译通过** —— CI 每次推送都会在 GitHub 的 macOS 机器上执行 `xcodebuild`(arm64 + arm64_32 双架构，零警告)。⚠️ 尚未在真机或模拟器上运行过，界面表现还未验证 |
| 审批与提问 | ✅ 已对"讲真实协议"的 mock 做过完整回路验证(选项、决策、`modifiedInput.answers`、无手表时的兜底)。⚠️ 尚未在真实任务中观察过，详见 `HANDOFF.md` |

## 常见问题

| 现象 | 处理 |
|---|---|
| `Cannot find the zcode CLI` | 设置 `ZCODE_BIN`(例如 `/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs` 或 `F:\zcode\resources\glm\zcode.cjs`) |
| 手表一直显示 "Retrying in Ns" | 两台设备不在同一 Wi-Fi、某一端开了 VPN，或防火墙拦了 8788 端口。先用浏览器打开 `http://<电脑IP>:8788/health` 确认 |
| "session is busy in another app" | 该会话被 ZCode 桌面 App 占用。桥接会尝试 `session/resume`；若桌面 App 正在跑任务，等它空闲后重试 |
| 事件只显示 `status` | CLI 的事件结构与分类器已知的不一致。开启 `debugEvents`，跑一轮任务，查看 `~/.zcode-watch-remote/events-debug.jsonl` |
| 会话列表为空 | `curl http://127.0.0.1:8788/health` —— 若 `appServer` 是 `down`，说明 CLI 启动失败(看桥接日志) |

## 仓库结构

```
bridge/         零依赖 Node 桥接(WebSocket 服务 + app-server 驱动)
  src/          index.js(入口)、hub.js(会话)、zcode.js(协议 B)、wsserver.js、http.js
  test/         e2e.mjs、mock-appserver.mjs、wsclient.mjs
watch/          watchOS SwiftUI App
  ZCodeRemote/  Models、BridgeClient、SessionStore、Views/…
  ZCodeRemote.xcodeproj
  project.yml   XcodeGen 配置
docs/protocol.md  两套线上协议的详细说明
tools/          图标生成器 + 结构校验器(CI 使用)
HANDOFF.md      工程笔记:协议侦察结论、已验证与未验证项
```

## 开发

```bash
cd bridge && node test/e2e.mjs        # 对 mock app-server 的 34 项断言
node tools/check-pbxproj.mjs          # 校验 Xcode 工程结构
node tools/check-swift.mjs            # Swift 源码括号/字符串健全性检查
node tools/generate-icon.mjs          # 重新生成 App 图标
```

桥接**没有任何运行时依赖** —— 无需审计第三方包，无需安装，裸 Node 即可运行。

## 许可证

MIT
