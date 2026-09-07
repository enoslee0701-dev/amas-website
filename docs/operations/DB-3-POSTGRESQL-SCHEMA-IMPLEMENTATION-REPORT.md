# DB-3 POSTGRESQL SCHEMA IMPLEMENTATION REPORT

**RB-01 · PHASE DB-3 —— PostgreSQL Schema 实现**
日期：2026-09-07 · 执行：Claude · 依据：DB-0 / DB-1 契约 + DB-2 实测数据

> ### ⚠ 本报告已被 DB-3.5 补充与部分更正（2026-09-07）
>
> 本报告的验证在 **PostgreSQL 18.6** 上完成。Supervisor 裁定「理论兼容」不能代替执行，
> 遂有 **DB-3.5 PostgreSQL 17.6 COMPATIBILITY GATE**。结果：
>
> - `0001..0026` 在 **17.6** 上 **26/26 APPLIED**，契约测试 **53/53 PASS**，回退与前滚均通过 → **DBR-22 CLOSED**
> - **§11 / §15 / DBR-24 中关于 `ON DELETE RESTRICT` SQLSTATE 的表述在目标版本上是错的**：
>   17.6 抛 `foreign_key_violation` **23503**，`restrict_violation` **23001** 是 PostgreSQL **18** 才引入的。
>   下文相关处已就地标注 `【DB-3.5 更正】`，**原文保留**，详见 `DB-3.5-POSTGRESQL-17.6-COMPATIBILITY-REPORT.md` §8。
> - migrations 本身**未因版本做任何修改**；只有契约测试改为版本可移植（并新增 1 条更严的断言，52 → 53）。

> **最终状态：`LOCALLY VERIFIED / READY FOR DB-4 REVIEW`**
> 详见 §17 的验证边界声明 —— 「LOCALLY VERIFIED」指在**真实 PostgreSQL 引擎**上执行并断言通过，
> **不是**在真实 Supabase 上。两者的差别在 §17 逐条列明，未夸大。

---

## GATE 0 — `app_user_profile_ext`

### 裁定

> ## `app_user_profile_ext = DO NOT CREATE`

DB-1 §5 第 2 行原本规定「CREATE NEW `app_user_profile_ext`，承接 `degree` / `bio`」。
逐字段取证后该表**不成立**：需要承接的字段只剩一个，而它属于 canonical schema 的语义范围。

### SQLite `users` 10 字段逐项归宿

| SQLite field | Current purpose | Target canonical location | Still required? | App-specific? | Decision |
|---|---|---|---|---|---|
| `id` | 内部主键（`crypto.randomUUID()`） | `auth.users.id` = `profiles.id` | ✅ | ❌ | **MAP** —— 经 `migration.legacy_identity_crosswalk` 解析，不产生第二个 id 空间 |
| `email` | 登录标识 + `UNIQUE COLLATE NOCASE` | `auth.users.email`（权威）+ `profiles.email` | ✅ | ❌ | **MERGE** —— 唯一性与大小写规则由 Supabase Auth 承担 |
| `name` | 展示名 | `profiles.display_name` | ✅ | ❌ | **MERGE** |
| `password_hash` | legacy 凭据（scrypt） | — | ❌ | ❌ | **DO NOT MIGRATE** —— AUTH-M7 已从生产代码删除 legacy 认证；复制凭据是纯负债 |
| `salt` | legacy 凭据盐 | — | ❌ | ❌ | **DO NOT MIGRATE** —— 同上 |
| `role` | `CHECK IN ('student','admin')` | `public.user_roles` | ✅ | ❌ | **MERGE** —— 经 §3.2 manifest 逐人裁定（D-18），无全局映射 |
| `degree` | 用户注册时自选的学位标签（自由文本 ≤64） | — | **❌** | ❌ | **DO NOT MIGRATE** —— 见下方证据 |
| `avatar` | 头像（URL / data URI / 生成图三种形态混存） | `profiles.avatar_path` | ✅ | ❌ | **MERGE + TRANSFORM** —— 需归一为 storage path，见 DBR-21 |
| `bio` | 个人简介（后端 ≤500） | **`profiles.bio`（本轮新增列）** | ✅ | ❌ | **EXTEND CANONICAL** —— 通用档案属性，不需要 App 专属表 |
| `created_at` | epoch ms | `profiles.created_at` | ✅ | ❌ | **MERGE** —— `to_timestamp(v / 1000.0)` |

### `degree` 判定为 DO NOT MIGRATE 的证据

1. **实测无数据**：7 个用户 **7/7 全为 `NULL`**（`select degree,count(*) from users group by 1` → `[{"degree":null,"c":7}]`）。迁移它不会保住任何现有信息。
2. **它不是权威学籍**：值由用户在注册页自选（`components/AuthView.tsx:55`，未选时前端硬编码回填 `'M.Div'`），后端只校验「是字符串且 ≤64 字符」（`backend/src/auth/users.ts:237-238`）。它是**展示标签**，不是学籍。
3. **canonical 已有权威承载**：`public.student_records.program_code` → `public.program_catalog(code)`（`0012_student_core.sql:92`），有 FK 约束、由教务流程写入。
4. **迁移它会制造第二个学位真相源**。一个用户自填的 `degree` 与教务认定的 `program_code` 不一致时，没有任何规则能裁决谁对。这正是 R-2 要防的「展示 ≠ 权威」。

> **App 侧后续动作（属 DB-12 范围，本轮不做）**：Profile 页的学位展示改为读 `student_records.program_code`；未建档用户显示「未确定」，**不得回填默认值**。

### `bio` 判定为 EXTEND CANONICAL（而非建扩展表）的理由

- 它**仍有产品价值**：`components/ProfileView.tsx` 有编辑框（386–398 行）与展示（584 行），是在售功能。
- 它**能放进现有 canonical schema**：个人简介是通用档案属性，不是 App 专属概念；Portal 自身也可用。
- GATE 0 的规则是「**只有无法放入现有 canonical schema 的字段才能建扩展表**」。`bio` 能放入，所以不建。
- 代价对比：一列 nullable text（`0023 §2`） vs 一整张带 FK、RLS、生命周期的扩展表。前者严格更小。

实测数据同样为 **7/7 全 `NULL`**，因此本次扩展列不承接任何存量数据，纯为后续写入服务。

**结论：GATE 0 通过，`app_user_profile_ext` 不创建。** 契约测试第 1 条断言即验证该表不存在。

---

## §1 Migration 归属（D-27）

全部 DDL 只落在 **`amas-website/supabase/migrations/`**，与 D-9 的治理文档归属一致。

| 文件 | 内容 |
|---|---|
| `0023_app_foundation.sql` | `migration` schema 四张工具表 · `profiles.bio` · 9 个 App 枚举 · `app_image_uploads` |
| `0024_app_learning.sql` | `course_catalog` 扩展 4 列 · `app_course_files` · `app_course_progress` · `app_christian_profile` · `app_practice_training_state` |
| `0025_app_rooms_prayer.sql` | `app_rooms`（哨兵改造）+ 房间 5 表 + 祷告 6 表 |
| `0026_app_community.sql` | 动态 3 表 · 好友 2 表 · 图书馆 2 表 · 录音 · 推送 · 公告 · 合作来件 |

**App repo 未新增任何 DDL**，也未建立第二套 migrations 目录。本轮 App 仓库代码零改动。

---

## §2 版本化对象清单

| 处置 | 数量 | 对象 |
|---|---|---|
| **MERGE INTO EXISTING** | 2 | `users` → `profiles` · `courses` → `course_catalog` |
| **EXTEND EXISTING** | 2 | `profiles` +1 列（`bio`） · `course_catalog` +4 列 |
| **CREATE NEW** | 28 | 全部 `app_*` 业务表 |
| **TRANSFORM** | 3 | `legacy_user_map` → `migration.legacy_identity_crosswalk` · `growth_state` → `app_christian_profile` · `rooms` → `app_rooms` |
| **DO NOT MIGRATE** | 3 | `refresh_jti`（死表）· `room_presence` / `room_realtime_events`（建表不迁数据） |

**表数对账**：SQLite 32 业务表 − `users`(MERGE) − `courses`(MERGE) − `legacy_user_map`(→`migration`) − `refresh_jti`(不迁) = **28** = 实测 `app_*` 表数 28。**无缺口**。

---

## §3 对 DB-1 的修正

DB-1 是在 DB-2 实测之前写的契约，本轮实现时发现三处必须修正。**均已实现修正版本，未沿用错误契约。**

| # | DB-1 原文 | 问题 | 本轮处置 |
|---|---|---|---|
| 1 | §5 #2：建 `app_user_profile_ext` | `degree` 无数据且非权威、`bio` 属通用档案属性 | GATE 0 裁定不建，`bio` 并入 `profiles` |
| 2 | §5 #5 列出 `courses` 独有列为 `thumbnail`/`thumbnail_image_id`/`total_lessons`/`created_by` | 漏了 `created_at`（67 行均有值），且 `total_lessons` 其实 `course_catalog` 已有 | 补 `course_catalog.created_at`；`total_lessons` 不重复建列 |
| 3 | §6 + §7 组合 | **自相矛盾**：§6 定 `host_user_id ON DELETE SET NULL`，§7 的 CHECK 又要求 `host_type='user'` 时该列 NOT NULL | 见 §5 —— 改为三形态模型 |

---

## §4 身份模型

**唯一 canonical identity = `profiles.id`（= `auth.users.id`）。不存在第二个 user id 空间。**

- 所有 `app_*` 与 `migration.*` 中承载「人」的列，共 **34 个 uuid 身份外键**，**全部**指向 `public.profiles(id)`。契约测试以 catalog 查询穷举验证（不是抽样）。
- App 未获得任何自己的用户表、用户序列或 id 生成器。
- `migration.legacy_identity_crosswalk` 是**迁移工具**：它记录 legacy id → canonical id 的解析过程，本身不是身份系统，验收后降级为只读审计。

### 数据库层强制的身份护栏

| 护栏 | 实现 | 测试 |
|---|---|---|
| 一个 Supabase 账号只能被一条 legacy 记录认领 | `uq_crosswalk_supabase_user`（partial unique） | catalog 断言 |
| 一个 canonical profile 只能被一条 legacy 记录认领 | `uq_crosswalk_canonical_profile` | catalog 断言 |
| email-only 匹配不得自动放行 | `crosswalk_email_only_requires_review` CHECK：`email_match_unreviewed` 与 `verified=true` 互斥 | ✅ 实测被拒 |
| 「已解析」必须真的解析出 profile | `crosswalk_resolved_shape` CHECK | 建约束 |
| 「已复核」必须有复核人与复核时间 | `crosswalk_verified_shape` CHECK | 建约束 |

---

## §5 角色模型 —— App 不引入新角色系统

- **未创建**任何 App 角色表、角色枚举或权限位。授权唯一依据仍是 Portal 的 `public.user_roles` + `user_role` 枚举（9 值，未增未改）。
- `migration.admin_role_migration_manifest` 只是**裁定台账**，不是授权来源。它的护栏：

| 护栏 | 实现 | 测试 |
|---|---|---|
| `RESOLVED` 必须附裁定依据 + 裁定人 + 时间 | `admin_manifest_resolved_requires_evidence` CHECK | ✅ 实测被拒 |
| 目标角色只能取 Portal 既有 9 个角色名 | `admin_manifest_target_roles_domain` CHECK（`<@` 数组包含） | ✅ 实测 `god_mode` 被拒 |
| 「尚未裁定」可表达 | `target_roles` 默认空数组 | — |

> **DB-2 已实测：SQLite 中 `admin` 账号数 = 0**（7 人全为 `student`）。
> 因此 DB-5 的人工裁定队列**预期为空**，但护栏照建 —— 空队列不是不需要护栏的理由。

`app_room_member_role`（`member` / `moderator`）**不是身份角色**，是房间内的运营位，与 Portal 授权体系正交，不参与任何 `user_roles` 判断。

---

## §6 房间哨兵改造（`rooms.host_id`）

### 发现的契约缺陷

DB-1 §6 与 §7 组合起来**不可能同时成立**：

```
§6:  host_user_id  ON DELETE SET NULL
§7:  CHECK ( (host_type='user' and host_user_id is not null) or ... )
```

房主注销 → FK 动作把 `host_user_id` 置 NULL → 撞上 CHECK → **整个 `DELETE FROM profiles` 失败**。
后果不是数据错误，是**任何开过房间的用户永远注销不掉**。

这不是推演，是 DB-3 契约测试实测抓到的：

```
ERROR: new row for relation "app_rooms" violates check constraint "app_rooms_host_shape"
详细: Failing row contains (r_user, user, null, null, null, 2026-09-07 …).
详细: SQL statement "UPDATE ONLY "public"."app_rooms" SET "host_user_id" = NULL …"
```

### 修正：承认「房主已注销」为第三种合法形态

| host_type | host_user_id | host_orphaned_at | 含义 |
|---|---|---|---|
| `system` | NULL | NULL | 5 个内置公共房间 |
| `user` | NOT NULL | NULL | 有房主的真人房间 |
| `user` | NULL | **NOT NULL** | 房主已注销，房间保留（R-10） |

`host_orphaned_at` 由 `BEFORE UPDATE` 触发器写入 —— `ON DELETE SET NULL` 发出的正是一次 UPDATE，
触发器在 CHECK 求值前补上标记，使 SET NULL 与形态约束相容。

### DB-1 §7 的三条验收要求仍然全部成立

| 要求 | 是否满足 | 实测 |
|---|---|---|
| 5 个内置公共房间可合法存在，无需假用户 | ✅ | `PASS 哨兵: system 房间无需假用户即可合法存在` |
| 真人 host 必须有有效 canonical identity | ✅ FK | `PASS 哨兵: 指向不存在 profile 的 host 被 FK 拒绝` |
| 非法 orphan user host 不允许写入 | ✅ CHECK | `PASS 哨兵: 凭空插入无房主的 user 房间被 CHECK 拒绝` |
| *（新增）* 系统房间不得伪装成「房主已注销」 | ✅ CHECK | `PASS 哨兵: 系统房间不得携带「房主已注销」标记` |
| *（新增）* 字符串 `'system'` 不可能进入身份列 | ✅ 类型 | `PASS 哨兵: 字符串 'system' 无法进入 uuid 身份列` |

**三条禁令全部遵守**：没有为 `system` 建假 `auth.users`；没有把字符串塞进 uuid FK；没有为过 migration 禁用任何 FK。

---

## §7 课程来源哨兵（`courses.created_by`）—— D-28

DB-2 实测：`courses.created_by` 的 **67/67 行全部是哨兵** —— `'system'`(35) 与 `'catalog-migration'`(32)，**没有任何一行指向真实用户**。

因此它承接为 `course_catalog.created_by_provenance text`：

- **刻意不设身份 FK**。设了就必须发明一个不存在的「system 用户」，违反 §7 三禁令与 R-7。
- 列名把语义写死为 *provenance*（来源），杜绝将来有人误当作作者。
- 列注释明确写出：若将来出现真人创建的课程，须**另加**一列 `created_by uuid references profiles(id)`，而不是复用本列。

契约测试断言两条：列存在、且该列上**没有**外键约束。

---

## §8 课程目录 —— 不存在第二套

- **未创建** `app_courses` / `app_course_catalog`（契约测试显式断言二者均不存在）。
- `app_course_progress.course_code` 与 `app_course_files.course_code` **直接 FK 到 `public.course_catalog(code)`**。
- DB-1 §4 已实测两侧完全对齐：67 vs 67，交集 67，双向差集 0。
- `course_catalog` 本轮只**加列**，未改既有列、未删数据。实测应用前后课程数恒为 67。

`app_course_progress.course_code` 用 **`ON DELETE RESTRICT`**：仍有学习进度的目录条目不得被删除。
实测通过。
> **【DB-3.5 更正】** 原文写「RESTRICT 抛 `restrict_violation` 23001」——那是 **PG 18** 的行为。**目标版本 17.6 抛 `foreign_key_violation` 23503**，且在 17.6 上 RESTRICT 与 NO ACTION 的 SQLSTATE **无法区分**。

---

## §9 TYPE A 后端拥有的表（D-20）

| 表 | 语义 | 客户端可达性 |
|---|---|---|
| `app_course_progress` | 学习进度 | RLS 开启，anon/authenticated **零权限** |
| `app_christian_profile` | Christian Profile 状态 | 同上 |
| `app_practice_training_state` | 实践训练状态 | 同上 |

### Christian Profile 契约（DB-1 §10 / D-19 OPTION A）

- `state jsonb` 是**不透明 blob**。数据库不解释其内部结构，**未建任何内部字段索引**，未拆表、未规范化、未重命名任何内部评分字段。
- 两个溯源列按 §10.3 分工：
  - `source_raw_hash` —— 迁移前 SQLite 原始字节 SHA256，**仅供溯源与争议仲裁，不作通过条件**（`jsonb` 会重排 key，用它判定必然误判）。
  - `canonical_semantic_hash` —— 语义规范化后的 SHA256，**这才是验收判据**。
- **本轮未迁移任何 CP 数据**（DB-2 实测 `growth_state` = 0 行）。三层 Gate 属 DB-7。

---

## §10 外键生命周期

**未做机械式全 CASCADE。** 49 个 `app_*` 外键逐条裁定：

| ON DELETE | 数量 | 语义 |
|---|---|---|
| `CASCADE` | 28 | 关系/信号/个人私有状态：随人消失无损失 |
| `SET NULL` | 20 | 内容/治理/审计记录：**R-10 保留内容、置空作者** |
| `RESTRICT` | 1 | `app_course_progress.course_code`：目录不得在仍被引用时删除 |

### R-10 tombstone 的实现

4 张表（`app_posts` / `app_post_comments` / `app_prayer_shares` / `app_recordings`）带
**派生列** `author_state`：

```sql
author_state text generated always as
  (case when user_id is null then 'deleted_account' else 'active' end) stored
```

它是 `GENERATED ALWAYS ... STORED`，**不承载新信息**，随 `user_id` 自动保持一致 ——
tombstone 状态因此**不可能与 `user_id` 漂移**（手写维护迟早会漂）。

`app_posts` / `app_post_comments` 的 `user_id` 由源库的 `NOT NULL` **放宽为可空**，这是 DB-1 §6 的明确要求：没有可空就没有 tombstone，只能在「删内容」和「给内容安一个假作者」之间二选一，两者都违反 R-10。

### 实测的生命周期行为

删除一个持有房间、成员资格、祷告分享、代祷、动态、CP 的用户后：

```
PASS  R-10: 祷告分享内容保留、作者置空
PASS  R-10: 祷告分享 author_state 自动变为 deleted_account
PASS  R-10: 动态保留、作者置空、作者快照仍在
PASS  R-10: 房主注销后房间保留，标记为「房主已注销」，且未变成系统房间
PASS  CASCADE: room membership 随人消失
PASS  CASCADE: 代祷计数信号随人删除
PASS  CASCADE: 成长档案随人删除
PASS  他人的点赞不受影响
```

---

## §11 类型转换契约（DB-1 §8）

| # | 契约 | 实现 | 实测 |
|---|---|---|---|
| 1 | `INTEGER` 0/1 → `boolean` | `app_prayer_shares.is_anonymous boolean` | ✅ |
| 2 | `TEXT` JSON → `jsonb` | `state` / `images_json` / `shared_room_json` / `evidence` | ✅ |
| 3 | epoch ms → `timestamptz` | 全部时间列（转换式 `to_timestamp(v/1000.0)` 属 DB-4+） | ✅ |
| 4 | `CHECK IN (...)` → 原生 enum | 9 个 `app_*` 枚举 | ✅ 值域外的值被拒 |
| 5/6 | `INSERT OR IGNORE` / `ON CONFLICT` | 部分唯一索引作冲突目标 | ✅ 见下 |
| 7 | `lastInsertRowid` → `RETURNING id` | `app_room_realtime_events` | ✅ |
| 8 | `COLLATE NOCASE` 唯一性 | 交由 Supabase Auth 承担（`users` 不迁） | 见 DBR-20 |
| 9 | TEXT uuid 主键 → `uuid` | **按真实生成器逐表裁定**，见下 | ✅ |
| 12 | `AUTOINCREMENT` → identity | `bigint generated always as identity` | ✅ 递增且可 RETURNING |

### #9 —— 主键类型不是一刀切

DB-1 §8 #9 写的是「TEXT uuid 主键 → `uuid`」。**实测表明不能全部这样做**：

| 生成器 | 涉及表 | 形态 | 目标类型 |
|---|---|---|---|
| `crypto.randomUUID()` | posts / comments / friend_requests / library / recordings / images / announcements / cooperation / course_files | 合法 uuid | `uuid` |
| `crypto.randomBytes(9).toString('hex')`（`routes/prayer.ts:27`、`routes/prayerSession.ts:25`） | prayer_shares / share_reports / room_prayer_topics / prayer_sessions / session_items / session_events | **18 位 hex，非 uuid** | `text` |
| 人类可读房间码 | rooms | `bible_reading` 等 | `text` |
| 课程代码 | courses | `c_matthew` 等 | `text`（= `course_catalog.code`） |

实测佐证：`prayer_shares.id` 12/12 非 uuid（样本 `1013a5683b195c40c6`）；`rooms.room_id` 7/7 非 uuid；`courses.id` 67/67 非 uuid；`users.id` 7/7 是 uuid；`course_files.id` 68/68 是 uuid。

**若照 DB-1 字面声明为 `uuid`，这些表会在类型转换处整批失败。** 契约测试把这条钉死为断言。

### #5/#6 —— 部分唯一索引的 `ON CONFLICT` 陷阱（实测复现）

```sql
-- ✗ 失败：ERROR: there is no unique or exclusion constraint matching the ON CONFLICT specification
on conflict (room_id, user_id, client_request_id) do nothing

-- ✓ 正确：必须重复索引的 WHERE 谓词
on conflict (room_id, user_id, client_request_id) where client_request_id is not null do nothing
```

SQLite 的「任意约束冲突即忽略」范围更宽，直译过去**不是静默降级，是运行时报错** ——
每一次幂等重放都会变成 500。已固化为两条测试（缺谓词必失败 / 带谓词正确去重），供 DB-12 的 DAL 改造对照。

---

## §12 幂等支持（最小化）

**只承接源库已有的幂等能力，未发明新的。**

- `app_prayer_shares.client_request_id` + 部分唯一索引 `uq_app_prayer_shares_idem`（源 `uniq_share_idem` 的等价物）。
- `app_prayer_sessions` **未**添加 `client_request_id`。DB-1 §15 待决 #3 把「祷告会创建是否补幂等键」归属 GPT、可延后至 DB-9。本轮不越权补。
- 实测三条：无谓词的 `ON CONFLICT` 被拒 · 带谓词正确去重 · 无幂等键的行不被误去重（部分索引语义正确）。

---

## §13 索引

**31 个普通索引 + 2 个部分唯一索引**，逐条有来源，无凭空添加。

### 来源一：源库 25 个索引（它们本身就是真实查询模式的沉淀）

21 个建立等价物；**4 个刻意不建**，因为在 Postgres 侧已被现有索引前缀完全覆盖：

| 源索引 | 不建的理由 |
|---|---|
| `idx_push_tokens_user(user_id)` | PK `(user_id, token)` 前缀即覆盖 |
| `idx_friend_requests_from(from_user_id)` | `UNIQUE (from_user_id, to_user_id)` 前缀即覆盖 |
| `idx_reports_share(share_id)` | `UNIQUE (share_id, reporter_user_id)` 前缀即覆盖 |
| `idx_session_items(session_id, position)` | `UNIQUE (session_id, position)` 完全相同 |

另 `idx_courses_created_at` 未在 `course_catalog` 上重建：67 行的表，顺序扫描比维护索引便宜。
`idx_users_email` 随 `users` 表一并不迁 —— 邮箱唯一性与查找归 Supabase Auth。

### 来源二：外键反向查找（Postgres **不会**为外键自动建索引）

10 个：`app_course_files.uploader_id` · `app_image_uploads.uploaded_by` · `app_room_members.user_id` ·
`app_prayer_shares.user_id` · `app_prayer_session_events.actor_user_id` · `app_prayer_sessions.created_by` ·
`app_prayer_intercessions.user_id` · `app_posts.user_id` · `app_post_comments.user_id` ·
`app_post_likes.user_id` · `app_friendships.user_b` · `app_library_favorites.book_id` 等。

缺了它们，**每一次用户注销都会对每张子表做全表扫描**（CASCADE / SET NULL 必须找出所有引用行）。

### 来源三：治理与迁移查询

`idx_app_prayer_share_reports_open`（部分索引，只索引 `status='open'` 的待处理举报）· `idx_crosswalk_method` · `idx_row_manifest_table_status`。

---

## §14 RLS 与授权边界

### 采取的立场：fail-closed，不写投机性 policy

- **28 张 `app_*` 表全部 `ENABLE ROW LEVEL SECURITY`**。
- **`anon` / `authenticated` 对 28 张表零权限**（`REVOKE ALL`）。契约测试用 `information_schema.role_table_grants` 穷举验证，不是抽样。
- **未建任何放行 policy。**

理由：App 当前的访问路径是 Express 后端（服务端持特权连接），客户端不直连数据库。
在真正需要客户端直连之前写「看起来对」的 policy，正是 **R-2 的权限展示 ≠ 权限控制**，
而且会在无人验证的情况下留下放行面。客户端直连所需的 policy 由后续 migration 在有明确需求时显式添加并单独验收。

### `migration` schema

`REVOKE USAGE FROM anon, authenticated` —— 迁移台账含身份映射与裁定依据，对客户端完全不可见。实测两条断言通过。

### 敏感表特别标注

`app_cooperation_submissions` 含来件人姓名与邮箱。任何对客户端的放行都是个人信息泄露，migration 内已写明必须保持 fail-closed。

---

## §15 Migration 测试

`supabase/tests/db3_schema_contract.sql` —— **52 条断言，全部通过**。

设计原则：**断言行为，不断言「表建出来了」**。一张名字建对但外键生命周期错了的表会静默毁数据，而 schema 快照看不出来。

| 组 | 条数 | 覆盖 |
|---|---|---|
| GATE 0 | 3 | 扩展表不存在 · `bio` 在 canonical · 长度上限生效 |
| 身份唯一性 | 2 | 穷举 34 个身份 FK 全部指向 `profiles(id)` |
| 系统哨兵 | 6 | 五种合法/非法形态 + 字符串不可进 uuid 列 |
| FK 生命周期 | 9 | 真删一个用户，逐表验证 CASCADE / SET NULL / tombstone 的实际结果 |
| 类型契约 | 8 | boolean / jsonb / timestamptz / enum / PK 类型 / identity |
| 幂等 | 3 | 含 `ON CONFLICT` 谓词陷阱 |
| 循环 FK 与生命周期 | 4 | DEFERRABLE 正反面 · 单场 active 会话 · 会话状态形态 |
| 迁移工具护栏 | 5 | email-only 不得 verified · RESOLVED 需证据 · 角色名值域 · 状态值域 · 版本基线 |
| fail-closed | 4 | 表授权 · RLS 开启 · `migration` schema 不可达 ×2 |
| 课程 | 5 | 无第二目录 · FK 到 canonical · D-28 provenance 无 FK · RESTRICT |
| Portal 回归 | 3 | 既有表完好 · 授权函数仍 fail-closed |

全程单事务 + 结尾 `ROLLBACK`，**不留任何测试数据**（R-7）。实测残留行数 = 0。

### 回退演练

`supabase/tests/db3_rollback.sql` 已**实际执行并验证**。回退后与 `0022` 基线逐项一致：

| 对象 | 0022 基线 | DB-3 回退后 |
|---|---|---|
| public 表数 | 26 | 26 ✔ |
| **public 列数** | **245** | **245 ✔** |
| RLS policy | 33 | 33 ✔ |
| enum 类型 | 15 | 15 ✔ |
| public 函数 | 96 | 96 ✔ |
| 触发器 | 21 | 21 ✔ |
| 外键 | 38 | 38 ✔ |
| `migration` schema | 0 | 0 ✔ |

列数相等是关键证据 —— 它证明 `course_catalog` 的 4 个扩展列与 `profiles.bio` 被完全摘除，没有残留。

**回退 → 前滚 → 52/52 再次全过**，双向可逆已验证。

---

## §16 验证环境与执行结果

**未标记 `BLOCKED_BY_ENV`：本轮找到并使用了真实的 PostgreSQL。**

| 项 | 值 |
|---|---|
| 引擎 | **PostgreSQL 18.6**（本地 scoop 安装，`127.0.0.1:5432`） |
| 验证库 | `amas_db3_verify`（全量）· `amas_baseline`（仅 `0001..0022`，作回归对照） |
| 平台垫片 | `scratchpad/shim.sql` —— 复刻 Supabase 在 migration 运行前已存在的对象：`anon`/`authenticated`/`service_role` 角色、`auth` schema、`auth.users`、`auth.uid()`/`auth.role()`/`auth.jwt()`、`pgcrypto` |

### 执行结果

| 检查 | 结果 |
|---|---|
| `0001` → `0026` 顺序应用 | **26/26 成功**（含此前从未执行的 `0022`，其内置断言亦通过） |
| `0023..0026` 重复应用（幂等） | **4/4 成功** |
| 契约测试 | **52/52 PASS**，退出码 0 |
| 回退脚本 | 成功，与基线逐项一致 |
| 回退后前滚 + 复测 | **52/52 PASS** |

### Portal 回归（`0001..0022` 基线 vs 应用 DB-3 之后）

| 对象 | 基线 | DB-3 后 | |
|---|---|---|---|
| Portal 表数（非 `app_`） | 26 | 26 | ✔ |
| RLS policy | 33 | 33 | ✔ |
| Portal enum | 15 | 15 | ✔ |
| public 函数 | 96 | 96 | ✔ |
| 触发器 | 21 | 21 | ✔ |
| 启用 RLS 的 Portal 表 | 26 | 26 | ✔ |
| `course_catalog` 行数 | 67 | 67 | ✔ |
| `program_catalog` 开放申请数 | 4 | 4 | ✔ |

**DB-3 未删改任何 Portal 既有对象。**

---

## §17 验证边界 —— 「LOCALLY VERIFIED」到底证明了什么

**必须明确，避免把本轮结果当成比实际更强的保证。**

### 已经真实验证的

- 全部 DDL 在真实 PostgreSQL 引擎上**可执行**，26 个 migration 顺序无冲突。
- 外键生命周期（CASCADE / SET NULL / RESTRICT）的**实际删除行为**，用真实的用户注销操作验证。
- CHECK / enum / 派生列 / DEFERRABLE FK / 部分唯一索引 / identity 列的**运行时语义**。
- `anon` / `authenticated` 的**表级授权确实为空**，`migration` schema 确实不可达。
- 回退与前滚**双向可逆**。

### 未验证的（不得当作已验证）

| 项 | 原因 | 后续归属 |
|---|---|---|
| 真实 Supabase 环境 | 本地无 Docker，`supabase start` 不可用；用垫片复刻平台对象 | RB-03 建立 production/staging 验证 |
| **PG 版本差异** | 本地 **18.6**，Supabase staging 是 **17.6**。所用特性（generated stored 列 PG12+、identity PG10+、deferrable FK、部分索引）在 17.6 均支持，但**未在 17.6 上实际执行过** | DB-4 前必须在 17.6 上重跑一次 → **DBR-22** |
| RLS 在真实 JWT 下的运行时行为 | 本轮未建任何 policy（fail-closed），无可测行为；Portal 既有 33 条 policy 只做了存在性回归，未做否定式测试 | 迁移后重跑 STEP 5 否定式全套 |
| Supabase 平台侧对象 | `storage`、`realtime` publication、Edge Functions 未纳入 | RB-03 |
| 任何业务数据迁移 | **DB-3 是 schema only（D-29）**，本轮写入的业务数据行数 = 0 | DB-4 ～ DB-11 |

---

## §18 Schema 版本基线（TASK 18）

SQLite 靠 `PRAGMA table_info` 运行期探测 schema 形态；Postgres 没有这个机制，
改由**版本化 migration + 显式断言**承担（DB-1 §8 #11）。

`migration.schema_baseline` 已登记：

| contract_version | migration_files | source_sqlite_sha256 | source_table_count |
|---|---|---|---|
| `DB-3.0` | `0023_app_foundation .. 0026_app_community` | `0798526d34a24c75696a305d65eafe2e` | 32 |

该 SHA256 正是 DB-2 只读审计所用 SQLite 文件的指纹（450560 bytes，32 业务表 / 285 行）。
**目标 schema 与它所依据的源基线由此可追溯配对** —— 将来源库若变化，指纹不匹配即暴露。

契约测试断言该行存在。

---

## 新增决策

### D-27｜Migration 归属

**Decision**：`amas-website/supabase/migrations` 是 AMAS Supabase database 的**唯一** migration source of truth。App repo 不得建立第二套 Supabase migrations，只保留离线迁移工具（读 SQLite、产出 manifest、写 Postgres），不含 DDL。
**Why**：Portal 与 App 迁移后共用同一个数据库；两套竞争的 migration 目录必然产生「谁先跑」「版本号撞车」「schema 漂移」三类问题。与 D-9 的治理文档归属一致。

### D-28｜`courses.created_by` 是来源标记，不是身份

**Decision**：承接为 `course_catalog.created_by_provenance text`，**刻意不设外键**。若将来出现真人创建的课程，须另加一列 `created_by uuid references profiles(id)`，不得复用本列。
**Why**：DB-2 实测 67/67 行全部是哨兵（`system` / `catalog-migration`），无一指向真实用户。设成 uuid FK 就必须发明一个不存在的「system 用户」，违反 §7 三禁令与 R-7。

### D-29｜DB-3 是 schema only

**Decision**：DB-3 只创建结构，不迁移任何一行业务数据。数据迁移在 DB-4 ～ DB-11 分阶段进行，每阶段独立验收与回退。
**Why**：结构与数据同批推进会让失败无法归因 —— 分不清是 schema 错了还是转换错了，也无法单独回退。

### D-30｜`app_user_profile_ext` = DO NOT CREATE

**Decision**：不创建 App 用户扩展表。`bio` 以一列扩展 canonical `profiles`；`degree` 不迁移，App 学位展示改读 `student_records.program_code`。
**Why**：`degree` 实测 7/7 全 NULL、由用户自选、非权威学籍，迁移它会制造第二个学位真相源（R-2）；`bio` 是通用档案属性，能放进 canonical schema，因此按 GATE 0 规则不得为它单开表。
**How to apply**：新增 App 用户字段前先问「canonical schema 能否承载」；能承载就扩展 canonical，不能才考虑扩展表。

### D-31｜`app_rooms` 三形态房主模型

**Decision**：`host_type` × `host_user_id` × `host_orphaned_at` 三形态；「房主已注销」是第三种合法形态，由 `BEFORE UPDATE` 触发器标记。
**Why**：DB-1 §6 的 `ON DELETE SET NULL` 与 §7 的 `NOT NULL` CHECK 不可能同时成立 —— 实测证明它会让任何开过房间的用户**永远无法注销**。三形态在保住 §7 全部验收要求的同时让注销路径可用。
**How to apply**：凡是「保留内容 + 置空作者」的表，若同时有形态 CHECK，必须先验证注销路径能跑通，不能只看约束本身是否合理。

### D-32｜主键类型跟随真实 id 生成器

**Decision**：目标 PK 类型按每张表**实际的 id 生成器**裁定，不一刀切成 uuid。`randomUUID()` 的表用 `uuid`；`randomBytes(9).toString('hex')` 与人类可读码的表用 `text`。
**Why**：DB-1 §8 #9 字面写「TEXT uuid 主键 → uuid」，但实测 `prayer_shares` / `rooms` / `courses` 的 id 根本不是 uuid，照字面执行会在转换处整批失败。
**How to apply**：类型契约必须以**代码里的生成器 + 全表实测形态**为准，不能以列名或惯例推断。

---

## 新增 / 更新问题

| ID | 严重度 | 内容 | 归属阶段 |
|---|---|---|---|
| **DBR-20** | Medium | `users.email` 的 `COLLATE NOCASE` 唯一性在迁移后由 Supabase Auth 承担；`profiles.email` 本身**没有**大小写不敏感唯一索引。需确认 Auth 侧规则足以防止大小写不同的重复账号 | DB-4 |
| **DBR-21** | Medium | App `avatar` 混存三种形态（上传 URL / data URI / 前端生成图），Portal `avatar_path` 语义是 storage path。实测 7/7 全 NULL，**当前迁移成本为 0**，但 App 侧写入路径须先归一 | DB-12 |
| **DBR-22** | ~~High~~ **CLOSED（DB-3.5）** | 本轮在 **PG 18.6** 验证，Supabase staging 是 **PG 17.6**。所用特性在 17.6 均支持但**未实测**。DB-4 开始前必须在 17.6 上重跑 `0023..0026` + 契约测试 | DB-4 前置 |
| **DBR-23** | Low | DB-0 记录 Portal 有「36 条 RLS policy」，本轮由 `0001..0022` 复现得到 **33 条**（基线与 DB-3 后一致，非本轮回归）。差异来源需核对（可能 DB-0 统计口径含 `storage` 等其他 schema） | DB-4 |
| **DBR-24** | Medium | DB-12 的 DAL 改造必须处理：部分唯一索引作 `ON CONFLICT` 目标时**必须重复 WHERE 谓词**，否则每次幂等重放变 500；**【DB-3.5 更正】** `RESTRICT` 在**目标版本 17.6 抛 `foreign_key_violation`(23503)**；`restrict_violation`(23001) 是 PG 18 才引入的，DAL **不得**依赖它 | DB-12 |

---

## 交付物

| 文件 | 行数 | 说明 |
|---|---|---|
| `supabase/migrations/0023_app_foundation.sql` | — | migration 工具 schema · `profiles.bio` · 9 枚举 · `app_image_uploads` |
| `supabase/migrations/0024_app_learning.sql` | — | `course_catalog` 扩展 · 课程文件 / 进度 · CP · PT |
| `supabase/migrations/0025_app_rooms_prayer.sql` | — | 房间 6 表 + 祷告 6 表 |
| `supabase/migrations/0026_app_community.sql` | — | 社群 3 表 + 附属 8 表 |
| `supabase/tests/db3_schema_contract.sql` | — | 52 条行为断言 |
| `supabase/tests/db3_rollback.sql` | — | 已实测的回退脚本 |
| 合计 | **1691** | |

---

## 停止条件确认

| 禁令 | 遵守情况 |
|---|---|
| 不修改 SQLite 数据 | ✅ 仅以 `{readonly:true}` 打开临时副本 |
| 不做 DAL 改动 / 不切驱动 | ✅ App repo 本轮零代码改动 |
| 不做真实数据迁移 | ✅ 业务数据写入行数 = 0 |
| 不创建 production Supabase | ✅ 全部在本地验证库 |
| 不删除 SQLite | ✅ |
| 不重算 Christian Profile | ✅ `state` 为不透明 blob，未建内部索引、未拆表、未改字段名 |
| 不自动授予角色 | ✅ 未插入任何 `user_roles` 行；manifest 无默认目标角色参数 |
| 不改运行期白名单 | ✅ |
| 不伪造通过 | ✅ 找到真实 PostgreSQL 才做验证；未验证项在 §17 逐条列明 |
| 不开始 DB-4 | ✅ |

---

## 最终状态

> # `LOCALLY VERIFIED / READY FOR DB-4 REVIEW`

**READY 的依据**：26 个 migration 顺序应用成功 · 52 条行为断言全过 · Portal 回归零差异 · 回退与前滚双向可逆 · 业务数据写入为 0。

**DB-4 的硬前置**：**DBR-22** —— 必须先在 PostgreSQL 17.6 上重跑 `0023..0026` 与契约测试。
本轮的验证引擎是 18.6，版本差异未实测，不能凭「特性都支持」就跳过。

**DB-4 的输入已就绪**：`migration.legacy_identity_crosswalk` 与 `migration.row_manifest` 已建成并带全部护栏；
DB-2 已实测 `legacy_user_map` = 0 行、`admin` 账号 = 0 个、email-only 映射 = 0 条，
因此 DB-4 的人工复核队列**预期为空** —— 但护栏与流程照走，空队列不是免检的理由。
