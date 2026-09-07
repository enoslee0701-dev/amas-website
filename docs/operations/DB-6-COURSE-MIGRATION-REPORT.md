# DB-6 COURSE MIGRATION REPORT

**RB-01 · PHASE DB-6 —— Canonical Course Migration & Historical Compatibility**
日期：2026-09-07 · 执行：Claude · 依据：D-36 顺序调整（DB-6 先于 DB-4）

> **最终状态：`DB-6 LOCALLY VERIFIED`**
> 67/67 EXACT_CANONICAL_MATCH · 0 CONFLICT · 0 BLOCKED ·
> 契约测试 36/36（17.6 与 18.6 各一次）· 幂等 3 次零漂移 · 回退已实测 ·
> Portal 自有列校验和与 `0022` 基线**逐字节一致**。

---

## 1. Starting Baseline

| 项 | 值 |
|---|---|
| website | `661e7af` DB-3.5 报告 §12 补实 commit 哈希与冻结世系实测确认 |
| App | `02903a1` docs: DBR-22 CLOSED（PG17.6 实测）+ DBR-24 更正 + D-33 |
| 验证引擎 | **PostgreSQL 17.6**（gate）· PostgreSQL 18.6（对照） |
| 验证库 | `amas_db6`（17.6，隔离）· `amas_db6_18`（18.6，隔离）· `amas_pg176_baseline`（仅 `0001..0022`，作 Portal 对照） |
| 源库 | `backend/data/amas.sqlite` · SHA256 前缀 `0798526d34a24c75696a305d65eafe2e` · **只读**（临时副本 + `{readonly:true}`） |
| Production | **未接触**（TASK 9 禁令） |
| ACTIVE lineage | DB-6（D-16：唯一 active implementation task） |

DB-3 建成时 `course_catalog` 的 4 个扩展列**全部为 NULL**（实测「已填扩展列的行数 = 0」）——
这是 DB-6 的起点，也是回退目标状态。

---

## 2. Canonical Catalog Recheck

在**当前 canonical commits** 上重新验证，不沿用 DB-1 的旧结论。三个源逐一独立读取：

| 源 | 位置 | 条数 |
|---|---|---|
| **A** App 权威目录 | `services/catalog.ts` `OFFICIAL_CATALOG` | **67** |
| **B** legacy 数据 | SQLite `courses` 表 | **67** |
| **C** canonical 目标 | Postgres `public.course_catalog`（`0016` 种子） | **67** |

**集合比对（只用 code 精确相等，无任何名称模糊匹配）**：

```
intersection            67
App-only                 0
canonical-only           0
SQLite-only              0
标题不一致条数           0     （legacy title 与 canonical title_zh 逐条相等）
total_lessons 不一致条数  0
```

> **对齐依据是 code，不是名字。** 工具刻意不实现任何相似度匹配 ——
> 名字像不代表是同一门课，一次错配就会把学生的学习历史挂到别的课上。

---

## 3. 67 Course Mapping Manifest

**COURSE_MAPPING_MANIFEST** 由 `backend/scripts/db6-course-migration.mjs` 生成：

- `backend/data/db6-out/course-mapping-manifest.json`（完整，含每条的全部字段）
- `backend/data/db6-out/course-mapping-manifest.md`（人可读表格）

字段：`legacy_course_id` · `canonical_course_code` · `legacy_title` · `canonical_title` ·
`official_catalog_title` · `title_identical` · `status` · `mapping_method` · `migration_action` ·
`legacy_created_at_ms` · `legacy_created_by` · `legacy_thumbnail` · `legacy_thumbnail_shape` ·
`legacy_thumbnail_image_id` · `legacy_total_lessons` · `canonical_total_lessons` ·
`course_progress_rows` · `course_files_rows` · `note`

### 汇总

| status | 条数 | mapping_method | migration_action |
|---|---|---|---|
| `EXACT_CANONICAL_MATCH` | **67** | `exact_code_equality` | `UPDATE_EXTENSION_FIELDS` |
| `RETIRED_REFERENCE` | **4** | `retired_id_registry` | `PRESERVE_AS_RETIRED_REFERENCE` |
| `CONFLICT` | **0** | — | — |
| `BLOCKED` | **0** | — | — |

manifest 共 **71 行** = 67 正式课程 + 4 retired 引用。

**全部 67 条正式课程都是 `EXACT_CANONICAL_MATCH`，无异常。**

---

## 4. Retired Course Handling

### 4 个 retired ID 逐项

`services/catalog.ts:117` 的注释是权威定性：**「旧的合并课程 → 已按书卷/主题拆分，迁移后删除」**。

| legacy id | historical meaning | 正式已知的 canonical 替代 | migration behavior |
|---|---|---|---|
| `c_dr_pastoral` | 教牧书信**合并**课程（已按书卷拆分） | **NONE FORMALLY KNOWN** | `PRESERVE_AS_RETIRED_REFERENCE` |
| `c_dr_peter` | 彼得书信**合并**课程（已按书卷拆分） | **NONE FORMALLY KNOWN** | `PRESERVE_AS_RETIRED_REFERENCE` |
| `c_dr_johannine` | 约翰书信**合并**课程（已按书卷拆分） | **NONE FORMALLY KNOWN** | `PRESERVE_AS_RETIRED_REFERENCE` |
| `c_healing` | 医治主题**合并**课程（已按主题拆分） | **NONE FORMALLY KNOWN** | `PRESERVE_AS_RETIRED_REFERENCE` |

### 为什么「无正式已知替代」而不是填一个

拆分是**一对多**的：一门合并课程的讲义被分散到多门新课程。
`backend/scripts/migrate-catalog.ts:23` 显示当年的做法是**按文件名**把讲义搬到新课程
（`update course_files set course_id = ? where filename = ? and course_id in (retired…)`），
`services/catalog.ts` 的 `files` 字段记录了哪门新课接收了哪些讲义。

因此不存在「`c_dr_pastoral` → 某一门课」这样的单一映射。
任何「名字最像」的填法都是猜测，正是 TASK 2 明令禁止的。

### 历史学习进度：查证结果

`migrate-catalog.ts:38` 有 `delete from course_progress where course_id = ?` ——
当年的一次性脚本**确实删除过** retired 课程的学习进度。
DB-1 §4.3 要求「历史学习进度不得静默丢失」，因此必须查清到底丢了什么。

查证用的是迁移**之前**的备份 `backend/data/amas.backup-before-catalog-202608281430.sqlite`
（2026-08-28 14:30，204800 bytes，只读读取）：

```
备份库表数            17
非空表                users=3, refresh_jti=3
courses               0 行
course_progress       0 行
course_files          表不存在
```

**结论：当前 SQLite 世系里，这 4 门 retired 课程从未有过数据行，也从未有过任何学习进度。**
`migrate-catalog.ts` 的删除语句在本库上是空操作。
**没有任何真实学习历史因课程退役而丢失** —— 这不是推断，是备份实测。

> 仓库历史中也从未记录过这 4 个 id 的标题（全历史 `git grep` 无命中），
> 因此报告不编造它们的中文名称。

### 「不会静默转成错误课程」的数据库层保证

4 个 retired id 不在 `course_catalog` 中，而 `app_course_progress.course_code` /
`app_course_files.course_code` 都是指向 `course_catalog(code)` 的真实外键。
所以对 retired 课程的引用**写不进去**，只会被拒绝 —— 不可能被悄悄算到某门现役课程头上。

三条实测断言：

```
PASS  retired: 指向 retired 课程的学习进度被 FK 拒绝，不会静默转成错误课程
PASS  未知课程: 不存在的 course_code 被 FK 拒绝
PASS  retired: 课程附件也无法挂到 retired 课程上
```

> **遗留张力（见 §16 DBR-27）**：DB-1 §4.3 原本要求 retired 进度「迁入并标记 `legacy_retired`」，
> 但 DB-3 的 FK 让这类行**无法表示**。当前 `course_progress = 0` 行，因此不阻断；
> 但这是契约与 schema 之间的真实不一致，须由 Supervisor 裁定，DB-6 不擅自加表。

---

## 5. created_by Provenance（D-28）

源库 `courses.created_by` **67/67 全部是哨兵**，无一指向真实用户：

| 值 | 条数 |
|---|---|
| `system` | **35** |
| `catalog-migration` | **32** |

按 D-28 承接为 `course_catalog.created_by_provenance text`，**刻意不设外键**。

实测断言：

```
PASS  provenance: 67 条全部带来源标记
PASS  provenance: 取值仅为 system / catalog-migration
PASS  provenance: 分布 35 system / 32 catalog-migration，与源库一致
PASS  D-28: created_by_provenance 上没有任何外键（不是身份）
PASS  D-28: created_by_provenance 是 text，不是 uuid
PASS  D-28: 未为哨兵值制造任何假用户（R-7）
```

最后一条是直接查 `profiles`：没有任何 `display_name` 或 `email` 等于 `system` /
`catalog-migration` 的行。**没有为了让 FK 成立而发明用户。**

---

## 6. created_at Preservation

### 源数据事实

```
非空                67 / 67   （无 NULL，因此不存在 null 行为分歧）
毫秒位非零           67 / 67   ← 关键：一旦丢亚秒精度就是真实的数据损失
distinct 时间戳      34
范围                1786673552677 → 1787898657811 (epoch ms)
                    2026-08-14T02:12:32.677Z → 2026-08-28T06:30:57.811Z (UTC)
```

### 转换式与精度实测

DB-1 §8 #3 规定 `to_timestamp(v / 1000.0)`。因为 13 位毫秒时间戳 + 3 位小数
已逼近 `double precision` 的有效位数上限，**不能想当然认为它无损**。
三种候选转换式在真实量级上逐值往返比对（PG 17.6）：

| 转换式 | 往返是否精确等于源毫秒值 |
|---|---|
| `to_timestamp(ms / 1000.0)`（double） | ✅ 7/7 精确 |
| `to_timestamp(ms::numeric / 1000)` | ✅ 7/7 精确 |
| `timestamptz 'epoch' + (ms \|\| ' ms')::interval` | ✅ 7/7 精确 |

采用 DB-1 规定的 `to_timestamp(v / 1000.0)`。

### 迁移后的锚点断言

```
PASS  created_at: 67 条全部非空，无静默丢失
PASS  created_at: 全部落在源数据的时间范围内（2026-08）
PASS  created_at: c_1cor            毫秒级往返精确等于源值 1786673552677
PASS  created_at: c_dr_marking      毫秒级往返精确等于源值 1786699129966
PASS  created_at: c_worship_studies 毫秒级往返精确等于源值 1787898657811
PASS  created_at: 会话时区改变不影响所存的绝对时刻
```

三个锚点取的是**最小值、中位值、最大值**。
时区一条是把会话 `TimeZone` 在 `UTC` 与 `Asia/Bangkok` 之间切换后比较同一行 ——
`timestamptz` 存的是绝对时刻，切时区只改显示，不改数据。

---

## 7. Course Extension Fields

DB-3 在 `course_catalog` 上新增的 4 列，本轮逐一确认：

| 列 | 来源 | legacy 有值吗 | 迁移后 | nullable | 是否改变 Portal 行为 |
|---|---|---|---|---|---|
| `thumbnail_path` | `courses.thumbnail` | 67/67 非 NULL | 35 应用内相对路径 + **32 空串** | ✅ 可空 | ❌ 不变 |
| `thumbnail_image_id` | `courses.thumbnail_image_id` | **0/67**（全 NULL） | 全 NULL | ✅ 可空 | ❌ 不变 |
| `created_at` | `courses.created_at` | 67/67 有值 | 67/67 有值 | ✅ 可空 | ❌ 不变 |
| `created_by_provenance` | `courses.created_by` | 67/67 有值 | 67/67 有值 | ✅ 可空 | ❌ 不变 |

### 空串 vs NULL —— 逐字保留，不静默归一

`thumbnail` 有 **32 条是空字符串**（不是 NULL），且这 32 条恰好就是
`created_by='catalog-migration'` 的那 32 条 —— 两个数字同源，说明是当年那批
占位式建档留下的形态，不是随机脏数据。

**迁移逐字保留空串。** 把 `''` 悄悄改成 `NULL` 是一次未声明的数据改写：
它会让「App 当时写的是空串」这个事实消失，而这恰恰是 DB-12 需要修的东西。
处置记为 **DBR-26**，由 App 写入路径在 DB-12 归一。

```
PASS  thumbnail_path: 32 条空串逐字保留（未被归一成 NULL）
PASS  thumbnail_path: 35 条应用内相对路径
PASS  thumbnail_path: 无 NULL —— 与源库 67/67 非 NULL 一致
PASS  thumbnail_path: 无 data URI / 外部 URL 混入
PASS  thumbnail_image_id: 全 NULL，未凭空制造图片引用
PASS  扩展列: 4 列全部可空，不改变 Portal 既有写入行为
```

**4 列全部可空**是关键：Portal 自己的写入路径不提供这些列，
任何一列设成 `NOT NULL` 都会立刻破坏 Portal 的既有插入。

---

## 8. Dry Run

**NO WRITE。** 只读三个源并产出 manifest：

```
=== DB-6 COURSE MAPPING (dry-run) ===
  源 A OFFICIAL_CATALOG : 67
  源 B SQLite courses   : 67 (sha256:0798526d34a24c75696a305d65eafe2e)
  源 C canonical catalog: 67
  交集(code 精确相等)   : 67
  App 独有 / canonical 独有 / SQLite 独有: 0 / 0 / 0
  retired ids           : c_dr_pastoral, c_dr_peter, c_dr_johannine, c_healing
  ---- status ----
    EXACT_CANONICAL_MATCH      67
    RETIRED_REFERENCE           4
  ---- migration_action ----
    UPDATE_EXTENSION_FIELDS        67
    PRESERVE_AS_RETIRED_REFERENCE   4
  标题不一致: 0   课时数不一致: 0
```

**`CONFLICT` 0 · `BLOCKED` 0**，与预期一致（67 条正式课程不应出现 identity conflict）。
工具在存在 `BLOCKED` 时以退出码 1 结束，本轮退出码 0。

---

## 9. Apply

### 采取的形式：VERIFY → UPDATE → LINK，**不是** delete + recreate

canonical `course_catalog` 已有完整的 67 条正式行（`0016` 种子）。
因此 apply **只对已存在的行做扩展列赋值**：

```
生成的 db6-apply.sql:
  UPDATE 语句      67
  INSERT 语句       0
  DELETE 语句       0
```

（`grep` 计数曾把脚本里「不 INSERT、不 DELETE」这句注释算成命中；
按 SQL 语句起始位置精确匹配后为 0 条。）

脚本自带前后置断言：

- 前置：`course_catalog` 必须恰为 67 条，否则 `raise exception` 拒绝执行；
- 后置：执行后仍须 67 条，且带 provenance 的行数须恰为 67，否则整个事务回滚。

### 执行

| 环境 | 结果 |
|---|---|
| PostgreSQL **17.6** `amas_db6` | ✅ `COMMIT`，rc=0 |
| PostgreSQL 18.6 `amas_db6_18` | ✅ `COMMIT`，rc=0 |

**未使用 Production**（TASK 9 禁令）。

---

## 10. Verification

| 要求 | 结果 | 证据 |
|---|---|---|
| 67 canonical courses 仍是 67 | ✅ | `canonical: course_catalog 恰为 67 条` |
| 无重复目录 | ✅ | `无重复 code` · `重复 code 被主键拒绝` · `不存在 app_courses / legacy_courses / app_course_catalog / courses` |
| 无 canonical 行丢失 | ✅ | apply 前后 67 = 67；apply 脚本后置断言把 ≠67 定为异常并回滚 |
| App 课程引用均可解析 | ✅ | 67/67 `EXACT_CANONICAL_MATCH`；44 门有附件的课程全部 `EXACT_CANONICAL_MATCH` |
| Portal 目录行为不变 | ✅ | §14 |
| retired 引用不静默转错 | ✅ | 三条 FK 拒绝断言（§4） |
| `created_at` 不丢失 | ✅ | §6 三个毫秒级锚点 + 时区不变性 |
| provenance 不变成假用户 | ✅ | §5 六条断言，含直接查 `profiles` 无哨兵行 |

### 契约测试

`supabase/tests/db6_course_contract.sql` —— **36 条断言**：

| 环境 | PASS | FAIL | exit |
|---|---|---|---|
| **PostgreSQL 17.6**（gate） | **36** | **0** | 0 |
| PostgreSQL 18.6（对照） | **36** | **0** | 0 |

### DB-3 保证未被 DB-6 破坏

DB-6 apply 之后重跑 DB-3 的完整契约套件：

| 环境 | DB-3 套件 |
|---|---|
| PostgreSQL 17.6 | **53/53 PASS** |
| PostgreSQL 18.6 | **53/53 PASS** |

### 两版结果一致性

迁移后 `(code, thumbnail_path, created_at, created_by_provenance)` 的全表 md5：

```
17.6  fbe04f8fa2f0e248adf6…
18.6  fbe04f8fa2f0e248adf6…     ✔ 逐行完全一致
```

---

## 11. Idempotency

在已 apply 的库上**连续再执行 3 次**：

| 次数 | rc | 行数 | 扩展列全表 md5 | 结论 |
|---|---|---|---|---|
| #0（首次） | 0 | 67 | `d47923e273a847ab…` | 基准 |
| #1 | 0 | 67 | `d47923e273a847ab…` | ✔ 无漂移 |
| #2 | 0 | 67 | `d47923e273a847ab…` | ✔ 无漂移 |
| #3 | 0 | 67 | `d47923e273a847ab…` | ✔ 无漂移 |

```
重复 code 数: 0
```

结构上的幂等前提也已断言：`course_catalog` **没有任何自增 / identity 列**，
所以不存在「执行一次就漂一点」的列。apply 全部是**绝对赋值**的 UPDATE，
没有 `x = x + 1` 形式，也没有 INSERT / DELETE。

---

## 12. Rollback

DB-6 只填充 DB-3 新建的 4 个**可空**扩展列，不增删任何课程行，
也从未触碰 Portal 自有列。因此回退 = 把这 4 列置回 NULL。

`supabase/tests/db6_rollback.sql`，**已实际执行**：

```
回退后课程数            67
回退后扩展列非空行数     0
Portal 列与 0022 基线    ✔ 完全一致
```

脚本同样带前后置断言：回退前必须是 67 条，回退后仍须 67 条 ——
**回退动作本身不允许丢课程**。

### 回退 → 前滚

```
rollback  →  apply（rc=0）  →  契约测试 36/36 PASS
```

双向可逆已闭合。

> 脚本已注明前提：这 4 列在 DB-3 建成时全为 NULL，故清空即还原。
> 若将来出现 DB-6 之外的写入方，须改为按 provenance 精确回退。

---

## 13. Tests

`supabase/tests/db6_course_contract.sql`（36 条），覆盖 TASK 13 点名的全部项目：

| 要求 | 断言数 |
|---|---|
| 67/67 exact mapping | 3（行数 / 无重复 / 无空 code） |
| duplicate rejection | 1（主键拒绝重复 code） |
| unknown active course rejection | 1（FK 拒绝不存在的 course_code） |
| retired reference handling | 6（4 个 id 不在目录 + 进度被拒 + 附件被拒） |
| created_at preservation | 6（非空 / 范围 / 三个毫秒锚点 / 时区不变性） |
| provenance handling | 6（含「无外键」「非 uuid」「无假用户」） |
| idempotent second apply | 1（结构前提）+ §11 的三次实跑 |
| Portal catalog regression | 5（credits 仍 null / 7 大类 / 21 门筹备中 / title 全有值 / 4 扩展列可空） |
| 唯一 SoT（无第二目录） | 1 |
| 正常路径可用 | 1 |

全程单事务 + 结尾 `ROLLBACK`，不留测试数据（R-7）。

---

## 14. Portal Regression

对 `course_catalog` 的 **Portal 自有 9 列**
（`code, title_zh, category, level, instructor, total_lessons, availability, credits, sort_order`）
计算全表 md5，与只跑到 `0022` 的基线库比对：

| | 校验和 |
|---|---|
| `amas_pg176_baseline`（`0001..0022`） | `eedf344f811b0a61…` |
| `amas_db6`（DB-3 + DB-6 apply 之后） | `eedf344f811b0a61…` |
| | **✔ 完全一致** |

**DB-6 没有修改 Portal 的任何一列、一行。** 课程数 67 = 67。

补充断言：

```
PASS  Portal: credits 仍全为 null（等正式学分表批准，DB-6 未擅自填充）
PASS  Portal: 课程仍为 7 大类
PASS  Portal: 21 门内容筹备中，与种子一致
PASS  Portal: title_zh 全部有值
```

`credits` 一条尤其要紧：D-10 相关的既定立场是学分表未经批准前恒为 null，
DB-6 **没有**借课程迁移之机填它。

---

## 15. Documentation Updates

- **新增** `docs/operations/DB-6-COURSE-MIGRATION-REPORT.md`（本文）
- **新增** `supabase/tests/db6_course_contract.sql`（36 条断言）
- **新增** `supabase/tests/db6_rollback.sql`（已实测）
- **新增** App `backend/scripts/db6-course-migration.mjs`（离线迁移工具，无新依赖、无 DDL，符合 D-27）
- **更新** `AMAS_PROJECT_HANDOFF.md` → v2.3，新增 **D-34 / D-35 / D-36**
- **更新** App `docs/project-memory/`：`DECISION_LOG.md`（D-34/35/36）·
  `OPEN_ISSUES.md`（DBR-25/26/27）· `CURRENT_STATE.md` · `DEVELOPMENT_ROADMAP.md`（阶段顺序调整）·
  `ACCEPTANCE_HISTORY.md`（DB-6 验收条目）· `AI_HANDOFF_RULES.md`（ACTIVE_TASK_OWNER）

---

## 16. Remaining Course Risks

| ID | 严重度 | 内容 | 归属 |
|---|---|---|---|
| **DBR-25** | **Medium** | **retired id `c_healing` 仍被现役代码引用** —— `components/CustomTheologyView.tsx:244` 的 `courseIds: ['c_counseling', 'c_healing']`。该课程在两侧目录中都已不存在，这条推荐规则会指向一门不存在的课。其余 3 个 retired id 在全仓已零引用。 | App / DB-12 |
| **DBR-26** | Low | `thumbnail` 的 32 条空串已逐字迁入 `thumbnail_path`。空串在路径列里语义等同 NULL，应由 App 写入路径归一；**迁移刻意不静默改写**。 | DB-12 |
| **DBR-27** | **Medium** | **契约与 schema 不一致**：DB-1 §4.3 要求 retired 课程的学习进度「迁入并标记 `legacy_retired`，不得静默丢弃」，但 DB-3 的 `app_course_progress.course_code → course_catalog(code)` 外键使这类行**无法表示**。当前 `course_progress = 0` 行故不阻断；须 Supervisor 裁定（保持 FK 严格 / 另设 retired 引用登记表），**DB-6 未擅自加表**（TASK 3 禁止第二套目录）。 | Supervisor 裁定 |
| DBR-23 | Low | （承前）Portal RLS policy 计数口径 36 vs 33，待与线上库核对。 | DB-4 |

### 不构成风险的既有事实（已查证，记录以免重复排查）

- `migrate-catalog.ts:38` 曾删除 retired 课程的 `course_progress` —— 经迁移前备份实测，
  当时 `courses` 与 `course_progress` **均为 0 行**，该语句是空操作，**无真实学习历史丢失**。
- 仓库全历史从未记录过 4 个 retired id 的标题，因此报告不编造名称。
- 44 门课程有附件（`course_files` 68 行），**全部**指向 `EXACT_CANONICAL_MATCH` 的课程，
  DB-11 迁移 `app_course_files` 时不会出现悬空引用。

---

## 17. DB-4 Environment Requirements

**DB-4 状态：`BLOCKED_BY_EXTERNAL_ENV` —— `STAGING SUPABASE REQUIRED`。**
本轮**未**开始 DB-4，未创建任何 Supabase 用户，未解析任何身份，未写 `legacy_user_map`。

### 本地已就绪（TASK 15 允许维护的部分）

| 项 | 状态 |
|---|---|
| `migration.legacy_identity_crosswalk` + 全部护栏 | ✅ 17.6 实测（DB-3.5） |
| `migration.admin_role_migration_manifest` + 证据强制 | ✅ 17.6 实测 |
| `migration.row_manifest` + 值域约束 | ✅ 17.6 实测 |
| `migration.schema_baseline` | ✅ |
| 离线迁移工具骨架（读源 → manifest → 幂等 SQL 的模式） | ✅ 本轮由 DB-6 工具确立并跑通 |

### 仍必须真实 staging Supabase 的部分

7 个 legacy 账号中：**6 个是测试装置**（3×`@amas.test` + 3×`@amas.local`，D-34 已定为
`TEST FIXTURE / DO NOT MIGRATE TO PRODUCTION`），
**1 个是 `POTENTIAL_REAL_USER`**（`estherzh0528@gmail.com`，D-35）。

D-35 要求在真实 staging 环境中检查五项（是否已有 Auth 账号 / 是否已有 canonical
`profiles.id` / 是否有 AUTH-M5/M6 确定性映射证据 / 是否存在冲突账号 / 能否确定是同一个人）。
**这五项没有一项能在本地垫片环境中回答** —— 垫片的 `auth.users` 是本地表，不是 GoTrue。

环境检查清单（DB-4 启动前须逐项为真）：

```
[ ] staging Supabase 项目可访问，且 PostgreSQL = 17.6
[ ] Auth（GoTrue）可用，可查询既有账号
[ ] service_role 凭据可用（不得进入 Git / 日志 / 报告）
[ ] AUTH-M5/M6 的映射证据可检索
[ ] STAGING-ONLY TEST FIXTURES 的创建/销毁流程已就位（与 Production population 分离）
[ ] 人工复核通道已确定（email-only 匹配一律 MANUAL_REVIEW_REQUIRED）
```

---

## 18. Recommended Next Step

**不自动开始 DB-4。** 建议顺序：

1. **Supervisor 裁定 DBR-27**（retired 学习进度的可表示性）——
   它是 DB-8（学习数据迁移）的前置，现在决定成本最低（`course_progress = 0` 行）。
2. **修 DBR-25**（`c_healing` 悬空引用）—— 属 App 代码，与身份无关，可本地完成。
3. **DB-11 的课程附件部分可先行评估**：`app_course_files` 的 `course_code` 已全部可解析，
   但它还有 `uploader_id → profiles(id)`（实测 68/68 全 NULL），
   因此**不依赖身份解析**，是继 DB-6 之后又一个可在无 staging 情况下推进的窗口。
4. staging Supabase 就绪后再进 DB-4 → DB-5 → 其余身份相关阶段。

> 第 3 点只是提请评估，**不是本轮的实施建议**；是否开工由 Supervisor 决定（D-16）。

---

## 停止条件确认

| 禁令 | 遵守情况 |
|---|---|
| 不建第二套课程目录 | ✅ 断言 `app_courses` / `legacy_courses` / `app_course_catalog` / `courses` 均不存在 |
| `created_by` 不得建 `profiles.id` 外键 | ✅ 断言该列无任何外键、类型为 text、无哨兵假用户 |
| 不靠名称模糊匹配 | ✅ 工具只实现 code 精确相等，无相似度逻辑 |
| retired id 不得猜测替代课程 | ✅ 4 条全部 `NONE FORMALLY KNOWN` |
| 不 delete + recreate | ✅ 0 INSERT / 0 DELETE，仅 67 条 UPDATE |
| 不使用 Production | ✅ 全部在本地隔离库 |
| 不创建真实 Supabase 用户 / 不解析 Esther 身份 / 不写 legacy_user_map | ✅ 本轮零身份操作 |
| 不开始 DB-5 | ✅ |
| 不修改 SQLite 数据 | ✅ 临时副本 + `{readonly:true}`；源库 SHA256 不变 |
| 冻结世系不动 | ✅ `release/post-legacy-gate = e35923b` |

---

## 最终状态

> # `DB-6 LOCALLY VERIFIED`
>
> 67/67 EXACT_CANONICAL_MATCH · CONFLICT 0 · BLOCKED 0
> 契约 36/36（17.6 gate + 18.6 对照）· DB-3 套件仍 53/53 · 幂等 3 次零漂移
> 回退与前滚双向可逆 · Portal 自有列与 `0022` 基线校验和完全一致
>
> **未开始 DB-4。** 待 Supervisor 裁定 DBR-27，以及 staging Supabase 就绪。
