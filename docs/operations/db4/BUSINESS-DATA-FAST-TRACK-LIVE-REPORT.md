# BUSINESS DATA FAST-TRACK LIVE REPORT

日期：2026-09-10 · 目标：`amas-staging`（D-41）
WRITER：**STAGING-DB-WRITER-A**（本会话，唯一写者）

```
BATCH B                          = PASS
BATCH C                          = PASS
DB-9                             = 5 MIGRATED / 26 SKIPPED
DB-11                            = 69 MIGRATED
TOTAL BUSINESS MIGRATED          = 74
TOTAL SOURCE SKIPPED             = 204
MANUAL REVIEW                    = 0
ROW_MANIFEST TOTAL               = 107
0026 POSTCONDITION               = PASS
LEDGER                           = 0001–0026
0027                             = ABSENT
LIVE MUTATION OUTSIDE B/C        = NONE
```

---

## §1 执行方式

B 与 C 是**两个完全独立的有界事务**，各自带保险丝
（缺 `-v i_understand_this_writes=YES` 直接中止）、前置断言、
事务内硬断言、失败即整体回滚。

两个脚本都**不放在 `supabase/migrations/`**（不是 migration apply，
不得产生新 ledger 版本），也**不放在 `supabase/tests/`**（那是纯 SELECT 探针）。
两者非注释写语句自检均为 **0 条 UPDATE / DELETE / DDL —— 只有 INSERT**。

两批都先在本地 PG 17.6 沙箱 `amas_db4`（post-0026 + DB-4 crosswalk 的克隆）
完整试跑通过后，才对 live 执行。

### 每批前置协议（§9），逐项执行

| 步骤 | BATCH B | BATCH C |
|---|---|---|
| `0026_postconditions.sql` | PASS | PASS |
| 目标表仍为空 | rooms/members/topics/shares/interc/events 全 0 | files 0 · coop 0 · DB-11 manifest 0 |
| 源计数复核 | system 房间 5 · DB-9 非零源行 31 | course_files 68 · distinct course_id 44 · coop 1 |
| 全新快照（不复用） | 466,235 bytes · `8c7ae34a…` | 466,326 bytes · `e92b3377…` |
| 无意外 live 漂移 | 确认 | 确认（`app_rooms=5` 为 B 的结果） |

---

## §2 BATCH B — DB-9 系统房间

### 迁移的 5 行

```
bible_reading · fellowship_room · praise_room · prayer_room · preaching_room
host_type = 'system'   host_user_id = NULL   host_orphaned_at = NULL
password_hash / password_salt : 源库实测均为 NULL，原样搬运，未发明值
created_at : epoch 毫秒 1788408535219 → 2026-09-03 04:08:55.219+00
```

符合 0025 三态 host 模型的 `system` 分支。这 5 个房间在源库中**零子行挂靠**，
因此与被排除的夹具身份天然独立 —— 不是靠人为切割做到的。

### 未迁移的 26 行（全部 SKIPPED，非 MANUAL_REVIEW）

| SKIP 原因 | 行数 | 构成 |
|---|---|---|
| `TEST_FIXTURE_DERIVED` | **18** | 2 夹具房间 + 3 room_members + 2 room_prayer_topics + 10 夹具 prayer_shares + 1 prayer_intercession |
| `ORPHAN_MISSING_ROOM_PARENT` | **2** | 孤儿 prayer_shares（`room_id` NOT NULL FK，其房间在源库中不存在） |
| `EPHEMERAL_EVENT_DO_NOT_MIGRATE` | **6** | room_realtime_events（canonical 契约明写不迁） |

按裁定：未创建 canonical 身份 · 未置空所有者做 tombstone ·
未把夹具房间 systemize · 未编造注销用户历史 · 未保留残缺房间簇 ·
未创建合成房间 / 收容房间 / 合成用户 / 合成归属。

### POST-BATCH B 实测

```
app_rooms = 5，全部 host_type='system' 且 host_user_id / host_orphaned_at 均为 NULL
app_room_members = app_room_prayer_topics = app_prayer_shares
  = app_prayer_intercessions = app_room_realtime_events = 0
DB-9 row_manifest : MIGRATED 5 · SKIPPED 26 · 合计 31 · manual_review 全 false
auth.users / profiles / user_roles = 1 / 1 / 1（未变）
ledger = 26 · 0027 ABSENT · 0026 门禁 PASS
```

---

## §3 BATCH C — DB-11 附属数据

### 存储契约（§7 要求先答的问题）

`app_course_files` 是**元数据索引**，二进制留在 App 后端本地磁盘
`backend/uploads/course-files`（`backend/src/db.ts` 的注释原文：
"Binary lives on disk (uploads/course-files); this table is the metadata index"）。

因此按 §7 做了一次**有界资产存在性检查**：

```
course_files 引用的 stored_name : 68
磁盘上实际存在                  : 68   缺失 = 0
磁盘上存在但未被引用            : 213（历史遗留上传，不在本轮范围）
```

**68/68 全部有对应二进制。** 本阶段不重新设计存储。

### 迁移的 69 行

| 源 | 行数 | 目标 | 转换 |
|---|---|---|---|
| `course_files` | 68 | `app_course_files` | `course_id → course_code`（仅改名，值不变）· `uploaded_at` epoch 毫秒 → `to_timestamp(x/1000.0)` · `uploader_id` 源侧 68/68 为 NULL，保持 NULL · `id` 68/68 为合法 uuid，原样搬运 |
| `cooperation_submissions` | 1 | `app_cooperation_submissions` | `received_at` epoch 毫秒 → timestamptz · `id` 为合法 uuid |

写入前在事务内重新断言了 FK 闭合，未依赖执行前的一次性检查。

### POST-BATCH C 实测

```
app_course_files = 68 · app_cooperation_submissions = 1
distinct course_code = 44 · course_code 悬空 = 0（对 live course_catalog 完全闭合）
uploader_id 非空 = 0
DB-11 row_manifest : MIGRATED 69 · SKIPPED 0
其余 25 张 app_* 表合计 = 0
course_catalog = 67（未触碰）· program_catalog = 9
auth.users / profiles / user_roles = 1 / 1 / 1（未变）
ledger = 26 · 0027 ABSENT · 0026 门禁 PASS
```

---

## §4 最终业务态与闭合

### 已迁移的业务行

```
5   系统房间          → public.app_rooms
68  课程附件元数据      → public.app_course_files
1   合作/事奉申请      → public.app_cooperation_submissions
──────────────────────
74  合计
```

### 源库 285 行闭合

```
74   迁移
204  SKIP     = 178 既有 SKIP（111 refresh_jti + 67 courses/DB-6 已完成）
                + 26 本轮 DB-9 排除
7    DB-4 已完成（users → crosswalk）
0    MANUAL REVIEW
─────
285  与源库精确闭合
```

### `row_manifest` 全量

| batch | MIGRATED | SKIPPED | 合计 |
|---|---|---|---|
| `DB-4` | 0 | 7 | 7 |
| `DB-9` | 5 | 26 | 31 |
| `DB-11` | 69 | 0 | 69 |
| **总计** | **74** | **33** | **107** |

**未为任何空表制造合成 manifest 行。**
MIGRATED 合计 74 与实际写入的业务行数一致。

---

## §5 未做的事

未创建任何新的 auth 身份 · 未做任何角色变更 · 无 DDL ·
未产生新的 migration ledger 版本 · 未触碰 `course_catalog` ·
未应用 `0027` · 未自动进入任何后续阶段 · 未自动回滚 ·
未打印或提交任何凭据。

`supabase/migrations/` 改动 = 0，`supabase/tests/` 改动 = 0。

---

## §6 遗留

`SUPABASE_SERVICE_ROLE_KEY` 泄露仍为 **OWNER-ACCEPTED / DEFERRED**，
不是已关闭项。它仍阻塞 STG personas 与任何 public staging 暴露 ——
而且现在 live 已有 74 行真实业务数据，这一项的权重比之前更高。
（具体暴露位置不写入本公开仓库。）

DB-4 中 legacy `d470e79a…` 的 `mapping_method` 仍为 `unresolved`。
本轮所有 DB-9 排除判断都建立在「不存在任何 canonical 身份」之上；
若将来该裁定改变，被排除的 18 行夹具数据**不会**因此自动变得可迁 ——
它们被排除的理由是夹具来源，不是身份缺失。

---

## §7 VERDICT

```
BATCH B                   : PASS
BATCH C                   : PASS
DB-9                      : 5 MIGRATED / 26 SKIPPED
DB-11                     : 69 MIGRATED
TOTAL BUSINESS MIGRATED   : 74
TOTAL SOURCE SKIPPED      : 204
MANUAL REVIEW             : 0
ROW_MANIFEST TOTAL        : 107
0026 POSTCONDITION        : PASS
LEDGER                    : 0001–0026
0027                      : ABSENT
LIVE MUTATION OUTSIDE B/C : NONE
```

**未自动继续 `0027` 或任何后续阶段。STOP，WAIT FOR SUPERVISOR。**
