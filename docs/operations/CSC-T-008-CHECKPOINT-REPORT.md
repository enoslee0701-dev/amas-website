# CSC 阶段 checkpoint 报告（T-001 ~ T-008）

分支 `csc/2026-09-14`（自 `4f47292` 起，本地，未 push）。读者：Luna / Enos。

## 任务结果

| 任务 | 状态 | 结果 | 提交 |
|---|---|---|---|
| T-001 | [x] | 规则文件就位，`scripts/verify.sh` 可执行 | 82d6f80 |
| T-002 | [x] | 工作分支 `csc/2026-09-14` 已确认 | 82d6f80 |
| T-003 | [!] | 首轮 `./scripts/verify.sh` 退出码 **1**（index.html JSON-LD 误报）。上一轮被权限拦截，本轮已能执行 | —（仅记录） |
| T-004 | [x] | 新增 `scripts/check-probe-syntax.mjs`：.mjs 探针此前完全没被检查 | 82d6f80 |
| T-005 | [x] **YELLOW** | 修 verify.sh 第 2 步：JSON-LD 被当 JS 解析必然误报；`data-src=` 导致内联脚本漏检 | 7630096 |
| T-006 | [x] **YELLOW** | 回归测试接进 verify.sh 第 3 步，并用替身用例钉住接线 | 36b5afe |
| T-007 | [x] | README 快速测评时长 4 分钟 → 3 分钟，与页面一致 | 47c1559 |
| T-008 | [x] | 本报告 | 本提交 |

## 当前验证状态（本报告提交前实测）

| 命令 | 退出码 |
|---|---|
| `./scripts/verify.sh` | 0（31 个 HTML / 30 段内联 script 0 错；回归用例 10/10） |
| `node scripts/test-inline-script-check.mjs` | 0（连跑 3 次） |
| `node scripts/check-probe-syntax.mjs` | 0（74 个 .mjs，0 错） |

T-003 的验收（verify.sh 退出码 0）现在已经满足。但队列规则只允许把 `[ ]` 改成别的状态，所以 T-003 仍标 `[!]`，要不要改判由 Luna 决定。

## 需要复核 / 决定

1. **YELLOW**：T-005、T-006 都改了验证门槛 `scripts/verify.sh`。第 2 步现在遇到未知的 script type 会直接失败，不再跳过；以后页面如果加 `type="module"` 内联脚本，要先在 `scripts/check-inline-scripts.mjs` 里补上对应处理。
2. **BLOCKED.md** 的 T-003、T-000 两条已追加进展说明，条目状态没动，留给 Luna 处置。
3. 以下工作区改动不归 Claude 所有，**没有提交**：`CLAUDE.md`（新增「不停机」一节）、`.claude/settings.json`（Stop 钩子）、`scripts/csc-continue.sh`。
4. 每次提交时 pre-commit 钩子会自动给全站 HTML 的缓存戳改版本号，所以每个提交都带有一批 HTML 的 `?v=` 变更。这是仓库原有的机制，不是任务本身的改动。

## 下一步

队列里还有 T-009 ~ T-016（其中 T-013、T-015 是 YELLOW），按顺序继续。
