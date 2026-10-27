# dsh-room

把正在运行的 DSH Web 共享给完全信任的人。访客用浏览器直接打开，不安装任何东西。

> 共享的是**完整的本机操作能力**：会话、文件、终端。获准访客可以执行房主账号能执行的操作，也能读取房主可读的文件。这不是只读沙箱，也不是访客降权。

## 三种接入方式

| 方式 | 房主准备 | 访客操作 | 跨机加密 | 适用 |
|---|---|---|---|---|
| **SSH 转发** | 已有 OpenSSH 服务 | `ssh -L` 一条命令 | SSH 保护整条 TCP | 同一私网、电脑端 |
| **私网 HTTPS** | 证书 + 私钥 | 浏览器打开链接 | HTTPS + WSS | 同一私网、任意设备 |
| **公网中继** | 一个中继入口（Worker 或自建） | 浏览器打开链接 | 访客↔中继 TLS，房主主动外连 | 跨网络 |

前两种下，房间网关只监听 `127.0.0.1`；第三种下房主**不需要任何入站端口**，由房主主动拨出到中继。

### SSH 转发

网关默认监听 `127.0.0.1:19443`。访客在本机执行：

```text
ssh -N -T -o ExitOnForwardFailure=yes -o StrictHostKeyChecking=yes \\
  -o ServerAliveInterval=30 \\
  -L 127.0.0.1:17443:127.0.0.1:19443 <房主账户>@<房主私网地址>
```

然后浏览器打开 `http://127.0.0.1:17443/join#<邀请码>`。

**注意端口**：访客看到的是自己本机的 17443，不是 19443。面板里的邀请链接按网关端口生成；走 SSH 时把链接里的 `127.0.0.1:19443` 换成 `127.0.0.1:17443` 再打开。房间网关对 loopback 来源接受任意端口（与 DSH 自身的信任栅栏一致），所以这种改写是允许的。

首次连接前请通过独立可信渠道核对房主 SSH 主机密钥。

### 私网 HTTPS

设置 `listenHost` 为某块网卡的私有地址，并提供 `tlsCertFile` / `tlsKeyFile`。

**明文共享只允许 loopback。** 绑定任何非回环地址时，缺少证书会在开房阶段直接失败（`BIND_FORBIDDEN`）。插件拒绝 `0.0.0.0`、`::` 与公网地址；证书的 SAN 必须覆盖访问用的 IP 或名称。

### 公网中继

房主主动外连，中继负责把访客的 HTTP 与 WebSocket 复用回房主。仓库里有两份中继实现，协议相同（`src/relay-protocol.ts`，v1）。

**A. Cloudflare Worker（推荐，无需自备服务器）**

```text
cd relay/worker
wrangler secret put RELAY_SECRET      # 至少 16 字符，与插件配置一致
wrangler deploy
```

`wrangler.toml` 已声明 Durable Object 绑定：一个房间对应一个 DO 实例，由它持有房主那条长连接并复用所有访客流量。Worker 本身是无状态的，**没有 Durable Object 就做不到这件事**。

部署后，在房主面板或配置里填：

| 配置 | 值 |
|---|---|
| `relayUrl` | `wss://<你的 worker 域名>/tunnel` |
| `relayRoom` | 与 `wrangler.toml` 的 `ROOM_NAME` 一致 |
| `relaySecret` | 与 `RELAY_SECRET` 一致 |
| `relayPublicUrl` | `https://<你的 worker 域名>` |

面板也支持运行时连接：`/api/room` 的 `relay.connect` 接受 `{url, room, secret, authority, publicUrl}`，密钥只留在内存。

**B. 自建 Node 中继**

```text
RELAY_SECRET=... RELAY_ROOM=demo PORT=8443 node relay/server.mjs
# 可选：RELAY_CERT / RELAY_KEY 直接提供 TLS
```

放在 VPS 上、前面套一层 Nginx/Caddy 终止 TLS，就能得到一个公网入口。

**中继的边界**

- 中继看得见密文之外的元数据（请求路径、头部），但拿不到 DSH 的 launch token 与浏览器 cookie。
- 房主侧连接鉴权用的是 `RELAY_SECRET`；访客仍要走房间的邀请与批准，中继本身不是授权层。
- 中继把房主暴露给公网，这是**搭中继的核心目的**，与“只绑私网”互斥。不启用中继时行为不变。

## 配对流程

1. 房主点「开启房间」，再点「生成邀请链接」。
2. 邀请链接带一次性高熵令牌，默认 5 分钟有效；打开后立即从地址栏移除。
3. 访客填名字、点「申请加入」，进入等待。
4. 房主面板出现「待批准」，显示访客填的名字与直连地址；线下确认后批准。
5. 访客获得房间会话 Cookie，之后 HTTP 与 WebSocket 都由网关转发到本机 DSH。

房主可随时踢人或关房：**踢出会断开该成员已建立的 WebSocket**，并让后续请求返回 401。已经提交的后台任务（例如终端里跑着的命令）不受影响。

## 安全边界

- 网关只转发到本机当前监听的那个 DSH 地址，访客无法指定上游目标。
- 每个请求先做来源网段、`Host`、`Origin` / Fetch Metadata 检查，再注入上游 Cookie。
- 访客拿不到 DSH 自己的 `dsh-auth-*` Cookie；上游的 `Set-Cookie` 一律不转发。
- 共享端口上的 `/api/room*`（房主控制面）直接 404。
- HTTP 只转发到核心 mux 与页面资源；未识别的 WebSocket 升级路径默认拒绝。
- 中继连接期间，只有持有随机 `x-dsh-room-relay` 令牌的连接器请求才被当作中继流量，访客无法自报来源地址。

以上防的是未授权访问与误配置，不是抵抗已经获准的访客。

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `listenHost` | `127.0.0.1` | 网关监听地址；非回环需要 TLS |
| `listenPort` | `19443` | 网关端口，`0` 表示临时端口 |
| `invitationTtlMs` | `300000` | 邀请有效时长 |
| `pendingTtlMs` | `300000` | 待批准请求保留时长 |
| `sessionIdleTtlMs` | `1800000` | 访客会话空闲超时 |
| `sessionMaxTtlMs` | `28800000` | 访客会话绝对上限 |
| `maxPending` / `maxMembers` | `8` / `16` | 同时等待 / 在线上限 |
| `allowedCidrs` | `[]` | 允许的直接来源网段，默认仅回环 |
| `authorityAliases` | `[]` | 额外接受的 `Host` / `Origin` |
| `tlsCertFile` / `tlsKeyFile` | `''` | HTTPS 证书与私钥路径 |
| `relayEnabled` / `relayUrl` / `relayRoom` / `relaySecret` | 关闭 / `''` | 中继接入 |
| `relayPublicAuthority` / `relayPublicUrl` | `''` | 中继的公开 authority 与邀请链接前缀 |

## 开发

```text
node scripts/build.mjs         # lib/index.js + lib/client.js
node_modules/.bin/tsc --noEmit
node_modules/.bin/vitest run   # 43 个测试
node --check relay/worker/src/index.js
```

端到端脚本（需要先起一个隔离 profile 的实例）：

```text
node scripts/e2e-deep.mjs  <ownerBase> <token>                 # 面板 UI + 访客完整流程
node scripts/e2e-ssh.mjs   <ownerBase> <token> 19443 17443     # 模拟 ssh -L 的端口改写
node scripts/e2e-relay.mjs <ownerBase> <token> <relayAuthority> # 中继链路
```

## 状态

**已验证**（隔离 profile、真实浏览器）：
房间生命周期、一次性邀请、待批准队列、独立会话、踢人（含断流）、HTTP/WS 反代、上游凭据交换、控制面隔离、来源与 Origin 栅栏、SSH 端口改写、中继链路（Node 中继）。

**已实现但未在公网部署验证**：Cloudflare Worker 中继。Durable Object 的路由逻辑有内存桩测试覆盖（`tests/integration/worker-room.spec.ts`，9 项），但本仓库没有部署凭据，真实 Worker 的 WebSocket 上限、CPU/时长限制需要在部署后实测。

**未实现**：审计日志、网卡变化自动停服、证书 SAN/有效期校验、指定社区插件的额外 WebSocket 路由、多房间并存。
