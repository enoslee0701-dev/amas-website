# STAGING-1A CANONICAL EXPECTED STATE

**AMAS · STAGING-1A —— 仓库侧 canonical 期望态基准（不依赖数据库直连）**
日期：2026-09-08 · 来源：`supabase/migrations/0001..0026` 静态提取

> **用途**：Supervisor 经授权通道执行 `supabase/tests/staging_readonly_probe.sql`
> 后，把输出与本文件逐项对拍。**目的是让比对变成机械动作，而不是临场判断。**
>
> **本文件不含任何 secret，也不依赖任何远端访问** —— 纯粹从仓库 SQL 源文件提取。
>
> **本轮未连接远端、未执行任何 mutation。**

---

## 1. 已确认远端事实（Supervisor 独立验证，非本会话取得）

```
project            amas-staging
DB connectivity    READ-ONLY SELECT VERIFIED
ledger             0001 .. 0010   （10 行）
population         auth.users = 1 · profiles = 1 · user_roles = 1
functions present  has_active_role · is_admin_any · student_guard · sync_alias_on_role_revoke
                   四者 SECURITY DEFINER = true
裁定               LEDGER DRIFT IS REAL
                   DO NOT REPAIR LEDGER · DO NOT DB PUSH · DO NOT APPLY 0023–0027
```

---

## 2. ★ 那四个函数其实分属两类 —— 只有两个是 drift 证据

这是本轮最重要的澄清。把四个混为一谈会高估 drift 范围。

| 函数 | canonical 定义位置 | 是否在 ledger 内 | 判定 |
|---|---|---|---|
| `has_active_role` | `0002_identity.sql` 定义，`0003_hardening.sql` **create or replace 覆盖** | ✅ 0002 与 0003 **都在** ledger | **预期存在，非 drift** |
| `is_admin_any` | 同上 | ✅ 同上 | **预期存在，非 drift** |
| `student_guard` | **仅** `0012_student_core.sql` | ❌ 0012 不在 ledger | **✔ drift 证据** |
| `sync_alias_on_role_revoke` | **仅** `0012_student_core.sql` | ❌ 同上 | **✔ drift 证据** |

> 前两个的存在完全符合 ledger（0002/0003 都已登记），
> **它们不能用来论证 drift**。真正的 drift 证据只有后两个。

---

## 3. ★ 一条可证伪的判别式：0003 是否真的生效

`has_active_role` 与 `is_admin_any` 在 0002 与 0003 中的定义**只差一处，但这一处是安全相关的**：

```
0002_identity.sql    ... security definer set search_path = public
0003_hardening.sql   ... security definer set search_path = ''      ← 加固版
```

因此远端这两个函数的 `proconfig`（探测包 **P2**）可以直接回答一个 ledger 回答不了的问题：

| 远端 `search_path` | 含义 |
|---|---|
| `search_path=` （空字符串） | ✅ 0003 真的落到了这两个函数上，与 ledger 一致 |
| `search_path=public` | ⚠ **ledger 声称 0003 已执行，但函数仍是 0002 的版本** —— 那么 drift 不止「0012 多执行了」，还包括「0003 少执行了」 |

> 这是本轮能提供的最便宜、最不可伪造的一条证据。**建议优先看 P2。**

---

## 4. 0011–0026 各自创建的对象（远端探测清单）

远端 ledger 停在 0010，因此下面每一项都应当**不存在**；
任何一项存在，都是带外执行的证据，须计入 drift 范围。

**汇总**：表 38 · 函数 44 · 枚举 17 · 触发器 9 · RLS 策略 10 · 索引 48

### `0011_requirement_field_unlock.sql`

- **函数**（1）：`review_application`

### `0012_student_core.sql`

- **表**（5）：`application_hq_approvals` · `hq_approval_internal` · `student_number_registry` · `student_records` · `student_status_history`
- **枚举**（2）：`hq_approval_status` · `student_status`
- **函数**（11）：`activate_student` · `admissions_ready_for_enrollment` · `append_only_guard` · `confirm_hq_approval` · `correct_student_number` · `create_student_record` · `my_student_record` · `my_student_timeline` · `normalize_student_number` · `student_guard` · `sync_alias_on_role_revoke`
- **触发器**（5）：`hq_approvals_set_updated_at` · `ssh_append_only` · `student_records_guard` · `student_records_set_updated_at` · `user_roles_alias_sync`

### `0013_rpc_context_single_use.sql`

- **函数**（1）：`application_protect_locked`

### `0014_history_guard_fk_safe.sql`

- **函数**（1）：`append_only_guard`
- **触发器**（1）：`ssh_append_only`

### `0015_student_number_states.sql`

- **表**（1）：`student_number_void_requests`
- **枚举**（2）：`number_void_status` · `student_number_state`
- **函数**（7）：`approve_student_number_void` · `correct_student_number` · `create_student_record` · `pending_number_void_requests` · `reject_student_number_void` · `request_student_number_void` · `student_number_has_irreversible_records`

### `0016_course_catalog.sql`

- **表**（1）：`course_catalog`
- **枚举**（2）：`course_availability` · `course_category`
- **函数**（1）：`course_catalog_guard`
- **触发器**（1）：`course_catalog_guard_t`

### `0017_student_experience.sql`

- **函数**（5）：`my_action_items` · `my_learning` · `my_student_capabilities` · `my_student_profile` · `update_my_contact`

### `0018_irreversible_record_registry.sql`

- **表**（1）：`irreversible_record_sources`
- **枚举**（1）：`irreversible_verdict`
- **函数**（1）：`student_number_has_irreversible_records`

### `0019_student_role_gating.sql`

- **函数**（6）：`my_action_items` · `my_learning` · `my_student_capabilities` · `my_student_profile` · `my_student_record` · `my_student_timeline`

### `0020_recovery_finalization.sql`

- **表**（1）：`recovery_flows`
- **枚举**（1）：`recovery_flow_status`
- **函数**（5）：`claim_recovery_flow` · `complete_recovery_flow` · `fail_recovery_flow` · `my_recovery_flow` · `start_recovery_flow`
- **触发器**（1）：`recovery_flows_set_updated_at`

### `0021_recovery_flow_liveness.sql`

- **函数**（4）：`claim_recovery_flow` · `my_recovery_flow` · `reap_stale_recovery_flows` · `start_recovery_flow`

### `0023_app_foundation.sql`

- **表**（2）：`app_image_uploads` · `migration`
- **枚举**（9）：`app_announcement_type` · `app_prayer_report_reason` · `app_prayer_report_status` · `app_prayer_session_event_type` · `app_prayer_session_status` · `app_push_platform` · `app_room_event_type` · `app_room_host_type` · `app_room_member_role`

### `0024_app_learning.sql`

- **表**（4）：`app_christian_profile` · `app_course_files` · `app_course_progress` · `app_practice_training_state`

### `0025_app_rooms_prayer.sql`

- **表**（12）：`app_prayer_intercessions` · `app_prayer_session_events` · `app_prayer_session_items` · `app_prayer_sessions` · `app_prayer_share_reports` · `app_prayer_shares` · `app_room_members` · `app_room_prayer_topics` · `app_room_presence` · `app_room_reading_state` · `app_room_realtime_events` · `app_rooms`
- **函数**（1）：`app_rooms_mark_host_orphaned`
- **触发器**（1）：`app_rooms_host_orphaned`

### `0026_app_community.sql`

- **表**（11）：`app_announcements` · `app_cooperation_submissions` · `app_friend_requests` · `app_friendships` · `app_library_books` · `app_library_favorites` · `app_post_comments` · `app_post_likes` · `app_posts` · `app_push_tokens` · `app_recordings`

---

## 5. 判读规则（避免把 drift 读错方向）

对 §4 中每一项，探测包 **P4** 会给出 `present` 布尔值。组合判读：

| ledger 已登记？ | 对象存在？ | 分类 | 处置 |
|---|---|---|---|
| ✅ | ✅ | `MATCH` | 无需动作 |
| ✅ | ❌ | **`SCHEMA_ONLY_DRIFT`** —— ledger 声称执行过，对象却没有 | **最危险的一类**：任何基于 ledger 的推进都会跳过它 |
| ❌ | ✅ | **`LEDGER_ONLY_DRIFT`** —— 带外执行 | 已确认存在（0012）。**不得**因此 repair ledger，见 §6 |
| ❌ | ❌ | `MISSING_REMOTE` | 正常未执行 |

> **不要把「0012 的对象存在」自动推广成「0012 全部执行过」。**
> 0012 创建 5 表 / 2 枚举 / 11 函数 / 5 触发器 / 5 策略 / 2 索引 ——
> P4 会逐项探测其中的代表对象。**部分存在**与**全部存在**是两种完全不同的状态，
> 前者意味着当年是手工挑着跑的，修复方案也完全不同。

---

## 6. ledger repair 的硬前提（不可绕过）

```
remote actual object definition  ==  canonical intended object definition
```

**仅凭「对象名存在」绝对不能 repair ledger。** 名字相同而定义不同的情况下 repair，
等于宣称一个从未正确发生过的迁移已经完成 —— 问题会从可见变成不可见。

因此 P2 / P3 / P6 都取了 `md5(pg_get_functiondef(...))`：
定义哈希是可复现的比对依据，比「函数在不在」强得多。

---

## 7. 0027 的判断依据（本轮仍不 apply）

`0027` 状态维持 **`PROPOSED — DO NOT APPLY`**，函数数量以 canonical 最新口径 **12** 项为准
（`handle_new_user` 不在其中）。

它唯一真正有风险的动作是对 `is_admin_any` 的 **`create or replace`**，
而该函数被 **13 处 RLS 策略**引用。因此 apply 决策必须先有两项远端证据：

| 需要的证据 | 探测包位置 |
|---|---|
| 远端 `is_admin_any` 的**实际定义**（含 `search_path` 与定义哈希） | **P2** · **P6** |
| 远端**实际**有多少条 RLS 策略引用它（未必真是 13） | **P7** |

没有这两项：**`NO APPLY DECISION`**。

---

## 8. 本轮未做的事

```
未连接远端                     未执行任何 mutation
未 repair ledger               未 db push
未 apply 0023–0026 / 0027      未 reset database password
未修改 .gitignore（另一会话有未提交改动，遵守 D-38）
未开始 STAGING-1B              DB-4 保持 PAUSED
```

## 9. 交付物

| 文件 | 用途 |
|---|---|
| `supabase/tests/staging_readonly_probe.sql` | **只读**探测包（P0–P9），全文件只有 SELECT |
| 本文件 | canonical 期望态 + 判读规则，供与探测输出对拍 |
