# DB-4 FAST-TRACK PREFLIGHT REPORT

日期：2026-09-10 · 目标：`amas-staging`（D-41）
WRITER：**STAGING-DB-WRITER-A**（本会话）
**LIVE MUTATION = NONE** —— 本轮对 live 只有 `SELECT`。
DB-4 **未执行**，仍为 `NOT AUTHORIZED FOR LIVE EXECUTION`。

---

## §0 先纠正一处范围认知

指令要求「prove exactly what real data DB-4 would migrate」。
按 canonical 契约 `DB-1-TARGET-SCHEMA-AND-MIGRATION-CONTRACT.md` 阶段表：

```
DB-4 | 身份迁移：crosswalk 填充 + 人工复核闭环 | 依赖 DB-3
     | 退出条件：每个 legacy user 都有 crosswalk 行；email_match_unreviewed 数为 0
     | 回滚：只写 crosswalk，业务数据不动
```

**DB-4 不迁移任何业务行。** 业务数据分散在后续阶段：
DB-5 角色 · DB-7 CP · DB-8 学习数据 · DB-9 房间与祷告 ·
DB-10 社群 · DB-11 附属（library / recordings / images / push /
announcements / course_files / cooperation）。

因此本报告给出两张矩阵：
**§3 是 DB-4 真正要写的东西**（身份，7 行）；
**§4 是全部源数据的去向**（供 DB-5..DB-11 排期，本轮不执行）。
把两者混为一谈会让 DB-4 的爆炸半径被高估 20 倍。

---

## §1 POST-0026 GATE = **PASS**

`supabase/tests/0026_postconditions.sql` 对 live 只读执行：

```
POST-0026 ALL PASS
ledger=0001..0026/26/e781ce12  tab=54 rls=54 norls=0 app=28
mig=4/rls0 pol=33 fn=60 open_exec=12
migration USAGE 全 false  identity 1/1/1  pc 9 未变  指纹 8/8 EXACT MATCH
```

---

## §2 源数据基线（只读副本，未触碰原库）

`AMAS Seminar App/backend/data/amas.sqlite`

```
大小    450,560 bytes        （与 0023 记录一致）
sha256  0798526d34a24c75696a305d65eafe2e f0357605defc13cca7f706d47e620c5a
mtime   2026-09-07 15:13:15  （DB-2 审计后未被改动）
表数    32                   合计 285 行   （与 0023 记录的 32 表 / 285 行精确吻合）
```

0023 里写的 `source_sqlite_sha256 = 0798526d34a24c75696a305d65eafe2e`
是该 sha256 的**前 32 位**，不是完整值 —— 记录时被截断了。已核对，来源一致。

非空表仅 11 张，其余 21 张为 0 行。

---

## §3 DB-4 真正的迁移矩阵（身份，唯一本阶段范围）

| SOURCE TABLE | SOURCE ROWS | TARGET TABLE | TARGET EXPECTED ROWS | IDENTITY/FK 依赖 | TRANSFORMATION | SKIP RULE | MANUAL REVIEW RULE |
|---|---|---|---|---|---|---|---|
| `users` | 7 | `migration.legacy_identity_crosswalk` | **7**（0 → 7） | `canonical_profile_id → public.profiles(id)` ON DELETE RESTRICT | legacy uuid → 解析记录；**不创建任何 Supabase 身份** | 无（每个 legacy user 都必须有一行，这是 DB-1 的退出条件） | 见 §5 |
| `users`（role 非 student） | **0** | `migration.admin_role_migration_manifest` | **0**（0 → 0） | — | — | 源库 7 人全部 `role='student'`，无 admin/teacher | 无 |
| `users` | 7 | `migration.row_manifest` | **7**（0 → 7） | — | 每个 legacy user 一条审计行，`source_table='users'` | 无 | `manual_review=true` 用于 §5 那一行 |

### 不变量（DB-4 后必须逐项成立）

```
auth.users        1 → 1     不变（DB-4 不创建身份）
public.profiles   1 → 1     不变
public.user_roles 1 → 1     不变
28 张 app_* 表     0 → 0     全部不变
course_catalog    67 → 67   不变
program_catalog    9 → 9    不变（业务指纹 cd41beee… / created_at dca03a83…）
schema             不变      DB-4 无 DDL，0026 门禁必须仍 PASS
```

---

## §4 全部源数据去向（DB-5..DB-11 排期用，本轮不执行）

| SOURCE TABLE | ROWS | 归属拆分 | TARGET | 阶段 | 处置 |
|---|---|---|---|---|---|
| `courses` | 67 | — | `course_catalog` | **DB-6 已完成** | live 已有 67 行，**SKIP，不得重复迁移** |
| `course_files` | 68 | `uploader_id` **全为 NULL** | `app_course_files` | DB-11 | 可迁；`course_id` 外键 0 悬空 |
| `refresh_jti` | 111 | REAL 1 / FIXTURE 6 / **悬空 104** | — | — | **SKIP**：会话刷新令牌，已被 Supabase Auth 取代 |
| `prayer_shares` | 12 | FIXTURE 10 / **悬空 2** | `app_prayer_shares` | DB-9 | 10 行随 fixture 处置；**2 行 MANUAL_REVIEW**（见下） |
| `rooms` | 7 | `host_id='system'` **5** / FIXTURE 2 | `app_rooms` | DB-9 | 5 个内置房间合法（对应 0025 三态 host 模型的 `host_type='system'`） |
| `room_members` | 3 | FIXTURE 3 | `app_room_members` | DB-9 | 随 fixture 处置 |
| `room_prayer_topics` | 2 | FIXTURE 2 | `app_room_prayer_topics` | DB-9 | 随 fixture 处置 |
| `room_realtime_events` | 6 | **room 全部悬空** | — | — | **SKIP**：DB-1 明写 presence/events 不迁；且 6 行全部指向不存在的 room `p4b1_1788420438666` |
| `prayer_intercessions` | 1 | FIXTURE 1 | `app_prayer_intercessions` | DB-9 | 随 fixture 处置 |
| `cooperation_submissions` | 1 | **无 user 列** | `app_cooperation_submissions` | DB-11 | 可迁；类型「事奉申请」，通过 email 字段承载联系人 |
| 其余 21 张 | 0 | — | 对应 `app_*` | — | 无数据 |

### 源库内部 FK 完整性（实测）

| 检查 | 悬空行数 |
|---|---|
| `course_files.course_id → courses` | **0** |
| `room_members.room_id → rooms` | **0** |
| `room_prayer_topics.room_id → rooms` | **0** |
| `prayer_intercessions.share_id → prayer_shares` | **0** |
| `prayer_shares.room_id → rooms` | **2** |
| `prayer_shares.user_id → users` | **2** |
| `room_realtime_events.room_id → rooms` | **6** |
| `refresh_jti.user_id → users` | **104** |

那 **2 行 `prayer_shares` 同时悬空 room 与 user**（同两行），
与 DB-2 §11 记录的 `MANUAL_REVIEW = 2` 完全一致 —— 本轮独立复现，非引用。

**潜在真实用户在所有内容表中拥有 0 行。**
唯一与它关联的是 1 条 `refresh_jti`（会话令牌，SKIP）。
换言之：即便身份映射被批准，也没有任何业务行会因此改变归属。

---

## §5 IDENTITY MAPPING = **MANUAL REVIEW（1 项）**

### 5.1 六个测试夹具 —— RESOLVED（判定明确）

| legacy id | email | 判定 |
|---|---|---|
| `6ea90950…` | `s1780377335744@amas.test` | D-34 TEST FIXTURE |
| `9492e7f2…` | `s1780377880150@amas.test` | D-34 TEST FIXTURE |
| `5b3896e6…` | `s1780377952749@amas.test` | D-34 TEST FIXTURE |
| `1cb28215…` | `sec2_a_…@amas.local` | D-34 TEST FIXTURE |
| `dc4c6c4d…` | `sec2_b_…@amas.local` | D-34 TEST FIXTURE |
| `1c028145…` | `sec2_c_…@amas.local` | D-34 TEST FIXTURE |

处置：`mapping_method='unresolved'` · `canonical_profile_id=NULL` ·
`mapping_confidence='high'`（"确定它不对应任何 canonical 身份"是高置信判断）·
`verified=false` · `notes='D-34 TEST FIXTURE / DO NOT MIGRATE'`。

表上的 `crosswalk_resolved_shape` CHECK 要求 `unresolved` 必须
`canonical_profile_id IS NULL` —— 与此处置吻合。

### 5.2 第七个 —— **MANUAL_REVIEW，不得自动放行**

```
legacy : d470e79a-f155-44c5-aaaf-cc299fc04d4b
         estherzh0528@gmail.com   name=Elowen   role=student

live   : c50ea5c3-04d0-45e8-827f-b3d00fdf27fa
         estherzh0528@gmail.com   display_name=Elowen   status=active
         role=applicant           email_confirmed=true  created=2026-09-03
```

**UUID 不同**，所以 crosswalk 确有必要。

支持同一人的证据有两条独立信号：**邮箱完全相同** + **显示名完全相同（Elowen）**。
反向信号一条：**角色不同**（legacy `student` vs live `applicant`）。

但按 **D-35** 与表上的 `crosswalk_email_only_requires_review` CHECK，
`email_match_unreviewed` **永远不能带 `verified=true`** ——
邮箱相同不构成自动映射的依据，这是设计上被明令封死的路径。

同时 DB-1 的 DB-4 退出条件要求 `email_match_unreviewed` 数为 **0**。
两者叠加的结论是：

> **DB-4 无法在没有一次人工裁定的情况下完成。**

三条可选路径，需 Supervisor / Owner 择一：

| 路径 | `mapping_method` | 前置要求 |
|---|---|---|
| A 判定为同一人 | `email_match_reviewed` | 必须给出 `canonical_profile_id=c50ea5c3…` 且 `verified` 三元组齐全（`verified_by` + `verified_at`） |
| B 判定为不同人 | `unresolved` | `canonical_profile_id=NULL`，legacy 账号在 staging 不认领任何身份 |
| C 显式操作员链接 | `explicit_operator_link` | 同 A，但记录依据为操作员裁定而非邮箱匹配 |

**本会话不做这个判定，也不猜。**

### 5.3 一处设计褶皱，需一并裁定

`verified_by` 的外键是 `public.profiles(id)`，而 live 只有一个 profile ——
就是本次复核的**对象本人** `c50ea5c3…`。
若选路径 A/C，唯一可填的复核人身份是被复核者自己（自我复核）。
这在 staging 内部可以接受，但应被明确记录，而不是默默填进去。

---

## §6 EXPECTED POST-DB4（机械化后置条件）

```
migration.legacy_identity_crosswalk        0 → 7
  其中 unresolved                          6（若 §5.2 选 B 则为 7）
  其中 email_match_reviewed / explicit      1（若选 A/C）
  其中 email_match_unreviewed               必须为 0    ← DB-1 退出条件
migration.admin_role_migration_manifest    0 → 0
migration.row_manifest                     0 → 7   （source_table='users'）
migration.schema_baseline                  1 → 1   不变

auth.users        1 → 1        profiles 1 → 1      user_roles 1 → 1
28 张 app_*        0 → 0        course_catalog 67   program_catalog 9
0026_postconditions.sql        执行后必须仍 PASS
```

---

## §7 RECOVERY = **PROVEN**

DB-4 的爆炸半径是三张 `migration.*` 工具表，且执行前它们**全为空**。

| 项 | 内容 |
|---|---|
| 备份 | 沿用已证方法：`pg_dump -Fc`（DB-3 执行时实测 exit 0 / 357,630 bytes / 语义精确还原）。执行窗口开启时**重取一份 pre-DB4 快照**，不复用 DB-3 那份 |
| 批次 | **单批次**。7 行、三张表、一个事务，没有拆批的必要 |
| 事务边界 | `begin; … commit;`，断言失败即整体回滚。psql `ON_ERROR_STOP=1` |
| 前置计数 | crosswalk 0 / manifest 0 / row_manifest 0 / auth.users 1 / profiles 1 |
| 行清单 | `migration.row_manifest` 本身即行清单，7 条，`source_table='users'` |
| 后置计数 | 见 §6 |
| 回滚 | 两步都不涉及业务数据：① `delete from migration.row_manifest; delete from migration.legacy_identity_crosswalk;`（两表执行前为空，全删即回到原状） ② 复跑 `0026_postconditions.sql` 证明 schema 与业务态未变 |
| 冒烟测试 | `0026_postconditions.sql` PASS + crosswalk 7 行 + 每个 legacy user 恰好 1 行 + `email_match_unreviewed` 计数 = 0 |

**无需 hosted backup**：本阶段零业务数据写入、零 DDL、零身份创建，
爆炸半径小于 DB-3（DB-3 已判定 A 并实测通过）。

一点必须记录的连带效应：crosswalk 的 `canonical_profile_id` 外键是
`ON DELETE RESTRICT`。若选路径 A/C，写入后该 profile 将无法被删除，
直到 crosswalk 行先被移除。这是设计意图（身份碰撞防线），不是缺陷。

---

## §8 0027

`0027` 保持 **PROPOSED / DO NOT APPLY**。本轮未设计、未编写、未应用 0027，
未与 DB-4 混合。无任何权限加固动作。

---

## §9 VERDICT

```
POST-0026 GATE          : PASS
SOURCE DATA             : 32 表 / 285 行，与 DB-2 基线精确吻合；非空表 11 张
TARGET LIVE BASELINE    : 28 张 app_* 全为 0 行；crosswalk/manifest/row_manifest 全为 0
                          auth.users 1 / profiles 1 / user_roles 1
                          course_catalog 67 / program_catalog 9
IDENTITY MAPPING        : 6 RESOLVED（D-34 测试夹具）
                          1 MANUAL REVIEW（estherzh0528@gmail.com，同邮箱 + 同显示名
                          但角色不同；D-35 与表 CHECK 均禁止自动放行）
EXPECTED POST-DB4       : crosswalk 0→7 · manifest 0→0 · row_manifest 0→7
                          其余一切不变，email_match_unreviewed 必须为 0
RECOVERY                : PROVEN（单批次 / 单事务 / 两表全删即回滚 / 无需 hosted backup）
DB-4 EXECUTION PLAN     : NOT READY —— 缺一次人工身份裁定（§5.2 路径 A / B / C）
LIVE MUTATION           : NONE
```

**WAIT FOR SUPERVISOR.**
