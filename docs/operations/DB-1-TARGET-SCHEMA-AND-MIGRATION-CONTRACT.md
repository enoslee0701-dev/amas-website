# DB-1 TARGET SCHEMA & MIGRATION CONTRACT REPORT

**日期**：2026-09-07 · **阶段**：RB-01 PHASE DB-1
**性质**：**定版设计与契约**。未修改 production DAL、未切 driver、未执行真实数据 migration、未创建 production Supabase、未删除 SQLite、未改变产品业务行为。
**起点**：App `main = 61cb31e` · Website `master = d6174f3`

---

## 1. Decisions Applied

| # | 决策 | 本报告落实位置 |
|---|---|---|
| **D-18** | Legacy App `admin` 无自动 Portal 角色映射，必须逐人显式裁定 | §3 · `ADMIN_ROLE_MIGRATION_MANIFEST` |
| **D-19** | Christian Profile 以 **preserve blob** 迁移，迁移期不重算、不规范化 | §10 |
| **D-20** | `course_progress` / `growth_state` 定为 **TYPE A（backend-owned）** | §5 · §6 |
| **D-21** | App `users` 并入 canonical Supabase/Portal 身份，**不保留第二个可写身份空间** | §2 · §5 |

---

## 2. Final Identity Model

### 2.1 关联键裁定 —— 用 `profiles.id`

依 DECISION 4「根据现有真实 Supabase schema 决定，不要为符合文字改已有正确 schema」。

实测 `0002_identity.sql`：

```sql
create table profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  ...
)
```

> **`profiles.id` 本身就是 `auth.users.id`**（同值主键 + 外键，`ON DELETE CASCADE`）。
> **不存在** `profiles.user_id` 这一列。现有 schema 已经正确，**不改**。

### 2.2 最终身份模型

```
auth.users.id (uuid)          ← Supabase 拥有，唯一认证身份
      │  (PK = FK, ON DELETE CASCADE)
      ▼
profiles.id (uuid)            ← canonical application person identity
      │
      ├── user_roles.user_id            授权
      ├── login_aliases                 学号/教职工号
      ├── applications / student_records / teacher_profiles
      └── ★ 迁移后：App 全部 owner 列直接 FK 到 profiles.id
```

**一个真人只能有一个 canonical identity。** 迁移后不存在第二个可写身份空间（D-21）。

### 2.3 `LEGACY_IDENTITY_CROSSWALK`

**它是迁移工具，不是新的业务身份系统。** 目标 schema：

```sql
-- 迁移期表；迁移完成并验收后降级为只读审计记录，永不进业务查询路径
create table migration.legacy_identity_crosswalk (
  legacy_sqlite_user_id  text primary key,
  supabase_auth_user_id  uuid,                       -- 可空：尚未解析
  canonical_profile_id   uuid references profiles(id),
  mapping_method         text not null,              -- 见下方枚举
  mapping_confidence     text not null,              -- high | medium | low
  verified               boolean not null default false,
  verified_by            uuid,
  verified_at            timestamptz,
  evidence               jsonb not null default '{}'::jsonb,
  notes                  text,
  created_at             timestamptz not null default now()
);
create unique index on migration.legacy_identity_crosswalk (supabase_auth_user_id)
  where supabase_auth_user_id is not null;
```

`mapping_method` 枚举与置信度：

| method | 含义 | confidence | 可否自动放行 |
|---|---|---|---|
| `provisioned_by_migration` | 迁移脚本据 legacy 记录**在 Supabase 新建**的账号 | **high** | ✅ 是。账号由本次迁移创建，归属定义上无歧义 |
| `explicit_operator_link` | 运维/教务显式指定 | **high** | ✅ 是（已有人工判断） |
| `email_match_reviewed` | 邮箱相同 **且** 经人工复核 | medium | ✅ 是 |
| **`email_match_unreviewed`** | **仅邮箱相同，无其他证据** | **low** | ❌ **否 —— 必须转人工复核** |
| `unresolved` | 无法解析 | — | ❌ 否 |

---

## 3. Final Role Mapping

### 3.1 ROLE_MAPPING_MATRIX

| Legacy (App) | Target (Portal) | Automatic? | Requires Review? | Privilege ↑ | Privilege ↓ | Evidence Required |
|---|---|---|---|---|---|---|
| `student` | `student` | ✅ 是 | 否 | 否 | 否 | 无 |
| **`admin`** | **不自动映射** | ❌ **否** | **是（逐人）** | **可能** | **可能** | **必需** |

Portal 现有 9 个角色在本次迁移中的处置：

| Portal 角色 | 迁移中是否授予 | 说明 |
|---|---|---|
| `student` | ✅ 由 `student` 自动映射 | 唯一自动路径 |
| `applicant` | ❌ 否 | App 无对应概念；只能由 Portal 注册流程产生 |
| `teacher` | ❌ 否 | 只能由教师验证闭环授予（SEC-2 受保护流程） |
| `mentor` | ❌ 否 | 关系表未实现 |
| `registrar` | ⚠ 仅经 §3.2 人工裁定 | **在 `ADMIN_ROLES` 内** |
| `academic_admin` | ⚠ 仅经 §3.2 人工裁定 | **在 `ADMIN_ROLES` 内** |
| `super_admin` | ⚠ 仅经 §3.2 人工裁定 | **在 `ADMIN_ROLES` 内**，权限最高 |
| `content_admin` | ⚠ 仅经 §3.2 人工裁定 | **不在 `ADMIN_ROLES` 内** —— 授予它等于**降权** |
| `finance` | ❌ 否 | App 无财务概念 |

> **`ADMIN_ROLES = {registrar, academic_admin, super_admin}`**（`auth/supabase.ts:111`）。
> 把 App 的 `admin` 映射成 `content_admin` 会让原管理员**静默失去管理能力**；
> 映射成 `super_admin` 则是**未经授权的提权**。两者都不可接受，故 D-18 禁止任何全局映射。

### 3.2 `ADMIN_ROLE_MIGRATION_MANIFEST`

```sql
create table migration.admin_role_migration_manifest (
  legacy_user_id     text primary key,
  canonical_user_id  uuid references profiles(id),
  legacy_role        text not null,                 -- 恒为 'admin'
  target_roles       text[] not null default '{}',  -- 空数组 = 尚未裁定
  mapping_basis      text,                          -- 裁定依据（自由文本，必填于 RESOLVED）
  review_status      text not null
                     check (review_status in ('RESOLVED','NEEDS_MANUAL_REVIEW')),
  reviewed_by        uuid,
  reviewed_at        timestamptz,
  notes              text
);
```

**迁移流程硬约束**：

```
任一 legacy_role='admin' 且 review_status <> 'RESOLVED' 的行存在
        ↓
整个角色迁移阶段停在 NEEDS_MANUAL_ROLE_REVIEW，不继续
        ↓
该账号在 user_roles 中**不获得任何管理角色**（可先只授予 student）
```

**不得猜测权限。** 迁移工具不提供「默认目标角色」这个参数。

---

## 4. Course Mapping

### 4.1 实测结果 —— 已完全对齐

```
App  services/catalog.ts  OFFICIAL_CATALOG      67 条
Portal course_catalog                            67 条
交集                                             67
App 独有                                          0
Portal 独有                                       0
App RETIRED_COURSE_IDS                            4  （两侧目录均已移除）
     c_dr_johannine · c_dr_pastoral · c_dr_peter · c_healing
```

`course_catalog.code` 的注释明写「与 App OFFICIAL_CATALOG 的 id 一致（`c_matthew…`）」，
且 App 侧已有 `backend/scripts/migrate-catalog.ts` 做同步。

### 4.2 COURSE_MAPPING_MATRIX

| 检查项 | 结果 |
|---|---|
| **code collision** | **0** —— 两侧 code 完全同名同义 |
| **missing course**（App 有 Portal 无） | **0** |
| **renamed course** | **0**（唯一已知名称漂移「世界观理解 / 世界观」是**官网文案**与目录的差异，D-2B-2 已裁定以目录为准，不影响 code） |
| **Portal 独有** | **0** |

**结论**：`App course id ──1:1──► course_catalog.code`，**禁止新建 `app_courses`**。
App `courses` 表的独有列并入 `course_catalog`（见 §5）。

### 4.3 历史 `course_progress` 的孤儿课程

**唯一真实风险**：`course_progress.course_id` 可能引用 4 个 retired id 或更早的未知 id。

```
迁移契约：course_progress 导入前必须先跑孤儿课程扫描
  course_id ∈ course_catalog.code            → 正常迁移
  course_id ∈ RETIRED_COURSE_IDS             → 迁入，但标记 legacy_retired，
                                                **不得静默丢弃**（学习历史属实践证据）
  course_id ∉ 两者                            → 停在 NEEDS_MANUAL_REVIEW
```

> **历史学习进度不得因为课程名称/编码变化而静默丢失**（TASK 4 硬要求）。
> 处置方式是**标记后保留**，不是删除。

---

## 5. Target Table Matrix

32 张 SQLite 表，每张一个明确结果。**无 TBD。**

| # | SQLite Table | 结果 | Target | 说明 |
|---|---|---|---|---|
| 1 | `users` | **MERGE INTO EXISTING** | `profiles` | D-21。`degree`/`bio` 见 #2；`password_hash`/`salt` **DO NOT MIGRATE**（Supabase 已持凭据，复制是纯负债）；`role` 走 §3 manifest |
| 2 | *(App 专属用户字段)* | **CREATE NEW** | `app_user_profile_ext` | 承接 `degree` / `bio` 等 Portal `profiles` 不宜承载的 App 字段。`user_id uuid PK REFERENCES profiles(id) ON DELETE CASCADE`。**不产生第二个 user id** |
| 3 | `legacy_user_map` | **TRANSFORM** | `migration.legacy_identity_crosswalk` | §2.3。迁移工具，非业务表 |
| 4 | `refresh_jti` | **DO NOT MIGRATE** | — | RB-27 死表，AUTH-M7 后无写入方 |
| 5 | `courses` | **MERGE INTO EXISTING** | `course_catalog` | §4。独有列 `thumbnail` / `thumbnail_image_id` / `total_lessons` / `created_by` → **EXTEND EXISTING** |
| 6 | `course_progress` | **CREATE NEW** | `app_course_progress` | TYPE A（D-20）。`user_id → profiles(id)`，`course_code → course_catalog(code)` |
| 7 | `course_files` | **CREATE NEW** | `app_course_files` | `course_code → course_catalog(code)` |
| 8 | **`growth_state`** | **TRANSFORM** | `app_christian_profile` | §10。TYPE A（D-20）。blob 保持 |
| 9 | `pt_state` | **CREATE NEW** | `app_practice_training_state` | 同为 per-user JSON blob |
| 10 | `rooms` | **TRANSFORM** | `app_rooms` | §7 系统哨兵改造 |
| 11 | `room_members` | **CREATE NEW** | `app_room_members` | 已有 FK，直迁 |
| 12 | `room_presence` | **DO NOT MIGRATE** | `app_room_presence`（建表不迁数据） | 易失（TTL 45s），迁移后自然重建 |
| 13 | `room_realtime_events` | **DO NOT MIGRATE** | `app_room_realtime_events`（建表不迁数据） | 易失事件流 |
| 14 | `room_reading_state` | **CREATE NEW** | `app_room_reading_state` | 已有 FK |
| 15 | `room_prayer_topics` | **CREATE NEW** | `app_room_prayer_topics` | |
| 16 | `prayer_sessions` | **CREATE NEW** | `app_prayer_sessions` | 已有 3 个 FK |
| 17 | `prayer_session_items` | **CREATE NEW** | `app_prayer_session_items` | |
| 18 | `prayer_session_events` | **CREATE NEW** | `app_prayer_session_events` | 事件历史，见 §6 生命周期 |
| 19 | `prayer_shares` | **CREATE NEW** | `app_prayer_shares` | R-10 tombstone 语义保持 |
| 20 | `prayer_intercessions` | **CREATE NEW** | `app_prayer_intercessions` | |
| 21 | `prayer_share_reports` | **CREATE NEW** | `app_prayer_share_reports` | 治理记录，见 §6 |
| 22 | `posts` | **CREATE NEW** | `app_posts` | R-10 tombstone |
| 23 | `post_likes` | **CREATE NEW** | `app_post_likes` | |
| 24 | `post_comments` | **CREATE NEW** | `app_post_comments` | R-10 tombstone |
| 25 | `friend_requests` | **CREATE NEW** | `app_friend_requests` | 双 owner FK |
| 26 | `friendships` | **CREATE NEW** | `app_friendships` | 双 owner FK |
| 27 | `library_books` | **CREATE NEW** | `app_library_books` | 无 owner |
| 28 | `library_favorites` | **CREATE NEW** | `app_library_favorites` | |
| 29 | `recordings` | **CREATE NEW** | `app_recordings` | |
| 30 | `image_uploads` | **CREATE NEW** | `app_image_uploads` | |
| 31 | `push_tokens` | **CREATE NEW** | `app_push_tokens` | |
| 32 | `announcements` | **CREATE NEW** | `app_announcements` | |
| 33 | `cooperation_submissions` | **CREATE NEW** | `app_cooperation_submissions` | Portal 已有 `submissions`，语义不同（App 是同工合作，Portal 是官网收件箱）—— **不合并** |

**汇总**：MERGE 2 · EXTEND 1 · CREATE NEW 25 · TRANSFORM 3 · DO NOT MIGRATE 3（含 2 张建表不迁数据）

> **`app_` 前缀的用意**：与 Portal 既有表在同一 schema 内明确区分归属，
> 避免未来有人误以为 `posts` 是 Portal 的学籍相关表。
> **它不代表第二个身份空间** —— 所有 owner 列都 FK 到 `profiles.id`。

---

## 6. User-owned FK Model

**不机械全部 `ON DELETE CASCADE`。** 按业务意义逐张裁定：

| Table | Owner 列 | Nullable | ON DELETE | ON UPDATE | Orphan 处理 | 理由 |
|---|---|---|---|---|---|---|
| `app_christian_profile` | `user_id` | ❌ | **CASCADE** | CASCADE | 迁移前必须解析；无法解析 → 停 | 成长档案属个人，人没了档案无归属对象。**但迁移期绝不允许孤儿**（§14 T-1） |
| `app_course_progress` | `user_id` | ❌ | **CASCADE** | CASCADE | 同上 | 学习进度属个人 |
| `app_practice_training_state` | `user_id` | ❌ | CASCADE | CASCADE | 同上 | 同上 |
| `app_posts` | `user_id` | ✅ | **SET NULL** | CASCADE | tombstone `author_state='deleted_account'` | **R-10**：内容保留，作者置空，不得赋予虚构所有者 |
| `app_post_comments` | `user_id` | ✅ | **SET NULL** | CASCADE | tombstone | R-10。评论是对话的一部分，删掉会让上下文断裂 |
| `app_post_likes` | `user_id` | ❌ | **CASCADE** | CASCADE | 直接删 | 点赞是纯计数信号，无保留价值 |
| `app_prayer_shares` | `user_id` | ✅ **已可空** | **SET NULL** | CASCADE | tombstone（**现已实现**） | R-10 原生场景 |
| `app_prayer_intercessions` | `user_id` | ❌ | CASCADE | CASCADE | 直接删 | 代祷计数信号 |
| `app_prayer_share_reports` | `reporter_user_id` | ✅ | **SET NULL** | CASCADE | 保留举报记录 | **治理记录必须留存**，举报人注销不能抹掉举报事实 |
| `app_prayer_sessions` | `created_by` / `facilitator_user_id` | ✅ | **SET NULL** | CASCADE | 保留会话历史 | 祷告会历史是群体记录，不属单人 |
| `app_prayer_session_events` | `actor_user_id` | ✅ | **SET NULL** | CASCADE | 保留事件 | **审计性质**，不得因人注销而失去事件链 |
| `app_room_members` | `user_id` | ❌ | CASCADE | CASCADE | 直接删 | membership 是当下关系 |
| `app_room_presence` | `user_id` | ❌ | CASCADE | CASCADE | 不迁移 | 易失 |
| `app_room_reading_state` | `updated_by` | ✅ | **SET NULL** | CASCADE | 保留位置 | 房间共同状态，不属个人 |
| `app_room_prayer_topics` | `created_by` | ✅ | SET NULL | CASCADE | 保留主题 | 房间内容 |
| `app_rooms` | `host_user_id` | ✅ | **SET NULL** + `host_type` | CASCADE | 见 §7 | 系统房间无真人 host |
| `app_friend_requests` | `from/to_user_id` | ❌ | CASCADE ×2 | CASCADE | 直接删 | 关系请求随人消失 |
| `app_friendships` | 成对 | ❌ | CASCADE ×2 | CASCADE | 直接删 | 同上 |
| `app_library_favorites` | `user_id` | ❌ | CASCADE | CASCADE | 直接删 | 个人书签 |
| `app_recordings` | `user_id` | ✅ | **SET NULL** | CASCADE | 保留 + tombstone | 录音可能是群体活动产物 |
| `app_image_uploads` | `uploaded_by` | ✅ | **SET NULL** | CASCADE | 保留 | 图片可能被他人内容引用，删了会产生断链 |
| `app_push_tokens` | `user_id` | ❌ | CASCADE | CASCADE | 直接删 | 设备令牌，人走即失效 |
| `app_announcements` | `published_by` | ✅ | **SET NULL** | CASCADE | 保留公告 | 公告是机构发声，不随发布者消失 |
| `app_course_files` | *(无 owner)* | — | — | — | — | — |

**统计**：`CASCADE` 11 张 · `SET NULL` + tombstone 11 张 · 不迁移 2 张。

---

## 7. System Sentinel Resolution

**已确认**：`rooms.host_id = 'system'` 是哨兵值，非 uuid、非真实用户。

**禁止**：给 `system` 建假 `auth.users` · 把字符串塞进 uuid FK · 为过 migration 临时禁 FK。

### 目标模型

```sql
create type app_room_host_type as enum ('system', 'user');

create table app_rooms (
  id            text primary key,
  host_type     app_room_host_type not null,
  host_user_id  uuid references profiles(id) on delete set null,
  password_hash text,
  password_salt text,
  created_at    timestamptz not null default now(),

  -- ★ 约束把「系统房间」与「真人房间」的合法形态钉死，
  --   非法 orphan user host 在数据库层就写不进去。
  constraint app_rooms_host_shape check (
    (host_type = 'system' and host_user_id is null) or
    (host_type = 'user'   and host_user_id is not null)
  )
);
```

### Acceptance 对照

| 要求 | 如何满足 |
|---|---|
| 5 个内置公共房间可合法存在 | `host_type='system'`, `host_user_id=NULL` —— 通过 CHECK，无需 FK 豁免 |
| 真人 host 必须有有效 canonical identity | `host_type='user'` 时 `host_user_id NOT NULL` 且 FK 到 `profiles(id)` |
| 非法 orphan user host 不允许写入 | FK + CHECK 双重拦截；无法插入指向不存在 profile 的行 |

**迁移转换**：`host_id='system'` → `(host_type='system', host_user_id=NULL)`；
其余 → `(host_type='user', host_user_id=<crosswalk 解析结果>)`，解析不出则**停在人工复核**。

> 业务语义未变：内置房间「永远没有真人房主，运营权只以 `room_members.role='moderator'` 存在」这条不变。

---

## 8. SQLite → Postgres Type Contract

| # | SQLite | Postgres | 行为差异 | 必需回归测试 |
|---|---|---|---|---|
| 1 | `INTEGER` 0/1 布尔 | `boolean` | Postgres **无** 0/1→bool 隐式转换；`WHERE flag` 在 SQLite 下 0 为假，Postgres 下类型错误 | 每个布尔列的真假往返 |
| 2 | `TEXT` JSON | `jsonb` | **key 顺序会被规范化**，序列化文本不再稳定 | §10 双哈希 |
| 3 | `INTEGER` epoch ms | `timestamptz` | 转换必须 `to_timestamp(col / 1000.0)`；直接 cast 得到 1970 年附近 | 时间戳往返等值 |
| 4 | `CHECK(col IN (...))` | 原生 `enum` | 值域外的历史值**插入即失败**（SQLite 下 CHECK 可能因历史数据先于约束而残留） | 全表值域扫描 |
| 5 | `INSERT OR IGNORE`（6 处） | `ON CONFLICT DO NOTHING` | **冲突目标必须有对应唯一约束**；SQLite 的「任意约束冲突即忽略」范围更宽 | 每处的冲突路径测试 |
| 6 | `ON CONFLICT`（7 处） | `ON CONFLICT (cols) DO UPDATE` | 必须显式写冲突列；SQLite 部分索引作为冲突目标需 `WHERE` 谓词完全匹配 | upsert 幂等测试 |
| 7 | `lastInsertRowid`（1 处） | `INSERT ... RETURNING id` | 无 rowid 概念 | 该处单测 |
| 8 | `TEXT COLLATE NOCASE`（`users.email`） | `citext` 或 `lower(email)` 唯一索引 | 直迁会**丢失大小写不敏感唯一性** | 大小写不同的重复邮箱必须被拒 |
| 9 | `TEXT` uuid 主键 | `uuid` | 非法格式**转换即失败** | 全表 uuid 合法性预扫描 |
| 10 | 部分唯一索引 `WHERE ... IS NOT NULL` | 语法相同 | 一致 | 幂等索引测试 |
| 11 | `PRAGMA table_info` 运行期探测 | **不适用** | Postgres 用版本化 migration，见 §12 | schema 版本断言 |
| 12 | `AUTOINCREMENT`（1 处） | `generated always as identity` | rowid 语义不同 | 该表插入测试 |

---

## 9. Transaction Contract

5 个事务边界，逐个定义。**核心风险**：同步闭包改 async 后出现
「事务函数退出了、异步 SQL 还没执行完」。

**统一规则**：所有事务改为 `await client.query('BEGIN')` … `COMMIT`/`ROLLBACK` 的
**显式单连接**模式，事务体内每一条 SQL 必须 `await`；禁止在事务闭包里
出现未 `await` 的 Promise。**Lint 规则 `no-floating-promises` 必须开启**。

| # | 位置 | 当前 SQLite 行为 | Postgres 契约 | Isolation | 部分失败 | 重试 | 幂等 |
|---|---|---|---|---|---|---|---|
| 1 | `routes/prayer.ts:184` 重设房间祷告主题 | 同步：清空 + 批量插入 | `BEGIN; DELETE; INSERT×n; COMMIT` | `READ COMMITTED` | 全回滚 | 否 | ✅ 天然幂等（全量替换） |
| 2 | `routes/prayerSession.ts:200` 创建祷告会 + items | 同步：插 session + 批量插 items，position 服务端重编号 | 同上 | `READ COMMITTED` | 全回滚 | 否 | ⚠ 需 `client_request_id` 幂等键（现无） |
| 3 | `routes/prayerSession.ts:339` 更新已排期会话 | **乐观并发**：`stmtUpdateScheduled` 带 `expected`，`changes===0` 时**事务内不做任何写入** | `UPDATE ... WHERE revision = $expected RETURNING`，`rowCount===0` → `ROLLBACK` + 409 | `READ COMMITTED` 足够（乐观锁自带保护） | 全回滚 | **否**（409 应由客户端决定） | ✅ revision 保证 |
| 4 | `routes/rooms.ts:68` 创建/更新房间 | 同步：按有无密码走两支 upsert | `BEGIN; INSERT ... ON CONFLICT DO UPDATE; COMMIT` | `READ COMMITTED` | 全回滚 | 否 | ✅ upsert |
| 5 | `routes/rooms.ts:144` 退出房间 | 同步：`removeMember` + 删 presence | `BEGIN; DELETE members; DELETE presence; COMMIT` | `READ COMMITTED` | 全回滚 | 否 | ✅ 幂等（删不存在的行是 no-op） |

> **#2 是唯一需要补幂等键的事务**：当前若客户端重试创建祷告会，会产生两条。
> SQLite 下同样有此问题，不是迁移引入的 —— 但迁移是修它的合适时机（DB-2 决定）。

---

## 10. Christian Profile Contract

### 10.1 迁移语义（D-19 / OPTION A）

**保持现有持久化语义。** 禁止：relationize · normalize · reconstruct · recompute ·
rename internal scoring fields · 借迁移之机改算法。

### 10.2 Target schema

```sql
create table app_christian_profile (
  user_id     uuid primary key references profiles(id) on delete cascade,
  state       jsonb not null,          -- 原 growth_state.state_json，内容逐字保持
  updated_at  timestamptz not null,
  -- 迁移期溯源列，验收后可保留为审计
  source_raw_hash        text,        -- 迁移前 SQLite TEXT 的 SHA256
  canonical_semantic_hash text        -- 语义规范化后的 SHA256
);
```

### 10.3 三层 Gate

#### Layer 1 — 内容一致性（**不是**序列化格式一致性）

> ⚠ **`jsonb` 会规范化 key 顺序并丢弃空白**，因此**不能**用「数据库导出的原始字符串」做唯一验证。

双哈希机制：

```
source_raw_hash        = SHA256(SQLite growth_state.state_json 原始字节)
                         迁移工具在读出时立即计算并写入 manifest，此后不再变化

canonical_semantic_hash = SHA256(canonicalize(JSON))
  canonicalize = 递归按 key 字典序排序 + 数组保持原序 + 无空白分隔
                （即 RFC 8785 JCS 风格；数组顺序**必须保留**，它承载答题顺序）
```

**验收判据**：

```
迁移前 canonical_semantic_hash  ==  迁移后从 Postgres 读回再 canonicalize 的 hash
```

`source_raw_hash` 只用于**溯源与争议仲裁**，不作为通过条件 ——
否则会因 `jsonb` 重排 key 而误判。

> **目标是证明内容没变，而不是证明 PostgreSQL 的 JSON 序列化格式没变。**

#### Layer 2 — 20 项 CP regression

`tests/services/christianProfileScoring.test.ts` 必须 **20/20 全绿**，
包括 5 项铁律边界（A/B/E 作答与外部证据均不改变 12 项倾向）。

#### Layer 3 — 3 个 golden snapshot

`orientation-vector-standard` / `top3-standard` / `orientation-vector-quick`
**必须无变化**。任何变化都必须先解释、再由 Supervisor 批准后显式更新。

---

## 11. Migration Manifest

**row-level accountability** —— 不接受「10000 rows imported」这种汇总。

```sql
create table migration.row_manifest (
  id                bigserial primary key,
  batch             text not null,
  source_table      text not null,
  source_pk         text not null,
  target_table      text not null,
  target_pk         text,
  status            text not null
                    check (status in ('PENDING','MIGRATED','SKIPPED','FAILED','MANUAL_REVIEW')),
  transformation    text,              -- 应用的转换规则标识
  identity_mapping  text,              -- 用到的 crosswalk mapping_method
  source_checksum   text,
  target_checksum   text,
  error             text,
  manual_review     boolean not null default false,
  reviewed_by       uuid,
  created_at        timestamptz not null default now()
);
create index on migration.row_manifest (source_table, status);
create unique index on migration.row_manifest (batch, source_table, source_pk);
```

**验收规则**：

```
每一行源数据必须在 manifest 中恰好有一条记录
status='PENDING' 的行数在阶段结束时必须为 0
status='FAILED' 或 'MANUAL_REVIEW' > 0  →  该阶段不得标记完成
行数对账：count(source) == count(manifest where batch=X)
```

---

## 12. Versioned Migration Ownership

### 评估结论

> **`amas-website/supabase/migrations` 继续作为 AMAS Supabase database 的唯一 migration source of truth。**

理由：

1. 它已有 `0001`–`0022` 共 22 个版本化 migration，26 张表、15 枚举、36 条 RLS policy 都在其中
2. Portal 与 App 迁移后共用**同一个 Supabase 数据库**，两套竞争的 migration 目录必然产生
   「谁先跑」「版本号撞车」「schema 漂移」三类问题
3. D-9 已确立治理文档集中在 `amas-website`，migration 归属与之一致

**明确禁止**：在 App repo 建立第二套 Supabase migrations。

App 侧目标表以 `0023_app_core.sql` 起在 website 仓库继续编号。
App repo 只保留**离线迁移工具**（读 SQLite、产出 manifest、写 Postgres），不含 DDL。

**SQLite 侧**：`M-0` schema 基线快照工具仍在 App repo（它只服务于 SQLite 的一次性导出）。

---

## 13. Migration Phase Plan

**每一阶段可独立验收与回退。禁止 32 张表一次搬完再一起测。**

| Phase | 内容 | 依赖 | 独立验收 | 回退点 |
|---|---|---|---|---|
| **DB-2** | SQLite schema 基线快照工具（M-0）+ 只读扫描（孤儿行 / uuid 合法性 / 枚举值域 / 邮箱大小写重复 / 孤儿课程） | 无 | 扫描报告产出，**零写入** | 无需回退（只读） |
| **DB-3** | `0023_app_core.sql`：身份扩展 + `app_user_profile_ext` + `migration.*` 三张工具表 | DB-2 | schema 建成，Portal 既有 26 张表全量回归仍绿 | `drop schema migration cascade` + revert migration |
| **DB-4** | 身份迁移：crosswalk 填充 + 人工复核闭环 | DB-3 | **每个 legacy user 都有 crosswalk 行**；`email_match_unreviewed` 数为 0 | 只写 crosswalk，业务数据未动 |
| **DB-5** | 角色迁移：`ADMIN_ROLE_MIGRATION_MANIFEST` 裁定 + `user_roles` 授予 | DB-4 | 所有 `admin` 行 `review_status='RESOLVED'`；授权结果与迁移前逐人比对 | 撤销本批次授予 |
| **DB-6** | 课程合并：`course_catalog` EXTEND + 孤儿课程扫描 | DB-3 | 67 条 code 一一对应；`credits` 仍为 null | drop 扩展列 |
| **DB-7** | **CP 迁移**（`app_christian_profile`）+ 三层 Gate | DB-4 | §10 三层全过；双哈希逐用户比对 | 表可 drop 重来（源 SQLite 未删） |
| **DB-8** | 学习数据：`app_course_progress` / `app_practice_training_state` | DB-4, DB-6 | 行数对账；孤儿课程按 §4.3 处置 | 表可 drop 重来 |
| **DB-9** | 房间与祷告：`app_rooms`（§7 哨兵）+ 9 张相关表 | DB-4 | 5 个内置房间合法存在；presence/events 不迁 | 表可 drop 重来 |
| **DB-10** | 社群：`app_posts` 等 5 张 | DB-4 | R-10 tombstone 正确 | 表可 drop 重来 |
| **DB-11** | 附属：library / recordings / images / push / announcements / course_files / cooperation | DB-4 | 行数对账 | 表可 drop 重来 |
| **DB-12** | **DAL 切换**（repository 接口层 + async 改造 + §9 事务契约） | DB-3..DB-11 | 全量回归（前端 181 + 后端 138）在 Postgres 下全绿 | 保留 SQLite 实现 + `DB_DRIVER` 开关 |
| **DB-13** | 双写/影子验证 + 切流 | DB-12 | 双库读结果一致 | 切回 SQLite |

> **SQLite 直到 DB-13 验收通过前不删除**（本轮已明令禁止删除）。

---

## 14. Test Strategy

| 类别 | 测试 | 守住的风险 |
|---|---|---|
| **schema tests** | 目标 schema 与 `SQLITE_TO_POSTGRES_SCHEMA_MAP` 逐列一致；migration 版本号连续 | DBR-03 |
| **row count reconciliation** | 每张表 `count(source) == count(target) + count(skipped)`，且 manifest 逐行可查 | 数据静默丢失 |
| **FK validation** | 所有新建 FK 在导入后无违反；`app_rooms` CHECK 生效 | DBR-01 · §7 |
| **orphan detection** | 导入前扫描：owner 列值不在 crosswalk 中的行数必须为 0 | **DBR-01（migration gate）** |
| **identity collision** | 一个 `supabase_auth_user_id` 只能映射一个 `canonical_profile_id`；反向亦然 | 身份碰撞 |
| **duplicate detection** | 大小写不同的重复邮箱；同一真人多条 legacy 记录 | DBR-08 |
| **role mapping tests** | 每个迁移后账号的**实际授权结果**与迁移前逐一比对；任何 privilege ↑ 必须在 manifest 中显式 | **DBR-02** |
| **transaction tests** | §9 五处的回滚、乐观锁 409、幂等重放 | DBR-04 |
| **course mapping tests** | 67 条 1:1；孤儿课程进入 MANUAL_REVIEW 而非丢弃 | §4.3 |
| **CP hash tests** | 双哈希（raw + canonical semantic）逐用户比对 + 20 regression + 3 snapshot | **DBR-05** · §10 |
| **negative authorization tests** | 迁移后重跑 STEP 5 否定式全套：anon/跨用户/越权/自授 admin 一律拒 | 授权回归 |
| **rollback rehearsal** | 每个 DB-n 阶段在 staging 演练一次回退 | 全局 |

---

## 15. Remaining Decisions

| # | 待决 | 归属 | 阻断哪一阶段 |
|---|---|---|---|
| 1 | **既有 `mapping_status='mapped'` 行的复核**（见下） | 用户 / 教务 | DB-4 |
| 2 | `admin` 账号逐人目标角色 | 用户 / 学院 | DB-5 |
| 3 | 祷告会创建是否补 `client_request_id` 幂等键（§9 #2） | GPT | DB-9（可延后） |
| 4 | `app_user_profile_ext` 承接哪些 App 专属字段的最终清单 | GPT | DB-3 |

### ⚠ 本轮发现：既有身份映射用的正是被禁止的 email-only silent matching

`backend/scripts/identity-migration-apply.mjs:88-101` 实测：

```js
const sbByEmail = new Map((sbList.users ?? []).map(u => [norm(u.email), u]));
...
mapping_status: existing ? 'mapped' : 'needs_provision',
mapping_reason: '该邮箱在 Supabase 已有账号，直接 1:1 映射'
```

`mapped` 分支**仅凭邮箱相同就静默判定为同一个人**，无其他证据、无人工复核 ——
正是 TASK 2 明令禁止的模式。

**契约处置**：

| 既有 status | 迁入 crosswalk 后的 method | 处置 |
|---|---|---|
| `provisioned` | `provisioned_by_migration` / high | ✅ 自动放行（账号由迁移创建，归属无歧义） |
| **`mapped`** | **`email_match_unreviewed` / low** | ❌ **强制转 `NEEDS_MANUAL_REVIEW`** |
| `skipped_test_account` | `unresolved` | ❌ 不放行（现已 403） |
| `needs_provision` / `provision_failed` | `unresolved` | ❌ 不放行 |

> 注意 `identity.ts` 的运行时白名单是 `{'mapped','provisioned'}` —— 即
> **今天 `mapped` 的账号已经能正常登录**。本契约不改变运行时行为（那属 AUTH 域），
> 只要求**迁移期**对这批账号做人工复核后才写入 canonical crosswalk。

---

## 16. Documentation Updates

| 文件 | 内容 |
|---|---|
| `DECISION_LOG.md` | **D-18** admin 无自动映射 · **D-19** CP preserve blob · **D-20** TYPE A · **D-21** 单一身份空间 |
| `OPEN_ISSUES.md` | 新增 **DBR-17** 既有 `mapped` 行为 email-only 静默匹配，需人工复核 |
| `DEVELOPMENT_ROADMAP.md` | 标注 DB-2 ～ DB-13 阶段计划 |
| `ACCEPTANCE_HISTORY.md` | append-only 追加 DB-1 条目 |
| `CURRENT_STATE.md` | 当前阶段 = RB-01 DB-1 完成，ACTIVE TASK 待 Supervisor 指派 |

### DBR 严重度语义澄清

```
Production Incident Severity   —— App 尚未进入正式 Production，故 DBR-01~05 不是当前生产事故
Migration Gate Severity        —— DBR-01~05 为 DB MIGRATION HARD BLOCKERS
```

两者**都必须在 Production 前解决**，但语义不同，文档中分开表述。

---

## 17. Proposed DB-2

```
DB-2  只读事实采集，零写入

  1. SQLite schema 基线快照工具（M-0）
     输出确定性 DDL，解决 DBR-03「无 schema 版本号」

  2. 五项只读扫描，逐项产出报告：
     - 孤儿行扫描（23 张 user-owned 表的 owner 列 vs users.id）
     - uuid 合法性扫描（所有 TEXT 主键与 owner 列）
     - 枚举值域扫描（所有 CHECK(... IN ...) 列的实际取值集合）
     - 邮箱大小写重复扫描（COLLATE NOCASE 语义丢失前的基线）
     - 孤儿课程扫描（course_progress.course_id vs 67 条 code + 4 个 retired）

  3. 既有 legacy_user_map 的 mapping_status 分布统计
     —— 量化有多少账号落在被禁止的 email-only 匹配上（§15）
```

**DB-2 仍不写任何数据、不建任何 Postgres 对象、不碰 DAL。**
它的产出直接决定 DB-3 的 schema 细节与 DB-4 的人工复核工作量。

---

# 状态

```
DB-1 COMPLETE / READY FOR DB-2 REVIEW
```

四项决策（D-18～D-21）已全部落实到契约。32 张表**全部**得到明确结果，无 TBD。
身份 / 角色 / 课程 / FK / 哨兵 / 类型 / 事务 / CP / manifest / migration 归属
十项契约定版。DB-2 ～ DB-13 阶段计划按真实依赖拆分，每阶段可独立验收与回退。

未开始 DB-2。未修改 production DAL、未切 driver、未执行数据 migration、
未创建 production Supabase、未删除 SQLite、未改变产品业务行为。
