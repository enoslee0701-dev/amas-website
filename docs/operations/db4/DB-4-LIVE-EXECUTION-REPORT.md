# DB-4 LIVE EXECUTION REPORT

日期：2026-09-10 · 目标：`amas-staging`（D-41）
WRITER：**STAGING-DB-WRITER-A**（本会话，唯一写者）

```
DB-4 LIVE = COMPLETED

IDENTITY CROSSWALK              = 7 / 7
REAL-LOOKING LEGACY USER        = NO-LINK / UNRESOLVED
TEST FIXTURES                   = 6 / 6 EXCLUDED FROM CANONICAL IDENTITY
AUTH USERS CREATED              = 0
BUSINESS DATA MIGRATED          = 0
0027                            = ABSENT
```

授权来源：本会话直接收到的 SUPERVISOR EXECUTION AUTHORIZATION — DB-4 LIVE。

---

## §1 身份裁定的准确表述

Supervisor 对 legacy `d470e79a…` 的裁定是 **NO-LINK / UNRESOLVED**，
并明确写道：

> This does NOT claim the two human identities are proven different.
> It means available evidence is insufficient to establish a canonical link.

本报告与写入库中的记录都严格采用这个表述。**不主张两个自然人身份不同**，
只表示证据不足以确立 canonical 关联，因此 DB-4 不把该 legacy 身份
与既有 live 用户关联。既有 live `applicant` 用户**未被改动**。

一处刻意的技术选择：该行的 `mapping_confidence` 取 **`low`**，
六个测试夹具取 `high`。理由是这一列描述的是「对映射结论的置信度」——
夹具确实高置信地不对应任何 canonical 身份；而第七个是「不知道」。
用 `high` 会把一个未知伪装成已知。

---

## §2 执行前

### 2.1 PRE-WRITE GATE = ALL PASS

```
0026_postconditions.sql 对 live            → POST-0026|OK
migration.legacy_identity_crosswalk         = 0
migration.admin_role_migration_manifest     = 0
migration.row_manifest                      = 0
```

### 2.2 全新 pre-DB4 快照（未复用 DB-3 那份）

```
pg_dump -Fc --no-owner --no-privileges -n public -n auth -n supabase_migrations
exit    = 0
大小    = 466,235 bytes（非空；大于 pre-DB3 的 357,630，与新增 28 张表吻合）
sha256  = addc1981696f922ff302a41e5973bc0e653a39b23bda567cbc018ad6dcf19fa5
位置    = session scratchpad，仓库之外，未提交
```

### 2.3 本地沙箱先行试跑

在 PG 17.6 沙箱 `amas_db4`（由 post-0026 模板克隆 + 造出 1/1/1 身份基线）先跑一遍，
三项行为全部符合预期后才碰 live：

| 场景 | 结果 |
|---|---|
| 不传保险丝参数 | 拒绝执行，零写入 |
| 正式执行 | 事务内断言全过，`DB-4\|COMMITTED` |
| 重复执行 | 被前置断言挡下（三表非空），计数仍为 7 / 7 |

---

## §3 执行方式

**单个 PostgreSQL 事务**，脚本为 `docs/operations/db4/DB-4-identity-crosswalk.sql`。

它刻意**不**放在 `supabase/migrations/` 下 —— DB-4 不是 migration apply，
**未产生任何新的 `schema_migrations` 版本**。也不放在 `supabase/tests/` 下，
以免与那批纯 SELECT 探针混淆。带保险丝：
缺 `-v i_understand_this_writes=YES` 直接中止。

事务结构：

```
begin
  前置断言（三张工具表为 0；身份基线 1/1/1）
  insert 7 条 crosswalk
  insert 7 条 row_manifest（batch='DB-4'）
  admin_role_migration_manifest 收 0 行
  事务内硬断言（11 项，含 app_* 业务表合计必须仍为 0 行）
commit
```

无 DDL。未触碰 `auth.users` / `profiles` / `user_roles` / 业务表 /
`course_catalog` / `program_catalog` / `schema_migrations`。

---

## §4 写入内容

### 4.1 `migration.legacy_identity_crosswalk` = 7 行，全部 `unresolved`

| legacy id | method | confidence | verified | classification | decision |
|---|---|---|---|---|---|
| `d470e79a…` | `unresolved` | **low** | false | `POTENTIAL_REAL_USER` | `NO-LINK / UNRESOLVED` |
| `1c028145…` | `unresolved` | high | false | `TEST_FIXTURE` | `EXCLUDED_FROM_CANONICAL_IDENTITY` |
| `1cb28215…` | `unresolved` | high | false | `TEST_FIXTURE` | `EXCLUDED_FROM_CANONICAL_IDENTITY` |
| `5b3896e6…` | `unresolved` | high | false | `TEST_FIXTURE` | `EXCLUDED_FROM_CANONICAL_IDENTITY` |
| `6ea90950…` | `unresolved` | high | false | `TEST_FIXTURE` | `EXCLUDED_FROM_CANONICAL_IDENTITY` |
| `9492e7f2…` | `unresolved` | high | false | `TEST_FIXTURE` | `EXCLUDED_FROM_CANONICAL_IDENTITY` |
| `dc4c6c4d…` | `unresolved` | high | false | `TEST_FIXTURE` | `EXCLUDED_FROM_CANONICAL_IDENTITY` |

全部 `supabase_auth_user_id = NULL` · `canonical_profile_id = NULL` ·
`verified_by = NULL` · `verified_at = NULL`。

**PII 取舍**：`evidence` 只记录**观察到的事实性标志**（布尔与枚举），
不把邮箱与显示名再抄一份进 Postgres。
第一行记的是：`email_match_observed=true` · `display_name_match_observed=true` ·
`uuid_differs=true` · `role_differs=true` · `legacy_role=student` ·
`live_role=applicant` · `business_content_owned=0` ·
`auto_link_forbidden_by='D-35 + crosswalk_email_only_requires_review'`。
`legacy_sqlite_user_id` 是必需的关联键，无法省略。

### 4.2 `migration.row_manifest` = 7 行

```
batch=DB-4  source_table=users  target_table=migration.legacy_identity_crosswalk
status=SKIPPED   manual_review=false   共 7 行
```

`status='SKIPPED'` 是准确的：**没有任何身份被迁移**，写入的是解析记录本身。
`manual_review=false` 也是准确的：复核已由 Supervisor 完成并裁定，不是待办事项；
技术上仍未解析的状态由 crosswalk 的 `mapping_method='unresolved'` 承载。

### 4.3 `migration.admin_role_migration_manifest` = 0 行

源库 7 人全部 `role='student'`，无 admin/teacher。DB-5 在本数据集上亦无对象。

---

## §5 HARD POSTCONDITIONS —— 全部独立复查通过

| 要求 | 实测 |
|---|---|
| crosswalk 行数 = 7 | 7 |
| distinct `legacy_sqlite_user_id` = 7 | 7 |
| `mapping_method='email_match_unreviewed'` = 0 | 0 |
| `canonical_profile_id IS NOT NULL` = 0 | 0 |
| `supabase_auth_user_id IS NOT NULL` = 0 | 0 |
| `verified=true` = 0 | 0 |
| DB-4 batch `row_manifest` = 7 | 7 |
| `admin_role_migration_manifest` = 0 | 0 |
| `auth.users` / `profiles` / `user_roles` | 1 / 1 / 1 |
| 28 张 `app_*` 业务表合计行数 | **0** |
| `course_catalog` / `program_catalog` | 67 / 9 |
| ledger | 0001–0026，26 行 |
| `0027` | ABSENT |
| `0026_postconditions.sql` | **PASS** |

`0026_postconditions.sql` 仍 PASS 这一项同时证明了：schema 未变、
八域指纹仍 8/8、`program_catalog` 业务与 `created_at` 指纹未变、
`open_execute_funcs` 仍为 12。

DB-1 的 DB-4 退出条件两条均已满足：
**每个 legacy user 都有 crosswalk 行**（7/7）；
**`email_match_unreviewed` 数为 0**。

---

## §6 未做的事

未创建任何 `auth.users`；未迁移任何业务行；未产生新的 ledger 版本；
未执行任何 DDL；未触碰 `0027`；未自动进入 DB-5 / DB-7 / DB-8 / DB-9 /
DB-10 / DB-11；未自动回滚；未打印或提交任何凭据。
`supabase/migrations/` 改动 = 0，`supabase/tests/` 改动 = 0。

---

## §7 遗留事项

### 7.1 那一行仍是技术上未解析的

`d470e79a…` 的 `mapping_method='unresolved'` 意味着：若将来出现足以确立
关联的证据（例如 Owner 直接确认），可以把它改写为
`explicit_operator_link` 或 `email_match_reviewed`。
本脚本使用 `on conflict do nothing`，**不会覆盖既有裁定** ——
改写既有行必须显式另行处理，这是刻意的。

顺带记录一处仍然成立的设计褶皱：`verified_by` 外键指向 `public.profiles`，
而 live 只有被复核者本人一个 profile。若将来走 `verified=true` 路径，
唯一可填的复核人身份就是被复核者自己。届时应显式记录，而不是默默填入。

### 7.2 `service_role` key 泄露仍为 OWNER-ACCEPTED / DEFERRED

不是已关闭项。它仍阻塞 STG personas 与任何 public staging 暴露。
（具体暴露位置不写入本公开仓库。）

---

## §8 VERDICT

```
DB-4 LIVE              = COMPLETED
IDENTITY CROSSWALK     = 7 / 7
REAL-LOOKING LEGACY    = NO-LINK / UNRESOLVED（不主张身份不同，仅证据不足）
TEST FIXTURES          = 6 / 6 EXCLUDED
AUTH USERS CREATED     = 0
BUSINESS DATA MIGRATED = 0
LEDGER                 = 0001–0026（未新增版本）
0027                   = ABSENT
0026 GATE              = PASS
```

**未自动继续。STOP，WAIT FOR SUPERVISOR。**
