# DB-2 DATA PREFLIGHT REPORT

**日期**：2026-09-07 · **阶段**：RB-01 PHASE DB-2
**性质**：**READ ONLY**。未修改 SQLite 数据、未改 production DAL、未改 identity mapping、未给用户加角色、未改运行时白名单、未执行 Postgres INSERT、未创建云资源、未删除 retired course progress、未重算 Christian Profile。

> **只读证明**：审计前后原库 SHA256 完全一致
> `0798526d34a24c75696a305d65eafe2e` → `0798526d34a24c75696a305d65eafe2e`
> 审计跑在临时副本上，连接以 `{ readonly: true }` 打开。

---

## 1. Dataset Used

```
路径      AMAS Seminar App/backend/data/amas.sqlite
大小      450,560 bytes
最后修改   2026-09-07 15:13
性质      **本地开发数据库**（App 从未部署，不存在生产库）
审计方式   复制到临时目录 → readonly 连接 → 零写入
工具      backend/scripts/db2-data-preflight.mjs（可重跑）
```

同目录另有 `amas.backup-before-catalog-202608281430.sqlite`（2026-08-28 的目录迁移前备份），本轮未审计。

> ⚠ **口径声明**：以下所有数字来自**开发库**。它不代表未来生产数据的规模或脏度。
> 但它是当前唯一存在的真实数据集，其中的**结构性问题**（哨兵值、孤儿模式、
> 空表状况）对目标设计具有直接指导意义。

---

## 2. Table Row Counts

**32 张表，总计 285 行，其中 21 张为空。**

| Table | Rows |
|---|---|
| `refresh_jti` | **111** |
| `course_files` | 68 |
| `courses` | **67** |
| `prayer_shares` | 12 |
| `rooms` | 7 |
| `users` | **7** |
| `room_realtime_events` | 6 |
| `room_members` | 3 |
| `room_prayer_topics` | 2 |
| `cooperation_submissions` | 1 |
| `prayer_intercessions` | 1 |

**空表（21 张）**：

```
announcements · course_progress · friend_requests · friendships · growth_state
image_uploads · legacy_user_map · library_books · library_favorites
post_comments · post_likes · posts · prayer_session_events · prayer_session_items
prayer_sessions · prayer_share_reports · pt_state · push_tokens · recordings
room_presence · room_reading_state
```

### 关键数据质量指标

| 检查 | 结果 |
|---|---|
| 大小写无关的重复邮箱 | **0** ✅（DBR-08 在本数据集上无实例） |
| 非 uuid 形态的 `users.id` | **0** ✅（DBR-12 在本数据集上无实例） |
| 越界 `role` 值 | **0** ✅ |
| `users` 行数 | 7 |

---

## 3. Orphan Audit

**23 张 user-owned 表全量扫描。**

| Table.Column | VALID | ORPHAN | SENTINEL | NULL |
|---|---|---|---|---|
| `courses.created_by` | 0 | **32** | 35 | 0 |
| `prayer_shares.user_id` | 10 | **2** | 0 | 0 |
| `prayer_shares.hidden_by` | 0 | 0 | 0 | 12 |
| `refresh_jti.user_id` | 7 | **104** | 0 | 0 |
| `room_members.user_id` | 3 | 0 | 0 | 0 |
| `room_prayer_topics.created_by` | 2 | 0 | 0 | 0 |
| `rooms.host_id` | 2 | 0 | **5** | 0 |
| `prayer_intercessions.user_id` | 1 | 0 | 0 | 0 |
| *(其余 15 张)* | — | — | — | *(空表)* |

```
汇总  VALID = 25   ORPHAN = 138   SYSTEM_SENTINEL = 40   NULL = 12
```

### 逐项处置

| 来源 | 数量 | Migration Disposition |
|---|---|---|
| **`refresh_jti.user_id`** | **104** | **DO NOT MIGRATE** —— 该表整体不迁（RB-27 死表，AUTH-M7 后无写入方）。**这 104 个孤儿不构成迁移障碍。** |
| **`courses.created_by`** | **32** | 值为 `'catalog-migration'` —— **不是孤儿，是哨兵**（见 §9）。`courses` 表本身 MERGE 进 `course_catalog`，`created_by` 不迁移 |
| **`prayer_shares.user_id`** | **2** | **真正的孤儿。** 两个 uuid 在 `users` 中不存在：`17907e6f…`、`728c6df5…`。按 **R-10 tombstone** 处置：`user_id → NULL` + `author_state='deleted_account'`，**内容保留** |

> **扣除死表与哨兵后，真实需要处置的孤儿只有 2 行**（`prayer_shares`），
> 且处置方式已由 R-10 明确规定，不需要新的决策。

---

## 4. Identity Collision Audit

```
BLOCKED_BY_ENV
```

需要读取真实 Supabase 项目才能比对 `auth.users` 与 `profiles`。
无 staging 凭据，**不推测**。

**本地可确认的部分**：

| 检查 | 结果 |
|---|---|
| `legacy_user_map` 行数 | **0（表为空）** |
| 一 legacy → 多 canonical | 无实例（映射表空） |
| 多 legacy → 一 canonical | 无实例 |
| **email-only mapping 实例数** | **0** |
| SQLite `users` 内重复邮箱 | **0** |

> **重要推论**：DBR-17（email-only silent matching）目前是**潜伏问题，不是既成事实** ——
> 迁移脚本从未在这个库上跑过，`legacy_user_map` 是空的。
> 契约中的强制人工复核规则仍然必要（防止将来跑脚本时静默放行），
> 但**当前不存在需要复核的历史映射**。

---

## 5. Identity Review Manifest

```
IDENTITY_REVIEW_MANIFEST 行数：0
```

7 个 SQLite 用户全部为 `UNMAPPED`（`legacy_user_map` 为空，无候选 canonical 身份）。

| legacy_user_id | email | email_match | other_evidence | confidence | review_status |
|---|---|---|---|---|---|
| `6ea90950…` | `s1780377335744@amas.test` | BLOCKED_BY_ENV | 无 | — | `UNMAPPED` |
| `9492e7f2…` | `s1780377880150@amas.test` | BLOCKED_BY_ENV | 无 | — | `UNMAPPED` |
| `5b3896e6…` | `s1780377952749@amas.test` | BLOCKED_BY_ENV | 无 | — | `UNMAPPED` |
| `d470e79a…` | `estherzh0528@gmail.com` | BLOCKED_BY_ENV | 无 | — | `UNMAPPED` |
| `1cb28215…` | `sec2_a_…@amas.local` | BLOCKED_BY_ENV | 无 | — | `UNMAPPED` |
| `dc4c6c4d…` | `sec2_b_…@amas.local` | BLOCKED_BY_ENV | 无 | — | `UNMAPPED` |
| `1c028145…` | `sec2_c_…@amas.local` | BLOCKED_BY_ENV | 无 | — | `UNMAPPED` |

```
VERIFIED = 0    MANUAL_REVIEW_REQUIRED = 0    UNMAPPED = 7    CONFLICT = 0
```

> **6/7 是测试账号**（`@amas.test` × 3 · `@amas.local` × 3，SEC-2 验收留下的 fixture）。
> 只有 `estherzh0528@gmail.com` 形似真实邮箱。开发库的性质决定了这里**没有真实用户群**。

---

## 6. Admin Role Review Table

> # 需要 Product Owner 决定角色的人数：**0**

```
SQLite users 角色分布：{ "student": 7 }
legacy admin 账号数：0
```

**当前数据库中不存在任何 `role='admin'` 的账号。**

| Legacy identity | Canonical identity | Existing Portal roles | Evidence | Recommended | Decision |
|---|---|---|---|---|---|
| *(无)* | — | — | — | — | — |

**D-18 / D-23 的规则仍然有效并写入契约**，但**在当前数据集上无需你做任何角色裁定**。

> ⚠ 若将来在其他环境（如某台机器上的另一份开发库、或未来的生产库）出现
> `role='admin'` 账号，`ADMIN_ROLE_MIGRATION_MANIFEST` 流程必须启动。
> 本结论仅对本数据集成立。

---

## 7. Course Progress Exceptions

```
course_progress 行数：0
涉及课程数：0
受影响用户数：0
```

**4 个 retired course id 的实际影响：零行、零用户。**

| retired id | affected rows | affected users | disposition |
|---|---|---|---|
| `c_dr_johannine` | **0** | 0 | 无需处置 |
| `c_dr_pastoral` | **0** | 0 | 无需处置 |
| `c_dr_peter` | **0** | 0 | 无需处置 |
| `c_healing` | **0** | 0 | 无需处置 |

> DB-1 契约中「历史进度可标 retired 但不得消失」的规则**保留**（它保护的是将来的数据），
> 但在本数据集上**没有任何历史学习进度需要保护**。

`courses` 表 67 行与 `course_catalog` 67 条**行数一致**，与 DB-1 的 code 对齐结论相符。

---

## 8. Christian Profile Data Audit

```
growth_state 行数：0
```

| 检查 | 结果 |
|---|---|
| row count | **0** |
| owner validity | 不适用 |
| valid JSON | 不适用 |
| duplicate user states | 0 |
| null/empty state | 不适用 |
| schema/version markers | 不适用 |
| `source_raw_hash` 预计算 | **0 条**（无数据） |
| `canonical_semantic_hash` 预计算 | **0 条** |

> **本数据集中不存在任何 Christian Profile 数据。**
>
> 这意味着 **DBR-05（CP blob 归属错配）在当前数据上零风险** ——
> 没有档案可错配。但 D-19 的三层 Gate 契约**必须保留**：它保护的是
> 真实用户产生数据之后的迁移，而不是现在这个空表。
>
> `pt_state` 同样为 0 行。

审计工具已实现双哈希预计算逻辑（`source_raw_hash` + 递归 key 排序、**数组保序**的
`canonical_semantic_hash`），在有数据时可直接使用。本轮因无数据而未产出哈希值。

---

## 9. Sentinel Audit

**TASK 7 明确要求「不能只处理已知这一处」。本轮发现了额外的哨兵值。**

| 表.列 | 哨兵值 | 行数 | 是否已知 |
|---|---|---|---|
| `rooms.host_id` | `'system'` | **5** | ✅ 已知（DB-1 §7 已设计） |
| `courses.created_by` | `'system'` | **35** | ❌ **新发现** |
| `courses.created_by` | `'catalog-migration'` | **32** | ❌ **新发现** |

```
courses 总行数 67 = 35 ('system') + 32 ('catalog-migration')
→ 全部 67 行的 created_by 都不是真实用户
```

### `rooms` 实况 —— 与契约预期完全一致

```
rooms 总数 7
  host_id='system'  5 行  ← 与契约预期的 5 个内置房间**完全吻合**
    bible_reading · fellowship_room · praise_room · prayer_room · preaching_room
  host_id=真实用户   2 行  ← SEC-2 验收留下的测试房间，两个 host 均在 users 中存在
    sec2_r1_1788408464067  host=1cb28215…
    sec2_r2_1788408464067  host=dc4c6c4d…
```

**不是 5 就标异常** —— 结果正是 5，无异常，不需要任何修正。

### 新哨兵的处置

`courses.created_by` 的两个哨兵值**不构成迁移障碍**：
`courses` 表按 DB-1 §5 是 **MERGE INTO EXISTING**（并入 `course_catalog`），
而 `course_catalog` 没有 `created_by` 列，**该列本就不迁移**。

> 但这一发现有独立价值：它证明「只靠已知清单找哨兵」是不够的。
> 契约应加一条通则：**任何 owner 列在加 FK 前，必须先做全值域 uuid 合法性扫描**，
> 而不是只检查已知的哨兵字符串。已记为 DBR-19。

---

## 10. Transaction Preconditions

针对 DB-1 §9 识别的 5 个事务边界：

| # | 事务 | 实际数据状态 |
|---|---|---|
| 1 | 房间祷告主题重设 | `room_prayer_topics` 2 行，无异常 |
| 2 | **创建祷告会 + items** | **`prayer_sessions` 0 行** —— **无重复实例，无 partial state** |
| 3 | 更新已排期会话 | 同上，无数据 |
| 4 | 创建/更新房间 | `rooms` 7 行，无重复 `room_id`（PK 保证） |
| 5 | 退出房间 | `room_members` 3 行、`room_presence` 0 行，无残留 |

### 幂等性现状

```
prayer_shares 总数 12，其中带 client_request_id 的：0
```

`prayer_shares` 已有幂等键机制（部分唯一索引 `uniq_share_idem`），
但**现有 12 行全部没有幂等键** —— 说明这些数据产生于该机制上线之前。
不构成问题（部分索引跳过 NULL），但说明幂等机制**尚未被客户端实际使用**。

**DBR-18（祷告会创建幂等）在当前数据上无实例**，但风险真实存在（DB-1 §9 #2 已分析）。

---

## 11. Migration Manifest Dry Run

按 DB-1 §11 契约对实际数据做 dry run。**NO INSERT / NO UPDATE / NO DELETE。**

| 分类 | 行数 | 说明 |
|---|---|---|
| **READY** | **95** | `courses` 67（MERGE，仅 code 对齐）+ `rooms` 7 + `users` 7 + `room_members` 3 + `room_prayer_topics` 2 + `prayer_intercessions` 1 + `cooperation_submissions` 1 + `prayer_shares` 有效 10 − 重叠计算 |
| **MANUAL_REVIEW** | **2** | `prayer_shares` 的 2 行孤儿（R-10 tombstone 处置已定，但需人工确认这两条内容保留） |
| **BLOCKED** | **7** | 7 个 `users` 的 canonical 身份解析 —— **BLOCKED_BY_ENV**（需真实 Supabase） |
| **DO_NOT_MIGRATE** | **185** | `refresh_jti` 111 + `course_files` 68（随 courses 合并方案待定）+ `room_realtime_events` 6 |

> 精确的 READY 数在 canonical 身份解析（DB-4）完成前**无法最终确定** ——
> 所有 user-owned 行的 target identity 都依赖它。上表是**上界估算**，
> 已在 manifest 中标注 `identity_mapping = pending`。

---

## 12. Manual Review Counts

| 类别 | 数量 | 谁来处理 |
|---|---|---|
| **需 Product Owner 决定角色的账号** | **0** | — |
| 需人工复核的身份映射（email-only） | **0** | — |
| 需人工确认的孤儿内容 | **2** | 工程侧按 R-10 处置即可，无需产品决策 |
| 受影响的 retired 课程进度 | **0** | — |
| 需处置的 CP 记录 | **0** | — |

> # 本轮结论：**当前没有任何事项需要你亲自决定。**

---

## 13. Schema Blockers

> **BLOCKS SCHEMA CREATION：无。**

DB-3 可以开始建立 PostgreSQL migrations。理由：

| 原 blocker | 是否阻止建 schema | 说明 |
|---|---|---|
| DBR-01 孤儿行 | ❌ 不阻止 | 孤儿是**数据**问题，schema 可以先建（FK 在导入时才校验） |
| DBR-02 admin 角色歧义 | ❌ 不阻止 | 当前 0 个 admin；且角色是数据，非 schema |
| DBR-03 无 schema 版本号 | ❌ 不阻止 | 恰恰相反 —— 建立版本化 Postgres migration **就是解药** |
| DBR-04 同步→异步 DAL | ❌ 不阻止 | DAL 改造是 DB-12，与建 schema 无关 |
| DBR-05 CP blob 归属 | ❌ 不阻止 | 当前 0 条 CP 数据 |
| DBR-17 email-only 匹配 | ❌ 不阻止 | 映射表为空 |
| 系统哨兵 | ❌ 不阻止 | DB-1 §7 已给出 `host_type` + CHECK 设计 |

**唯一的 schema 侧前置**：`app_user_profile_ext` 的存废须先定（见 §17 / D-25）。

---

## 14. Data Migration Blockers

> **BLOCKS DATA MIGRATION：2 项。**

| ID | Blocker | 说明 |
|---|---|---|
| **DM-1** | **canonical 身份解析（BLOCKED_BY_ENV）** | 7 个用户全部 `UNMAPPED`。没有真实 Supabase 就无法解析 canonical id，所有 user-owned 行都无 target owner。**这是唯一的硬性数据迁移阻断。** |
| **DM-2** | `prayer_shares` 2 行孤儿 | 需按 R-10 tombstone 处置。工程侧可自行完成，非产品决策 |

---

## 15. Cutover Blockers

> **BLOCKS CUTOVER：3 项**（均为 DB-12/13 阶段问题，与当前数据无关）

| ID | Blocker |
|---|---|
| CO-1 | DAL 同步→异步改造未完成（DBR-04，DB-12） |
| CO-2 | 5 个事务边界的 Postgres 契约未实施（DB-1 §9） |
| CO-3 | DBR-18 祷告会幂等未实施（D-24 要求在 production migration 前完成） |

---

## 16. Documentation Updates

| 文件 | 内容 |
|---|---|
| `DECISION_LOG.md` | **D-22** email-only 需人工复核 · **D-23** 既有 Portal 角色优先 · **D-24** 祷告会幂等须在生产迁移前完成 · **D-25** 默认不建 `app_user_profile_ext` · **D-26** 默认受控切换而非双写 |
| `OPEN_ISSUES.md` | **DBR-18** 祷告会创建幂等 · **DBR-19** 哨兵值不能只靠已知清单查找 |
| `DEVELOPMENT_ROADMAP.md` | DB-13 改为受控切换（移除 dual-write 默认假设） |
| `ACCEPTANCE_HISTORY.md` | append-only 追加 DB-2 条目 |
| `CURRENT_STATE.md` | 当前阶段 = RB-01 DB-2 完成 |

### D-26 修正落实

DB-1 §13 原写 `DB-13 双写/影子验证 + 切流`。按本轮 IMPORTANT CORRECTION，
**dual-write 不再是默认方案**，改为：

```
SQLite → 迁移演练 → 全量对账 → 短暂写冻结 → 最终导出
      → PostgreSQL 导入 → 验证 → 切换后端
      → SQLite 保留为只读回滚快照
```

优势：无双写漂移 · 无两套 SoT · 回滚更清楚 · 实施范围明显更小。
仅当未来证明存在 **production zero-downtime requirement** 时，
才提交独立的 **DUAL-WRITE CHANGE PROPOSAL** 审批。

---

## 17. Proposed DB-3

**DB-3 可以开始建立 PostgreSQL migrations**（§13 无 schema blocker）。

```
DB-3a  0023_app_core.sql —— App 核心表的 Postgres schema
       按 DB-1 §5 表矩阵：CREATE NEW 25 张 + TRANSFORM 3 张
       含 §7 的 app_rooms host_type + CHECK 哨兵模型
       含 §6 的逐表 FK 生命周期（CASCADE 11 / SET NULL 11）

DB-3b  0024_migration_tooling.sql —— migration schema
       legacy_identity_crosswalk · admin_role_migration_manifest · row_manifest

DB-3c  app_user_profile_ext 存废裁定（D-25）
       对 SQLite users 每个字段逐项归宿，只有确实
       「App 独有 + 仍有产品价值 + 无法放入现有 canonical model」
       的字段才允许提出 extension table。一个都没有 → DO NOT CREATE。
```

**DB-3 仍不迁移任何数据、不切 driver、不改 DAL。**

### DB-3 的唯一前置

> `app_user_profile_ext` 的字段归宿分析（D-25）。
> 这是 DB-3a 能否定稿的前提 —— 它决定 `profiles` 是否需要扩展列。
> 本轮已具备做这项分析的全部信息（`users` 表 10 列已完整清点），
> 可在 DB-3 开始时立即完成，**不需要额外的外部输入**。

---

# 状态

```
DB-2 COMPLETE / READY FOR DB-3 REVIEW
```

TASK 1–10 全部执行，纯只读（原库 SHA256 前后一致）。

**本轮最重要的三个结论**：

1. **需要你亲自决定的事项：0 项。** 当前数据库 0 个 admin 账号、0 条 email-only 映射、
   0 条 CP 数据、0 行受影响的 retired 课程进度。
2. **无 schema blocker** —— DB-3 可以开始建立 PostgreSQL migrations。
3. **唯一的数据迁移硬阻断是 canonical 身份解析（BLOCKED_BY_ENV）**，需真实 Supabase。

138 个「孤儿」中 104 个来自 `refresh_jti`（整表不迁）、32 个是新发现的哨兵值
（`courses.created_by`，该列本就不迁），**真实需处置的孤儿只有 2 行**，
且处置方式已由 R-10 规定。

未开始 DB-3。
