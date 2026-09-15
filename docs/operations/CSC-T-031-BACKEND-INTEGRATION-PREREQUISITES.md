# 真实后端联调前置条件盘点（T-031）

读者：Luna / Enos。分支 `csc/2026-09-14`，2026-09-16。

**边界**：只读仓库文档与源码整理。没有连接任何真实服务，没有改安全设置，也没有碰真实数据。下文所有「当前状态」都是**文档里写的状态**，没有经过实时核实。各文档的日期不同，互相矛盾的地方已经标出。

文档简称：
- HO = `AMAS_PROJECT_HANDOFF.md`
- S0 = `STAGING-0-READINESS-REPORT.md`
- PL = `PORTAL-local-staging-setup.md`
- 1A7 = `STAGING-1A7-CONTROLLED-LEDGER-REPAIR-REPORT.md`
- 1A8 = `staging-1a8/STAGING-1A8-0022-PREFLIGHT-REPORT.md`
- DB4L = `db4/BUSINESS-DATA-FAST-TRACK-LIVE-REPORT.md`（2026-09-10，是最新的预发环境报告）
- TR = `supabase/tests/README.md`

以上文档都在 `docs/operations/` 下，TR 除外。

## 〇、先说结论

1. **能联调的只有预发环境**：`amas-staging`，ref `sdrwyebizfdwldlfjyim`（HO:928）。生产环境 **NOT ESTABLISHED**，本阶段明令禁止创建（HO:929，S0:662）。
2. **文档之间有冲突**：HO 仍写着迁移到 0021、0022 未执行（HO:911，HO:1183-1222）；更新的 DB4L 写的是账本 0001–0026、0027 缺席（DB4L:14-17）。**联调前要先以实时只读核对为准**，不能照抄 HO。
3. **本机已经具备连到预发环境的条件**：本地 `supabase-config.local.js` 指向的正是上面这个预发 ref（只在进程内比对，结果为「相同」，没有输出任何值）。这就是 INCIDENT-0916 的前提：测试数据很可能写进了**预发库**的 submissions 表。

## 一、前置条件与现状

| # | 前置条件 | 文档里的现状 | 出处 | 缺口 / 谁来解 |
|---|---|---|---|---|
| E1 | 有可联调的 Supabase 环境 | 预发环境运行中；是否仍然存活需要 owner 确认 | HO:928；S0:646 | Enos 确认 |
| E2 | 生产环境 | NOT ESTABLISHED，本阶段禁止创建 | HO:929，HO:1080-1091；S0:662 | BLOCKER-01（用户） |
| M1 | 迁移账本与仓库一致 | 仓库 0001–0027；预发账本 0001–0026；0027 标注「PROPOSED — DO NOT APPLY」 | DB4L:14-17；`STAGING-1A-CANONICAL-EXPECTED-STATE.md`:186 | 以实时只读核对为准 |
| M2 | 账本写入者可追溯 | 0011–0021 的写入者、0022 的执行者都是 **UNRESOLVED / UNKNOWN EXTERNAL WRITER** | 1A7:229-255；1A8:535-539，572-580 | 需要 Enos 追查，并重定「单一写入者」规则 |
| M3 | 已知漂移可以接受 | 0008 在账本里的文本和仓库文件差 5 处 `::text` 转换，文档判定行为无差异 | 1A8:262-280 | 需要确认新的 0022 基线摘要 |
| M4 | 托管备份与恢复验证过 | 从未验证 | S0:614-617 | NEEDS_OWNER |
| F1 | 7 个 Edge Function 已部署 | 预发环境已部署，生产未部署 | HO:607-617，912，1245 | 部署状态需实时核对；`check-portal-config.py` 只核对源码存在（:244-262） |
| F2 | 函数密钥已配置 | 函数读取 `SUPABASE_URL`、`SUPABASE_SERVICE_ROLE_KEY`，`login-by-identifier` 另读 `SUPABASE_ANON_KEY` | `supabase/functions/*/index.ts`；`login-by-identifier/index.ts`:3,16 | 配置方式文档未写 |
| A1 | Site URL / 重定向允许清单 | 预发：`localhost:8090` 与通配 `/**`；生产：只允许精确 URL，未决定 | HO:933-954；S0:519-528 | DECISION_REQUIRED；取值来源文档 `AUTH-production-auth-config.md` 不在本仓库（HO:244，309） |
| A2 | 邮件确认与 SMTP | 预发 `mailer_autoconfirm=true`、SMTP 未配置；生产要求自有 SMTP | HO:933-954，1095-1106 | BLOCKER-02（用户） |
| A3 | 改密码时重新验证 / MFA | 预发 reauth=false；生产要求 true；MFA/TOTP 已配置 | HO:933-954 | 生产前处理 |
| A4 | CORS 来源 | 预发 `localhost:5173`；生产 DECISION_REQUIRED | HO:933-954 | 决定 |
| A5 | 生产域名 | 未定 | HO:1308-1325（BLOCKER-07） | 用户 |
| S1 | RLS / 安全验收通过 | 预发共 621 条断言通过（没有生产环境的）；2B 208/208 | HO:1379-1382；`PORTAL-2B-acceptance-report.md`:6 | 结论停留在当时的迁移版本上，迁移变化后需要重跑 |
| S2 | 端到端矩阵与 RLS 负向矩阵 | `e2e_acceptance_matrix.mjs` 可执行 0 例，全部被环境阻塞；53 项 BLOCKED_BY_ENV；6 项 AUTH 外部测试未跑；RLS 负向矩阵待跑 | `RELEASE-READINESS-REPORT.md`:331；S0:261，377，436-451 | 需要环境与测试账号 |
| S3 | 验收脚本可在本机运行 | 需要 `staging.env`（URL / ANON / SERVICE / DBPW / PGHOST），可用 `AMAS_ENV` / `SEC_ENV_DIR` 覆盖；**`sec3_http.mjs` 写死了 Windows 草稿目录路径** | TR:56-67；`sec3_http.mjs`:7 | 本机没有 `staging.env`；脚本路径要先改成可配置（候选任务） |
| C1 | 前端拿到预发配置的方式 | 已提交的 `supabase-config.js` 保持为空；只在回环地址上加载 gitignored 的 local 文件 | `assets/js/supabase-config.js`:7-10，25-45；PL:23-35 | 已具备（本机 local 文件存在，并指向预发环境） |
| C2 | 不把配置发布出去 | master 推送即由 GitHub Pages 公开；**TR 要求 UI 验收时「临时」把配置填进已提交的 `supabase-config.js`，跑完再还原** | PL:15-19；TR:26-27 | 这是发布风险：一旦忘记还原并推送，配置就公开了。建议改用 local 覆盖文件 |
| C3 | 预发与生产分开构建 | 需要分开，但生产配置怎么注入没有文档 | S0:530-534 | 未设计 |
| D1 | 测试数据隔离 | 预发只能用合成账号（`*@amas-test.dev`），清理 SQL 写在 TR；没有批准不得远端写入 | S0:268-298；PL:134-141；TR:72-81 | **submissions 表没有隔离与清理约定**（INCIDENT-0916） |
| D2 | 预发里已有的数据 | DB-4 身份映射 7/7，业务数据 74 行已迁入预发 | `db4/DB-4-LIVE-EXECUTION-REPORT.md`:7-14；DB4L:7-12 | 联调写入会和这些真实迁移数据混在一起，需要约定标识与清理办法 |
| D3 | 本地探针不会误写后端 | 已加两道防线（INC-0916-G），守卫检查 19/19 | `BLOCKED.md` INCIDENT-0916；`scripts/test-probe-network-guard.mjs` | 已具备 |

## 二、需要人来决定的（按依赖顺序）

1. **本地门户联调连哪个环境**（PL:46，145-162）。目前本机事实上已经连向预发环境。
2. **INCIDENT-0916**：核对并清理预发库 submissions 表里的测试行，并约定 submissions 表的测试数据标识与清理办法（D1）。
3. **账本写入者与 0022 执行者追查**，确认单一写入者规则（M2）。
4. **待监督裁决**：20 行业务数据（`db4/BUSINESS-DATA-FAST-TRACK-TRIAGE-REPORT.md`:11），DB4L 以「WAIT FOR SUPERVISOR」结束（DB4L:209）。
5. **生产相关的 BLOCKER**：01 生产项目、02 SMTP、07 域名、05 / 06 AUTH 提交与合并（HO:1080-1181，1308-1325）。

## 三、不需要外部决定、可以直接入队的候选（GREEN）

- `supabase/tests/sec3_http.mjs` 等脚本把写死的 Windows 草稿目录改成读取 `SEC_ENV_DIR` / `AMAS_ENV`（S3）。
- 修订 TR 的 UI 验收说明：改为使用 gitignored 的 local 覆盖文件，不再临时改动已提交的 `supabase-config.js`（C2）。
- 在 HO 顶部加注：Supabase 状态段落已被 DB4L 取代（〇.2）。这属于文档修订，HO 归属需要先确认。
