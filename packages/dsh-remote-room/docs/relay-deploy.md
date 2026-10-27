# 公网中继部署（可选）

0.3.1 起共享默认面向**非同网络**：房主需要一台双方都能连出去的中继。仓库**不内置任何中继地址**——地址与创建门闩由使用者本地提供：

```powershell
# .env（或直接设进程环境变量）
DSH_REMOTE_ROOM_RELAY=wss://<你的实例>.workers.dev
DSH_REMOTE_ROOM_RELAY_TOKEN=<部署时写入的 CREATE_TOKEN>
```

优先级：界面里保存过的值 > 环境变量 > 插件 Config。界面填一次会记住，之后无需再填。只想在同一 Wi-Fi 内共享时，把“谁能加入”切到「同一局域网」，插件会在房主进程内按需启动内置中继，不经过任何第三方。

## 为什么需要

NAT 是单向的：内网机器能连出去，外面连不进来。两台都在 NAT 后的机器没有任何一方能先发起连接，所以必须有一个“双方都能主动连出去”的可达点。SSH 不能替代它——`ssh -R` 同样要求一台公网可达的跳板机。

中继只见密文：房间级 mTLS 在字节流内部完成，中继只做配对与转发。

## 使用 Cloudflare Worker（推荐，免费额度足够）

仓库内 `relay/` 是现成实现：Worker 入口 + SQLite 支撑的 Durable Object，一次部署得到一个固定的 `wss://<name>.<子域>.workers.dev`。

```powershell
cd relay
npx wrangler login                                # 一次浏览器授权
npx wrangler deploy --config wrangler.toml        # 输出 workers.dev 地址
$token = -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 43 | % {[char]$_})
"$token" | npx wrangler secret put CREATE_TOKEN   # 房主创建房间时的门闩
```

然后把 `wss://<name>.<子域>.workers.dev` 和同一个 `CREATE_TOKEN` 填进插件：设置 → 远程房间 → 「谁能加入」选**公网** → 中继地址 → 保存。地址会被记住，之后共享不再需要输入。

注意：

- `CREATE_TOKEN` 只用于限制**创建**房间；邀请本身是独立的房间证书，不要把它放进邀请。
- 不要把 `/v1/rooms/...` 的查询参数写进访问日志。
- 免费版 Durable Object 只支持 SQLite 后端（`wrangler.toml` 已按此声明）；`workers.dev` 不属于自有 zone，无法挂 WAF 限流，滥用面由 `CREATE_TOKEN` 与应用内每房间限额承担。
- 想长期公开给他人使用前，先评估配额与滥用处置；个人自用无需额外配置。

## 自建（可选）

`relay/src/server.ts` 是一个普通 Node WebSocket 服务端，可以放在任意有公网地址的机器上，前面接一层 TLS 反向代理终止 `wss`：

```powershell
node --experimental-strip-types relay/src/server.ts   # 仅供本地联调
```

生产建议：反向代理负责 `wss`，进程只监听 loopback，并按 `relay/README.md` 配置上限。

## 如果两端都有公网 IPv6

这条路径不需要中继，但当前版本**尚未实现**（需要给内置中继加自签 TLS 与邀请内的证书指纹，并放开 `wss://[IPv6]:port` 校验）。它适合“双方都有全局 IPv6 且路由器允许入站”的场景，属于后续增强，不替代上述中继。
