# AMAS 全项目自动化测试与优化建议 · 2026-10-27

状态：全量执行完成，补充缺陷复核与原始日志已保存。

后续修复见 [修复与整顿记录](AMAS-REPAIR-2026-10-27.md)。其中对 P2-07 已作更正：10 月 26 日恢复总部 8 项的页面决策晚于旧数据库 4 项配置，应将数据库对齐到 8 项。本文保留初审原始结果，不能作为修复后的当前状态。

本次按用户要求检查单元逻辑、契约、数据库、浏览器业务流程、账号身份、移动端及公开站点。测试对象为当前工作区，基准提交 `0e2b4295`；开始时已有的 `BLOCKED.md`、`QUEUE.md`、`SUPERVISOR.md` 和日志改动保留。本次没有修改业务代码、现有断言、数据库迁移或真实环境权限，没有部署、提交或推送。

## 结论

**核心学籍业务的既有测试通过，但补充测试发现费用与权限方面的实际缺陷，不能以既有回归绿灯作为完整上线验收。**

申请、录取、总校确认、建档、27 门课程、成绩发布、77 学分毕业与成绩单的本地数据库闭环已通过。新增的角色矩阵与异常测试则复现财务资料可见范围过宽、MFA 绕过、记账重试缺少幂等保护、汇总截断、角色入口不一致及过期管理员邀请等问题。

证据目录：[本轮日志与复现脚本](../../logs/evidence/2026-10-27-audit/)。未验证事项不计为通过；一次性 PostgreSQL 与模拟 SDK 不等于真实 Supabase 身份认证验收。

## 测试范围与统计

| 层次 | 结果 | 解释 |
|---|---|---|
| 既有自动检查 | **112 项：95 通过，17 未通过** | 按补齐环境后的最终结果统计；包含旧断言、设施错误和真实问题，不能当成 17 个独立产品缺陷 |
| 数据库验收 | **13 套：10 通过，3 失败** | 3 套历史夹具过期，失败后的断言未执行到 |
| 新增数据库身份矩阵 | **13 条通过，3 条失败** | 财务敏感资料 2 条、MFA 写入 1 条 |
| 新增浏览器角色 / 费用矩阵 | **9 条通过，5 条失败** | 两种角色入口、大数据截断、未知写入结果及重复请求 |
| 新增 8 个 Edge HTTP 矩阵 | **101 条通过，6 条失败** | 5 个 null 请求体 500，加过期管理员邀请 |
| 原有审核入口 HTTP | **8 条通过** | 使用真实 Deno 处理器和本地模拟后端 |
| Edge 类型检查 | **8 个：6 通过，2 失败** | 详见类型问题 |
| 新增公告与在途操作组合测试 | **4 条通过，3 条失败** | 公告响应会打断下载和咨询 |
| 手机布局补充检查 | **32 条通过** | 360 / 390px，含四语言状态栏；不替代触摸控件尺寸检查 |
| 线上公开页面 / 资源 GET | **15 项通过** | 与本地文件字节一致；不包含真实账号旅程 |

以上各层存在交叉，不能相加作为唯一用例总数。完整机器可读记录：[最终既有检查](../../logs/evidence/2026-10-27-audit/final-results.json)、[SQL 汇总](../../logs/evidence/2026-10-27-audit/sql-results.json)。

首次既有检查为 93 通过、19 个非零退出；申请写入因 300 秒截止未跑完，延长后 307/307 通过；课程迁移检查补上相邻 App 的权威源后通过，因此最终为 95/112。另一个缺环境的项目目录检查也已补上公开只读配置执行，发现真实目录不一致，仍记失败。

- 既有测试：自动发现 `scripts/test-*` 中 96 个 JS/Python 文件；学员待办按项目要求分四组，另跑基础验证和静态检查。
- 数据库：全部 43 个迁移装入一次性 PGlite PostgreSQL 17.5；运行最新 SIS 及旧门户、学号、Schema 验收。
- 服务端：8 个 Edge Function 的 Deno 类型检查；真实函数与真实 SDK 经本地 HTTP 接口测试角色和异常输入。
- 补充身份测试：9 种身份，加无角色、角色撤销、角色过期；在 `authenticated` 数据库角色下验证 RLS。
- 公开线上抽查：15 个页面和资源匿名 GET 均为 200，响应字节与本地对应文件一致。未执行页面脚本、登录、表单提交或后端写入。

没有行覆盖率插桩，因此本报告不提供虚构的“代码覆盖率百分比”。检查任务数、断言数和行覆盖率是不同指标。

## 优先处理的问题

### P1-01 · 财务可读取完整报名资料与总校申请表

复现：仅授予 `finance`，使用 `authenticated` 数据库角色，直接查询 `submissions.data` 与 `submissions.school_form`，可读到测试中的健康与家庭资料标记。

原因：`0042_finance.sql` 的 `sub_finance_select` 开放整行，RLS 不会因前端只选择姓名等列而限制其他列。其“只读姓名、班级与对应账号”的注释与实际权限不一致；`0038` 的总校申请表只给教务读写的约定也被这条策略扩大。

建议：财务名单改由受控 RPC 返回必要字段，移除财务对原始报名整行的读取路径；教务完整资料访问继续按业务授权处理。加入 REST 指定敏感列读取的否定式测试。

只读核查确认：现有 `amas-staging` 上同样存在这条整行读取策略，且 `authenticated` 有报名表 SELECT 权限；表中存在上述敏感列。本次没有查询真实报名内容。

证据：[权限补充测试](../../logs/evidence/2026-10-27-audit/additional-role-matrix.log)。复现数据全部为合成数据；未读取真实个人资料。

### P1-02 · MFA 开启时，财务仍可用 AAL1 直接记账

复现：确认 `mfa_required()=true`，设定合法财务身份和 `aal1`，直接插入 `finance_entries` 成功；`aal2` 正向对照也成功。

原因：费用页面要求 `requireAal2: true`，数据库 `fe_insert` / `fe_void` 只检查角色，写入直接经客户端表接口进行，未经过执行 MFA 检查的 Edge/RPC。

建议：在服务端和数据库落实同一 MFA 开关与角色检查，覆盖记账和作废；测试开、关、缺配置及读取失败四种情况。页面守卫不能承担数据库授权职责。

当前 `amas-staging` 的 MFA 开关为 **false**，符合此前“暂时关闭”的项目决定；远端费用策略与本地一致。该缺陷指开关恢复 true 时数据库仍不强制 AAL2，并非把当前明确关闭 MFA 判为故障。

证据：[权限补充测试](../../logs/evidence/2026-10-27-audit/additional-role-matrix.log)。本次未修改生产或本地业务权限。

### P1-03 · 记账结果未知时允许重复提交

复现：模拟提交后响应丢失，页面提示“这一次没有记上，请再试一次。”再次点击会产生第二次插入请求；两次请求没有稳定的幂等键。单笔请求无 `batch_id`；整班操作的批次也会在重试时重新生成。

影响：如果第一笔已在服务端提交，重试可能形成重复应收或收款。补充测试证明客户端会重发无幂等标识的请求，未声称在真实环境制造了重复账目。

建议：每次业务操作使用跨重试保持不变的请求 ID，数据库施加唯一约束，服务端原子地返回首次结果；未知结果时提示核对流水并查询状态。作废流程也要区分确定拒绝与结果未知。

证据：[浏览器补充测试](../../logs/evidence/2026-10-27-audit/additional-browser-matrix.log)，以及独立重复执行的 [复核日志](../../logs/evidence/2026-10-27-audit/additional-browser-recheck.log)。

截图：[结果未知时的重试提示](../../logs/evidence/2026-10-27-audit/screenshots/finance-unknown-result.png)。

### P1-04 · 过期管理员仍能创建教师邀请

复现：邀请入口读取到一条已过期的 `super_admin` 角色，仍返回 200，并发出邀请与审计写入请求。

原因：`create-teacher-invitation/index.ts` 查询角色仅过滤 `revoked_at`，未过滤 `expires_at`；后续用服务端凭据直接写表，没有数据库活动角色复核。

建议：统一使用包含过期、撤销和作用范围判断的活动角色校验；邀请写入与授权复核置于同一受控操作。其他入口也要核对角色过期处理，不能只依赖页面缓存的角色。

证据：[教师邀请 HTTP 测试](../../logs/evidence/2026-10-27-audit/http-matrix-create-teacher-invitation.log)。这里执行真实处理器和 SDK，身份及后端均为本地模拟，未发出真实邀请。

只读下载已部署的邀请入口 v3，内容与本地完全一致，角色查询同样缺少有效期判断：[源码比对](../../logs/evidence/2026-10-27-audit/remote-invitation-comparison.json)。未在远端发起邀请来验证此问题。

### P1-05 · 费用记录截断后仍显示为完整合计

复现：构造 1001 笔各 1 THB 的数据，模拟仓库 `supabase/config.toml` 中 `max_rows=1000` 的接口上限，页面显示 1000 THB，没有不完整数据提示。

原因：费用页面一次读取明细并在浏览器汇总，设置 `limit: 5000`，未翻页或核对完整性。客户端请求较大的 limit 不能证明服务端返回全部数据；即使服务端允许 5000，超过该数仍会截断。名单也采用单次读取。

建议：全量余额与统计在服务端聚合；明细和名单稳定分页，明确区分“本页合计”和“全部合计”。加入 999 / 1000 / 1001 / 5001 行边界测试，包含同日流水、多个币种及作废记录。真实托管环境的行数上限尚未核对。

证据：[浏览器补充测试](../../logs/evidence/2026-10-27-audit/additional-browser-matrix.log)。

截图：[截断后的费用合计](../../logs/evidence/2026-10-27-audit/screenshots/finance-truncated-total.png)。

### P2-01 · 财务与内容管理身份登录后落入拒绝页

`homeForRoles()` 把两种身份分配到 `portal/admin/`，但该页只允许 `registrar`、`academic_admin`、`super_admin`。补充浏览器测试中财务和内容管理都显示“你没有访问这个页面的权限”；财务直接访问费用页则通过。

建议：按身份映射到可用首页；财务落到费用页。为内容管理明确可操作的页面，再同步入口、菜单和守卫。避免通过扩大总览权限修复导航问题，因总览包含招生与学籍等信息。

证据：[全角色入口测试](../../logs/evidence/2026-10-27-audit/additional-browser-matrix.log)。

截图：[财务默认首页被拒绝](../../logs/evidence/2026-10-27-audit/screenshots/finance-landing-blocked.png)。

### P2-02 · 五个入口接收 JSON null 时返回 500

已复现：`login-by-identifier`、`submit-teacher-verification`、`create-teacher-invitation`、`review-teacher-verification`、`student-lifecycle`。合法 JSON `null` 通过解析后，对属性的直接访问抛异常。

建议：共用请求对象验证器，在访问属性前拒绝 `null`、数组及原始类型，统一返回 400，并保留 401 / 403 / 409 等业务状态的语义。`review-application`、`sis-admin` 和 `recovery-finalize` 的本轮同类边界通过。

证据：[8 个入口 HTTP 测试结果索引](../../logs/evidence/2026-10-27-audit/edge-http-matrix-results.json)。

### P2-03 · 两个 Edge Function 类型检查失败，SDK 未精确锁定

当前 Deno 2.9.6 下，`review-application` 有 12 条 TS2339，涉及验证结果的联合类型收窄；`create-teacher-invitation` 有一条 TS2345，涉及 `SupabaseClient` 泛型。其余 6 个入口类型检查通过。

Edge 入口引用 `npm:@supabase/supabase-js@2`，本次解析到 2.118.0；浏览器本地 SDK 为 2.116.0。这些类型失败不等于已证实线上运行失败；独立关闭类型检查执行的审核入口原有 8 项 HTTP 测试通过。

建议：给验证结果建立显式判别联合类型，统一客户端类型；精确锁定 SDK 和运行时、提交依赖锁文件，并将类型检查纳入验证入口。

证据：[类型检查索引](../../logs/evidence/2026-10-27-audit/deno-check-results.json)、[审核运行测试](../../logs/evidence/2026-10-27-audit/deno-edge-runtime.log)。

### P2-04 · 部分历史 SQL 用例已与当前模型脱节

- `portal2b_acceptance.sql`：分类预期合计 67 门；现目录 68 门，神学类为 12 门而非 11 门。最新迁移自检及 68 门总数通过。
- `db6_course_contract.sql`：断言课程数为 67，当前为 68。
- `scripts/verify-g1/checks.sql`：夹具使用 `application_pathway='degree'`，当前枚举不支持。

建议：从正式课程总表与业务枚举生成受版本管理的夹具，保留反例，核对剩余断言后再更新；不得为获得绿灯直接放宽或删断言。以上失败意味着这些文件后续断言本轮未执行到，应在修复夹具后补跑。

证据：[旧门户 SQL 首轮](../../logs/evidence/2026-10-27-audit/sql-extended.log)、[数据库契约复核](../../logs/evidence/2026-10-27-audit/sql-extended-recheck.log)、[实际结构清单](../../logs/evidence/2026-10-27-audit/schema-inventory.json)。

### P2-05 · 浏览器特性基线与旧回归需要维护

新费用页使用 `crypto.randomUUID`，本地 SDK 包使用逻辑赋值，均超出原登记的特性集合。因此特性基线自测和真实扫描失败；这不是在旧浏览器上完成的运行故障证明。

课程搜索测试访问已不存在的 DOM。查阅提交 `d705546a` 和 `main.js` 注释后确认：搜索和分类筛选是按此前产品要求移除的，当前只保留学位筛选，应将旧测试按明确的新需求重写，而非恢复已移除功能来获得绿灯。

聊天超时用例中 38 项功能断言通过，但“零外网请求”计数失败；Discover 返回首页后的 console 检查也出现本地配置 404 / 后端连接拒绝。新增动态公告请求与测试服务器主动拒绝本地配置的行为需要在探针中明确隔离和分类。奉献帮助用例 G6 要求只发一次请求，实测拦到 2 次；内容保留、可重试、提示可见等条件通过。网站新增先写后台再发邮件后，探针需要按目标和提交阶段分别计数，不能把请求数增加直接当成重复提交。

本地旁路测试仍假设仓库默认连接配置为空，但此前已经明确配置了 `amas-staging`，所以其“没有旁路必定 missing”的前提不成立。应使用独立的空 / 已配置夹具验证旁路行为。网络诊断明确记录首页还会尝试调用 `/rest/v1/rpc/site_public`，并主动拒绝 `supabase-config.local.js`；诊断过程中所有外部请求均在派发前中止：[网络诊断](../../logs/evidence/2026-10-27-audit/public-network-trace.json)。

`test-portal-session` 的 39 项断言通过，剩余失败断言要求管理总览不加载 `shell.js`；该页已经改为使用门户外壳，属于结构前提过期。失效提示、回跳和 next 保留等行为断言通过，不能把此失败表述为“会话过期功能失效”。

学员待办的四组测试均因新只读 RPC `portal_board` 未登记到白名单而触发 A1/A2 失败；日志实际只记录了一笔 `update_my_contact`，不能表述为“学生资料被额外写入”。应按数据库只读函数定义维护分类，并继续保留未知 RPC 失败机制。

两套资源测试原脚本均缺 `DL` 下载目录定义，业务断言尚未开始即退出。审计副本只修临时目录及移动后的导入路径，未改断言；资源实际交付的 56 条断言全部通过。等待测试为 25/27，英 / 韩提示断言在后续复核中仍失败，具体原因待定位；不能直接归为翻译缺失，不以目录修好就计为全绿：[副本结果](../../logs/evidence/2026-10-27-audit/resource-repaired-results.json)。原脚本仍计为未通过。

这些仍计为失败，不伪装成通过；需要维护测试设施和业务期望。另：首页介绍区数字仍写 67 门，与当前 68 门目录不一致，是可直接修复的内容问题。

### P2-06 · 首页新增学位筛选按钮的触摸高度不足

手机触摸检查实测五个学位筛选按钮高度均为 35px，低于项目现有的 44px 测试标准；宽度分别约 78–128px。该失败属于当前控件尺寸问题，应与旧的 Windows/macOS 黄金尺寸基线分开处理。

建议：扩大按钮的实际点击高度与间距，保持长文本及四语言布局，回归 360 / 390px 下的真实点击和键盘焦点。不要通过把这些按钮加入忽略列表消除失败。

证据：[触摸检查](../../logs/evidence/2026-10-27-audit/full-test-pages-touch.log)。

`test-touch-targets` 还复现原先登记的 T0 平台黄金尺寸差和 T5 跳转链接焦点失败。因为本次新增了 T4 学位按钮过小，整套不能按“只有既有基线”豁免。

### P2-07 · 官网招生选项与实际开放项目不一致

使用配置中公开 anon key 只读查询现有 `amas-staging`：开放项目为 `bth, gdip, mdiv, dmin`；官网下拉却有 `bth, pastor, preaching, dip, gdip, mdiv, dmin, missionary`。一致性测试 5/6，通过读取的全部 9 行都是公开项目目录，没有个人数据。

`0022_program_offering_scope.sql` 明确记载申请入口暂时只保留四个学位项目，并要求官网一致。因此当前额外选项需要修复；其中 `dip` 也不在开放项目代码中。建议依据权威目录生成静态下拉或读取开放项目，保持官网、正式申请表和后台一致；不要为使旧页面通过而擅自重新开放项目。

证据：[公开目录一致性复测](../../logs/evidence/2026-10-27-audit/retry-program-catalog-consistency.log)。另外，68 门课程迁移与相邻 App 的两个现存 catalog 源均逐行一致，检查在临时目录中执行，未覆盖用户的 `course_seed.sql`。

### P2-08 · 公告晚返回会打断正在下载和咨询的用户

组合测试将公告请求扣住，分别发起资源下载和咨询，再释放公告响应：下载的忙碌与等待状态被提前清除；HEAD 成功后没有触发文件交付；咨询的正常回复也被丢弃。测试中全部请求均为本地合成响应，没有外部 AI 调用。

原因：`renderSiteBoard()` 为刷新公告和班级文字调用 `applyLanguage(currentLang)`；后者同时承担“用户切换语言”的取消行为，递增资源与聊天的世代令牌。语言并未改变，独立请求却被作废。

建议：把文本刷新与用户切换语言的副作用拆开；公告更新只刷新相关区域，不取消下载或聊天。保留真正切语言时阻止旧语言响应的保护，同时增加“公告晚返回 × 下载 / 咨询”组合回归。

证据：[组合测试](../../logs/evidence/2026-10-27-audit/site-board-inflight-race.log)，**4 条前置/正向对照通过、3 条行为失败**。

## 现有远端项目的只读核查

虽然本次没有新建专用测试环境，但从配置与已连接工具发现已有 `amas-staging`。通过 Supabase 插件读取项目健康、迁移账本、部署清单、权限元数据与 advisors；SQL 均在只读事务中运行，未创建账号、读取申请内容或写入业务数据。

- 项目状态 ACTIVE_HEALTHY，PostgreSQL 17.6；最新费用、公告、班级及申请表规则的抽查对象存在，8 个 Edge 入口均为 ACTIVE。
- 迁移账本有 29 条记录，使用 0001–0026 加时间戳合并迁移，不能与本地 43 个文件一一对齐。最新功能对象确实存在，因此不能把账本条数差直接判为“缺了 14 个迁移”；应补齐迁移来源对账和部署追溯。
- 公开表没有发现未启用 RLS 的表。44 个“开启 RLS 无 policy”的提示包含刻意只经 RPC 访问的表，不应直接补宽松 policy。
- 3 个匿名和 69 个登录用户可调用的 SECURITY DEFINER 提示需要按函数逐一审查授权门禁，不能全部等同于越权漏洞；公开公告入口本就需要匿名访问。
- 1 个关联 App 函数 `app_rooms_mark_host_orphaned` 未固定 search_path，且为 SECURITY INVOKER；建议明确固定路径。[官方处理说明](https://supabase.com/docs/guides/database/database-linter?lint=0011_function_search_path_mutable)。
- 泄露密码保护未启用，建议纳入认证配置复核。[官方说明](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection)。
- 性能建议包含 68 个外键索引提示、40 个 RLS initplan 提示、3 个重复 permissive policy 提示及 51 个未使用索引提示。需结合代表性数据量和查询计划排序，不应直接删除暂未使用的索引。[RLS 优化说明](https://supabase.com/docs/guides/database/database-linter?lint=0003_auth_rls_initplan)。

原始证据：[权限与 MFA 元数据](../../logs/evidence/2026-10-27-audit/remote-catalog.json)、[对象抽查](../../logs/evidence/2026-10-27-audit/remote-deployment-shape.json)、[迁移](../../logs/evidence/2026-10-27-audit/remote-migrations.json)、[部署清单](../../logs/evidence/2026-10-27-audit/remote-edge-functions.json)、[安全建议](../../logs/evidence/2026-10-27-audit/remote-security.json)、[性能建议](../../logs/evidence/2026-10-27-audit/remote-performance.json)。

## 身份测试说明

| 身份 | 本轮关键结果 |
|---|---|
| 未登录访客 | 已有官网与提交隔离测试；本地 SQL 验证可投递、不可回读 |
| 申请人 | 申请状态、锁定、补件、内部备注隔离；主数据库验收通过 |
| 学员 | 课程、成绩、学分、个人资料与费用自有数据隔离；SIS 验收通过 |
| 教师 | 任课 / 非任课范围、成绩与出勤写入、撤销后失权；SIS 验收通过 |
| 导师 | 只见所带学员，陪伴记录不可由普通教师或学员读取；SIS 验收通过 |
| 教务 | 排课、编班、录取、学籍与成绩发布；数据库及入口角色断言通过 |
| 财务 | 学业数据隔离通过；完整报名资料可读、MFA 写入绕过、默认入口失败 |
| 内容管理 | 原始报名行不可读；默认入口失败，可操作页面需明确 |
| 教学主管 | 补充入口与角色矩阵通过 |
| 超管 | 角色管理、敏感操作门禁；另发现过期超管仍可创建教师邀请 |
| 无角色 / 已撤销 / 已过期财务 | 补充数据库报名行访问断言均拒绝；不代表所有入口的过期角色都已验证 |

数据库授权测试通过 `SET ROLE authenticated` 执行，非数据库所有者直接读写。浏览器测试使用真实页面与客户端业务代码，但 SDK 返回值合成；HTTP 测试使用真实处理器与 SDK，但 Auth 返回为合成身份。三者均不能替代真实签名 JWT 验收。

## 优化实施顺序

1. **首批：费用与授权修复。** 先收窄财务数据访问、落实数据库 MFA、阻止过期角色邀请；随后实现记账幂等及服务端统计。验收包括正常操作、跨身份越权、角色过期、AAL1、响应丢失和大数据量。
2. **第二批：入口与交互一致性。** 修财务 / 内容管理落地页、招生项目清单及公告打断在途操作；统一请求验证与未知结果提示，处理类型与浏览器兼容性门槛。修复后先跑最小复现，再回归相关身份和业务闭环。
3. **第三批：固定测试环境。** 使用一次性完整 Supabase 测试栈运行迁移，自动生成各角色种子，覆盖真实 JWT、PostgREST、Auth、Storage 和 MFA；提供一条命令启动、测试、清理。环境和数据与生产分开。
4. **第四批：统一自动化入口。** 现 `verify.sh` 主要覆盖语法与两套回归，不能代表全量测试。将快速单元 / 契约、类型检查、数据库权限、浏览器关键旅程分层执行；为关键缺陷保留否定式断言，并生成机器可读结果及失败截图。
5. **第五批：兼容性与运行观测。** 明确支持的浏览器版本及手机设备，补 Safari / Firefox、触摸与弱网实测；记录接口错误、请求 ID、未知写入结果和审计事件，日志避免包含申请表及凭据。

## 尚未验证

- 本次没有可任意清理的新建隔离 staging；已有 `amas-staging` 仅做只读核查，未对真实数据库执行迁移、写入或角色变更。
- 真实登录凭据、签名 JWT 与真实会话撤销；邮件投递、真实 MFA 因子、完整密码找回链接；Storage 上传与外部表单 / 邮件服务实际交付。
- 已读取托管环境迁移账本、8 个入口部署版本并抽查关键 RLS；仍未完成全量 Schema/授权差异比对、全部已部署源码比对及真实 PostgREST 行数上限测试。
- Safari、Firefox、iOS / Android 真机、PWA 安装和离线行为；本次主浏览器为 macOS Chrome。
- 并发负载、容量、长时间稳定性、备份恢复。业务竞态用例不等于压力测试。

## 如何复核

在仓库根目录运行，依赖放仓库外。先保留失败日志，权限与财务问题修复后再运行原复现。

```bash
bash scripts/verify.sh
python3 logs/evidence/2026-10-27-audit/run-local-suite.py
PGLITE_DIR=/tmp/amas-audit-pglite-20261027 node scripts/run-sql-local.mjs \
  supabase/tests/sis0_lifecycle_e2e.sql supabase/tests/sis1_acceptance.sql \
  supabase/tests/sis2_acceptance.sql supabase/tests/sis3_acceptance.sql \
  supabase/tests/portal2b_irreversible_guard.sql
PGLITE_DIR=/tmp/amas-audit-pglite-20261027 node \
  logs/evidence/2026-10-27-audit/run-extended-sql.mjs \
  logs/evidence/2026-10-27-audit/additional-role-matrix.sql
node logs/evidence/2026-10-27-audit/additional-browser-matrix.mjs
```

`run-local-suite.py` 会跳过 `results.json` 中已有的任务（包括失败项），适合续跑；全量重跑可设置 `AMAS_AUDIT_OUT=/tmp/amas-audit-rerun` 使用新的证据目录；每套默认时限为 720 秒，可用 `AMAS_SUITE_TIMEOUT` 调整。依赖版本：Node 24.19.0、Python 3.11.0、PGlite 0.3.7、Deno 2.9.6。旧 SQL 执行器仅移除 psql 的 `\set` / `\echo` 客户端指令，补充 auth 表列、JWT 身份读取与 pgcrypto；业务迁移及断言原文未放宽。

## 17 项未通过的既有检查索引

以下保留原脚本最终状态；审计副本通过不覆盖原脚本失败。

| 检查 | 分组 | 退出码 | 日志 |
|---|---|---|---|
| `test-browser-feature-floor.mjs` | — | 1 | [查看](../../logs/evidence/2026-10-27-audit/full-test-browser-feature-floor.log) |
| `test-chat-timeout.mjs` | — | 1 | [查看](../../logs/evidence/2026-10-27-audit/full-test-chat-timeout.log) |
| `test-course-search.mjs` | — | 1 | [查看](../../logs/evidence/2026-10-27-audit/full-test-course-search.log) |
| `test-discover-back-link.mjs` | — | 1 | [查看](../../logs/evidence/2026-10-27-audit/full-test-discover-back-link.log) |
| `test-giving-help-flow.mjs` | — | 1 | [查看](../../logs/evidence/2026-10-27-audit/full-test-giving-help-flow.log) |
| `test-local-config-override.mjs` | — | 1 | [查看](../../logs/evidence/2026-10-27-audit/full-test-local-config-override.log) |
| `test-pages-touch.mjs` | — | 1 | [查看](../../logs/evidence/2026-10-27-audit/full-test-pages-touch.log) |
| `test-portal-session.mjs` | — | 1 | [查看](../../logs/evidence/2026-10-27-audit/full-test-portal-session.log) |
| `test-resource-delivery.mjs` | — | 1 | [查看](../../logs/evidence/2026-10-27-audit/full-test-resource-delivery.log) |
| `test-resource-wait.mjs` | — | 1 | [查看](../../logs/evidence/2026-10-27-audit/full-test-resource-wait.log) |
| `test-student-todo-loop.mjs` | St,A,G | 1 | [查看](../../logs/evidence/2026-10-27-audit/full-test-student-todo-loop-St-A-G.log) |
| `test-student-todo-loop.mjs` | Sf,A,G | 1 | [查看](../../logs/evidence/2026-10-27-audit/full-test-student-todo-loop-Sf-A-G.log) |
| `test-student-todo-loop.mjs` | Se,A,G | 1 | [查看](../../logs/evidence/2026-10-27-audit/full-test-student-todo-loop-Se-A-G.log) |
| `test-student-todo-loop.mjs` | Sp,A,G | 1 | [查看](../../logs/evidence/2026-10-27-audit/full-test-student-todo-loop-Sp-A-G.log) |
| `test-touch-targets.mjs` | — | 1 | [查看](../../logs/evidence/2026-10-27-audit/full-test-touch-targets.log) |
| `check-browser-feature-floor.mjs` | — | 1 | [查看](../../logs/evidence/2026-10-27-audit/full-check-browser-feature-floor.log) |
| `program_catalog_consistency.mjs` | — | 1 | [查看](../../logs/evidence/2026-10-27-audit/retry-program-catalog-consistency.log) |

完成时间（Asia/Bangkok）：2026-10-27T09:44:26.657284+07:00。汇总：[summary.json](../../logs/evidence/2026-10-27-audit/summary.json)。
