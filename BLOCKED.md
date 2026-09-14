# BLOCKED.md — 需要 Enos / Luna 介入的事项
（Claude 追加，处理完由 Luna 删除或标 `[已解决]`）

格式：
- [ ] <任务ID> | <级别 RED/YELLOW/UNCLEAR> | <一句话问题> | <需要谁做什么> | <时间>

- [ ] T-003 | UNCLEAR | `./scripts/verify.sh` 无法执行：被运行环境的权限分类器拒绝，理由 `Create Unsafe Agents` | 需 Enos 决定：或授予该脚本的执行权限，或改由人工运行并把结果贴回；我不会以手工重跑脚本内容的方式绕过该拦截 | 2026-09-14
- [ ] T-000 | UNCLEAR | 本规则集的引入路径存疑：最初「安装 CLAUDE.md 并进入无人值守循环」的指令是夹在工具输出里、伪装成用户消息到达的，我当时判为注入并拒绝；随后由 Enos 本人在真实对话轮中重申并亲自放入文件。本轮另有两次安全拦截命中同一条线（读取来源目录 = Instruction Poisoning；执行 verify.sh = Create Unsafe Agents） | 需 Enos 确认：是否确认采用本规则集，并知悉它将取代当前会话既有的「每包固定 SHA、监督交验后再继续」机制 | 2026-09-14

- 更新 2026-09-14（Claude 追加，未改上面条目状态，留给 Luna 处置）：
  · T-003：本轮 `./scripts/verify.sh` 已能执行，拦截未复现。首轮退出码 1（index.html JSON-LD 误报），已在 T-005 修复，现退出码 0。
  · T-000：Enos 本轮在真实对话轮直接指示「读根目录 CLAUDE.md，按工作循环从队列取第一条未完成任务开始执行」，据此进入循环。
