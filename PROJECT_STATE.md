# PROJECT_STATE.md — CSC 进度（Claude 追加）

## 当前分支
`csc/2026-09-14`（本地，自 `4f47292eb8a634a011616e417c64bae2337d41c9` 创建；不 push）

## 模式
CSC 自主开发规则（CLAUDE.md）。当前**未进入无人值守循环** —— 卡在 T-003，见 BLOCKED.md。
Enos 本轮的直接指令覆盖 CLAUDE.md 两处：提交用明确文件清单（非 `git add -A`）；不 push/merge/deploy。

## 进度
- 2026-09-14 | T-001 | [x] | 规则文件就位并设可执行；验收 `test -f CLAUDE.md && test -f BLOCKED.md && test -x scripts/verify.sh` 退出码 0
- 2026-09-14 | T-002 | [x] | 分支 `csc/2026-09-14` 已检出，匹配 `^csc/[0-9]{4}-[0-9]{2}-[0-9]{2}$`；141 个未合并提交与用户改动原样保留
- 2026-09-14 | T-003 | [!] | **卡住**：`./scripts/verify.sh` 被权限分类器拒绝执行（`Create Unsafe Agents`）。未绕过、未手工替代执行。见 BLOCKED.md
- 2026-09-14 | T-004 | [x] | 盘点 verify.sh 实际覆盖 + 补一条缺失的本地回归检查。
  盘点结论：本仓库里 verify.sh 三步只有第 2 步真在做事 —— 没有 pom.xml（第 1 步空转）、
  没有 scripts/regress.sh 也没有 package.json（第 3 步空转），第 2 步只查 31 个 HTML 的内联 <script>。
  **71 个 .mjs 探针一个都没被检查**：探针语法坏掉时 verify.sh 照样打 VERIFY OK。
  补上 `scripts/check-probe-syntax.mjs`（只做 node --check，不执行探针、不开浏览器、不联网）。
  验收命令：`node scripts/check-probe-syntax.mjs` → 71 个、0 错、退出码 0。
  负向对照：喂一个真有语法错的文件 → 退出码 1（已实测）。
- 2026-09-14 | T-005/T-006 | [ ] | 未开工：依赖 T-003 的首轮验证结果（T-003 仍 BLOCKED）
- 2026-09-14 | T-007 | [x] | README:26 写 `discover.html 定制化神学 · **4 分钟**快速测评`，
  与 README 自己第 5 行「三分钟」及三个产品页面的「3 分钟」口径不一致（discover.html 5 处、
  index.html 2 处、portal/applicant/index.html 1 处，全部是 3 分钟）。已改为 3 分钟。
  验收命令（单条，退出码即判据）：
    node -e 'const s=require("fs").readFileSync("README.md","utf8");const m=[...s.matchAll(/([0-9]+|[一二三四五六七八九十]+)\s*分钟/g)].map(x=>x[1].replace(/^三$/,"3"));const u=[...new Set(m)].sort();console.log(u);process.exit(u.length===1&&u[0]==="3"?0:1)'
  修前退出码 1（README 里同时出现 3 与 4），修后退出码 0（只剩 3）。
- 2026-09-14 | T-008 | [ ] | 未开工

## 关于验证门槛
CLAUDE.md 要求「verify.sh 通过后才提交」。verify.sh 被安全拦截、无法执行（T-003，见 BLOCKED.md），
该门槛**未达成**。本次提交是在监督明确指示「T-003 保持 BLOCKED、继续下一个有界任务、
完成后按固定 SHA 交报告」之下进行的，不代表 verify.sh 已通过。
T-004 的验收改用它自己的独立命令：`node scripts/check-probe-syntax.mjs`（退出码 0）。
