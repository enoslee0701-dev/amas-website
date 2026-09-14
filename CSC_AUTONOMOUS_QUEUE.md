# CSC_AUTONOMOUS_QUEUE.md

- [x] T-001 | GREEN | 在仓库根目录安装 CSC 自主开发规则文件并设置 `scripts/verify.sh` 可执行 | 验收：`test -f CLAUDE.md && test -f BLOCKED.md && test -x scripts/verify.sh`
- [x] T-002 | GREEN | 创建或确认工作分支命名为 `csc/<YYYY-MM-DD>`，保留现有用户改动 | 验收：`git branch --show-current` 匹配 `^csc/[0-9]{4}-[0-9]{2}-[0-9]{2}$`
- [!] T-003 | GREEN | 运行仓库现有验证脚本并记录首轮结果 | 验收：`./scripts/verify.sh` 退出码为 0
- [x] T-004 | GREEN | 盘点首轮验证覆盖范围，补齐一个缺失的本地回归检查 | 验收：新增检查可独立运行且退出码为 0，并在提交中列出命令
- [ ] T-005 | GREEN | 修复首个可本地复现的非 RED 验证失败 | 验收：对应复现命令先失败后通过，且未删除或跳过测试
- [ ] T-006 | GREEN | 为已修复问题补充最小回归测试 | 验收：回归测试稳定通过并能在 `./scripts/verify.sh` 中执行
- [x] T-007 | GREEN | 审核仓库文档与运行说明，修正一处与当前行为不一致的说明 | 验收：文档改动可由一条本地检查命令验证
- [ ] T-008 | GREEN | 完成当前阶段 checkpoint 提交并生成简短完成报告 | 验收：存在对应 `csc: T-008` commit，`git show --stat --oneline HEAD` 成功
