# dsh-room monorepo

同一仓库，两个可独立安装的 DSH 分享插件。它们共享同一种架构（Node 宿主半边 + 浏览器客户端半边 + 中继），但面向两种不同的授权边界。

| 模式 | 包 | 共享什么 | 访客得到什么 | 适用 |
|---|---|---|---|---|
| **整机 UI 共享** | [`dsh-room`](packages/dsh-room/README.md) | 正在运行的完整 DSH Web：会话、文件、终端 | 房主账户的完整操作能力（不是只读沙箱） | 完全信任的人，需要直接接手整套 DSH |
| **单工作区共享** | [`@local/dsh-remote-room`](packages/dsh-remote-room/README.md) | 房主选中的一个目录，权限可选 `read-only` / `workspace-write` / `danger-full-access` | 访客自己的 agent、模型和 API key，通过 `remote_*` 工具操作授权目录，不公开房主 DSH Web | 协作处理一个项目，最小权限 |

## 安装

两个包分别安装、分别构建；从构建后的包目录通过 DSH 插件管理器安装。仓库目前不执行 workspace 级 `pnpm install`，两个包各自保留 `node_modules`，可离线构建与测试。

```powershell
# 单工作区共享
cd packages/dsh-remote-room
pnpm install --ignore-scripts
pnpm run build
pnpm run check:package

# 整机 UI 共享
cd packages/dsh-room
pnpm install --ignore-scripts
pnpm run build
```

根目录只提供便捷转发脚本，无运行时依赖：

```powershell
npm run build        # 依次构建两个包
npm run typecheck    # 依次类型检查
npm test             # 依次运行两个包的测试
```

## 结构

```text
packages/
  dsh-remote-room/   # @local/dsh-remote-room 0.3.5，含 docs/、relay/、真实 E2E 脚本
  dsh-room/          # dsh-room 0.1.0，含自己的 relay/ 与测试
pnpm-workspace.yaml  # packages/*，为后续统一安装与发布预留
```

- 单工作区共享的文档、ADR、中继部署与测试说明在 [`packages/dsh-remote-room/docs/`](packages/dsh-remote-room/docs/development-status.md)。
- 两个包的中继实现尚未合并；各自保留 `relay/`（[remote-room](packages/dsh-remote-room/relay/README.md) / [room](packages/dsh-room/README.md#公网中继)）。
- 后续的 `dsh-share` 聚合包、统一中继、包重命名与 CI path filter 尚未实现；workspace glob 与根脚本已经为它们留好位置。

## 已知验证边界

`dsh-remote-room` 的 134 项回归 + 1 项需要公网中继环境变量的自跳过测试通过；`dsh-room` 目前 40 项通过，`tests/integration/worker-room.spec.ts` 的 5 项在 Node 测试桩下失败（Worker `DurableObjectState.acceptWebSocket` 未在 stub 中提供），这是导入前就存在的测试与 Worker 实现不一致，不是本次搬家引入。真实浏览器/桌面 E2E 不在根脚本内运行，见各包 README。
