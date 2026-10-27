# DSH 远程工作区插件 · 方案 v6

> 房主把目录与可选的进程执行能力借给访客，agent、模型和 API key 留在访客自己的 DSH。房主只安装插件并保持 DSH 在线，不向访客公开 DSH Web。
>
> 状态：**已实现并有真实端到端证据**（见 `development-status.md`）。本文档保留为架构与边界基准：其中 D5 的「替换 fs/subprocess provider」未采用，实现改为八个显式 `remote_*` 工具 + 独立房间 UI（理由与覆盖见 `development-status.md`）；传输层以 `decisions/0003-desktop-compatible-mtls.md` 为准，取代本文档 §5.1 的早期握手假设。v5 原文保存在 `archive/dsh-remote-workspace-plan.v5.md`，不代表当前方案。

## 0. 范围与决策

### 0.1 产品约束

- 两端都安装插件；房主不需要 agent 或 agent 会话，不新增房主入站监听端口。
- 房主可以使用自己的本地 DSH UI。禁止的是向访客公开房主 DSH Web/API，不是禁止房主使用本机控制面。
- 访客入房时由房主授权一次，不做逐操作审批；房主始终可以撤销。
- 文件操作、普通命令和 PTY 必须实际发生在房主；断线、撤销或配置错误时，不能回落到访客本机。
- 本地与房主工具必须可区分。现有工具优先复用，但不以“零工具开发”为已经实现的结论。
- 保持与 better-sidebar 等插件兼容，不替换主界面或整列侧栏。

### 0.2 决策表

| # | 决策 | 状态与边界 |
|---|---|---|
| D1 | 房主仅提供能力；agent 在访客 | 固定约束；房主控制面不依赖 session |
| D2 | 两端出站 WSS，经可配置中继配对 | 主线；Cloudflare Worker + DO 是候选默认，须测目标网络 |
| D3 | 复用 DSH 三种模式名与 fs 原子操作、写围栏 | 房主另行实施房间读写边界，不能直接继承部署权限 |
| D4 | 入房一次授权，授权绑定连接、对端与代际 | 重连不自动继承旧授权；无逐动作确认 |
| D5 | 优先在 preset 隔离 realm 中替换 provider | 待完整组合 PoC；不是整个 session 的所有服务都会随之替换 |
| D6 | 单 npm 包，Host/Client 两个运行面，多个必要导出入口 | provider 子路径必须真实构建并列入 exports |
| D7 | 中继不获得内容密钥；使用认证的端到端加密 | 具体握手实现尚待选定，未通过验证前不开放真实数据 |
| D8 | WSS 上做轻量逻辑分流与有界 RPC/流控 | 不预设通用 mux；不承诺固定行数或无窗口 |
| D9 | 首个交付纵切只含受限文件能力 | 搜索、普通进程、PTY、跨 OS 分阶段验证 |
| D10 | 普通命令用房主 `subprocess.spawn`，PTY 用房主 `spawnTerminal` | 后续独立阶段，二者不能相互替代 |
| D11 | 房主保存有界操作 journal，写 diff 取自 fs 成功结果 | 不宣称完整录像、回滚或每次写均有原文 |
| D12 | 受限档不提供任意命令执行 | 当前 DSH 默认沙箱不保证只读共享目录；不是理论上无法实现受限 runner |

### 0.3 v5 的关键修正

| 原假设 | v6 |
|---|---|
| 房主不开任何 Web UI，授权却放 session 右栏 | 房主用无 session 的本地控制入口；访客右栏只负责远程工作区 |
| 只补读检查，写原样交给 fs-sandbox | 房主对全部读写入口授权，策略由本地 grant 生成；fs-sandbox 附加兜底 |
| 换 fs/subprocess 后全部工具免费远端化 | 逐项检查消费者、搜索、shell、路径与后台任务依赖 |
| 13 个抽象成员等于 13 个 RPC | 三个同步成员本地实现，流另有生命周期 |
| pause + bufferedAmount 足以端到端背压 | 接收端反馈、有界队列、数据调度与源暂停共同工作 |
| 几个密码算法足以定义 E2EE | 认证握手、记录绑定、nonce、防重放与重连密钥均须验证 |
| 按层铺开 45 个文件 | 先做纵切；保留授权、密码、传输、Host/Client、relay 的边界 |

## 1. 技术栈与包形态

### 1.1 已选与待选

| 项 | 选择 | 要求 |
|---|---|---|
| 语言 | TypeScript、ESM、strict | Host/Client 的运行时导入不得混用 |
| 构建 | tsdown + tsc 类型检查 | Client 必须产出 DSH 动态模块格式，不能只用普通浏览器 ESM 代替 |
| 测试 | Vitest + 真实 Loader/分发产物 smoke | 单测之外覆盖真实组合、卸载和会话隔离 |
| WSS 客户端 | Node 全局 WebSocket | Node 22.4 起稳定；插件最低 Node 版本还须服从目标 DSH 的实际要求 |
| Config | `@deepseek-ai/schemastery` | 版本对齐目标 DSH；wire 输入另做严格校验及长度/数量上限 |
| 文件执行 | 房主 `ctx.fs`，要求经验证的 sandbox 写 provider | 不可在缺失写围栏时静默改用无约束实现 |
| 进程与 PTY | 房主 `ctx.subprocess` | 不自行安装 node-pty；不使用要求 Agent 的 `ctx.terminals.spawn` |
| E2EE | 优先评估维护中的认证密钥交换实现；Noise PSK 可作参照 | 具体库、版本、许可证、维护与安全证据在 A1 决策；不先承诺“零依赖” |
| 中继 | Worker + SQLite-backed DO | 独立部署单元；地址可配置，部署前核对当期限制与配额 |
| UI | DSH 动态 Client、Slots、主题 token、locale | HostControl 无 session 可达；访客右栏独立 key |

不为依赖数量优化安全关键实现。不预装 ssh2、node-pty 或编辑器；如选自建 Node 中继，其 WebSocket 服务端依赖独立评估，Node 全局 WebSocket 不是服务端。

### 1.2 包导出与构建

以下仅表示计划的入口映射，不是可直接安装的完整 manifest。暂以 `@local/dsh-remote-room` 为本地开发包名；发布名称另定，引用时必须整体一致。

```json
{
  "name": "@local/dsh-remote-room",
  "type": "module",
  "main": "lib/index.js",
  "exports": {
    ".": "./lib/index.js",
    "./client": "./lib/client.js",
    "./provider-fs": "./lib/provider-fs.js",
    "./deny-subprocess": "./lib/deny-subprocess.js"
  },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "platform": "web" }
  }
}
```

- preset 引用 `@local/dsh-remote-room/provider-fs`，不是另一个包 `@dsh-remote-room/provider-fs`。执行阶段再增加 subprocess provider 导出。
- `tsdown` 为这些入口生成对应产物；入口之间是否共享内部 chunk 由实际 Loader 与分发验证决定，不强求单文件。
- Host 共享身份的 DSH 服务与 Cordis 不打包成私有副本；peer/dev 声明依据实际 import 与宿主接口确定。
- Client 的 `dsh.client.inject`、模块 external 与 Cordis service inject 是不同机制，不能互相替代；由 A0 验证后补齐 manifest。
- 使用实际目标 DSH 的精确兼容版本，不用浮动 `next` 声称与桌面版对齐。声明支持的 DSH/Node 版本范围并保留已测矩阵。
- `files` 必须覆盖导出产物、patch、locale、图标及必要资源，排除 relay 与参考克隆。A0 从打包后的安装视图加载每个入口。

### 1.3 参照物与不照搬的部分

| 参考 | 复用或参照 | 不可推导的结论 |
|---|---|---|
| DSH `fs-ssh` | 远端身份、同步路径方法、流关闭、错误映射 | 不能把全部成员做异步 RPC，不能照搬 POSIX 路径算法到 Windows |
| DSH `subprocess-ssh` | 普通进程/终端句柄、取消、退出与回收 | 不是只实现 PTY 就支持 bash |
| DSH `fs-sandbox` / `sandbox-policy` | 模式词汇、per-call policy、拒绝码 | 不自动获得 room grant，也不只允许写 room root |
| DSH `tool-fs` / observation policy | 现有工具与观察/过期保护 | stale 保护依赖组合中的独立 policy，不是工具自动附送 |
| DSH preset registry | 同 realm 的 provider/consumer 组合 | preset 不是安全沙箱，也不是每个 Agent 一套 provider |
| open-remote-ssh | 生命周期、认证失败停止重连、普通 exec 与 PTY 分离 | 不照搬远端 Server 引导、OpenSSH 配置和端口转发 |
| ShellHub | 设备出站、逻辑通道和协议身份 | 多个逻辑流不消除同一底层连接上的队头阻塞；不能删掉流控义务 |
| better-sidebar | 插件共存与槽位使用方式 | 不依赖其内部 DOM、私有组件或固定 tab 数量 |

SSH 本身不强制 helper 二进制；DSH 当前 SSH 家族依赖 OpenSSH 连接与远端 helper，这是它的实现选择。我们不直接挂该家族，是因为房主已有 DSH 能力、部署约束要求零新增入站端口，而非 WSS 天生比 SSH 安全或实现更少。

## 2. 架构与职责

### 2.1 拓扑

```text
房主本机 UI → 本地 controller → RoomService → 授权/路径检查 → ctx.fs / ctx.subprocess
                                   │
                              出站 WSS
                                   │
                         Worker → 房间 Durable Object
                                   │                 只转发受限长度的密文数据
                              出站 WSS
                                   │
访客本机 UI → 本地 controller → RoomService ← 远端 providers ← 经验证的 preset 工具
```

插件服务在两端已运行的 DSH 进程内工作，不额外部署房主 daemon/helper。仍需安装插件、运行 DSH，并有可用中继，不能称为“什么都不用装”或“零部署”。

### 2.2 唯一状态与资源所有者

- `RoomService` 拥有房间、连接代际、grant、Guest 绑定、RPC 与进程/流资源；UI 只展示状态和调用操作。
- 授权由房主本地状态决定。中继的 role/配对信息和访客发送的 mode/root/target 都不是授权依据。
- Host controller 是本机 UI 的受控入口；Guest 发来的 wire 方法使用单独白名单，不能调用本地 approve、提权或任意 DSH Remote API。
- preset revision 是共享实例。绑定必须显式包含会话、房间与代际，不使用全局 `currentRoom`；旧会话不能被重定向到后来加入的新房间。
- UI tab 隐藏、组件卸载与关闭终端是不同动作；不能用 React 生命周期决定授权是否有效。

### 2.3 本地 UI → Host 桥

在 A0 选择并验证目标 DSH 支持的、无 Agent 的 Client-callable Host 接口。现有 slash/session command 要求 Agent，不能充当房主无 session 入口；Host Service 也不会自动变成 `ctx.remote` 方法。

桥必须完成方法注册、Client 挂载、wire codecs、结果/错误、订阅基线、取消及 UI 重连恢复。参考 `packages/api/gateway`、`packages/api/remotes`，以当前运行时接口为准，不在本文猜方法签名。若公开接口不能满足无 session 调用，应先解决插件扩展点，而不是暴露房主 Web 给访客。

本地 create/join/observe/revoke 等操作共用 RoomService。approve 和扩大权限只允许本地用户操作，不能提供给 agent 自批；其余可供 agent 使用的管理动作在实现阶段另评估，不改变“优先复用文件工具”的目标。

## 3. 授权、路径与执行边界

### 3.1 模式语义

| 档位 | 文件能力 | 执行 |
|---|---|---|
| `read-only` | 仅共享根内的读取与必要元数据 | 禁止普通 spawn 与 PTY |
| `workspace-write`（默认） | 仅共享根内的读取、创建/覆盖文本、文本修改 | 禁止普通 spawn 与 PTY |
| `danger-full-access` | 房主当前 OS 用户可访问范围内的整机文件 | 后续执行阶段开放普通命令与 PTY，仍受 grant/生命周期限制 |

复用模式名，不宣称与 DSH 原模式完全等价。DSH 默认沙箱允许更广的读取，参考实现的 workspace-write 还允许临时目录；插件受限档都不因此扩展房间范围。UI 必须标明这一差异。danger 不意味着提权到管理员或绕过 OS ACL。

当前 fs seam 没有 remove/rename/mkdir 方法；首版不自行补齐这些远程管理操作。创建文本仍可能产生父目录等副作用，必须验证整个操作的路径影响，不能把“无删除方法”宣传成“不会造成数据损失”。

### 3.2 一次授权与可信 policy

房主确认已认证访客后，记录不可由 Guest 修改的 grant：房间 ID、认证对端/连接代际、模式、规范化共享根、允许的方法、有效期和撤销状态。配置明确邀请/握手/授权过期时间，不存在隐式永久授权。

每次能力调用都由房主执行：

```text
校验连接、代际、grant、方法与输入上限
  → 从可信 grant 派生实际能力，不信访客提供的权限字段
  → 房主规范化并检查目标（读写均检查）
  → 将检查后的目标与房主生成的 per-call policy 交给能力
  → 记录完成、拒绝或未知结果
```

`fs-sandbox` 优先采用显式 policy；不传则使用部署 fallback，不会自动知道房间。Host 必须显式传入当前受支持的 `mode/workspaceRoot`，不得透传访客提权参数。源码含 `additionalWritableRoots`，当前 Inspect 返回类型却未包含；首版不使用额外根，并在 A0 固定目标版本复核。

复用原子写、版本守卫与 fs-sandbox 拒绝机制，但房间根检查是独立的授权条件。缺少所需写 provider 或无法确认其语义时，不开放写入。

### 3.3 所有文件入口均受约束

- 检查覆盖 resolve、stat/lstat、readText、streamText、readBytes、readByteRange、listDir、writeText、editText，不能只围其中三个方法。
- Guest 路径按房主方言解析；Guest 传回的 targetKey 不代表已授权文件句柄。Host 校验来源并重新解析实际使用的目标。
- 检查与执行使用同一个 fresh target；`contains()` 只是解析后目标之间的词法包含判断，不是独立的符号链接安全原语。
- listDir 还需检查/脱敏子项，避免房间内链接泄露外部真实路径与元数据；lstat 的“不跟随最终链接”语义须单独测试。
- 根目录替换、符号链接/junction、缺失路径最近祖先、Windows 大小写/盘符/UNC、伪造和过期 target 都进入测试。
- DSH fs-sandbox 接受最后一次解析到 syscall 之间的残余 TOCTOU。A2 必须定义本插件的威胁模型并验证并发链接置换；若不能满足远程不可信输入的范围保证，应收紧支持范围或采用更强路径访问机制，不能直接标注“风险已消除”。

上述检查发生在房主进程内，不是每一次检查都需要额外网络往返。根缓存如采用，必须规定失效语义，不能以性能为由无限缓存授权身份。

### 3.4 为什么受限档禁任意执行

当前 DSH 默认沙箱词汇主要约束文件写入，不保证只读共享根，也不全面限制网络与进程可见性。任意 shell 可以读共享根外的文件、环境和凭据，并可能外传，因此不满足本插件受限档承诺。

这是当前实现与范围的选择，不是“受限执行物理上不可能”。未来若要支持，需单独设计和验证 runner；不能通过放开 subprocess 来免费获得 grep/glob。

### 3.5 本地确认与审计

房主控制入口须无 session 可用，包含开房、选择根/模式、确认访客、有效期、在线状态、撤销与关房。`ctx.userApproval.request()` 要 Agent 和打开的 turn，不用于本阶段房主授权；不为复用它创建虚假 Agent 会话。

拒绝、超时、认证失败、版本不兼容均不授予能力。不得把关闭提示或 UI 失联解释为同意。基本 grant/revoke/拒绝记录与操作日志在开放写入之前完成。

## 4. 工具复用与 provider 验证

### 4.1 复用优先，不承诺零开发

| 能力 | 已确认机制 | 实施要求 |
|---|---|---|
| read/write/edit | 文件工具使用 fs seam | 同 OS 先跑闭环，验证 observation policy、diff 与拒绝呈现 |
| processPath/fileUrl/contains | FileSystem 的同步方法 | Guest 同步实现；resolve/握手返回足够的房主坐标、URI 与路径方言信息 |
| streamText | 异步流不是一个 JSON 字段 | 建立有界 pull/next/close/cancel 生命周期，参考 fs-ssh |
| glob/grep | 通过 subprocess 运行 rg，不经过 fs | 首个受限纵切不挂载；后续评估受约束搜索 API 或上游 capability 改进 |
| 搜索二进制 | 现有工具解析访客本地 rg 绝对路径 | 不能原样交房主 spawn，需房主定位与验证的适配 |
| bash/pwsh | shell executor 依赖普通 subprocess | 需要完整 spawn handle/collect/取消/退出支持；按房主环境选 shell |
| 后台任务/spill | 还有 jobs、存储、路径消费者 | 逐项验证，不透传不可读的本机路径冒充远端结果 |
| 文件树/预览 | 内置树未证明跟随隔离 fs | 插件自己的 UI 显式绑定房间，不假定换 provider 自动替换所有 UI |

`processPath/fileUrl/contains` 不能改成返回 Promise 的 RPC。Guest 的同步 contains 只服务调用方接口，房主仍独立授权。二进制传输显式编码；`processPathFromHostPath` 不把访客本机路径映射到房主；首版 watch 明确不支持，以刷新替代。

### 4.2 preset 接线要求

A0 产出真实可加载的 patch，而不是把未验证伪 YAML 当配置。Loader group 使用 `group: true`、行级 `isolate` 映射和 `config` 子条目数组；provider 与所有相关 consumer 必须同 realm。

- 提供 fs、subprocess、shell、workingDirectory、sandboxPolicy 等服务时，按实际提供项一并隔离；不隔离 sandboxPolicy 却在组内新建它会触发服务泄漏审计。
- `dsh-shell` 是抽象服务定义，不能当具体 provider；执行阶段使用经验证的 bash/pwsh provider。
- 受限阶段显式拒绝 subprocess/执行路径；可用 deny provider 满足隔离测试，不借用访客本地实现。禁用搜索、bash、PTY 及其他未验证执行入口。
- `agent.ctx` 普通查找仍可能取 Host realm；同名工具是 scope shadow，未覆盖的 Host 工具仍可能可见。列出模型可见工具及其执行世界，审计文件、进程、subagent、存储等旁路。
- 验证 observation policy、working directory、shellEnv、jobs 与工具注册范围。房主环境由房主重建/过滤，不能把访客 DSH_HOME/PROFILE_DIR 等本地坐标直接注入远端进程。
- preset 只能在当前 API 允许的空白会话阶段选择；不能承诺在已开始的会话里随意切换 provider。

### 4.3 本地/远端可区分与跨 OS 门槛

同名工具替换与“同会话可明确访问两个目标”不是一回事。A0 必须先确定寻址方案：可明确标识的专用远程会话，或同一会话中的显式本地/远端调用目标。若采用分会话作为首版限制，须获得产品确认；不能悄悄把原需求改成只可二选一。

无论采用何种方式，模型上下文、调用/结果与 UI 都要能识别执行世界、房间与根，且可从已提交会话记录重建模型看到的绑定事实；密钥与邀请秘密不得进入记录。实现模型侧呈现时再核查工具/提示扩展接口，不在本文捏造事件类型。

跨 OS 不能仅靠“不透明字符串”解决：现有 editor、workingDirectory、sandboxPolicy、shell 等消费者使用访客本地路径或平台判断。先验证同 OS；Windows→POSIX 与 POSIX→Windows 分别测试，在消费者适配完成前不宣称支持。

## 5. 传输、认证与协议

### 5.1 认证加密通道

邀请链接包含随机房间标识与高熵秘密，秘密置于 fragment；插件本地解析，不发送给 relay，不记入日志/遥测。fragment 只降低 HTTP 泄漏，不防剪贴板、聊天转发或历史记录泄漏；邀请应可过期、关闭和更新。

X25519、HKDF、AES-GCM 是候选原语，不是完整协议。A1 选定实现前必须覆盖：秘密对握手 transcript 的认证，角色/房间/协议绑定，双向独立密钥，密钥确认，唯一 nonce，严格序号/防重放，必要帧头的完整性保护，以及每次重连的新密钥与连接代际。

优先选有维护、测试向量和可核查安全依据的实现；Noise PSK 仅是候选参照。记录实际库、精确版本、许可证与使用模式；自有代码以适配为主。原方案 `HMAC(k, nonce)` 不再作为已完成握手，序号出现在 AAD 也不等于已实现防重放。

中继仍能观察房间路由、IP、流量大小与时序，并能拒绝服务；E2EE 不消除这些元数据或可用性风险。未经认证与授权不能执行真实能力。

### 5.2 逻辑消息与方法

v1 固定一种协议版本，不兼容直接拒绝；命名可借鉴 `/dsh/ctl/1.0.0`、`/dsh/fs/1.0.0`，不预建版本交集协商框架。封包头与编码在 A1 通过测试冻结，不再预定“8 字节、自写 60 行即可”。

| 消息族 | 内容 | 边界 |
|---|---|---|
| ctl | 能力/平台信息、认证状态、grant、撤销、心跳 | relay 配对不等于认证，认证不等于授权 |
| fs RPC | resolve、stat/lstat、文本/字节读、目录、write/edit | 三个同步 provider 成员不在 RPC 方法表内 |
| stream | open/next 或 credit/data/end/cancel | 句柄绑定连接与 grant 代际，关闭释放资源 |
| audit | 有界分页查询、必要通知 | 先不独立分配审计数据流 |
| process/pty | 后续普通进程与终端控制/数据 | 两类生命周期独立，未实现时不协商为可用 |

每个请求包含唯一 request ID，回复对应请求；明确超时、取消、错误码、结果上限和晚到回复处置。对已结算 ID 不重复执行；去重表有界，淘汰或跨代际后不把未知 mutation 作为新请求补跑。不宣称全链路 exactly-once。

文本流跨分片解码必须使用增量解码或保留完整码点；不得逐个任意字节块独立解码。PTY `write(data: string)` 维持文本语义，通用字节分片不必为此全部变成文本协议。

### 5.3 流控与资源上限

`bufferedAmount` 只观察本地发送积压，`Readable.pause()` 只暂停本地源，二者不能说明“中继→访客”是否消费完成。设计必须包括接收端消费反馈/credit、每流与每连接有界队列、在途请求数、数据分块调度和源暂停；fs 流优先采用拉取。

控制/撤销消息优先于 bulk，但共享有序 WSS 仍有队头阻塞，不能承诺“互不阻塞”。加密后的完整消息也受上限约束；重组缓冲、解密前长度、JSON 深度/数组数量、日志和去重状态均要有界。

业务部署值放 Config，协议安全上限在协议中固定；A1 冻结具体默认值与绝对上限。readText 可先以 8 MiB 为候选业务上限，帧需分块，不把整个读取结果塞进一条控制消息。过大文件返回可操作错误/范围读取方式，不静默截断后当完整内容。

Cloudflare 当前官方接收 WebSocket 消息上限为 32 MiB，不是旧方案的 1 MiB；本协议可以且应选更小的限制。部署时重新核对，不能把平台最大值当作本产品的内存预算。

### 5.4 中继部署

- Worker 路由并升级连接，一个 DO 管理房间配对；两侧均为入站到 DO 的 WebSocket，可使用 Hibernation API。
- 普通内存 Map 会在休眠后丢失。连接 attachment/重建过程保存必要角色与路由状态；不保存内容密钥和授权决定。
- 独立 `package.json`、tsconfig、wrangler、SQLite migration/bindings、配置说明与部署测试。relay 不导入 DSH Host/Client 或权限/密钥实现。
- 限制房间创建、配对槽位、未认证等待、消息大小/速率、连接数与 TTL；对乱序配对、角色抢占、断线和滥用做测试。中继侧防滥用不替代端到端认证。
- Hibernation、心跳和配额一起测试，不能只凭 API 存在就声称零运维/零成本。中继不可用时不自动换至未获用户认可的地址。

自建 relay 是后备部署选项，须实现相同配对与限制并独立验证，不称为“60 行生产中继”。WebRTC/SSH-over-stream 暂不实现；WebRTC 还需要 Node 支持、信令与可能的 TURN，不作为延迟不达标后的自动切换。

## 6. 生命周期与审计

### 6.1 断线、撤销与未知结果

房间状态至少区分等待连接、认证、待确认、已授权、撤销中和关闭；连接另有代际。RoomService 统一拥有状态转换与资源清理，不在多个 UI/handler 内各写一套。

撤销、到期、断线检测或插件卸载后，立即拒绝新能力调用，取消在途请求与文件流，执行已启用普通进程/PTY 的终止程序并等待可观察退出。不能保证撤销已提交的写入或任意命令的外部副作用；无法完成回收要明确显示错误，不能提前显示“已全部停止”。

突发网络中断在房主检测前有窗口，故连接需心跳与有效期；A1 明确失活判定预算。仅网络错误可退避重拨，认证失败、撤销、过期和版本不兼容停止自动尝试。新连接重新认证并由房主重新确认，不自动恢复旧 grant/流。

读可在新授权下重新请求；写、命令和终端输入不自动重放。若执行可能已发生但回复丢失，返回“结果未知”，结合 request ID 与房主 journal 查询/重新读取核对，不声称失败即未执行。断线后的 provider 只返回远端不可用，不调用本地 fallback。

### 6.2 有界 journal，不是完整回滚

- 房主 journal 为权威，使用插件拥有的持久存储；A0 检查存储接口，A2 验证重启可读。保存 seq、request ID、对端/代际、操作、路径、状态、时间以及 grant/revoke/拒绝事实。
- mutation 前记录尝试，成功后用同一次 fs 返回的 `FsWriteOutcome/FsEditOutcome` 记录结果。不要另做前读后读重造 diff 基线。
- `write.before` 可为 null，内容为 diff 基线而非字节级备份。缺失、大文件、非 UTF-8、截断/淘汰必须标注，不承诺每次写完整回放或自动回滚。
- TTL、总字节数、单条内容上限和保留策略显式配置；元数据/内容分页读取，只读导出。默认不持久记录文件全文和终端输出，内容保留需房主明确启用并可清理。
- 写前 journal 不可用则拒绝新 mutation；执行后日志失败则标注审计缺口，不伪报“操作未执行”。进程崩溃可能留下未知结果，不宣称原子跨文件/日志事务。

## 7. UI 与兼容性

房主使用无 session 的本地 HostControl：优先验证 settings 扩展入口，必要时另选已支持的本机 surface；不能以 session 右栏作为唯一入口。确认前显示认证对端、根、模式、有效期、整机权限风险；昵称只是显示信息。撤销入口在连接期间始终可达，UI 不存在时仍可由服务到期关闭。

访客使用 session 右栏 `sidebar.right.pane.tab` 的独立 key，显示执行世界/房间、根、模式、连接状态、文件树和只读预览。断开保留内容时明确标为陈旧，禁用会触发远程操作的控件。树和预览通过已绑定房间接口读取，不假定内置树自动跟随 preset。

只注册需要的叶子槽，通过 `slots.inject` 等待声明；不抢 sidebar/main、不读取其他插件 DOM、不复用 key。与 better-sidebar 同时开启、槽位重建、插件卸载和重新加载均要测试。主题 token 与 locale 跟随宿主；不因“宿主已装包”就 runtime-import 另一 feature plugin 的私有 UI。

## 8. 模块与文件树

以下是实现目标，不是立即创建所有文件的清单。首版集中 ctl/fs schema，不预建多版本 negotiation、独立 audit 流、通用 types 大桶或 provider-sandbox。原 45 文件并非数量异常；优化的是职责与实施顺序，不是以更少文件为 KPI。

```text
dsh-remote-room/
├── package.json / cordis.patch.yml / tsdown.config.ts
├── tsconfig.json                   Host/Client 类型边界按实际构建配置补齐
├── locale/{en,zh}.json / icon.svg   分发元数据；Client 文案由 locale.ts 管理
├── src/
│   ├── index.ts                    插件装配，不承载业务分支
│   ├── config.ts
│   ├── protocol.ts                 v1 DTO/schema/错误；不 import Node/React
│   ├── room-service.ts             房间、grant/epoch、会话绑定、生命周期
│   ├── invite.ts
│   ├── security/
│   │   ├── channel.ts              认证加密实现适配、nonce/代际
│   │   └── access.ts               grant 验证、房主 policy、路径读写边界
│   ├── wire/
│   │   ├── connection.ts           WSS、心跳、断线
│   │   ├── rpc.ts                  请求、流、超时、取消、错误
│   │   └── flow.ts                 有界队列、消费反馈、调度
│   ├── host/
│   │   ├── controller.ts           受控本地 UI→Host 入口
│   │   ├── files.ts                fs 调用；不重复实现原子写
│   │   └── audit-store.ts          有界 journal、查询与保留
│   ├── guest/
│   │   ├── filesystem.ts           远端 FileSystem provider 导出入口
│   │   ├── deny-subprocess.ts      受限档拒绝执行，禁止 fallback
│   │   └── preset.ts               已验证的组合与显式绑定
│   └── client/
│       ├── index.ts / bridge.ts    槽注册与本地控制桥适配
│       ├── state.ts / locale.ts    展示状态，不持有权威 grant
│       ├── HostControl.tsx         无 session 可达
│       ├── RoomPanel.tsx
│       ├── FileTree.tsx
│       └── Preview.tsx
├── relay/
│   ├── package.json / tsconfig.json / wrangler.toml / README.md
│   ├── src/{worker,room}.ts
│   └── tests/room.spec.ts           配对、休眠恢复、TTL、限额
└── tests/
    ├── package-exports.spec.ts      安装视图与产物
    ├── realm.spec.ts               真实 Loader、两个会话、Host 不变
    ├── channel.spec.ts             帧、取消、慢消费者、资源上限
    ├── crypto.spec.ts              向量、冒充中继、重放与重连
    ├── access.spec.ts              伪造 policy/target、链接、全部文件入口
    ├── lifecycle.spec.ts           revoke/到期/断线/卸载、未知写结果
    ├── files-audit.spec.ts         fs 往返、原子结果、缺口与保留
    └── controller-ui.spec.ts       无 session 控制、用户专有授权、兼容
```

执行阶段另加 `host/processes.ts`、`host/terminals.ts`、`guest/subprocess.ts`、`client/TerminalPane.tsx` 及对应测试、导出入口。不提前创建空壳。若 access 或 channel 复杂度增长，再按独立职责拆开；不得为凑文件数把安全检查、密码和 UI 混进一个 serve 文件。

依赖方向：Client → 本地桥 → RoomService；Guest provider → RPC；Host handler → access → 本地能力；wire 与 security 不依赖 UI；relay 不依赖插件运行时。业务类型随所属模块定义，只有真正跨 wire 的 DTO/schema 集中在 protocol。

## 9. 验证顺序与验收

按纵切推进，不先把所有 transport/protocol/handler 写完再接 UI。阶段未通过不能把待验证能力写成已支持。

| 阶段 | 范围 | 退出条件 |
|---|---|---|
| A0 接线 PoC | 打包导出、完整 realm、无 session HostControl、本地桥、存储接口；可用假远端 | 真实 Loader 可挂载，无 service 泄漏；本地/远端寻址方案确认；两个会话不串绑定；组外 Host 能力不变；用户专有授权不可由 agent 触发 |
| A1 安全通道与 relay | 选定认证握手实现、固定 v1、有界 RPC/流控、独立 DO、grant/revoke/expiry | 假中继替换/重放失败；未授权无真实能力；重连新代际；休眠恢复和滥用测试；冻结上限/失活预算，测网络与配额 |
| A2 只读纵切 | 同 OS provider-fs + 全文件读入口 access + 树/预览 + 基本 journal | 正常读取；越界、伪造 target、链接元数据泄漏被阻止；TOCTOU 威胁模型与处置记录；重启审计可读；断线不读本地哨兵 |
| A3 写入纵切 | 房主盖章 policy、write/edit、observation policy、outcome 审计 | room 内成功、room 外（包括根外 temp）拒绝、read-only 拒绝；过期版本行为明确；撤销竞态/未知结果不重放；审计失败行为可见 |
| A4 文件版收口 | 生命周期、兼容、分发、错误/locale、journal 分页与保留 | better-sidebar 共存、槽重建与 unload 无泄漏；支持版本矩阵与已知限制齐全，形成文件版 MVP |
| A5 执行扩展 | 普通 spawn、collect、jobs/spill、PTY、shell/env、danger 档 | 按房主 OS 选 shell；受限档全部拒绝执行；命令/PTY 真在房主；取消/撤销/失活/unload 等待退出且报告清理失败 |
| A6 后续验证 | 受约束搜索、Windows↔POSIX 消费者适配；编辑器等另立需求 | 每项分别证明可复用性；不把 WebRTC、多房间或 SSH 隧道打包成必做打磨 |

### 9.1 性能与失效实验

从 A1 记录 DO 与可用自建 relay 的网络环境、区域、RTT、成功率与费用；没有自建端时标缺证，不编造比较结论。若寻址或 realm 路线不成立，先记录差距、评估薄工具适配/上游改进，再决定回退；不因一次失败自动换整套技术栈。

实验固定参数后才能报告达标。A1 先采用以下测试基线，不冒充最终生产默认值：

- 预热 20 次，读取 4 KiB 文件 200 次，空闲与持续 10 MiB 合成 bulk 输出两组；记录 p50/p95/p99、吞吐、超时和各级队列峰值。
- 消费者暂停 30 秒后恢复，另测并发 8 个读请求；队列不得超过配置硬上限，不得丢控制消息或把截断结果当完整数据。
- 候选体验门槛：4 KiB read 的 p95 ≤ 500ms，bulk 下 p95 ≤ 空闲两倍；不满足先区分路由、队列和调度原因，再调整默认中继/产品范围。
- 心跳间隔、失活超时、grant TTL 与清理超时在 A1 填入实测配置，断线与撤销测试报告实际检测/回收时间；不得仍用“即时响应”代替指标。

### 9.2 实施前仍需决策

| 未决项 | 负责人/关口 | 不能越过的条件 |
|---|---|---|
| 同会话双目标还是明确分会话 | 产品确认，A0 | 不能丢失本地/房主工具可区分的要求 |
| 无 session bridge/surface 与持久存储 API | A0 运行时 Inspect + smoke | 不暴露房主 DSH Web，不用 Agent 假充入口 |
| 密钥交换库、模式与 wire 编码/上限 | A1 | 未认证不能接触真实能力 |
| 远端不可信输入下链接竞态支持范围 | A2 | 不拿现有 fs-sandbox 的本地威胁模型当安全证明 |
| 精确 DSH/Node 支持版本 | A0 固定，发布持续验证 | 参考 clone 与安装版差异必须记录，能力缺失失败关闭 |

## 10. 证据与参考

源码参考固定在 `reference/deepseek-harness` 的 `22ddee37`，不是当前安装版接口的替代权威。2026-10-26 实时 Inspect 已确认 `sandboxPolicy.resolve` 支持 agentless fallback、preset 的 `select` 限首 turn 前、`serviceFor` 显式取隔离服务，以及 session 右栏的作用域；未做任何插件实现验证。

| 事实 | 本地参考路径（相对 DSH clone） |
|---|---|
| 显式 policy、默认写围栏、temp 语义 | `packages/fs/fs-sandbox/src/index.ts`；`packages/sandbox/sandbox/src/roots.ts` |
| fs 同步/异步 seam、结果 before/after | `packages/fs/fs/src/{index,types}.ts`；`packages/ssh/fs-ssh/src/index.ts` |
| realpath、列表子项和原子变更 | `packages/fs/fs-local/src/{index,fsio}.ts` |
| 搜索直接 spawn 与访客 rg 路径 | `packages/fs/tool-fs-search/src/{index,search-core}.ts` |
| observation policy 不等于工具本体 | `packages/fs/{tool-fs,fs-observation-policy}/src/index.ts` |
| 跨 OS 消费者问题 | `packages/fs/tool-str-replace-editor`；`packages/session/working-directory`；`packages/shell/{tool-bash,shell-env,bash-local}` |
| preset 共享代际、realm 与泄漏审计 | `packages/preset/agent-preset-registry/{README.zh.md,src/mount.ts}` |
| 普通进程/PTY 契约 | `packages/subprocess/subprocess/src/{index,types}.ts`；`packages/ssh/subprocess-ssh` |
| 无 Agent 审批限制、本地桥 | `packages/interaction/user-approval`；`packages/api/{gateway,remotes}` |

外部资料在本轮审阅通过 Tavily CLI 检索并读取正文；平台数值为检索时状态，部署前重核：

- [MDN WebSocket API](https://developer.mozilla.org/en-US/docs/Web/API/WebSockets_API) 与 [bufferedAmount](https://developer.mozilla.org/en-US/docs/Web/API/WebSocket/bufferedAmount)：缺少接收背压、本地发送队列的含义。
- [Node 22 WebSocket](https://nodejs.org/docs/latest-v22.x/api/globals.html#class-websocket)：客户端 API 稳定状态。
- [Cloudflare DO WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)、[Limits](https://developers.cloudflare.com/durable-objects/platform/limits/)、[Pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)：休眠、消息限制、配额与费用。
- [Noise Protocol Framework](https://noiseprotocol.org/noise.html)：认证握手、PSK、transcript、密钥与 nonce 的设计参照，不等于已选实现。
- [VS Code Remote-SSH](https://code.visualstudio.com/docs/remote/ssh)、[open-remote-ssh](https://github.com/jeanp413/open-remote-ssh)、[ShellHub](https://github.com/shellhub-io/shellhub)：部署、隧道、生命周期与逻辑通道参考。
