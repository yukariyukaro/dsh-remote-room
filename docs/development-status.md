# 开发状态

目标：交付两端 DSH 插件，访客 agent 使用房主授权的文件、普通命令与 PTY，并具有与已有 sidebar 共存的远程文件预览。当前为开发版，完整 UI/发布验收未完成。

## 已实现

- Host/Client 分离的 npm bundle、Config、国际化 metadata、图标、构建与包检查脚本。
- 两条出站 WebSocket、严格消息 parser 限制、credit、有界 RPC、取消与结果未知语义、心跳和房间生命周期。
- 邀请 v2 与原生 TLS 1.3 mTLS，精确房间证书 pin，兼容 OpenSSL 与 Electron/BoringSSL，不降级认证。参见 ADR 0003。
- 三档 grant、房主单次批准、全入口文件授权、共享根身份固定、symlink/junction 拒绝、版本 guard、pull stream、元数据审计和 KV adapter。
- 保留本地工具和 fs，另加 remote_rooms/read/list/write/edit/exec/process/pty 八个明确目标工具。
- 仅 danger-full-access 可执行的真实 Host subprocess 与 PTY；有界输出、UTF-8 游标、缺口、stdin、resize、终止、到期和撤权回收。
- 独立 room/document sidebar 类型、无会话 settings 入口、远程文本/图片预览、普通进程/PTY 文本记录 UI，不替换本地 file provider 或 tab。

## 已实际运行的验证

统一使用 bundled Node 24.21.0。PATH Node 24.1.0 不满足 DSH 版本要求，不能用于验收。

| 层次 | 结果 | 说明 |
|---|---|---|
| 根 TypeScript | PASS | `node node_modules/typescript/bin/tsc --noEmit` |
| 集成与安全回归 | 106/106 PASS，11 files，20.95s | `vitest run`（含新增 20 项 Client 状态机单测）；真实网络、DSH provider、ToolRuntime、进程与 PTY，不等于真实桌面 UI |
| 原生 Host process/PTY | 14/14 PASS | Windows 实际分配 PTY，无 skip；包括 Unicode、isTTY、write/resize/kill、idle、子进程树撤权、审计故障 |
| 远端 process tools | 10/10 PASS | 真 ToolRuntime→双端→relay→subprocess；实际 PTY、unknown、escaped JSON 超限恢复 |
| v2 TLS 双运行时实验 | 各 7/7 PASS | Node/OpenSSL 与 Electron/BoringSSL；包括直接加载生产模块和密文篡改 |
| 0.1.1 独立 npm CLI profiles | PASS，exit0 | exact DSH rc.3、Node/OpenSSL，真实 tgz 安装、认证、批准/读写/版本/撤权；该包仍为旧 PSK 协议 |
| 0.1.1 原生 Electron carrier | FAIL | 安装/state 成功，BoringSSL NO_CERTIFICATE_SET；促成 mTLS v2，而非关闭验证 |
| 0.1.2 原生 Electron carrier profiles | PASS，exit0 | 新 mTLS 分发包，两真实隔离 web profile，经支持 CLI 安装；实际 agent read/write、旧 epoch 拒绝、撤权拒绝 |
| 已安装 carrier 执行/PTY | PASS，exit0 | 0.1.2 `--processes`；Host-only 磁盘标记、Unicode/exit7、真实 isTTY/write/resize/kill、撤权停止心跳并拒绝新执行 |
| Web 真实干净安装 | PASS | Plugins Add textbox → Install → Enable now → Settings Remote room；0.1.2–0.1.6 双端 |
| Web 自动状态同步 | 0.1.3 FAIL，0.1.4 PASS | 实际 E2E 找到 GET streaming request-body 声明导致 400；改 buffered 后两端 SSE 200，pending/批准/authorized/文件列表无需刷新 |
| packaged Desktop 原生安装/SSE | PASS，exit0 | 0.1.4 实际安装/启用/设置空态，并明确断言原生 scheme 的 SSE 200；双根隔离与 graceful owned cleanup；安装后截图局部超时如实记载 |
| Web/Web 只读完整点击金线 | PASS，exit0 | 0.1.4 双端 UI 安装→邀请/加入→pending→批准→会话右栏文件预览 exact seed→撤权取消/确认→stale/Reload 禁用；无 model/API 业务替代 |
| 0.1.5 侧栏收紧 + 主题视觉 | PASS，exit0 | 同一金线复跑；真实 Settings 切 Dark/Light 后断言 `<body data-ds-dark-theme>`，1440 dark/light 与 1100 窄宽截图；工作台先显示连接/远端文件，创建表单折叠到下方 |
| Client 连接状态机 | PASS，20/20 | 真实 `@deepseek-ai/dsh-client-store` 引擎；只有 SSE 快照确立“实时同步”，HTTP 初始化/刷新/变更后读取不再冒充或清除流状态 |
| Web 全权限 exec/PTY UI | PASS，exit0 | 第二个 `danger-full-access` 房间经真实表单创建/加入/批准；面板启动真实 Host 命令（exit 7、Host-only 标记）与真实 PTY（resize、显式 stdin、确认终止），撤权后面板 stale 且控件禁用 |
| 本地/同名远端共存 | PASS，exit0 | 同一会话侧栏并列两个 `shared.txt`：内置 Files 打开访客自有工作区（根必须在访客 fixture 内），种子互不串台；撤权后远端 stale、本地仍可读 |
| Desktop Host ↔ Web Guest | PASS，exit0 | packaged Desktop 原生窗口作主机，真实点击创建邀请/批准/撤权；隔离 Web profile 作访客完成安装、加入、远端预览与 stale（`dsh-room-desktop-report-K4UWCU`） |
| Web Host ↔ Desktop Guest | PASS，exit0 | 反向配对：Web 作主机创建/批准/撤权，原生 Desktop 作访客完成安装、加入，并在 New Session 侧栏真实打开远端 `shared.txt` 预览到精确种子，撤权后 stale 且 Reload 禁用（`dsh-room-desktop-report-kCRLyL`） |
| build / check:package / pack | PASS | `0.2.0`：类型检查、导出与 Client 语法校验通过；106/106 回归；真实 Web 金线 exit0 |

当前交付 artifact：`artifacts/local-dsh-remote-room-0.3.0.tgz`，SHA-256 `112e80443b6c3a1ee3039dbbb395a0abc5818520fc7c880a2e2012038de49c95`。该包在 **DSH 0.2.1-rc.4** 上通过 0.3 的真实 Web 证据：`--mode journey --visual`（两端 CLI 预置 profile，只跑产品 UI，`dsh-room-ui-web-8CCvLE`，exit0）与 `--mode install`（干净 home 单端点，真实 Plugins Add → Install → Enable now → 远程房间设置空态，`dsh-room-ui-web-RkI4hA`，exit0）。回归 `vitest run` 为 133/133（15 files）。

0.3.0 相比 0.2.0 的变化：**一键共享**。共享不再要求填写中继地址、根目录或权限下拉——选择目录（原生选择器或手输绝对路径）、选权限、点「生成邀请」即得邀请；「谁能加入」默认“仅本机”，由插件在房主进程内按需启动内置中继并自动写入邀请；房间名自动等于共享目录名并在授权握手中同步给访客；界面改为三段式（共享首页 / 邀请与批准 / 已连接工作台）且**全中文**；目录选择经 `uiWorkspace.pickDirectory()`，手输路径作为回退。真实旅程断言：邀请 URL 中的 relay 必须是 `ws://127.0.0.1:<端口>`、房名必须等于目录名、面板不得出现英文 UI 词汇。

P3 的调整：公网能力保留但**降级为可选**——「公网」档在界面填一次地址即被记住，`relay/` 仍提供可部署的 Cloudflare Worker/Durable Object 实现与 `docs/relay-deploy.md`，但不再把“每个房主都要有 Cloudflare 账号”当作前置条件；同机与局域网场景完全不依赖任何外部服务。

**仍以 0.1.7 证据为准的部分**：Desktop Host ↔ Web Guest（`dsh-room-desktop-report-K4UWCU`）与 Web Host ↔ Desktop Guest（`dsh-room-desktop-report-kCRLyL`）两向跨载体金线，以及 0.1.7 的 exec/PTY 记录 —— 这些运行发生在 0.3.0 的共享与界面改动之前，尚未在 0.3.0 上复跑。Desktop 上的原生目录选择器同样只有代码接入点，未做真实点击验收。`0.1.7` 的 tarball 与证据保留，但交付版本以 `0.3.0` 为准。

0.2.0 记录保留：`artifacts/local-dsh-remote-room-0.2.0.tgz`，SHA-256 `e325e5c8908799431051dfa59b6ecc04c0457553e3f8ef9a29cca30eb95e9ec0`，完整 Web 金线 `dsh-room-ui-web-r1FZG7`，当时回归 106/106。

0.1.2 验收 artifact SHA256：`36a24181a7378670a9340794b6ccca88f36858ad0e0eb415a3cf59aaf806d5fe`。后续源码或文档改动需重新构建/打包并记录新 hash，不能把这次 hash 当作任意新包的证据。

真实 carrier 验收命令：

```powershell
& 'C:\Users\J\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe' scripts/e2e-profiles.mjs --package artifacts/local-dsh-remote-room-0.1.2.tgz
```

使用 `D:\J\dsh\resources\runtime\cli\bin\dsh.cmd`，内部为 Electron_RUN_AS_NODE。所有测试 profile、端口、子进程树及临时目录在 exit0 前完成回收；不访问当前用户 profile 或模型 key。

## 当前应用与浏览器证据

当前真实 profile 曾安装 0.1.0，并经 plugin manager 确认 Host active、实时远端工具可调用、Client 设置 slot 注册。该事实不是 0.1.2 窗口验收，也不能说明旧 PSK 能在 Desktop 正常连接。升级与已安装 Client 重新加载仍需显式验证。

当前 GUI 的 agent 浏览器登录仍需用户处理，未读取用户 token 或代用其他 profile 凭证。隔离 fresh-profile E2E 不依赖这个登录：Web 双端已完成安装/启用、创建/加入/批准、会话右栏远端预览、本地与同名远端共存、撤权过期快照，并用真实主题切换截取 dark/light/窄宽；Web 侧全权限房间已通过真实 exec/PTY；packaged Desktop 完成安装/启用、设置、原生 SSE 200，并与 Web 双向跑通跨载体金线（Desktop 作主机、以及 Desktop 作访客并在原生侧预览远端文件）。详见 `test-ui-web.md` 与 `test-ui-desktop.md`。

## 尚需完成的发布阻断项

1. Desktop ↔ Desktop 配对；Desktop↔Web 两个方向都已通过（含原生侧远端文件预览），工具修改属于已安装 profile 混合链路，不能标为 UI 保存。
2. 不同 room/epoch 的同一远端文件并存与 better-sidebar 第三方面板；本地/同名远端共存已通过。
3. 执行与 PTY 的真实按钮点击已通过 Web/Web；**原生 Desktop 侧的执行面板**仍未覆盖，不能用已安装 profile 的工具驱动链路冒充。
4. disable/enable、卸载、升级/重启、持久审计磁盘重开与故障恢复。
5. 跨 OS 配对；生产 WSS 中继部署/压力。Cloudflare DO 仅候选，结构恢复测试不是实际部署验收。

## 已知约束

文件 canonicalize→syscall 仍存在房主本地恶意并发置换的残余 TOCTOU；底层 listDir 先缓冲整目录。审计只存元数据，不提供完整回滚。邀请证书私钥是共享 bearer credential，不能证明自然人身份，JavaScript 字符串不承诺可靠擦除。PTY UI 是有界文本记录与显式输入，不是 xterm 交互终端模拟器。
