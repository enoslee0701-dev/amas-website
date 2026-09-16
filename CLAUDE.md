# CLAUDE.md — CSC 自主开发规则（Claude 执行者）

你是本仓库的主要执行者。目标：无人值守持续推进，直到队列清空或遇到 RED 任务。

## 文件所有权（严格遵守）
| 文件 | 谁写 | 谁读 |
|---|---|---|
| CSC_AUTONOMOUS_QUEUE.md | Luna（派任务） | Claude |
| PROJECT_STATE.md | Claude（报进度） | Luna / Enos |
| BLOCKED.md | Claude（报卡点） | Luna / Enos |
| CLAUDE.md | Enos | Claude |
不改不属于你的文件。队列文件只允许把任务状态 `[ ]` 改为 `[x]` 或 `[!]`。

## 工作循环
1. 读 PROJECT_STATE.md（上次做到哪）→ 读 CSC_AUTONOMOUS_QUEUE.md（取第一个 `[ ]` 且非 RED 的任务）
2. 开发 → 运行 `scripts/verify.sh` → 失败则修，最多 3 轮
3. 通过后：`git add -A && git commit -m "csc: <任务ID> <一句话>"`，在队列标 `[x]`，在 PROJECT_STATE.md 追加一行
4. 回到第 1 步。队列空 → 在 PROJECT_STATE.md 写 `QUEUE_EMPTY` 并停止

## 分级
- GREEN：本地代码、测试、修复、文档、重构 → 直接做
- YELLOW：新依赖、Schema 变更、删除文件、改 CI → 做，但在 PROJECT_STATE.md 标 `[YELLOW]` 供 Luna 复核
- RED：生产迁移、权限/RLS/认证、密钥、支付、推 main、外部付费调用 → 不做，写 BLOCKED.md，跳下一条

## 停止条件（写 BLOCKED.md 后停，其余情况不停）
- 任务描述不足以开工，且查阅代码后仍无法确定
- verify.sh 连续 3 轮失败
- 需要 Enos 提供凭据、账号或业务决定
- 队列剩余未完成任务少于 2 条 → 写 BLOCKED.md 请 Luna 补货，但继续做剩余任务

## 验证门槛（缺一不算完成）
- `mvn -q -DskipTests=false test` 全绿（Java）；如有前端单文件 HTML，`node --check` + 回归脚本
- 新功能必须附测试；修 bug 必须先写复现测试
- 不得为了通过而删测试、跳过测试或改断言

## 分支与提交
- 工作分支：`csc/<日期>`，永不直接改 main
- 每个任务一个 commit；不 push（由 Luna/Enos 决定）

## 降级
Astra/Sol 不可用不是停工理由（ASTRA_UNAVAILABLE_MODE）。只有 RED 才挂起。

## 回复风格 / 不停机
- 完成一个任务后不写总结汇报，直接取下一条。
- 只在 QUEUE_EMPTY，或写入 BLOCKED.md 且需要 Enos 决定时，才结束回复。
- 如果被 Stop 钩子推回，立即取下一条，不解释。
- 中文，简短。

@EXECUTOR.md
