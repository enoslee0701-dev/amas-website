# DB-0 DATABASE FACTS & TARGET DESIGN REPORT

**日期**：2026-09-07 · **阶段**：RB-01 PHASE DB-0
**性质**：**只审计、建模、设计**。未修改 DAL、未改 repository、未切 driver、未执行任何 migration、未创建 Supabase Production、未做 destructive schema change、未改业务逻辑。
**起点**：App `main = origin/main = d564c4c` · Website `master = 79fcf65`

---

## 1. Current Database Reality

```
App 后端      better-sqlite3 单文件   backend/data/amas.sqlite（DB_PATH 未设时）
Portal        Supabase Postgres      22 个版本化 migration，仅 staging
```

| | App SQLite | Portal Supabase |
|---|---|---|
| 表数 | **32** | **26** |
| 枚举 | 0（用 `CHECK(... IN ...)`） | **15** |
| 索引 | 25 | 未逐一清点 |
| RLS | 不存在 | **26 张表启用，36 条 policy** |
| SECURITY DEFINER | 不存在 | **80 处** |
| 触发器 | 0 | **22** |
| 迁移机制 | **无版本化**（见 §4） | 版本化 `0001`–`0022` |
| 角色词表 | **2 个**：`student` / `admin` | **9 个** |

**两套数据库当前没有任何数据流打通**，唯一桥梁是 `legacy_user_map`（身份映射）。

---

## 2. SQLite Schema Inventory

32 张表。**只有 6 张有任何外键**。

| Table | Cols | FK | Idx | Owner 列 | 标记 |
|---|---|---|---|---|---|
| `users` | 10 | 0 | 1 | *(id 本身)* | **CANONICAL IDENTITY** |
| `legacy_user_map` | 7 | 0 | 1 | `legacy_user_id`, `supabase_user_id` | **SECURITY-SENSITIVE** · NO FK |
| `refresh_jti` | 2 | 0 | 0 | `user_id` | **DEAD**（AUTH-M7 后无写入方，RB-27） |
| `rooms` | 5 | 0 | 0 | `host_id` | NO FK · `host_id='system'` 非真实用户 |
| `room_members` | 4 | 2 | 1 | `user_id` | **+FK** |
| `room_presence` | 6 | 0 | 1 | `user_id` | NO FK · 易失（TTL 45s） |
| `room_reading_state` | 7 | 1 | 0 | `updated_by` | **+FK** |
| `room_realtime_events` | 6 | 0 | 1 | — | 易失 |
| `room_prayer_topics` | 6 | 0 | 1 | `created_by` | NO FK |
| `prayer_sessions` | 11 | 3 | 2 | `created_by`, `facilitator_user_id` | **+FK** |
| `prayer_session_items` | 8 | 1 | 1 | — | +FK |
| `prayer_session_events` | 7 | 1 | 1 | `actor_user_id` | +FK |
| `prayer_shares` | 8 | 0 | 2 | `user_id`（**可空**）, `hidden_by` | NO FK · **R-10 tombstone**（`author_state`） |
| `prayer_intercessions` | 3 | 0 | 0 | `user_id` | NO FK |
| `prayer_share_reports` | 6 | 2 | 1 | `reporter_user_id` | +FK |
| `posts` | 12 | 0 | 1 | `user_id` | NO FK · **USER-OWNED** |
| `post_likes` | 2 | 0 | 1 | `user_id` | NO FK |
| `post_comments` | 8 | 0 | 1 | `user_id` | NO FK |
| `announcements` | 6 | 0 | 1 | `published_by` | NO FK |
| `courses` | 10 | 0 | 1 | `created_by` | NO FK · **与 Portal 重复**（§8） |
| `course_progress` | 5 | 0 | 0 | `user_id` | NO FK · **USER-OWNED · MIGRATION-RISK** |
| `course_files` | 8 | 0 | 1 | — | NO FK |
| `friend_requests` | 4 | 0 | 3 | `from_user_id`, `to_user_id` | NO FK |
| `friendships` | 3 | 0 | 0 | *(成对 user id)* | NO FK |
| `library_books` | 11 | 0 | 1 | — | NO FK |
| `library_favorites` | 3 | 0 | 0 | `user_id` | NO FK |
| `cooperation_submissions` | 7 | 0 | 1 | — | NO FK |
| `image_uploads` | 7 | 0 | 0 | `uploaded_by` | NO FK |
| `recordings` | 8 | 0 | 0 | `user_id` | NO FK |
| `push_tokens` | 4 | 0 | 1 | `user_id` | NO FK |
| **`growth_state`** | 3 | 0 | 0 | `user_id` | **NO FK · Christian Profile 全部数据在此**（§12） |
| `pt_state` | 3 | 0 | 0 | `user_id` | NO FK |

### 通用约定

```
主键        TEXT（uuid 字符串）；仅 1 处 INTEGER PRIMARY KEY AUTOINCREMENT
时间戳      INTEGER，epoch 毫秒（created_at 15 处 / updated_at 6 处 / …）
                **不是** TEXT，也不是原生时间类型
布尔        INTEGER 0/1（如 is_anonymous、hidden_at）
JSON        TEXT（images_json / shared_room_json / state_json ×2）
枚举        CHECK(col IN (...)) 约束，无 SQL 类型
列类型分布  TEXT 149 · INTEGER 53
```

### `users` 表（canonical 身份）

```sql
id            TEXT PRIMARY KEY
email         TEXT NOT NULL UNIQUE COLLATE NOCASE
name          TEXT NOT NULL
password_hash TEXT NOT NULL     -- AUTH-M7 后已无写入方（登录归 Supabase）
salt          TEXT NOT NULL     -- 同上
role          TEXT NOT NULL CHECK(role IN ('student','admin')) DEFAULT 'student'
degree, avatar, bio  TEXT
created_at    INTEGER NOT NULL
```

> ⚠ `password_hash` / `salt` 在 AUTH-M7 之后**不再被写入**，但列仍存在且有历史数据。
> 迁移时**不得**把它们带进 Postgres —— Supabase Auth 已持有凭据，复制一份是纯负债。

---

## 3. SQL Usage Inventory

```
含 SQL 的生产文件   21
识别到的语句        164
生产代码未触及的表   0
```

| Table | SELECT | INSERT | UPDATE | DELETE | 主要读写位置 |
|---|---|---|---|---|---|
| `users` | 9 | 1 | 1 | 2 | `auth/users.ts`, `middleware/roomAuth.ts`, `rooms/presence.ts`, `routes/prayer*` |
| `rooms` | 4 | 2 | 1 | 2 | `routes/rooms.ts`, `middleware/roomAuth.ts`, `diagnostics/systemRooms.ts` |
| `room_members` | 2 | 2 | 1 | 2 | `middleware/roomAuth.ts`, `diagnostics/systemRooms.ts` |
| `prayer_shares` | 2 | 1 | 1 | 1 | `routes/prayer.ts`, `routes/prayerHistory.ts` |
| `prayer_sessions` | 2 | 1 | 1 | 1 | `routes/prayerSession.ts`, `routes/prayerHistory.ts` |
| `growth_state` | 1 | 1 | 1 | 2 | **`routes/growth.ts`** |
| `course_progress` | 1 | 1 | 1 | 2 | `routes/courses.ts` |
| `legacy_user_map` | 1 | 0 | 0 | 0 | **`auth/identity.ts`**（只读，运行时身份解析） |
| `room_reading_state` | 1 | 1 | 1 | 0 | `routes/roomReading.ts` |
| `room_presence` | 1 | 1 | 0 | 3 | `rooms/presence.ts`, `routes/rooms.ts` |
| 其余 22 张 | — | — | — | — | 见下方说明 |

### 关键结构性发现

> **`db.ts` 同时是 schema 定义与数据访问层。**
> `posts` / `post_likes` / `post_comments` / `friend_requests` / `friendships` /
> `image_uploads` / `recordings` / `refresh_jti` 的 SQL **只出现在 `db.ts` 内部**，
> 没有独立 repository。DB-1 若要引入 repository 接口层，`db.ts` 是必须先拆的那一块。

### Authorization boundary

```
所有表的授权判定都在 Express 层（requireAuth / requireAdmin / requireRoomMember /
requireRoomManager / requireReadingRoom），**数据库层零约束**。
```

---

## 4. SQLite-Specific Assumptions

| # | 假设 | 当前 SQLite 行为 | Postgres 等价 | 迁移风险 | 必须的测试 |
|---|---|---|---|---|---|
| 1 | **同步 prepared statement** | `better-sqlite3` 全同步，`stmt.get()/run()` 立即返回 | `pg` 全异步 | **P0** —— 每个调用点都要改成 `await`，控制流可能变化 | 全量回归 + 并发写测试 |
| 2 | **单进程单写者** | 进程内独占文件；`realtimeDeploymentNote` 明确警告「SINGLE-INSTANCE」 | 多连接并发 | **P0** —— 现有代码可能隐含「读到的就是最新」 | 双实例并发写测试 |
| 3 | `db.transaction(fn)()` | 同步嵌套，5 处使用（`prayer.ts` 1 · `prayerSession.ts` 2 · `rooms.ts` 2） | `BEGIN/COMMIT` + 显式连接 | **P0** —— 同步闭包改异步后事务边界易断 | 每处事务的回滚测试 |
| 4 | `INSERT OR IGNORE`（6 处） | 冲突静默忽略 | `ON CONFLICT DO NOTHING` | P1 —— 需逐处确认冲突目标列 | 幂等性测试 |
| 5 | `ON CONFLICT`（7 处） | SQLite upsert 语法 | 语法相近但**冲突目标必须有唯一约束** | P1 —— SQLite 部分索引未必等价 | upsert 测试 |
| 6 | `lastInsertRowid`（1 处） | 返回 rowid | 需 `RETURNING id` | P1 | 该处单测 |
| 7 | **时间戳为 INTEGER epoch ms** | 应用层生成 `Date.now()` | `timestamptz`（Portal 已用） | **P1** —— 直接搬会得到 1970 年附近的时间；必须 `to_timestamp(ms/1000)` | 时间戳往返测试 |
| 8 | **布尔为 INTEGER 0/1** | `is_anonymous INTEGER` | `boolean` | P1 —— 隐式真值语义不同（Postgres 无 0/1→bool 隐式转换） | 布尔字段测试 |
| 9 | **JSON 存 TEXT**（4 列） | 应用层 `JSON.stringify/parse` | `jsonb` 或保持 `text` | P2 —— 转 `jsonb` 更好但会改变读写代码 | CP 快照往返（见 §12） |
| 10 | `CHECK(col IN (...))` 当枚举 | 字符串 + CHECK | Portal 已有 15 个原生 `enum` | **P1** —— 值域必须先对齐，否则插入失败 | 枚举转换测试 |
| 11 | `COLLATE NOCASE` on `users.email` | SQLite 大小写不敏感唯一 | Postgres 需 `citext` 或 `lower()` 唯一索引 | **P1** —— 直接迁会丢大小写不敏感性，可能产生重复邮箱 | 大小写重复邮箱测试 |
| 12 | 运行期 `PRAGMA table_info` + `ALTER TABLE ADD COLUMN` | 见下 | 版本化 migration | **P0** —— 见「无版本化迁移」 | — |
| 13 | 部分唯一索引 `WHERE client_request_id IS NOT NULL` | SQLite 支持 | Postgres 也支持（语法相同） | P3 | 幂等索引测试 |
| 14 | `TEXT` 主键存 uuid | 无 uuid 类型 | `uuid` 类型 | P2 —— 转类型需保证格式合法（`legacy_user_id` 用 `crypto.randomUUID()`，但历史值未必） | uuid 合法性扫描 |

### ⚠ 无版本化迁移机制（P0）

App 的 schema 演进方式是**运行期打补丁**：

```ts
function hasColumn(table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === column);
}
if (!hasColumn('room_members', 'role')) {
  db.exec(`ALTER TABLE room_members ADD COLUMN role TEXT NOT NULL DEFAULT 'member'`);
}
```

**后果**：不存在「当前 schema 版本号」这种东西。同一份代码在不同年龄的数据库上
会得到不同结果，且**无法判定某个部署处于哪个 schema 状态**。
迁移前必须先建立一次性的 schema 基线快照（见 §15）。

---

## 5. Identity Model

### 5.1 现有身份字段清点

| 列名 | 出现表数 | 表 |
|---|---|---|
| `user_id` | **14** | `course_progress`, `growth_state`, `library_favorites`, `post_comments`, `post_likes`, `posts`, `prayer_intercessions`, `prayer_shares`, `pt_state`, `push_tokens`, `recordings`, `refresh_jti`, `room_members`, `room_presence` |
| `created_by` | 3 | `courses`, `prayer_sessions`, `room_prayer_topics` |
| `host_id` | 1 | `rooms`（值可为 `'system'` —— **非真实用户**） |
| `legacy_user_id` / `supabase_user_id` | 1 | `legacy_user_map` |
| `from_user_id` / `to_user_id` | 1 | `friend_requests` |
| `actor_user_id` | 1 | `prayer_session_events` |
| `facilitator_user_id` | 1 | `prayer_sessions` |
| `reporter_user_id` | 1 | `prayer_share_reports` |
| `published_by` | 1 | `announcements` |
| `uploaded_by` | 1 | `image_uploads` |
| `updated_by` | 1 | `room_reading_state` |
| `hidden_by` | 1 | `prayer_shares` |

**共 12 种不同的身份列命名，散布在 23 张表上。**

### 5.2 两套身份空间

```
Portal:  auth.users.id (uuid)  ──►  profiles.id (FK, ON DELETE CASCADE)
                                ──►  user_roles.user_id
                                ──►  student_records / applications / …

App:     users.id (TEXT uuid)  ──►  上表 23 张的 owner 列（20 张无 FK）

桥梁:    legacy_user_map(legacy_user_id ↔ supabase_user_id, mapping_status)
         唯一读取者 auth/identity.ts，运行时解析，解析不出 403 fail closed
```

### 5.3 Canonical Identity 建议

> # 建议：`auth.users.id` 成为唯一 application canonical identity。

```
auth.users.id  (uuid, Supabase 拥有)
      │
      ├── profiles.id                     Portal 人物资料（已有 FK CASCADE）
      ├── user_roles.user_id              授权（已有）
      ├── applications / student_records  申请与学籍（已有）
      │
      └── ★ 迁移后：App 全部 owner 列直接指向它
              posts.user_id, growth_state.user_id, course_progress.user_id, …
```

**理由**：

1. Portal 已经以它为中心建成 26 张表 + 36 条 RLS policy，改动成本为零
2. AUTH-M7 之后它已是唯一 user 认证来源
3. 保留 App `users.id` 作为第二身份空间，等于**永久维持 `legacy_user_map` 这层翻译**，
   而每一次翻译失败都是一次 403 或一条孤儿数据

**过渡**：`legacy_user_map` 在迁移期是权威映射表，迁移完成后
**降级为历史审计记录**（不删，供追溯），App 侧 `users` 表退化为
「Portal `profiles` 的本地投影」或整体并入 `profiles`（见 §8 建议）。

---

## 6. Role Mapping Matrix

> **不得简单做 `admin → admin`** —— 本轮 AUTH-M7 已实证这会造成**静默 403**。

### 事实

```
App SQLite     users.role CHECK(role IN ('student','admin'))          2 个值
Portal Supabase user_role enum                                         9 个值
               applicant · student · teacher · mentor · registrar
               finance · content_admin · academic_admin · super_admin
授权判定        auth/supabase.ts:111
               ADMIN_ROLES = {registrar, academic_admin, super_admin}
               isAdminRole(roles) = roles.some(r => ADMIN_ROLES.has(r))
```

**`'admin'` 不在 `ADMIN_ROLES` 中。** 把 App 的 `'admin'` 原样写进 `user_roles`，
`isAdminRole` 返回 false → **静默 403**，无任何报错。

### ROLE_MAPPING_MATRIX

| Current (App) | Target (Portal) | Canonical? | Migration Mapping | Ambiguous? | Security Risk |
|---|---|---|---|---|---|
| `student` | `student` | ✅ | 1:1 直映 | 否 | 低 |
| `admin` | **`DECISION_REQUIRED`** | ❌ | **无法自动决定** —— App 的 `admin` 是单一超级角色，Portal 把它拆成了 `registrar` / `academic_admin` / `super_admin` / `content_admin` 四种职能 | **是** | **高** —— 全给 `super_admin` 会**过度授权**；全给 `content_admin` 会让现有管理员**掉权**（`content_admin` 不在 `ADMIN_ROLES` 中） |
| *(App 无)* | `teacher` | — | App 侧无对应角色，教师身份只存在于 Portal | — | — |
| *(App 无)* | `applicant` / `mentor` / `finance` | — | 同上 | — | — |

**必须由用户/学院逐人决定 `admin` 的目标角色**，不能批量转换。
当前 App 中 `role='admin'` 的账号数需在 DB-1 前清点（生产库不可读，本轮无法执行）。

### 其他角色域（不可混淆）

```
room_members.role  ('member' | 'moderator')   ← 房间运营权，与账号角色是**不同权限域**
                                                （D-16 前已确立：account role ≠ room role）
```

---

## 7. User-Owned Tables

**23 张用户所属表，其中 20 张没有任何外键。**

| Table | Owner 列 | FK? | 可产生孤儿? | 现有应用层校验 | 目标 FK | ON DELETE | 风险 |
|---|---|---|---|---|---|---|---|
| **`growth_state`** | `user_id` | ❌ | **是** | 仅 `requireAuth` | → `auth.users(id)` | `CASCADE` | **P0**（CP 全部数据） |
| **`course_progress`** | `user_id` | ❌ | **是** | 仅 `requireAuth` | → `auth.users(id)` | `CASCADE` | **P0** |
| **`posts`** | `user_id` | ❌ | **是** | 仅 `requireAuth` | → `auth.users(id)` | `SET NULL` + tombstone（R-10） | **P1** |
| `post_comments` | `user_id` | ❌ | 是 | `requireAuth` | → `auth.users(id)` | `SET NULL` + tombstone | P1 |
| `post_likes` | `user_id` | ❌ | 是 | `requireAuth` | → `auth.users(id)` | `CASCADE` | P2 |
| **`prayer_shares`** | `user_id`（**已可空**） | ❌ | 是 | `author_state` tombstone | → `auth.users(id)` | **`SET NULL`**（R-10 已实现语义） | **P1** |
| `prayer_intercessions` | `user_id` | ❌ | 是 | `requireRoomMember` | → `auth.users(id)` | `CASCADE` | P2 |
| `pt_state` | `user_id` | ❌ | 是 | `requireAuth` | → `auth.users(id)` | `CASCADE` | P1 |
| `library_favorites` | `user_id` | ❌ | 是 | `requireAuth` | → `auth.users(id)` | `CASCADE` | P2 |
| `push_tokens` | `user_id` | ❌ | 是 | `requireAuth` | → `auth.users(id)` | `CASCADE` | P2 |
| `recordings` | `user_id` | ❌ | 是 | `requireAuth` | → `auth.users(id)` | `CASCADE` | P2 |
| `room_presence` | `user_id` | ❌ | 是（易失，TTL 45s） | `requireRoomMember` | → `auth.users(id)` | `CASCADE` | P3 |
| `friend_requests` | `from/to_user_id` | ❌ | 是 | 应用层 | → `auth.users(id)` ×2 | `CASCADE` | P2 |
| `friendships` | 成对 user id | ❌ | 是 | 应用层 | → `auth.users(id)` ×2 | `CASCADE` | P2 |
| `image_uploads` | `uploaded_by` | ❌ | 是 | `requireAuth` | → `auth.users(id)` | `SET NULL` | P2 |
| `announcements` | `published_by` | ❌ | 是 | `requireAdmin` | → `auth.users(id)` | `SET NULL` | P2 |
| `courses` | `created_by` | ❌ | 是 | `requireAdmin` | *(见 §8：可能不迁)* | — | P1 |
| `room_prayer_topics` | `created_by` | ❌ | 是 | `requireRoomManager` | → `auth.users(id)` | `SET NULL` | P2 |
| `rooms` | `host_id` | ❌ | **特例** | `host_id='system'` 是**哨兵值**，非真实用户 | **不可直接加 FK** | — | **P1**（加 FK 会让 5 个内置房间插入失败） |
| `refresh_jti` | `user_id` | ❌ | 是 | — | **不迁移**（RB-27 死表） | — | — |
| `legacy_user_map` | `legacy/supabase_user_id` | ❌ | 是 | `auth/identity.ts` | 迁移期保留，之后降级审计 | — | **P0** |
| `room_members` | `user_id` | ✅ | 否 | +FK | 已有 | 保持 | 低 |
| `room_reading_state` | `updated_by` | ✅ | 否 | +FK | 已有 | 保持 | 低 |

> **`rooms.host_id = 'system'` 是本轮发现的具体陷阱**：它不是 uuid，也不指向任何用户。
> 直接加 `FOREIGN KEY (host_id) REFERENCES auth.users(id)` 会让 5 个内置公共房间无法插入。
> 目标设计必须把 `host_id` 改为**可空** + 单独的 `is_system boolean`，或改用 `owner_kind` 判别列。

---

## 8. Portal / App Schema Overlap

| 实体 | App SQLite | Portal Supabase | 分类 | 处置建议 |
|---|---|---|---|---|
| 用户身份 | `users` | `auth.users` + `profiles` | **DUPLICATE MODEL** | **MERGE INTO EXISTING** —— App `users` 并入 `profiles`；`password_hash`/`salt` **不迁** |
| 角色 | `users.role`（2 值） | `user_roles`（9 值枚举） | **DUPLICATE MODEL** | **MERGE INTO EXISTING**，按 §6 矩阵逐人映射 |
| 课程目录 | `courses` | `course_catalog` | **SAME ENTITY** —— `course_catalog.code` 注释明写「与 App OFFICIAL_CATALOG 的 id 一致（`c_matthew…`）」 | **MERGE INTO EXISTING**。`courses` 独有列（`thumbnail`, `thumbnail_image_id`, `total_lessons`）→ **EXTEND EXISTING** |
| 学习进度 | `course_progress` | **不存在**（PORTAL 侧 `in_progress`/`completed` 为 NOT IMPLEMENTED） | **APP-ONLY** | **CREATE NEW**，但必须与 `course_catalog.code` 对齐外键 |
| 学生 | 无（只有 `users.role='student'`） | `student_records` + `student_number_registry` | **PORTAL-ONLY** | App 不引入 |
| 申请人 | 无 | `applications` 等 6 张 | **PORTAL-ONLY** | App 不引入 |
| 教师 | 无 | `teacher_profiles` 等 4 张 | **PORTAL-ONLY** | App 不引入 |
| 项目/学位 | 无 | `program_catalog` | **PORTAL-ONLY** | — |
| Christian Profile | `growth_state.state_json` | **不存在** | **APP-ONLY** | **CREATE NEW**（见 §12） |
| 祷告室 / 语音 / 社群 | 14 张 | 不存在 | **APP-ONLY** | **CREATE NEW** |
| 审计 | 无 | `audit_logs`, `security_events` | **PORTAL-ONLY** | App 迁移后应接入现有审计，**不建第二套** |

> **核心风险**：若按「一张 SQLite 表 = 一张新 Postgres 表」机械迁移，
> 会立刻产生**第二套 user 模型、第二套 course 模型、第二套 role 模型**，
> 与 D-2B-1（Supabase 为统一 SoT）直接冲突。**必须先合并，再迁移。**

---

## 9. Existing Supabase Schema

```
表        26   applications · application_hq_approvals · application_internal ·
               application_requirements · application_status_history · audit_logs ·
               course_catalog · data_export_logs · hq_approval_internal ·
               irreversible_record_sources · login_aliases · profiles ·
               program_catalog · recovery_flows · security_events ·
               student_number_registry · student_number_void_requests ·
               student_records · student_status_history · submissions ·
               teacher_invitations · teacher_profiles · teacher_profiles_internal ·
               teacher_verification_internal · teacher_verification_requests · user_roles

枚举      15   account_status · alias_type · application_pathway · application_status ·
               course_availability · course_category · hq_approval_status ·
               irreversible_verdict · number_void_status · recovery_flow_status ·
               student_number_state · student_status · teacher_profile_status ·
               teacher_verification_status · user_role

RLS       26 张表启用 · 36 条 policy
函数      80 处 SECURITY DEFINER
触发器    22
```

**身份关系**：`profiles.id uuid primary key references auth.users(id) on delete cascade`
—— Portal 的 canonical person identity 已经是 `auth.users.id`。

---

## 10. PostgreSQL Target Model

> 完整逐表映射见 `SQLITE_TO_POSTGRES_SCHEMA_MAP.md`（DB-1 产出）。
> 本节先给**类型与结构的统一规则**，逐表细节待 DB-1。

| SQLite | Postgres | 转换 |
|---|---|---|
| `TEXT` 主键（uuid 字符串） | `uuid` | 需先扫描合法性；非法值必须先修数据 |
| `INTEGER`（epoch ms） | `timestamptz` | **`to_timestamp(col / 1000.0)`** —— 直接搬会得到 1970 年 |
| `INTEGER` 0/1 | `boolean` | `col <> 0` |
| `TEXT` JSON | `jsonb` | 需同步改读写代码；或先保持 `text` 降低一次性风险 |
| `CHECK(col IN (...))` | 原生 `enum` 或保留 `check` | 值域必须先与 Portal 枚举对齐 |
| `TEXT COLLATE NOCASE`（email） | `citext` 或 `lower()` 唯一索引 | 否则丢失大小写不敏感唯一性 |
| 无 FK | 显式 `FOREIGN KEY` | 迁移前必须先清理孤儿行（§14 P0） |

---

## 11. Authorization Boundaries

**不因为迁到 Supabase 就让浏览器直接访问所有表。** 按真实 access path 分类：

### TYPE A — Backend Owned（`Browser → Express API → PostgreSQL`）

```
posts · post_likes · post_comments · friend_requests · friendships
rooms · room_members · room_presence · room_realtime_events · room_reading_state
room_prayer_topics · prayer_sessions · prayer_session_items · prayer_session_events
prayer_shares · prayer_intercessions · prayer_share_reports
recordings · image_uploads · push_tokens · library_books · library_favorites
course_files · cooperation_submissions · announcements
```

**后端 Express 仍是主要授权边界**（现有 `requireRoomMember` / `requireRoomManager` /
`requireReadingRoom` 等逻辑保持不变）。
这些表**不对 anon / authenticated 客户端开放**，仅 service role 可达。
**仍应启用 RLS 并默认拒绝**，作为纵深防御——但不为它们编写面向浏览器的 policy。

### TYPE B — Portal Direct（`Browser → Supabase`）

```
profiles · user_roles · applications · application_* · student_records
student_status_history · course_catalog · program_catalog · teacher_* · audit_logs
```

**已有 26 张表启用 RLS、36 条 policy**，保持现状，最小权限。

### TYPE C — Shared（两侧都要访问）

| 表 | Portal 用途 | App 用途 | 边界要求 |
|---|---|---|---|
| `profiles` | 人物资料读写 | App 读展示名/头像 | RLS 本人可读写；App 经 service role 读 |
| `user_roles` | 授权 | `fetchActiveRoles` 现查 | RLS 只读本人；App 经 service role 查任意人 |
| `course_catalog` | 课程目录呈现 | App 课程列表 | RLS 匿名可读（已是公开目录）；写入仅 service |
| **`course_progress`**（新建） | 未来学籍需要 | App 读写本人进度 | **DECISION_REQUIRED** —— 决定是走 App 后端还是 Portal 直连 |
| **`growth_state`**（新建） | 未来 CP 呈现 | App 读写本人 | **DECISION_REQUIRED** —— 同上 |

> TYPE C 的两项 `DECISION_REQUIRED` 必须在 DB-1 前定，
> 因为它决定这两张表是否需要面向浏览器的 RLS policy。

---

## 12. Christian Profile Migration

### 当前持久化形态

```
位置    growth_state(user_id TEXT, state_json TEXT, updated_at INTEGER)
        —— 3 列，无 FK，无索引
文档键  amas_ct_state_v2
同步    localStorage（每题自动保存）→ /api/growth/state → growth_state.state_json
owner   growth_state.user_id（App users.id）
```

**CP 在数据库里没有任何关系模型 —— 它是一个不透明 JSON blob。**
题目、答案、12 项倾向分数、历史快照、实践证据、导师观察全部在这一列里。

### 已有数据是否存在

**UNKNOWN。** 生产库不存在（App 无部署），staging 库不可读。
本地 dev/test 库的数据是 fixture，不具代表性。

### Target schema

两个方向，需 DB-1 决定：

| 方案 | 做法 | 优点 | 代价 |
|---|---|---|---|
| **A. 保持 blob** | `christian_profile(user_id uuid PK → auth.users, state jsonb, updated_at timestamptz)` | 迁移=搬一列，**天然不重算**；读写代码几乎不改 | 数据库无法查询倾向分数；未来做统计要先解析 |
| **B. 关系化** | 拆成 `cp_sessions` / `cp_answers` / `cp_profiles` / `cp_evidence` 等 | 可查询、可统计、可加约束 | **必须重新解释历史 blob**，风险高；违反「只迁持久化状态、不重算」 |

> **推荐 A**。理由：Supervisor 明确要求「只迁移持久化状态，**不重新计算**用户结果」。
> 方案 B 在迁移过程中就要解释 blob 结构，一旦解析逻辑与 `store.ts` 有细微差异，
> 用户会看到**无解释的结果变化** —— 这正是要防的事。关系化可作为迁移后的独立议题。

### 如何证明迁移前后完全一致

**现有 20 项 CP regression + 3 个 golden snapshot 作为 migration gate**：

```
迁移前   跑一次 christianProfileScoring.test.ts → 20/20，snapshot 记录基线
迁移后   同一份 blob 从 Postgres 读回 → 再跑一次 → 必须仍 20/20 且 snapshot 未变
额外     对每个真实用户 blob 做 SHA256，迁移前后逐一比对，**必须逐字节相同**
```

方案 A 下这是可以做到「逐字节相同」的强证明；方案 B 做不到。

---

## 13. Migration Dependency Order

按**真实 schema** 推导（非示例照抄）：

| Phase | Tables | 依赖 | Verification | Rollback point |
|---|---|---|---|---|
| **DB-1** | *(无数据迁移)* schema 基线快照 + repository 接口层设计 | — | 全量回归仍绿 | 代码可 revert |
| **P1 身份** | `profiles` 扩展 / `legacy_user_map` 导入 | 无 | 每个 App `users.id` 都能解析出 `auth.users.id`；**零无法映射** | 只写映射表，不动业务数据 |
| **P2 角色** | `user_roles` | P1 | `admin` 逐人映射结果经人工确认（§6） | 可撤销授予 |
| **P3 课程目录合并** | `course_catalog`（扩展列） | P1 | 67 门课 code 一一对应，`credits` 仍为 null | 扩展列可 drop |
| **P4 用户核心数据** | `growth_state` → `christian_profile`，`pt_state`，`course_progress` | P1,P3 | **CP blob 逐字节 SHA256 比对**（§12） | 快照回滚 |
| **P5 社群** | `posts`, `post_likes`, `post_comments`, `friend_requests`, `friendships` | P1 | 行数一致；孤儿行已按 R-10 tombstone 处理 | 快照回滚 |
| **P6 祷告室 / 房间** | `rooms`, `room_members`, `room_*`, `prayer_*` | P1 | 5 个内置房间的 `host_id='system'` 语义保持（§7 陷阱） | 快照回滚 |
| **P7 附属** | `library_*`, `recordings`, `image_uploads`, `push_tokens`, `course_files`, `announcements`, `cooperation_submissions` | P1 | 行数一致 | 快照回滚 |
| **不迁移** | `refresh_jti`（RB-27 死表）· `users.password_hash/salt` | — | — | — |

`room_presence` / `room_realtime_events` 为**易失数据**（TTL 45s / 事件轮询），
建议**不迁移**，迁移后自然重建。

---

## 14. Risk Register

| ID | 风险 | Sev | 说明 |
|---|---|---|---|
| **DBR-01** | **孤儿行** —— 20 张用户所属表无 FK，历史数据可能引用已不存在的 `users.id` | **P0** | 加 FK 前必须全表扫描；孤儿必须按 R-10 tombstone 或删除，**逐条决定不得批量** |
| **DBR-02** | **`admin` 角色映射歧义** | **P0** | App 单一 `admin` → Portal 四种职能角色。批量给 `super_admin` 是过度授权，给 `content_admin` 会静默掉权（不在 `ADMIN_ROLES`） |
| **DBR-03** | **无 schema 版本号** | **P0** | 运行期 `ALTER TABLE` 打补丁，无法判定某部署处于哪个 schema 状态；迁移前必须建基线快照 |
| **DBR-04** | **同步 → 异步 DAL 改造** | **P0** | `better-sqlite3` 全同步，`pg` 全异步。5 处 `db.transaction()` 的同步闭包改异步后事务边界易断 |
| **DBR-05** | **CP blob 归属错配** | **P0** | `growth_state.user_id` 无 FK；映射错一个人，其全部成长档案归错人且**无从察觉**（blob 内不含身份） |
| **DBR-06** | **时间戳漂移** | **P1** | INTEGER epoch ms 直接搬进 `timestamptz` 会得到 1970 年附近；需 `to_timestamp(ms/1000.0)` |
| **DBR-07** | **重复 user / course 模型** | **P1** | 机械 1:1 迁移会造出第二套 user/course/role 模型，与 D-2B-1 冲突 |
| **DBR-08** | **email 大小写唯一性丢失** | **P1** | `COLLATE NOCASE` 无等价直译；不处理会产生大小写不同的重复邮箱 |
| **DBR-09** | **`rooms.host_id='system'`** | **P1** | 哨兵值非 uuid、非真实用户；直接加 FK 会让 5 个内置房间插入失败 |
| **DBR-10** | **枚举值域不匹配** | **P1** | SQLite `CHECK(... IN ...)` 的值未必在 Portal 现有枚举内，插入会失败 |
| **DBR-11** | **JSON → jsonb 转换** | **P2** | 4 列 JSON-in-TEXT；转 jsonb 需同步改读写代码 |
| **DBR-12** | **uuid 格式非法** | **P2** | TEXT 主键存的未必都是合法 uuid（历史值来源不一） |
| **DBR-13** | **唯一冲突** | **P2** | 部分唯一索引与 upsert 语义在 Postgres 下未必等价 |
| **DBR-14** | **数据静默丢失** | **P2** | `INSERT OR IGNORE`（6 处）在 Postgres 下若映射为 `ON CONFLICT DO NOTHING`，冲突目标列必须完全一致，否则行为不同 |
| **DBR-15** | **单实例假设** | **P2** | 代码内明确警告 SINGLE-INSTANCE；迁 Postgres 后多实例并发需重新验证 realtime 与 presence |
| **DBR-16** | **App 无生产数据可验证** | **P3** | App 从未部署，迁移演练只能用 fixture；真实数据形态未知 |

---

## 15. Required Migrations

**本轮不执行，仅列出 DB-1 需要产出的迁移。**

| # | 内容 | 前置 |
|---|---|---|
| M-0 | **SQLite schema 基线快照工具** —— 把运行期补丁后的真实 schema 导出为确定性 DDL | 无（DBR-03 的解药） |
| M-1 | 孤儿行扫描脚本（只读，输出报告，不改数据） | M-0 |
| M-2 | `legacy_user_map` 完整性校验（每个 `users.id` 都能解析） | M-1 |
| M-3 | Postgres 目标 schema（`0023_app_core.sql` 起） | §10 逐表映射完成 |
| M-4 | `profiles` 扩展列（承接 App `users` 的 `degree`/`bio` 等） | M-3 |
| M-5 | `course_catalog` 扩展列（`thumbnail`, `total_lessons` 等） | M-3 |
| M-6 | 数据导入脚本（按 §13 分阶段，每阶段可独立回滚） | M-3..M-5 |

---

## 16. Required Tests

| # | 测试 | 守住什么 |
|---|---|---|
| T-1 | **CP blob 逐字节 SHA256 比对**（迁移前后） | DBR-05 · §12 |
| T-2 | 现有 20 项 CP regression + 3 golden snapshot 在 Postgres 读回后仍全绿 | §12 migration gate |
| T-3 | 孤儿行为零（加 FK 后） | DBR-01 |
| T-4 | 每个角色映射的授权结果与迁移前一致（尤其 `admin`） | DBR-02 |
| T-5 | 时间戳往返（写入 → 读出 → 与原 epoch ms 相等） | DBR-06 |
| T-6 | 大小写不同的重复邮箱被拒 | DBR-08 |
| T-7 | 5 个内置房间在有 FK 的 schema 下仍能创建 | DBR-09 |
| T-8 | 5 处事务在异步 DAL 下的回滚行为 | DBR-04 |
| T-9 | 双实例并发写（presence / realtime） | DBR-15 |
| T-10 | 全量回归（前端 181 + 后端 138）在 Postgres 下仍全绿 | 总闸门 |

---

## 17. Documentation Updates

### TASK 14 — RB-28 部署要求（**只记变量名，不记值**）

| 变量 | 用途 | DEV | STAGING | PRODUCTION |
|---|---|---|---|---|
| `VITE_SUPABASE_URL` | 前端 Supabase 项目地址；`supabaseEnabled` 的判定依据之一 | 必需 | **必需** | **必需** |
| `VITE_SUPABASE_ANON_KEY` | 前端 anon / publishable key | 必需 | **必需** | **必需** |

> **AUTH-M7 之后这两项是硬依赖**：未配置时 App **不能登录**
> （`requireSupabase()` 抛 503 并说明原因，不再静默回落到已移除的 legacy 端点）。
> 已写入 `OPEN_ISSUES.md` RB-28，本报告正式纳入部署 / staging / production 清单。

### TASK 15 — AUTH-M7 文档口径确认

```
AUTH-M7                    IMPLEMENTED / LOCALLY VERIFIED
外部 AUTH 测试（6 项）      IMPLEMENTED / ENVIRONMENT-UNVERIFIED
```

已在 `AUTH-M7-COMPLETION-REPORT.md`、`ACCEPTANCE_HISTORY.md`、
`OPEN_ISSUES.md`（RB-26）、`DECISION_LOG.md`（D-17）四处一致记录。
**绝不写 INTEGRATION VERIFIED**，直到真实 staging Supabase 测试完成。

---

## 18. Proposed DB-1 Plan

**DB-1 只做两件事，仍不迁数据、不切 driver：**

```
DB-1a  SQLite schema 基线快照工具（M-0）
       解决 DBR-03：运行期 ALTER 打补丁导致无法判定 schema 状态。
       产出确定性 DDL，作为一切后续比对的基准。

DB-1b  逐表 SQLITE_TO_POSTGRES_SCHEMA_MAP.md
       按 §10 的统一规则，为 32 张表逐一写出：
       column mapping / type mapping / PK / FK / unique / indexes /
       defaults / check / delete behavior / identity mapping /
       RLS requirement / access path / data transformation /
       migration order / verification / rollback risk
```

**DB-1 明确不做**：repository 接口层重构（那是 DB-2）· 任何数据写入 · 任何 Postgres 连接。

### 需要 Supervisor 在 DB-1 前决定

| # | 决策点 | 为什么必须先定 |
|---|---|---|
| 1 | **`admin` 角色的目标映射**（DBR-02） | 影响 §6 矩阵与 M-2；批量转换会造成过度授权或静默掉权 |
| 2 | **CP 迁移方案 A（保持 blob）还是 B（关系化）** | 决定 §12 的 target schema 与能否做「逐字节相同」证明 |
| 3 | **`course_progress` / `growth_state` 属 TYPE A 还是 TYPE C** | 决定这两张表是否需要面向浏览器的 RLS policy |
| 4 | **App `users` 表是并入 `profiles` 还是保留为投影** | 决定是否彻底消灭第二身份空间 |

---

# 状态

```
DB-0 NEEDS DECISION
```

事实审计与目标建模已完成（TASK 1–15 全部执行）。
**但 DB-1 无法在四项决策未定的情况下开始** —— 其中 `admin` 角色映射与 CP 迁移方案
会直接改变目标 schema 的形状，先设计后返工的代价远高于先决策。

未开始 DB-1。未修改任何 DAL、repository、driver，未执行任何 migration。
