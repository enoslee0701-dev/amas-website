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

## 2026-09-14 第二轮（Enos 在真实对话轮直接指示：按根目录 CLAUDE.md 工作循环从队列取第一条未完成任务执行）
- 2026-09-14 | T-003 | [!]→记录 | 本轮 `./scripts/verify.sh` **可以执行**（未再被拦截）。首轮结果：退出码 **1**，
  唯一失败 `语法错误: index.html` —— index.html:27、:51 两段 `<script type="application/ld+json">` 被当 JS 塞进
  new Function，合法 JSON 必然误报。队列里 T-003 保持 `[!]`（规则只允许 `[ ]` 改状态），由 Luna 决定是否改判。
- 2026-09-14 | T-005 | [x] | [YELLOW：改了验证门槛 scripts/verify.sh] 修 verify.sh 第 2 步误报。
  第 2 步抽成 `scripts/check-inline-scripts.mjs`：按 script type 分流（JS→new Function；ld+json/json/importmap→JSON.parse；
  其他 type→直接报错，不静默跳过）。顺带修同一段里的漏检：原 `/src=/` 会命中 `data-src=`，带 data-src 的内联脚本整段不查。
  复现测试（先写后修）：`node scripts/test-inline-script-check.mjs`（临时 git 仓库里跑 verify.sh 真实副本，8 个正/负用例）
    修前：不符合预期 3 个（JSON-LD 误报 ×2、data-src 漏检 ×1），退出码 1
    修后：不符合预期 0 个，退出码 0
  `./scripts/verify.sh`：修前退出码 1 → 修后退出码 0（31 个 HTML、30 段内联 script、0 错）。未删、未跳过任何检查。
- 2026-09-14 | T-006 | [x] | [YELLOW：改了验证门槛 scripts/verify.sh] T-005 的回归测试接入 verify.sh 第 3 步
  （`CSC_VERIFY_NESTED` 非空时跳过，防止测试在临时仓库里调 verify.sh 时递归）。
  新增 2 个用例钉住接线：非嵌套时放一个必失败的替身 → verify.sh 必须失败；嵌套时必须跳过替身。
    接线前：10 个用例里 1 个不符（verify.sh 没跑回归），退出码 1
    接线后：10/10，连跑 3 次退出码均 0；`./scripts/verify.sh` 退出码 0，输出里有这 10 个用例
- 2026-09-14 | T-008 | [x] | 阶段 checkpoint：报告 `docs/operations/CSC-T-008-CHECKPOINT-REPORT.md`（T-001~T-008 结果、实测验证、待复核项）。
  提交前 `./scripts/verify.sh` 退出码 0。
- 2026-09-15 | T-009 | [x] | 申请人资料页读取边界。原守卫 `if (error)` / `if (!prof)` 挡不住 `{}` 和全 null 行
  （profiles 行没建时 my_profile 返回 NULL 复合值，经 PostgREST 可能成全 null 对象；未连库实测，按契约防御），
  会画出空表单、账号信息全「—」。改为「对象、非数组、至少一个非 null 字段」才算读到；否则报「没有读到你的档案」+ 重试。
  判据刻意不要求 id：20+ 支探针的 my_profile 桩只给 display_name/email。
  检查：`node scripts/test-applicant-profile-read-boundary.mjs`（node:vm 桩运行页面脚本，7 情形：读失败×2、null、undefined、{}、全 null、正常行；
  读不到类同时验重试入口会 reload、且不渲染保存按钮）修前 2 个不符 → 退出码 1；修后 0 个 → 退出码 0。
  回归：`node scripts/test-profile-writes.mjs` PASS 42 FAIL 0；`./scripts/verify.sh` 退出码 0。
- 2026-09-15 | T-010 | [x] | 账号状态词表契约一致性检查（不开浏览器）：`node scripts/check-account-status-vocab.mjs` 退出码 0。
  按文件名重放 supabase/migrations 里对 account_status 的 create / add value / rename value / drop，
  得出最终枚举，与页面 `ACC` 的键、`ACC_KEYS` 三者比集合（另查重复；任一集合取不到 → 退出码 2）。
  补足旧 Ap5/Ap6（在 test-profile-writes.mjs 里，需要 Chrome）的漏洞：只读 0002、不比 ACC 键、写死 5 个。
  用例：`node scripts/test-account-status-vocab.mjs` 13/13（11 个临时目录用例，含后续迁移加值没跟上 → 失败、
  注释里的 add value 不算；1 个用真实页面删掉 locked 的负向对照；1 个真实仓库正向）。现状一致，页面未改。
- 2026-09-15 | T-011 | [x] | 保存按钮在途禁用与重复提交审核（三个资料页，均写 update_my_contact）。
  `scripts/test-profile-writes.mjs` 新增 D 段：每页 × 三种来路（真实再点保存键 / 电话框回车 / 脚本 requestSubmit），
  第一下同来路发出并以「在途保存键已禁用」证明确实发出，再提交一次，按本地 stub 计数器差值判增量 = 1。
  修前：学员页·requestSubmit 增量 2（before 21 → after 23），其余 8 组增量 1；PASS 59 FAIL 1，退出码 1。
  原因：学员页只设 btn.disabled，处理函数没有 `if (btn.disabled) return;`（申请人/教师页有）。点击与回车被浏览器按禁用态拦住，
  不经过按钮的提交拦不住。已补守卫。修后 PASS 60 FAIL 0，退出码 0；`./scripts/verify.sh` 退出码 0。
- 2026-09-15 | T-012 | [x] | 申请人历史页「读不到 / 无记录」区分。新增 `node scripts/test-applicant-history-read-boundary.mjs`
  （node:vm 桩运行页面脚本，11 情形，**双向**判据：读不到不许出现「没有」、无记录不许出现「没读到」，并验证重试会重新请求）。
  列表 6 情形（error / null / {} / undefined / [] / 有记录）现状全对。
  时间线查出缺陷：读不到（error / null / {}）后提示「请稍后再点一次」，照做再点却只是把提示收起、不重新请求，要点第二下才重试。
  修复：只有已读到（loaded=1）的时间线再点才收起。修前 3 个不符 → 退出码 1；修后 0 个 → 退出码 0。
  回归：`node scripts/test-read-failures.mjs` PASS 22 FAIL 0；`./scripts/verify.sh` 退出码 0。
- 2026-09-15 | T-013 | [x] | [YELLOW] 学员侧读失败模式盘点，报告 `docs/operations/CSC-T-013-STUDENT-READ-FAILURE-INVENTORY.md`（只盘点，未改页面）。
  可复用模式 P1~P5；三页 11 个读取逐一列 error / 无结论现状（标明实测 vs 读码）。
  主要发现：courses 收到 `my_learning={}`、profile 收到 `my_student_profile=null` 会**卡在骨架屏**；
  courses 收到 null 显示「共 0 门」、首页 my_student_record 无结论时显示「尚未查到学籍记录」、timeline / program_catalog 的 error 被吞。
  有界候选任务 1 条：学员课程目录 my_learning 无结论边界（含验收命令），建议 GREEN；其余建议之后分别拆条。供 Luna 复核后决定是否入队。
- 2026-09-15 | T-014 | [!] | 卡住（UNCLEAR）：验收要求的「window.onerror 收集」在生产代码与全部 13 个分支中都不存在，
  补检查前需先决定是否新建采集器及其范围/去向。见 BLOCKED.md。T-015/T-016 与之无依赖，继续。
- 2026-09-15 | T-015 | [x] | [YELLOW] 缓存戳变更范围审核。新增 `scripts/check-stamp-only-diff.mjs`：新旧两版把 `?v=<12位>"` 归一后逐字比，
  相同 = 只改戳；否则（含畸形戳、新增、删除）= 内容改动，必须在 --expect 名单里；--per-commit 逐提交判，防中途加了又删被整段抵消。
  用例 `node scripts/test-stamp-only-diff.mjs` 11/11（临时 git 仓库）。
  实测命令：`node scripts/check-stamp-only-diff.mjs 4f47292 HEAD --per-commit --expect portal/applicant/profile/index.html portal/student/profile/index.html portal/applicant/history/index.html`
  → 退出码 0。10 个 csc 提交（至 bbab396）里带戳的 25 个 HTML 每次全部只改戳；有内容改动的 HTML 恰是 T-009/T-011/T-012 各自那一页；T-008 同一分钟内提交，戳未变（0 个）。
  顺带核对：check-cache-bust 的 `pages=27` 是扫描的 HTML 数（31 个跟踪文件去掉 docs/ 下 4 个），带戳的是 25 个，不矛盾。
- 2026-09-15 | T-016 | [x] | 资料页最小本地回归。目标脚本 `node scripts/regress-profile-pages.mjs` → 退出码 0，全部通过 8/8；
  报告 `docs/operations/CSC-T-016-PROFILE-REGRESSION-REPORT.md`（存在，由脚本生成）。
  范围：T-009 读取边界（vm）、T-010 词表契约、test-profile-writes（PASS 60）、test-portal-pages（112/112）、
  test-student-todo-loop 按其组隔离规则分 4 趟（St 24 / Sf 13 / Se 11 / Sp 20，均 FAIL 0）。
  运行器用例 `node scripts/test-regress-profile-pages.mjs` 5/5。
  过程中查明：前两次整支跑 todo-loop 在它那一段被 10 分钟工具超时切断 —— 该探针禁止 Sf/Se/Sp 同进程（设计如此），
  且不走 lib/chrome-launcher、未设 CHROME_PATH 时默认 Windows 路径。运行器改为分组跑并传入 chromeBinary()；探针本身未改。
  未留残留进程（一天内启动的 headless Chrome 为 0）。另见机器上有 28 个 1~2 天前的 headless Chrome，非本轮产生，未处理。
  T-015 提交后复核：`check-stamp-only-diff.mjs HEAD^ HEAD --per-commit`（在 865dd68 上）25 个 HTML 只改戳，退出码 0。
- 2026-09-15 | 更正 | BLOCKED.md 的 QUEUE 补货请求撤回：T-017~T-024 已在队列中（Luna 追加的这 8 条随 f5013a2 / T-011 的
  `git add CSC_AUTONOMOUS_QUEUE.md` 一起进了提交，该提交说明里没写到这一点）。我此前只 grep 了 T-014~T-016，误判为只剩 1 条。
- 2026-09-15 | T-017 | [x] | API 错误归一化边界检查：`node scripts/test-api-error-mapping.mjs`（node:vm 加载真实 api.js，20 个用例，
  覆盖 normalize / msg / fn / rpc 的未知、权限、限流映射、状态码优先级、不带服务端原文）。
  修前 5 个不符 → 退出码 1：① msg(constructor/toString/__proto__/hasOwnProperty/valueOf) 返回函数或对象（原型链取值）；
  ② fn() 403 无结构化 body → unknown；③ 429 无 body / 网关形状 body → unknown；④ body error="constructor" → message 是函数。
  修复（assets/js/portal/api.js）：msg 只认 MESSAGES 自有键；fn 只收字符串错误码，无码时 403→forbidden、429→rate_limited。修后 20/20，退出码 0。
  回归：test-admin-overview-writes PASS 28 FAIL 0；test-session-unknown PASS 23 FAIL 0；`./scripts/verify.sh` 退出码 0。
  页面「结果不明」按 HTTP 状态判（0 / ≥500 / 200 无数据），不看 code，本次改动不影响该分流。
- 2026-09-15 | T-018 | [x] | 申请历史页空数据 / 读取失败审核。与 T-012 同题，逐项核对现有覆盖（均通过）：
  空数据：vm「列表 []」「时间线 []」+ 浏览器 Hn4 / Hn5；读取失败：vm 列表 error/null/{}/undefined、时间线 error/null/{} + 浏览器 H1/H2/Hn1~Hn3c；
  重试入口：列表 error → UI.error onRetry（vm 验 reload）、列表无结论 → 刷新按钮（vm 验 reload，浏览器 Hn1b）、时间线读不到 → 再点即重读（vm）。
  补的缺口：时间线「再点即重读」此前只在 vm 桩里验过，浏览器里只看了 loaded 标记。给 test-read-failures.mjs 的 stub 加页内 rpc 计数，新增 Hn3d。
  负向对照：临时换回 T-012 修复前的页面（f5013a2 版本）→ Hn3d FAIL（请求 1→1），PASS 22 FAIL 1，退出码 1；已 `git checkout HEAD --` 还原。
  当前页面：PASS 23 FAIL 0，退出码 0；`node scripts/test-applicant-history-read-boundary.mjs` 11/11；`./scripts/verify.sh` 退出码 0。
- 2026-09-15 | T-019 | [x] | 资料页重复提交三种触发方式。T-011 的 D1/D2 已覆盖「在途时再触发」（三页 × 点击 / 回车 / requestSubmit，增量 1）。
  补 D3「不等待连发两次」（按钮来不及禁用的瞬间）：真实双击（clickCount 1→2）、回车连按两次、同一轮事件循环两次 requestSubmit；判据增量恰为 1。
  负向对照：临时换回 T-011 修复前学员页（5e1b4f3 版本）→ D3 学员·requestSubmit 增量 2（31→33）、D2 同样 21→23；PASS 67 FAIL 2，退出码 1；
  双击与回车连按在修复前也是 1（浏览器按禁用态拦下）。已 `git checkout HEAD --` 还原。
  当前页面：`node scripts/test-profile-writes.mjs` PASS 69 FAIL 0，退出码 0；`./scripts/verify.sh` 退出码 0。
- 2026-09-15 | T-020 | [x] | [YELLOW：改了提交钩子依赖的 scripts/bump.py] 缓存戳脚本对用户文件的保护。
  新增负向夹具 `python3 scripts/test-bump-untracked-guard.py`（一次性 git 仓库真跑 commit；每种形态验：不进 HEAD、文件未被改写、提交该拒则拒该放则放）：
  U1 子目录未跟踪 / U2 非 ASCII 文件名 / U3 文件名带空格 / U4 .gitignore 忽略 / U5 嵌套仓库 / U6 无本地 assets / U7 主检出里的 linked worktree。
  修前 18/23：U4 被忽略的页面被写入戳，随后 hook 暂存被 git 拒、整个提交中止；U5、U7 嵌套仓库 / linked worktree 的页面被写入戳（提交照常完成）——
  即本项目主检出每次提交都会改写 worktrees/* 里别的会话的 HTML；U3 拒绝信息里带空格的路径被切断。
  **任何形态都没有让用户文件进入 HEAD**（原有 GUARD 对未跟踪未忽略页面拒绝有效）；问题是越界写入与误拦。
  修复：在工作区里时，候选改为 `git ls-files -z --cached --others --exclude-standard -- '*.html'`（忽略的、嵌套的从头不读不写）；
  GUARD 改用 -z + --literal-pathspecs。修后 23/23。回归：test-hook-gate.py 16/16、test-cache-bust-contract.py 15/15、
  check-cache-bust 5/5、bump.py --list 仍为 25 个、`./scripts/verify.sh` 退出码 0。
  未处理：check-cache-bust.py 工作区模式（不带 --from-index）仍用 rglob 扫描，只读不写；pre-commit 用的是 --from-index，不受影响。
- 2026-09-15 | T-021 | [x] | 全站脚本语法与链接一致性。新增汇总入口 `node scripts/check-site-static.mjs`（6 步，一个退出码；任一步零文件 → 退出码 2）：
  JS/MJS/CJS 117 个（node --check）、TypeScript 8 个、HTML 内联 31 个、Python 9 个（ast.parse）、Shell 2 个（sh/bash -n）、站内链接 153 个 —— 全部 0 错，退出码 0。
  此前 assets/js 站点脚本、supabase 的 .mjs/.ts、scripts 的 .py/.sh、.githooks/pre-commit 都没有任何语法检查。
  过程中查明：`node --check` 对 .ts **不可靠**（放过 `function c(n: number {`，退出码 0）→ TS 改为 module.stripTypeScriptTypes + vm.SourceTextModule。
  用例 `node scripts/test-check-site-static.mjs` 11/11（每类坏文件各一例都点名失败；.ts 的 TS 层与 JS 层错误各一例；空转 → 2）。
  无外网：`sandbox-exec -p '(version 1)(allow default)(deny network*)' node scripts/check-site-static.mjs` → 退出码 0；
  同一沙箱反向对照 curl → exit 6、node fetch → ENOTFOUND（沙箱确实拦网）；运行前后 `git status --porcelain --ignored` 一致、无新 __pycache__。
  未接入 verify.sh（接入属改门槛，留给 Luna 决定）。`./scripts/verify.sh` 退出码 0。
- 2026-09-15 | T-022 | [x] | 无配置启动的友好降级测试：新增 `node scripts/test-noconfig-degraded.mjs`（自带 Chrome，约 45s）。
  覆盖全部 21 个引用 auth.js 的页面（P0 与 git grep 清单核对），走真实页面与真实 supabase-config.js（含本地旁路段）；
  两种「没配置」：absent（旁路 404）/ placeholder（旁路 = 仓库里的 supabase-config.local.example.js 原样，非秘密占位符）。
  逐页断言：CONFIG_STATE=missing、SDK 在（桩）但 createClient 0 次、无未捕获异常、页面不漏 undefined；
  门户 16 页整页「门户系统尚未启用」且无重试；login/register/forgot-password/faculty-verify 页内提示可见、提交键禁用；auth/recovery 失败卡片文案。
  稳定复现：本机 supabase-config.local.js 由测试服务器接管（从不读本机真文件）；非本机请求一律拦截（实际 0 个）；每次内部跑 2 轮逐字比对（S1）。
  量具自检 N1：旁路换成构造的「已填」值 → 判 ready、不显示「尚未启用」、createClient ≥1（证明不是永远判 missing）。
  两次独立运行均 PASS 91 FAIL 0，退出码 0；无残留进程。`./scripts/verify.sh` 退出码 0。
  顺带观察（未处理，候选）：auth/recovery 在 auth.js 未加载成功（`!A`）时也说「门户系统尚未启用」；
  以及 supabase-js 对格式不合法的 url 会在 createClient 抛错，使 auth.js 整体加载失败 —— 均属「配置填错」而非「没配置」，不在本条范围。
- 2026-09-15 | T-023 | [x] | [YELLOW] 发布前浏览器兼容性检查范围盘点，报告 `docs/operations/CSC-T-023-BROWSER-COMPAT-SCOPE.md`（只盘点，未改页面、未发布、未碰真实数据）。
  现状：63 支浏览器探针全是 Chromium；WebKit/Firefox/真机/内置浏览器 0；仓库无目标浏览器定义。
  特性扫描（36 段 JS、210 段 CSS，一次性正则）：JS 硬下限由 `?.` / `??` 决定（约 Chrome 80 / Safari 13.1 / Firefox 74，版本号待逐项复核）；
  CSS 软下限：`:has()` 有写明的回退；`inset`（含门户确认弹窗）与 flex `gap` 为中风险；`:focus-visible` 旧 Safari 无焦点框；
  `backdrop-filter` 全部缺 `-webkit-` 前缀（Safari < 18 无毛玻璃）。未核：supabase-js 2.116.0 UMD 的语法级别。
  候选 4 条：C1 目标浏览器矩阵（需 Enos 决定）/ C2 静态特性下限检查（GREEN）/ C3 补 -webkit-backdrop-filter（GREEN）/ C4 Safari 冒烟（需 Enos 先开远程自动化）。
- 2026-09-15 | T-024 | [x] | 阶段 checkpoint：报告 `docs/operations/CSC-T-024-CHECKPOINT-REPORT.md`，固定 SHA `749780292b605c3ce50922361da10445cb395332`。
  在该 SHA 上：`./scripts/verify.sh` 退出码 0；17 项非浏览器检查全部 0；浏览器 5 批 12 趟全部 0（profile-writes 69、portal-pages 112、todo-loop 4 组、read-failures 23、noconfig 91、admin-overview 28、session-unknown 23，均 FAIL 0）。
  运行前后被跟踪文件只有 Enos 的 CLAUDE.md 改动；无残留进程。
- 2026-09-15 | T-024 复核 | 报告提交 0d31169 后：`check-stamp-only-diff.mjs HEAD^ HEAD --per-commit` → 25 个 HTML 只改戳、0 内容改动，退出码 0。

QUEUE_EMPTY（2026-09-15）：队列无 `[ ]` 任务。剩余 `[!]`：T-003（验收已满足，待 Luna 改判）、T-014（待 Enos 决定，见 BLOCKED.md）。
- 2026-09-16 | T-025 | [x] | 学员 / 教师资料页主读取的网络失败与空响应回归：新增 `node scripts/test-profile-read-boundary.mjs`（node:vm，14 情形；申请人页仍由 T-009 的检查负责）。
  修前 6 个不符 → 退出码 1：学员页 my_student_profile 为 null/undefined 时读 prof.has_student_record 抛 TypeError、**卡在骨架屏**；
  为 {} 或缺 registrar_managed 时画空表单并写「尚无学籍记录」；教师页 my_profile 为 {} 或全 null 行时画空表单。
  修复：学员页按契约要求 self_editable 与 registrar_managed 均为对象，否则「没有读到你的资料」+ 重试；教师页用与 T-009 相同的 gotRow 判据。修后 14/14，退出码 0。
  网络失败（error.code=network）两页原本就走 UI.error + 重试，已加断言钉住；教师页教职档案「读失败 ≠ 还没有档案」也已钉住。
  夹具修正：test-profile-writes.mjs 的 my_student_profile 桩原为 `{profile, student}`，与 0017 契约不符，改为契约形状（未改任何断言）。
  回归：regress-profile-pages 8/8（profile-writes PASS 69、portal-pages 112/112、todo-loop 四组）、test-role-guard 退出码 0、`./scripts/verify.sh` 退出码 0。
- 2026-09-16 | T-026 | [x] | 缓存戳生成对路径空格与未跟踪文件的处理。T-020 已覆盖未跟踪（含空格 / 非 ASCII / 忽略 / 嵌套）；本条补**已跟踪**路径与带空格目录：
  `python3 scripts/test-bump-untracked-guard.py` 新增 U8（带空格目录里的未跟踪页 → 拒，完整路径）、U9（已跟踪带空格页有未暂存私稿 → 拒，文件不动，私稿不进 HEAD，完整路径）、
  P1 / P2（已跟踪、目录与文件名带空格 / 非 ASCII+空格 → 照常打戳并被准确暂存，HEAD 为新戳、工作区与 HEAD 一致）。
  判据通用化：「没进 HEAD」改判 HEAD 中该路径内容 ≠ 用户手上这一版（未跟踪 / 已跟踪一视同仁）；base 在 setup 之后取。
  当前 bump.py：37/37，退出码 0。负向对照：临时换回 T-020 前的 bump.py（f4d27b7）→ 30/37，U8d / U9d（路径被空格切断）及 U3d/U4/U5/U7 不符，退出码 1；已还原。
  bump.py 本身未改（T-020 的修复已满足）。回归：test-hook-gate 16/16；`./scripts/verify.sh` 退出码 0。
