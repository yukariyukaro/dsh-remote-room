# DSH 远程工作区插件 · 方案 v4

> 一句话：**把房主的 DSH 当成一台 SSH 机器，把访客的 DSH 当成本地 VS Code。**
> 房主只提供文件与终端能力；Agent、模型、会话全部跑在访客这边。
>
> 本版根据 **ShellHub 源码实测**重写了传输层。ShellHub 已 clone 到 `vendor/shellhub`（2026-10-26，Apache-2.0）。
> 历史：v1（会话共享）→ v2（能力 RPC）→ v3（provider seam）→ **v4（反向隧道 + 流复用 + 命名协议）**。

---

## 0. 决策记录

### 0.1 已定

| # | 决策 |
|---|---|
| D1 | 房主只提供能力（fs / exec / 审计），**不跑 Agent、不共享会话、不暴露 Web** |
| D2 | Agent 跑在访客侧，用访客的模型与 token |
| D3 | 入口 = 右栏 Tab（`sidebar.right.pane.tab`），左栏与对话页不碰 |
| D4 | 常驻图标 + 未连接灰态 |
| D5 | `main` 整页作为可选"放大模式" |
| D6 | 中继 = Cloudflare Workers + Durable Objects |
| D7 | 房主零入站端口、零页面托管 |
| D8 | 一期只服务"双方都装插件" |
| **D9** | **传输层照搬 ShellHub**：房主出站 WSS → 反向隧道 → **多路复用流** → 每流协商**命名协议** |
| **D10** | 协议名带版本：`/dsh/fs/1.0.0`、`/dsh/pty/1.0.0`、`/dsh/audit/1.0.0`、`/dsh/ctl/1.0.0` |
| **D11** | fs 走结构化 JSON-RPC（可审计、可版本校验）；pty 走字节流；两者**不同协议、不同流** |
| **D12** | 权限 = 三档 + **规则表**（ShellHub firewall 式，默认拒绝） |
| **D13** | 审计 = 会话对象 + 可回放（`before`/`after`），带保留期裁剪（ShellHub session recording 式） |

### 0.2 v3 → v4 的关键变更

| 项 | v3 | v4 | 依据 |
|---|---|---|---|
| 传输 | 自己设计帧类型 `[ver][type][len]` | **反向 WSS + yamux 式流 + multistream 式协议协商** | ShellHub `agent/pkg/tunnel/tunnel.go` |
| 多路复用 | 无（fs 与 pty 会互相阻塞） | 每能力一条独立 stream | 同上 |
| 协议演进 | 单帧版本号 | **协议名里带版本**，可并行多版本 | `server/ssh/pkg/dialer/protocols.go` |
| 终端会话层 | 自定义字节流 | 字节流（默认）/ 可选 **SSH over stream** | `agent/server/server.go` |
| 权限 | 三档 | 三档 + 规则表（默认拒绝） | `server/api/services/firewall.go` |
| 审计 | 元数据日志 | 会话对象 + 录制/回放 + 保留期 | `server/api/services/session-recording.go` |

### 0.3 备选（不选）

| 方案 | 为什么不选 |
|---|---|
| A. 浏览器里跑一个 DSH | 访客没装 DSH 时才需要；等于重写瘦客户端 |
| B. 公开房主的 DSH Web 端 | 暴露整套后台与登录态 |
| C. 共享房主的 Agent 会话 | 访客聊天要重写、烧房主 token、权限纠缠 |
| E. 远端目录同步成本地镜像 | 延迟/冲突/磁盘；可作后续离线模式 |

---

## 1. 一页速览

```text
┌──────────┬─────────────────────────┬──────────────────────┐
│ 左栏     │ 中间：访客自己的会话      │ 右栏：房主的机器      │
│ 工作区   │ 原装 Agent、原装工具卡    │ ├ 连接状态（灰态）    │
│ 会话列表 │ 原生 read/write/bash      │ ├ 远端文件树          │
│          │ （底下走房主 provider）    │ ├ 预览 / 编辑 / diff  │
│          │                          │ └ 终端（PTY 在房主）  │
└──────────┴─────────────────────────┴──────────────────────┘
                        ↑ 一条出站 WSS
              Relay（Cloudflare DO，哑管道）
                        ↓
┌──────────────────────────────────────────────────────────┐
│ 房主 DSH：只有能力                                          │
│  tunnel ← yamux 流 ← 协议协商 → fs / pty / audit 处理器      │
└──────────────────────────────────────────────────────────┘
```

### 三条铁律

1. 房主不出 Agent、不出会话、不出页面；
2. Agent 在访客侧（对话页零改动）；
3. 终端 PTY 在房主。

---

## 2. 术语

| 术语 | 含义 |
|---|---|
| tunnel | 房主主动建立、长期保持的反向连接到中继 |
| stream | tunnel 上的一条逻辑流（类似 yamux 的 stream） |
| protocol | stream 打开后协商的协议名，带版本，如 `/dsh/fs/1.0.0` |
| capability | fs / pty / audit 三类能力 |
| tier | `watch` / `edit` / `takeover` |

---

## 3. 参照物

### 3.1 VS Code Remote-SSH（心智）

| 层 | Remote-SSH | 我们 |
|---|---|---|
| UI | 本地 VS Code | 访客 DSH |
| 资源 | 远端（VS Code Server） | 房主 DSH |
| 通道 | SSH + 复用 RPC | 反向 WSS + 复用流 |
| 入口 | 活动栏 Remote Explorer | 右栏 Tab |
| 授权 | SSH 密钥一次授权 | 进房一次授权（三档） |

### 3.2 Remote-SSH 不能抄

| 来源 | 结论 |
|---|---|
| `microsoft/vscode-remote-release` | ⚠️ **问题追踪仓库**（4.2k★，非源码），扩展本体不开源 |
| `microsoft/vscode` `src/vs/platform/remote/**` | ✅ MIT，可读可抄：`managedSocket.ts`、`remoteAgentConnection.ts`、`remoteAuthorityResolver.ts`、`remoteSocketFactoryService.ts` |

### 3.3 ShellHub 实测架构（本版主要依据）

已 clone：`vendor/shellhub`（Apache-2.0，2.2k★）。逐模块结论：

#### ① 隧道：反向 WSS + 多路复用 + 协议协商

`agent/pkg/tunnel/tunnel.go`：

```go
// Tunnel accepts the connections a ShellHub server opens back to the device
// and dispatches each to the handler registered for its protocol.
type Tunnel[H] interface {
    Handle(protocol string, handler H)
    Listen(ctx context.Context, listener net.Listener) error
    Close() error
}

// TunnelV2 multiplexes streams over the reverse connection,
// selecting a handler by the protocol name the peer negotiates.
type TunnelV2 struct {
    mux      *multistream.MultistreamMuxer[string]
    cli      client.Client
    listener net.Listener
}
```

- **V2**：yamux（`hashicorp/yamux v0.1.2`）+ `go-multistream v0.6.1`，每个流用 multistream-select 协商协议名；
- **V1**（legacy）：把反向连接当 HTTP 解析，按 `METHOD://path` 路由；
- 断线用 `ErrTunnelDisconnect`（WebSocket `CloseAbnormalClosure`）表达，由 `cli` 重开连接。

#### ② 协议名是常量且带版本

`server/ssh/pkg/dialer/protocols.go`：

```go
const (
    ProtoSSHOpen   = "/ssh/open/1.0.0"
    ProtoSSHClose  = "/ssh/close/1.0.0"
    ProtoHTTPProxy = "/http/proxy/1.0.0"
)
// The agent and server must keep these values in sync.
// Changing a value is a wire incompatible change.
```

#### ③ 设备端跑 SSH 服务器，但**不监听端口**

`agent/server/server.go`：

```go
// Server is the agent's SSH server. It does not listen on a public port:
// the connections it serves arrive over the tunnel the agent holds open.
func (s *Server) HandleConn(conn net.Conn) { s.sshd.HandleConn(conn) }
```

- 用 `gliderlabs/ssh`（他们 fork 了：`replace github.com/gliderlabs/ssh => github.com/shellhub-io/ssh`）；
- 通道：`session`（shell/exec/subsystem）与 `direct-tcpip`（端口转发）；
- PTY：`gliderlabs.AllocatePtyHandler`，底层 `creack/pty`（POSIX）+ `charmbracelet/x/conpty`（Windows）；
- 保活：每会话一个 loop，`conn.SendRequest("keepalive", true, nil)`；
- 会话登记：`Sessions sync.Map`，支持按 id 强制关闭。

#### ④ 连接装配

`agent/pkg/agentd/agent.go:775-794`：

```go
tun := tunnel.NewTunnelV2(a.cli)
tun.Handle(HandleSSHOpenV2,  sshHandlerV2(a))
tun.Handle(HandleSSHCloseV2, sshCloseHandlerV2(a))
tun.Handle(HandleHTTPProxyV2, httpProxyHandlerV2(a))
```

**这正是我们要的形态**：一个长期反向连接，按协议名分发到不同处理器。

#### ⑤ 权限：默认拒绝的规则评估

`server/api/services/firewall.go`：

```go
// AllowsConnection returns nil when the connection may proceed, ...
AllowsConnection(ctx context.Context, conn models.FirewallConnection) error
func (s *service) EvaluateFirewall(ctx context.Context, conn models.FirewallConnection) error
// Community Edition: there are no rules, so the connection is allowed.
```

#### ⑥ 审计：录制是**对象**，与会话行解耦

`server/api/services/session-recording.go`：

> "A recording is an object, not a row, and nothing in the schema points at it: it is found by composing a key from the session's UID. Deleting the session row therefore does not delete the recording."
> 会话行上有 `Recorded` 标志；保留期删除时由 pruner 按 UID 清对象。

#### 对我们最有价值的三条

1. **不要让终端独占连接**：反向连接必须从一开始就是多路复用的，否则 fs 请求会被终端字节流阻塞。
2. **协议名带版本**，可以让新旧两端并存升级，避免"半通不通"。
3. **PTY 在设备侧**，通过 SSH 语义（`AllocatePtyHandler`）而不是自定义 resize/signal 消息——已被两个操作系统验证过（POSIX + Windows conpty）。

### 3.4 其他可抄的开源实现

| 项目 | ★ | 许可证 | 抄什么 |
|---|---|---|---|
| shellhub | 2.2k | Apache-2.0 | **主参考**：隧道/流/协议/PTY/规则/录制 |
| warpgate | 8.1k | Apache-2.0 | bastion 的产品化：目标建模、Web 管理 |
| next-terminal | 5.7k | Apache-2.0 | TS 写的堡垒机 + Web 终端 + 会话审计 |
| webssh | 5.1k | MIT | 极简 Web SSH（xterm + 后端通道） |
| ssh2 (Node) | 5.8k | MIT | 纯 JS SSH 客户端/服务端；做 SSH-over-stream 时用 |
| yamux / smux | 2.7k / 1.6k | MPL-2.0 / MIT | 流复用语义参考 |
| teleport | 21.0k | ⚠️ AGPL-3.0 | 只抄设计：短期凭证 + RBAC + 回放 |
| jumpserver | 31.8k | ⚠️ GPL-3.0 | 只抄设计：资源/授权/审计三元组 |
| code-server | 79.7k | MIT | 浏览器 IDE 的静态资源与 WS 组织 |

**许可分层**：MIT / Apache-2.0 / BSD / MPL-2.0 可抄代码；AGPL / GPL **只抄设计**。

### 3.5 两个参照物：值得抄什么、不值得抄什么

一句话分工：**Remote-SSH 教我们"怎么在 UI 上表示一台远端机器"，ShellHub 教我们"怎么把连接送进内网"。**

#### VS Code Remote-SSH

| 值得参考 | 具体到我们 |
|---|---|
| **authority 概念**：`vscode-remote://ssh-remote+host/path` 把"哪台机器"编进资源地址 | `FsTarget.targetKey` 里编 roomId；房间不是全局开关，是资源的一部分 |
| **连接复用 + 重建**：`managedSocket.ts` / `remoteAgentConnection.ts` | tunnel 断线后重建所有 stream，而不是重开界面 |
| **能力探测而非假设**：远端 shell / 平台 / 架构都是问出来的 | `terminalEnvironment()` 拿 `platform`、`defaultShell` |
| **UI 常驻显示"我在哪台机器"** | 右栏 Tab 头部常驻房间名 + 在线状态；断线要显式降级 |
| **版本协商**：远端 server 版本不匹配会提示 | 协议名带版本 + `ctl` 握手带 `minSupported` |

| 不值得 | 原因 |
|---|---|
| extension host 远程化 | 我们的 Agent 故意在本地 |
| 窗口级隔离（新窗口） | 我们是右栏 Tab |

#### ShellHub

| 值得参考 | 具体到我们 |
|---|---|
| **反向连接 + yamux 流 + multistream 协议名** | 已采纳（§5） |
| **设备端服务器"不监听端口"**：只 `HandleConn(conn)`，连接从隧道来 | 房主处理器写成"给我一条 stream 我来服务"，与传输解耦 → 好测，将来能接真 SSH |
| **传输版本并存**：V1（HTTP）与 V2（yamux）同时支持 | `ctl` 预留多版本并行，不用一次性切换所有用户 |
| **会话表 + 强制关闭**：`Sessions sync.Map` + `CloseSession(id)` | 房主踢人时必须 `terminate()` 正在跑的 PTY，而不是只断 WSS |
| **PTY 双平台**：`creack/pty`（POSIX）+ `conpty`（Windows） | 我们用 DSH `spawnTerminal` 已覆盖，但要处理 Windows shell 选择与编码 |
| **评估返回原因而非布尔** | 简化为 `throw deny(原因)`（§4.2） |

| 不值得 | 原因 |
|---|---|
| namespace / tenant / device / tag 多层 | 多租户 SaaS 的模型，我们是 1:1 熟人 |
| firewall 规则引擎 | 三档足够（§4.3） |
| connector 管理容器 | 与我们的场景无关 |
| 企业版录制 pruner | 我们没有对象存储与保留期合规需求 |

### 3.6 与 Remote-SSH 最大的不同：我们没有 server bootstrap

Remote-SSH 连远端要做三件事：

1. 用本机 OpenSSH 建隧道；
2. 检查远端有没有**版本匹配**的 VS Code Server，没有就推送到 `~/.vscode-server` 并启动（几百 MB，需要下载、需要 Node）；
3. 之后本地只有 UI，文件 / 终端 / 调试 / 语言服务全部在远端。

对照我们：

| 步骤 | Remote-SSH | 我们 |
|---|---|---|
| 传输 | 本机 OpenSSH 客户端 | 房主**出站 WSS**（不需要 sshd、不需要公网） |
| 部署服务端 | 下载并启动 VS Code Server | **不需要**：房主的 DSH 本来就在跑 |
| 版本匹配 | 必须匹配，否则重装 | 协议名带版本，`ctl` 握手协商 |
| 本地职责 | 只有 UI | 访客的 DSH：UI + Agent |

**这是本方案最有利的一点**：房主的 DSH 之所以在线，正是因为他遇到了问题需要帮忙——它天然"已经部署好了"。我们没有 `~/.vscode-server` 那一步，也没有几百 MB 下载。

代价：房主必须装我们的插件（一次性），且 DSH 必须在运行。这和 Remote-SSH 需要 sshd 常驻是同一种约束。

> 所以"两边都要起服务吗"的答案是：**要，但两个服务都是已经跑着的 DSH 进程里的插件**，不是新部署的守护进程。

### 3.7 传输选型：为什么是"自写 mux"，不是 ssh2 / Teleport / ShellHub 代码

| 选项 | 是什么 | 重量 | 结论 |
|---|---|---|---|
| **ssh2（Node, MIT）** | 纯 JS 的 SSH 客户端 + 服务端 | 一个 npm 依赖 | 不用于 fs。SSH 的 fs 是 SFTP，给不了版本守卫、`contains` 边界、`before/after` 审计；且要求**字节透明的传输**，得把 WSS 包装成 socket |
| **Teleport（Go, AGPL）** | 一整套访问基础设施（CA + proxy + auth） | 一个集群 | 只抄设计 |
| **ShellHub（Go, Apache）** | 多租户 SaaS | 两个微服务 | 我们不是 Go，**抄不了代码**，只抄设计（§3.3） |
| **自写 mux（约 150 行）** | 帧 + 流 + 窗口 | 零依赖 | ✅ v1 采用 |

**关于"ShellHub 会不会太重"**：我们不是引入 ShellHub，是抄它的三个概念——反向隧道、按流协商协议名、设备端不监听端口。这不是依赖，是设计。

真正会让项目变重的是 **ssh2 路线**：多一套协议栈（密钥、算法协商、通道）、一个把 WSS 伪装成 socket 的适配层，而且文件能力还得另写——等于两套协议并存。

**什么时候值得上 ssh2**：当我们想让标准 `ssh` 客户端直接连进房间时。那是 M5 之后的事，届时只让终端流里跑 SSH，fs 协议保持不变。

---

## 4. 权限模型

### 4.1 先说清楚：SSH 建立后就是完全权限

真正的 SSH 一旦认证通过，你拿到的就是这个用户的全部权限，**没有"目录"这个概念**。
所以"像 SSH"只有一种含义：**接管这台机器**。

我们的三档不是安全分层，而是三种**产品意图**：

| 档位 | 语义 | 能做什么 | 能否被目录约束 |
|---|---|---|---|
| `watch` 只读 | 帮我看一眼 | 读共享目录内文件 | ✅ 纯 fs，能 |
| `edit` 编辑（默认） | 帮我改文件 | 读 + 写共享目录内 | ✅ 纯 fs，能 |
| `takeover` 接管 | 这就是 SSH | 整机读写 + 执行命令 | ❌ 不能 |

### 4.2 为什么 `edit` 不含执行

**一个能跑命令的终端无法被目录约束** —— `cd ..`、`cat /etc/passwd`、`curl` 就出去了。

所以"共享目录 + 允许执行"只有三条路：

1. 套沙箱（`ctx.sandbox.confine`）—— Windows 上是否真的 confine 得住，**待验证**；
2. 假装目录能兜住 —— 不诚实，不做；
3. **归到 `takeover`** —— ✅ v1 选这个。

沙箱验证通过后，再考虑给 `edit` 增加"受限执行"档。在那之前，**想跑东西就明确升到"接管"**，让房主知道自己交出去的是什么。

### 4.3 实现：四个分支

```ts
function guard(tier: Tier, op: 'read' | 'write' | 'exec', target?: FsTarget): void {
  if (tier === 'takeover') return                    // 整机：不做任何检查
  if (op === 'exec')       throw deny('当前档位不含命令执行，需要房主升级为"接管"')
  if (op === 'write' && tier === 'watch')
                           throw deny('当前档位只读')
  if (target && !ctx.fs.contains(roomRoot, target))
                           throw deny('路径不在共享目录内')
}
```

`contains()` 是 DSH 给的（官方描述："不解析 targetKey 的规范化包含判定"），不用自己拼路径。

**关于"返回原因"**：这不是安全机制，就是 `throw new Error(原因)` 而不是 `return false`。效果是——模型被拒时知道"是只读档"，于是不再反复重试；如果只抛 `denied`，它通常会换个写法再试三次。（这是 ShellHub 里唯一值得保留的权限细节。）

**默认是 `edit` 不是 `takeover`**：够用来改配置、修日志，但不会一上来就把整台机器交出去。朋友要跑起来验证时，房主再点一下升级。

### 4.4 刻意不做的事

| 不做 | 理由 |
|---|---|
| 规则表 / 策略引擎 | 1:1 的熟人场景，三档足够；ShellHub 的 firewall 是给多租户 SaaS 用的 |
| RBAC / 多租户 / 标签 | 我们没有"组织"这个概念 |
| 逐次审批弹窗 | 房主插件没有会话上下文，做不成；且违背 SSH 心智 |
| 每命令审计 + 合规报表 | v1 只保留"可回滚"所需的最小记录 |
| 会话录制视频流 | 回放靠 `before`/`after` 文本 diff，够用 |

**信任模型**：房主选 `takeover` 就是把自己的机器交出去，这个责任在他自己，产品要做的是**把选择讲清楚 + 随时能收回**，而不是用一层层规则假装能兜住。风险提示写在 §12.1。

### 4.5 默认排除项（可空，默认只挡 `.dsh`）

```text
.dsh/                    房主自己的 DSH 配置与会话（默认）
.env / .env.*            凭据（建议，可选）
**/credentials*          provider key（建议，可选）
```

排除项只是 `guard()` 里多一次字符串检查，**默认值保持最小**，不让用户配一堆东西才能开房间。

### 4.6 生命周期

```text
建房 → 选根目录 + 档位 + 过期 → 邀请（roomId + roomKey 在 fragment + tier）
访客连接 → 一次性授权生效
房主：随时降档 / 断开 / 关房（立即生效；正在跑的 pty 与 exec 一并终止）
```

---

## 5. 连接链路（重写：反向隧道 + 流复用）

### 5.1 拓扑

```text
房主 DSH ──出站 WSS(长连)──► Relay(CF DO)  ◄──出站 WSS── 访客 DSH
   隧道服务端                        哑管道                隧道客户端
   (接受 stream)                  按 roomId 转发            (打开 stream)
```

**注意方向**：房主永远是**接受** stream 的一方（因为房主在内网），访客与中继负责**打开** stream。这与 ShellHub 一致：agent 反向连到服务器，服务器再向 agent 开流。

### 5.2 分层

```text
┌─────────────────────────────────────────────┐
│ 应用协议（命名、带版本）                       │
│  /dsh/ctl/1.0.0   /dsh/fs/1.0.0              │
│  /dsh/pty/1.0.0   /dsh/audit/1.0.0           │
├─────────────────────────────────────────────┤
│ 流复用（streamId + 窗口/背压）                 │
├─────────────────────────────────────────────┤
│ 帧与加密（AES-256-GCM，AAD 绑 roomId|dir|seq） │
├─────────────────────────────────────────────┤
│ WSS（TLS 1.3）→ Cloudflare DO                 │
└─────────────────────────────────────────────┘
```

### 5.3 流复用的最小实现

不引入 JS 版 yamux（生态不成熟），自己写 ~200 行：

```text
帧头： [1B type][4B streamId][4B len][payload]
type： OPEN=1  DATA=2  WINDOW=3  CLOSE=4  RST=5  PING=6
窗口： 初始 256 KB，消费方回 WINDOW(增量)；发送方窗口耗尽则挂起该 stream
```

语义照 yamux：单流独立背压、半关闭、异常用 RST。

### 5.4 协议协商

打开 stream 后，发起方先发一行协议名（长度前缀），接受方回 `GO` 或 `NOPE`：

```text
→ lenPrefix("/dsh/fs/1.0.0")
← "GO"
→ 之后进入该协议的载荷
```

与服务端能力清单不匹配 → `NOPE`，对方关流。版本不匹配 → `NOPE` + 可选的支持列表。

### 5.5 加密与邀请

```text
X25519 ECDH → HKDF-SHA256 → 双向独立 AES-256-GCM
邀请： https://<relay>/j/<roomId>#<roomKey>    （# 之后不进 HTTP）
握手： hello{ roomId, tier, nonce, proof = HMAC(roomKey, roomId|nonce) }
```

中继只看到 `roomId`、帧长、时间戳，看不到内容。

---

## 6. 能力面与 DSH 服务映射

### 6.1 `ctx.fs`（房主侧真实实现，本机实测签名）

```ts
resolve(path, { cwd?, signal? }): Promise<FsTarget>          // 允许往返 I/O
processPath(target): string
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

```ts
FsWriteOutcome = { operation, version, before: string | null, after: string }
FsEditOutcome  = { version, before, after }
FsTarget       = { targetKey, displayPath }    // targetKey 对调用方不透明
```

DSH 文档本身就为远端 provider 留了口子：

> `resolve()`: "**a remote/sandboxed backend may need a round-trip** to map a path to a stable identity"
> `contains()`: "Test canonical containment **without exposing or parsing backend target keys**"

### 6.2 能力 → 协议 → 房主实现

| 能力 | 协议 | 房主实现 | 权限点 |
|---|---|---|---|
| 列目录 | `/dsh/fs` | `listDir` | read |
| 读文件 | `/dsh/fs` | `readText` / `readByteRange` / `streamText` | read |
| 写 / 编辑 | `/dsh/fs` | `writeText` / `editText`（版本校验 → `FS_STALE_VERSION`） | write |
| 变更通知 | `/dsh/fs` | `watch` | read |
| 边界判定 | `/dsh/ctl` | `contains(roomRoot, target)` | 全部 |
| 终端 | `/dsh/pty` | `subprocess.spawnTerminal` | exec |
| 一次性命令 | `/dsh/pty` | `subprocess.spawn` | exec |
| 审计查询 | `/dsh/audit` | 本地审计存储 | read |

### 6.3 `ctx.subprocess`（房主侧，实测）

```ts
spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle>
//  spec: { argv, cwd, env?, rows, cols, terminalType, shellActivity?, graceMs, signal? }
//  handle: { pid, output: Readable, write(), resize(), inspectForeground(),
//            inspectActivity(), signalForeground(SIGINT|SIGTERM|...), terminate(), done }
terminalEnvironment(signal?): Promise<{ platform: 'posix'|'windows'; defaultShell?: string }>
```

`spawnTerminal` **不需要 Agent** —— 这是"PTY 在房主"成立的根本。

### 6.4 沙箱

```ts
ctx.sandbox.confine(argv, policy, signal?): Promise<ConfinedArgv>
ctx.sandboxPolicy.resolve({ session? }): SandboxExecutionPolicy
```

`takeover` 档执行时用 `confine` 包命令（若可用）；`edit` 档写文件时把 `SandboxExecutionPolicy` 作为 `writeText` 的最后一个参数传入。

---

## 7. 终端：PTY 在房主

### 7.1 默认方案（v4 采用）

```text
访客 xterm.js ──/dsh/pty 流──► 房主 spawnTerminal
                                 ├─ output → DATA 帧
                                 ├─ 键盘   → DATA 帧（反向）
                                 ├─ resize → resize()
                                 └─ Ctrl-C → signalForeground('SIGINT')
```

沿用 ShellHub 的三条经验：

| ShellHub 做法 | 我们照做 |
|---|---|
| PTY 在设备侧分配（`AllocatePtyHandler`） | 房主 `spawnTerminal` |
| 保活用协议级 `keepalive` 请求 | `/dsh/ctl` 上的 `PING` 帧 + SSH 层可选 |
| 会话可被服务端强制关闭（`Sessions` 表 + `CloseSession`） | 房主维护 `Map<ptyId, handle>`，吊销时 `terminate()` |

### 7.2 可选：SSH over stream

若希望"房间真的是 SSH 语义"（可以日后让人用标准 ssh 客户端连进来）：

```text
/dsh/pty 流里跑 SSH 协议：
  房主侧：ssh2.Server（Node, MIT）接收该 stream，内部再 spawnTerminal
  访客侧：ssh2.Client 连该 stream，用 session+pty 通道
```

代价：多一层协议与密钥管理；收益：`session`/`direct-tcpip`/`sftp` 全部白拿，且与 ShellHub 完全同构。
**一期不做，列为 M4 之后的可选项。**

### 7.3 为什么不用 `ctx.terminals`

```ts
ctx.terminals.spawn(owner: Agent, request, signal?)   // ← 需要 Agent
```

房主插件没有 Agent，用不了。DSH 自带的右栏终端仍服务**本地**会话，与我们的远端终端并存。

---

## 8. 工具层：本地与远端如何区分

### 8.1 首选：换 provider，不加工具

若 `ctx.fs` / `ctx.subprocess` 能在隔离 ctx（或 agent preset）里替换（M0 spike 验证），则房间会话里的 `read` / `write` / `edit` / `glob` / `grep` / `bash` 全是**原生工具**，底下走远端 provider。

这就是 Remote-SSH 的做法：不是给编辑器加"远程读写"命令，而是整个窗口换了宿主。

### 8.2 回退：`room_*` 工具

`room_read` / `room_list` / `room_glob` / `room_grep` / `room_write` / `room_edit` / `room_bash`。

实现直接参考仓库（MIT）：

```text
packages/fs/tool-fs                  read / write / edit
packages/fs/tool-fs-search           glob / grep
packages/fs/tool-str-replace-editor
packages/shell/tool-bash
packages/subprocess/subprocess-local   spawn / spawnTerminal 的本地实现
packages/terminal/terminal-bash        PTY 后端
```

工具卡用 `tool.call.toolview`（keyed by 工具名，keyDomain 开放）注册成与原生一致的 read / diff / terminal 卡片。

### 8.3 提示词兜底（两种方案都要）

```text
- 你正在操作房主机器上的目录 <remoteRoot>，其中路径是远端路径。
- 本地工作区 <localRoot> 与本房间无关。
- 当前档位：<tier>。
- 被拒绝时不要重复尝试，把原因告诉用户。
```

⚠️ `PromptSection` 字段以本地 `listService('systemPrompt')` 为准。

---

## 9. UI：右栏 Tab

### 9.1 事实（实测）

| 属性 | 值 |
|---|---|
| slot | `sidebar.right.pane.tab` |
| kind | `keyed` |
| keyDomain | **open** |
| replaceRisk | **none** |
| declaredBy | 一个 entry 在 `rightbar.session`（DSH 自带） |
| scope | `session` |
| 现有占用者 | **17 个** |

### 9.2 注册

```js
ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
  name: 'sidebar.right.pane.tab',
  key: 'dsh-room:workspace',
  component: RoomTab,                 // 常驻；未连接渲染灰态
}))

ctx.slots.register({ name: 'main', key: 'room', component: RoomTab })   // 放大模式
ctx.slots.register({ name: 'settings.section', id: 'dsh-room', ... })   // 房主管理
```

### 9.3 三态

| 状态 | 渲染 |
|---|---|
| 未连接 | 邀请码输入 / 等待接纳 / 上次错误 + 重试（轻量灰态） |
| 已连接 | 文件树 + 预览/编辑 + diff + 终端 + 能力清单 |
| 断线 | 原因 + 重试 + "房间是否仍存活" |

灰态用 `--dsw-alias-*` 弱化色，不硬编码。

### 9.4 已接受约束

> 没打开会话时右栏不出现（`scope: 'session'`）。

### 9.5 可白拿的 hooks

```text
useResource / useWorkspaces / usePanelInfo / useSessions
useRemoteAccess / useSessionAccess / useWorkspaceAccess / useAccess
useChat / useConversation / useInput / inputActions
hookContext: TabHookContext
```

`useAccess(action)` 直接驱动"能否写/能否执行"的界面开关。

### 9.6 组件

| 区域 | 实现 |
|---|---|
| 文件树 | 自写（懒加载 `listDir`） |
| 预览 | 自写（文本 / 图片 / 二进制提示） |
| 编辑 | **CodeMirror 6**（~200 KB） |
| Diff | `diff` 库 + 自写渲染 |
| 终端 | **xterm.js** + fit addon |
| 连接面板 | 自写 |

---

## 10. 兼容性

### 10.1 实测

better-sidebar 只注册：`sidebar.right.pane.tab`、`.title`、`conversation.session.header.utilities`、`settings.section`、`shell.overlay`。
**从不碰** `sidebar`、`sidebar.panellist`、`main`。

### 10.2 三条禁令

| 禁止 | 原因 |
|---|---|
| ❌ 注册 `sidebar` | catalog：注册它会 **replaces the navigation column outright** |
| ❌ 复用别人的 key | 撞 key 就是替换该 occupant |
| ❌ 只做右栏入口 | 右栏是 session 作用域，必须有 `settings.section` 或命令兜底 |

### 10.3 版本风险

better-sidebar README 写明 v0.28.0 接管 npm `latest`，而 DSH 仍是 0.2.x，宿主必须固定版本。

---

## 11. 协议 v1（流 + 命名协议）

### 11.1 协议名

| 协议 | 用途 |
|---|---|
`/dsh/ctl/1.0.0` | 握手、ping、能力清单、吊销通知
`/dsh/fs/1.0.0` | JSON-RPC：resolve/stat/lstat/list/read/write/edit/watch
`/dsh/pty/1.0.0` | 字节流：open/write/resize/signal/close
`/dsh/audit/1.0.0` | 审计查询

版本规则照 ShellHub：**改变协议名中的版本 = 线上不兼容变更**。

### 11.2 `/dsh/fs` 方法

| method | 入参 | 出参 |
|---|---|---|
| `resolve` | `path` | `{ targetKey, displayPath }` |
| `stat` / `lstat` | `path` | `{ type, size, version }` |
| `list` | `path` | `[{ name, type, size, version }]` |
| `read` | `path, offset?, length?` | `{ text, totalLines, version }` |
| `write` | `path, content, expectedVersion?` | `{ version, before, after }` |
| `edit` | `path, oldString, newString, replaceAll, version` | `{ version, before, after }` |
| `watch` | `path` | 流：`{ path, kind }` |

### 11.3 `/dsh/pty` 控制消息

```text
open   { argv?, cwd?, rows, cols, terminalType }
data   原始字节（双向）
resize { cols, rows }
signal { name: 'SIGINT'|'SIGTERM'|'SIGHUP' }
close  { reason }
exit   { code, signal }
```

### 11.4 错误码

```text
no-permission       档位不允许 / 不在根内
path-escape         resolve + contains 判定越界
not-found / is-dir / not-dir
version-conflict    FS_STALE_VERSION
too-large           FS_TOO_LARGE
rate-limited
exec-timeout
revoked / room-closed / proto-mismatch
```

错误必须带人话原因（会被模型读到）。

### 11.5 背压

- `pty` 的 `DATA` 帧按 window 流控；超过 200 帧/秒在房主侧合并；
- `fs.read` 大文件走 `streamText` 分块 + 窗口；
- 窗口耗尽时挂起该流，不影响其他流。

---

## 12. 安全模型

### 12.0 原则：靠边界清晰与可撤销，不靠层层规则

安全的三个支点，其余都是可选：

1. **边界清晰** —— 根目录 + 三档，一眼能说明白；
2. **随时能收回** —— 降档、断开、关房，立即生效；
3. **改了什么看得见** —— `before`/`after` 可回滚。

不做的：规则引擎、合规报表、行为分析。房主选 `takeover` 就是交出机器，这个责任他自己承担；产品负责**把选择讲清楚**，不假装能用规则兜住。

### 12.1 信任声明（写进产品文案）

> **`takeover` 档等于一次 SSH 登录**：可以读写任何路径、执行任何命令。`edit` 档可以改共享目录内的文件但不能执行命令；`watch` 档只能看。只给信得过的人开房间，用完即关。

### 12.2 边界（全部实现只有 §4.2 那一个函数 + 两处护栏）

| 威胁 | 措施 |
|---|---|
| 路径逃逸 | `resolve` 后过 `contains(roomRoot, target)`；**禁止前缀比较**；`lstat` 先拒符号链接 |
| Windows 特有 | 盘符 / UNC / 大小写 / junction —— 交给 `contains()`，不自己拼 |
| 越权写 | `expected` 版本守卫（防覆盖，不是防越权）；`edit` 先校验版本再匹配 |
| 越权执行 | `exec` 默认关；开启时 `sandbox.confine(argv, policy)` |
| 密钥泄露 | `roomKey` 只在 fragment；中继不落盘 |
| 会话泄露 | **结构上不存在**：房主插件不持有 `sessionController` |
| 连接劫持 | E2E + `proof = HMAC(roomKey, roomId\|nonce)` |
| 拒绝服务 | 令牌桶 + 每流窗口 + 房间 TTL |
| 流饿死 | 多路复用：大终端输出不再阻塞 fs |

> 注意：`takeover` 档下 `contains` **不生效**（用户明确选择了整机）。这是产品决策，不是漏洞。

### 12.3 吊销

```text
降档  → 下一条请求起生效
断开  → 断 WSS，终止该访客全部 pty 与 exec
关房  → 终止所有访客的一切能力
```

### 12.4 审计（借 ShellHub recording 形态）

```text
会话对象： { sessionId, actor, tier, startedAt, endedAt, recorded }
事件：     { time, method, path?, command?, bytes, result, before?, after? }
保留：     默认 14 天，到期裁剪；录制与会话行解耦（先删事件，再删会话）
```

---

## 13. 代码结构

```text
dsh-remote-workspace/
├── package.json                 # dsh.bundle.patch + dsh.client
├── cordis.patch.yml
├── icon.svg
├── locale/{en,zh}.json
├── index.js                     # Host 半边入口
├── src/
│   ├── shared/
│   │   ├── mux.ts               # 流复用（OPEN/DATA/WINDOW/CLOSE/RST/PING）
│   │   ├── protocol.ts          # 协议名常量 + zod schema
│   │   └── crypto.ts            # X25519 + AES-GCM
│   ├── tunnel/                  # 参考 shellhub agent/pkg/tunnel
│   │   ├── host-tunnel.ts       # 房主：接受 stream，按协议分发
│   │   ├── guest-tunnel.ts      # 访客：开 stream，协商协议
│   │   └── relay-client.ts      # WSS + 重连 + 心跳
│   ├── host/
│   │   ├── fs-service.ts        # /dsh/fs 处理
│   │   ├── pty-service.ts       # /dsh/pty 处理（spawnTerminal）
│   │   ├── policy.ts            # 三档 + 规则表 + contains
│   │   ├── audit.ts             # 会话对象 + 事件
│   │   └── room-server.ts       # 建房/接纳/TTL/吊销
│   └── guest/
│       ├── remote-fs.ts         # 远端 fs provider（挂给房间会话）
│       ├── remote-subprocess.ts
│       ├── tools.ts             # 仅回退方案
│       └── prompt.ts
├── client/
│   ├── index.tsx                # slot 注册
│   ├── RoomTab.tsx              # 三态
│   ├── FileTree.tsx / Editor.tsx / Terminal.tsx / ConnectPane.tsx
└── test/
```

### Config 草案

```yaml
role: both                    # host | guest | both
relayUrl: wss://room.example.com
roomTtlMs: 7200000
tier: edit                    # watch | edit | takeover
root: ''
exclude: ['.env', '.env.*', '.dsh', '**/credentials*']
exec: { enabled: false, allowlist: [] }
entry: always                 # always | when-connected
```

---

## 14. 里程碑

| 阶段 | 内容 | 验收 |
|---|---|---|
| **M0 传输 spike**（1–2 天） | ① 自写 mux 跑通：一条 WSS 上并行 3 条流；② 协议协商 `/dsh/ctl` + `/dsh/fs`；③ `wrangler dev` 起 DO；④ 跑通一次 `resolve + readText`；⑤ 中继断言零明文 | 大终端流量下 fs 请求仍即时响应；中继无明文 |
| **M1 provider 验证** | 验证 `ctx.fs` 能否在隔离 ctx 替换并与本地并存；失败则切 `room_*` | 房间会话读远端，其他会话读本地 |
| **M2 远端 fs 只读 + UI** | 右栏三态 + 文件树 + 预览 + 权限/审计骨架 | 浏览房主目录并打开文件 |
| **M3 写与审计回放** | `write`/`edit` + 版本守卫 + diff + 审计列表与回放 | 改文件可追责、可回滚 |
| **M4 终端** | `/dsh/pty` + xterm + resize + signal + 限流 | 跑 `npm test` 实时输出 |
| **M5 打磨** | CodeMirror 编辑、放大模式、入口偏好、多房间评估；可选 SSH-over-stream | 可日常使用 |

---

## 15. 测试计划

| 类别 | 用例 |
|---|---|
| mux 单测 | 多流并发、窗口耗尽、RST、单流阻塞不影响他流、半关闭 |
| 协商单测 | 未知协议 → `NOPE`；版本不匹配 → `NOPE` + 支持列表 |
| 路径策略 | `..`、绝对路径、符号链接、junction、UNC、大小写、尾随空格 |
| 权限矩阵 | 3 档 × {read, write, list, exec} × {根内, 根外, 排除项} |
| 协议单测 | 帧编解码、重放（seq）、篡改（GCM tag） |
| 一致性 | `write` 后 `read` 版本一致；`edit` 冲突 → `version-conflict` |
| E2E | 双浏览器上下文：连接 → 浏览 → 编辑 → 终端 |
| 安全 | 中继明文记录模式断言零明文；断言房主侧无 session 访问 |
| 兼容 | 与 better-sidebar 并行；禁用后不崩 |

---

## 16. 风险与未决

| # | 风险 | 处理 |
|---|---|---|
| 1 | mux 自写有正确性风险 | 先用 ShellHub/yamux 的语义做单测基准；必要时改用成熟库 |
| 2 | provider 能否隔离（同进程两套 `ctx.fs`） | M1 spike；失败切 `room_*` |
| 3 | Windows ⇄ POSIX 路径 | 一律走 `processPath`；`contains` 前做平台规范化 |
| 4 | 右栏已 17 个 Tab | 灰态轻量；label 明确；`when-connected` 偏好 |
| 5 | DO 免费额度 | M0 实测 |
| 6 | `PromptSection` 字段 | 以 `listService('systemPrompt')` 为准 |
| 7 | 大文件 / 二进制 | `readBytes(maxBytes)` + `FS_TOO_LARGE`；二进制走下载 |
| 8 | 房主无 Agent 时 PTY 泄漏 | `ctx.effect` disposer + 卸载时 `terminate()` 全部 handle |
| 9 | 多房间 | 首版单房间；协议名已支持并行 |

---

## 17. 参考

**主参考（已 clone）**
- `vendor/shellhub` — `agent/pkg/tunnel/tunnel.go`、`agent/server/server.go`、`agent/pkg/agentd/agent.go:775-794`、`server/ssh/pkg/dialer/protocols.go`、`server/api/services/firewall.go`、`server/api/services/session-recording.go`

**远程开发**
- https://code.visualstudio.com/blogs/2019/07/25/remote-ssh
- https://github.com/microsoft/vscode/tree/main/src/vs/platform/remote （MIT）

**DSH 实现（MIT）**
- `packages/fs/{fs,fs-local,fs-sandbox,tool-fs,tool-fs-search}`
- `packages/shell/{bash-local,bash-sandbox,tool-bash}`
- `packages/subprocess/{subprocess,subprocess-local}`
- `packages/terminal/{terminal,terminal-bash}`
- `packages/ssh/{ssh,fs-ssh,subprocess-ssh,sandbox-ssh,ssh-helper-runtime}`

**传输与安全**
- https://developers.cloudflare.com/durable-objects/
- https://doc.libsodium.org/

**终端与编辑器**
- https://github.com/xtermjs/xterm.js
- https://codemirror.net/
- https://github.com/mscdex/ssh2 （可选 SSH-over-stream）

---

_方案 v4。ShellHub 事实来自 `vendor/shellhub` 源码（2026-10-26，Apache-2.0）；DSH 签名、槽占用数为本机实测。标 ⚠️ 的条目需在 M0/M1 用真实环境确认。_
