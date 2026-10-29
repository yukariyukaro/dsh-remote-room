# dsh-remote-room 使用与维护指南

这份文件随 npm 包发布，装好后位于
`<profile>/node_modules/@yukariyukaro/dsh-remote-room/GUIDE.md`。
DSH 里的 agent 可以用 `remote_room_guide` 工具拿到它的绝对路径与源码树位置，也可以直接读本文件；源码在本目录的 `src/`。

- 包名：`@yukariyukaro/dsh-remote-room`
- 设置里的名字：**远程工作区**
- 适用：DSH `>=0.2.1-rc.2 <0.2.2`，Node `>=24.9`

## 1. 这是什么

房主在自己机器上挑一个目录、选一档权限、生成邀请；访客用**自己的** agent、模型和 API key，通过 `remote_*` 工具读写房主授权的那个目录。房主的 DSH Web 界面不暴露给访客，房主也不需要开任何入站端口（跨网络时由房主主动外连中继）。

两端各自安装同一个包。房间的创建、批准与撤销**没有 agent 工具入口**，只能在界面里由人完成——这是刻意的授权边界，不是缺功能。

## 2. 安装

```powershell
dsh plugin --profile <profile 名> add @yukariyukaro/dsh-remote-room
```

- profile 名：桌面版通常是 `desktop`，`dsh web` 通常是 `web`。命令本质是在该 profile 目录里执行 pnpm add。
- 有插件管理工具时等价于 `plugin_manager` 的 `install_bundle`，target 传包名。
- 插件包的 `dsh.bundle.patch` 会往该 profile 的 `cordis.patch.yml` 末尾插入条目；`files` 里的 `GUIDE.md` 与 `src` 会随包落到本机，因此安装后仍能读到文档与原始源码。
- 版本不满足 `engines.dsh` 时安装会被挡下；版本豁免有崩溃风险，需本人明确同意。

## 3. 升级与卸载

```text
# 升级：装最新版后重启 DSH
dsh plugin --profile <profile 名> add @yukariyukaro/dsh-remote-room

# 卸载：移除依赖与注册，重启后设置里不再出现「远程工作区」
dsh plugin --profile <profile 名> remove @yukariyukaro/dsh-remote-room
```

npm 上的 `latest` 只是发布线，不保证与本机 DSH 版本兼容；升级前先看 `engines.dsh`。

## 4. 房主：共享一个目录

入口：设置 →「远程工作区」→「共享你的工作区」。要点：

- **共享目录**：点「浏览…」选目录；拿不到原生选择器时点「直接输入路径」粘贴绝对路径。
- **访问权限**：只读 / 可读可写 / 完整访问（见 §6），默认选最保守能用的那档。
- **谁能加入**：同一 Wi-Fi 选「同一局域网」（插件在房主进程内起内置中继，不经第三方）；跨网络选「跨网络」，必须先在「中继地址」填 `wss://` 地址并「保存」。
- **生成邀请**：得到 `dsh-room://join/v2#…`，默认 5 分钟有效（`invitationTtlMs`），过期只能「重新生成」。
- **批准**：访客申请后出现「有人请求进入」，确认身份再点「允许进入」；随时可「结束共享」撤销。

房间名自动等于目录名。邀请是高熵秘密，只私下发给要共享的人。

## 5. 访客：加入一个房间

入口：设置 →「远程工作区」→「加入别人的房间」→ 粘贴邀请 →「申请加入」→ 等房主批准 → 状态「已连接」。

连接后可用工具（坐标都是房间 ID + 授权 epoch + 房主侧绝对路径）：

| 工具 | 作用 |
|---|---|
| `remote_rooms` | 列出房间、epoch、根目录、权限档位（只读发现） |
| `remote_read` / `remote_list` | 分页读文本 / 列目录 |
| `remote_write` / `remote_edit` | 写 / 字面替换，必须先用 `remote_read` 拿到 observedVersion |
| `remote_process_*` | 仅在完整访问档可用 |

断线、撤权、未知结果不会回落到访客本机，也不会自动重放写入；返回值的 `source` 恒为 `"remote-room"`。

## 6. 权限三档

| 档位 | 能做什么 |
|---|---|
| `read-only` | 共享根内读取 |
| `workspace-write` | 共享根内读写；两档都拒绝任意命令 |
| `danger-full-access` | 整机文件与进程能力，含房主账户的网络权限 |

判定在 `src/host/access.ts`：非完整访问档要求路径同时在词法根内且真实目标在根内；进程执行在 `src/host/processes.ts` 只对完整访问档放行。

## 7. 中继（跨网络）

中继是独立部署单元：仓库内 `relay/` 有 Node 版与 Cloudflare Worker 版，部署步骤见 `docs/relay-deploy.md`。同机与局域网场景用内嵌中继，不需要外部服务。

地址来源优先级：界面里填过的会记住 > 环境变量 `DSH_REMOTE_ROOM_RELAY` / `DSH_REMOTE_ROOM_RELAY_TOKEN` > 插件 Config 的 `relayUrl`。生产地址必须是 `wss://`（纯 `ws://` 只允许 literal loopback 与 RFC1918 私有地址，因为中继只转发房间级 mTLS 密封后的字节）。

## 8. 配置项

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
| `auditBackend` | `json` | 审计所用 KV backend，缺失会直接报错，不静默降级 |

## 9. 排障

| 症状 | 位置 |
|---|---|
| 设置里没有「远程工作区」 | 插件未启用，或 DSH 没重启 |
| 「生成邀请」不可用 | 没选目录；或选了「跨网络」但「中继地址」为空 |
| 房主侧 `BIND_FORBIDDEN` | 非回环地址缺 TLS 证书 |
| 访客「连接失败」 | 中继地址/令牌、443 出网、或选错「同一局域网」 |
| 访客写失败 `FS_NOT_OBSERVED` | 没先 `remote_read`，或 epoch 已变 |
| 审计为空 | `auditBackend` 指向的 KV 不存在 |
| 需要追溯 agent 动作 | 读审计条目：操作 + 结果元数据（默认不含文件内容） |

## 10. 源码索引

| 路径 | 职责 |
|---|---|
| `src/index.ts` | 插件入口：审计、设置、房间控制器、工具注册 |
| `src/config.ts` | 配置 schema（§8） |
| `src/room-service.ts` | 房间生命周期、认证、授权 epoch、过期/撤销 |
| `src/invite.ts` / `src/share.ts` / `src/protocol.ts` | 邀请、共享描述、线协议 |
| `src/host/` | 房主半边：入口授权、审计存储、进程执行、设置、内嵌中继宿主 |
| `src/guest/` | 访客半边：`remote_*` 文件与进程工具 |
| `src/security/` | TLS 1.3 双向认证、房间证书与 pin |
| `src/wire/` | 有界 WebSocket duplex、credit 流控、framed RPC |
| `src/client/` | Web 客户端：房间面板、邀请卡、远端预览、文案 |
| `relay/` | 独立中继（Node + Cloudflare Worker） |
| `tests/` | 单元 / 集成 / 安全 / e2e |
| `docs/` | 开发状态、ADR、中继部署、迁移计划 |

改代码后的常规验证：

```text
pnpm install --ignore-scripts
pnpm run typecheck
pnpm run test          # 单元 + 集成
pnpm run test:e2e      # 真实网络 / 真实 provider
pnpm run build
pnpm run check:package
```

## 11. 已知边界

- 审计保存操作与结果元数据，不默认保存文件内容，不提供完整回滚。
- 文件操作逐组件拒绝符号链接/junction，但 canonicalize 到 syscall 之间仍有残余 TOCTOU。
- 邀请 v2 证明对方持有邀请凭证，不证明某个自然人身份；同一邀请的持有人可冒充任一角色。
- 浏览器侧批准排除独立 API owner，但不是「真人证明」。
- Cloudflare Worker 中继尚未完成真实部署与压力验证。
- 桌面端原生目录选择器只有接入点，未做真实点击验收。
- 跨网络分享需要「已经有人给你一个中继地址」：插件不自带公共中继，`relayUrl` 为空时「跨网络」走不通；同一 Wi-Fi 用「同一局域网」不需要中继。
- 拿不到原生选择器时退回手填绝对路径，零基础用户容易卡在这一步。

## 12. 两端版本不一致会怎样

**插件版本可以不相等，协议版本才决定能不能互通。** 0.5.x 与 0.4.x 混用是安全的：0.5 只新增了本地只读工具与随包文档/源码，协议层没变。

三道闸门：

1. **邀请自带版本**：`dsh-room://join/v2`。版本不对直接 `INVALID_INVITATION`。
2. **握手钉死协议号**：`control.hello` 固定报 `protocol: 2`；房主侧不认就抛 `VERSION_MISMATCH`，房间进 `failed`，不会半连通。
3. **方法白名单**：授权后房主只接受固定方法集合，未知操作返回 `METHOD_NOT_FOUND`；访客侧只接受 `control.grant` / `control.ping`，房主无法反向调用访客本地能力。

未覆盖：协议号相同但语义被改的版本不会被拒绝，也没有「最低版本」通告。协议一变两端必须一起升，跨网络中继两侧尤其如此。

## 13. 邀请的结构与判据

邀请是 `dsh-room://join/v2#relay=…&room=…&certificate=…&key=…`，参数放在 `#` 后面：

| 字段 | 含义 | 判读 |
|---|---|---|
| `relay` | 房主这一侧实际使用的接入地址 | 内网 `ws://` = 走了「同一局域网」；`wss://` = 走了「跨网络」 |
| `room` | 房间 ID（32 位 base64url） | 与状态栏一致即同一房间 |
| `certificate` / `key` | 房间专用证书与私钥 | 证明持有邀请；不得转发或写日志 |

解析器只认 v2 且严格四项（`src/invite.ts` 的 `parseInvitation`）：多一字段、少一字段、版本不是 v2 都会报 `INVALID_INVITATION`。所以「邀请被聊天软件截断」是最常见的人为故障——先查这一条。

读取邀请关键字段（不落盘、不打印私钥）：

```text
node -e "const u=new URL(process.argv[1]);const p=new URLSearchParams(u.hash.slice(1));console.log(JSON.stringify({shape:u.protocol+'//'+u.hostname+u.pathname,relay:p.get('relay'),room:(p.get('room')||'').slice(0,8),fields:[...p.keys()]}))" "<邀请链接>"
```
