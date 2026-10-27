# DSH 远程工作区插件 · 技术调研（v2）

> 参考对象：**VS Code Remote-SSH**。把「房主的 DSH」当成「远端机器」，把「访客的 DSH」当成「本地 VS Code」。
> 状态：调研稿 v2（2026-10-26）。数字除标注来源外均为**估算**，需在 M0 实测校准。
> v1 已归档为 `dsh-share-room-tech-research.v1.md`（当时的设计是"共享会话流 + 访客重写对话页"）。

---

## 0. 决策记录

### 0.1 已定（v2）

| # | 决策 | 说明 |
|---|---|---|
| D1 | **房主只提供能力**：文件树、文件读写、终端、权限 | 房主**不跑 Agent**、**不共享会话**、不暴露 DSH Web |
| D2 | **Agent 跑在访客侧** | 访客用自己的 DSH、自己的模型、自己的 token 预算；通过远端工具操作房主机器 |
| D3 | **入口 = DSH 右栏 Tab**（`sidebar.right.pane.tab`） | 左栏与中间对话页完全不碰，天然与 better-sidebar 共存 |
| D4 | **常驻图标 + 未连接灰态** | 右栏永远有这一格；未连接时渲染空态与"加入房间"，不是隐藏 |
| D5 | `main` 整页作为**可选放大模式** | 点 Tab 里的"放大"把 `main` 切到 `room`；退出回 `conversation` |
| D6 | 中继 = **Cloudflare Workers + Durable Objects** | 一个 DO 实例 = 一个房间；WebSocket Hibernation 适配稀疏流量 |
| D7 | 房主侧**零入站端口、零页面托管** | 只有一条出站 WSS；`127.0.0.1:50069` 从不对外 |
| D8 | 一期只服务「双方都装插件」 | 浏览器静态页、公开 Web 端都后置 |

### 0.2 变更（v1 → v2）

| 项 | v1 | v2 |
|---|---|---|
| 共享对象 | 会话流（`sessionController.follow`） | **能力 RPC**（fs / terminal / audit） |
| Agent 在哪 | 房主 | **访客** |
| 房主暴露面 | 会话 + 工作区 + 终端 | **只有被授权的文件与终端** |
| 访客聊天界面 | 自己重写一个对话页 | **原装对话页**，工具卡由 DSH 原生渲染 |
| UI 承载 | `main` 整页 | **右栏 Tab**（`main` 仅作放大） |

一句话：**从"共享一个 Agent"改成"共享一台机器的能力"**。后者更小、更安全，也更省 UI 工作。

### 0.3 备选方案（保留，不选）

| 方案 | 形态 | 为什么不选 |
|---|---|---|
| **A. 浏览器里跑一个 DSH** | 中继托管静态 SPA | 访客没装 DSH 时才需要；等于重写一个瘦客户端，且失去原生主题与组件 |
| **B. 公开房主的 DSH Web 端** | 隧道到 `127.0.0.1:50069` | 暴露整套后台与房主登录态。DSH 虽支持非房主页面（`snapshotFor` / `REMOTE_ACCESS_SNAPSHOT_KEY` / `createPeer`），但安全边界全压在 `remoteAccess` 正确性上 |
| **C. 共享房主的 Agent 会话** | 访客看房主会话流并发言 | 访客聊天要自己重写；房主 token 被烧；会话权限与文件权限纠缠 |
| **D. 右栏 Tab + 能力 RPC** | 本方案 | ✅ 采用 |
| **E. 远端目录同步成本地镜像** | 访客本地有一份快照 | 现成工具（better-sidebar 的 git/diff/搜索）直接可用，但延迟、冲突、磁盘占用；可作后续"离线模式" |

---

## 1. 参考项目

### 1.1 主参考：VS Code Remote-SSH

| 层 | VS Code Remote-SSH | 我们 |
|---|---|---|
| UI | 本地 VS Code | 访客的本地 DSH |
| 文件 / 终端 / 扩展宿主 | **远端**（VS Code Server） | **房主** DSH |
| 通道 | SSH 上复用 RPC（控制 socket + 数据通道） | 房间 WSS + 帧协议 |
| 本地有没有业务逻辑 | 几乎没有，只渲染 | 同理：**访客侧不跑远端 Agent** |
| 入口在哪 | 左活动栏的 Remote Explorer | **右栏 Tab**（DSH 右栏就是它的副栏） |

来源：[Remote SSH 官方博客](https://code.visualstudio.com/blogs/2019/07/25/remote-ssh)、[Remote development over SSH](https://code.visualstudio.com/docs/remote/ssh-tutorial)。

**照抄的核心心智**：本地端是瘦客户端，远端拥有真实资源。我们唯一的不同是"Agent 在本地"——因为 Agent 是 DSH 的本体能力，而它需要的只是远端资源。

### 1.2 其他参考

| 项目 | 证明了什么 | 我们借用什么 |
|---|---|---|
| [Live Share](https://learn.microsoft.com/en-us/visualstudio/liveshare/reference/connectivity) | `relay` 模式房主**不开端口**；加密隧道 + 中继回落 | 连接模式、安全模型 |
| [Code With Me](https://www.jetbrains.com/help/ide-services-cloud/getting-started-with-codewithme-for-business.html) | 默认只读，终端/运行/编辑逐项授予 | 权限粒度、默认收紧 |
| [coder/code-server](https://github.com/coder/code-server) | 浏览器内 IDE 可行 | "宿主机发页面"的边界认知（我们不走） |
| [ttyd](https://github.com/tsl0922/ttyd) / [gotty](https://github.com/yudai/gotty) | PTY 字节流经 WS 到浏览器，xterm.js 重绘 | 终端通道 |
| [xtermjs/xterm.js](https://github.com/xtermjs/xterm.js) | 浏览器终端事实标准 | 终端渲染 |
| [frp](https://github.com/fatedier/frp) / [Cloudflare Tunnel](https://developers.cloudflare.com/tunnel) | 出站隧道穿越 NAT | M0 备选（主选是 DO） |

### 1.3 本项目自身

- 公开仓库：[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)（MIT，Cordis 驱动）。
- 本机安装：`@deepseek-ai/dsh-desktop-runtime@0.2.1-rc.2`。
- ⚠️ **版本漂移**：公开教程出现过 `0.1.0-rc.6`，本地是 `0.2.1-rc.2`。所有接口以本地 `cordis_inspect_query` 为准。

---

## 2. 网络连接

### 2.1 结论

**房主不开入站端口，也不提供任何页面。** 公网可达性只放在中继上。

| 事 | 是否必须 |
|---|---|
| 一个公网可达的 WSS 端点（中继） | ✅ 必须 |
| 房主开放入站端口 | ❌ |
| 房主有公网 IP / 域名 / 证书 | ❌ |
| 额外的静态站点域名 | ❌（访客自带 DSH，连落地页都不需要） |

### 2.2 候选与选择

| 方案 | 房主入站端口 | 运维 | 国内可用性 | 结论 |
|---|---|---|---|---|
| 端口映射 / DDNS | ✅ | 高 | 差 | ❌ |
| cloudflared quick tunnel | ❌ | 低 | 不稳定 | M0 备选 |
| frp（自建 frps） | ❌ | 中 | 好 | 过渡备选 |
| **Cloudflare Workers + DO** | ❌ | 低（`wrangler deploy`） | 中（需实测） | ✅ **采用** |
| Tailscale / ZeroTier | ❌ | 低 | 中 | 局域网兜底 |

### 2.3 中继形态（已定）

| 项 | 值 |
|---|---|
| 形态 | Cloudflare Workers + **Durable Objects**（一个 DO 实例 = 一个房间） |
| 路由 | `wss://<relay>/v1/host?room=<id>`、`/v1/guest?room=<id>`，都用 `env.ROOM.idFromName(roomId)` 落到同一个 DO |
| 长连接 | **WebSocket Hibernation API**（`state.acceptWebSocket`）：房间空闲不烧 CPU/内存 |
| 职责 | 房间注册、心跳、帧转发、限流、TTL |
| 禁止 | 解析业务、落盘内容、持有密钥 |
| 前置 | 本地已有 wrangler 登录态；先 `wrangler dev` 跑本地；DO 免费额度（SQLite 后端）是否够用**待确认** |

### 2.4 三边都是出站

```text
访客 DSH（本地）  ──出站 WSS──►  Relay (CF DO)  ◄──出站 WSS──  房主 DSH
     │                              │
     └── Agent 在本地跑              └── 只按 roomId 转发加密帧
     └── 右栏 Tab 渲染远端视图
```

---

## 3. 架构：房主是"能力方"，访客是"Agent 方"

### 3.1 职责切分

| | 房主 | 访客 |
|---|---|---|
| 跑不跑 Agent | ❌ 不跑 | ✅ 跑自己的 |
| 花谁的 token | — | 访客自己 |
| 拥有什么 | 真实文件、真实进程、真实权限 | 模型、会话、UI |
| 暴露什么 | **只有被授权的 fs / exec 能力** | 无 |
| 共享会话吗 | ❌ 完全不共享 | — |

**房主插件根本不碰 `sessionController`。** 这是本方案最大的安全收益：房主的会话、历史、记忆、其他工作区，从协议层面就不可达。

### 3.2 数据流

```text
访客的 Agent（本地 DSH）
  └─ 调用工具 room_read / room_write / room_bash …
        │
        ▼
访客侧 Host 插件（房间客户端）
  └─ 加密封帧 ──出站 WSS──► Relay ──出站 WSS──► 房主侧 Host 插件（房间服务端）
                                                        │
                                                        ├─ 权限裁决（路径 / 命令 / 配额）
                                                        ├─ ctx.fs.*  → 真实文件
                                                        ├─ ctx.subprocess.* / PTY → 真实终端
                                                        └─ 审计
```

反向的流：终端输出、文件变更通知、审批结果。

### 3.3 为什么这样最省

| 原方案的痛点 | v2 怎么消掉 |
|---|---|
| 访客要重写一个对话页 | **不用**。访客聊的是本地会话，DSH 原装对话页、工具卡、审批、回放全部照用 |
| 房主 token 被烧 | 不烧，访客自己付 |
| 会话共享的权限纠缠 | 不存在会话共享这件事 |
| 房主的私人历史被看到 | 协议里没有这条通道 |
| 访客侧要处理远端流式输出 | 流式输出是本地 Agent 在流，直接由 Agent 循环产生 |

> 换言之：**v1 里最贵的那些活儿，在 v2 里都不存在了。**

### 3.4 权限模型（全部在房主侧强制）

| 维度 | 取值 | 默认 |
|---|---|---|
| `fs.read` | 路径白名单（根目录 + 排除项） | 开启，白名单内 |
| `fs.write` | 同上 + 是否需房主确认 | **关闭** |
| `exec` | `off` / 命令白名单 / 全开 | **off** |
| `net` | 房主机器上的出网 | 跟随 exec |
| `secrets` | `.env` / 凭据目录 | **永不可读** |
| 配额 | 请求数/秒、字节/秒、并发流 | 有 |
| 生命周期 | 房间 TTL、单次会话上限、随时吊销 | 有 |

**强制点在房主插件里，不在工具描述里，也不在提示词里。** 访客伪造任何参数都无用。

可复用的 DSH 原语：

- `ctx.fs.writeText(target, content, expected?, signal?, sandboxPolicy?)` —— 直接吃 `SandboxExecutionPolicy`；
- `ctx.sandbox.confine(argv, policy)` —— 把命令包进沙箱再执行；
- `ctx.sandboxPolicy.resolve()` —— 拿默认模式与 workspace root。

---

## 4. UI：右栏 Tab

### 4.1 入口普查（2026-10-26 实测）

`Slots.listSubTree` 实时数据：

| slot | 现有占用者 |
|---|---|
| `main`（中央整版面） | `conversation`、`plugins`、`schedules`、`dsh-context` |
| `sidebar.panellist`（左栏图标） | `plugins`(0)、`schedules`(10)、`dsh-context`(20) |
| `sidebar`（整个左栏） | 只有 `Kb`（DSH 自带 ui-sidebar） |
| **`sidebar.right.pane.tab`** | **17 个**，见下 |

右栏 Tab 的 17 个占用者（节选）：

```text
@deepseek-ai/dsh-client-ui-sidebar-files        ← 自带文件树
@deepseek-ai/dsh-client-ui-sidebar-terminal     ← 自带终端
@deepseek-ai/dsh-client-ui-sidebar-documentpreview
@deepseek-ai/dsh-client-ui-sidebar-browser
@deepseek-ai/dsh-client-ui-sidebar-right/guide
dsh-better-sidebar:files / :editor / :git / :diff / :sidechat / :subagent
dsh-file-review:review
dsh-context
```

关键属性：

| 属性 | 值 |
|---|---|
| kind | `keyed` |
| keyDomain | **open**（任意字符串） |
| replaceRisk | **none**（加 Tab，不替换整栏） |
| declaredBy | 一个 entry 在 `rightbar.session`（DSH 自带） |
| scope | `session` |

> **结论：右栏是官方预留的、非覆盖型扩展点。better-sidebar 也是这么加进去的，我们加第 18 个天然兼容。**

### 4.2 布局

```text
┌──────────┬─────────────────────────┬──────────────────────┐
│ 左栏     │ 中间：本地会话（原装）    │ 右栏：远程工作区      │
│ 工作区   │ 聊天 / 工具卡 / 审批      │ ├ 连接状态（灰态）    │
│ 会话列表 │                          │ ├ 远端文件树          │
│ 面板图标 │                          │ ├ 预览 / 编辑         │
│          │                          │ ├ diff               │
│          │                          │ └ 终端               │
└──────────┴─────────────────────────┴──────────────────────┘
```

左栏 = 本地 DSH；中间 = 访客自己的对话（原装，不碰）；右栏 = 那台"远端机器"。

### 4.3 注册形态

```js
// 主入口：右栏 Tab —— 常驻，未连接时是灰态空壳
ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
  name: 'sidebar.right.pane.tab',
  key: 'dsh-room:workspace',
  component: RoomTab,            // 未连接 → 空态 + 加入房间；已连接 → 文件/终端/diff
}))

// 可选放大：同一个组件升级成整页
ctx.slots.register({ name: 'main', key: 'room', component: RoomTab })
//   放大 = main 切到 'room'；退出 = 切回 'conversation'
//   conversation 格子始终在注册表里，不会被销毁

// 房主管理入口（不占右栏）
ctx.slots.register({ name: 'settings.section', id: 'dsh-room', ... })
```

`RoomTab` 一份代码，右栏与整页两处复用，靠 props 区分宽度模式。

**常驻 + 灰态的实现要点**：

- Tab 的 key 永远注册；`connected` 是组件内部状态，不是注册条件；
- 未连接时渲染：房间号输入 / 邀请码粘贴 / "等待房主接纳" / 上次房间的错误；
- 已连接但断线时渲染：断线原因 + 重试 + 房间是否还活着；
- 灰态视觉用 `--dsw-alias-*` token 的弱化色，别硬编码颜色。

### 4.4 与 better-sidebar 的共存（已核实）

读了 better-sidebar 0.28.0 的源码（该包带完整 `.tsx`）：

```text
slots.inject('sidebar.right.pane.tab',        ...)   ← 右侧栏 Tab
slots.inject('sidebar.right.pane.tab.title',  ...)   ← Tab 标题
slots.inject('conversation.session.header.utilities', ...)
slots.inject('settings.section',              ...)
slots.inject('shell.overlay',                 ...)
```

它**一次都没碰** `sidebar`、`sidebar.panellist`、`main`。而 `sidebar` 槽的 catalog 明确写着：

> OCCUPIED by ui-sidebar's SidebarRoot … registering here **replaces the navigation column outright** … **To add something to the sidebar, register into one of those inner seats instead.**

所以：**两边井水不犯河水，我们和它是邻居而不是竞争。**

真正的风险不是槽冲突，而是**版本**：它的 README 写明 v0.28.0 要接管 npm `latest`，而 DSH 自身仍是 0.2.0-rc.2，宿主必须固定版本。

### 4.5 已知 UX 风险：Tab 太挤

右栏已有 17 个 Tab，`dsh-better-sidebar:files` 与系统自带 `sidebar-files` 甚至同时存在。所以：

- 图标要有辨识度，label 明确写"远程"；
- 灰态要**轻**，别让人一进 DSH 就看到一个大空面板；
- 提供偏好项"仅连接时显示"（与 D4 默认相反，作为可选项）。

### 4.6 可复用的槽属性

`sidebar.right.pane.tab` 的 `standardProps` 已包含聊天/会话原语：

```text
useRemoteAccess / useResource / useWorkspaces / usePanelInfo
useSessions / useSessionStatus / useSessionAccess / useWorkspaceAccess
useChat / useConversation / useInput / inputActions
useSession / sessionId / useProjection / useAccess / useTrajectory
hookContext: TabHookContext
```

其中 `useAccess(action)` 正好用来做"当前身份能不能写/能不能执行"的界面开关。

---

## 5. 访客侧 Agent 集成（本方案的核心）

### 5.1 工具集

| 工具 | 参数 | 对应远端能力 |
|---|---|---|
| `room_read` | `path`, `offset?`, `limit?` | `fs.readText` / `readByteRange` |
| `room_list` | `path`, `depth?` | `fs.listDir` |
| `room_glob` | `pattern`, `path?` | 远端 glob |
| `room_grep` | `pattern`, `path?`, `include?` | 远端 grep |
| `room_write` | `path`, `content` | `fs.writeText`（需写权限） |
| `room_edit` | `path`, `old`, `new` | `fs.editText`（带版本检查） |
| `room_bash` | `command`, `cwd?`, `timeoutMs?` | `subprocess.spawn` + 沙箱（需 exec 权限） |

约束：

- **一期只允许一个活动房间**（工具名不必带房间后缀，模型不易混淆）；
- 房间未连接时用 `ctx.tools.guard()` 直接拒绝并给出原因（不要静默隐藏，否则模型会幻觉）；
- 远端路径与本地路径**必须区分**：工具内一律解析到房间根目录，拒绝绝对路径逃逸；
- `room_edit` 必须带版本检查，避免覆盖房主刚做的修改。

### 5.2 工具卡渲染（白拿的原生体验）

DSH 有 `tool.call.toolview`，**keyed by 工具名，keyDomain 开放**（已被 `read`/`write`/`bash`/`grep` 等占用，但允许任意新 key）。

所以给 `room_read` / `room_edit` / `room_bash` 注册自定义卡片：

- `room_read` → 代码行视图（和 `read` 卡片同构）
- `room_edit` → **diff 卡片**（写入前后的文本）
- `room_bash` → **终端卡片**（命令 + 输出 + exit code）

访客看到的工具卡和本地工具**一模一样**，无需额外 UI 工作。这是"Agent 在本地"带来的最大红利。

### 5.3 系统提示注入

访客的模型必须知道自己在操作一台**远端机器**：

```text
- 你正在通过房间 <id> 操作房主机器上的目录 <remoteRoot>。
- 该目录下的路径是远端路径；本地工作区 <localRoot> 与本房间无关。
- 可用能力：读 [允许] / 写 [禁止] / 执行 [禁止]。
- 读取被拒绝时不要反复尝试，把原因告诉用户。
```

用 `ctx.systemPrompt.section()` 注入。⚠️ 待验证：`PromptSection` 的确切字段（`name` / `order` / `content` 之类）以本地 `listService('systemPrompt')` 的类型为准。

### 5.4 子 Agent 与并发

- 子 Agent 继承工具注册（scoped tools 在 `agent.ctx` 上可见），但**权限判断必须在房主侧**；
- 并发写同一文件：房主侧版本检查 + 单文件写锁；
- `room_bash` 声明为 exclusive（`isConcurrencySafe` 返回 false）。

### 5.5 房主侧的"非 Agent"现实问题

房主插件没有 Agent 上下文，所以：

| 需要 | 可用 | 备注 |
|---|---|---|
| 文件读写 | `ctx.fs.*` | 直接可用 |
| 命令执行 | `ctx.subprocess.spawn(spec)` | 直接可用；配合 `ctx.sandbox.confine` |
| 交互式 PTY | `ctx.terminals.spawn(owner: Agent, ...)` | **需要 Agent**，房主侧拿不到 → 待验证替代路径 |
| 交互式审批 | `ctx.approval.request(req)` | 需要会话上下文 → 一期改为**策略式**（预授权 + 审计 + 一键吊销） |

一期用"策略式授权"而不是"逐次弹窗"。这个取舍要写进 UI：房主开房间时就把权限说清楚，事后靠审计与吊销兜底。

---

## 6. 协议（能力 RPC）

### 6.1 帧格式

WebSocket 二进制帧，4 字节头（`type` 1B + `flags` 1B + `len` 2B），body 为 AES-GCM 密文。

### 6.2 方法表（访客 → 房主）

| method | 入参 | 出参 / 流 |
|---|---|---|
| `hello` | `roomId`, `proof`, `nonce` | `welcome` / `reject` |
| `fs.stat` | `path` | `{ size, mtime, kind }` |
| `fs.list` | `path` | `entries[]` |
| `fs.read` | `path`, `range` | `{ text, totalLines, version }` |
| `fs.write` | `path`, `content`, `expectedVersion?` | `{ version }` / `conflict` |
| `fs.edit` | `path`, `old`, `new`, `expectedVersion` | `{ version }` / `conflict` |
| `fs.watch` | `path` | 流：`{ path, kind }` |
| `exec.run` | `command`, `cwd`, `timeoutMs` | 流：`stdout` / `stderr` / `exit` |
| `exec.cancel` | `runId` | `{}` |
| `audit.list` | `since?` | `entries[]` |

### 6.3 错误码（必须机器可读）

```text
no-permission       路径不在白名单 / 写被禁 / exec 被禁
path-escape         解析后越出房间根
not-found / is-dir / not-dir
version-conflict    文件已被房主改动
rate-limited
room-closed / revoked
exec-timeout
```

**每个错误都要带人话原因**，因为最终会被模型读到，影响它的下一步行为。

### 6.4 流与背压

- `exec.run` 输出最凶（`npm run build` 一秒几 MB）→ 服务端聚合 + 采样（>200 帧/秒合并），令牌桶限流；
- `fs.watch` 合并抖动（100ms 去抖）；
- 断线有 gap 时：文件类重新拉快照，终端类提示"输出可能不完整"。

### 6.5 端到端加密

```text
X25519 ECDH → HKDF-SHA256 → 双向独立 AES-256-GCM
帧：[1B ver][8B seq][12B iv][ciphertext][16B tag]，AAD = roomId|direction|seq
```

- `roomKey` 由**房主本地生成**，中继永远不知道；
- 邀请链接形如 `https://<relay>/j/<roomId>#<roomKey>`，`#` 之后不进 HTTP；
- 密码是可选第二道门，哈希存房主侧，中继只看到失败计数。

---

## 7. 技术栈与开源复用

### 7.1 选型

| 层 | 选择 | 理由 |
|---|---|---|
| 插件（房主/访客同一个包） | TypeScript + Cordis 插件（`apply(ctx, config)`） | 与 DSH 同栈 |
| 出站连接 | `ws` 客户端 | 纯客户端，无新增端口 |
| 协议校验 | `zod` | 与 DSH 的 `typert` 同源 |
| 加密 | Node `crypto`（X25519 + AES-256-GCM） | 零依赖 |
| 中继 | Cloudflare Workers + Durable Objects | 已定 |
| 右栏 UI | React 18 + 自建 CSS（`--dsw-alias-*` token） | 与宿主一致 |
| 编辑器 | 一期 **CodeMirror 6**（~200 KB）；二期可选 Monaco | 包体 vs 观感 |
| 终端 | `@xterm/xterm` + `xterm-addon-fit` | 事实标准 |
| Diff | `diff` 库 + 自写渲染 | 轻 |
| 状态 | 房间状态自己存 JSON（**不写 Session 日志**） | 插件不得追加未知事件类型 |
| 测试 | `vitest` + `playwright`（两个浏览器上下文） | — |

### 7.2 开源复用清单（2026-10-26 实测）

> ★ 由 GitHub API 实时查询。标 **NOASSERTION** 表示 GitHub 未能识别或带附加条款，引入前必须自己读 LICENSE。

| 项目 | ★ | 许可证 | 角色 |
|---|---|---|---|
| microsoft/vscode | 194.3k | MIT | 不引入（应用不是库），UI 标杆 |
| coder/code-server | 79.7k | MIT | 不引入（宿主机发页面 = 备选 B） |
| anomalyco/opencode | 221.7k | MIT | 参考：终端 agent 的工具卡与会话渲染 |
| open-webui/open-webui | 156.8k | NOASSERTION | 不引入（整应用 + 品牌条款） |
| lobehub/lobehub | 83.5k | NOASSERTION | 不引入 |
| cline/cline | 70.9k | Apache-2.0 | UX 参考：diff 卡 + 审批按钮 |
| microsoft/monaco-editor | 46.9k | MIT | 二期引入（VS Code 编辑器内核） |
| LibreChat | 46.3k | MIT | 参考多 provider 聊天架构 |
| CopilotKit | 38.2k | MIT | 备选 |
| continuedev/continue | 36.3k | Apache-2.0 | UX 参考：IDE 内聊天 + 自定义 provider |
| voideditor/void | 28.7k | Apache-2.0 | 参考：VS Code fork 内嵌 AI |
| vercel/ai | 27.5k | NOASSERTION | **v2 不再需要**（流式来自本地 Agent 循环） |
| RooCodeInc/Roo-Code | 24.3k | Apache-2.0 | 备选 UX 参考 |
| eclipse-theia/theia | 21.7k | EPL-2.0 | 不引入（整套框架） |
| **xtermjs/xterm.js** | 21.3k | MIT | **引入**：终端 |
| loft-sh/devpod | 15.3k | MPL-2.0 | 不引入（环境管理） |
| assistant-ui | 12.7k | MIT | **v2 不再需要** |
| codemirror/dev | 7.8k | NOASSERTION | **一期引入**：编辑器 |
| cloudflare/agents | 5.9k | MIT | 中继范式参考（DO + 流式） |
| partykit/partykit | 5.7k | MIT | 中继范式参考（DO 房间） |

**没有"整包可用"的成品**：Live Share 有协作无 Agent；Cline/Continue 有 Agent 无房间；code-server/Theia 有远程 IDE 但走"宿主机发页面"；partykit/agents 有房间无 IDE。**我们是拼装，但每个缺口都有现成件。**

---

## 8. 带宽估算

v2 里没有会话流，全部是能力 RPC：

| 数据 | 峰值 | 平均 | 备注 |
|---|---|---|---|
| `fs.list` / `fs.stat` | 50 KB/次 | — | 大目录要分页 |
| `fs.read` | 1 MB/次 | — | 超阈值走流式 + 截断 |
| `fs.write` | 同文件大小 | — | 大文件禁写或分块 |
| `fs.watch` | 2 KB/s | 0 | 去抖后 |
| 终端输出（普通命令） | 200 KB/s | 1 KB/s | 空闲接近 0 |
| 终端输出（构建日志） | 2–5 MB/s | — | **必须聚合限流** |
| 对比：1080p30 投屏 | — | 250–600 KB/s | 遥不可及 |

结论：**真正要治理的只有终端日志与大文件**，其余量级都很小。

---

## 9. 安全清单（M1 必须全绿）

- [ ] 房主插件**不碰** `sessionController`，协议里没有会话通道；
- [ ] 权限裁决全在房主侧：路径解析后判白名单，拒绝 `..`、符号链接、UNC、大小写变体（**不做字符串前缀比较**）；
- [ ] `exec` 默认关闭；开启时用 `sandbox.confine` 包沙箱；
- [ ] 写操作带版本检查，冲突显式返回；
- [ ] 敏感路径永不读（`.env`、凭据目录、`.dsh`；`node_modules` 可选）；
- [ ] 邀请令牌一次性 + 短期（默认 2h）；房间关闭立即失效；
- [ ] `roomKey` 只在 URL fragment 或房主口头传递，中继日志无痕；
- [ ] 传输三层：访客↔中继 TLS、中继↔房主 TLS、端到端 AES-GCM；
- [ ] 审计：谁 / 何时 / 对哪个路径 / 结果；房主可随时吊销并断开；
- [ ] 中继不落盘内容；房主侧审计只存元数据 + 摘要；
- [ ] 房主 UI 常驻可见"当前几个房间、谁在连、最近做了什么"。

---

## 10. 里程碑

| 阶段 | 内容 | 验收标准 |
|---|---|---|
| **M0 打通能力链路**（1–2 天） | `wrangler dev` 起 DO 房间；房主插件出站注册；访客插件连接；跑通**一次 `fs.read`**；中继 debug 模式断言抓不到明文 | 访客拿到的文件内容 = 房主磁盘内容；房主 `50069` 无任何新增路由 |
| **M1 右栏 Tab + 只读** | 常驻 Tab（灰态 + 连接流）；远端文件树；只读预览；能力清单 | 访客在自己的 DSH 右栏看到远端目录并打开文件 |
| **M2 工具接入** | `room_read/list/glob/grep` + `tool.call.toolview` 卡片 + 系统提示注入 + 房主侧权限与审计 | 访客的 Agent 能自主读远端文件，卡片与本地工具一致 |
| **M3 写与终端** | `room_write/edit`（版本检查 + diff 卡）+ `room_bash`（沙箱 + 流式输出 + 限流）+ 终端视图 | 访客改一个文件；房主能在审计里看到并回滚 |
| **M4 打磨** | 编辑器（CodeMirror）+ 放大模式（`main`）+ 偏好项（入口可见性）+ 多房间评估 | 可日常使用 |

---

## 11. 未决问题

1. **交互式 PTY**：`ctx.terminals.spawn(owner: Agent, ...)` 需要 Agent，房主插件没有。一期用 `subprocess.spawn`（非交互）是否够用？
2. **`PromptSection` 的确切字段**：以本地 `listService('systemPrompt')` 为准。
3. **工具命名**：`room_*` 前缀是否会与生态里其他插件冲突？是否需要带房间 slug？
4. **多房间**：一期只允许一个活动房间，够不够？
5. **审计存储位置与保留期**：写房主 DSH 的 storage（JSON）还是独立文件？
6. **中继免费额度**：DO 免费计划（SQLite 后端）能否支撑日常使用，未实测。
7. **右栏 Tab 的 session 作用域**：没打开会话时右栏不可用 —— 这个约束能否接受？
8. **写权限的"逐次确认"**：`approval.request` 需要会话上下文，房主侧没有。是否接受"策略式预授权 + 事后审计 + 吊销"？

---

## 12. 参考链接

**Remote 开发**
- https://code.visualstudio.com/blogs/2019/07/25/remote-ssh
- https://code.visualstudio.com/docs/remote/ssh-tutorial
- https://code.visualstudio.com/docs/remote/vscode-web

**协作与权限**
- https://learn.microsoft.com/en-us/visualstudio/liveshare/reference/connectivity
- https://learn.microsoft.com/en-us/visualstudio/liveshare/reference/security
- https://www.jetbrains.com/help/ide-services-cloud/getting-started-with-codewithme-for-business.html

**终端与编辑器**
- https://github.com/xtermjs/xterm.js
- https://github.com/tsl0922/ttyd
- https://github.com/yudai/gotty
- https://codemirror.net/

**传输与中继**
- https://developers.cloudflare.com/tunnel
- https://github.com/fatedier/frp
- https://docs.yjs.dev/
- https://doc.libsodium.org/

**DSH**
- https://github.com/deepseek-ai/deepseek-harness

---

_本文档为 v2 调研稿。标 ⚠️ / "待验证" 的条目需在 M0–M1 用真实环境确认后再落代码；star 数与槽占用数据为 2026-10-26 实测。_
