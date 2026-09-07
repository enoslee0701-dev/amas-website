# DB-3.5 POSTGRESQL 17.6 COMPATIBILITY REPORT

**RB-01 · PHASE DB-3.5 —— 目标版本兼容性闸门**
日期：2026-09-07 · 执行：Claude · 触发：Supervisor 裁定「理论兼容 ≠ 执行验证」

> **最终状态：`DB-3 LOCALLY VERIFIED / READY FOR DB-4 REVIEW`**
> **`DBR-22 CLOSED`** —— 八项闭合条件全部满足，逐项证据见 §10。

---

## 1. Starting Commit

| 项 | 值 |
|---|---|
| website | `2e63ae6` DB-3 POSTGRESQL SCHEMA IMPLEMENTATION：LOCALLY VERIFIED / READY FOR DB-4 |
| App | `3852384` docs: DB-3 决策 D-27~D-32 + DBR-20~DBR-24 |
| 被验证的 migration | `0001` ～ `0026`（26 个，其中 `0023`～`0026` 为 DB-3 产出） |
| 被验证的测试 | `supabase/tests/db3_schema_contract.sql`（起始 52 条断言） |
| 冻结世系 | `release/post-legacy-gate@e35923b` —— 本轮**未** merge / rebase / cherry-pick / 修改 |

**唯一 active implementation task = DB-3.5**（遵守 D-16）。

---

## 2. PG17.6 Environment Proof

### 环境选择过程（按 Supervisor 给定的优先顺序）

| 优先级 | 方案 | 结论 |
|---|---|---|
| 1 | 复用项目已有本地 Supabase 环境 | **不可用** —— `supabase/config.toml` 存在且声明 `major_version = 17`，但 `supabase start` 需要 Docker，本机**未安装 Docker** |
| 2 | 隔离的 PostgreSQL 17.6 container | **不可用** —— 同上，无容器运行时 |
| 3 | **可证明版本的临时本地实例** | ✅ **采用** —— EDB 官方免安装二进制包 `postgresql-17.6-1-windows-x64-binaries.zip`，独立 data 目录 + 独立端口 |

> 已装的 scoop `postgresql` bucket 只提供 18.6，无 17.x 可选，故必须另取二进制。

### 版本证据

```
$ psql -h 127.0.0.1 -p 5433 -U postgres -d postgres -tAc "select version()"
PostgreSQL 17.6 on x86_64-windows, compiled by msvc-19.44.35213, 64-bit

$ ... -tAc "show server_version"
17.6

$ ... -tAc "show server_version_num"
170006
```

### 环境隔离

| 项 | DB-3（旧） | **DB-3.5（本轮）** |
|---|---|---|
| 版本 | 18.6 | **17.6** |
| 端口 | 5432 | **5433** |
| data 目录 | `scoop/apps/postgresql/current/data` | `scratchpad/pg176data`（全新 `initdb`） |
| 客户端 | psql 18.6 | **psql 17.6**（与服务端同版本） |
| 验证库 | `amas_db3_verify` / `amas_baseline` | `amas_pg176` / `amas_pg176_baseline` |

两个集群同时运行、互不影响，因此本报告的每一项都能在 17.6 与 18.6 上分别复现对照。

### 平台垫片（与 DB-3 相同，未放宽）

`scratchpad/shim.sql` 复刻 Supabase 在 migration 运行前已存在的对象：
`anon` / `authenticated` / `service_role` / `supabase_auth_admin` 角色、`auth` schema、
`auth.users`、`auth.uid()` / `auth.role()` / `auth.jwt()`、`pgcrypto`。
**它不是 Supabase**（见 §9）。

---

## 3. Migration Replay 0001–0026

从 `initdb` 出来的**全新空库**开始，顺序执行，**无任何手工跳过**。

| # | migration | status | ms | error |
|---|---|---|---|---|
| 1 | `0001_init.sql` | APPLIED | 106 | — |
| 2 | `0002_identity.sql` | APPLIED | 125 | — |
| 3 | `0003_hardening.sql` | APPLIED | 209 | — |
| 4 | `0004_teacher_verification.sql` | APPLIED | 132 | — |
| 5 | `0005_ratelimit_fix.sql` | APPLIED | 100 | — |
| 6 | `0006_trigger_isolation.sql` | APPLIED | 101 | — |
| 7 | `0007_actor_fk_policy.sql` | APPLIED | 119 | — |
| 8 | `0008_applications.sql` | APPLIED | 127 | — |
| 9 | `0009_application_rpc_context.sql` | APPLIED | 190 | — |
| 10 | `0010_program_catalog.sql` | APPLIED | 209 | — |
| 11 | `0011_requirement_field_unlock.sql` | APPLIED | 94 | — |
| 12 | `0012_student_core.sql` | APPLIED | 139 | — |
| 13 | `0013_rpc_context_single_use.sql` | APPLIED | 92 | — |
| 14 | `0014_history_guard_fk_safe.sql` | APPLIED | 113 | — |
| 15 | `0015_student_number_states.sql` | APPLIED | 140 | — |
| 16 | `0016_course_catalog.sql` | APPLIED | 214 | — |
| 17 | `0017_student_experience.sql` | APPLIED | 113 | — |
| 18 | `0018_irreversible_record_registry.sql` | APPLIED | 88 | — |
| 19 | `0019_student_role_gating.sql` | APPLIED | 120 | — |
| 20 | `0020_recovery_finalization.sql` | APPLIED | 121 | — |
| 21 | `0021_recovery_flow_liveness.sql` | APPLIED | 113 | — |
| 22 | `0022_program_offering_scope.sql` | APPLIED | 191 | — |
| 23 | **`0023_app_foundation.sql`** | **APPLIED** | 126 | — |
| 24 | **`0024_app_learning.sql`** | **APPLIED** | 128 | — |
| 25 | **`0025_app_rooms_prayer.sql`** | **APPLIED** | 156 | — |
| 26 | **`0026_app_community.sql`** | **APPLIED** | 145 | — |

```
26 / 26 applied     FAILED 0     SKIPPED 0     总耗时 ~3.5s
```

`0022` 内含 `raise exception` 形式的自校验断言（开放申请项目必须恰为 `bth/gdip/mdiv/dmin`），在 17.6 上同样通过。

**没有任何依赖 PostgreSQL 18 行为的 SQL 在应用阶段暴露出来。**（唯一的版本差异出现在错误码层面，见 §8。）

---

## 4. 52 Contract Test Results

### 首次执行（未改测试）

```
PASS 48   →   在第 49 条中止
ERROR: update or delete on table "course_catalog" violates foreign key constraint
       "app_course_progress_course_code_fkey" on table "app_course_progress"
```

**这是本阶段唯一的失败，且它是测试的缺陷，不是 schema 的缺陷。** 根因见 §8。

### 修正后（两个版本各跑一次，同一份测试文件）

| 环境 | PASS | FAIL | SKIP | exit |
|---|---|---|---|---|
| **PostgreSQL 17.6**（目标） | **53** | **0** | **0** | 0 |
| PostgreSQL 18.6（对照） | **53** | **0** | **0** | 0 |

### 关于 52 → 53

Supervisor 要求 `PASS 52 / FAIL 0 / SKIP 0`，实际是 **53**。说明：

- **原有 52 条断言一条未删、一条未放宽**，全部仍在且全部通过。
- 第 53 条是本轮**新增**的：被 RESTRICT 拦下的父行**必须仍然存在**。
  原测试只断言「抛了异常」，新测试还断言「数据确实没被删」——**比原来更严**。
- 唯一被改写的是异常捕获条件（从写死 PG18 的 `restrict_violation` 改为同时接受两个版本的条件），
  并把实际 SQLSTATE 输出到 NOTICE 供 DB-12 参考。**断言的行为没有变。**

### 覆盖确认（Supervisor 点名的项目，均在 17.6 上通过）

| 要求覆盖项 | 对应断言 | 17.6 |
|---|---|---|
| FK behavior | `身份唯一性: 全部身份 FK 都指向 profiles(id)`（穷举 34 个） | ✅ |
| CASCADE | `CASCADE: room membership / 代祷计数 / 成长档案 随人删除` ×3 | ✅ |
| SET NULL | `R-10: 祷告分享 / 动态 内容保留、作者置空` | ✅ |
| tombstone | `author_state 自动变为 deleted_account`、`作者快照仍在` | ✅ |
| room host three-state model | 哨兵 6 条 + `app_rooms 不存在违反 host_shape 的行` | ✅ |
| invalid owner rejection | `指向不存在 profile 的 host 被 FK 拒绝`、`字符串 'system' 无法进入 uuid 身份列` | ✅ |
| course references | `学习进度直接 FK 到 canonical course_catalog`、`未创建第二套课程目录`、RESTRICT 2 条 | ✅ |
| Christian Profile JSONB | `类型 #2: JSON blob 存为 jsonb`、`CASCADE: 成长档案随人删除` | ✅ |
| prayer idempotency schema | 幂等 3 条（含 `ON CONFLICT` 谓词陷阱） | ✅ |
| indexes / constraints | 部分唯一索引 2 条 · DEFERRABLE 2 条 · 单场 active 会话 · 生命周期形态 | ✅ |
| identity constraints | crosswalk 3 条 · admin manifest 2 条 · row manifest 1 条 | ✅ |

---

## 5. Portal Regression Results

在 17.6 上另建 `amas_pg176_baseline`（只跑 `0001..0022`）作对照。

### 计数对比

| 对象 | 0022 基线 | DB-3 之后 | |
|---|---|---|---|
| Portal 表（非 `app_`） | 26 | 26 | ✔ |
| RLS policy | 33 | 33 | ✔ |
| Portal enum | 15 | 15 | ✔ |
| Portal 函数 | 95 | 95 | ✔ |
| Portal 触发器 | 21 | 21 | ✔ |
| Portal 外键 | 38 | 38 | ✔ |
| 启用 RLS 的 Portal 表 | 26 | 26 | ✔ |
| `course_catalog` 行数 | 67 | 67 | ✔ |
| `program_catalog` 开放申请 | 4 | 4 | ✔ |
| **Portal 列数** | **245** | **250** | **需解释 ↓** |

### 逐名对比（不是只看计数）

```
Portal 表   : 逐名完全一致（零增删）
RLS policy  : 逐名完全一致（零增删）
public 函数 : +1  app_rooms_mark_host_orphaned
```

### 差异解释（两处，均为 DB-3 已声明的产出，非回归）

**① Portal 列数 +5** —— 逐列 diff 输出：

```
> course_catalog.created_at            :: timestamp with time zone
> course_catalog.created_by_provenance :: text
> course_catalog.thumbnail_image_id    :: uuid
> course_catalog.thumbnail_path        :: text
> profiles.bio                         :: text

新增列数: 5    删除列数: 0
```

这**恰好**是 DB-3 §2 声明的 EXTEND EXISTING 集合（`profiles` +1、`course_catalog` +4），一列不多、一列不少。

更强的证据 —— 对既有列的 `(类型, 可空性, 默认值)` 三元组做 diff：

```
被修改或删除的既有列: 0
```

**② public 函数 +1 `app_rooms_mark_host_orphaned`** —— D-31 的触发器函数。
它只挂在 `public.app_rooms` 上（`BEFORE UPDATE`），不触及任何 Portal 表。
Portal 触发器数 21 = 21 已证明这一点。

**结论：existing Portal objects preserved。** 既有对象零删除、零修改；新增部分全部在 DB-3 的声明范围内。

---

## 6. Rollback Results

在 17.6 上执行 `supabase/tests/db3_rollback.sql`：

| 对象 | 0022 基线 | 回退后 | |
|---|---|---|---|
| public 表数 | 26 | 26 | ✔ |
| **public 列数** | **245** | **245** | ✔ |
| RLS policy | 33 | 33 | ✔ |
| enum 类型 | 15 | 15 | ✔ |
| public 函数 | 95 | 95 | ✔ |
| 触发器 | 21 | 21 | ✔ |
| 外键 | 38 | 38 | ✔ |
| `migration` schema | 0 | 0 | ✔ |

**逐列名对比：完全一致，零残留。**

列数从 250 回到 245，证明 5 个扩展列被完整摘除；函数从 96 回到 95，证明触发器函数一并清除。

> **`DB-3 的 rollback 不只是 PG18 能用` —— 已证明。**

---

## 7. Forward Replay Results

紧接回退之后，在同一个库上重新前滚：

```
OK 0023_app_foundation.sql
OK 0024_app_learning.sql
OK 0025_app_rooms_prayer.sql
OK 0026_app_community.sql

契约测试：PASS=53  ERROR=0  exit=0
```

`回退 → 前滚 → 53/53` 在 17.6 上闭合。

---

## 8. PG17 Compatibility Findings

### 唯一的真实版本差异：`ON DELETE RESTRICT` 的 SQLSTATE

独立探针（同一段 SQL 在两个集群上跑）：

```sql
create table t_parent (code text primary key);
create table t_child_restrict  (code text references t_parent(code) on delete restrict);
create table t_child_noaction  (code text references t_parent(code) on delete no action);
-- 各插一行子记录后尝试删父行，捕获 returned_sqlstate
```

| | **PostgreSQL 17.6**（目标） | PostgreSQL 18.6 |
|---|---|---|
| `ON DELETE RESTRICT` 违反 | `23503` `foreign_key_violation` | `23001` `restrict_violation` |
| `ON DELETE NO ACTION` 违反 | `23503` `foreign_key_violation` | `23503` `foreign_key_violation` |

`restrict_violation`（23001）是 **PostgreSQL 18 才引入**的独立条件。
**在 17.6 上，RESTRICT 与 NO ACTION 无法靠 SQLSTATE 区分**，只能看约束名。

### 影响评估

| 层面 | 影响 |
|---|---|
| **schema 行为** | **无差异** —— 两版都正确阻止了删除，父行都存活 |
| **migrations** | **无需修改**（已按 Supervisor 要求，不为版本号做无谓改动） |
| **契约测试** | 需修改 —— 它写死了 PG18 的条件名 |
| **DB-12 DAL** | **有实质影响** —— 见下 |

### 对 DB-12 的硬性要求（更正 DB-3 的 DBR-24）

DB-3 报告写的是「`RESTRICT` 抛 `restrict_violation`(23001) 而非 `foreign_key_violation`(23503)」。
**那句话在目标版本上是错的，方向正好反了。** 正确表述：

- DAL **必须**捕 `23503`；**不得**依赖 `23001`（它在 17.6 上永不出现）。
- 若代码需要区分 RESTRICT 与 NO ACTION，**必须看约束名**，不能看 SQLSTATE。
- 若将来 Supabase 升级到 PG 18，`23001` 会开始出现 —— 因此正确写法是**同时接受两者**。

DB-3 报告已就地标注 `【DB-3.5 更正】`，**原文保留**（不静默覆盖历史记录）。
`OPEN_ISSUES.md#DBR-24` 已更正。

### 静态复核（TASK 6，执行已覆盖，此处为补充清点）

`0023`～`0026` 用到的构造，逐项确认 17.6 支持且已被实跑覆盖：

| 构造 | 出现 | 最低版本 | 17.6 |
|---|---|---|---|
| `generated always as ... stored` | 6 | PG 12 | ✔ |
| ` 其中 `generated always as identity` | 2 | PG 10 | ✔ |
| `deferrable initially deferred` FK | 1 | PG 7.4 | ✔ |
| `create type ... as enum` | 9 | PG 8.3 | ✔ |
| 部分唯一索引（`where` 谓词） | 5 | PG 7.2 | ✔ |
| `jsonb` 列 | 8 | PG 9.4 | ✔ |
| 数组包含 `<@` / `text[]` 列 | 1 / 3 | PG 7.4 | ✔ |
| `check` 约束 | 22 | — | ✔ |
| `on delete set null` / `restrict` | 24 / 3 | — | ✔ |
| `create schema` | 1 | — | ✔ |
| `do $$ ... exception when duplicate_object` | 12 | — | ✔ |
| `comment on` | 46 | — | ✔ |

**PG18 专属特性用量清点（确认零依赖）**：

```
uuidv7() / uuidv4()          0 次
VIRTUAL 生成列                0 次
temporal / WITHOUT OVERLAPS   0 次
RETURNING OLD / NEW           0 次
NOT ENFORCED 约束             0 次
```

**事务性 DDL**：所有 migration 与回退脚本均在事务中执行且可回滚（回退脚本显式 `begin/commit`），
17.6 与 18.6 行为一致，未依赖任何版本特定的 DDL 事务语义。

---

## 9. Supabase-specific Unverified Boundaries

**即使 PostgreSQL 17.6 全绿，也不写 `SUPABASE VERIFIED`。**

以下继续标 **`ENVIRONMENT-UNVERIFIED`**，直到真实 staging Supabase：

| 项 | 为什么普通 PG 17.6 证明不了 |
|---|---|
| Supabase Auth integration | `auth.users` 与 `auth.uid()` 在本轮是垫片里的本地表与本地函数，不是 GoTrue |
| Supabase API exposure | PostgREST 未参与；表是否被 API 暴露、暴露成什么形状，未验证 |
| runtime RLS behavior | 本轮无 JWT、无 `request.jwt.claims` 真实注入；DB-3 刻意未建放行 policy，Portal 既有 33 条 policy 只做了存在性回归，**未做否定式运行时测试** |
| SECURITY DEFINER 执行上下文 | Portal 有 80 个 SECURITY DEFINER 函数，其 `search_path` 与属主在托管环境下的实际行为未验证 |
| hosted extensions / configuration | 托管侧的扩展集合、`pgsodium` / `pg_net` / `pg_cron` 等、以及参数配置未比对 |
| real service-role behavior | `service_role` 在本轮只是一个 `bypassrls` 本地角色，非 Supabase 签发的真实身份 |
| storage / realtime | `storage` schema、realtime publication 未纳入 |

**本轮的 `LOCALLY VERIFIED` 只覆盖 DDL 与数据库层约束行为，不覆盖以上任何一项。**

---

## 10. DBR-22 Status

> ## `DBR-22 — CLOSED`

Supervisor 给定的八项闭合条件，逐项对照：

| # | 条件 | 结果 | 证据 |
|---|---|---|---|
| 1 | PostgreSQL version = 17.6 | ✅ | §2 `server_version = 17.6`、`server_version_num = 170006` |
| 2 | 26/26 migrations PASS | ✅ | §3 全表，FAILED 0 / SKIPPED 0 |
| 3 | 52/52 contract PASS | ✅ | §4 —— 原 52 条全过，另新增 1 条更严断言，实为 **53/53**，FAIL 0 / SKIP 0 |
| 4 | rollback PASS | ✅ | §6 逐列与基线零差异 |
| 5 | forward replay PASS | ✅ | §7 前滚后 53/53 |
| 6 | Portal regression PASS | ✅ | §5 逐名零增删；+5 列为声明内 EXTEND，既有列改动数 0 |
| 7 | 未为版本号无谓修改 migrations | ✅ | §11 —— migrations 零改动 |
| 8 | 不宣称 SUPABASE VERIFIED | ✅ | §9 边界照旧标 `ENVIRONMENT-UNVERIFIED` |

因此 DB-3 提升为：

> ## `DB-3 LOCALLY VERIFIED / READY FOR DB-4 REVIEW`

---

## 11. Changes Made

### migrations —— **零改动**

`0023`～`0026` 一个字符未改。17.6 全绿，因此按 Supervisor 的
「不要为了看起来更兼容而修改已经工作的 migrations」执行。

### 测试 —— 1 处改动

`supabase/tests/db3_schema_contract.sql`，课程 RESTRICT 那一条：

| | 改前 | 改后 |
|---|---|---|
| 捕获条件 | `when restrict_violation`（PG18 专属） | `when restrict_violation or foreign_key_violation`（两版通用） |
| 断言 | 「抛了异常」 | 「抛了异常」**+「父行仍然存在」** |
| 可观测性 | 无 | 把实际 SQLSTATE 输出到 NOTICE |
| 断言数 | 52 | **53** |

**没有删除或放宽任何既有断言。** 改动理由完全是 §8 的版本差异。

### 文档 —— 3 处

1. `DB-3-...-REPORT.md`：顶部加 DB-3.5 更正横幅；§11 / DBR-24 就地标 `【DB-3.5 更正】`；DBR-22 标 CLOSED。**原文全部保留。**
2. `OPEN_ISSUES.md`：DBR-22 → CLOSED 并附八项证据；DBR-24 SQLSTATE 表述更正。
3. `AMAS_PROJECT_HANDOFF.md`：新增本报告索引行；D-33。

---

## 12. Commits

| 仓库 | commit | 内容 |
|---|---|---|
| website | *(本次提交)* | DB-3.5 报告 · 契约测试版本可移植化 · DB-3 报告更正标注 · HANDOFF |
| App | *(本次提交)* | DBR-22 CLOSED · DBR-24 更正 · D-33 |

App 仓库**代码零改动**（仅 `docs/project-memory/`）。

---

## 13. Documentation Updates

- **新增** `docs/operations/DB-3.5-POSTGRESQL-17.6-COMPATIBILITY-REPORT.md`（本文）
- **更正** `docs/operations/DB-3-POSTGRESQL-SCHEMA-IMPLEMENTATION-REPORT.md`（标注式，不覆盖原文）
- **更新** `docs/operations/AMAS_PROJECT_HANDOFF.md` → v2.2，新增 **D-33**
- **更新** App `docs/project-memory/OPEN_ISSUES.md`（DBR-22 / DBR-24）
- **更新** App `docs/project-memory/DECISION_LOG.md`（D-33）

### D-33｜目标版本验证不可用「理论兼容」替代

**Decision**：schema / DDL 的验证必须在**目标部署版本**上真实执行。
「所用特性在目标版本都支持」只能作为静态补充，**不能**作为通过依据。
版本不一致时，状态必须写成 `TARGET VERSION VERIFICATION REQUIRED`，不得写 `VERIFIED`。
**Why**：DB-3 在 PG 18.6 全绿，其结论「特性都支持 17.6」也确实成立 ——
但 DB-3.5 在 17.6 上仍抓到一处真实差异（`ON DELETE RESTRICT` 的 SQLSTATE 反向），
它不属于「特性支持与否」，而属于**行为细节**，静态推理看不见。
**How to apply**：任何跨版本/跨引擎的结论，先问「在目标版本上跑过没有」；没跑过就标 `UNVERIFIED`。

---

## 14. Recommended DB-4 Entry

**不自动开始 DB-4。** 以下是交给 Supervisor 判断的事实。

### 已就绪（可在本地完成）

| 项 | 状态 |
|---|---|
| `migration.legacy_identity_crosswalk` + 全部护栏 | ✅ 17.6 实测 |
| `migration.row_manifest` + 值域约束 | ✅ 17.6 实测 |
| `migration.admin_role_migration_manifest` + 证据强制 | ✅ 17.6 实测 |
| `migration.schema_baseline`（`DB-3.0`，绑定 SQLite 指纹） | ✅ |
| 源数据事实（DB-2） | ✅ 7 用户 · `admin` 0 个 · `legacy_user_map` 0 行 · CP 0 行 |

### 必须等待真实 Supabase staging identity 的部分

DB-4 的核心是把 7 个 legacy SQLite user 解析到 canonical `profiles.id`。
按 DB-1 §2.3 的 `mapping_method` 值域，**每一条自动放行路径都需要真实 Supabase**：

| mapping_method | 能否在本地完成 | 原因 |
|---|---|---|
| `provisioned_by_migration` | ❌ | 需要在真实 Supabase Auth 中**创建账号**才能产生 `auth.users.id` |
| `explicit_operator_link` | ❌ | 需要真实 Supabase 账号作为链接目标 |
| `email_match_reviewed` | ❌ | 需要真实 Supabase 侧存在同邮箱账号才谈得上匹配 |
| `email_match_unreviewed` | — | 本就禁止自动放行 |
| `unresolved` | ✅ | 但它不推进任何东西 |

**因此本地能做的 DB-4 部分仅限于**：crosswalk 行的**结构性预填**（7 条 legacy id + 规范化邮箱 + `mapping_method='unresolved'`），
以及迁移工具代码与其单元测试。**真正的 identity 解析必须在真实 staging Supabase 完成。**

### 7 个 SQLite 用户的邮箱构成（供判断解析环境）

DB-2 实测的 7 个 legacy 账号中：

| 类别 | 数量 | 说明 |
|---|---|---|
| `@amas.test` / `@amas.local` 测试账号 | 6 | 自动化测试与本地开发产生，**不对应真人** |
| 真实邮箱（`estherzh0528@gmail.com`） | 1 | 唯一可能对应真人的账号 |

> **建议提请 Supervisor 决定**：这 6 个测试账号是否应走 `unresolved` 并在 DB-4 直接标记为
> **不迁移**（它们不是真人，为它们在生产 Supabase 创建账号本身就是造假数据，触碰 R-7），
> 从而把 DB-4 的真实解析范围收敛到 **1 个账号**。
> 这会显著改变 DB-4 的形态与所需环境，因此不由本轮擅自决定。

### 建议的下一步顺序

1. Supervisor 裁定上述 6 个测试账号的处置；
2. 若裁定为不迁移 → DB-4 的解析对象降为 1 人，可考虑与 RB-03（建立 staging/production Supabase）合并推进；
3. 在此之前，本地可先行的是 DB-6（课程合并，`course_catalog` EXTEND 已就位、67↔67 已对齐、**不依赖身份**）。

---

## 最终状态

> # `DB-3 LOCALLY VERIFIED / READY FOR DB-4 REVIEW`
>
> `DBR-22 CLOSED` · migrations 零改动 · Supabase 相关边界仍为 `ENVIRONMENT-UNVERIFIED`
>
> **未开始 DB-4。**
