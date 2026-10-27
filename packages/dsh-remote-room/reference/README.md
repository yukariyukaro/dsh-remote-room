# reference — 只读参考材料

这里放的是**开发时要对照的源码与原始资料**，不是本项目的代码。三个代码仓库都是浅克隆，随仓库一起 gitignore，不进版本库。

## 代码仓库

| 目录 | 上游 | 版本 | 许可证 | 用它看什么 |
|---|---|---|---|---|
| `deepseek-harness/` | [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) | `22ddee37` (2026-10-23) | MIT | 见下表 |
| `open-remote-ssh/` | [jeanp413/open-remote-ssh](https://github.com/jeanp413/open-remote-ssh) | `6b5b86f` (2026-10-26) | MIT | 隧道 = 本地监听 + `forwardOut`、重连判据、`execChannel` 不分配 PTY |
| `shellhub/` | [shellhub-io/shellhub](https://github.com/shellhub-io/shellhub) | `0d847ff` (2026-10-26) | Apache-2.0 | 反向隧道、按流协商协议名、设备端不 `Listen` |

### deepseek-harness 里具体看哪儿

| 路径 | 为什么看 |
|---|---|
| `packages/ssh/fs-ssh/` | 远端 `ctx.fs` provider 的完整形状：路径是远端坐标、8 MiB 读上限、不实现 `watch()` |
| `packages/ssh/subprocess-ssh/` | 远端子进程与终端句柄 |
| `packages/ssh/sandbox-ssh/` | 远端沙箱委托 |
| `packages/sandbox/sandbox/src/index.ts` | `SandboxMode` 三档定义、`SandboxExecutionPolicy` 字段、`confine()` |
| `packages/sandbox/sandbox-policy/` | 逐会话模式解析、`additionalWritableRoots` |
| `packages/fs/fs-sandbox/` | 写围栏（只围写不围读）、`FS_SANDBOX_DENIED` |
| `packages/fs/fs/src/index.ts` | `ctx.fs` seam：`resolve()` / `contains(parent, child)` |
| `packages/fs/tool-fs/`、`tool-fs-search/`、`fs-observation-policy/` | 工具优先复用；核对搜索的 subprocess/本地 rg 路径依赖与独立观察策略，不把换 fs provider 当成全部工具远端化 |
| `packages/interaction/user-approval/` | 为什么房主用不了它：`request()` 要求 agent + 打开的 turn |
| `packages/subprocess/subprocess/src/types.ts` | `SubprocessTerminalHandle`：`output: Readable`、`write(text)`、`resize`、`signalForeground`、`terminate` |
| `packages/terminal/` | `ctx.terminals`（要 Agent，房主用不了） |

> 读上游源码时注意：仓库根目录有 `AGENTS.md` / `CLAUDE.md`，那些是**给改 DSH 本身的人**看的贡献规则，我们只是读者，不适用。

## 早期检索原文（`research/`）

v1 阶段做方向比较时抓的搜索结果，保留原始 JSON，便于回溯当时依据的原文。

| 文件 | 检索内容 |
|---|---|
| `ai1.json` | Vercel AI SDK `useChat` / 自定义 ChatTransport / WebSocket 重连与流式 |
| `cwm1.json` | JetBrains Code With Me：访客是否必须装 IDE、能否浏览器加入 |
| `ls1.json` | Visual Studio Live Share：访客要求、浏览器支持 |
| `rssh.json` | VS Code Remote-SSH 架构：VS Code Server 与远端 extension host |
| `vw1.json` | VS Code for the Web 的能力边界（无终端、Web 扩展受限） |
| `preset-ptc-plugin-manager.patch.yml` | 探测 DSH preset / plugin 装载机制时留下的 patch 样例 |

这些都是**当时的证据**，不代表现在的结论；结论以 `docs/dsh-remote-workspace-plan.md` 为准。
