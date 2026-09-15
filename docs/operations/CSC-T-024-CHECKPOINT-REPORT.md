# CSC 阶段 checkpoint 检查报告（T-009 ~ T-024）

读者：Luna / Enos。上一阶段（T-001 ~ T-008）的报告见 `CSC-T-008-CHECKPOINT-REPORT.md`。

## 固定 SHA

- **被检查的提交**：`749780292b605c3ce50922361da10445cb395332`（`7497802`，T-023）
- 分支 `csc/2026-09-14`，自 `4f47292` 起共 19 个 `csc:` 提交；**未 push**
- 检查时，被跟踪文件里只有 `CLAUDE.md` 有未提交改动（Enos 的，不归 Claude，未提交）；跑完之后状态一致
- 本报告所在的提交（T-024）是在上面这个 SHA 之后新建的，只增加本报告、`PROJECT_STATE.md`、队列标记，以及 pre-commit 例行重打的缓存戳。提交后用 `check-stamp-only-diff.mjs HEAD^ HEAD --per-commit` 复核过，结果记在 `PROJECT_STATE.md`

## 检查结果（全部在 `7497802` 上运行）

### 门槛与静态检查（不开浏览器）

| 命令 | 退出码 | 摘要 |
|---|---|---|
| `./scripts/verify.sh` | **0** | VERIFY OK（第 2 步 31 个 HTML；第 3 步回归用例 10/10） |
| `node scripts/check-site-static.mjs` | 0 | 6 步，0 错误，0 空转 |
| `node scripts/check-probe-syntax.mjs` | 0 | 86 个 .mjs，0 语法错误 |
| `node scripts/check-account-status-vocab.mjs` | 0 | 三个集合完全一致 |
| `python3 scripts/check-cache-bust.py` | 0 | 5/5 |
| `node scripts/test-inline-script-check.mjs` | 0 | 10/10 |
| `node scripts/test-api-error-mapping.mjs` | 0 | 20/20 |
| `node scripts/test-applicant-profile-read-boundary.mjs` | 0 | 7/7 |
| `node scripts/test-applicant-history-read-boundary.mjs` | 0 | 11/11 |
| `node scripts/test-account-status-vocab.mjs` | 0 | 13/13 |
| `node scripts/test-stamp-only-diff.mjs` | 0 | 11/11 |
| `node scripts/test-check-site-static.mjs` | 0 | 11/11 |
| `node scripts/test-regress-profile-pages.mjs` | 0 | 5/5 |
| `python3 scripts/test-bump-untracked-guard.py` | 0 | 23/23 |
| `python3 scripts/test-hook-gate.py` | 0 | 16/16 |
| `python3 scripts/test-cache-bust-contract.py` | 0 | 15/15 |
| `node scripts/check-stamp-only-diff.mjs 4f47292 HEAD --per-commit --expect <3 个页面 + api.js>` | 0 | 19 个提交里，带戳的 HTML 除 T-009 / T-011 / T-012 各自那一页外只改了缓存戳 |

### 浏览器探针（本地 stub、自带 Chrome，外网请求被拦截）

| 命令 | 退出码 | 摘要 |
|---|---|---|
| `node scripts/regress-profile-pages.mjs`（8 趟） | 0 | profile-writes PASS 69 · portal-pages 112/112 · todo-loop 四组 24 / 13 / 11 / 20，均 FAIL 0 |
| `node scripts/test-read-failures.mjs` | 0 | PASS 23 FAIL 0 |
| `node scripts/test-noconfig-degraded.mjs` | 0 | PASS 91 FAIL 0 |
| `node scripts/test-admin-overview-writes.mjs` | 0 | PASS 28 FAIL 0 |
| `node scripts/test-session-unknown.mjs` | 0 | PASS 23 FAIL 0 |

## 本阶段任务

| 任务 | 状态 | 结果 | 提交 |
|---|---|---|---|
| T-009 | [x] | 申请人资料页：收到 `{}` 或全 null 行时不再画空表单 | 5051606 |
| T-010 | [x] | 账号状态词表：重放全部迁移，与页面两处定义比对 | 5e1b4f3 |
| T-011 | [x] | 学员资料页：保存在途时，不经过按钮的提交不再发出第二笔 | f5013a2 |
| T-012 | [x] | 历史页时间线：读不到之后再点一次，会真正重新读取 | 861ec4b |
| T-013 | [x] **YELLOW** | 学员侧读失败盘点报告 + 1 条候选任务 | bbab396 |
| T-014 | **[!]** | 卡住：代码里不存在 `window.onerror` 采集，见 BLOCKED.md | — |
| T-015 | [x] **YELLOW** | 缓存戳变更范围审核工具与结论 | 865dd68 |
| T-016 | [x] | 资料页最小回归运行器 + 报告 | 21a8bc7 |
| T-017 | [x] | API 错误映射：原型名错误码不再渲染出函数源码；403/429 没有 body 时给出明确提示 | b66ba5e |
| T-018 | [x] | 历史页空数据 / 读失败覆盖核对；补浏览器断言 Hn3d | 51088b7 |
| T-019 | [x] | 资料页「不等待连发两次」三种来路，均只发一笔 | f4d27b7 |
| T-020 | [x] **YELLOW** | bump.py 不再改写被忽略的页面和嵌套 worktree 里的 HTML | 75c0dae |
| T-021 | [x] | 全站静态检查汇总；沙箱断网下退出码 0 | bd6888a |
| T-022 | [x] | 无配置启动：21 页 × 两种「没配置」的降级测试 | b4e5edd |
| T-023 | [x] **YELLOW** | 浏览器兼容性范围盘点报告 | 7497802 |
| T-024 | [x] | 本报告 | 本提交 |

## 需要注意 / 需要决定

1. **主检出的 bump.py 仍是旧逻辑**：T-020 的修复只在本分支上。在它合入 master 之前，`amas-web` 主检出每提交一次，就会把挂在它目录下的 `worktrees/*` 里所有 HTML 的缓存戳改写一遍。这些 worktree 随即出现未暂存改动，它们的下一次提交会被 GUARD 拦下。**是否合并由 Luna / Enos 决定。**
2. **T-003、T-014 标为 `[!]`**：T-003 的验收（verify.sh 退出码 0）现在已经满足，是否改判由 Luna 决定。T-014 需要先决定要不要做生产侧异常采集、采集后发往哪里（选项写在 BLOCKED.md）。
3. **待决定的候选**：T-023 的 C1（目标浏览器矩阵）、C4（需要打开 Safari 远程自动化）；是否把 `check-site-static.mjs` 接进 verify.sh（这属于改门槛）；T-013 报告里的学员课程目录候选任务。
4. **测试环境事实**：`test-student-todo-loop.mjs` 在 Mac 上必须设置 `CHROME_PATH`（它默认的是 Windows 路径），而且 Sf / Se / Sp 三组必须分开跑。`node --check` 对 .ts 文件不可靠，会放过 TS 语法错误。
5. **本机状况**：有 28 个 1~2 天前启动的 headless Chrome 进程仍在运行，不是本阶段产生的，没有处理。
6. **记录更正**：T-017 ~ T-024 这 8 条是 Luna 追加的，它们随 T-011 的提交（f5013a2）一起进了仓库；我中途误发过一条「队列不足」的补货请求，已经在 BLOCKED.md 里撤回。
7. **未提交的 Enos 文件**：`CLAUDE.md` 的改动、`.claude/settings.json`（Stop 钩子）、`scripts/csc-continue.sh`，保持原样。
