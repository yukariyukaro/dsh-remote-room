# DSH 共享房间插件 · 技术调研

> 目标：参考 VS Code Live Share，把「DSH」当成「VS Code」来共享。
> 状态：调研稿（2026-10-26）。所有网络/带宽数字除标注来源外均为**估算**，需在 M0 阶段实测校准。

---

## 0. 结论速览

1. **不需要在公网开放入站端口。** 房主侧只建立**出站连接**（出站 WSS / 隧道客户端），公网可达的只有中继域名。这与 Live Share 的 `relay` 模式一致（官方明确：relay 模式下房主"不开启任何端口"）。
2. **访客界面 = 访客自己的 DSH**（装同一插件）。不是投屏，不是把房主后台代理出去，也不是另写一个 IDE。见 §3.6。
   > 修订（2026-10-26）：初版写"访客界面是独立 Room SPA"。核实后改为：一期只服务"双方都装插件"，浏览器静态页降级为后续兜底。
3. **网络连接照搬 Live Share 的三档模式**：`direct`（局域网直连）/ `relay`（默认，零端口）/ `auto`（先试直连再回落）。第一版直接只做 `relay`。
4. **房主侧既不开端口，也不提供页面**：插件只建立一条**出站 WSS** 到中继。客户端代码要么在"访客自己的 DSH"里（装同一插件），要么在中立域名的静态站点上；房主的 `127.0.0.1:50069` **从不对外**。
   > 修订（2026-10-26）：初版计划用 `ctx.webServer.registerUpgrade()` 把房间路由挂到 DSH 自己的监听器上，再打隧道出去。核实 Live Share `browser-join` 后确认这是歧路，已废弃，详见 §2.4。
5. **中继是哑管道**：只按 roomId 转发帧，不懂业务、不落盘。业务鉴权与权限裁决全部在房主侧。宿主形态已定为 **Cloudflare Workers + Durable Objects**（§3.3）。
6. **端到端加密用「密钥放 URL fragment」**：对话密钥不进 HTTP 请求、不进中继日志；中继即使被攻破也读不到内容。Live Share 的做法是 SSH over TLS WebSocket，我们换成 X25519 + AES-256-GCM。
7. **带宽比投屏低两个数量级**：结构化事件流平均 < 20 KB/s，1080p 投屏约 250–600 KB/s。
8. **不自己写 IDE，也不自己写流式**：编辑器内核引 CodeMirror/Monaco，终端引 xterm.js，聊天流式引 Vercel AI SDK 的 `ChatTransport`（§3.5–3.7）。我们只写"房间协议 + 权限 + 数据接线"。
9. **承载面用整页而不是小面板**：DSH 的 `main`（keyed，keyDomain 开放）+ `sidebar.panellist` 足以挂一个与 Plugins 页同级的整页视图（§3.8）。

---

## 1. 参考项目

### 1.1 主参考：VS Code Live Share

| 项目 | 性质 | 证明了什么 | 我们借用什么 |
|---|---|---|---|
| [microsoft/live-share](https://learn.microsoft.com/en-us/visualstudio/liveshare/)（闭源，有官方文档与 SDK 仓库） | 商业产品 | **共享工作区上下文，而不是屏幕**；加密隧道 + 中继回落 | 整体架构、连接模式、安全模型 |
| [Connectivity requirements](https://learn.microsoft.com/en-us/visualstudio/liveshare/reference/connectivity) | 官方文档 | `auto` 模式先试直连（端口 5990–5999），失败才走云中继；`relay` 模式**不开放任何端口**；中继不落盘、不嗅探 | 三档连接模式、端口策略 |
| [Security features](https://learn.microsoft.com/en-us/visualstudio/liveshare/reference/security) | 官方文档 | SSH/SSL 全链路加密；relay 上是「TLS WebSocket 之上再套 SSH」；双向公钥认证；会话 24h 过期；密钥仅存内存并轮换 | 加密分层、会话过期、内存密钥 |

**它最值得抄的一句设计**：`auto` 模式下"部分访客直连、部分访客走中继"是允许的——同一个房间可以混合路由。我们第一版不需要，但协议要为它留位置（每路连接自己协商 transport）。

### 1.2 结构参考：JetBrains Code With Me

| 项目 | 证明了什么 | 我们借用什么 |
|---|---|---|
| [Code With Me](https://www.jetbrains.com/help/ide-services-cloud/getting-started-with-codewithme-for-business.html) | **默认只读**；终端、运行、编辑、隐藏敏感文件都是独立的、房主可随时授予/收回的权限项 | 权限粒度设计、默认收紧、实时撤权 |

这条很关键：Code With Me 的默认值是 read-only，不是 full access。我们的房间默认也应该是「旁观」。

### 1.3 载体参考：浏览器里的 IDE / 终端

| 项目 | 证明了什么 | 我们借用什么 |
|---|---|---|
| [coder/code-server](https://github.com/coder/code-server) | 把一整个 IDE 塞进浏览器、走 WebSocket 全双工，是可行且成熟的 | 「访客用浏览器、不装客户端」这条路成立 |
| [yudai/gotty](https://github.com/yudai/gotty)、[ttyd](https://github.com/tsl0922/ttyd) | 把 PTY 字节流通过 WebSocket 送到浏览器，前端用 xterm.js 重绘；支持 resize、剪贴板 | 真终端视图的实现范式 |
| [tmate](https://tmate.io/) | 单二进制 + 一个命令就能共享终端，靠 WebSocket 隧道穿越 NAT | 「房主零配置」的产品标准 |
| [xtermjs/xterm.js](https://github.com/xtermjs/xterm.js) | 浏览器终端的事实标准（VS Code、JupyterLab、Portainer 都在用） | 终端渲染组件 |

### 1.4 传输与加密

| 项目 | 证明了什么 | 我们借用什么 |
|---|---|---|
| [Cloudflare Tunnel](https://developers.cloudflare.com/tunnel)（`cloudflared`） | 出站连接模型：守护进程主动连边缘，**零入站端口**；维持多条长连接做冗余 | MVP 阶段最快的公网出口 |
| [frp](https://github.com/fatedier/frp) | 自建 `frps` + `frpc`，房主侧 `frpc` 出站连公网 VPS；支持 TCP/HTTP/WSS | 国内部署的主力方案 |
| [Yjs](https://docs.yjs.dev/) / y-websocket | CRDT + awareness 协议（光标、在线状态），断线重连自动合并 | 多访客同时改文件（后续阶段） |
| [libsodium](https://doc.libsodium.org/) / Node `crypto` | X25519 密钥交换 + AES-GCM / ChaCha20-Poly1305 | 端到端加密 |

### 1.5 本项目自身

| 项目 | 性质 | 说明 |
|---|---|---|
| [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) | MIT 开源，Cordis 驱动的 agent harness | 插件即一切；`dsh-client-ui-*` 系列可参考 UI 写法与 CSS token |
| 本机安装 | `@deepseek-ai/dsh-desktop-runtime@0.2.1-rc.2` | **版本漂移注意**：公开教程里出现的是 `0.1.0-rc.6`，本地是 `0.2.1-rc.2`。所有接口以本地 `cordis_inspect_query` 结果为准，不以网上文档为准 |

---

## 2. 网络连接：到底要不要"公网开放"

### 2.1 先把问题说准

"房间网页要在公网开放"这句话里，其实混了三件事：

| 事 | 是否必须 |
|---|---|
| 有一个**公网可达的 HTTPS 地址**给访客打开 | ✅ 必须（否则朋友的手机打不开） |
| 房主机器**开放入站端口** | ❌ 不必 |
| 房主机器**拥有公网 IP / 域名 / 证书** | ❌ 不必 |

答案：**公网可达性放在中继/隧道上，房主只做出站连接。**

### 2.2 五种候选

| 方案 | 公网 IP | 域名/证书 | 需要 VPS | 房主入站端口 | 运维难度 | 国内可用性 | 适用 |
|---|---|---|---|---|---|---|---|
| A. 端口映射 / DDNS | ✅ | ✅ | ❌ | ✅ 开放 | 高（NAT、防火墙、证书） | 差（多数家宽无公网 IP） | ❌ 不采用 |
| B. `cloudflared` Quick Tunnel | ❌ | ❌（随机域名） | ❌ | ❌ | 低 | **不稳定**（境内访问 Cloudflare 边缘波动大） | MVP 验证 / 海外用户 |
| C. `frp`（自建 `frps`） | ❌ | ✅ 自家域名 | ✅ 一台 | ❌ | 中 | 好（国内 VPS 延迟低） | **国内首选** |
| D. 自研 Relay（房主出站 WSS） | ❌ | ✅ | ✅ | ❌ | 中高（要写服务） | 好 | **目标形态** |
| E. 组网（Tailscale / ZeroTier / Headscale） | ❌ | ❌ | 可选 | ❌ | 低 | 中（依赖打洞/自建控制面） | 熟人小圈子兜底 |

### 2.3 推荐组合（2026-10-26 修订）

> **修订说明**：初版把 M0 定成「用 frp 把 50069 隧道出去，访客直接打开房主的 DSH 页面」。
> 核实 Live Share 的 [browser-join](https://learn.microsoft.com/en-us/visualstudio/liveshare/quickstart/browser-join) 后确认这是歧路：
> **房主不需要向访客提供任何页面。** 访客的浏览器加载的是 `vscode.dev` 上的**通用客户端**，
> 只有会话数据经中继流动；房主的机器不参与"发网页"这件事。

```
房主                : 只跑插件，只出一条出站 WSS（不需要 frp / cloudflared / 域名）
访客（有 DSH）      : 装同一个插件，用自己的 DSH 渲染房间   ← desktop join
访客（没有 DSH）    : 浏览器打开中立域名的静态 SPA          ← browser join
中继                : 唯一需要公网 HTTPS + 域名的东西
```

**收益**：

- 房主侧无入站端口、无隧道进程、无证书问题，`50069` 永远不出本机；
- 干掉初版的「Host/Origin 校验」难题（整条链路不碰 DSH 的 index 鉴权）；
- 国内可用性问题从「房主打隧道」转移到「中继部署在哪」，这是一次性的事。

### 2.4 三档客户端归属

| 档 | 客户端在哪 | 房主暴露面 | UI 保真度 | 工期 | 风险 |
|---|---|---|---|---|---|
| **C. 访客自带 DSH**（主推） | 访客自己的 DSH + 本插件面板 | 一条出站 WSS | 高（原生主题/组件） | 中 | 低 |
| **A′. 中立静态 SPA**（兜底） | 中继域名下的静态站点 | 同上 | 中（自写） | 中 | 低 |
| **B. 让访客打开房主的 DSH**（整站） | 房主的 `50069` 经隧道暴露 | **整套管理后台 + 房主登录态** | 最高（就是本体） | 低 | **高** |

**C 和 A′ 共用同一份协议**，中继不用关心对面是浏览器还是另一台 DSH。这就是 Live Share 的 desktop/browser 双客户端模型。

### 2.5 那「真的访问到对方 DSH 的 Web 服务」行不行？

技术上可行，而且 DSH 框架本身就为非房主页面留了位置。本机 `cordis_inspect_query` 查到的原话：

- `remoteAccess.snapshotFor(principal)`：*"每次 index 注入后，渲染非房主页面的业务包应把这个值赋给 `REMOTE_ACCESS_SNAPSHOT_KEY`，替换 webServer index 自带的 owner baseline。"*
- `connection.createPeer({ principal })`：可以创建一个与房主**不同**的 in-process Peer。
- `connection.authorizeIndex(request, response)`：索引页鉴权，可 mint cookie 或 401。

也就是说，「同一套 UI + 给非房主一份削减过的权限快照」是被框架**预期过**的用法，不是我们硬 hack。

**但它是上表 B 档，风险最高**：

1. 暴露的是**完整后台**——设置、插件管理、凭据、全部工作区、全部历史会话；
2. 安全边界被压在 `remoteAccess` 的**实现正确性**上，任何一处漏判 = 全权限；
3. UI 到处是房主假设，要么逐个裁剪（工作量大且易漏），要么让访客看到一堆报错面板；
4. 隧道回指 `127.0.0.1:50069`，等于把本机 Web 服务暴露到公网，微软对 Live Share 的 `direct` 模式也只敢开 5990–5999 且默认回落中继。

**结论**：B 只作为「高信任·整机接管」模式，需要显式二次确认 + 明显红条 + 默认关闭；不作为产品默认路径。

### 2.6 什么时候才需要 `webServer` 那套接口

只有 B 档需要。C/A′ 两档下，宿主插件**完全不注册任何 HTTP 路由**，只用 `ws` 客户端出站连中继。

保留 `ctx.webServer.registerUpgrade()` 的知识点，作为将来做 B 档的技术储备：
`registerUpgrade({ path, handler })` 给 `(req, socket, head)`，可用 `ws` 的 `noServer: true` 接管；路径唯一，重复注册抛错。


---

## 3. 技术栈选型

### 3.1 宿主侧（房主电脑）

| 层 | 选择 | 理由 | 备选 |
|---|---|---|---|
| 语言 | TypeScript（Node ≥ 20.19） | 与 DSH 插件/运行时同栈，零跨语言边界 | — |
| 插件框架 | Cordis（`apply(ctx, config)`） | DSH 原生 | — |
| HTTP/WS 接入 | DSH `webServer.register` + `registerUpgrade` | 零新增端口 | 独立 `http` 服务 |
| WebSocket 库 | `ws`（`noServer: true`） | 与自定义 upgrade 天然契合 | `uWebSockets.js`（过早优化） |
| 消息校验 | `zod` | DSH 自己就在用（`typert` 基于 zod），协议 schema 可直接复用 | 手写校验 |
| 加密 | Node 内置 `crypto`（X25519 + AES-256-GCM）；需要更全原语再上 `libsodium-wrappers` | 无额外依赖、FIPS 友好 | libsodium |
| 存储 | 房间/邀请/审计写 JSON（`dsh-storage-json` 同款风格），不写 Session 日志 | 插件不得向 Session 追加未知事件类型 | SQLite（等数据量大了再说） |

> 注意：**不要**给 Session 追加自定义事件类型。DSH 的 Session 只接受已知类型或带 `ignorable: true` 的存储态事件，而 live `append()` 盖不上这个标记，会导致 Session 无法再打开。房间状态自己存。

### 3.2 访客侧（浏览器）

| 层 | 选择 | 理由 | 备选 |
|---|---|---|---|
| 构建 | Vite（客户端包，产出单文件/静态目录） | 简单、快、产物可直接由房主托管 | esbuild 直出 |
| 框架 | React 18 | 与 DSH Web UI 同构，便于照抄组件结构 | Preact（体积敏感时） |
| 样式 | **自建 CSS + 抄 `--dsw-alias-*` 主题变量的取值**（房主在握手时下发 token 快照） | 插件不能 `require` DSH 的客户端包；但可以抄样式值 | CSS-in-JS |
| 编辑器 | 一期 **CodeMirror 6**（约 200 KB）；二期可选 **Monaco**（VS Code 同款内核，MIT，46.9k★，gz 后 2–3 MB） | Monaco 才是"像 VS Code"的观感，但包体大；先小后大 | — |
| 终端 | `@xterm/xterm` + `xterm-addon-fit` | 事实标准；M3 需要 | 纯 `<pre>`（M1–M2 够用） |
| 聊天 | **Vercel AI SDK**（`useChat` + 自定义 `ChatTransport`），可选叠 **assistant-ui** | 流式、重连、消息状态全部现成，见 §3.7 | 手写（不推荐） |
| Diff | `diff` 库 + 自写渲染 | 轻 | Monaco 自带 diff editor |
| 状态 | 自写 store（协议帧驱动） | 房间状态是流式的，用不上重型框架 | zustand |

### 3.3 中继侧

| 层 | 选择 | 理由 |
|---|---|---|
| 形态 | **Cloudflare Workers + Durable Objects**（已定，2026-10-26） | 无服务器、自带 TLS 与边缘网络；**一个 DO 实例 = 一个房间** |
| 路由 | `wss://<relay>/v1/host?room=<id>`、`/v1/guest?room=<id>`，两者都 `env.ROOM.idFromName(roomId)` 落到同一个 DO | 房间生命周期与 DO 生命周期天然对齐 |
| 房间对象 | DO 持有 `host` socket + `guests` 集合；用 **WebSocket Hibernation API**（`state.acceptWebSocket`） | 房间空闲不烧 CPU/内存，适配"偶尔救火"的稀疏流量 |
| 职责 | 房间注册、心跳、帧转发、限流、TTL | **不懂业务、不落盘、不持密钥** |
| 前置 | 本地已有 wrangler 登录态；先 `wrangler dev` 跑本地；DO 免费额度（SQLite 后端）是否够用**待确认** | — |
| 参考实现 | partykit/partykit（DO 房间范式）、cloudflare/agents（DO + 流式） | 见 §3.5 |

### 3.4 开发/验证

| 用途 | 工具 |
|---|---|
| 协议单测 | `vitest` |
| 端到端 | `playwright`（两个浏览器上下文：房主 + 访客） |
| 抓包验证 E2E | 中继侧加"记录所有明文帧"的 debug 模式，断言抓不到明文 |

### 3.5 开源复用清单（2026-10-26 实测）

> ★ 数由 GitHub API 实时查询。许可证取 `license.spdx_id`；标 **NOASSERTION** 表示 GitHub 未能识别、或该仓库带附加条款，**引入前必须自己读 LICENSE**。

| 项目 | ★ | 许可证 | 在我们这里的角色 |
|---|---|---|---|
| microsoft/vscode | 194.3k | MIT | 不引入（是应用不是库），只当 UI 标杆 |
| coder/code-server | 79.7k | MIT | 不引入（宿主机发页面 = B 档） |
| anomalyco/opencode | 221.7k | MIT | 参考：终端 agent 的会话与工具卡渲染 |
| open-webui/open-webui | 156.8k | NOASSERTION | 不引入（Python+Svelte 整应用，且有品牌条款） |
| lobehub/lobehub | 83.5k | NOASSERTION | 不引入，理由同上 |
| cline/cline | 70.9k | Apache-2.0 | **UX 参考**：聊天流 + diff 卡 + 审批按钮（不抄代码） |
| microsoft/monaco-editor | 46.9k | MIT | **二期引入**：VS Code 编辑器内核 |
| LibreChat | 46.3k | MIT | 参考：多 provider 聊天架构 |
| CopilotKit/CopilotKit | 38.2k | MIT | 备选（生成式 UI，偏重） |
| continuedev/continue | 36.3k | Apache-2.0 | **UX 参考**：IDE 内聊天 + 自定义 provider |
| voideditor/void | 28.7k | Apache-2.0 | 参考：VS Code fork 内嵌 AI 的做法 |
| vercel/ai | 27.5k | NOASSERTION | **引入**：`useChat` + 自定义 `ChatTransport` |
| RooCodeInc/Roo-Code | 24.3k | Apache-2.0 | 备选 UX 参考 |
| eclipse-theia/theia | 21.7k | EPL-2.0 | 不引入（整套 IDE 框架，等于另起一个应用） |
| xtermjs/xterm.js | 21.3k | MIT | **引入**：终端 |
| loft-sh/devpod | 15.3k | MPL-2.0 | 不引入（环境管理，不是协作） |
| assistant-ui | 12.7k | MIT | **可选引入**：聊天 UI 组件 |
| codemirror/dev | 7.8k | NOASSERTION | **一期引入**：轻量编辑器 |
| cloudflare/agents | 5.9k | MIT | 中继范式参考（DO + 流式） |
| partykit/partykit | 5.7k | MIT | 中继范式参考（DO 房间模型） |

**结论：没有"整包可用"的成品。** 每个候选都只覆盖一半：

| 候选 | 有协作 | 有 AI | 有远程 IDE | 缺的那半 |
|---|---|---|---|---|
| Live Share（闭源） | ✅ | ❌ | ✅ | 无 AI |
| Cline / Continue / Roo | ❌ | ✅ | ❌ | 无房间、无中继 |
| code-server / Theia | ✅ | ❌ | ✅ | 宿主机发页面（B 档）；无 AI 协作 |
| partykit / cloudflare agents | ✅ | 部分 | ❌ | 无 IDE、无文件与终端 |
| **我们** | ✅ | ✅ | ✅ | 拼装，拼接点见 §3.6–3.8 |

### 3.6 IDE 归属：为什么不能"直接把 vscode 引进来"

四种放法，只有一种成立：

| 放法 | 引入什么 | 终端 | 分发 | 判定 |
|---|---|---|---|---|
| vscode.dev + Web 扩展（`FileSystemProvider` + chat webview） | 真 VS Code | ❌ **官方明确：Web 版不支持终端/调试器** | 要上 Marketplace | **排除**（排障必须要终端） |
| 房主跑 code-server，访客开浏览器 | 真 VS Code | ✅ | 房主装 | = B 档，已搁置 |
| **访客 DSH 当外壳 + 编辑器内核** | Monaco/CodeMirror + xterm | ✅ | 插件内 | ✅ **采用** |
| 引入 Theia 整套框架 | 整套 IDE | ✅ | 另起一个应用 | 排除（就不是插件了） |

依据：VS Code for the Web 的限制页明确写了浏览器环境**不支持终端**，需要终端就得用桌面版或 Codespaces。

**所以"给 IDE 装一个能调对方 DSH 的对话界面"这句话，落地时变成：**

> 不是"给 vscode 装扩展"，而是**"给 DSH 的 Web UI 装一个整页的远程工作区视图，里面放编辑器内核 + 终端 + 一个连到房主 Agent 的聊天栏"**。

### 3.7 流式输出不用自己写

AI SDK 的 `ChatTransport` 契约只有两个方法：`sendMessages(messages) → ReadableStream<UIMessageChunk>` 和 `reconnectToStream()`。

把房主 DSH 的帧直接映射进去：

| 房间帧（来自房主） | AI SDK chunk |
|---|---|
| `session.follow` 的 `assistant-stream` text delta | `text-delta` |
| 工具开始 | `tool-input-start` / `tool-input-available` |
| 工具结果 | `tool-output-available` |
| turn 结束 | `finish` |

**关键红利**：`reconnectToStream()` 正好对应我们 §4.4 的 `lastSeq` 续传——断线重连的状态机不用自己写。

参考：Ably 的 [Custom WebSocket Transport for Vercel AI SDK](https://ably.com/blog/custom-transport-vercel-ai-sdk)（把 AI SDK 接到 WS 上的完整例子）。

### 3.8 承载面：DSH 的 slot 足够做"整页 IDE"

来自 `Slots.listSubTree` 实测：

| slot | kind | 用途 |
|---|---|---|
| `sidebar.panellist` | list | 左侧加一个图标入口 |
| **`main`** | keyed，`keyDomain` 开放 | **挂整页主面板**，与 Plugins 页同级 |
| `conversation.view` | list | 在会话顶部加一个 Tab（如"远程"） |
| `shell.overlay` | list | 全屏浮层（倒计时、红条） |
| `settings.section` | list | 设置页 |

→ **"面板太简单"的解法不是换更大的库，而是改用 `main` + `sidebar.panellist` 做整页视图。**

⚠️ 但 `conversation.chat.node` 要求本地会话日志里存在对应事件；远端流不在本地日志，且我们不允许往 Session 追加未知事件类型。所以**不要**把远端消息塞进 `chat.node`，走 `main` 面板或 `conversation.view`。



---

## 4. 关键机制设计

### 4.1 连接拓扑

```
        ┌──────────────┐   出站 WSS (443)    ┌──────────────┐
        │ 房主 DSH     │ ──────────────────► │              │
        │ Host 插件    │   已加密房间帧       │    Relay     │
        └──────────────┘                     │  （哑管道）   │
                                             │              │
        ┌──────────────┐   WSS               │              │
        │ 访客的 DSH   │ ◄──────────────────►│              │
        │ Guest 面板   │                     │              │
        └──────────────┘                     │              │
                                             │              │
        ┌──────────────┐   WSS               │              │
        │ 访客浏览器   │ ◄──────────────────►│              │
        │ 静态 SPA     │                     └──────────────┘
        └──────────────┘
```

- 房主 → 中继：**一条**常驻出站 WSS，可复用于多个房间；
- 访客有两种形态（自己的 DSH / 中立静态 SPA），**协议完全相同**，中继不区分；
- **房主的 `50069` 不参与**；插件不注册任何 HTTP 路由（除非启用 §2.5 的 B 档）；
- 中继只在 `roomId` 内转发帧，不做解析（E2E 后它也无法解析）。


### 4.2 握手时序

```
房主                                       中继                          访客
 │  POST /rooms (create)                     │                              │
 │  ← { roomId, hostSecret, roomKey(32B) }   │                              │
 │  WSS /host  (roomId + hostSecret)         │                              │
 │ ────────────────────────────────────────► │                              │
 │  ← host-ready                             │                              │
 │                                           │  GET /r/<roomId>#<roomKey>   │
 │                                           │ ◄────────────────────────────│
 │                                           │  (fragment 不会发到服务端)    │
 │                                           │  WSS /guest (roomId, proof)  │
 │                                           │ ◄────────────────────────────│
 │  ← guest-joined { guestPub, proof }       │                              │
 │  ──── X25519(hostPriv, guestPub) ────►    │  同一密钥                   │
 │  ← room frame (AES-GCM, aad=roomId|seq)   │ ────────────────────────────►│
```

要点：

- **`roomKey` 放 URL fragment**（`#` 之后），浏览器不会把它发给服务器，中继日志里永远没有；
- 访客首次连接做一次带 proof 的握手（proof = `HMAC(roomKey, roomId|nonce)`），中继只做**转发**给房主校验，自己验证不了；
- 密码（可选）不参与加密，只是**第二道门**：房主侧用 `scrypt`/`argon2` 哈希保存，校验在房主侧做，中继只看到 `wrong-password` 失败计数。

### 4.3 复用 DSH 的三个事件源（这是省力的关键）

| 房间视图 | DSH 能力（本地已验证签名） |
|---|---|
| 会话实时流 + 打字机 | `sessionController.follow(request, signal)`：先 `snapshot`，再持续推 durable 事件帧与 `assistant-stream` 帧 |
| 历史翻页 | `sessionController.page(request, signal)` |
| 文件树 / 文件内容 | `workspaceFiles.list` / `read` / `readBytes` / `stat` |
| 目录实时变化 | `workspaceFiles.changes(scope, path, signal)`（流） |
| 每轮改动与 diff | `workspaceChanges.summary(sessionId, seq)` / `.diff(...)` |
| 真终端（M3） | `terminalController.attach(agent, id, signal)` → `RemoteStream<TerminalFrame, TerminalInput>` |
| 访客身份 | `connection.createPeer({ principal })` |
| 权限裁决 | `remoteAccess.registerPolicy` / `decide` / `follow` |
| 危险操作拦截 | `tools.guard` / `tools.pre-execute` |
| 审计素材 | `tools/result`（最终工具结果）、`session/event` |

**结论：房间协议基本是「把上面几个流按访客权限裁剪后转发」，不是从零实现协作引擎。** 这决定了 M1 的工作量主要在权限与 UI，而不在"怎么同步"。

### 4.4 断线续传

- 每个帧带单调 `seq`；访客重连时携带 `lastSeq`；
- 房主侧为每个访客维护一个**有界环形缓冲**（比如 2000 帧 / 5 MB，超了丢最旧并置 `hasGap: true`）；
- 有 gap 就回退到 `sessionController.page` 重新拉快照，而不是逐帧补；
- 这也是 Live Share 类产品的常规做法：**事件流可重建，所以断线不是灾难**。

### 4.5 背压与限流

- 服务端 `ws.bufferedAmount` 超过阈值（如 1 MB）→ 暂停该访客的上游订阅（`sessionController.follow` 用 `signal` 取消，重新 attach 时带 cursor）；
- 终端输出是**最凶的**：`npm run build` 一秒能吐几 MB。必须做**服务端聚合 + 采样**（例如 > 200 帧/秒时合并为一批，或降级成"每 100ms 一帧"）；
- 每访客令牌桶：`{ framesPerSec: 200, bytesPerSec: 512KB }`；
- 中继侧同样限流，防止一个房间打满整机带宽。

### 4.6 端到端加密

```
密钥派生：X25519 ECDH → HKDF-SHA256 → 每方向独立的 AES-256-GCM key
帧格式：  [1B version][8B seq][12B iv][ciphertext][16B tag]
AAD：     roomId | direction | seq   （防重放、防跨房间重放）
```

- 轮换：每 N 帧或每 10 分钟重新 ECDH（可选，M2 再做）；
- 中继**永远拿不到** `roomKey`，因此无法解密；它只看到 `roomId`、帧长度、时间戳；
- 代价：中继无法做内容级风控（这正是设计意图，滥用治理靠"房间数与流量"这层元数据）。

### 4.7 权限模型（两层，不可合并）

```
访客能力（房间层）                  协助会话能力（Agent 层）
├─ canViewSession                  ├─ fs.read  : 允许路径集合
├─ canViewFiles (path allowlist)   ├─ fs.write : 允许路径集合 + 是否需房主确认
├─ canComment                      ├─ exec     : off / allowlist / full
├─ canRunTerminal (readonly|input) ├─ network  : off / allowlist
├─ canProposePatch                 ├─ plugins  : 是否允许调用 bilibili/qq 类工具
└─ canCancelOwnRun                 └─ secrets  : 永不可读
```

- 默认值：`canViewSession` + `canViewFiles(白名单)`，其余全关；
- **第二层由 `tools.restrict()` / `tools.guard()` 落在 Agent 的 `ctx` 上**，不是靠提示词说"请不要改文件"；
- 子 Agent 必须继承同一份限制（否则一句"帮我 spawn 个 subagent"就绕过了）。

---

## 5. 协议草案（v0）

传输：WebSocket 二进制帧，帧头 4 字节（`type` 1B + `flags` 1B + `len` 2B），body 为 AES-GCM 密文。

### 5.1 控制帧（房主 ↔ 访客）

| type | 方向 | 字段 | 说明 |
|---|---|---|---|
| `hello` | G→H | `proto`, `roomId`, `proof`, `nonce` | 访客首帧，含挑战证明 |
| `welcome` | H→G | `selfId`, `roomMeta`, `capabilities`, `theme` | 能力清单 + 主题 token 快照 |
| `reject` | H→G | `code`, `message` | `wrong-password` / `room-closed` / `capability-missing` |
| `capability` | H→G | `capabilities`, `revision` | 房主改权限，实时推送 |
| `presence` | 双向 | `members[]` | 在线成员与身份标签 |
| `focus` | H→G | `target`, `revision` | 镜头模式：房主当前在看什么 |
| `bye` | 双向 | `reason` | 主动断开 |

### 5.2 数据帧（房主 → 访客，只读投影）

| topic | 载荷 | 来源 |
|---|---|---|
| `session.follow` | `{ sessionId, snapshot \| event \| stream }` | `sessionController.follow` |
| `session.page` | `{ sessionId, records, hasMore }` | `sessionController.page` |
| `session.projections` | `{ sessionId, values }` | 投影快照 |
| `files.change` | `{ path, kind }` | `workspaceFiles.changes` |
| `files.diff` | `{ path, oldText, newText }` | `workspaceChanges.diff` |
| `terminal.data` | `{ terminalId, bytesBase64 }` | `terminalController.attach` |
| `approval.pending` | `{ callId, tool, args, diff? }` | `tools/pre-execute` |

### 5.3 动作帧（访客 → 房主，全部要过能力检查）

| action | 需要的 capability | 备注 |
|---|---|---|
| `comment.post` | `canComment` | 消息带 `author: guest:<name>` 前缀进入会话 |
| `patch.propose` | `canProposePatch` | 只登记，不落盘 |
| `patch.apply` | **房主专属** | 访客不能给自己签字 |
| `terminal.input` | `canRunTerminal: 'input'` | 房主可随时改回 readonly |
| `run.cancel` | `canCancelOwnRun` | 只能取消自己发起的 |
| `file.read` | `canViewFiles(path)` | 路径校验在房主侧 |

> 规则：**授权类动作（授予权限、应用补丁、放宽沙箱）永远只属于房主**，不给访客、也不给 Agent。这与 DSH 自身的 "approval is user-only" 一致。

---

## 6. 带宽与容量估算

以下为**按帧结构推算的量级估计**，M0 用真实会话实测校准。

| 数据 | 峰值 | 平均 | 备注 |
|---|---|---|---|
| 会话事件流（文本） | 20 KB/s | 2–5 KB/s | token 流，压缩后更小 |
| 文件 diff | 50 KB/次 | — | 大文件需截断 |
| 目录变更 | 1 KB/s | — | 只在改动时推送 |
| 终端输出（普通命令） | 200 KB/s | 1 KB/s | 空闲时接近 0 |
| 终端输出（构建日志） | 2–5 MB/s | — | **必须限流聚合** |
| 真终端全天基线 | — | 5–20 KB/s | 交互式使用 |
| **对比：1080p30 投屏** | — | **250–600 KB/s（2–5 Mbps）** | 结构化方案低 1–2 个数量级 |

容量结论（数量级）：

- 一条中继节点，10 KB/s 级的房间流，带宽不是瓶颈，**连接数与帧率**才是；
- 一个房间 1 房主 + 5 访客，正常排查场景 **< 100 KB/s**；
- 真正要治理的是**终端日志**和**大文件 diff**，不是会话流。

---

## 7. 安全清单（M1 必须全绿）

- [ ] 邀请令牌一次性 + 短期（默认 2h，可延长）；房间关闭即失效；
- [ ] `roomKey` 只出现在 URL fragment，服务端日志、Referer、中继均不可见；
- [ ] 访客身份独立（`createPeer` 非 owner），**不复用房主登录态**；访客看不到房主的其他会话/工作区；
- [ ] 密码用 `scrypt`/`argon2` 哈希，失败计数 + 指数退避；
- [ ] 路径校验在房主侧做，拒绝 `..`、符号链接、UNC、大小写变体；**不做字符串前缀比较**；
- [ ] 访客动作有独立审计：谁、何时、对哪个资源、结果如何；
- [ ] 撤权是"立即生效"：断开流 + 取消订阅 + 中继侧踢连接；
- [ ] 传输全景：访客 ↔ 中继 = TLS；中继 ↔ 房主 = TLS；**端到端 = X25519 + AES-GCM**；三层独立；
- [ ] 房间结束分两级：`断开访客` / `结束协助并停止任务`，且如实报告残留进程；
- [ ] 不落盘：中继不存帧内容；房主侧审计只存元数据 + 摘要。

---

## 8. 里程碑

| 阶段 | 内容 | 验收标准 |
|---|---|---|
| **M0 打通链路**（1–2 天） | 宿主插件只做出站 WSS；中继用 `wrangler dev` 跑本地（Workers + DO，先不部署）；访客端用 50 行静态 HTML 握手；中继 debug 模式断言抓不到明文 | 两个浏览器上下文经中继互发一句话；房主 `50069` 无任何新增路由；`wrangler dev` 下 DO 路由生效 |
| **M1 只读房间** | `main` 整页视图 + `sidebar.panellist` 入口；会话 follow 流 + 文件树 + 能力清单 + 审计列表 + 邀请/密码/过期 | 访客在自己的 DSH 里看完一次排查全过程 |
| **M2 互动** | 聊天（AI SDK `useChat` + 自定义 `ChatTransport`）、留言、补丁提议、房主审批、权限实时变更、镜头模式、断线续传 | 访客在聊天里发一句，房主 DSH 的 Agent 收到并流式回传 |
| **M3 终端** | xterm.js + PTY 流 + 只读/可输入切换 + 二次确认 + 限流 | 构建日志不卡死页面，输入切换有明显标识 |
| **M4 编辑器** | 一期 CodeMirror（可编辑）→ 二期 Monaco（VS Code 观感）+ diff editor | 访客能在远端改一个文件并由房主审批 |

---

## 9. 未决问题（需要实测/讨论）

1. **B 档才需要担心的 Host/Origin 校验**：真要把 `50069` 暴露给访客时，隧道域名的 Host 头不是 `127.0.0.1`，`connection` 的 `requestRejection` / `allowsRemoteAuthorities`（仅当 `trustedHosts` 含校验过的非 loopback 主机名时为 true）会不会拒绝？C/A′ 两档不涉及，可延后。
   - 若要做 B 档，三条路子：① 配置 `trustedHosts`；② 房间路由绕开 Connection 的 index 校验、自做访客令牌；③ 独立端口起极简 HTTP。倾向 ②（房间本就不该复用房主登录态）。
2. **访客页能不能复用开源 repo 的组件**：公开仓库的版本（教程提到 `0.1.0-rc.6`）与本地 `0.2.1-rc.2` API 是否兼容？只抄样式还是也抄逻辑？
3. **模型费用归属**：访客发起的会话烧的是房主的 token。要不要每房间设预算上限、或强制走访客自带 API Key？
4. **多访客同时改**：直接上 Yjs，还是先做"写入租约 + 排队"？我倾向后者（简单、可解释）。
5. **国内中继合规**：自建中继对外提供服务是否需要备案/资质，规模化前要确认。
6. **终端输入的真实风险**：给了终端输入，等于给了任意命令；是否只允许"房主在旁"时开放？

---

## 10. 参考链接

**Live Share**
- https://learn.microsoft.com/en-us/visualstudio/liveshare/reference/connectivity
- https://learn.microsoft.com/en-us/visualstudio/liveshare/reference/security
- https://code.visualstudio.com/blogs/2017/11/15/live-share
- https://learn.microsoft.com/en-us/visualstudio/liveshare/faq

**协作产品**
- https://www.jetbrains.com/help/ide-services-cloud/getting-started-with-codewithme-for-business.html
- https://github.com/coder/code-server

**终端共享**
- https://github.com/tsl0922/ttyd
- https://github.com/yudai/gotty
- https://tmate.io/
- https://github.com/xtermjs/xterm.js

**传输与加密**
- https://developers.cloudflare.com/tunnel
- https://github.com/fatedier/frp
- https://docs.yjs.dev/api/about-awareness
- https://doc.libsodium.org/

**DSH**
- https://github.com/deepseek-ai/deepseek-harness

---

_本文档为调研稿；标 ⚠️ / "待验证" 的条目均需在 M0 阶段用真实环境确认后再落代码。_
