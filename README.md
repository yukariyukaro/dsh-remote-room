# dsh-remote-room

让访客使用自己的 agent、模型和 API key 操作房主授权的文件与可选进程，不向访客公开房主的 DSH Web。

**0.3 已实现一键共享**：选目录、选权限、点「生成邀请」即可得到邀请，无需填写中继地址或根目录；房间名等于目录名，界面全中文。133 项回归（15 files）通过；`0.3.0` 在 DSH 0.2.1-rc.4 上通过真实 Web 旅程（`--mode journey --visual`，`dsh-room-ui-web-8CCvLE`）与真实 Plugins UI 安装（`--mode install`，`dsh-room-ui-web-RkI4hA`）。packaged Desktop 与 Web 的跨载体金线仍停留在 0.1.7 证据（`K4UWCU` / `kCRLyL`），Desktop 上的原生目录选择器也只有代码接入点，尚未做真实点击验收；Desktop ↔ Desktop、原生侧执行面板、Quit 菜单点击与持久化重启同样未覆盖。精确证据见 [开发状态](docs/development-status.md)。

## 能力与权限

两端各安装插件，通过两条出站 WebSocket 连接同一个中继。共享默认面向**非同网络**：中继地址填一次即被记住，也可以由插件 Config 的 `relayUrl` 预置；「同一局域网」档则由插件在房主进程内按需启动内置中继，不经过第三方。房主不新增常驻入站服务。
- 房主创建邀请，访客加入，TLS 身份认证后房主在本地 UI 批准一次。授权有期限，可随时撤销；创建与批准没有 agent 工具入口。
- `read-only`：共享根内读取；`workspace-write`：共享根内读写；二者都拒绝任意命令。`danger-full-access` 才允许整机文件与进程能力，其范围包括房主账户的网络权限，不是 cwd 沙箱或系统提权。
- 保留现有本地文件、命令工具和 `ctx.fs`，另加明确的 `remote_*` 工具。每次传入 room ID、epoch 和房主路径；断线、撤权、未知结果不会回落到访客机器，也不会自动重放写入或 stdin。
- 房主可以没有 agent/session；设置中的远程工作区入口可独立批准与撤权。文件在会话 sidebar 的远程工作台中打开。

## 远程文件与已有 sidebar

不覆盖 `file` 协议、不替换本地文件 tab、不改变 better-sidebar 的布局服务。远程地址使用独立身份：

```text
dsh-resource://remote-room-file/room/<id>/epoch/<epoch>/path/<逐段编码的房主路径>
```

专用预览 tab 支持有界 UTF-8 文本与 PNG/JPEG/GIF/WebP。Markdown、HTML、SVG 当前按源码显示，不执行；PDF 和其他二进制暂无渲染器。预览不会交给访客本地文件读取器，没有默认落盘缓存。撤权后已读取内容只能作为标记过期的快照，不能撤回已经被人或 agent 看到的数据。

## 安装与运行

开发目标是 **DSH 0.2.1-rc.3、Node >=24.9**。当前本机验证使用 Node 24.21.0 / OpenSSL 3.5.8；其他 OS 与运行时版本尚未形成支持矩阵。

```text
pnpm install --ignore-scripts
pnpm run typecheck
pnpm run test:e2e
pnpm run build
pnpm run check:package
```

运行 DSH 插件管理器安装构建后的项目目录。插件使用 DSH 的 `fs`、`subprocess`、`tools`、`connection` 与 `storage` 服务，要求实际的 rc.3 `SandboxedFileSystem`。审计默认使用已有 `json` KV backend；没有该 backend 时应显式配置，不能悄悄退化为无审计。中继部署启用创建门禁时，在房主插件 Config 中设置 `relayCreateToken`，不要将它附加到邀请或分发给访客。

选目录（原生选择器或手输绝对路径）、选权限、确认“谁能加入”（默认「跨网络」）、点「生成邀请」。跨网络时中继地址填一次即被记住，部署见 [docs/relay-deploy.md](docs/relay-deploy.md)；同一 Wi-Fi 场景切到「同一局域网」即可完全不经第三方。访客粘贴邀请、点「申请加入」，房主点「允许进入」。房间名自动等于共享目录名。

邀请包含高熵秘密，只交给受信任访客，不发布到日志、issue 或公开页面。生产地址必须 WSS；仅允许 literal loopback 与 RFC1918 私有地址使用纯 WS，因为中继只转发已由房间级 mTLS 密封的字节。

中继是独立部署单元，参见 [relay/README.md](relay/README.md)。同机与局域网场景由插件内嵌的 Node 中继承担，无需任何外部服务；跨网络场景可使用仓库内的 Cloudflare Worker + SQLite Durable Object 实现（部署步骤见 [docs/relay-deploy.md](docs/relay-deploy.md)），或任意自托管实例。Worker 实现尚未完成真实部署、休眠与压力验证，不应把本地结构恢复测试视为生产认证。

## 模块

| 目录 | 职责 |
|---|---|
| `src/security` | 原生 TLS 1.3 双向证书认证、房间凭证生成与精确证书 pin |
| `src/wire` | 有界 WebSocket Duplex、credit 与 framed RPC |
| `src/room-service.ts` | 房间、认证、grant epoch、过期/断线/撤销与资源生命周期 |
| `src/host` | 全入口文件授权、审计、主机进程与本地认证 UI bridge |
| `src/guest` | 显式远端工具、读前观察与版本 guard |
| `src/client` | 房间面板、远端预览与独立 resource/tab 注册 |
| `relay` | 不依赖 DSH 的中继服务 |
| `tests/e2e`、`tests/security` | 真实网络、真实 DSH provider、ToolRuntime 与安全拒绝测试 |
| `scripts/e2e-profiles.mjs` | 独立临时 DSH profile 的真实 CLI/Loader/HTTP 与 Agent 工具测试 |
| `scripts/e2e-ui-web.mjs` | 双隔离 Web 的真实安装、房间与会话点击旅程 |
| `scripts/e2e-ui-desktop.mjs` | 原生 Desktop 双根隔离、实际安装/启用、owned CDP 与进程回收；`--mode mixed`（Desktop 主机）/ `--mode mixed-guest`（Desktop 访客）与 Web 跨载体配对 |

## 测试口径与已知限制

局部 provider 测试和进程内两个端点测试，不等于完整已安装插件验收。测试按以下层次报告，避免混称：原生网络/TLS、真实 provider、真实工具流水线、独立 DSH profile、实际浏览器与已有插件共存。

文件操作逐组件拒绝符号链接/junction，并固定共享目录身份；仍有 canonicalize 到 syscall 的残余 TOCTOU，不承诺抵御房主本地恶意管理员并发置换。底层 DSH `listDir` 会先缓冲目录，返回条数限制不是底层无限目录内存保证。审计保存操作与原子结果元数据，不默认保存文件内容，不提供完整回滚。

邀请 v2 携带房间专用证书与私钥，TLS 双向验证与精确 pin 证明对方持有邀请凭证，不证明某个自然人身份。同一邀请的持有人可以冒充任一角色。浏览器 owner admission 排除独立 API owner，但不是“真人证明”，也不防恶意本地 agent 操控已登录的房主浏览器。

## 设计记录

- [实现计划 v6](docs/dsh-remote-workspace-plan.md)：原阶段方案；与实现变化以 ADR 和开发状态为准。
- [远程文件身份](docs/decisions/0001-remote-file-identity.md)
- [原生 TLS PSK 初选与弃用原因](docs/decisions/0002-native-tls-psk.md)
- [Desktop 兼容的双向 TLS](docs/decisions/0003-desktop-compatible-mtls.md)
- [真实 profile 验证](docs/test-profiles.md)
- [v5 冻结归档](docs/archive/dsh-remote-workspace-plan.v5.md)
- [只读参考索引](reference/README.md)
