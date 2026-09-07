# ARCHITECTURE & PRE-MERGE REVIEW

**日期**：2026-09-07
**触发**：Supervisor Review — CONDITIONALLY ACCEPTED，正式状态维持 `TESTED LOCALLY / NOT READY`
**执行**：TASK A/B（只读审计）+ TASK C/D（方案，未实施）+ E1/E2/E3（已实施并测试）
**约束遵守**：未部署 production、未执行 destructive migration、未创建付费资源

---

## 1. Current Git State

```
amas-website
  branch        master
  HEAD          088dce70e69d4d53cd66e067b7fe500de69b9204
  上游           origin/master   0/0
  working tree  clean（本轮改动后见 §15）

AMAS-Seminary（本地目录 "AMAS Seminar App"）
  branch        main
  HEAD          95dc954fb0b66ebc6932cf77bd3a731385520772
  上游           origin/main     0/0   ← 本轮已修复丢失的追踪配置（RB-15 关闭）
  working tree  clean（本轮改动后见 §15）

  auth/supabase-unification   4af8307ae711c45389967b1439ab7c539f4be62b
  merge-base(main, auth)      d5f2f8a354c2414fb2be49dd4a7024051e656ad9
                              2026-09-03 "voice: 移除通用逃生口，改为隔离的 build:voice-demo"
```

---

## 2. Auth Branch Reality

### 结论先行

> # AUTH MIGRATION ≠ APPLICATION DATABASE MIGRATION
>
> `auth/supabase-unification` **只做了认证适配，完全没有触碰业务数据库。**
> 从此不再把这两件事合并描述。

### 证据

`merge-base..auth` 共 12 个提交、83 个文件、4469 行新增。但**生产源码改动极小**：

| 文件 | 变化 | 实际内容 |
|---|---|---|
| `backend/src/db.ts` | **7 行** | 仍是 **SQLite `CREATE TABLE` DDL**，只把 `user_id TEXT NOT NULL` 改为可空 + 新增 `author_state` 列（R-10 tombstone） |
| `backend/src/auth/users.ts` | −21 行 | 删除 `promoteToAdmin()` —— 即 `_promote` 提权后门（AUTH-M3） |
| `backend/src/routes/auth.ts` | 28 行 | 认证路由适配 |
| `backend/src/routes/prayer.ts` | 8 行 | 配合 `author_state` |
| `backend/src/auth/supabase.ts` | **新增** | Supabase 身份**适配层** |

其余 4400+ 行是：Android 平台脚手架（50 个文件）、测试（约 1000 行）、文档（6 份）、迁移审计脚本。

**`package.json` / `backend/package.json` 未新增任何 `supabase` / `pg` / `postgres` 依赖。**

### Authentication — 迁到什么程度

`backend/src/auth/supabase.ts` 头部自述：

> 「本模块是**唯一**懂 Supabase 认证细节的地方；上层 `requireAuth` / `requireAdmin`
> 的 `req.principal` 契约保持不变，因此 **16 个路由文件与 18 个前端文件都不需要改动**。」

这句话本身就说明了范围：**这是一层 token 验证适配器，不是数据迁移。**

技术细节（已读代码确认）：
- 验签方式：**本地 JWKS（ES256 非对称）**，后端不持有任何 Supabase secret
- 角色查询：**每次现查、不缓存**，保证角色撤销即时生效
- **不检查 `aal`** —— 普通 student 全程 AAL1 即可学习（符合既定铁律）

`middleware/auth.ts` 在 auth 分支上是**三级 token 接受**：

```
1) APP_SECRET            → service principal
2) Supabase token        → looksLikeSupabaseToken → verifySupabaseAccess
3) Legacy 自签 token      → 仍然接受，由 config.supabase.acceptLegacy 控制
                           代码注释：「AUTH-M7 删除；可用 AUTH_ACCEPT_LEGACY=false 提前演练」
```

| 问题 | 答案 |
|---|---|
| 登录/注册/session/refresh/reset 是否迁到 Supabase Auth？ | **部分**。验证路径支持 Supabase token，但 legacy 自签路径**仍然启用** |
| 哪些 AUTH milestone 真实完成？ | M2/M3（适配层 + 移除 `_promote`）、M5/M6（身份 provision + 1:1 mapping + orphan tombstone，11/11）、M6.5A（凭据恢复 23/23）、M6.5B（Preflight + Mobile 135/135） |
| 哪些仍只是 adapter / compatibility layer？ | **全部**。`supabase.ts` 自我定义为「身份适配层」 |
| 是否仍存在 legacy auth？ | **是。** 双轨接受，移除计划在 AUTH-M7，而 AUTH-M7 `NOT_STARTED` |

⚠ 补充事实：`backend/src/test/supabase-auth.test.ts` 在缺 `AMAS_ENV` 时**整组跳过**。
由于 `staging.env` 不存在，**这些 AUTH 验收在 CI 中从未真正执行过**。

### Database — 是否迁移

| 问题 | 答案 |
|---|---|
| 是否把业务数据从 SQLite 迁往 Supabase Postgres？ | **否。完全没有。** |
| 迁了哪些表？ | **零张** |
| migration 在哪里？ | **不存在**。`backend/` 下无 Postgres 迁移目录 |
| DAL / repository 是否切换？ | **否**。仍是 `better-sqlite3` 的 prepared statements |
| SQLite 是否仍是 source of truth？ | **是**，且是唯一的 |
| 是否存在 dual-write / fallback？ | **否**。不存在双写，因为根本没有第二个存储 |

---

## 3. Main vs Auth Diff

```
仅在 main 的提交    18
仅在 auth 的提交    12
可否 fast-forward   ✗ 双向分叉，必须 merge commit
```

### 冲突文件（`git read-tree` 三方试算，工作区已复位）

```
.gitignore
backend/src/auth/users.ts          ★ 认证层
backend/src/db.ts                  ★ SQLite schema —— 两侧都改了 DDL
backend/src/routes/auth.ts         ★ 认证路由
backend/src/routes/prayer.ts       ★ 业务路由
backend/src/test/smoke.test.ts
backend/src/test/supabase-auth.test.ts
components/VoiceRoom/PrayerRoomPanel.tsx
package.json
package-lock.json
```

10 个文件全部是**两侧都修改过**的，非新增冲突。

### Potential regressions

| 风险 | 说明 |
|---|---|
| **`db.ts` schema 分叉** | main 侧新增了 `room_reading_state`（P1-2 共享阅读位置）等表；auth 侧改了 `prayer_shares.user_id` 可空 + `author_state`。**合并时若丢掉任一侧，对应功能静默损坏且测试可能仍绿** |
| `routes/prayer.ts` | 两侧都改；main 侧是 P1-1/P1-2 的 presence 与阅读位置，auth 侧是 tombstone 语义 |
| `package-lock.json` | 机械冲突，重新 `npm install` 解决即可 |
| 测试基线 | main 侧后端 116（本轮新增护栏 13）、前端 158（本轮新增 CP 20）；auth 侧新增 5 个测试文件。合并后需重取基线 |

### Security impact

- **正向**：auth 分支删除了 `_promote` 提权后门，合并后 main 也会获得该修复
- **需警惕**：合并会引入 legacy token 双轨接受逻辑。`AUTH_ACCEPT_LEGACY` 默认值必须在合并时显式确认，**不得默认放行 legacy**

### Expected Architecture After Merge

| 项 | 合并后的实际状态 |
|---|---|
| Authentication SoT | **双轨**：Supabase token 与 legacy 自签 token 同时被接受 |
| User identity SoT | **仍是 SQLite `users` 表**（`findById(payload.sub)` 查本地库） |
| Application database SoT | **SQLite，未变** |
| SQLite 是否仍存在 | **是，且承载全部业务数据** |
| Supabase Postgres 是否承载业务数据 | **否** |

> **合并 auth 分支不会解决 RB-01。** 它解决的是认证来源，不是数据持久化。

### Verdict

```
NEEDS MANUAL RECONCILIATION
```

不是 `SAFE TO MERGE`：10 个文件冲突，其中 `db.ts` 是两侧各自演进的 schema DDL，
自动合并有静默丢功能的风险。也不是 `BLOCKED`：冲突可控，无不可调和的架构矛盾。

**前置条件**：合并前必须先取得双方的完整测试基线，合并后跑全量回归（R-9 合并窗口）。

---

## 4. Authentication Architecture

**当前（main）**：App 后端自签 JWT（HS256，密钥来自 `JWT_SECRET`/`APP_SECRET`/ephemeral），
用户表在 SQLite。官网 Portal 用 Supabase Auth，但线上未接通。

**合并 auth 分支后**：App 后端可验证 Supabase 签发的 token（ES256 / JWKS），
同时保留 legacy 自签路径直到 AUTH-M7。

**目标态**：Supabase Auth 单一来源，legacy 路径删除（AUTH-M7）。

---

## 5. Database Architecture

**当前与合并后均为**：

```
App 业务数据    → better-sqlite3 单文件 backend/data/amas.sqlite
Portal 业务数据 → Supabase Postgres（22 migrations，仅 staging）
```

两套数据库并存，**没有任何数据流打通**。这是当前架构最大的结构性问题。

---

## 6. Whether SQLite Migration Already Exists

```
不存在。零张表、零个 migration、零行 DAL 改动、零个 Postgres 依赖。
```

---

## 7. Merge Safety

见 §3：`NEEDS MANUAL RECONCILIATION`。

---

## 8. SQLite → Postgres Migration Plan

> 本节是**方案**，未实施。按 Supervisor 要求，先出计划不动手。

### Current State

```
存储        better-sqlite3（同步 API，进程内，单写者）
位置        backend/data/amas.sqlite（DB_PATH 未设时）
schema      定义在 backend/src/db.ts 的 CREATE TABLE 语句中
迁移机制    ⚠ 无版本化迁移。schema 靠 CREATE TABLE IF NOT EXISTS 累积
DAL         prepared statements（stmtXxx.run/get/all），散落在各 route 与 auth 模块
事务假设    better-sqlite3 同步 + 单进程。代码可能隐含"无并发写"的假设
```

### Target State

```
存储        Supabase Postgres（与 Portal 同实例，或独立 project）
schema      版本化 SQL migrations，沿用 amas-website/supabase/migrations 的编号体系
授权边界    RLS + SECURITY DEFINER RPC + Edge 入口校验（R-2 三层）
身份        auth.users.id 作为唯一 Person Identity
```

### Migration Strategy（八步，逐步可回退）

| # | 步骤 | 要点 |
|---|---|---|
| 1 | **Schema migration** | 先从 `db.ts` 的 DDL 反向导出完整 schema，逐表翻译为 Postgres（类型、约束、索引、外键）。**此时不动代码** |
| 2 | **Data migration** | 写一次性导出/导入脚本。**必须先在 SQLite 副本上演练**，产出行数对账表 |
| 3 | **DAL migration** | 引入 repository 接口层，先让 SQLite 实现满足它（行为不变、测试全绿），**再**加 Postgres 实现。这一步是整个计划的关键：先解耦，后替换 |
| 4 | **Environment switch** | `DB_DRIVER=sqlite\|postgres` 环境变量切换，两套实现并存一段时间 |
| 5 | **Test migration** | 现有 116 个后端测试必须在 Postgres 实现下同样全绿，**不得删减或放宽** |
| 6 | **Staging migration** | 在 staging 跑完整迁移 + 全量回归 + E2E 矩阵 |
| 7 | **Production migration** | 停写窗口 → 导出 → 导入 → 对账 → 切换 → 冒烟 |
| 8 | **Rollback** | 保留 SQLite 实现与最后一份快照，切换开关即可回退。**Postgres 侧不做破坏性删除** |

### Compatibility — ID 保持（关键）

**不得因认证迁移而改变业务实体 ID，除非有显式 mapping 表。**

| 实体 | 当前 ID 来源 | 迁移策略 |
|---|---|---|
| user | SQLite `users.id` | 与 `auth.users.id` 建立 **1:1 mapping 表**（AUTH-M5/M6 已有 dry-run 工具与 11/11 验收，可复用） |
| applicant / student / teacher | Portal 侧已在 Supabase | App 侧无对应实体，**无冲突** |
| course | 两侧各有目录 | 以 `program_catalog` / `course_catalog` 为权威，App 侧对齐 code |
| Christian Profile | App 本地 store | 随 user id mapping 迁移，**scoring 结果不得重算**（会造成用户可见的无解释变化） |
| assignments / attendance / grades | **均未实现** | 无数据可迁 |
| practice evidence | `evidence.ts`，当前调用方未接入 | 无数据可迁 |

⚠ **CP 档案是最敏感的一项**：已有用户的倾向结果在迁移后必须逐字节一致。
本轮建立的 golden fixture（§11）正是为此提供的护栏。

---

## 9. Deployment Architecture Proposal

> 要求：最小、稳定、低运维成本。不引入 K8s / 微服务。

### 方案甲 —— 单托管平台 + Supabase（推荐）

```
官网              GitHub Pages（不变，已在用）
App 前端          静态托管（Cloudflare Pages 或 Netlify，免费档足够）
后端 API          单一容器平台（Fly.io / Railway / Render 任一），1 实例起步
Supabase          Auth + Postgres + Storage（若需要）
域名              app.<domain> → App 前端
                  api.<domain> → 后端
                  www.<domain> → 官网
环境隔离          三套：dev(本机) / staging(独立 Supabase project + 独立后端实例) / production
日志              平台内置 stdout 收集 + 保留 7–30 天
健康检查          后端加 GET /healthz（返回 200 + 版本 + DB 连通性）
```

**优点**：一个后端进程、一个托管平台账单、Supabase 承担 Auth/DB/备份。
**代价**：需要选定并注册一个容器平台（**属付费资源，需你批准**）。

### 方案乙 —— 全 Supabase，后端改为 Edge Functions

```
后端逻辑迁入 Supabase Edge Functions，取消独立后端进程
```

**优点**：无额外托管账单，与 Portal 侧架构完全一致，运维面最小。
**代价**：Express 路由需大幅重写；WebSocket / 实时事件轮询器（`startEventPoller`）
在 Edge Functions 下没有直接等价物，**祷告室 presence 与共享阅读位置需要重新设计**。
这违反「不为了部署重新设计整个架构」的约束。

### 推荐

**方案甲。** 理由：改动面最小，保留现有 Express 代码与全部 116 个后端测试；
Supabase 只承担它已经在承担的职责（Auth + Postgres）；
运维复杂度仅增加「一个容器实例 + 一个健康检查端点」。

方案乙看似更省，但会迫使 presence / realtime 重写 —— 那是当前唯一真正跑通的
功能闭环（P1-1/P1-2，98 项 E2E 断言），不值得为部署便利去动它。

---

## 10. RB-06 Guardrail Result — ✅ 已实施

新增 `backend/src/startupGuard.ts` + 接入 `server.ts`（**在建 app 之前**，
配置不合格的生产实例不会开出监听端口）。

**生产模式下缺以下任一项即 `process.exit(1)`**：

| 变量 | 判定 |
|---|---|
| `JWT_SECRET` | 未设 或 < 32 字符 |
| `DB_PATH` | 未设 或 `:memory:` |
| `CORS_ORIGINS` | 未设 或 含 localhost / 127.0.0.1 / 0.0.0.0 / [::1] |

**明确不做**：不自动生成生产密钥、不静默回落 dev 默认值、不修改传入的 env
（有专门测试断言「护栏必须是只读检查」）。

**测试**：`backend/src/test/startup-guard.test.ts` —— **13/13 PASS**

```
production + 缺配置        → 拒绝启动、退出码 1、逐项列出原因
production + 配置齐备      → 放行，零输出
development / test / 未设  → 一律放行，开发流程零影响
多项缺失                  → 一次报全（"共 3 项"），不是报一条就退
```

并把该测试加入 `npm test`（原脚本只跑 smoke，新测试不会进 CI = 摆设）。
**后端基线 103 → 116，全绿。**

---

## 11. Christian Profile Regression Result — ✅ 已实施

**发现**：`services/christianProfile/scoring.ts`（474 行，产品核心）**此前零测试覆盖**。
仓库内不存在任何 CP fixture 或 golden 文件，无可复用者。

新增 `tests/services/christianProfileScoring.test.ts` —— **20/20 PASS，3 个 snapshot 固化**。

### 实测确认的结构常量

```
ITEM_BANK          84 题 = faith_foundation 12 + discipleship 12
                          + ministry_orientation 36 + scenario 12 + readiness 12
quick 标记          30 题，且 30/30 全部属于 C/D
ORIENTATION_KEYS   12 项，顺序 teacher…servant 与规范完全一致
SCORING_VERSION    provisional_v1   ITEM_VERSION 1   LANGUAGE_VERSION zh-CN
```

**与《CHRISTIAN_PROFILE_SPEC》记载的 30/84 完全吻合，无漂移。**

### 已钉死的铁律边界（这是本项最大价值）

用「加进去 → 断言 12 项倾向分数一字不变」验证，**全部通过**：

| 加入什么 | 倾向向量 |
|---|---|
| 信仰基础（A）作答 | 不变 ✅ |
| 门徒生命 / 灵修实践（B）作答 | 不变 ✅ |
| 事奉准备度 / 经验（E）作答 | 不变 ✅ |
| A+B+E 全加 | 不变 ✅ |
| 外部证据（**课程完成 / 实践证据 / 导师反馈**） | 不变 ✅ |

即：**课程进度不污染倾向、实践证据独立、导师反馈独立** —— 三项均获代码级证明。

其余覆盖：确定性（两次评分逐字节一致）、作答顺序无关、无「总分/综合分」字段、
Top 3 恰好 3 项且降序、倾向指数落在 0–100、quick 不产出 A/B/E 三层。

### 过程中的一次自我纠错

首跑 2 条边界测试失败。排查后确认是**测试构造错误**（用了过滤后数组的下标，
导致同一题在两个集合里选了不同选项），**不是算法问题**。
按约束「不得修改算法来让测试通过」，修正的是测试，改用 `ITEM_BANK` 全库位置。
该坑已写入文件注释。

---

## 12. E2E Preparation Result — ✅ 已实施

新增 `supabase/tests/e2e_acceptance_matrix.mjs`，**63 条用例**已骨架化。

```
PASS             0
FAIL             0
BLOCKED_BY_ENV   53
NOT_IMPLEMENTED  10
TOTAL            63
退出码            2（区别于真实失败的 1）
```

**零 fake pass。** 缺环境报 `BLOCKED_BY_ENV` 并计入 blocked；
产品未实现报 `NOT_IMPLEMENTED`（10 条：学习进度/作业/出勤/成绩/实践训练/成长路径/
教师被分配课程/授权学员/成绩录入/班级管理）。

分组：A public 8 · B applicant 10 · C student 12 · D teacher 11 · E admin 8 ·
**N authorization negative 14**（STEP 5 全部否定式用例已逐条落位）。

staging 就绪后注入 `STAGING_BASE_URL` / `SUPABASE_URL` / `SUPABASE_ANON_KEY` /
`TEST_USER` / `TEST_TEACHER` / `TEST_ADMIN` 即可开跑。
文件末尾附一次性 fixture 的 CLEANUP 说明（禁止对真实账号执行写操作）。

---

## 13. Updated Blocker Severity

按 Supervisor 要求校准：**P0 保留给 security compromise / data loss / destructive
corruption / production down / critical auth bypass**；
「上线必备但尚未配置」降为 P1 Release Blocker。

| ID | Issue | 原 | 新 | 校准理由 |
|---|---|---|---|---|
| RB-01 | App 后端本地 SQLite，无持久化/备份/回滚 | P0 | **P0（维持）** | 真实 data loss 风险：容器/实例重建即丢全部数据，且无备份可恢复。符合 P0 定义 |
| RB-02 | App 前后端无部署目标 | P0 | **P1** | 是 Release Blocker，不是安全或数据事故。当前无人在用，不构成 production down |
| RB-03 | Production Supabase 不存在 | P0 | **P1** | 同上：上线必备的配置缺失，非安全/数据风险 |
| RB-04 | SMTP 未配置 / `mailer_autoconfirm=true` | P0 | **P1** | 同上。⚠ 但若在**已开放用户**的环境保持 autoconfirm，则升回 P0（可绕过邮箱验证注册） |
| RB-05 | `JWT_SECRET` 未设 → ephemeral 密钥 | P1 | **P1（维持）** | 重启即全员登出属可用性问题；本轮 RB-06 护栏已使其在生产模式下**无法启动**，风险已被拦截 |
| RB-06 | 无生产启动护栏 | P1 | **CLOSED** | 本轮已实施并测试（§10） |
| RB-07 | localhost 依赖 | P1 | **P1（维持）** | 已被 RB-06 护栏在生产模式下拦截 |
| RB-08 | 线上 Portal `SUPA` 空配置 | P1 | **P2** | 当前是**有意的降级形态**：未接库 = 无人可访问 = 无风险面。属待配置项 |
| RB-09 | `PRODUCTION_DOMAIN` 未定 | P1 | **P1（维持）** | 阻断 Auth 回调收敛 |
| RB-10 | STEP 5 否定式测试一项未跑 | P1 | **P1（维持）** | 未验证的授权边界是真实未知风险，不能降级 |
| RB-11 | auth 分支未合入 main | P1 | **P2** | §2 已证明它不解决 RB-01；合并可延后，不阻断 staging |
| RB-12 | LiveKit 未配置 | P1 | **P2** | 语音是可选功能域，缺失不影响其余流程上线 |
| RB-13 | 无备份/回滚/监控 | P1 | **P1（维持）** | 与 RB-01 耦合；无备份即无法从数据事故恢复 |
| RB-14 | `0022` 未执行 | P2 | **P2（维持）** | 线上 Portal 未接库，零影响 |
| RB-15 | App 未推送 + 丢失上游追踪 | P2 | **CLOSED** | 本轮已推送并 `-u` 恢复追踪 |
| **RB-21** | **CP 核心算法零测试覆盖** | — | **CLOSED** | 本轮建立 20 条回归 + 3 个 golden fixture（§11） |
| **RB-22** | **AUTH 验收测试在 CI 中从未执行** | — | **P2（新增）** | `supabase-auth.test.ts` 等在缺 `AMAS_ENV` 时整组跳过；CI 从未真正跑过这些 AUTH 断言 |

**校准后：P0 仅剩 1 项（RB-01），P1 6 项，P2 6 项，本轮关闭 3 项。**

---

## 14. Documentation Updates

见 §15 提交清单。同步内容：

- `project-memory/CURRENT_STATE.md` — 测试基线、HEAD、阶段口径
- `project-memory/OPEN_ISSUES.md` — 新增 CP 覆盖缺口关闭、AUTH CI 跳过（RB-22）
- `project-memory/DEVELOPMENT_ROADMAP.md` — 标注阶段切换，功能开发暂停
- `project-memory/DECISION_LOG.md` — **新建**，记录本次正式架构决策
- `AMAS_PROJECT_HANDOFF.md` — 指向本报告

### 本次正式决策（记入 DECISION_LOG）

> **D-11｜SQLite 不作为 AMAS App 最终 Production 架构**
> 最终方向继续采用 Supabase-based authentication + managed persistent database。
> SQLite 可继续用于 local development / isolated test / temporary compatibility，
> 但不得成为正式 Production 架构的终点。
>
> **附带认定**：`auth/supabase-unification` 分支**未**完成业务数据库迁移，
> 二者不等价，此后分开描述与排期。

---

## 15. Commits Created

见提交记录。本轮产出：

| 仓库 | 文件 | 性质 |
|---|---|---|
| AMAS-Seminary | `backend/src/startupGuard.ts` | 新增（E1） |
| AMAS-Seminary | `backend/src/server.ts` | 接入护栏（3 行） |
| AMAS-Seminary | `backend/src/test/startup-guard.test.ts` | 新增 13 测试 |
| AMAS-Seminary | `backend/package.json` | 把护栏测试纳入 `npm test` |
| AMAS-Seminary | `tests/services/christianProfileScoring.test.ts` | 新增 20 测试（E2） |
| AMAS-Seminary | `tests/services/__snapshots__/…snap` | 3 个 golden fixture |
| AMAS-Seminary | `docs/project-memory/*` | 记忆校准 |
| amas-website | `supabase/tests/e2e_acceptance_matrix.mjs` | 新增 63 条骨架（E3） |
| amas-website | `docs/operations/ARCHITECTURE-PREMERGE-REVIEW.md` | 本报告 |

**未修改任何产品业务逻辑，未改动 CP 算法，未改动课程/实践/12 倾向口径。**

---

## 16. Recommended Next Action

**唯一推荐：拍板 §9 的部署方案（推荐甲），并同步确定 §8 迁移计划是否立项。**

理由：RB-01 是校准后**唯一的 P0**，它同时是 RB-13（备份/回滚）的前置。
而 §2 已经证明「合并 auth 分支」**不能**解决它 —— 这是本轮最重要的发现，
它推翻了「先合并 auth 分支就能推进架构」的假设。

**需要你决定 / 提供的（Stop Conditions 触发）**：

1. **付费云资源**：方案甲需要一个容器托管平台账号 —— 未经批准不创建
2. **Production Supabase project** —— 未经批准不创建
3. **`PRODUCTION_DOMAIN`** 与 DNS —— 我不碰 DNS
4. **SMTP 服务商与发信域**
5. §8 迁移计划是否立项、按什么优先级排

**不需要授权、可继续推进的**：
`db.ts` schema 完整反向导出（迁移计划第 1 步的前置，纯只读产出）、
repository 接口层解耦（第 3 步前半段，行为不变、测试保持全绿）、
`/healthz` 健康检查端点、E2E 矩阵各用例的实跑逻辑补齐。

---

# 状态

```
NOT READY
```

维持 `TESTED LOCALLY`。未提升至 INTEGRATION VERIFIED —— 现有测试仍全部在
本机进程内运行，未跨真实 HTTP 边界、未连托管数据库、E2E 可执行用例数仍为 0。
