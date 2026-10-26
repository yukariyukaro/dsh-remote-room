# DSH 远程工作区插件 · 方案（唯一现行版）

> 一句话：**把房主的 DSH 当成一台 SSH 机器，把访客的 DSH 当成本地 VS Code。**
> 房主只提供文件与终端能力，Agent、模型、会话全部跑在访客这边。
> 版本：v3（2026-10-26）。历史调研见 `dsh-share-room-tech-research.md`（v2）与 `.v1.md`，本文不重复其内容。

---

## 1. 一页速览

```text
┌──────────┬─────────────────────────┬──────────────────────┐
│ 左栏     │ 中间：访客自己的会话      │ 右栏：房主的机器      │
│ 工作区   │ 原装 Agent、原装工具卡    │ ├ 连接状态（灰态）    │
│ 会话列表 │ 原生 read/write/bash      │ ├ 远端文件树          │
│          │ （底下走的是房主机器）     │ ├ 预览 / 编辑 / diff  │
│          │                          │ └ 终端（PTY 在房主）  │
└──────────┴─────────────────────────┴──────────────────────┘
        ↑ 以上全部在访客的 DSH 里
                                     ↓ 唯一通道
                         Relay（Cloudflare Workers + DO）
                                     ↓
┌──────────────────────────────────────────────────────────┐
│ 房主 DSH：只有能力，没有 Agent                              │
│   fs provider（读/写/watch）· subprocess（exec/PTY）· 审计  │
└──────────────────────────────────────────────────────────┘
```

### 三条铁律

1. **房主不出 Agent、不出会话、不出 Web 页面**，只出被授权的 fs / exec 能力。
2. **Agent 在访客侧**，因此访客的对话页、工具卡、审批、回放全部是原装的，不需要重写。
3. **终端开在房主**：PTY 由房主 `ctx.subprocess.spawnTerminal` 分配，访客只做字节渲染。

### 关键判断：复用 provider seam，而不是自造工具

DSH 的 `ctx.fs` 与 `ctx.subprocess` 是**可替换的抽象 provider**，而且官方文档明确为远端场景留了口子：

> `resolve()`: "**a remote/sandboxed backend may need a round-trip** to map a path to a stable identity"
> `contains()`: "Test canonical containment **without exposing or parsing backend target keys**"
> `processPathFromHostPath()`: "host-backed or **explicitly shared backends override it**"

仓库里甚至有现成的一族 SSH 实现：`packages/ssh` 下的 `ssh` / `fs-ssh` / `subprocess-ssh` / `sandbox-ssh` / `ssh-helper-runtime`。

**所以本方案是"给房间会话换一套 provider"，不是"加一堆 `room_*` 工具"。**

---

## 2. 术语

| 术语 | 含义 |
|---|---|
| 房主 / host | 被协助的人。DSH 拥有真实文件与进程 |
| 访客 / guest | 协助者。用自己的 DSH、模型、token |
| 房间 / room | 一次授权会话，一个 Durable Object 实例 |
| 能力 / capability | `fs` 与 `exec` 两类，按三档授权 |
| provider | `ctx.fs` / `ctx.subprocess` 的实现，本方案替换为远端实现 |
| 档位 / tier | `read-only` / `workspace` / `global`，进房时一次性决定 |

---

## 3. 参照物：VS Code Remote-SSH

### 3.1 分层对照

| 层 | VS Code Remote-SSH | 本方案 |
|---|---|---|
| UI | 本地 VS Code | 访客的本地 DSH |
| Agent / 扩展宿主 | 远端（VS Code Server） | **访客本地**（唯一差异，见 §3.3） |
| 文件系统 | 远端 provider | 远端 `fs` provider（房主） |
| 终端 | 远端 PTY | 远端 `spawnTerminal`（房主） |
| 通道 | SSH + 复用 RPC | 房间 WSS + 帧协议 |
| 入口 | 活动栏 Remote Explorer | 右栏 Tab（DSH 的副栏） |
| 授权 | SSH 密钥一次授权 | 进房一次授权（三档） |

### 3.2 能抄什么、抄不到什么（重要）

| 来源 | 许可 | 能拿到什么 |
|---|---|---|
| `microsoft/vscode` → `src/vs/platform/remote/**` | **MIT** | `managedSocket.ts`（连接复用）、`remoteAgentConnection.ts`、`remoteAuthorityResolver.ts`、`remoteSocketFactoryService.ts`、`sharedProcessTunnelService.ts`、`remote.ts` |
| `microsoft/vscode` → `src/vs/server/node` | MIT | 服务端形态与启动参数 |
| `microsoft/vscode-remote-release` | NOASSERTION | ⚠️ **只是问题追踪仓库**（4.2k★，主语言 Dockerfile），Remote-SSH 扩展本体不开源 |
| `deepseek-ai/deepseek-harness` | MIT | fs / shell / ssh / subprocess / terminal 的完整实现，可直接照抄结构 |

> **诚实结论**：无法"clone Remote-SSH 源码照抄"。可抄的是 **VS Code 核心的 remote 平台层（MIT）** 与 **DSH 自己的 provider 实现（MIT）**；Remote-SSH 扩展只能抄其**公开文档描述的行为**。

### 3.3 为什么 Agent 在本地而 VS Code 的扩展宿主在远端

| | VS Code | 我们 |
|---|---|---|
| 为什么这样放 | 语言服务、linter、调试器必须贴近源码 | Agent 是 DSH 的本体，且要**用访客的模型与预算** |
| 代价 | 远端要装 Node 与扩展 | 需把"工具调用"远程化（由 provider 承担） |
| 收益 | — | 访客 UI 零改动、房主不烧 token、房主会话完全不可达 |

### 3.4 可抄的开源替代（Remote-SSH 闭源后的替代清单）

按"离我们多远"排序，★ 为 2026-10-26 GitHub API 实测。

| 项目 | ★ | 许可证 | 抄什么 |
|---|---|---|---|
| **shellhub-io/shellhub** | 2.2k | **Apache-2.0** | **形态最像我们**：设备端 agent + 中心服务 + Web 终端。抄它的 agent 注册/心跳/隧道分层与会话审计 |
| **warp-tech/warpgate** | 8.1k | **Apache-2.0** | 成熟 bastion：如何同时做 SSH 透传与 Web 管理；权限与目标建模 |
| **next-terminal** | 5.7k | **Apache-2.0** | TypeScript 编写的堡垒机 + 会话审计 + Web 终端，前端结构最接近我们的右栏 |
| **huashengdun/webssh** | 5.1k | **MIT** | 极简 Web SSH 客户端（xterm + 服务端通道），抄"终端页最小实现" |
| **mscdex/ssh2** | 5.8k | **MIT** | 纯 JS 的 SSH **客户端 + 服务端**。若想让房间真的是 SSH 语义（PTY/exec/SFTP），这是唯一能内嵌的方案 |
| **hashicorp/yamux** | 2.7k | MPL-2.0 | 单连接多路复用（流 ID + 窗口）。我们的 WSS 要复用 fs/pty/事件 |
| **xtaci/smux** | 1.6k | MIT | 同上，更轻 |
| **gliderlabs/ssh** | 4.2k | BSD-3 | Go 写 SSH server 的最短路径（二期若做真 SSH 入口） |
| **teleport** | 21.0k | ⚠️ **AGPL-3.0** | **只抄设计**：短期证书替代静态密钥、RBAC、会话录制回放 |
| **jumpserver** | 31.8k | ⚠️ **GPL-3.0** | **只抄设计**：PAM 的资源/授权/审计三元组 |
| **hashicorp/boundary** | 4.1k | NOASSERTION | 只抄设计：会话即一等资源 |
| **coder/code-server** | 79.7k | MIT | 可抄：浏览器 IDE 的静态资源与 WS 组织 |
| **coder/coder** | 17.2k | ⚠️ **AGPL-3.0** | 只抄设计：workspace + agent 拓扑 |
| **loft-sh/devpod** | 15.3k | MPL-2.0 | 抄 UX：客户端怎样"连到一个远端环境" |
| **eclipse-theia/theia** | 21.7k | EPL-2.0 | 抄 RPC-over-WebSocket 的成熟实现 |
| **microsoft/node-pty** | 2.1k | NOASSERTION | 参考；我们**用不上**（房主侧走 `ctx.subprocess.spawnTerminal`） |

#### 许可分层（很关键）

| 层 | 许可证 | 能做什么 |
|---|---|---|
| **可抄代码** | MIT、Apache-2.0、BSD、MPL-2.0 | 复制实现，保留声明 |
| **只抄设计** | AGPL-3.0、GPL-3.0 | 读架构、写自己的实现。**不要复制代码**——AGPL 的网络分发条款会传染 |

#### 对我们的三个直接结论

1. **主参考换成 `shellhub`**：它是"设备端 agent + 中心中继 + Web 终端 + 审计"，与我们 D1/D2 的结构同构，且 Apache-2.0 可抄。
2. **协议层不要从零发明**：`yamux`/`smux` 的 stream 概念（`streamId + window`）直接映射到我们帧头，或复用 Theia 的 RPC-over-WS 形态。
3. **权限模型抄 Teleport 的设计**（短期凭证 + RBAC + 录制回放），但**代码自己写**——它是 AGPL。

---

## 4. 权限模型：一次性授权，三档

### 4.1 语义对齐 SSH

SSH 的做法是：**连接时验证身份，进来之后按该用户的权限做事**，不逐条命令弹窗。
本方案完全一致：**房主在访客进房时给一次档位，之后不再逐次确认。**

（这也解决了一个现实问题：`ctx.approval.request()` 需要会话上下文，而房主插件没有 Agent —— 逐次审批在架构上就做不成。）

### 4.2 三档

| 档位 | fs 读 | fs 写 | exec | 典型用途 |
|---|---|---|---|---|
| **read-only**（默认） | 根目录内 | ❌ | ❌ | 看一眼日志、定位问题 |
| **workspace** | 根目录内 | 根目录内 | 仅根目录 cwd + 命令白名单 | 改代码、跑测试 |
| **global** | 全盘 | 全盘 | 全盘 | 完全接管（等同 SSH 登录） |

### 4.3 默认排除项（三档都生效，除非显式放开）

```text
.env / .env.*            凭据
.dsh/                    房主自己的 DSH 配置与会话
**/credentials*          provider key
.git/config 中的远端凭据  （可选）
node_modules/            体积与噪音（可选）
```

### 4.4 一次性授权怎么落地

```text
房主：创建房间 → 选根目录 → 选档位 → 生成邀请
      （邀请里带 roomId + roomKey + tier + 过期时间，roomKey 只在 fragment）
访客：粘贴邀请 → 连上 → provider 生效
房主：随时可 降档 / 断开 / 关闭房间（立即生效，正在跑的命令一并终止）
```

**降档是实时的**：房主一改，下一条请求就被拒；不需要重连。

### 4.5 审计（不做事后逐次确认，但必须可追溯）

每次能力调用记录：

```text
{ time, actor: 'guest:<name>', method: 'fs.write', path, bytes, result: 'ok'|'denied'|'conflict', tier }
```

写入记录只在房主侧；`fs.writeText` / `editText` 的返回值本来就带 `before` / `after`，天然可做 diff 回看。

---

## 5. 连接链路

### 5.1 拓扑

```text
访客 DSH ──出站 WSS──► Relay (Cloudflare Workers + DO) ◄──出站 WSS── 房主 DSH
```

- 三边全部出站；房主不开端口、不发页面、`127.0.0.1:50069` 从不对外；
- 一个房间 = 一个 DO 实例，`env.ROOM.idFromName(roomId)`；
- 用 **WebSocket Hibernation**（`state.acceptWebSocket`）让空房间不烧资源；
- 中继是哑管道：按 `roomId` 转发加密帧，不解析、不落盘、不持密钥。

### 5.2 传输备选（已存在，暂不用）

DSH 自带 `ctx.ssh`：

```ts
readonly ready: Promise<Hello>
request<T>(method, params, result: z.ZodType<T>, signal?, wait?): Promise<T>
connectStream(endpoint: SshStreamEndpoint, signal?): Promise<Socket>
dispose(): Promise<void>
```

配套包：`packages/ssh` 的 `ssh` / `fs-ssh` / `subprocess-ssh` / `sandbox-ssh` / `ssh-helper-runtime`。

**能复用同一套 provider 协议**，但要求双方网络可达且有 sshd —— 我们的目标用户（家宽 NAT 后）不满足。因此：

- 一期：Cloudflare DO 中继；
- 二期（可选）：`transport: 'relay' | 'ssh'`，同一 provider 协议换底层。

### 5.3 端到端加密

```text
X25519 ECDH → HKDF-SHA256 → 双向独立 AES-256-GCM
帧：[1B ver][8B seq][12B iv][ciphertext][16B tag]，AAD = roomId|direction|seq
```

`roomKey` 由房主本地生成，中继永不接触；邀请形如 `https://<relay>/j/<roomId>#<roomKey>`。

---

## 6. 能力面与 DSH 服务映射

### 6.1 `ctx.fs`（房主侧真实实现）

本机实测签名（节选，均为 `abstract`，可被 provider 覆盖）：

```ts
resolve(path, { cwd?, signal? }): Promise<FsTarget>          // 允许往返 I/O
processPath(target): string
processPathFromHostPath(hostPath): string | undefined
fileUrl(target): string
contains(parent, child): boolean                              // 不解析 targetKey
stat(target, signal?): Promise<FsInfo | undefined>
lstat(path, { cwd? }, signal?): Promise<FsPathInfo | undefined>  // 不跟随符号链接
readText(target, signal?): Promise<string>
streamText(target, signal?): Promise<AsyncIterable<string>>
readBytes(target, signal, maxBytes): Promise<Uint8Array>
readByteRange(target, { offset, length }, signal?): Promise<Uint8Array>
listDir(target, signal?): Promise<FsDirEntry[]>
writeText(target, content, expected?, signal?, sandboxPolicy?): Promise<FsWriteOutcome>
editText(target, edit, expected?, signal?, sandboxPolicy?): Promise<FsEditOutcome>
watch(target, changed, signal): Promise<() => Promise<void>>
```

关键返回值：

```ts
FsWriteOutcome = { operation, version, before: string | null, after: string }
FsEditOutcome  = { version, before, after }
FsTarget       = { targetKey, displayPath }     // targetKey 对调用方不透明
```

### 6.2 能力映射表

| 房间能力 | 房主侧实现 | 访客侧消费方 | 权限点 |
|---|---|---|---|
| 列目录 | `listDir` | 右栏文件树 | read |
| 读文件 | `readText` / `readByteRange` / `streamText` | 原生 `read` 工具、预览器 | read |
| 写文件 | `writeText(..., sandboxPolicy)` | 原生 `write` / `edit` 工具 | write |
| 局部编辑 | `editText`（版本校验 → `FS_STALE_VERSION`） | 原生 `edit` 工具 | write |
| 变更通知 | `watch` | 文件树刷新 | read |
| 边界判定 | `contains(roomRoot, target)` | 每次调用前 | 全部 |
| 路径映射 | `processPath` | 交给 subprocess 用 | exec |
| 执行命令 | `subprocess.spawn` / `spawnTerminal` | 原生 `bash` 工具、终端 | exec |

### 6.3 `ctx.subprocess`（房主侧）

```ts
spawn(spec: SubprocessSpawnSpec): SubprocessHandle
spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle>
terminalEnvironment(signal?): Promise<{ platform: 'posix' | 'windows'; defaultShell?: string }>
```

`spawnTerminal` 是**非 Agent 作用域**的——这正是"终端开在房主"能成立的原因。

### 6.4 沙箱复用

```ts
ctx.sandbox.confine(argv, policy, signal?): Promise<ConfinedArgv>
ctx.sandboxPolicy.resolve({ session? }): SandboxExecutionPolicy
```

房主侧对 `workspace` 档写入与执行时，把解析出的 `SandboxExecutionPolicy` 直接传给 `writeText` / `editText` 的最后一个参数，并用 `confine` 包住 argv。

---

## 7. 终端开在房主

### 7.1 为什么不是 `ctx.terminals`

```ts
ctx.terminals.spawn(owner: Agent, request, signal?)   // ← 需要 Agent
```

房主插件没有 Agent，所以用不了。`ctx.subprocess.spawnTerminal` 不需要 Agent，是正确入口。

### 7.2 房主侧

```ts
const env = await ctx.subprocess.terminalEnvironment()
const handle = await ctx.subprocess.spawnTerminal({
  argv: [env.defaultShell ?? '/bin/bash'],
  cwd: roomCwd,
  rows, cols,
  terminalType: 'xterm-256color',
  graceMs: 5000,
})
```

`SubprocessTerminalHandle` 提供：

```ts
pid; output: Readable
write(data: string): Promise<void>
resize(cols, rows): Promise<void>
inspectForeground(): Promise<{ processGroupId, inputWaiting } | undefined>
inspectActivity(): Promise<{ state, revision }>
signalForeground(signal: 'SIGINT'|'SIGTERM'|'SIGKILL'|'SIGTSTP'|'SIGHUP'): Promise<number>
terminate(): Promise<void>
done: Promise<{ exitCode, signal }>
```

### 7.3 访客侧

- `xterm.js` 渲染；`output` 字节流经加密帧转发；
- 键盘 → `write`；窗口尺寸变化 → `resize`；
- Ctrl-C → `signalForeground('SIGINT')`（而不是往流里塞 `\x03`，更接近 VS Code 的行为）；
- 断线：PTY 保持在房主侧，重连后按 scrollback 重建视图（房主侧保留环形缓冲）。

> 注：DSH 自带的右栏终端仍服务**本地**会话，两者并存互不影响。

---

## 8. 工具层：本地与远端如何区分

### 8.1 首选方案：换 provider，不加工具

若 `ctx.fs` / `ctx.subprocess` 能在隔离的 ctx（或 agent preset）里替换（M0 spike 验证），则：

- 房间会话里的 `read` / `write` / `edit` / `glob` / `grep` / `bash` 是**原生工具**，行为、卡片、审批、内容归档全部不变；
- 它们底下走的是远端 provider；
- 访客的**其他会话**仍绑定本地 provider，互不干扰。

这就是 Remote-SSH 的做法：不是给编辑器加"远程读写"命令，而是整个窗口换了宿主。

### 8.2 回退方案：`room_*` 工具

若 provider 无法在同一进程内共存，则退回到显式工具：

| 工具 | 对应 |
|---|---|
| `room_read` / `room_list` / `room_glob` / `room_grep` | fs 读 |
| `room_write` / `room_edit` | fs 写（带版本检查） |
| `room_bash` | exec + PTY 或一次性命令 |

实现直接参考仓库：

```text
packages/fs/tool-fs            read / write / edit
packages/fs/tool-fs-search     glob / grep
packages/fs/tool-str-replace-editor
packages/shell/tool-bash       bash 工具
packages/shell/tool-bash-persistent
packages/subprocess/subprocess-local   spawn / spawnTerminal 的本地实现
packages/terminal/terminal-bash        PTY 后端
```

工具卡用 `tool.call.toolview`（keyed by 工具名，**keyDomain 开放**）注册成与原生一致的 read / diff / terminal 卡片。

### 8.3 提示词兜底（两种方案都要）

用 `ctx.systemPrompt.section()` 注入：

```text
- 你正在操作房主机器上的目录 <remoteRoot>，其中的路径是远端路径。
- 本地工作区 <localRoot> 与本房间无关。
- 当前档位：<tier>（读 / 写 / 执行 的可用性）。
- 被拒绝时不要重复尝试，把原因告诉用户。
```

⚠️ `PromptSection` 的确切字段以本地 `listService('systemPrompt')` 为准。

---

## 9. UI：右栏 Tab

### 9.1 事实（2026-10-26 实测）

| 属性 | 值 |
|---|---|
| slot | `sidebar.right.pane.tab` |
| kind | `keyed` |
| keyDomain | **open**（任意字符串） |
| replaceRisk | **none**（只加 Tab，不替换整栏） |
| declaredBy | 一个 entry 在 `rightbar.session`（DSH 自带） |
| scope | `session` |
| 现有占用者 | **17 个**（含 better-sidebar 的 files/editor/git/diff/sidechat、自带 files/terminal/browser/documentpreview、dsh-context、dsh-file-review） |

### 9.2 注册

```js
// 主入口：常驻，未连接时是灰态
ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
  name: 'sidebar.right.pane.tab',
  key: 'dsh-room:workspace',
  component: RoomTab,
}))

// 可选放大：同一组件升级为整页
ctx.slots.register({ name: 'main', key: 'room', component: RoomTab })

// 房主管理：不占右栏
ctx.slots.register({ name: 'settings.section', id: 'dsh-room', ... })
```

`main` 的 `conversation` 格子始终在注册表里，切走再切回不会丢会话。

### 9.3 常驻 + 灰态

- key 永远注册，`connected` 只是组件状态；
- 未连接：邀请码输入 / 等待接纳 / 上次错误 + 重试；
- 已连接断线：原因 + 房间是否仍存活；
- 灰态使用 `--dsw-alias-*` token 的弱化色，不硬编码颜色；
- 偏好项 `entry: 'always' | 'when-connected'`（默认 always，即本方案）。

### 9.4 已接受的约束

> **没打开会话时右栏不出现**（`scope: 'session'`）——已确认可接受。

### 9.5 可白拿的 hooks

`sidebar.right.pane.tab` 的 `standardProps` 包含：

```text
useRemoteAccess / useResource / useWorkspaces / usePanelInfo
useSessions / useSessionStatus / useSessionAccess / useWorkspaceAccess
useChat / useConversation / useInput / inputActions
useSession / sessionId / useProjection / useAccess / useTrajectory
hookContext: TabHookContext
```

`useAccess(action)` 直接用于"当前身份能否写/能否执行"的界面开关。

### 9.6 视图组件

| 区域 | 实现 | 依赖 |
|---|---|---|
| 文件树 | 自写（懒加载 on `listDir`） | 无 |
| 预览 | 自写（文本 / 图片 / 二进制提示） | 无 |
| 编辑 | **CodeMirror 6** | `@codemirror/*` |
| Diff | `diff` 库 + 自写渲染 | `diff` |
| 终端 | **xterm.js** + fit addon | `@xterm/xterm` |
| 连接面板 | 自写 | 无 |

Monaco 留作二期（VS Code 同款内核，但 gz 后 2–3 MB）。

---

## 10. 兼容性（better-sidebar 及同类插件）

### 10.1 实测结论

better-sidebar 0.28.0 注册的槽：

```text
sidebar.right.pane.tab          ← 与我们同一个槽，**并排添加，不互相替换**
sidebar.right.pane.tab.title
conversation.session.header.utilities
settings.section
shell.overlay
```

它**一次都没碰** `sidebar`、`sidebar.panellist`、`main`。

### 10.2 三条禁令

| 禁止 | 原因 |
|---|---|
| ❌ 注册 `sidebar` 槽 | catalog 原文：注册它会 **replaces the navigation column outright**，它声明的 workspace / settings 座位全部消失 |
| ❌ 复用别人的 key（`dsh-better-sidebar:*`、`plugins`、`conversation`、`schedules`、`dsh-context`） | key 撞上就是**替换**该 occupant，不是并排 |
| ❌ 只做右栏入口 | 右栏是 session 作用域；必须有 `settings.section` 或命令作为备用入口 |

### 10.3 版本风险

better-sidebar 的 README 写明：v0.28.0 将接管 npm `latest`，而 DSH 自身仍是 0.2.x，**宿主必须固定版本**。我们与之共用同一个槽，所以这条风险对我们同样成立 —— 插件 `engines` 要写清楚。

---

## 11. 协议 v1

### 11.1 帧

```text
[1B ver][1B type][2B len][payload]
payload = AES-256-GCM(明文 JSON)
```

### 11.2 方法

| 方向 | 方法 | 说明 |
|---|---|---|
| G→H | `hello` | `{ roomId, tier, nonce, proof }` |
| H→G | `welcome` | `{ tier, root, capabilities, pub }` / `reject` |
| 双向 | `ping` / `pong` | 25s |
| G→H | `fs.resolve` / `fs.stat` / `fs.lstat` / `fs.list` | |
| G→H | `fs.read` | `{ path, offset?, length? }` |
| G→H | `fs.write` | `{ path, content, expectedVersion? }` |
| G→H | `fs.edit` | `{ path, oldString, newString, replaceAll, version }` |
| 双向 | `fs.watch` / `fs.changed` | 流 |
| G→H | `exec.run` / `exec.cancel` | 一次性命令 |
| G→H | `pty.open` / `pty.write` / `pty.resize` / `pty.signal` / `pty.close` | 交互式终端 |
| H→G | `pty.data` / `pty.exit` | 流 |
| G→H | `audit.list` | 审计查询 |
| H→G | `revoked` | 房主降档/断开 |

### 11.3 错误码

```text
no-permission        档位不允许 / 目标不在根内
path-escape          resolve + contains 判定越界
not-found / is-dir / not-dir
version-conflict     FS_STALE_VERSION
too-large            FS_TOO_LARGE
rate-limited
exec-timeout
revoked / room-closed
```

错误必须带**人话原因**（会被模型读到）。

### 11.4 版本协商

`hello` 带 `protoVersion`；房主返回 `minSupported`。不匹配直接 `reject{ code: 'proto-mismatch' }`，避免半通不通。

---

## 12. 安全模型

### 12.1 信任声明（必须写进产品文案）

> **进房时的三档授权等于一次 SSH 登录。** `workspace` 档可以改房主项目里的任何文件、运行任何白名单内命令；`global` 档等同拿到房主用户权限。
> 只给信得过的人开房间，并在结束后立即关闭。

这不是可以靠 UI 缓解的风险，只能靠边界清晰 + 可撤销 + 可审计。

### 12.2 边界实现

| 威胁 | 措施 |
|---|---|
| 路径逃逸 | `resolve()` 后必须过 `contains(roomRoot, target)`；**禁止字符串前缀比较**；`lstat` 先拒绝符号链接再 follow |
| Windows 特有 | 盘符、UNC、大小写不敏感、junction 都要在 `contains` 之前处理 |
| 越权写 | `writeText` / `editText` 带 `expected` 版本守卫；`edit` 先校验版本再匹配（`FS_STALE_VERSION`） |
| 越权执行 | `exec` 默认关；开启时 `sandbox.confine(argv, policy)` + cwd 限制 |
| 密钥泄露 | `roomKey` 只在 fragment；中继不落盘；房主侧不持久化明文 |
| 会话泄露 | **结构上不存在**：房主插件不持有 `sessionController` |
| 连接被劫持 | E2E + `proof = HMAC(roomKey, roomId|nonce)` |
| 拒绝服务 | 令牌桶（请求数、字节数、并发流）+ 房间 TTL |

### 12.3 吊销语义

```text
降档    → 下一条请求起生效；不打断已在跑的命令（除非房主选择终止）
断开    → 立即断 WSS，终止该访客所有 pty 与 exec
关房间  → 终止所有访客的所有能力，删除房间
```

---

## 13. 代码结构

单包双角色：`role: 'host' | 'guest' | 'both'`（默认 `both`），一个包里两套半边。

```text
dsh-remote-workspace/
├── package.json              # dsh.bundle.patch + dsh.client
├── cordis.patch.yml          # insert 一行
├── icon.svg
├── locale/{en,zh}.json
├── index.js                  # Host 半边入口：export function apply(ctx, config)
├── src/
│   ├── shared/
│   │   ├── protocol.ts       # zod schema
│   │   ├── crypto.ts         # X25519 + AES-GCM
│   │   └── frame.ts
│   ├── host/                 # 房主侧
│   │   ├── room-server.ts    # 房间注册、邀请、接纳、TTL
│   │   ├── policy.ts         # 三档 + 路径规范化 + contains
│   │   ├── fs-provider.ts    # 实现 ctx.fs 的远端版本
│   │   ├── exec-provider.ts  # subprocess.spawn / spawnTerminal 封装
│   │   ├── pty.ts            # PTY 生命周期与环形缓冲
│   │   └── audit.ts
│   └── guest/                # 访客侧
│       ├── room-client.ts    # WSS 客户端 + 重连
│       ├── remote-fs.ts      # 远端 fs provider（挂给房间会话）
│       ├── remote-subprocess.ts
│       ├── tools.ts          # 仅回退方案用
│       └── prompt.ts
├── client/                   # 浏览器半边
│   ├── index.tsx             # slot 注册
│   ├── RoomTab.tsx           # 灰态 / 已连接 / 断线 三态
│   ├── FileTree.tsx
│   ├── Editor.tsx            # CodeMirror 6
│   ├── Terminal.tsx          # xterm.js
│   └── ConnectPane.tsx
└── test/
```

### Config 草案

```yaml
role: both                    # host | guest | both
relayUrl: wss://room.example.com
roomTtlMs: 7200000            # 2h
tier: workspace               # read-only | workspace | global
root: ''                      # 房主选定的根目录（guest 侧为空）
exclude:                      # 三档都生效
  - '.env'
  - '.env.*'
  - '.dsh'
  - '**/credentials*'
exec:
  enabled: false
  allowlist: []               # workspace 档的默认值
entry: always                 # always | when-connected
```

---

## 14. 里程碑

| 阶段 | 内容 | 验收标准 |
|---|---|---|
| **M0 spike**（1–2 天） | ① 验证 `ctx.fs` / `ctx.subprocess` 能否在隔离 ctx 内替换、与本地 provider 并存；② `wrangler dev` 起 DO 房间；③ 跑通一次远端 `resolve + readText`；④ 中继 debug 断言抓不到明文 | 房间会话读到房主磁盘内容且本地会话不受影响；中继无明文 |
| **M1 远端 fs（只读）** | 远端 fs provider 全量实现；右栏 Tab 三态；文件树 + 预览；权限/审计骨架 | 访客在右栏浏览房主目录并打开文件；`global` 外全部被 `no-permission` 拦住 |
| **M2 远端写** | `writeText` / `editText` + 版本守卫 + diff + 审计回看 | 访客改一个文件，房主审计可见并能回滚；并发改动返回 `version-conflict` |
| **M3 远端执行 + 终端** | `subprocess.spawn` / `spawnTerminal`；xterm 接入；Ctrl-C 走 `signalForeground`；限流 | 在右栏终端里跑 `npm test` 能看到实时输出与退出码 |
| **M4 打磨** | CodeMirror 编辑；`main` 放大；入口偏好；多房间评估；错误文案 | 可日常使用 |

---

## 15. 测试计划

| 类别 | 用例 |
|---|---|
| 路径策略单测 | `..`、绝对路径、符号链接、junction、UNC、大小写、尾随空格、超长路径 |
| 权限矩阵 | 3 档 × {read, write, list, exec} × {根内, 根外, 排除项} 全组合 |
| 协议单测 | 帧编解码、版本不匹配、重放（seq）、篡改（GCM tag） |
| 一致性 | `write` 后 `read` 版本一致；`edit` 冲突返回 `FS_STALE_VERSION` |
| E2E | 两个浏览器上下文（房主/访客），跑通连接 → 浏览 → 编辑 → 终端 |
| 安全 | 中继侧开启明文记录模式，断言**零明文**；断言房主 side 无 session 访问 |
| 兼容 | 与 better-sidebar 同时启用，右栏 Tab 并存；禁用已装插件后不崩 |

---

## 16. 风险与未决

| # | 风险 / 未决 | 影响 | 处理 |
|---|---|---|---|
| 1 | **provider 能否隔离**（同一进程两套 `ctx.fs`） | 决定走首选还是回退 | **M0 spike 第一件事**；失败即切 §8.2 |
| 2 | Windows ⇄ POSIX 路径差异 | 房主 Windows、访客假设 POSIX 时易错 | 路径一律用 `processPath`；`contains` 前做平台规范化 |
| 3 | 右栏已有 17 个 Tab | 拥挤、找不到 | 灰态要轻；label 明确"远程"；`when-connected` 偏好 |
| 4 | DO 免费额度是否够用 | 影响分发成本 | M0 实测；不行则降级为"仅在会话期间保活" |
| 5 | `PromptSection` 字段未确认 | 提示注入写不对 | 以 `listService('systemPrompt')` 为准 |
| 6 | 交互式 PTY 的 shell 选择 | Windows 上 shell 差异大 | 用 `terminalEnvironment()` 取 `defaultShell` |
| 7 | 多房间 | 首版只允许一个活动房间 | M4 评估；工具/槽 key 已预留后缀空间 |
| 8 | 大文件与二进制 | 内存与带宽 | `readBytes(maxBytes)` + `FS_TOO_LARGE`；二进制走下载而非预览 |
| 9 | 房主没有 Agent 时的 PTY 清理 | 泄漏进程 | `ctx.effect` 注册 disposer；服务卸载时 `terminate()` 全部 handle |

---

## 17. 参考

**Remote 开发**
- https://code.visualstudio.com/blogs/2019/07/25/remote-ssh
- https://code.visualstudio.com/docs/remote/ssh-tutorial
- https://github.com/microsoft/vscode/tree/main/src/vs/platform/remote （MIT）
- https://github.com/microsoft/vscode/tree/main/src/vs/server （MIT）

**DSH 实现参考（MIT）**
- https://github.com/deepseek-ai/deepseek-harness
- `packages/fs/{fs,fs-local,fs-sandbox,tool-fs,tool-fs-search}`
- `packages/shell/{bash-local,bash-sandbox,tool-bash,tool-bash-persistent}`
- `packages/subprocess/{subprocess,subprocess-local}`
- `packages/terminal/{terminal,terminal-bash}`
- `packages/ssh/{ssh,fs-ssh,subprocess-ssh,sandbox-ssh,ssh-helper-runtime}`

**传输与安全**
- https://developers.cloudflare.com/durable-objects/
- https://developers.cloudflare.com/durable-objects/best-practices/websockets/
- https://doc.libsodium.org/

**编辑器与终端**
- https://github.com/xtermjs/xterm.js
- https://codemirror.net/

---

_本文档为现行唯一方案（v3）。所有 DSH 签名、槽占用数、star 数均为 2026-10-26 本机实测或 GitHub API 实时查询；标 ⚠️ 的条目需在 M0 用真实环境确认。_
