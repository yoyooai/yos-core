# YOS 基于某上游产品 v0.6.0 的改造审计交接说明

## 1. 文档目的

本文用于把当前 YOS 代码交给独立审查人复核。它不证明当前版本可以发布，也不要求审查人接受已有结论。

审查目标是回答四个问题：

1. 哪些文件与经授权的上游产品 v0.6.0 基线完全一致。
2. 哪些变化只是品牌、路径或变量改名。
3. 哪些变化改变了安装、升级、运行时、消息和数据行为。
4. 当前代码应继续维护，还是应从上游基线提交重新建立可追踪分支后选择性迁移。

## 2. 锁定对象

### 上游对照

- 来源：经授权的某上游产品代码基线，本文不记录具体产品名称和仓库地址
- 版本：`v0.6.0`
- 提交：`d008294751efb79e170651707fc15064a85741c8`
- 提交标题：`chore(release): v0.6.0 (#734)`

### 当前 YOS

- 审查对象：YOS 候选母版
- 分支：`main`
- 交接前代码提交：`fc4efce2b375b9e197f2b00f894be18b6f7370c5`
- 包名：`yos`
- 版本：`0.3.0-alpha.1`

## 3. 重要的 Git 事实

当前仓库不是在上游基线提交上直接创建分支后逐步改造的。

- 当前仓库最早提交是根提交 `4309804`，没有父提交。
- 品牌清理、内部命名空间迁移和旧迁移体系删除等早期改造，已经被压入该根提交。
- 上游基线提交 `d008294` 不在当前 Git 祖先历史中。
- `4309804` 之后只有四个消息恢复相关提交。
- 因此，早期改造可以通过代码树对比审计，但不能通过当前 Git 历史逐提交还原。

这也是本次独立审查最重要的背景。

## 4. 已执行的改造

### 4.1 上游基线门禁修复

- 修复不稳定测试和直接运行 Jest 时缺少 Skill 依赖的问题。
- 增加统一的 `npm run verify` 验收入口。
- 更新存在已知漏洞的依赖。
- 对齐 `package.json`、CLI 与 `VERSION`。
- 增加依赖审计、双构建一致性和仓库污染检查。

这部分主要影响依赖锁定、测试、构建和发布前验证，不以改变 AI Runtime 功能为目标。

### 4.2 用户可见品牌清理

- README、CLI、Web Console、提示词和图片改为 YOS。
- 新增 `yos` 命令入口。
- 删除旧上游营销内容和施工文档。
- 重建 YOS changelog。

### 4.3 内部命名空间迁移

- 包名、命令和入口改为 `yos`、`cli/yos.js`。
- 默认目录改为 `~/yos`，产品元数据目录改为 `.yos`。
- 环境变量和服务标识改为 `YOS_*`、`yos-*`。
- 更新源改为显式配置：`YOS_RELEASE_REPO` 和 `YOS_REGISTRY_REPO`。
- 未配置正式 YOS 发布源时，远程更新默认停用。
- Docker 默认从当前源码构建，不引用未确认的远程镜像。

这部分不只是品牌修改，会影响安装、目录、配置、服务和升级行为。

### 4.4 旧迁移体系退役

项目当时确认后续只做全新安装，因此删除：

- `cli/commands/migrate-instructions.js`
- `cli/lib/instruction-migration.js`
- `cli/lib/migrate.js`
- `data/instruction-baselines/manifest.json`
- `scripts/export-instruction-baselines.js`
- 对应测试、夹具和旧布局自动迁移提示

当前版本不支持旧上游产品布局或早期 YOS 布局的原地迁移。缺少当前 `.yos/instructions/meta.json` 时应明确失败。

### 4.5 异常消息持久化与恢复

`4309804` 之后新增了四个可追踪提交：

1. `09febae`：异常入站消息持久化和来源消息 ID 去重。
2. `8a45433`：派发重试耗尽后的管理员元数据告警。
3. `da3cabb`：把通信桥测试纳入发布验证。
4. `fc4efce`：补充消息恢复设计和使用契约。

主要行为变化：

- 运行时不可用时，入站消息保持 `pending`，不再要求用户重发。
- 恢复后由 dispatcher 自动继续处理。
- `(channel, source_message_id)` 唯一，防止同一渠道事件重复执行。
- 重试耗尽后标记 `failed`，可向管理员发送不含用户正文的告警。

该阶段相对 `4309804` 修改 15 个文件、新增 4 个文件，没有删除文件。

## 5. 文件级差异统计

以下统计使用上游基线 `d008294` Git tree 与当前 `fc4efce` Git tree 的 blob SHA 对比，不等同于功能覆盖率：

| 项目 | 数量 |
|---|---:|
| 上游基线文件 | 384 |
| 当前文件 | 373 |
| 同路径且内容完全一致 | 97 |
| 同路径但内容变化 | 235 |
| 当前新增 | 41 |
| 当前删除 | 52 |

对 103 个发生变化的文本型生产/配置文件进一步做品牌归一化比较：

| 类型 | 数量 |
|---|---:|
| 只包含旧上游品牌到 YOS 的品牌文本变化 | 63 |
| 除品牌外还存在其他变化 | 40 |

另有一个二进制图片变化未计入上述 103 个文本文件。

注意：新增和删除中包含目录改名造成的成对变化，例如旧上游记忆技能目录改为 `skills/yos-memory/`，不能直接把所有新增/删除都理解为功能增减。

## 6. 需要重点审查的行为变化

### P0：安装、升级与发布来源

重点文件：

- `cli/commands/init.js`
- `cli/commands/component.js`
- `cli/commands/doctor.js`
- `cli/lib/self-upgrade.js`
- `cli/lib/release-source.js`
- `cli/lib/registry.js`
- `skills/activity-monitor/scripts/upgrade-check.js`
- `scripts/install.sh`

审查问题：

- 未配置 YOS 发布源时是否确实不会访问旧上游。
- 配置发布源后是否能正确检查、下载、升级和回滚。
- 是否存在文档声称支持但代码未闭环的升级路径。

### P0：新旧目录与数据边界

重点文件：

- `cli/lib/config.js`
- `cli/lib/runtime-setup.js`
- `cli/lib/runtime/instruction-builder.js`
- `cli/lib/sync-settings-hooks.js`
- `cli/commands/runtime.js`

审查问题：

- `.yos`、`~/yos` 和 `YOS_*` 是否在所有路径一致。
- 删除旧迁移后，错误路径是否明确失败而不是静默丢数据。
- 全新安装是否仍能完整初始化 Claude 和 Codex 所需文件。

### P1：Runtime 行为

重点文件：

- `cli/lib/runtime/claude.js`
- `cli/lib/runtime/codex.js`
- `cli/lib/runtime/index.js`
- `cli/lib/heartbeat/claude-probe.js`
- `cli/lib/heartbeat/codex-probe.js`

当前仍保留 Claude 与 Codex 双 Runtime，默认 Runtime 仍是 Claude。本轮没有完成“Codex 默认”或“只保留 Codex”。

### P1：消息恢复

重点文件：

- `skills/comm-bridge/init-db.sql`
- `skills/comm-bridge/scripts/c4-db.js`
- `skills/comm-bridge/scripts/c4-receive.js`
- `skills/comm-bridge/scripts/c4-dispatcher.js`
- `skills/comm-bridge/scripts/c4-send.js`
- `skills/activity-monitor/scripts/message-router.js`

审查问题：

- 数据库迁移是否对旧库幂等。
- 重复消息是否只去重入站，不虚假承诺执行级 exactly-once。
- 恢复、失败、告警和隐私边界是否一致。

## 7. 已验证与未验证

### 已验证

- 当前 `fc4efce` 的项目门禁曾通过：Jest `165/165`、Node `1027/1027`。
- 6 个依赖根目录安全审计曾为 0。
- 两次发布构建 SHA-256 曾一致。
- YOS-Dev 隔离 PM2 沙箱完成消息异常、恢复、去重和告警测试。
- 真实飞书长连接完成“故障期间保存、恢复后自动回复、来源 ID 去重”测试。

审查人仍应在自己的干净环境重新执行，不应把以上记录当作独立验收结果。

### 未验证或未完成

- 没有完成真实微信故障恢复测试。
- 没有把当前版本作为客户候选版执行完整安装、升级和回滚验收。
- 没有完成 Codex 默认运行时改造。
- 没有配置正式 YOS 发布仓库和组件注册表。
- 没有提交 Channels 飞书依赖的正式安全修复。
- 没有把上游基线 `d008294` 保留为当前仓库的祖先提交。

## 8. Channels 仓库边界

本仓库只包含 OS，不包含 Channels 正式仓库。

真实飞书测试期间，临时 Channels 副本的飞书依赖锁文件检出 8 个已知漏洞。临时执行 `npm audit fix` 后，飞书测试 `8/8`、审计为 0。该临时修改没有推送到正式 Channels 仓库，临时副本已删除。

因此，不能根据 OS 审查结果推断 Channels 已达到发布标准。

## 9. 已知不一致

- 当前 Git 历史没有上游基线祖先，早期改造不可逐提交审计。
- 开发记录曾提到 `v0.3.0-alpha.1` 标签，但交接前本地仓库没有该 Git 标签。
- 版本名为 `0.3.0-alpha.1`，但它不是客户发布版。

## 10. 建议的独立审查顺序

1. 从内部留存的上游基线检出 `d008294`，不要使用当前仓库的根提交代替上游原版。
2. 对比 `d008294` 与 `fc4efce`，输出完整的新增、删除、修改清单。
3. 将差异分为：完全未改、仅品牌、路径/配置、行为逻辑、新增功能、删除功能。
4. 优先审查第 6 节列出的高风险文件。
5. 在 Linux x64 干净环境执行安装、`npm run verify`、真实 Codex、升级和回滚测试。
6. 在审查报告完成前，不直接在 `main` 上边审边修，避免审查对象持续变化。

## 11. 建议输出格式

每个差异至少记录：

| 文件 | 变化类型 | 变化说明 | 是否影响行为 | 风险 | 建议 |
|---|---|---|---|---|---|
| 路径 | 品牌/配置/逻辑/新增/删除 | 一句话事实 | 是/否 | P0/P1/P2 | 保留/重写/回退/待确认 |

最终报告需要明确给出：

- 当前代码是否适合继续作为母版。
- 如果重建，哪些提交或能力可以选择性迁移。
- 如果不重建，必须先补齐哪些阻塞项。
