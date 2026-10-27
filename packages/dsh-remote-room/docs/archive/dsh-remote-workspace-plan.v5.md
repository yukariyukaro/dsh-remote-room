# DSH 远程工作区插件 · 方案 v5

> 让 A 帮 B 修电脑：B 的 DSH 开一个房间，把「某个目录 + 可选终端」借给 A，A 用自己的 DSH 里的 agent 干活。
> 三种档位直接沿用 DSH 自己的沙箱模式名：`read-only` / `workspace-write` / `danger-full-access`。

---

## 0. 一页速览

### 0.1 它是什么

一个 DSH 插件，装在两台机器上：

- **房主（能上网、被求助的一方）**：选一个目录，选一个档位，点「开房」。插件开一条**出站** WSS 连接到中继，不监听任何端口。
- **访客（帮忙的一方）**：拿到邀请链接，粘进 DSH。右栏出现一个 tab，能看文件树、读文件、改文件；档位是 `danger-full-access` 时还能开终端。
- **agent 在访客这边**。房主不跑 agent、不跑会话、不开 Web UI，只提供能力。

### 0.2 决策表

| # | 决策 | 理由 |
|---|---|---|
| D1 | 房主只提供能力：文件、终端、审计。无 agent、无会话、无 Web UI | 公开 Web 端不可行；agent 属于访客 |
| D2 | agent 跑在访客的 DSH 里 | 访客的模型、访客的 API key、访客的上下文 |
| D3 | 入口是右栏 tab，不是主页面 | 不抢占 `main`；不开会话时不出现可接受 |
| D4 | 复用 DSH 的权限**词汇**（三个模式名）与**执行机构**（`fs-sandbox`） | 见 §4；审批除外，那个要 agent，见 §4.5 |
| D5 | 房主不监听任何入站端口，只开出站 WSS | NAT / 无公网 IP / 无管理员权限 |
| D6 | 中继默认 Cloudflare Workers + DO，一房间一；**relay 地址可配置** | 零运维；DO 天然是房间的消息总线；换中继不改协议，见 §3.4 |
| D7 | 传输 = 一条 WSS + 自写多路复用 + 命名协议 | ShellHub 的结构，见 §2.2 |
| D8 | 加密端到端，中继只转发密文 | 房主不该因为用了别人的中继就信任它 |
| D9 | 房间是一个 **agent preset**：在隔离 realm 里换掉 `ctx.fs` / `ctx.subprocess`，`tool-fs` / `tool-bash` 原样复用，**零工具开发** | 见 §5.1；模型继续用 `read`/`write`/`bash`，不学新工具 |
| D10 | 房主的终端用 `ctx.subprocess.spawnTerminal` 开在房主机器上 | `ctx.terminals` 要 Agent，房主没有 Agent |
| D11 | 审计 = 会话对象 + `before`/`after` 快照，可回放 | 借 ShellHub recording 的形态 |
| D12 | `workspace-write` 档**不含**命令执行 | 不是安全策略取舍，是这一档物理上做不到，见 §4.4 |

### 0.3 v4 → v5 改了什么

| 项 | v4 | v5 |
|---|---|---|
| 档位 | 自造 `watch` / `edit` / `takeover` | **直接用 DSH 的 `read-only` / `workspace-write` / `danger-full-access`** |
| 权限判定 | 自写 `guard()` 四分支 | 委托给房主的 `ctx.fs`（`fs-sandbox`）+ 一条自写读边界 |
| 入房授权 | 自写对话框 | 抄 DSH 的 `allowed-once` 语义；实现只能自写，见 §4.5 |
| 工具接入 | 首选换 provider，回退 `room_*` | **房间 = preset，换 provider，零工具**（回到 v4 §8.1；v5 初稿误降级为 `room_*`，已推翻） |
| 文档 | 909 行 / 17 节 | 本文件；把「为什么」压实成表，删掉重复论证 |
| 技术栈 | 散落各处 | 独立成 §1 |

---

## 1. 技术栈

### 1.1 语言与构建

| 项 | 选择 | 说明 |
|---|---|---|
| 语言 | **TypeScript**，ESM only，`"type": "module"` | DSH 全家桶都是 ESM；CJS 混入会撞 Loader |
| 打包 | **`tsdown`** | `dsh-context`、`dsh-better-sidebar` 都用它，产物是单文件 `lib/index.js` |
| 包形态 | **单包双入口** | `main: lib/index.js`（host）+ `./client`（web），照 `dsh-context` |
| 类型检查 | `tsc --noEmit`，`strict: true` | 不产出 `.d.ts` 也能跑，但建议保留 `types` 供别人引用 |
| 测试 | `vitest` | 同生态；传输层与 mux 必须有单测 |
| Node | ≥ 22.19（开发机实测 24.21） | 依赖全局 `WebSocket` |

包清单必须包含 DSH 认的 `dsh` 字段：

```json
{
  "type": "module",
  "main": "lib/index.js",
  "exports": { ".": "./lib/index.js", "./client": "./lib/client.js" },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "inject": ["@deepseek-ai/dsh-client-locale",
                 "@deepseek-ai/dsh-client-ui-slots",
                 "@deepseek-ai/dsh-client-ui-sidebar-right",
                 "@deepseek-ai/dsh-client-ui-primitives"]
    }
  }
}
```

`inject` 里的包由宿主在运行时提供，**不要打进 bundle**——它们是 peer。

### 1.2 外部依赖

**运行时依赖：1 个。**

| 需要什么 | 用什么 | 依赖成本 |
|---|---|---|
| WebSocket 客户端 | **Node 24 全局 `WebSocket`**（undici） | 0 |
| 端到端加密 | `node:crypto`：X25519 + HKDF + AES-256-GCM | 0 |
| 多路复用 | **自写**，约 60–80 行，帧头 8 字节，无窗口 | 0 |
| PTY | 房主 `ctx.subprocess.spawnTerminal` | 0（不用 node-pty） |
| 文件读写 | 房主 `ctx.fs`（`fs-local` + `fs-sandbox`） | 0 |
| **fs / bash 工具** | **复用 `tool-fs` / `tool-bash`**，在房间 preset 里挂载 | 0（见 §5） |
| 协议/Config 校验 | **`@deepseek-ai/schemastery`** `~3.18` | 1 个 |
| 中继 | Cloudflare Worker + DO | 0（`wrangler` 只在部署期用） |

选 `schemastery` 而不是 `zod`：Cordis 的 `Config` 本来就是 schemastery，再引一套 zod 等于两套校验器并存。

**peerDependencies（宿主提供，不打包）**：`@deepseek-ai/cordis`、`dsh-fs`、`dsh-subprocess`、`dsh-sandbox-policy`、`dsh-user-approval`、`dsh-tools`、`dsh-session`，以及 4 个 `dsh-client-ui-*`、`react@18`、`react-dom@18`。

**devDependencies**：`typescript`、`tsdown`、`vitest`、`@types/node`、`@types/react`、`@types/react-dom`，以及上面那些 `@deepseek-ai/dsh-*`（装 npm `next` tag，与桌面版 `0.2.1-rc.x` 对齐）。

**不引入**：`ws`（有全局 WebSocket）、`ssh2`（见 §2.3）、`node-pty`（房主已有 PTY 服务）、`zod`（见上）、CodeMirror（v1 用只读渲染，编辑器延后）。

### 1.3 参考实现对照表

写代码时对着这些抄形状，不要自己发明：

| 要写的东西 | 参考 | 抄什么 |
|---|---|---|
| 远端 fs provider | `packages/ssh/fs-ssh` | 路径是**远端坐标**不是本地句柄；`processPathFromHostPath()` 返回 `undefined`；单次读 8 MiB 上限；不实现 `watch()` |
| 远端子进程 / 终端 | `packages/ssh/subprocess-ssh` | 终端句柄的生命周期、控制流、取消 |
| 权限 | `packages/fs/fs-sandbox`、`packages/sandbox/sandbox-policy` | 模式词汇、`SandboxExecutionPolicy` 字段、拒绝码 |
| 一次性授权 | `packages/interaction/user-approval` | `allowed-once` 语义；它的 `request()` 要 Agent + turn，房主没有，见 §4.5 |
| fs 工具 | `packages/fs/tool-fs`、`tool-fs-search`、`tool-str-replace-editor` | **不抄，直接复用**：挂在房间 preset 里，只换它脚下的 `ctx.fs` |
| preset 隔离机制 | `packages/preset/agent-preset-registry`（README + `src/mount.ts`） | 一个 preset = 一棵隔离 Loader 树；provider 与 consumer 必须在同一 group |
| 插件骨架 | `dsh-context`（第三方单包双入口） | `tsdown` 配置、`dsh` 字段、`exports` |
| 右栏 tab | `dsh-better-sidebar` | tab 注册方式；并把它当兼容对象，见 §7 |
| 连接 / 重连 / 隧道 | `open-remote-ssh` | 见 §2.1 |
| 反向隧道 + 协议名 | ShellHub | 见 §2.2 |

---

## 2. 参照物：各抄什么

### 2.1 open-remote-ssh（最贴近我们的 TypeScript 实现）

`jeanp413/open-remote-ssh` 是 VS Code Remote-SSH 的开源平替，纯 TS，`webpack` 打包。读过源码后，值得抄和不值得抄都很清楚：

**值得抄的：**

- **隧道就是一个本地 TCP 监听器**：`net.createServer()` 监听 `127.0.0.1:0`，每条 socket 调 `forwardOut()` 拿一条 SSH 通道，然后双向 `pipe`。VS Code 只认「本地端口」，插件就给它一个端口。
  → 我们不需要 TCP 端口（fs/pty 走自己的 RPC），但**同样的手法可以用在 `sock:` 直连上**：sshs 家族要的是 duplex stream，我们的 mux 流可以直接喂进去，不用中转端口。
- **重连策略**：`close` 事件里判断 `retries <= tries && err.level !== 'client-authentication' && err.code !== 'ENOTFOUND'` 才退避重连。**认证失败不重连**——这条我们也要有：房间被撤销后不能死循环。
- **`execChannel()` 不分配 PTY**，所以写进去不会有本地回显。我们的 `pty` 流（要 PTY）与一次性命令（不要 PTY）照这个划分。

**不值得抄的（也是我们不做 SSH 的原因）：**

- `authResolver.ts` **46 KB**，占整个插件源码的三分之一。它要处理 `~/.ssh/config`、密钥口令、keyboard-interactive、known_hosts 校验、跳板机。我们一个邀请链接 + ECDH 全部绕开。
- `serverSetup.ts` + `fetchRelease.ts` **约 23 KB**，负责在远端下载安装 VS Code Server、校验 commit、匹配版本、失败重装。**我们没有这一步**——房主的 DSH 本来就在跑。
- 它仍然**必须有远端 sshd**：配置文件里写着 `AllowStreamLocalForwarding`，说明它依赖服务端的端口转发能力。它只替换了客户端，从不替换服务端。

### 2.2 ShellHub（反向隧道与协议名）

`shellhub-io/shellhub`，Go，Apache-2.0。抄三个概念，不抄代码：

- **设备不监听端口**：设备端跑一个 gliderlabs/ssh 实例但**从不 `Listen`**，拿到隧道连接后直接 `sshd.HandleConn(conn)`。这就是「零入站」的标准做法。
- **按流协商协议名**：`/ssh/open/1.0.0`、`/ssh/close/1.0.0`、`/http/proxy/1.0.0`，注释明确写着「改一个字符就是线上不兼容变更」。**协议名自带版本**，比在 payload 里加 `version` 字段更硬。
- **一个流一个用途**：SSH、HTTP 代理、SFTP 各占一条流，互不阻塞。这就是我们「大终端流量下 fs 请求仍要即时响应」的依据。

底层它用的是 `hashicorp/yamux v0.1.2` + `go-multistream v0.6.1`。我们不复用 yamux（Go），**也刻意不抄它的窗口流控**——窗口是在「只能靠协议自己管背压」时才需要的，而我们的终端源是 `Readable`，`pause()` 更直接，见 §3.5。

### 2.3 为什么不用 ssh2

| 方案 | 卡在哪 |
|---|---|
| `ssh2`（Node） | 需要**服务端**。房主没有可达的 sshd，也没有管理员权限开端口。要自建 sshd 就得自己实现服务端 + 认证 + 通道，比自写 mux 更大 |
| 自建 sshd 跑在隧道里 | = 自己写 SSH 服务端。认证、算法协商、通道、PTY 请求全部重来 |
| Teleport / Coder | 一整套集群（CA + proxy + auth），许可证也挡着 |
| ShellHub 代码 | Go，且是 Kubectl 式的设备管理产品，我们要的是房间 |

**结论**：SSH 是「两台机器互信之后的通用底座」，我们不缺通用底座——我们缺的是一条能穿过 NAT、能带版本号、能审计的**能力通道**。mux 60 行就够。

什么时候再上 ssh2：当有人想让标准 `ssh` 客户端直连房间时。届时把 mux 的一条流喂给 ssh2 的 `sock:` 即可，fs 协议不动。

---

## 3. 架构

### 3.1 拓扑

```
房主 DSH ──插件──┐
                 │ 出站 WSS（唯一方向）
                 ▼
        Cloudflare Worker ──► Durable Object「房间」
                 ▲                     │
                 │ 出站 WSS            │ 只转发密文帧
                 └─────────────────────┘
                 ▲
访客 DSH ──插件──┘  右栏 tab + 房间 preset + agent
```

一条 WSS 里跑多路复用，每一路是一个**命名协议**：

```
/dsh/ctl/1.0.0    握手、授权、心跳、撤销
/dsh/fs/1.0.0     结构化文件 RPC（JSON）
/dsh/pty/1.0.0    终端字节流
/dsh/audit/1.0.0  房主 → 访客的单向审计流
```

命名协议的价值：访客和房主版本不一致时，能同时提供 `1.0.0` 和 `1.1.0`，按名字选交集，而不是靠 payload 里的版本字段猜。

### 3.2 房主侧零部署（相对 SSH 家族的关键便宜）

DSH 已经有完整的远端能力家族 `packages/ssh/`：`ssh`（连接）、`fs-ssh`（`ctx.fs`）、`subprocess-ssh`（`ctx.subprocess`）、`sandbox-ssh`（`ctx.sandbox`）、`ssh-helper-runtime`（**给没装 Node 的远端机器用的预编译 helper**）。

它的做法是：远端机器上跑 helper 二进制，helper 内部就是 `fs-local` + `fs-sandbox`。

**我们的远端不需要 helper。** 房主的 DSH 就是那台「远端」——`fs-local`、`fs-sandbox`、`spawnTerminal` 全都已经在他进程里跑着了。所以：

| | SSH 家族 | 我们 |
|---|---|---|
| 远端要装什么 | helper 二进制（多平台分发） | **什么都不用装**，DSH 已在跑 |
| 远端 node | 不需要（helper 预编译） | 有（就是 DSH 本身） |
| 认证 | 密钥 / 口令 / known_hosts | 邀请链接里的房间密钥 |
| 入站 | 要 sshd | 零入站 |
| 版本匹配 | helper 与客户端要匹配 | 协议名带版本 |

代价：房主必须装我们这个插件，且 DSH 必须在运行。这跟 Remote-SSH 要求 sshd 常驻是同一类约束。

### 3.3 「两边都起服务」的问法

不需要额外进程。两个「服务」就是两个**已经在跑的 DSH 进程里的插件**：

- 房主侧：注册一个房间服务，出站连中继，收到请求就调本机 `ctx.fs` / `ctx.subprocess`。
- 访客侧：注册右栏 tab + 一个房间 preset（在隔离 realm 里换掉 `ctx.fs` / `ctx.subprocess`），出站连中继。

### 3.4 不走 SSH，那走什么

一句话：**一条出站 WSS + 自写多路复用 + 命名协议 + 端到端加密**。

SSH 替我们做的事就五件，逐条对上：

| SSH 的职责 | 我们的替代 | 说明 |
|---|---|---|
| 加密传输 | X25519 ECDH → HKDF-SHA256 → AES-256-GCM，AAD = `roomId \| direction \| seq` | 中继只转发密文 |
| 身份认证 | 邀请链接里的 `roomKey`（URL fragment）+ 房主手动确认 | 没有密钥/口令/known_hosts，一次性、可撤销 |
| 多路复用 | 自写 mux：8 字节帧头，无窗口（背压走 `pause()`） | 约 60–80 行，不引 SSH 通道栈 |
| 通道协商 | 命名协议 `/dsh/{ctl,fs,pty,audit}/1.0.0` | 名字带版本，比 payload 里的版本字段硬 |
| PTY | 房主 `ctx.subprocess.spawnTerminal`，字节流走 `/dsh/pty` | 终端是房主 OS 的事，协议层不实现 |
| 端口转发 | **不需要** | 我们不隧道 TCP，直接发结构化 RPC |

关键差别不是「更轻」，是**数据面形态不同**。SSH 传的是终端字节流 + SFTP 文件块，我们传的是 `{ method, path, args }`：

- 权限判定需要**结构化路径**——房主要对 `path` 跑 `contains()`，字节流里做不到；
- 审计需要 `before` / `after` 快照——SFTP 的 write 只有字节，没有原文；
- 版本演进需要对**方法**协商，而不是对通道协商。

握手全流程：

```
访客                          中继(DO)                         房主
 │  WSS(roomId)  ───────────►  │  ◄───────────  WSS(roomId)
 │  ctl:hello {v, nick}        │                 ctl:hello {v, nick}
 │                             │  配对（房主在线才放行）
 │  ctl:auth {HMAC(k, nonce)}  │  ← 中继看不到明文
 │  ◄──────────────────────────────  ctl:grant {tier, root}
 │  OPEN /dsh/fs/1.0.0 …
```

**传输可替换。** mux 之上不知道自己在什么管道里跑，只要给一条双向字节流。所以中继三选一：

| 中继 | 何时用 |
|---|---|
| Cloudflare DO（默认） | 零运维；一房间一 DO 天然是消息总线 |
| 自建 ~60 行 Node WS 转发 | Cloudflare 在境内不稳时；同一接口，换 URL 即可 |
| WebRTC DataChannel | 以后想 P2P 不经中继；mux 完全不动 |

因此 API 必须是 `connect({ relayUrl, roomId, roomKey })`——**relay 地址是配置，不是编译期常量**。

心跳 25s 一次 `PING`，两次不回判死。重连用指数退避 + 抖动，**认证失败不重连**（照 open-remote-ssh 的判据）。流不跨连接恢复：`pty` 断了就 `RST`，UI 显示「已断开」，不假装连续。

### 3.5 WSS 够不够：四个维度

「SSH 更成熟」这个直觉是对的，但要看成熟度花在哪。**SSH 值得抄的是设计，不是实现**；而且我们真正需要的终端语义（PTY 分配、`resize`、前台进程组信号、活动观察、会话回收）已经在 DSH 的 `spawnTerminal` 里了，不需要复刻 SSH 的 `pty-req` + `channel` 那一套。SSH 另外 90% 的成熟度花在我们用不到的地方：agent forwarding、端口转发、X11、SCP、密钥与 known_hosts 管理。

| 维度 | 判断 | 依据 |
|---|---|---|
| 帧切分正确性 | **够** | TCP 之上有序可靠；单条消息 ≤ 1 MiB（Cloudflare 上限），DATA 帧 64 KiB |
| 背压 / 流控 | **够，且比窗口简单** | `output` 是 `Readable`，`pause()` 就是真背压，不用手写 WINDOW 记账 |
| 吞吐 | **够** | 终端典型几十 KB/s；fs 单次 8 MiB，分页即可 |
| **延迟** | **这是真短板** | 多一跳中继。境内走 Cloudflare 时 RTT 可能 100–300ms，终端手感会明显变钝 |

延迟这一条不能靠论证解决，只能靠**测量**。所以 M0 的验收加两条硬指标：

1. 经中继的 RTT（境外 DO 与自建 Node 转发各测一次）；
2. 终端刷屏时 `read` 工具的 p95 延迟。

**任一项超标就上直连**，而不是继续优化中继：传输层抽象成 `{ send(frame), onFrame, close }`，先跑 WSS，之后加 WebRTC DataChannel（STUN 打洞、TURN 兜底），mux 与协议一行不改。

> 一个反直觉的结论：如果哪天房主自己有公网 IP 且愿意开 sshd，SSH 直连确实会更好（低延迟、成熟）。但那是个**可选加速路径**，不是底座——让普通用户为修个软件去配 sshd，本末倒置。

---

## 4. 权限：复用 DSH，只补一条

### 4.1 直接沿用 DSH 的模式名

| 档位 | 能做什么 | 谁能兜底 |
|---|---|---|
| `read-only` | 读房间目录内 | 我们（读边界） |
| `workspace-write`（默认） | 读 + 写房间目录内 | `fs-sandbox` 围写，我们围读 |
| `danger-full-access` | 整机读写 + 执行 | 无——这就是一次 SSH 登录 |

房主在自己 DSH 里本来就见过这三个词（`/permission` 命令、设置里的 Permissions 选择器）。**不要发明新词**。

### 4.2 DSH 已经有什么（全都已经装在用户机器上了）

| 层 | 包 | 能力 |
|---|---|---|
| 模式词汇 | `dsh-sandbox` | `SandboxMode = 'read-only' \| 'workspace-write' \| 'danger-full-access'` |
| 策略解析 | `dsh-sandbox-policy` | `resolve()` → `{ mode, workspaceRoot, additionalWritableRoots?, sessionId? }` |
| fs 写围栏 | `dsh-fs-sandbox` | 拒绝返回 `FS_SANDBOX_DENIED`，工具渲染成 `[sandbox: file access denied under <mode> mode]` |
| 命令围栏 | `dsh-bash-sandbox` + `ctx.sandbox.confine()` | bwrap / Landlock / Seatbelt / Windows ACL 受限令牌 |
| 一次性授权 | `dsh-user-approval` | `approval/request` waterfall → `allowed-once \| rejected \| cancelled \| unavailable`（**要 agent + turn，房主用不了**，见 §4.5） |
| 用户开关 | `dsh-permission-presets` | 把沙箱模式与审批策略捆成预设，`/permission` 切换 |

房主的房间策略因此就是一份 DSH 的 `SandboxExecutionPolicy`：

```ts
const policy = {
  mode: room.tier,                    // 就是 DSH 的 SandboxMode
  workspaceRoot: room.root,           // 共享的那个目录
  additionalWritableRoots: room.extra, // 可选
}
```

写请求原样转给房主的 `ctx.fs`，`fs-sandbox` 自己会拦。我们**不重复实现写围栏**。

### 4.3 我们只写这一条检查

`fs-sandbox` 明确**只围写不围读**（原文：「读取、列出、元数据操作与只读监听均与 `fs-local` 完全一致」）。而房间是**目录共享**，读也必须围：

```ts
async function assertInside(room: Room, target: string) {
  if (room.tier === 'danger-full-access') return            // 整机
  const [root, file] = await Promise.all([
    ctx.fs.resolve(room.root),
    ctx.fs.resolve(target),
  ])
  if (!ctx.fs.contains(root, file)) throw RoomOutsideRoot(room.root, target)
}
```

`contains(parent: FsTarget, child: FsTarget)` 收的是**已解析的 `FsTarget`**，不是字符串，所以要先 `resolve()`。两次 resolve 意味着**每次读两次远端往返**——可以按 `room.root` 缓存根句柄，只剩一次。

就这一条。约 20 行，挂在远端 fs 的 `readText` / `list` / `stat` 上。

`workspace-write` 下的写由 `fs-sandbox` 兜，我们的读边界让语义**比 DSH 的同名模式更严**（DSH 的 `workspace-write` 允许读整台机器）。这个偏差要在设置页写清楚。

### 4.4 为什么 `workspace-write` 不含执行

不是取舍，是这一档做不到：

- DSH 的 `workspace-write` 用内核机制**兜写**（bwrap 只读绑定、Landlock、Seatbelt），能拦住 `rm -rf /`。
- 但它**不兜读**。文档原话：`Network and process visibility are outside this vocabulary`。
- 一个能执行任意命令的 shell，读整台机器是免费的：`~/.ssh/id_rsa`、浏览器 cookie、环境变量里的 API key。再往外发一条 `curl` 就出去了。

**能执行的 shell = 能读完 + 能外带**。所以执行只能是 `danger-full-access`。

想将来在受限档里给执行，必须自己做「只读绑定共享目录」的 runner，而不是复用 `bash-sandbox` 的默认 profile。v1 不做。

### 4.5 入房授权：想复用审批，但用不了

第一反应是复用 `ctx.userApproval`：一次 `allowed-once`，跟房主平时点「允许一次」是同一个控件、同一套文案、同一份审计事件。

**但它的 `request()` 要求一个 Agent 和打开的 turn**：

```ts
async request(req: ApprovalRequest): Promise<ApprovalOutcome> {
  const session = req.agent.session
  if (!this.approvalStateOf(session).turnOpen) throw new Error(
    'approval.request() outside an open turn: … must be turn-enclosed …')
```

理由是审批必须写成 `approval/asked` + `approval/decided` 一对事件进会话日志，而一对事件必须被 turn 的提交边界包住。

而房主按 D1 **不跑 agent**，开房那一刻也不会有 turn。所以这条直接用不了。

**结论：用我们自己的确认 UI**（右栏 tab 里的一张确认卡片），决定写进房间审计流。审批的**语义**照抄 DSH——只给一次、失败即拒、随时可撤销——但不复用它的实现。

> 如果哪天房主侧确实有了 agent 会话，再切回 `ctx.userApproval`，那时的审计链路是免费的。

### 4.6 刻意不做

规则引擎 / RBAC / 多租户；逐动作审批；合规报告；录像式审计；网络与进程隔离（`SandboxMode` 的词汇里就没有这些）。

---

## 5. 能力复用：房间是一个 preset

### 5.1 结论先行：零工具开发

**这不是新决定。** v4 的 §8.1 标题就叫「首选：换 provider，不加工具」，并且已经点了「隔离 ctx（或 agent preset）」。是 v5 初稿把它降级成了回退项——那是一次退步，现在恢复。

放弃 `room_read` / `room_write` / `room_bash` 一族工具的理由不是「多写几个文件」：

- 工具名换了，模型要重新学一套——它熟的是 `read` / `write` / `edit` / `bash`；
- 丢掉 `tool-fs` 的过期检测、观察策略、diff 呈现、沙箱升级提示；
- 丢掉 `tool-bash` 的输出 spill、后台任务、`sandboxMode` 协商；
- 上游每改进这两个工具一次，我们就要手工追一次。

DSH 里已经有现成答案：**agent preset**。

`dsh-agent-preset-registry` 的机制（原文）：

- 每个 preset 声明一组 `plugins`，启动时创建**注册表拥有的 scope 和内存 Loader 树**；
- 「preset 的服务提供方及其消费方必须共享同一个 `cordis:group` 隔离 realm」；
- 「Agent loop 仍由宿主共享」。

翻一下就是：**在隔离 realm 里把 `ctx.fs` / `ctx.subprocess` 换成房间实现，再把 `tool-fs` / `tool-bash` 原样挂进去**。模型看到的仍然是 `read` / `write` / `bash`，但这些工具读写的就是房主的文件系统。

开关是 `ctx.isolate(name)`。DSH 自己在子 agent 里已经这么用：`childCtx.isolate('workingDirectory')`。

### 5.2 房间 preset 的组成

```yaml
- id: preset-room
  name: '@deepseek-ai/dsh-agent-preset'
  config:
    id: room
    plugins:
      - name: cordis:group
        config:
          isolate: [fs, subprocess, shell, workingDirectory]
          plugins:
            - '@dsh-remote-room/provider-fs'            # 我们写
            - '@dsh-remote-room/provider-subprocess'    # 我们写
            - '@deepseek-ai/dsh-sandbox-policy'
            - '@deepseek-ai/dsh-shell'
            - '@deepseek-ai/dsh-bash-local'             # inject = ['subprocess'] → 自动变远端
            - '@deepseek-ai/dsh-tool-fs'
            - '@deepseek-ai/dsh-tool-fs-search'
            - '@deepseek-ai/dsh-tool-str-replace-editor'
            - '@deepseek-ai/dsh-tool-bash'
            - '@deepseek-ai/dsh-working-directory'
```

（`group` / `isolate` 的确切 YAML 方言以 `cordis-composition-reference` 为准，这里只表达结构。）

三个关键事实：

1. **`bash-local` 是 `static inject = ['subprocess']`** —— bash 执行器建立在 `ctx.subprocess` 之上。换掉 subprocess，bash 自动变远端，**一行 executor 都不用写**。
2. **`tool-bash` 的 inject 是 `['tools','shell','systemPrompt','shellEnv','workingDirectory']`** —— 全都能在 realm 里提供。
3. **`tool-fs` 只认 `ctx.fs`** —— 它不知道自己是本地还是远端，这正是我们要的。

**上游明确警告**：「条目局部隔离不沿 Agent 注册 scope 传播：组外的普通 Context 查找（包括 `agent.ctx`）仍选择 Host realm。」所以 provider 和 consumer **必须写在同一个 group 里**；漏一个，工具就会静默拿到宿主的 fs。

### 5.3 我们要写的 provider

| provider | 实现 | 规模 |
|---|---|---|
| `provider-fs` | `ctx.fs` 远端实现，继承 `FileSystem` 基类；照 `fs-ssh` 写 | **≈120 行**——`fs-ssh` 全文 107 行，13 个方法每个就是一行 `this.call('fs.xxx', …)` 转发 |
| `provider-subprocess` | `ctx.subprocess` 远端实现，`spawnTerminal` 转发到房主 | ≈250 行（`subprocess-ssh` 17 KB，含进程句柄、终端、信号） |
| `provider-sandbox` | 可选。`danger-full-access` 直通；受限档要给 exec 才需要 | 小 |

`watch()` 不覆写——基类默认以 `FS_IO_ERROR` 拒绝，和 `fs-ssh` 一致。`contains` 也不用往返：`fs-ssh` 用 `posix.relative` 在本地算，我们也一样。

这才是真实工作量：**两个 provider 约 400 行，不是六个工具**。而且 `ctx.fs` 一写完，右栏文件树、`edit` 的 stale 检测、`grep`、diff 展示全部免费。

### 5.4 为什么不是直接用 `fs-ssh`

既然 DSH 已经有 `fs-ssh` / `subprocess-ssh` / `sandbox-ssh`，能不能直接挂上去？查过之后答案是**不能，但原因不是"我们用了 WSS"**。

先澄清一件事：**远端 fs provider 这笔开销跟传输方式无关**。DSH 自己为了 SSH 也写了这一份——换成任何传输都要有人当那个"client 半边"。

真正卡住的是这两条：

| 障碍 | 事实 |
|---|---|
| `dsh-ssh` 要真的 sshd | 它 `spawn` 用户的 OpenSSH 客户端（Config 是「OpenSSH host alias」），再用**本地 stream socket**（`createConnection({ path })`）接转发通道。房主没有可达 sshd，这条就断 |
| 远端要装 helper 二进制 | `ssh-helper-runtime` 是预编译可执行文件，装到远端后客户端会 `sha256` 校验摘要（`helper.ts`：`Installed entry whose digest is compared by the client`）。这正是 VS Code Server 那一套 bootstrap——我们方案里最想省掉的一步 |

而 helper 干的事，房主的 DSH 本来就在干（`fs-local` + `fs-sandbox` 已经在他进程里）。**所以我们要写的不是 `fs-ssh` 的替代品，而是一条通往已在运行的服务的最薄适配层。**

> 唯一的白拿路径：房主侧内嵌一个 `ssh2` 的 **Server**（不 `Listen`，直接喂我们的 mux 流），隧道里跑真 SSH，然后 `fs-ssh`/`subprocess-ssh`/`sandbox-ssh` 原样复用。代价是仍要部署 helper、多一层协议栈、以及要给房主开一个 loopback 入口。列为 §9 的可选后续，不进 v1。

### 5.5 终端开在房主

房主侧用 `ctx.subprocess.spawnTerminal(spec)`：它**不要求 Agent 作用域**，直接返回 `{ pid, output, write, resize, inspectForeground, signalForeground, terminate, done }`。

不能用 `ctx.terminals.spawn(owner: Agent, …)`——它要一个 Agent，而房主**故意不跑 agent**（D1）。这是 v3 里写错、v4 修正的点。

终端字节流走 `/dsh/pty/1.0.0` 独立流，和 fs 的 JSON-RPC 互不阻塞。

`output` 是 `Readable`、`write` 收 `string`（文本语义）——这两条决定了背压与切分方式，见 §3.5 与 §6.1。

### 5.6 文件树与模块划分

```
dsh-remote-room/
├── package.json                     dsh.bundle.patch / dsh.client.inject / 双入口 exports
├── cordis.patch.yml                 安装时注入：房间服务 + 房间 preset 定义
├── tsdown.config.ts
├── tsconfig.json
├── src/
│   ├── index.ts                     host 入口：Config 校验、服务注册、preset 生成
│   ├── config.ts                    relayUrl / 房间根 / 默认档位 / 心跳与上限
│   ├── types.ts                     纯类型：RoomMode、RoomGrant、帧、协议消息
│   │
│   ├── room/
│   │   ├── room.ts                  房间状态机：idle → hosting → joined → closed
│   │   ├── grant.ts                 档位 → SandboxExecutionPolicy（复用 DSH 字段）
│   │   ├── invite.ts                邀请链接编解码（roomId + roomKey，key 在 fragment）
│   │   ├── keys.ts                  X25519 ECDH + HKDF + AES-256-GCM
│   │   └── audit.ts                 before/after 采集 + 环形缓冲
│   │
│   ├── transport/
│   │   ├── transport.ts             抽象：send(frame) / onFrame / close
│   │   ├── ws.ts                    WSS 客户端：连接、25s 心跳、退避重连、认证失败不重连
│   │   ├── mux.ts                   8 字节帧头、streamId 路由、UTF-8 码点边界切分
│   │   └── negotiation.ts           命名协议版本取交集
│   │
│   ├── protocol/
│   │   ├── ctl.ts                   hello / auth / grant / ping / revoke
│   │   ├── fs.ts                    方法表 + schemastery 校验
│   │   ├── pty.ts                   终端流控制帧
│   │   └── audit.ts                 单向追加
│   │
│   ├── host/                        房主侧（把请求落到本机能力上）
│   │   ├── serve.ts                 分发 → ctx.fs / ctx.subprocess
│   │   ├── fence.ts                 assertInside：唯一的读边界（§4.3）
│   │   ├── fs-handler.ts            各 fs 方法的房主实现
│   │   └── pty-handler.ts           spawnTerminal + bufferedAmount 背压
│   │
│   ├── guest/                       访客侧（把远端伪装成本地）
│   │   ├── provider-fs.ts           ctx.fs 远端实现（继承 FileSystem 基类，照 fs-ssh）
│   │   ├── provider-subprocess.ts   ctx.subprocess 远端实现
│   │   ├── provider-sandbox.ts      可选：受限档的远端委托
│   │   └── preset.ts                生成 §5.2 那份房间 preset 的插件行
│   │
│   └── client/                      Web 端
│       ├── index.ts                 tab 注册
│       ├── state.ts                 连接状态 / 房间列表
│       ├── panel/
│       │   ├── RoomPanel.tsx        三态外壳（§7）
│       │   ├── FileTree.tsx         目录树
│       │   ├── Preview.tsx          只读预览
│       │   └── TerminalPane.tsx     xterm 挂载
│       ├── HostCard.tsx             开房 / 选档位 / 复制邀请链接
│       ├── GrantCard.tsx            访客入房确认
│       └── locale.ts                文案字典
│
├── relay/                           独立部署，不进插件包
│   ├── wrangler.toml
│   └── src/
│       ├── worker.ts                路由 + WebSocket 升级
│       └── room.ts                  Durable Object：配对、转发、TTL
│
└── tests/
    ├── mux.spec.ts                  分片 / 半包 / UTF-8 边界 / 并发开流
    ├── keys.spec.ts                 密钥派生向量
    ├── fence.spec.ts                越界拒绝
    ├── transport.spec.ts            重连 / 心跳 / 认证失败不重连
    └── provider-fs.spec.ts          对假 host 的完整往返
```

| 模块 | 对着参考仓库看哪儿 |
|---|---|
| `guest/provider-fs.ts` | `packages/ssh/fs-ssh/src`、`packages/fs/fs/src/index.ts`（基类与 `contains`） |
| `guest/provider-subprocess.ts` | `packages/ssh/subprocess-ssh/src`、`packages/subprocess/subprocess/src/types.ts` |
| `host/fs-handler.ts` | `packages/fs/fs-local/src`（stale 检查、原子写、diff 基线） |
| `host/pty-handler.ts` | `packages/subprocess/subprocess/src/index.ts`（`spawnTerminal`） |
| `host/fence.ts` | `packages/fs/fs-sandbox/src/containment.ts` |
| `transport/mux.ts` | `reference/shellhub`（协议名与流）、`reference/open-remote-ssh`（重连判据） |
| `relay/room.ts` | Cloudflare DO WebSocket Hibernation 文档 |

**开发顺序**（与里程碑对齐）：`transport` → `protocol` → `host` → `guest/provider-fs` → `guest/preset` → `client` → `host/pty-handler`。

---

## 6. 协议 v1

### 6.1 流与帧

一条 WSS，握手后按名字开流。帧头 8 字节：`type(1) | streamId(3) | length(4)`，大端。

类型：`OPEN / DATA / CLOSE / RST / PING`。**不设窗口**——背压不靠协议层流控，见 §3.5。

DATA 帧上限 64 KiB。切成 64 KiB 时必须在 **UTF-8 码点边界**回退，否则中文会被劈开。`spawnTerminal` 的 `output` 和 `write` 都是文本语义（`write(data: string)`），所以这条是硬要求，不是优化。

加密：X25519 ECDH → HKDF-SHA256 → AES-256-GCM。AAD = `roomId | direction | seq`，防重放与跨流拼接。`roomKey` 只出现在邀请链接的 URL fragment 里（不进 Referer、不进服务器日志）。

### 6.2 方法

`fs` 流的方法表**就是 `FileSystem` 基类的 13 个抽象成员**，不多不少——因为 `provider-fs` 继承它，缺一个编译不过：

| 流 | 方法 | 备注 |
|---|---|---|
| `ctl` | `hello` / `auth` / `grant` / `ping` / `revoke` | `grant` 返回生效档位与目录 |
| `fs` | `resolve` / `processPath` / `fileUrl` / `contains` / `stat` / `lstat` / `readText` / `streamText` / `readBytes` / `readByteRange` / `listDir` / `writeText` / `editText` | JSON；路径是**房主坐标**，访客不得解释 |
| `pty` | `open` / `data` / `resize` / `signal` / `close` | 字节流 |
| `audit` | 单向追加：`{ts, op, path, before, after, result}` | 房主写，访客读 |

`processPath` / `fileUrl` 在房主侧计算（访客侧无从得知真实路径），`contains` 由房主侧判定——这三个方法划清了「路径是坐标不是句柄」这条线（`fs-ssh` 同款处理）。

**`ctx.fs` 里没有 `remove` / `rename` / `mkdir`。** 已核对基类，13 个抽象成员全是读、写、改、观察。这意味着：

- `workspace-write` 档天然是「能改不能删」——删文件只能走 bash，也就是只有 `danger-full-access` 能做；
- 这不需要额外设计，是 seam 的形状给的，要在产品文案里说清楚。

### 6.3 上限与背压

- 单次 `readText` 8 MiB（同 `fs-ssh`），超了要分页。
- 单条控制帧 1 MiB，超了 `RST`。
- PTY 输出不做应用层限流。背压直接用 `handle.output.pause()` / `resume()`：socket 的 `bufferedAmount` 超过 1 MiB 就暂停读，落回来再继续。这条压力一路顶到房主的 PTY，中间不需要任何窗口记账。
- 不实现 `watch()`。文件树靠手动刷新 + 写后主动刷新（`fs-ssh` 也是这么处理的）。

---

## 7. UI 与兼容性

右栏 tab 注册在 `sidebar.right.pane.tab`（keyed slot，`replaceRisk: none`，已有 17 个占用者，我们做一个正常占位者）。

三态：

| 状态 | 显示 |
|---|---|
| 未连接 | 置灰图标，点击开配置 |
| 已连接 | 文件树 + 只读预览；`danger-full-access` 时多一个终端按钮 |
| 断开 | 保留最后内容，顶部一条「已断开，重连」 |

**兼容性三条禁令**（对着 `dsh-better-sidebar` 的实测行为）：

1. 不注册 `sidebar` 槽——那是整列，注册即替换别人。
2. 不复用别人的 key。
3. 不让右栏成为唯一入口——右栏是 session 作用域，没开会话就不显示（可接受），所以**工具和命令必须独立可用**。

`dsh-better-sidebar` 只碰 `sidebar.right.pane.tab`、`.title`、`conversation.session.header.utilities`、`settings.section`、`shell.overlay`，不碰 `sidebar` / `panellist` / `main`。我们同样只碰前四个中的前两个 + `settings.section`。**不抢 `main`**——「放大模式」留到用户明确要求时再做。

---

## 8. 里程碑

| 阶段 | 内容 | 验收 |
|---|---|---|
| **M0** | 传输打底：Worker + DO + 自写 mux + 两条命名协议 | 一条 WSS 上同时跑 ctl + fs；**大终端流量下 fs 请求仍即时响应**；RTT 与 p95 实测记录在案（见 §3.5） |
| **M1** | **realm 隔离验证**（最高风险项提前）：空房间 preset 里换掉 `ctx.fs`，看 `tool-fs` 是否真的读到远端 | 同一个 `read` 工具，切 preset 前后读到的目录不同；组外查找仍拿宿主 fs |
| **M2** | `provider-fs` + `host/fence` + `read-only` 档 | 访客用 `read` 读到房主目录；越界路径被 `ROOM_OUTSIDE_ROOT` 拒 |
| **M3** | 右栏 tab + 开房/邀请流程 + 确认卡片 | 房主点一次就开；访客粘链接就连上 |
| **M4** | 写入：`writeText` / `editText`，接房主 `ctx.fs` + `fs-sandbox` | `workspace-write` 下写房间内成功、写房间外被 `FS_SANDBOX_DENIED` |
| **M5** | 审计：`before`/`after` + 回放 | 每次写都能看到改前改后 |
| **M6** | `provider-subprocess` + 终端：`bash-local` 自动变远端，`spawnTerminal` 转发 | 只在 `danger-full-access` 开放；关 tab 时 PTY 被回收 |
| **M7** | 打磨：CodeMirror、多房间、可选 SSH-over-stream | — |

M0/M1 是两个必须先过的验证，**不要**在它们通过前写 UI。M1 之所以提前：整个「零工具」方案压在这条上，赌错就要退回 `room_*`。

---

## 9. 风险与未决

| 风险 | 影响 | 处置 |
|---|---|---|
| **realm 隔离在房间 preset 里不成立** | 整个「零工具」方案落空 | **M1 先验证**；失败则退回薄版 `room_*`——transport / protocol / host 全部可复用，只多写 4 个工具壳 |
| preset 是 pre-stable API | 上游升级会破 | 只依赖两个已文档化面：`plugins` 列表、`cordis:group` 隔离；不碰 `mount.ts` 内部实现 |
| 右栏文件树是否跟随 session 的 `ctx.fs` | 不跟随的话 room 会话里树仍显示本地 | M3 验证；不跟随就自己渲染只读树，工具链不受影响 |
| 自写 mux 的正确性 | 帧边界错会让终端吐乱码 | 单测覆盖分片、半包、乱序、并发开流、UTF-8 边界切分；先只跑 ctl+fs |
| 中继延迟 | 终端手感变钝（多一跳） | M0 实测 RTT；超标就上 WebRTC 直连，协议不动 |
| 中继在境内可达性 | 默认 Cloudflare 可能慢或不可达 | relay 地址做成配置；备选自建 Node 转发，协议一行不改 |
| 想白拿 SSH 家族（`fs-ssh` 等）的诱惑 | 会拖进 sshd 与 helper 部署 | v1 不碰；要做得接受「房主装 helper 二进制」，见 §5.4 |
| DO 免费额度 | 大流量终端可能顶到上限 | M0 里量一次；超了就降级为「终端默认关」 |
| Windows ⇄ POSIX 路径 | 房主 Windows、访客 Linux 时路径语义不一致 | 路径一律当**房主坐标**的不透明字符串；只在房主侧规范化 |
| 右栏已 17 个 tab | 再加一个会更挤 | 接受；用户自己会关 |
| PTY 在房主 unload 时泄漏 | 孤儿进程 | 房主插件 `dispose` 时遍历活跃 PTY 并 `terminate()` |
| 多房间 | 一人同时开几个 | v1 单房间；数据结构留 `Map<roomId, Room>` |

**已消除的风险**（相对 v4）：

- ~~权限规则表过重~~ → 缩成一条 `assertInside`，写委托给 `fs-sandbox`。
- ~~「SSH 建立后就是完全权限」的表述含糊~~ → 改成有依据的结论：沙箱模式兜写不兜读，所以执行只能落在 `danger-full-access`。
- ~~重复实现 fs/bash 工具~~ → 房间做成 preset，工具零开发。代价是换来「realm 隔离」这个新风险，已提前到 M1。

---

## 10. 参考

- DSH 源码（MIT）：`packages/ssh/{fs-ssh,subprocess-ssh,sandbox-ssh}`、`packages/fs/fs-sandbox`、`packages/sandbox/sandbox-policy`、`packages/interaction/{user-approval,permission-presets}`、`packages/fs/tool-fs`、`packages/terminal`
- [open-remote-ssh](https://github.com/jeanp413/open-remote-ssh) — TypeScript，隧道/重连/服务端引导的完整实现
- [ShellHub](https://github.com/shellhub-io/shellhub) — 反向隧道、命名协议、零入站端口（Apache-2.0）
- [VS Code Remote-SSH 文档](https://code.visualstudio.com/docs/remote/ssh) — 心智模型（扩展本体闭源）
- Cloudflare Durable Objects（WebSocket Hibernation API）
