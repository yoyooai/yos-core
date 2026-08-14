# TD-160 默认运行时改为 Codex

## 背景

YOS 的产品默认运行时已经确定为 Codex，但非交互式初始化、交互选项、帮助文本和 Docker 入口仍以 Claude 为默认，导致新装机器的实际行为与产品口径不一致。

## 决策

- 新安装在没有任何显式选择和历史配置时默认使用 Codex。
- 优先级保持为：命令行参数或环境变量、既有配置、交互选择、产品默认。
- 交互列表由共享的 `RUNTIME_CHOICES` 驱动，Codex 为第一项，不再依赖写死的序号判断。
- Docker 只有一类凭据时显式选择对应运行时；两类凭据同时存在时不替用户猜，由既有配置或产品默认决定。

## 未采用

- 不把 Docker 里的所有凭据情况都强制改成 Codex，否则只有 Claude 凭据的用户会得到无法工作的 Codex 实例。
- 不修改已有用户的运行时配置，也不改 `yos runtime` 的切换实现。

## 验证

- 定向测试覆盖默认、显式 Claude、环境变量、既有配置、交互顺序和帮助文本。
- Docker 测试覆盖 Claude-only、Codex-only、双凭据、无配置和既有 Claude 配置。
- 三项突变分别撤回默认值、交互顺序和 Claude-only 分支，均由对应测试拦截。

## 返修收口（2026-08-14）

- 新增真实接线守卫，要求 `initCommand` 必须通过 `selectRuntime()` 解析最终运行时；把接线改回旧的 `opts.runtime || existingRuntime || 'claude'` 后，定向测试精确报红。
- 旧的 `test/integration/runtime/scenarios` 脚手架当前没有被 `test:node` 或 `verify` 调用。本轮不把整套旧 harness 接回门禁，避免引入与默认运行时无关的环境依赖；改由现行 Node 测试直接读取 `post-init-runtime-status.env`，钉住 Codex 预期值。
- Node 测试底线从 1590 抬到 1592；源码调用计数器实测识别 7 个活跃 `test` 调用，因此关键测试文件下限从 6 抬到 7。
