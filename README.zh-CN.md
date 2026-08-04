# YOS

YOS 是面向长期数字分身和数字员工的 AI Agent 运行引擎。

它让同一个 Agent 能够跨会话、跨渠道持续运行，并提供长期记忆、消息调度、定时任务、健康监控和异常恢复能力。当前工程母版同时保留 Claude Code 与 Codex，后续逐步演进为 Codex 优先架构。

## 当前状态

本仓库是 YOS 正式工程母版，当前可用于开发和内部验证，尚未定为客户正式发布版本。

## 核心能力

- 身份、状态和参考资料的持久记忆
- 带 SQLite 历史记录的统一消息桥
- 定时任务和延迟任务
- 运行状态监控与异常恢复
- Web Console
- Claude Code 与 Codex 运行时适配器
- 安装、组件和升级工具

## 开发环境安装

需要 Node.js 20.20 或更高版本、npm、git 和 tmux。

```bash
npm ci
npm install -g .
yos init
```

## 常用命令

```bash
yos init
yos shell
yos attach
yos status
yos doctor
yos runtime status
yos runtime codex
yos add <component>
yos list
```

## 验证

```bash
npm run verify
npm run release:pack
```

统一门禁会运行全部 Jest 测试、Node 测试、依赖安全审计和可复现打包检查。标准 Linux 环境中未通过该命令的版本，不得作为发布版本。正式制品必须使用 `npm run release:pack`：它先完整执行门禁，通过后才会生成 `publication/` 中的包。普通 `npm pack` 仅供客户端升级事务构建候选包，不代表已通过发布门禁。

自升级如果自动回滚不完整，会保留事务备份并输出完整恢复命令：`yos upgrade --self --recover <backup>`。不要在恢复前手工删除该备份目录。

## 当前兼容边界

本版只支持全新安装。改名是彻底的，不是叠加的：唯一入口是 `yos`，默认运行目录是 `~/yos`，配置只读 `YOS_*` 变量。改名前的入口、主目录和 `ZYLOS_*` 变量一律不再识别，原地迁移体系已退役 —— 因此已安装的上游版本或早期 YOS 无法原地升级，需要全新安装并显式搬运数据。

每一处有意偏离上游的改动都记录在[已授权偏离清单](docs/authorized-deviations.md)。

本阶段也明确保留 Claude Code。只有当 Codex 已经独立具备启动、监控、记忆轮转和异常恢复能力后，才重新评估是否移除 Claude。

## 文档

- [Docker 部署](docs/docker.md)
- [GitHub 认证](docs/github-authentication.md)
- [自定义会话启动](docs/custom-session-start.md)
- [Hook 活动跟踪](docs/hook-activity-tracking.md)

## 许可证

YOS 按照 [LICENSE](LICENSE) 中的条款发布。
