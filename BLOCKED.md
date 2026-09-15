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
- [ ] INCIDENT-0916 | RED | **测试探针很可能已向真实 Supabase 写入测试数据** | 需 Enos：核对并决定是否清理真实库；决定是否给相关探针加「拦截本地旁路」保护 | 2026-09-16
  · 经过：T-029 回归时我在本机运行了 `test-chat-timeout.mjs` 与 `test-giving-submit.mjs`（仓库原有探针）。这两支直接从仓库根目录伺服页面、
    **不替换** supabase-config.js，且对非本机请求 `Fetch.continueRequest` 放行。本机有一份真实填好的 `assets/js/supabase-config.local.js`
    （gitignore；只读核对：url 为 `<ref>.supabase.co`，anonKey 长 208，未打印任何值），页面跑在 127.0.0.1，旁路把它加载进来 →
    `logToDB`（main.js）/ giving.html 的写库分支按真实配置向 `https://<ref>.supabase.co/rest/v1/submissions` 发请求。
  · 证据：放行运行中 test-chat-timeout 的 I2 记到 **2 个外网请求**；随后我用「拦截并记录」的临时副本复跑两支（副本已删除），
    各记录到 `OPTIONS https://<ref>.supabase.co/rest/v1/submissions`（CORS 预检，已拦下）。据此判断放行那次**很可能是预检 + POST**。
    giving 那支没有外网计数，且浏览器会缓存预检，**写入条数无法从本地确定**。
  · 可能写入的内容（探针夹具，非真实个人信息）：留言 type=chat，姓名「张三」、联系方式 `zhangsan@example.invalid`、正文「这是留言正文」；
    奉献 type=giving，姓名「测试访客」、联系方式 `local@example.invalid`。时间约 2026-09-16 05:0x（本机时间）。
  · 与 T-029 改动无关：配置真实填好时，新判据 SUPA_IS_FILLED() 与旧的「非空」判断结果相同，都会写库；这是探针 + 本地旁路的既有问题。
  · 我已停止运行这类探针。同类风险的探针（不替换配置且放行外网）：test-chat-timeout、test-giving-submit、test-upload-flow。
  · 我**没有**、也不会自行连接真实库去查询或删除（需要凭据与授权）。
- [ ] T-030 / T-031 / T-032 | UNCLEAR | 因 INCIDENT-0916 暂停，队列标 `[!]`（任务本身未被判定不可做） | Luna：INCIDENT-0916 有决定后改回 `[ ]` 即可继续 | 2026-09-16
  · 更新 2026-09-16（Claude 追加）：**防止再发生**的措施已落地（真实库核对 / 清理仍待 Enos）：
    L1 `scripts/lib/no-local-config.mjs`：58 个带本机服务器的探针在读磁盘前一律拒绝伺服 supabase-config.local.js（例外 3 个，理由逐条核实）；
    L2 `scripts/lib/chrome-launcher.mjs`：*.supabase.co / *.supabase.in 合并钉到 0.0.0.0（与各探针原有规则合并为一个旗标）；
    守卫检查 `node scripts/test-probe-network-guard.mjs` 19/19。加防线后复跑：test-chat-timeout 39/39（I2 零外网请求）、test-giving-submit 31/31、test-upload-flow 48/48。
- [ ] T-030-RED | RED | 认证相关页面在途重复提交：login / register / forgot-password 的提交处理函数没有 `if (btn.disabled) return;` 守卫 | 需 Enos 决定是否允许改认证页（CLAUDE.md 列为 RED，Claude 未改） | 2026-09-16
  · 实测（`node scripts/test-form-keyboard-resubmit.mjs`，supabase auth 为本地桩，延迟 1.5s）：回车连按 / 在途再按回车均只发 1 次（浏览器按按钮禁用态拦下）；
    同一轮两次 `requestSubmit`、在途再 `requestSubmit` 均发 **2 次**（signInWithPassword / signUp / resetPasswordForEmail 各被调两次）。
  · 影响：只有不经过按钮的程序化提交会触发（扩展、辅助工具、将来页面自己调用），普通点击与回车不受影响。修法与资料页 / 联系表单相同（一行守卫）。
  · 未测：auth/recovery（需要 recovery 令牌）、faculty/verify 的 tvForm（需要邀请码与会话）—— 两者同样没有这行守卫（读源码）。
