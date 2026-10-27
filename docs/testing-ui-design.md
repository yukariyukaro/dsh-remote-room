# Web / packaged Desktop 真实 UI E2E 设计

本文是下一步实现依据，不是执行报告。调查日期：2026-10-26。本轮只读调查并新增本文；没有启动 Desktop、浏览器、服务或测试集群，没有安装插件、读取用户 profile / key / token，也没有操作当前 GUI `http://127.0.0.1:53420`。该 GUI 的浏览器待登录状态不作为测试环境。

## 1. 先确定测试对象与通过口径

建议保留三个层次，分别报告，不用其中一层的通过代替另一层：

| 层次 | 真实运行的部分 | 不应声称覆盖 |
| --- | --- | --- |
| 组件 / 协议 / provider 测试 | 明确的输入、状态、权限拒绝、网络及文件系统行为 | 分发包安装、完整 DSH、真人点击 |
| 已安装 profile 集成 | 支持的 `dsh` CLI、真实 profile、真实安装、真实 Host / Agent 工具执行 | 浏览器渲染、点击、Electron 原生窗口 |
| 真实 UI 用户旅程 | 上一层加真实 Web 或 packaged Electron renderer，通过界面安装、创建、加入、批准、预览、撤权 | 没有实际执行的模型推理、OS 原生对话框操作、生产互联网部署 |

Web 与 Desktop 不是两个独立业务实现：Desktop 加载共享 Web 应用，但另有自定义协议、preload、原生窗口、目录选择、运行时及退出行为。因此 UI 业务流程共用，启动器与原生场景分开。

**最小金线**：两个独立端点使用同一份不可变 `.tgz`，在 Plugins 中安装并启用；房主用 Settings 中远程工作区表单创建邀请，访客用表单加入；房主核对并点击批准；访客在会话右侧工作台浏览并打开房主文件；房主点击撤权并确认；访客看到失效状态且不能再次读取。每个变化均有可见断言，文件操作另有房主临时文件断言。

首个实施版本不伪造“通过 UI 编辑文件”：当前远程预览是只读的（`src/client/Preview.tsx:1,69-74`），文件列表只有进入目录和打开文件（`src/client/RoomPanel.tsx:54-73`）。写入用现有真实 Agent 工具 observer 单独断言，报告为“UI 批准 + 服务驱动工具写入”，不叫“UI 编辑保存”；未来若增加编辑器再单列真实 UI 保存场景。

## 2. 既有脚本能复用什么

现有 `scripts/e2e-profiles.mjs` 是集成测试，不应改名冒充点击测试。可在之后实现中提取小范围共用 helper，但本轮不改代码。

| 可复用能力 | 精确位置 | UI runner 的使用方式 |
| --- | --- | --- |
| 唯一临时根、owned root 校验 | `scripts/e2e-profiles.mjs:26-28,205-216` | 所有数据只属于本次运行；退出失败保留根，不删可能仍在使用的数据 |
| 环境 allowlist 与双 home | `:39-50,223-226` | 不扩散当前 `DSH_PROFILE*`、模型凭证、`.env`、代理或用户 npm 配置 |
| 固定普通 Node 执行路径 | `:45,68-78,235-249` | driver 必须用 Node >=24.9，子进程 PATH 首位为 driver 的 Node |
| 支持入口 help 探测 | `:251-256` | CLI Web 继续先检查 profile / plugin / port 参数 |
| 同一 artifact 复制与 SHA-256 | `:257-265` | 安装的必须是相同字节；不可用源码 link 替代待验收包 |
| 自有 Web readiness 与认证 | `:133-155,275-277` | 浏览器导航到**本次子进程**给出的 URL；token 只在内存，日志只记 origin |
| 真 Agent 工具 observer | `:165-203,269-274,325-335` | 限集成 / 混合场景；绝不替代创建、加入、批准、撤权这些 UI 点击 |
| deadline、finally、owned PID tree | `:52-66,205-219,339-344` | 增加 Desktop 正常退出阶段，再保留精确 owned tree 强制兜底 |

已有 `installed` 模式通过 CLI `plugin add <owned.tgz>` 安装；`overlay` 模式明确不是安装（`:257-265,272,338`）。UI 安装金线必须从空白临时 profile 出发，不能提前 CLI 安装后再截图冒充 UI 安装；CLI 安装可作为“已安装环境点击功能”的较快独立用例。

已有旧 artifact 的独立 Node / OpenSSL 全链路通过、Electron / BoringSSL PSK 失败，记录于 `docs/test-profiles.md:66-78`，属于旧协议历史证据。主 agent 在本文收尾时另报告 mTLS native-carrier profiles 已通过；具体命令、hash 与输出由其执行报告负责，本文没有独立复跑。无论 native-carrier 集成是否通过，都不代表已启动 packaged Desktop 原生窗口或通过 UI 点击验收。

## 3. packaged Desktop 的隔离启动：有依据的待验证方案

### 3.1 已核验的事实

只读参考源码根为 `reference/deepseek-harness/`，本次 HEAD 为 `22ddee3792402c3e70ec5f86a63c3e3e895a2f60`。下文 `DSH/` 表示这个根，行号均以该只读快照为准。

本机已安装应用为 `D:\J\dsh\DeepSeek Harness.exe`；读取的应用 manifest `D:\J\dsh\resources\app.asar\package.json:2-8,25-26` 标识 Desktop `0.2.1-rc.3`、入口 `lib/main.js`、构建 commit `be72761ee1a6736ebcdf4f3739363b083ae53c98`、非 dirty。参考 HEAD 与安装构建不同，不能仅凭参考源码声称当前 exe 已通过启动 / attach 验证。Electron 44.7.0 是本次调查的指定运行时目标。

- Desktop 固定拥有 `resolveDshHome()/profiles/desktop`，没有查到任意 `--profile <name>` 的 Desktop UI 选择器。依据：`DSH/apps/desktop/src/paths.ts:17-21`、`src/main.ts:319-331`。因此两端隔离要换 `DSH_HOME`，不是让两个窗口共享同一 home 再取不同 profile 名。
- `DSH_HOME` 与 Electron userData 是两种独立状态；只换前者不够。userData 保存快捷键、桌面设置、首次隐藏确认等，并参与 Electron 单实例归属。依据：`DSH/apps/desktop/README.md:87,118,296`，`src/single-instance.ts:16-25`，`src/main.ts:1374-1376`。
- `DSH_DESKTOP_USER_DATA_DIR`、`DSH_DESKTOP_RENDERER_DEBUG_PORT` 是 **development launcher** 读取的变量：`DSH/apps/desktop/scripts/dev.ts:59-90` 把它们翻译为 Electron 原生 switches。没有找到 packaged main 读取这两个变量的实现，不能只设置这些 env 就声称 packaged 已隔离或已启用 CDP。
- DSH 的开发启动器确实传 `--remote-debugging-port=<port>` 和 `--user-data-dir=<path>`，但它启动的是开发应用；直接拿它的结果不能算 packagedDesktop 覆盖。
- packaged Desktop 的 Host 使用 Electron Node-mode 子进程是产品自身实现，允许保留；**顶层 UI launcher** 不能设置 `ELECTRON_RUN_AS_NODE=1`。只跑安装内 `dsh.cmd --profile web` 得到的是 Web Host，不是 Desktop UI。依据：`DSH/apps/desktop/src/host-process.ts:198-213`、`DSH/apps/desktop/README.md:131-141`。

### 3.2 原生 switches 的证据与置信度

没有发现 DSH 自有的 packaged `--e2e` / `--cdp-port` 特性。可用于最小 discovery 的候选是 Electron 本身的参数，不是新增 DSH feature claim：

| 参数 / 行为 | 精确证据 | 当前判断 |
| --- | --- | --- |
| `--user-data-dir=<owned absolute path>` | Electron v44.7.0 [electron_main_delegate.cc:254-258](https://github.com/electron/electron/blob/v44.7.0/shell/app/electron_main_delegate.cc#L254-L258) 在脚本启动前覆盖 `chrome::DIR_USER_DATA`；[electron_paths.cc:47-49](https://github.com/electron/electron/blob/v44.7.0/shell/common/electron_paths.cc#L47-L49) 默认 sessionData 跟随 userData | 上游实现证据强；本机 packaged 实际隔离及锁归属尚待 discovery |
| `--remote-debugging-port=0` | Electron v44.7.0 [electron_browser_main_parts.cc:609-620](https://github.com/electron/electron/blob/v44.7.0/shell/browser/electron_browser_main_parts.cc#L609-L620) 启动 debugging server；[devtools_manager_delegate.cc:67-83,97-101](https://github.com/electron/electron/blob/v44.7.0/shell/browser/ui/devtools_manager_delegate.cc#L67-L101) 接受 0、绑定 `127.0.0.1`、使用 sessionData | 上游支持 ephemeral renderer CDP；本机 endpoint discovery / Playwright attach 未执行 |
| `--inspect=127.0.0.1:<port>` / `--inspect-brk=...` | Electron v44.7.0 [command-line-switches.md:284-306](https://github.com/electron/electron/blob/v44.7.0/docs/api/command-line-switches.md#L284-L306)；DSH 开发启动器 `scripts/dev.ts:85-90` | 是 main-process Node inspector，不等于 renderer CDP；首版不要多开 inspector |
| `DSH_DESKTOP_HOST_INSPECT_PORT` | `DSH/apps/desktop/README.md:199`，`src/host-process.ts:173,203` | Host 调试不能证明 renderer 点击；不作为 UI attach |

上游文件通过只读 HTTPS 抓取逐行核查；没有执行上游代码。以上只能支持“下一步值得验证”，不是“当前 DSH 已正式保证这些 packaged automation 接口”。不需要因尚未跑 discovery 就臆造 test-only flag；只有当前包拒绝 / 不暴露 endpoint 时，才报告具体 gap，另提最小 test-only option，且不在本轮改 runtime。

### 3.3 下一步 discovery 的启动描述（本轮未执行）

runner 使用 bundled 普通 Node：

```text
C:\Users\J\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe
```

本轮只运行该路径 `--version`，返回 `v24.21.0`。不要使用 PATH 的 Node 24.1。该路径是明确选择的解释器，不遍历其上级用户 home。

每个端点先创建独有的 `base`；环境按现有 allowlist 生成，设定 `HOME`、`USERPROFILE`、`APPDATA`、`LOCALAPPDATA`、`TEMP`、`TMP`、`DSH_HOME`、`DSH_AGENTS_HOME`、npm user/global config/cache 到 `base` 下；cwd 也为 owned workspace。顶层环境不继承 `ELECTRON_RUN_AS_NODE`、`NODE_OPTIONS`、`NODE_PATH`、当前 DSH profile 或账号凭据。

候选 argv（传给 `spawn` 的数组，不经 shell 拼接）：

```text
executable: D:\J\dsh\DeepSeek Harness.exe
args:
  --user-data-dir=<base>\electron-user-data
  --remote-debugging-port=0
env:
  DSH_HOME=<base>\home
  ...上述 allowlist 与独立 OS / cache 路径
cwd: <base>\workspace
```

分阶段检查，任何一步失败即停止，不回落到 live app：

1. 只启动一个 owned packaged 进程，记录 PID、exe、artifact hash / 应用版本及脱敏 stderr。确认没有瞬间作为 second-instance 退出；临时 home 中出现 Desktop 自己初始化的 `profiles/desktop`，Electron 数据落在 owned userData。
2. 优先从该进程的 `DevTools listening on ws://127.0.0.1:...` 记录发现 endpoint；若当前 Windows 包不提供该日志，再在**本次 owned userData** 检查 `DevToolsActivePort`。文件的实际生成与格式属于 discovery 结果，不能事先写成已验证 DSH 契约。两种都不可用就明确报 gap，不扫描 9222 或当前 GUI 的调试端口。
3. 校验 endpoint 为 loopback、来自 owned 进程与 fresh 数据根，读取其 `/json/version` / `/json/list`。用 `chromium.connectOverCDP(ownedEndpoint)` 连接现有 renderer；不 `chromium.launch()` 另造浏览器冒充 Desktop。选择 `dsh-app://app/` 主应用 target，不盲选第一个（可能是 welcome / loading / update 页面）。等待可交互内容而非仅加载成功。
4. 截图与断言证明实际 `dsh-app://app/` 及应用入口；验证初次引导是否有无凭证继续路径。真实登录墙出现则报告前置条件，不注入用户凭证、不调用 `dshOnboarding` 绕过 UI、不把 loading 页当通过。fresh profile 能否在无模型 key 下完成这一段尚未实测。
5. 关闭本进程并确认 owned Host 后代退出。单端 discovery 完成后才尝试第二端相同隔离方式；核对独立 userData / home / CDP，不能一次开四组进程。

CDP 是高权限本地接口，URL 仅保存在 runner 内存中，不对网络暴露，不加 `--remote-allow-origins=*`、`--no-sandbox` 或认证关闭选项。所有端点发现必须有 deadline；无 endpoint 是明确的 discovery 失败，不能静默跳过 Desktop。

Playwright `_electron.launch({ executablePath, args, env })` 也属于真实 Electron 自动化候选，不是 `RUN_AS_NODE`；但需要额外验证其依赖的 main inspector、打包 fuse、首窗识别和 `.close()` 行为。首版优先选择可解释的 owned `spawn` + renderer CDP，暂不同时实现两套。

## 4. 插件 UI 可以安装同一份本地 tarball

**源码支持，不是只有 npm package name**。无需添加文件选择器，也无需本地 npm registry 来兜底这一步。

证据链：

1. Plugins 页面入口及 `Add plugin` 对话框：`DSH/packages/client/ui-plugin-manager/README.md:46-61`，明确接受 package / Git / tarball / absolute local path。
2. UI 先调用 `remote.pluginManager.inspect(spec, ...)`，然后 `installBundle(spec, ...)`：`DSH/packages/client/ui-plugin-manager/src/client/manager-store.ts:1215-1249`。
3. Host 的 `parseInstallSpec` 接受绝对 `.tgz` / `.tar.gz`，也允许 `file:` 前缀但路径仍必须绝对；相对路径拒绝：`DSH/packages/boot/plugin-manager/src/install-spec.ts:29-30,60-82`。
4. tarball 预检检查本地路径存在，之后接受为 `kind: 'tarball'`，`bundle: null`：`DSH/packages/boot/plugin-manager/src/index.ts:560-587`。包是不是合法 bundle、兼容性最终要等安装后校验，预检接受不等于安装成功（`operations.ts:157-177`）。
5. 一般手输安装默认 `enabled: false`，要再点击“立即启用”：`manager-store.ts:1246-1249,1421-1439`。不能把下载成功当作插件 active。

未来测试步骤：构建 / pack 一次 → 记录 SHA-256 → 复制同样字节到每个 owned 可见绝对路径 → 页面点击 Plugins → Add plugin → 以真实 textbox 填入该 `.tgz` **Host 路径** → 点击 Install → 等待真实结果 → 点击 Enable now → 核对列表 / 行状态及插件的可见 Settings / sidebar 功能。Web 页面中的路径指运行 DSH 的机器，并不是浏览器客户端文件上传。

不能用 `page.evaluate(() => remote.pluginManager.installBundle(...))`、agent `plugin_manager`、私有 operations API 或手写 profile manifest 代替这条 UI 安装。遇到依赖 build-script 授权时只批准明确本次所需的包；不自动授权全部脚本、不绕过 DSH 兼容性检查。当前 `.tgz` 的传递依赖仍可能需要 registry 网络，不能宣称“local tarball = 全部离线”。

本轮没有在安装版本 GUI 中实际提交 tarball；上述路径是参考源码与 UI 文档确认，安装版本仍需金线验证。它不依赖 OS 原生 file dialog。

## 5. 文件 / 目录对话框单独测

必须分清三类：

- 普通 HTML `<input type=file>`：Playwright `filechooser` / `setInputFiles` 可用于验证应用接收文件，但直接设置文件不证明 OS 对话框可操作。
- Electron 原生目录选择：preload 暴露 `__DSH_DIRECTORY_PICKER__.pick`（`DSH/apps/desktop/src/preload-app.ts:88-90`）；客户端 native flow 优先选择它（`DSH/packages/client/ui-directory-picker-native/src/client/index.ts:23-40`）；main 验证本机主窗口和顶层 frame 后调用 `dialog.showOpenDialog(...openDirectory, createDirectory)`（`DSH/apps/desktop/src/directory-picker.ts:10-29`）。Playwright page 的 DOM / JS dialog API不能驱动这个 OS 目录窗口。
- 本插件共享根输入：`src/client/RoomPanel.tsx:38-40` 当前直接输入绝对路径，不存在“浏览共享目录”按钮。不要在测试里发明它，也不需要为金线使用原生 chooser。

核心业务金线使用明确的 owned 绝对目录输入。DSH 自身“打开工作区”的原生 folder picker 另列较小场景：点击真实应用按钮 → Windows UI Automation 根据**owned PID / owner HWND**找到 dialog → 选择临时目录并确认 → 应用可见 workspace 路径正确；再测 Cancel 不创建 workspace、重复点击不叠多个 chooser。UIA 实现尚未存在 / 验证，是下一步可选自动化工作，不要写成现成支持。

若暂时没有可靠 UIA，保留一次明确的人工作业验收，不把它标为自动化通过。不得向桌面全局盲发 Enter / Escape 或键入路径，避免误操作用户其它窗口。

将 `dialog.showOpenDialog` stub 为固定值，能测 preload / IPC / UI 接收结果，但不能声称测到了真实 OS 对话框。对于 Web 的通用点击回归，可通过支持的 `--patch` 使用官方 in-page picker overlay；`DSH/apps/web/tests/pin-browse-picker.overlay.yml:1-13` 明确说明 native chooser 不是 Playwright page 能驱动的交互。此 override 必须写进结果标签；**native picker 场景不能带这个 override**。packaged Desktop 不假设支持 Web 的 `--patch` argv。

另外，插件撤权 / 关闭使用 `window.confirm`（`src/client/RoomPanel.tsx:88-89`）。这是 JS confirm，与 Electron native chooser 不同；测试应在点击前订阅相应 dialog，仅对预期内容确认，并分别验证取消与批准。不能设置全局“所有 dialog 自动同意”。

## 6. 最少进程的场景与矩阵

四组合是逐步执行的覆盖矩阵，不是同时启动四套：

| 房主 | 访客 | 主要风险 |
| --- | --- | --- |
| Web | Web | 基础安装、认证、shared UI、权限状态同步 |
| packaged Desktop | Web | Desktop 作为房主的真实运行时、批准 / 撤权与共享文件 |
| Web | packaged Desktop | Desktop 作为访客的预览、自定义协议 / preload 与失效展示 |
| packaged Desktop | packaged Desktop | 双 Desktop 隔离、独立锁与完整互通 |

先 Web/Web 完成一条可复用旅程，再单端 Desktop discovery，再 Desktop/Web 与反向，最后 Desktop/Desktop。每个用例只保留两个端点、一份相同 artifact、一个 owned relay；Web 可用同一测试 Chromium 的两个隔离 browser contexts，Desktop 直接 attach 各自 Electron。Web carrier 明确区分 ordinary Node/OpenSSL 与 installed `dsh.cmd` 的 Electron/BoringSSL Node-mode，两者都不等于 Desktop UI。

建议短用例拆分：

1. **安装与持久化**：两端 UI 安装 / 启用、功能出现；退出重启后仍可见；关闭 / 打开 bundle 验证贡献消失 / 恢复；卸载要真实确认。独立于 TLS 是否成功。
2. **业务金线**：创建 / 加入 / 核对 / 批准 / 文件预览 / 撤权。批准前不存在可读文件 UI；需要实际拒绝证据时补充经过真实授权面的只读请求，标记为辅助断言。
3. **工具能力混合**：复用 observer 的 `remote_read` / 带 observedVersion 的 `remote_write`，验证房主磁盘、stale epoch 与 revoke 拒绝；不要声称模型思考或 UI 编辑覆盖。
4. **原生壳**：工作区 folder picker、取消、标题栏关闭隐藏、真正 Quit、重启与锁释放。与业务失败隔离报告。

每个操作先找可访问 role / label，定位到当前页面 / room，再 click / fill；等待 status / 可见内容而非固定 sleep。状态断言与至少关键截图配对。不要只看 HTTP 200、插件 slot 注册、按钮存在或 toast 一闪就通过。远程文件预览要在有 session 的右侧工作台做；Settings 入口没有 `openFile`（`src/client/index.ts:41-46`），不能把 Settings 中文件按钮禁用误判成实现没有预览。

## 7. 正常退出优先，强制清理兜底

Desktop 点击窗口 X **不是退出**：`DSH/apps/desktop/src/main.ts:1108-1117` 拦截关闭并隐藏，Windows 还可能首次弹隐藏确认。不能依靠 `page.close()` / 窗口消失判断资源已停止。

UI 主场景通过应用菜单 / 托盘真实 Quit；自动化 teardown 可另外发送 CDP browser-level `Browser.close`，但这一步应标记为 teardown，不能算点过 Quit。Electron v44.7.0 [devtools_manager_delegate.cc:125-134](https://github.com/electron/electron/blob/v44.7.0/shell/browser/ui/devtools_manager_delegate.cc#L125-L134) 把该方法转给应用 Quit，而且不会正常回复，因此以 owned 子进程退出事件为准，不无限等 CDP response。若有任务 / 提醒，可能弹 native quit confirmation（`DSH/apps/desktop/src/quit-confirmation.ts:68-94`）；不能假定一发命令必然退出。

DSH 的正常 quit 会调用 backend.close 等清理（`src/main.ts:1278-1318`）。Host.stop 发 IPC shutdown，等待 10 秒，然后 TERM / 5 秒 / KILL / 5 秒（`src/host-process.ts:318-343`）。runner 应给外壳退出一个覆盖这些阶段的有界预算（建议先 30 秒，并依据 discovery 调整），然后只对本次记录的 owned PID tree 使用 Windows `taskkill /PID ... /T /F` 兜底。

不能照搬现有 `killTree` 的“父进程 closed 就直接返回”而不考虑 Desktop 后代残留；新增 runner 需跟踪自己启动的树及创建时间，正常退出后验证 owned Host / package-manager 后代也已结束，并验证 owned CDP 不再可用。记录 graceful / forced / incomplete teardown；forced 可以清理成功，但 lifecycle graceful 场景仍应失败；无法确认停止则保留临时根且失败。不得按进程名杀全部 `DeepSeek Harness.exe`，不得探测或杀当前用户应用。禁止 PID 不明时重试或猜测。

只有全部 owned 资源停止后，校验 realpath 是本次 mkdtemp 且仍在允许前缀内再删除。正常重启持久化用例只保留本次根，其它用例不跨 run 复用 profile。

## 8. 最小下一步实现计划

本轮只产出设计；以下文件名是**建议新增**，不是已存在实现：

1. 新增一个小型 `scripts/e2e-ui.mjs` driver，显式选择 carrier / pair / artifact，优先 Web/Web；复用隔离、脱敏、deadline、owned PID 与 hash 思路。新增一个 Playwright spec / helper，不引入通用浏览器集群或另一套业务框架。依赖选型 / 安装另行确认。
2. 先用 Plugins 原生表单安装 `.tgz`、启用并看到真实插件页面；实现持久化 / 卸载短用例。完成后只报告该短用例，不等 mTLS 修复才有第一份有用证据。
3. 单独 `desktop discovery` 模式启动一份 isolated packaged app，验证本机原生 switches、CDP target、初次引导与 Quit / 子树清理；产出实际支持 / gap。若被 current packaging / onboarding 阻断，明确记录阻断，不改 live profile 或 runtime。
4. 将相同 UI journey 接到 Desktop/Web，再反向与 Desktop/Desktop；等待真实 mTLS artifact 通过后才记录文件链路。TLS 失败时保留安装 / 页面可见等已完成阶段，后续依赖阶段记 `not-reached`，不能 skip 成绿色。
5. 最后加 OS native picker 专项（UIA 或明确人工），不让它阻塞可输入绝对路径的核心金线。

报告至少分四列：`launch/attach`、`install/enable`、`UI journey`、`teardown`。附命令、carrier/version/Node/Electron、artifact SHA-256、每步结果与脱敏关键截图；没有执行的矩阵单元写 `not-run`。邀请、认证 URL、cookie、密钥、完整 token 不进入 trace / HAR / screenshot / 错误日志。邀请显示期间暂停截图或做敏感区域遮盖；录制也必须采用相同规则，不能只事后清理 console。

### 待 discovery 回答的明确问题

- 当前安装版本是否实际接受原生 switches，并在 owned userData 提供可发现的 ephemeral CDP？
- 单端 / 双端是否都获得独立单实例锁，且不会唤醒 live 用户窗口？
- fresh packaged profile 的 welcome / onboarding 是否可以不配置模型 key 进入 Plugins / Settings？若需真实授权，自动化前置条件是什么？
- 当前安装版本是否按参考源码处理本地 tarball、启用结果与可能的 restart-required？
- CDP 对 `dsh-app://app/` 的 Playwright 操作、JS confirm、正常 Quit 和后代退出是否可靠？

这些问题尚未通过运行解答。它们不影响目前已经查明的设计方向：CLI 集成继续保留；真实 UI 另加薄 runner；packaged Desktop 必须真实启动并隔离两种数据根；原生对话框作为独立能力验证，不虚构点击或完成结果。
