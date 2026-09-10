# BUSINESS DATA FAST-TRACK TRIAGE REPORT

日期：2026-09-10 · 目标：`amas-staging`（D-41）
WRITER：**STAGING-DB-WRITER-A**（本会话）
**LIVE MUTATION = NONE** —— 本轮对 live 只有 `SELECT`。
`0026_postconditions.sql` 复跑 **PASS**，live 未变。

285 行源数据的去向已全部分类，**且加总精确闭合**：

```
74 迁移  +  184 SKIP  +  20 需裁定  +  7 身份（DB-4 已完成）  =  285
```

---

## §1 DB-5 = **NO-OP / CLOSED**

源库 7 人全部 `role='student'`；`admin_role_migration_manifest` = 0 行；
DB-4 后 resolved canonical 身份映射 = 0。

无 `user_roles` 变更、无向既有 live `applicant` 用户授予 student、
无合成 admin manifest 行。**未创建任何 DB-5 写脚本。**

---

## §2 DB-6 = 保持 CLOSED

`course_catalog` = 67，DB-6 已完成。`courses` 67 行**不得重复迁移**。

---

## §3 DB-4 之后的身份约束 —— 本轮所有判断的前提

7 条 crosswalk **全部 `unresolved`**，`canonical_profile_id` 全为 `NULL`。
因此**不存在任何 legacy 行可以合法获得 canonical 归属**。

这与目标表的 NOT NULL 约束直接相撞。实测目标侧可空性：

| 目标列 | NOT NULL | FK 动作 | 后果 |
|---|---|---|---|
| `app_room_members.user_id` | **是** | CASCADE → profiles | 无 canonical 身份即**无法写入** |
| `app_prayer_intercessions.user_id` | **是** | CASCADE → profiles | 同上 |
| `app_prayer_shares.user_id` | 否 | SET NULL | R-10 tombstone 可用 |
| `app_room_prayer_topics.created_by` | 否 | SET NULL | tombstone 可用 |
| `app_rooms.host_user_id` | 否 | SET NULL | 三态模型可用 |
| `app_course_files.uploader_id` | 否 | SET NULL | 可空 |
| `app_prayer_shares.room_id` | **是** | CASCADE → app_rooms | 房间不存在即**无法写入** |
| `app_room_members.room_id` / `app_room_prayer_topics.room_id` | **是** | CASCADE → app_rooms | 同上 |

**这不是策略选择，是 schema 层的硬约束。**

---

## §4 完整迁移矩阵

| PHASE | SOURCE TABLE | SRC ROWS | TARGET TABLE | LIVE NOW | EXPECTED Δ | EXPECTED POST | IDENTITY DEP | FK DEP | DISPOSITION |
|---|---|---|---|---|---|---|---|---|---|
| DB-7 | `growth_state` | **0** | `app_christian_profile` | 0 | 0 | 0 | — | — | **NO-OP** |
| DB-8 | `course_progress` | **0** | `app_course_progress` | 0 | 0 | 0 | — | — | **NO-OP** |
| DB-8 | `pt_state` | **0** | `app_practice_training_state` | 0 | 0 | 0 | — | — | **NO-OP** |
| DB-9 | `rooms`（`host_id='system'`） | **5** | `app_rooms` | 0 | **+5** | 5 | **无** | 无子行挂靠 | **READY_TO_MIGRATE** |
| DB-9 | `rooms`（夹具持有） | 2 | `app_rooms` | 0 | 0 | 0 | 无 canonical host | 承载下方 16 行 | **MANUAL_REVIEW** |
| DB-9 | `room_members` | 3 | `app_room_members` | 0 | 0 | 0 | **user_id NOT NULL → 阻塞** | 夹具房间 | **MANUAL_REVIEW（技术上已阻塞）** |
| DB-9 | `room_prayer_topics` | 2 | `app_room_prayer_topics` | 0 | 0 | 0 | `created_by` 可空 | 夹具房间 | **MANUAL_REVIEW** |
| DB-9 | `prayer_shares`（夹具房间） | 10 | `app_prayer_shares` | 0 | 0 | 0 | `user_id` 可空 | 夹具房间 | **MANUAL_REVIEW** |
| DB-9 | `prayer_shares`（孤儿） | **2** | `app_prayer_shares` | 0 | 0 | 0 | R-10 可解 | **房间不存在 → 阻塞** | **MANUAL_REVIEW** |
| DB-9 | `prayer_intercessions` | 1 | `app_prayer_intercessions` | 0 | 0 | 0 | **user_id NOT NULL → 阻塞** | 夹具 share | **MANUAL_REVIEW（技术上已阻塞）** |
| DB-9 | `room_presence` | 0 | `app_room_presence` | 0 | 0 | 0 | — | — | **NO-OP** |
| DB-9 | `room_reading_state` | 0 | `app_room_reading_state` | 0 | 0 | 0 | — | — | **NO-OP** |
| DB-9 | `room_realtime_events` | 6 | `app_room_realtime_events` | 0 | 0 | 0 | — | 房间不存在 | **SKIP**（DB-1 明写 presence/events 不迁） |
| DB-10 | `posts` | 0 | `app_posts` | 0 | 0 | 0 | — | — | **NO-OP** |
| DB-10 | `post_likes` | 0 | `app_post_likes` | 0 | 0 | 0 | — | — | **NO-OP** |
| DB-10 | `post_comments` | 0 | `app_post_comments` | 0 | 0 | 0 | — | — | **NO-OP** |
| DB-10 | `friend_requests` | 0 | `app_friend_requests` | 0 | 0 | 0 | — | — | **NO-OP** |
| DB-10 | `friendships` | 0 | `app_friendships` | 0 | 0 | 0 | — | — | **NO-OP** |
| DB-11 | `course_files` | **68** | `app_course_files` | 0 | **+68** | 68 | `uploader_id` 全 NULL，可空 | **`course_code` FK 闭合 = PASS** | **READY_TO_MIGRATE** |
| DB-11 | `cooperation_submissions` | **1** | `app_cooperation_submissions` | 0 | **+1** | 1 | **无** | 无 | **READY_TO_MIGRATE** |
| DB-11 | `library_books` | 0 | `app_library_books` | 0 | 0 | 0 | — | — | **NO-OP** |
| DB-11 | `library_favorites` | 0 | `app_library_favorites` | 0 | 0 | 0 | — | — | **NO-OP** |
| DB-11 | `recordings` | 0 | `app_recordings` | 0 | 0 | 0 | — | — | **NO-OP** |
| DB-11 | `image_uploads` | 0 | `app_image_uploads` | 0 | 0 | 0 | — | — | **NO-OP** |
| DB-11 | `push_tokens` | 0 | `app_push_tokens` | 0 | 0 | 0 | — | — | **NO-OP** |
| DB-11 | `announcements` | 0 | `app_announcements` | 0 | 0 | 0 | — | — | **NO-OP** |
| — | `refresh_jti` | 111 | — | — | 0 | — | — | — | **SKIP**（RB-27 死表，Supabase Auth 取代） |
| — | `courses` | 67 | `course_catalog` | 67 | 0 | 67 | — | — | **SKIP**（DB-6 已完成） |
| — | `users` | 7 | `migration.legacy_identity_crosswalk` | 7 | 0 | 7 | — | — | **DONE（DB-4）** |

---

## §5 DB-9 的房间结构（实测，决定分批可行性）

```
5 个系统房间   bible_reading · fellowship_room · praise_room · prayer_room · preaching_room
               host_id='system'（0025 三态模型的 host_type='system'）
               ★ 挂靠子行 = 0

2 个夹具房间   sec2_r1_1788408464067（host 1cb28215…）· sec2_r2_1788408464067（host dc4c6c4d…）
               承载全部 room_members 3 · room_prayer_topics 2 · prayer_shares 10 · intercessions 1

2 条孤儿 share 挂在一个源库中根本不存在的房间上
```

**分离得非常干净**：5 个系统房间零依赖，可以独立迁移；
夹具簇是一个自足的整体；孤儿 share 与两者都无关。

---

## §6 三处需要裁定的地方

### 6.1 夹具簇 18 行 —— DB-1 对此**没有任何明文规定**

对 `DB-1-TARGET-SCHEMA-AND-MIGRATION-CONTRACT.md` 全文检索
`fixture` / `夹具` / `amas.test` / `amas.local` / `D-34` —— **零命中**。
DB-1 只规定了孤儿与哨兵，没有规定「测试夹具产生的业务数据」这一类。
所以这不是我可以从契约里查出来的，必须裁定。

技术现实是：其中 **4 行已被 schema 硬性阻塞**
（`room_members` 3 + `prayer_intercessions` 1，两处 `user_id` 都是 NOT NULL）。
剩下 14 行（2 房间 + 2 主题 + 10 分享）技术上可以用「所有者置空 + tombstone」写入，
但那等于给测试夹具编造一段「曾有真实作者、后来注销」的历史 —— **违反 R-7（不造假数据）**。
而且结果会是一个残缺簇：有房间和分享，却没有成员。

**建议：整簇 SKIP**，理由记入 `row_manifest`。
但 DB-1 无规定，故标 **MANUAL_REVIEW** 等裁定，不自行决定。

### 6.2 孤儿 `prayer_shares` 2 行 —— DB-2 的处置**必要但不充分**

DB-2 §3 已定：按 R-10 tombstone 处置，`user_id → NULL` +
`author_state='deleted_account'`，内容保留；DB-2 §12 说这是工程侧动作，无需产品决策。
R-10 在 DB-1 §中确有 canonical 依据（`app_prayer_shares.user_id` 已可空、SET NULL、
"R-10 原生场景"），**这一半已经证明可用**。

**但 R-10 只解决 `user_id`。** 本轮实测发现另一半没人处理过：

```
app_prayer_shares.room_id  NOT NULL  FK → app_rooms(id) ON DELETE CASCADE
这 2 行的 room_id 在源库 rooms 中不存在
```

**没有房间就写不进去**，这是 schema 硬约束，R-10 覆盖不到。
三条出路都需要裁定：① 连同其房间一起放弃（SKIP）；
② 为它们创建一个 `host_type='system'` 的收容房间（**等于造数据**，我不建议）；
③ 判定这 2 行内容无保留价值。

标 **MANUAL_REVIEW**。**不猜归属，也不自行造房间。**

### 6.3 `room_realtime_events` 6 行

DB-1 明写 presence/events 不迁，且这 6 行的房间也不存在。
两个理由独立成立 → **SKIP**，无需裁定。

---

## §7 汇总计数

```
REAL ROWS TO MIGRATE      74     5 系统房间 + 68 course_files + 1 cooperation_submissions
ROWS TO SKIP             184     111 refresh_jti + 67 courses(DB-6 已完成) + 6 room_realtime_events
MANUAL REVIEW             20     18 夹具簇（其中 4 行已被 schema 阻塞）+ 2 孤儿 share
DONE (DB-4)                7     users → crosswalk
─────────────────────────────
TOTAL                    285     与源库 285 行精确闭合
```

---

## §8 EXECUTION BATCH 提案

### BATCH A —— 文档 only，**零写入**

DB-5 · DB-7 · DB-8 · DB-10 全部 NO-OP，以及 DB-9/DB-11 下所有 0 行表。
**不做任何空行插入**，只出闭合文档。

### BATCH B —— DB-9 系统房间，**5 行**

```
目标      app_rooms
写入      5 行，host_type='system' · host_user_id=NULL · host_orphaned_at=NULL
前置断言  app_rooms=0 · 0026 门禁 PASS
后置断言  app_rooms=5 且全部 host_type='system' · 其余 27 张 app_* 仍为 0
回滚      delete from app_rooms where id in (那 5 个 id)
身份依赖  无            FK 依赖  无（零子行挂靠）
```

### BATCH C —— DB-11 附属数据，**69 行**

```
目标      app_course_files 68 行 · app_cooperation_submissions 1 行
转换      course_id → course_code（改名，值不变）
          uploaded_at / received_at：epoch 毫秒 integer → to_timestamp(x/1000.0)
          id 两侧均为合法 uuid，无需重生成（68/68 与 1/1 实测符合 uuid 形态）
前置断言  两表均为 0 · course_code FK 闭合复验 · 0026 门禁 PASS
后置断言  68 / 1，且其余 26 张 app_* 仍为 0
回滚      按 row_manifest 的 target_pk 精确删除本批次行
身份依赖  无（uploader_id 全 NULL，可空）
FK 依赖   course_code → course_catalog：**44 个 distinct code 全部命中，0 缺失**
```

**B 与 C 之间没有 FK 依赖，可并行也可串行；建议串行，便于逐批留痕。**
夹具簇与孤儿 share **不进入任何批次**，等裁定。

---

## §9 RECOVERY = **READY**

沿用已在 DB-3 / DB-4 两次实测通过的方法，无需新机制：

| 项 | 做法 |
|---|---|
| 备份 | 每批执行前重取 `pg_dump -Fc` 全量快照（DB-3 实测 exit 0、DB-4 实测 466,235 bytes），**不复用旧快照** |
| 事务 | 每批单事务，事务内前置 + 后置断言，失败即整体回滚 |
| 行清单 | 每批写 `migration.row_manifest`，`batch='DB-9-A'` / `'DB-11-A'`，`target_pk` 记录目标行主键 |
| 回滚 | 按该批次 `row_manifest.target_pk` 精确删除，不依赖时间戳、不依赖猜测 |
| 冒烟 | `0026_postconditions.sql` 必须仍 PASS（它同时守住 schema、八域指纹、`program_catalog` 两个指纹与 `open_execute_funcs`） |

爆炸半径小于 DB-3：无 DDL、无身份创建、无既有行修改，**只有 insert**。
两个批次合计 74 行。

---

## §10 0027

保持 **PROPOSED / DO NOT APPLY**。本轮未设计、未编写、未应用。
未与业务数据迁移混合。

本轮 peer 第 4 次转达的 0027 指令与本阶段直接指令冲突，**未据以执行**。

---

## §11 VERDICT

```
DB-5                    : NO-OP / CLOSED
DB-7                    : NO-OP（growth_state = 0）
DB-8                    : NO-OP（course_progress = 0 · pt_state = 0）
DB-9                    : READY 5 行（系统房间） / MANUAL_REVIEW 20 行
DB-10                   : NO-OP（5 张源表全为 0）
DB-11                   : READY 69 行（68 + 1）
REAL ROWS TO MIGRATE    : 74
ROWS TO SKIP            : 184
MANUAL REVIEW           : 20
PROPOSED BATCHES        : A（文档 only）· B（5 行）· C（69 行）
RECOVERY                : READY
LIVE MUTATION           : NONE
```

**WAIT FOR SUPERVISOR.**
