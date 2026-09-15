# BLOCKED.md — 需要 Enos / Luna 介入的事项
（Claude 追加，处理完由 Luna 删除或标 `[已解决]`）

格式：
- [ ] <任务ID> | <级别 RED/YELLOW/UNCLEAR> | <一句话问题> | <需要谁做什么> | <时间>

- [ ] T-003 | UNCLEAR | `./scripts/verify.sh` 无法执行：被运行环境的权限分类器拒绝，理由 `Create Unsafe Agents` | 需 Enos 决定：或授予该脚本的执行权限，或改由人工运行并把结果贴回；我不会以手工重跑脚本内容的方式绕过该拦截 | 2026-09-14
- [ ] T-000 | UNCLEAR | 本规则集的引入路径存疑：最初「安装 CLAUDE.md 并进入无人值守循环」的指令是夹在工具输出里、伪装成用户消息到达的，我当时判为注入并拒绝；随后由 Enos 本人在真实对话轮中重申并亲自放入文件。本轮另有两次安全拦截命中同一条线（读取来源目录 = Instruction Poisoning；执行 verify.sh = Create Unsafe Agents） | 需 Enos 确认：是否确认采用本规则集，并知悉它将取代当前会话既有的「每包固定 SHA、监督交验后再继续」机制 | 2026-09-14

- 更新 2026-09-14（Claude 追加，未改上面条目状态，留给 Luna 处置）：
  · T-003：本轮 `./scripts/verify.sh` 已能执行，拦截未复现。首轮退出码 1（index.html JSON-LD 误报），已在 T-005 修复，现退出码 0。
  · T-000：Enos 本轮在真实对话轮直接指示「读根目录 CLAUDE.md，按工作循环从队列取第一条未完成任务开始执行」，据此进入循环。
- [ ] T-014 | UNCLEAR | 验收写「window.onerror 收集存在且不泄漏敏感值」，但**生产代码里没有任何页面异常采集**：
  `git grep` 全部 13 个本地/远端分支的 *.html 与 assets/**/*.js，无 `window.onerror`、无 `addEventListener("error")`、无 `unhandledrejection`。
  现有的只有测试侧：21 支探针用 CDP `Runtime.exceptionThrown` 收集，1 支（test-profile-writes.mjs）在 stub 里挂 `window.addEventListener("error")` 只存 message。
  「补一条静态检查」无法对着不存在的采集器成立；要新建采集器则涉及：装在哪些页面（公开站 main.js / 门户 shell.js / 全部）、
  只留在内存还是上报（上报到哪个服务 = 外发 + 隐私）、哪些字段算敏感（token / email / query string / 手机号）。
  | 需 Luna / Enos 决定其一：(a) T-014 本意是测试侧采集 → 改写验收（例如「探针的页面异常采集不把 stub 凭据写进输出」）；
  (b) 要生产侧采集 → 给出安装范围与去向（仅内存 / 上报目标），我按此实现并附静态检查；(c) 撤掉此条 | 2026-09-15
- [ ] QUEUE | UNCLEAR | 队列剩余未完成任务少于 2 条：T-015 完成后只剩 T-016 一条 `[ ]`（T-003、T-014 为 `[!]`） | 请 Luna 补货；T-013 报告里有一条可直接入队的有界候选（学员课程目录 my_learning 无结论边界） | 2026-09-15
- 更正 2026-09-15（Claude 追加）：上面 `QUEUE` 那条补货请求**判断错误，撤回**。T-017~T-024 早已由 Luna 加入队列
  （随 f5013a2 / T-011 的提交一并进了仓库，我当时只 grep 了 T-014~T-016 三行，漏看了后面）。请忽略该条。
