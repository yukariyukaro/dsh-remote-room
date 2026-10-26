# dsh-remote-room

> 一个 DSH 插件：让「帮忙的人」用自己的 DSH agent，去操作「被帮的人」电脑上的文件和终端。

**当前状态：方案阶段，还没有代码。** 下一步是 M0 传输验证。

## 一句话架构

两条**出站** WSS 连到同一个中继房间，之间跑自写多路复用 + 命名协议 + 端到端加密。房主不监听任何端口、不跑 agent、不开 Web UI。

## 三条必须记住的约束

1. **房主只出能力**：目录、可选终端、审计。没有 agent、没有会话、没有 Web UI。
2. **房主零入站端口**：只有出站 WSS，NAT 后面也能用。
3. **权限直接用 DSH 自己的**：`read-only` / `workspace-write` / `danger-full-access`，不自造档位。

## 文档

| 文档 | 内容 |
|---|---|
| [`docs/dsh-remote-workspace-plan.md`](docs/dsh-remote-workspace-plan.md) | **当前方案 v5**：决策表、技术栈、权限模型、协议、里程碑、风险 |
| `docs/archive/` | 历史版本（v1 会话共享 → v2 能力 RPC → v3 provider 替换 → v4 反向隧道 → v5 复用 DSH 权限）。只做追溯，不代表现状 |

## 技术栈速查

| 项 | 选择 |
|---|---|
| 语言 | TypeScript，ESM only |
| 打包 | `tsdown`，单包双入口（host + client） |
| 运行时依赖 | **1 个**：`@deepseek-ai/schemastery` |
| 传输 | Node 全局 `WebSocket` → 中继（默认 Cloudflare DO，可换自建/WebRTC） |
| 多路复用 | 自写，约 60–80 行，无窗口（背压走 `Readable.pause()`） |
| 权限 | 复用 `dsh-sandbox-policy` 的模式 + `dsh-fs-sandbox` 的写围栏 |
| 终端 | 房主 `ctx.subprocess.spawnTerminal` |

## 接下来：M0

验收标准：

- 一条 WSS 上同时跑 `ctl` + `fs` 两条命名协议；
- 大终端流量下 `fs` 请求仍即时响应；
- RTT（境外 DO / 自建转发各一次）与 `room_read` 的 p95 延迟记录在案。

任一项超标就上 WebRTC 直连，mux 与协议一行不改。

## 参考实现（本地克隆，不在本仓库内）

| 项目 | 本地路径 | 用来看什么 |
|---|---|---|
| DSH 源码（MIT） | `../vendor/deepseek-harness` | `packages/ssh/*`（远端 provider 形状）、`fs/fs-sandbox`、`sandbox/sandbox-policy` |
| open-remote-ssh | `../vendor/open-remote-ssh` | 隧道 = 本地监听 + `forwardOut`、重连判据、`execChannel` 不分配 PTY |
| ShellHub（Apache-2.0） | `../vendor/shellhub` | 反向隧道、按流协商协议名、设备端不 `Listen` |

## 目录

```
docs/                      设计文档
  dsh-remote-workspace-plan.md   当前方案 v5
  archive/                       历史版本
```
