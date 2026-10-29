# dsh-remote-room 使用与维护指南

这份文件随 npm 包一起发布，装好插件后就在
`<profile>/node_modules/@yukariyukaro/dsh-remote-room/GUIDE.md`。
DSH 里的 agent 可以用 `remote_room_guide` 工具拿到它的绝对路径与源码树位置，也可以直接读本文件；源码在本目录的 `src/`。

- 包名：`@yukariyukaro/dsh-remote-room`
- 设置里的名字：**远程工作区**
- 适用：DSH `>=0.2.1-rc.2 <0.2.2`，Node `>=24.9`

**先记住三件事**

1. **两端都要装**：房主和访客各自在自己的 DSH 里装同一个包。
2. **只认这个包名**。npm 上的 `dsh-room` 是别人的占位包，不是本项目。
3. **共享的不是只读沙箱**：权限选到 `danger-full-access` 时，访客拥有的就是房主账户的文件与进程能力。

---

## 1. 一句话了解它

房主在自己机器上挑一个目录、选一档权限、生成邀请；访客用**自己的** agent、模型和 API key，通过 `remote_*` 工具读写房主授权的那个目录。房主的 DSH Web 界面不会暴露给访客，房主也不需要开任何入站端口（跨网络时由房主主动外连中继）。

房主侧工作流：设置 →「远程工作区」→ 选目录 → 选权限 → 生成邀请 → 访客申请后点「允许进入」。
访客侧工作流：拿到邀请 → 粘贴 → 申请加入 → 等房主批准 → 出现远程房间 → 用 `remote_*` 工具操作。

---

## 2. 安装

### 2.1 给 AI 的口令（非技术用户用这条）

把下面整段粘进 DSH 对话框，遇到权限询问点「允许」，装完按提示重启：

```text
请帮我在这台电脑上安装一个 DSH 插件：@yukariyukaro/dsh-remote-room（当前发布线 0.4.x / 0.5.x）。
我是一个不懂电脑的人，请你自己动手做完，不要让我敲命令、不要一次给我多个方案。

1. 先告诉我这台电脑上 DSH 的版本号。
2. 用插件管理工具安装：plugin_manager，action=install_bundle，target=@yukariyukaro/dsh-remote-room。
   如果这个工具不可用，就改用 DSH 自带命令行：
   Windows 在 <DSH 安装目录>\resources\runtime\cli\bin\dsh.cmd，macOS 在 resources/runtime/cli/bin/dsh，
   执行：dsh plugin --profile <当前 profile 名> add @yukariyukaro/dsh-remote-room
   当前 profile 名自己判断（桌面版通常 desktop，dsh web 通常 web），不要问我。
3. 弹出「需要完全访问权限 / 允许 / 批准」时，告诉我「请点允许」，等我点完再继续。
4. 装完确认三件事：在插件列表里、版本正确、状态已启用。
5. 告诉我要不要重启 DSH、重启后去哪个位置找它（设置里叫「远程工作区」）。

约束：只做这一件事；不要升级/删除/禁用其它插件；不要新建或修改我的工作区；
DSH 版本与本插件要求不符时不要自行豁免版本检查，先告诉我版本和风险，等我决定。
最后用中文、最简短地汇报：装成功没有、要不要重启、在哪里打开。
```

### 2.2 装完验收

```text
我刚装了插件 @yukariyukaro/dsh-remote-room，请帮我确认能不能用：
1. 插件列表里的状态：装了没有、版本、是否启用。
2. 设置里是否出现「远程工作区」。
3. 没出现的话，判断是「需要重启」还是「安装失败」，用一句人话说明原因和一个下一步动作。
只要结论 + 一个动作，不要排查清单。
```

### 2.3 手动命令

```powershell
dsh plugin --profile web add @yukariyukaro/dsh-remote-room
```

profile 目录里的 `package.json` 会多出这条依赖，`cordis.patch.yml` 末尾由包的 `dsh.bundle.patch` 自动插入条目。

### 2.4 安装失败

把报错原样贴回去：

```text
安装 @yukariyukaro/dsh-remote-room 失败了，报错原样贴在下面：

【整段粘贴，一个字都别删】

请判断原因直接修好，不要让我查资料或改配置：
- 下载/网络问题 → 换镜像源 https://registry.npmmirror.com 重试
- DSH 版本不匹配 → 先告诉我当前版本与要求版本，再问我要不要继续
- 需要重启才生效 → 告诉我怎么重启
修一次就停，最多重试两次。修完告诉我：能用了吗？不能用的话，唯一需要我点的地方在哪。
```

常见原因：包名写错（要带 `@yukariyukaro/` 前缀）、DSH 版本不在 `0.2.1-rc.x` 区间被 engines 挡下、公司网络拦截 registry。

---

## 3. 升级与卸载

```text
把 @yukariyukaro/dsh-remote-room 升级到 npm 最新版本，装好后告诉我版本号和要不要重启。
不要动其它插件，也不要改我的设置。
```

```text
帮我把 @yukariyukaro/dsh-remote-room 卸载干净：移除当前 profile 里的依赖和注册，
重启后设置里不再出现「远程工作区」。不要删我的会话、文件和其它插件设置。
```

手动：`dsh plugin --profile <name> remove @yukariyukaro/dsh-remote-room`，然后重启 DSH。

---

## 4. 房主：共享一个目录

```text
我已经装好「远程工作区」插件，想把本机一个文件夹共享给朋友。我是房主。
请一步一步告诉我点哪里，每步一句话，最多 6 步，不要讲原理：
打开哪个入口 → 怎么选文件夹 → 权限选哪个最保守能用的 → 点哪个按钮生成邀请 →
怎么发给朋友 → 朋友申请后我在哪里点「允许」。
最后提醒我一句：邀请只发给认识的人，用完在哪里撤销。
```

要点：

- 房间名自动等于目录名。
- 邀请是高熵秘密，默认 5 分钟有效（`invitationTtlMs`）；**不要**发到群里、issue、公开页面。
- 「谁能加入」默认跨网络；同一 Wi-Fi 场景切「同一局域网」即可完全不经第三方（插件在房主进程内起内置中继）。
- 授权有期限（`grantTtlMs`，默认 1 小时），可随时撤销；撤销即时生效，已读走的数据收不回来。

## 5. 访客：加入房间

```text
朋友给我发了一个 DSH 远程房间的邀请，我也装了同一个插件，现在要加入。我是访客。
请一步一步告诉我怎么做，每步一句话，最多 5 步：
在哪里粘贴邀请 → 点哪个按钮 → 申请后等什么 → 房主同意后我怎么看到对方的文件夹。
顺便确认：用的是我自己的模型和 API key，不会用到房主的，对吧？
```

访客拿到的工具（都以房间 ID + 授权 epoch + 房主侧绝对路径为坐标）：

| 工具 | 作用 |
|---|---|
| `remote_rooms` | 列出房间、epoch、根目录、权限档位（只读发现） |
| `remote_read` / `remote_list` | 分页读文本 / 列目录 |
| `remote_write` / `remote_edit` | 写文件 / 字面替换，必须先用 `remote_read` 拿到 observedVersion |
| `remote_exec*` 家族 | 仅在 `danger-full-access` 且房主授权时可用 |

边界：断线、撤权、未知结果不会回落到访客本机，也不会自动重放写入。

---

## 6. 权限三档

| 档位 | 能做什么 |
|---|---|
| `read-only` | 共享根内读取 |
| `workspace-write` | 共享根内读写；两档都拒绝任意命令 |
| `danger-full-access` | 整机文件与进程能力，含房主账户的网络权限 |

选最保守能用的那一档。`danger-full-access` 不是提权，但也不是沙箱。

---

## 7. 中继（跨网络）

中继地址不写死在代码里：用环境变量 `DSH_REMOTE_ROOM_RELAY` / `DSH_REMOTE_ROOM_RELAY_TOKEN`，或界面里填一次由插件记住（配置项 `relayUrl`）。部署见 `docs/relay-deploy.md`；同机/局域网用内嵌中继，无需外部服务。生产地址必须是 WSS（纯 WS 只允许 loopback 与 RFC1918 私有地址）。

---

## 8. 配置项

在插件条目 config 里改（`cordis.patch.yml`）：

| 键 | 默认 | 说明 |
|---|---|---|
| `relayUrl` | `''` | 中继地址 |
| `relayCreateToken` | `''` | 中继创建门禁令牌，**不要**随邀请分发 |
| `invitationTtlMs` | 300000 | 邀请有效期 |
| `grantTtlMs` | 3600000 | 授权有效期 |
| `rpcTimeoutMs` | 30000 | 单次远端调用超时 |
| `maxRooms` | 2 | 同时存在的房间数 |
| `maxFileBytes` | 2097152 | 单文件上限 |
| `maxDirectoryEntries` | 2000 | 目录条目上限 |
| `auditMaxEntries` / `auditMaxBytes` | 2000 / 2097152 | 审计环形缓冲 |
| `auditBackend` | `json` | 审计用的 KV backend，缺省会直接报错，不静默降级 |

---

## 9. 出问题怎么查

| 现象 | 先看这里 |
|---|---|
| 设置里没有「远程工作区」 | 插件是否已启用、DSH 是否重启过 |
| 生成邀请失败 | 目录是否可读、`maxRooms` 是否已满、日志里的 `BIND_FORBIDDEN`（非回环地址缺证书） |
| 访客连不上 | 中继地址/令牌、防火墙、是否选了「同一局域网」但不在同一网段 |
| 能连上但读不了 | 路径是否在共享根内、是否被 `maxFileBytes`/`maxDirectoryEntries` 截断 |
| 写失败 `FS_NOT_OBSERVED` | 没先 `remote_read`，或 epoch 变了（授权已换） |
| 审计缺失 | `auditBackend` 配的 KV 是否存在 |
| 想追溯 agent 做了什么 | 读审计条目：操作 + 结果元数据（默认不含文件内容） |

---

## 10. 源码索引（要改哪里）

| 路径 | 职责 |
|---|---|
| `src/index.ts` | 插件入口：挂审计、设置、房间控制器、工具注册 |
| `src/config.ts` | 配置 schema（上表） |
| `src/room-service.ts` | 房间生命周期、认证、授权 epoch、过期/撤销 |
| `src/invite.ts`、`src/share.ts`、`src/protocol.ts` | 邀请、共享描述、线协议 |
| `src/host/` | 房主半边：全入口文件授权、审计存储、进程执行、设置、本地中继宿主 |
| `src/guest/` | 访客半边：`remote_*` 文件工具与进程工具 |
| `src/security/` | TLS 1.3 双向认证、房间证书与 pin |
| `src/wire/` | 有界 WebSocket duplex、credit 流控、framed RPC |
| `src/client/` | Web 客户端：房间面板、邀请卡、远程预览、locale |
| `relay/` | 独立中继服务（Node 版 + Cloudflare Worker） |
| `tests/` | 单元 / 集成 / 安全 / e2e（真实网络与真实 provider） |
| `docs/` | 开发状态、迁移计划、ADR、中继部署 |
| `GUIDE.md` | 本文件：安装口令 + 使用 + 维护 + 源码索引 |

改代码前的常规验证：

```text
pnpm install --ignore-scripts
pnpm run typecheck
pnpm run test          # 单元 + 集成
pnpm run test:e2e      # 真实网络 / 真实 provider
pnpm run build
pnpm run check:package # 导出、locale、客户端 bundle 语法、本指南存在性
```

---

## 11. 已知边界

- 审计保存操作与结果元数据，不默认保存文件内容，不提供完整回滚。
- 文件操作逐组件拒绝符号链接/junction，但 canonicalize 到 syscall 之间仍有残余 TOCTOU。
- 邀请 v2 证明对方持有邀请凭证，不证明某个自然人身份；同一邀请的持有人可冒充任一角色。
- 浏览器侧批准排除独立 API owner，但不是「真人证明」。
- Cloudflare Worker 中继尚未完成真实部署与压力验证。
- 桌面端原生目录选择器只有接入点，未做真实点击验收。
- 跨网络分享需要「已经有人给你一个中继地址」。插件不自带公共中继，`relayUrl` 默认为空时「跨网络」这条路径走不通；同一个 Wi-Fi 用「同一局域网」不需要中继。
- 桌面端在拿不到原生目录选择器时退回手填绝对路径，零基础用户容易卡在这一步。

---

## 12. 两端版本不一致会怎样

**结论：插件版本可以不相等，协议版本才决定能不能互通。** 0.4.x 和 0.5.x 混用是安全的——0.5.0 只新增了一个本地只读工具（`remote_room_guide`）和随包文档/源码，协议层零改动。

具体的三道闸门：

1. **邀请自带版本号**：`dsh-room://join/v2`。解析时版本不对直接 `INVALID_INVITATION`（"Unsupported invitation version; create a new v2 invitation"），旧邀请不会被当成新协议硬用。
2. **握手必须同协议号**：连接后第一步是 `control.hello`，邀请侧固定报 `protocol: 2`；房主侧不认就抛 `VERSION_MISMATCH`（"Unsupported remote room protocol"），房间进 `failed`，不会半连通地跑。
3. **操作走白名单**：授权后房主只接受固定方法集合，未知操作返回 `METHOD_NOT_FOUND`；访客侧也只接受 `control.grant` / `control.ping`，房主无法反向调用访客的本地能力。

**风险点（当前未覆盖）**：协议号相同但语义被改动的版本不会被拒绝，也没有「最低版本」通告——两侧都报 2 就会互通。所以跨版本混用只在「协议未变」时安全；升级时两端一起升，跨网络中继两侧尤其如此。

排查版本问题：房主日志里的 `VERSION_MISMATCH` = 协议不认；访客侧的 `INVALID_INVITATION` = 邀请格式版本不认。两者都属硬失败，不会悄悄降级。
