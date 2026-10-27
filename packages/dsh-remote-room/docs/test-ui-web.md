# 真实 Web UI E2E

## 范围与运行方式

`scripts/e2e-ui-web.mjs` 用支持的 `dsh --profile web` CLI **仅启动**独立 Web fixtures；不预先调用 `plugin add`、不写 profile manifest、不调用私有安装 API。Playwright 从项目根的 `playwright` dev dependency 导入，默认启动可见的自有 Chromium，不 attach agent browser、Desktop 或当前 GUI `http://127.0.0.1:53420`。CLI token 只来自本次 owned child stdout，在内存中交给自己的 browser context 导航，不打印认证 URL、cookie 或邀请。

```powershell
& 'C:\Users\J\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe' scripts/e2e-ui-web.mjs --mode install
& 'C:\Users\J\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe' scripts/e2e-ui-web.mjs --mode journey --deadline 540000
```

`--help` 列出 `--cli`、`--package`、`--sha256`、`--deadline`、可选 `--visual` 和显式 `--headless`。`--visual` 在已授权远程预览上通过真实 Settings → General → Dark / Light 改主题，读取实际 theme DOM 标志后截图 1440 宽两种主题及 1100 宽浅色；它不注入样式或主题 store。默认 artifact 为 `artifacts/local-dsh-remote-room-0.1.2.tgz`，预期 SHA-256 为 `36a24181a7378670a9340794b6ccca88f36858ad0e0eb415a3cf59aaf806d5fe`；其它包必须同时提供匹配的 `--package` 和 `--sha256`。依赖和浏览器安装由主 agent 管理，runner 不安装依赖。

`install` 从干净临时 home 开始，真实点击 Preview Notice → Continue、Get started → Close（不填写虚假 key），再点击 Plugins → Add plugin，textbox 填 **Host 绝对 tarball 路径**，点击 Install → Enable now。通过标准不是 toast：必须进入 Settings → Remote room，看到标题、空连接状态及真实表单。

`journey` 使用两个独立 `DSH_HOME` 与两个 browser contexts、同一份 hash 验证的 tarball，再走表单创建邀请、加入、批准、会话右侧文件预览和确认撤权。此模式通过支持的 `--patch` 使用官方 in-page directory-picker overlay 的同等 disable/insert 内容，明确属于 **测试 fixture**，不是 native picker 覆盖。relay 也是 owned loopback transport fixture，不替代 DSH launcher。没有 model API 调用，不声称 UI 编辑保存或 Agent 工具写入。

## 隔离、安全与清理

- 每次 `mkdtemp(dsh-room-ui-web-*)`，独立 HOME / USERPROFILE / APPDATA / LOCALAPPDATA / TEMP / TMP / DSH_HOME / DSH_AGENTS_HOME / npm config/cache；仅继承显式 OS allowlist，driver 普通 Node 位于子进程 PATH 首位。无 `.env`、模型 key、当前 profile 或代理环境继承。
- CLI help 验证 `--profile` / `--patch` / `--port` / `--no-open`；每端都从自己 child stdout 发现 loopback ephemeral URL，明确拒绝 53420。
- 有 action/navigation/readiness/总 deadline；无 trace、HAR 或 video。截图一律 mask 所有 textarea 和 `.rr-invite`；DOM 故障记录不读取表单值。邀请只在内存中用于真实 textbox 填入。
- owned PID 使用父子树与进程创建时间跟踪；teardown 先正常关闭 owned Chromium，再仅对本次树 taskkill `/PID /T /F`，最后验证已记录 PID + 创建时间不再存在。Web Host 的强制树停止是 **teardown**，不是已验收 graceful Quit。
- 失败保留本次临时 home 和 evidence；只有全部 owned trees 验证停止且用 realpath 校验本次 owned root 后，成功场景才删除已知 `host` / `guest` / `browser` 数据子目录。evidence 保留，不能删除未知或仍可能存活的用户数据。

## 实际执行记录（2026-10-26）

环境：Windows；普通 Node `v24.21.0`；支持 CLI `D:\J\dsh\resources\runtime\cli\bin\dsh.cmd`（内部 Electron Node-mode 是 Web carrier，**不是 Desktop UI**）；根依赖 Playwright `1.64.1`，真实可见 Chromium。artifact SHA-256 如上。参考源码仅用于定位，不视为当前 runtime guarantee。

| Run / evidence 根 | Launch / attach | Install / enable | UI journey | Teardown |
| --- | --- | --- | --- | --- |
| `C:\Users\J\AppData\Local\Temp\dsh-room-ui-web-HVb7bQ\evidence` | own Web + visible Chromium 成功 | not-reached；Preview Notice mask 拦住 Plugins click | not-reached | owned trees 已停止、birth-time 验证；失败数据保留 |
| `C:\Users\J\AppData\Local\Temp\dsh-room-ui-web-uGyxaO\evidence` | own Web 成功 | not-reached；Continue 后 Get started modal 拦住点击，后确认存在标准 Close 按钮 | not-reached | owned trees 已停止、birth-time 验证；失败数据保留 |
| `C:\Users\J\AppData\Local\Temp\dsh-room-ui-web-OkVZt3\evidence` | **通过** | **通过**：全程真实 UI 安装 / 立即启用 / Remote room 空连接页面 | install 模式未执行 | **通过**：owned trees 停止验证；已停止 homes 删除，evidence 保留；exit 0 |
| `C:\Users\J\AppData\Local\Temp\dsh-room-ui-web-wTameB\evidence` | 两端通过 | 两端 UI 安装 / 启用通过 | 创建前 runner 精确 `getByLabel(Access boundary)` 未匹配 wrapping select；已改为 role=combobox；业务 not-reached | owned trees 已停止、birth-time 验证；失败数据保留 |

短金线已通过的截图：`host-install-input.png`、`host-installed-disabled.png`、`host-enabled-settings.png`，机器可读结果为同目录 `result.json`。前两次失败是实际首次引导的 UI 探索，不是插件安装故障，也没有用 API 或虚假 key 绕过。

### 双端业务已运行，发现真实状态同步缺陷

| Artifact / evidence 根 | Launch / install | 实际到达的业务阶段 | 失败与未到达阶段 | Teardown |
| --- | --- | --- | --- | --- |
| `0.1.2` / `C:\Users\J\AppData\Local\Temp\dsh-room-ui-web-pu7Wxy\evidence` | 两端真实 UI 安装 / 启用通过 | 主机表单 Create invitation、访客表单 Request access 已点击；访客可见 Authenticating | 等待 pending 40 秒超时；批准 / preview / revoke 未到达；当时未加 backend 只读诊断，不能仅据截图归因 TLS | 已停止与 birth-time 验证，失败数据保留，exit 1 |
| `0.1.3` / `C:\Users\J\AppData\Local\Temp\dsh-room-ui-web-381GpY\evidence` | 两端真实 UI 安装 / 启用通过 | 同上；失败时通过 own authenticated context 的只读 `action:state` 诊断，**Host 与 Guest 后端均为 pending / revision 3** | 两端真实 DOM 仍显示 Authenticating；因此是 UI 状态推送未更新，不是已证明 TLS 配对失败。批准 / preview / revoke 未到达；不得称业务通过 | 已停止与 birth-time 验证，失败数据保留，exit 1 |

`0.1.3` SHA-256 为 `076745b703c3949880ef4c767cf0b2e8e161dc8297a31416d81840907b44be04`，使用命令为上方 journey 命令另加 `--package artifacts/local-dsh-remote-room-0.1.3.tgz --sha256 076745b703c3949880ef4c767cf0b2e8e161dc8297a31416d81840907b44be04 --deadline 600000`。诊断文件 `host-state-diagnostic.json` / `guest-state-diagnostic.json` 只保存 rooms snapshot，不含邀请；`host-failure.png` / `guest-failure.png` 均遮盖 textarea 与邀请区域。console 记录有两条 HTTP 400，但该次未采集 pathname，**不能声称 400 已确认为 SSE endpoint**；后续 runner 已增加仅 pathname / method / status 的失败网络记录与 events content-type 记录。源代码修复归主 agent，本 runner 不改 `src/`。

### `0.1.4` 完整 Web/Web 金线已通过

SHA-256：`c80f9e18c18e9d3a6260ea4d5f224d5a005e33d13b3d2b8c3465ea2c9ca84d0e`。实际命令：

```powershell
& 'C:\Users\J\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe' scripts/e2e-ui-web.mjs --mode journey --deadline 600000 --package artifacts/local-dsh-remote-room-0.1.4.tgz --sha256 c80f9e18c18e9d3a6260ea4d5f224d5a005e33d13b3d2b8c3465ea2c9ca84d0e
```

修复归主 agent：GET events route 原先错误声明 `requestBody: streaming`，当前 DSH HTTP bridge 会给 GET 构造带 body 的 Request，导致 400。改为 buffered 是请求体处理修复，不改变 SSE response 流。`0.1.4` 运行明确断言两端 events 返回 HTTP 200 / `text/event-stream`，并观察 UI 自动从 authenticating 进入 pending，没有 Refresh / polling fallback。

| Evidence 根 | Launch / install | UI journey | Teardown |
| --- | --- | --- | --- |
| `C:\Users\J\AppData\Local\Temp\dsh-room-ui-web-qKWwfx\evidence` | 两端 UI 安装 / 启用通过；SSE 200 | Create / Join / pending / 无批准前文件树 / Approve / Authorized + shared.txt listing 通过；runner 对 New Session 后 sidebar 使用 racy `isVisible`，漏点 Open right sidebar，再等 New tab 超时；preview / revoke 未到达 | 已停止验证，失败数据保留，exit 1 |
| `C:\Users\J\AppData\Local\Temp\dsh-room-ui-web-Ir7aWL\evidence` | **两端干净 home、可见 own Chromium、真实 UI 安装 / 启用与 SSE 200 通过** | **全程通过**：Create invitation → Request access → 两端自动 Awaiting approval，访客无文件树 → Approve connection → Authorized + 无操作错误 → 真实 New Session → Open right sidebar → Remote room guide → shared.txt → 精确 seed `remote-ui-golden-seed-2026` 可见 → Revoke confirm 先取消再批准 → guest retained snapshot 明示 stale，Reload file disabled | **owned trees 停止 / birth-time 校验通过**；停止后移除 homes，evidence 保留；exit 0 |

已读并核对关键截图 `guest-file-preview.png` 与 `guest-revoked-preview.png`：前者显示独立远程源 tab 中真实 seed，后者显示访问结束的保留快照提示和禁用 Reload file。还有 `host-pending.png` / `guest-pending.png` / `guest-authorized-settings.png`；截图均遮盖邀请输入。该次 `result.json` 无 pageErrors / consoleErrors / failedRequests 记录。右侧工作台可在空白 New Session 里真实打开，无需模型 key、发送消息或 API 创建会话。

没有声称：撤权后再次通过 Agent 工具读取的实际拒绝（本 runner 仅断言 UI stale + reload disabled）；UI 编辑保存；built-in local-file 与同名远程文件 coexistence；better-sidebar 兼容；Desktop 混合端业务。这些另有需要时单独覆盖。

`web-journey.mjs` 将 Web 首次引导拆成单独 `dismissFreshWebWelcome(page)`；`installAndEnable` 不假定 Desktop 也有这些弹窗。Desktop driver 可以复用后者，但本文件不代替其它 owner 的 native 运行报告。

### `0.1.5`：收紧侧栏 + 真实主题视觉

SHA-256 `8749705ed73e221e8038fae6ce708a1c2fdbf50e4e4c0a58679fe9170c157e14`，命令为 journey 加 `--visual --deadline 900000`，实际 `exit 0`。证据 `C:\Users\J\AppData\Local\Temp\dsh-room-ui-web-fgoLbR\evidence`；`result.json` 记录 `journey: passed create/join/approve/preview/revoke`，两端 `eventStreamResponses` 均为 `200 text/event-stream`，`visuals` 为 dark 1440 / light 1440 / light 1100 三项 `themeObserved: true`。

主题不是 mock：脚本在 Settings → General 中真实点击 Dark / Light，然后断言 `<body>` 的 `data-ds-dark-theme` 属性，再截图 `guest-preview-dark-1440.png`、`guest-preview-light-1440.png`、`guest-preview-light-1100.png`。已读图核对：远端工作台先显示连接与远端文件（`shared.txt`、27 B）和活动记录，把“Share or join another room”折叠在底部；远端 tab 标题为 `shared.txt` 而不是整条 Windows 路径；深色主题下工作台与原生 shell 的对比度一致。设置面板仍保留完整的创建/加入表单。

### 全权限 exec/PTY UI 场景（`--processes`）

`--processes` 在只读金线之后，用同一套真实 Settings 表单创建**第二个** `danger-full-access` 房间：主机填中继 / 共享根 / 权限并创建邀请，访客粘贴后申请，主机批准；随后全部操作都在真实执行面板中完成。

实际 `exit 0`（证据 `C:\Users\J\AppData\Local\Temp\dsh-room-ui-web-EpqOFV\evidence`，`result.json` 的 `journey` 为 `passed create/join/approve/preview/revoke/exec/pty`）：

| 断言 | 真实观察 |
| --- | --- |
| 普通命令 | 面板内以 JSON argv 启动 Host 上的 `node.exe`；`ROOM_STDOUT_OK` 与 `ROOM_STDERR_OK` 同时出现，状态显示 `Exited` / `Exit code: 7` / `PROCESS_EXITED` |
| Host-only 副作用 | 生成的 `host-exec-marker.txt` 在主机共享根读回为 `HOST_ONLY`；访客 `workspace` 下不存在该文件 |
| 真实 PTY | 选 `Real PTY` 后看到 `PTY_READY`（伴随 ConPTY 控制序列，按“可见文本”如实呈现）；`100×30` resize 成功；勾选追加换行后发送 `hello-room`，程序侧 `setRawMode` 收到字节并输出 `PTY_ECHO:hello-room`；`Terminate process` 弹出确认框，确认后状态变为 `Exited` |
| 撤权后 | 主机撤销该房间，访客执行面板出现 stale 提示且启动按钮禁用 |

驱动侧修正记录（均为测试代码缺陷，不是插件缺陷）：新模块曾把 `endpoints` 数组误当对象解构；该房间行挂载于 authenticating 阶段默认折叠，需先真实点击行头；argv 用 label 定位在切换通道后失效，改为结构选择器；PTY 原始脚本未开 `setRawMode`，ConPTY 行缓冲导致字节未交付；`Terminate process` 的阻塞式 confirm 必须先接受对话框再 await 点击。失败证据保留在 `dsh-room-ui-web-3g5wPP`、`dsh-room-ui-web-KhIFlW`、`dsh-room-ui-web-8phAfl`、`dsh-room-ui-web-aGVqtk`、`dsh-room-ui-web-EBW4oz`、`dsh-room-ui-web-2y6G4i`，其中两次的 `*-state-diagnostic.json` 证明第二个房间已是 `danger-full-access` + `authorized`。

未声称：`outputClosed` 的直接 UI 观察（面板通过禁用输入/终止、重新启用启动来间接体现）；UI 编辑保存；不同 room/epoch 的同一远端文件并存；better-sidebar 第三方兼容；Web Host ↔ Desktop Guest、Desktop ↔ Desktop。

### 最终分发包 `0.1.7` 一次性认证

`0.1.7` SHA-256 `24dbd611dffde1532ebf1b23089e19fb3119e970c5ef7fc46dea9114652cdc77`，一次运行同时开启 `--visual --processes`：

```powershell
& 'C:\Users\J\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe' scripts/e2e-ui-web.mjs --mode journey --visual --processes --deadline 900000 --package artifacts/local-dsh-remote-room-0.1.7.tgz --sha256 24dbd611dffde1532ebf1b23089e19fb3119e970c5ef7fc46dea9114652cdc77
```

实际 `exit 0`，证据 `C:\Users\J\AppData\Local\Temp\dsh-room-ui-web-Hhu14m\evidence`：

- `journey: passed create/join/approve/preview/revoke/exec/pty`，两端 `eventStreamResponses` 都是 `200 text/event-stream`。
- 该轮同时包含本地/同名远端共存、dark/light/1100 主题截图、第二个全权限房间的 exec 与真实 PTY，以及两次撤权。

历史记录：`0.1.6` 曾在同一组场景下通过（`dsh-room-ui-web-QUJYPv`），但之后仓库只改了文档与 README 就重新打包，字节随之变化；为避免 hash 与内容不一致，`0.1.6` 的 tarball 已删除，交付版为 `0.1.7`。`0.1.5` 的同场景通过证据为 `dsh-room-ui-web-fgoLbR`（视觉）与 `dsh-room-ui-web-EpqOFV`（exec/PTY）。某次同版本首次安装尝试曾在 150 秒未见 `Enable now`（`dsh-room-ui-web-KVO3HW`，失败数据保留），重试即通过，属安装耗时波动。

### 本地/同名远程文件共存

同一会话的右侧栏里，脚本先打开远端 `shared.txt`（Host 种子 `remote-ui-golden-seed-2026`），再通过内置 `Files` 入口打开访客**自己**工作区里的同名 `shared.txt`（会话内写入 `guest-local-seed-2026`）。断言：

- 内置 Files 面板的 `data-files-root` 必须位于访客自有 fixture home 之内（绝不允许出现 Host 目录）；
- 两个种子各出现一次，且交互检查：本地预览不含远端字节、远端预览不含本地字节；
- 撤权后远端标签进入 stale 且 Reload 禁用，而本地标签仍是 `data-textpreview-state="text"` 并保留自己的字节。

实际 `exit 0`：`C:\Users\J\AppData\Local\Temp\dsh-room-ui-web-K81m5e\evidence`，截图 `guest-local-and-remote-coexist.png` 清楚显示同一侧栏并列两个 `shared.txt` 标签，分别展示访客本地种子与 Host 远端种子。该截图也确认远端 tab 标题只显示 basename（0.1.5 起）。

Desktop / Desktop-Web / Web-Desktop / Desktop-Desktop、原生目录选择、真正 Quit、持久化重启、卸载目前均不在本 runner 已通过范围。
