# YOS Core Roadmap

## 2026-08-10 Unified Capability Catalog

Development implementation is complete on an isolated branch and is awaiting
independent acceptance. Core now derives a read-only local catalog, exposes
`yos capability`, reports declared health only through the existing doctor, and
generates the shelf `capabilities.json` beside `index.json`. No capability data
participates in permission or execution decisions; no release or production
shelf was changed.

## 当前阶段

- [x] 以上游 `v0.6.0` 为血统基线，完成 YOS 品牌切换。
- [x] 建立发布验证门禁与包内容策略。
- [x] 修复自升级发布门禁冲突、前置预检和后段回滚缺口。
- [x] 收口回滚假全清：交接状态版本化，并以核心版本、Core Skills 内容和服务状态共同判定回滚完成。
- [x] 给发布门禁加自保护：禁止跳过/聚焦测试，关键回滚测试与守卫文件不可静默消失。
- [x] 收口门禁外层吞错：测试计数只有经最终消费标记确认后才能放行，warning-only 包装不能伪造 PASS。
- [x] 把 executed-test gate 改成只交回数据：最终结论统一在 `runVerification` 外层完成，异常、空值和假计数都在审计与打包前失败。
- [x] 兼容旧核心的失败回复：自动回滚不完整时，恢复详情进入旧版也能显示的 error 字段。
- [x] 兼容 0.1.13 旧货架回退核验：仅对三项现代元数据均缺失且 `index.json` 摘要命中留档值的真实历史格式显式放行。
- [x] 为显式声明 repair 钩子的组件补同版本完整性修复，并统一本地/货架公共能力标题来源。
- [x] TD-158 交付故障可见性：陈旧健康快照触发用户状态提示，持续掉线且有积压时独立告警管理员，安装显式记录告警目标，健康检查不再猜收件人。
- [x] TD-160 默认运行时切换为 Codex：新安装默认选择 Codex，显式参数、环境变量和既有配置继续优先，Docker 对单一凭据族做对称选择。
- [x] 周期性站外备份已在生产运行：控制机编排、短期 STS、失败告警、保留候选和异机恢复已闭环。
- [x] TD-154/155 系统级调度返修：拒绝会静默失效的用户级 unit、按真实 `ActiveState=activating` 拒绝并发安装、拒绝前不停旧 timer、SIGINT/SIGTERM 统一回滚。小A 独立真机复验通过（2026-08-13 小啄机），**2026-08-14 合入 main（苏白「合吧」）**。⚠️ 生产货架机的定时器**未重装** —— 上面跑的仍是分支装的那一套，行为等价。
- [x] TD-145/TD-4②：官方组件显示实际分发货架与源码仓库；普通命令拒绝把无关目录误认成 YOS 安装，`yos init` 继续承接首次安装和恢复。
- [x] WO-088 卡住型自愈收口：强制重建统一留下本地日志与持久快照计数，四小时内三次会锁存人工关注标记；冻结会话按精确进程树恢复并清理，离线快照保留真实活动时间与来源。
- [ ] TD-157 安装被中断的等待期一句话不吭 ⇒ 操作员会升级为强杀，而强杀留下 timer enabled+inactive。改法＝收到首个信号即打印一行提示；本轮未做，挂账。
- [ ] TD-146 运行时恢复重复回复：代码时序诊断已完成，现有合同无法安全推导 exactly-once；待小A核对 taka 现场时间线后再决定是否改协议。
- [ ] 独立验收自升级成功、步骤 5/6/9/11/12 失败回滚、步骤 13 告警和手动恢复。
- [ ] 用小A的隔离 Docker 台架重跑 A1/A2/A3/A6，确认旧交接单不再假报回滚完成。
- [ ] 在隔离容器中完成真实升级与回滚证据；通过前不发布客户版本。
- [ ] 小A在验收机复跑 `SIGSTOP` 造障，核对恢复时长、旧进程归零、快照计数递增与客户侧零打扰。

## 不在本轮

- 不改品牌、目录结构和版本号策略。
- 不改组件升级流水线。
- 不动任何现役服务器、发布源、标签或 `main`。
