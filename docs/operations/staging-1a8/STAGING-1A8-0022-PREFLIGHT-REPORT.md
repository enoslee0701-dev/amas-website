# STAGING-1A8 — 0022 BACKUP-SAFE PREFLIGHT 报告

日期：2026-09-09 · 目标：`amas-staging`（D-41）
WRITER OWNER：**STAGING-DB-WRITER-A**（本 Claude 会话）
**LIVE MUTATION = NONE** —— 本轮对 live 只有 `SELECT` 与 `pg_dump` 读取。
0022 **未在 live 执行**，仍为 `NOT AUTHORIZED FOR EXECUTION`。

---

## §1 canonical 0022 是什么

`supabase/migrations/0022_program_offering_scope.sql`
md5 `dd62b7827970a1c10ecfd23ac116a2cd` · 35 行 · **未被本轮修改**。

它只有三条语句：

| # | 语句 | 性质 |
|---|---|---|
| 1 | `update public.program_catalog set is_open_for_application=false where code in (5 个)` | 写 |
| 2 | `update public.program_catalog set name_zh=…, name_en=… where code='dmin'` | 写 |
| 3 | `do $$ … raise exception … $$` | **纯断言，不写任何东西** |

没有 DDL、没有 `insert`、没有 `delete`、没有 `grant`/`revoke`。

---

## §2 EXACT BLAST RADIUS

### 2.1 先纠正一处范围认知

Supervisor 给出的「expected known affected codes」含 `bth` / `gdip` / `mdiv`。
按 canonical SQL 逐字推导，**这三个 code 不在任何 UPDATE 的 WHERE 子句里**。
它们只出现在第 3 条断言中被读取。因此：

```
实际被写入的 code = 6 个（laycert pdip pastor preaching missionary dmin）
仅被读取、不被写入 = 3 个（bth gdip mdiv）
```

### 2.2 逐行逐列矩阵

`is_open_for_application` 现状全部为 `true`（live 实测 open_count=9）。

| code | 现 open | 0022 后 open | 现 name_zh | 0022 后 name_zh | 现 name_en | 0022 后 name_en | 是否被写 |
|---|---|---|---|---|---|---|---|
| `bth` | true | true | 神学学士 | 神学学士 | Bachelor of Theology | Bachelor of Theology | **否** |
| `gdip` | true | true | 教牧学研究硕士 | 教牧学研究硕士 | Master of Ministry Studies | Master of Ministry Studies | **否** |
| `mdiv` | true | true | 道学硕士 | 道学硕士 | Master of Divinity | Master of Divinity | **否** |
| `dmin` | true | **true（不变）** | 教牧学博士 / 宣教学博士 | **教牧学博士** | Doctor of Ministry / Missiology | **Doctor of Ministry** | 是（改名） |
| `laycert` | true | **false** | 平信徒指导者课程 | 不变 | Lay Leader Course | 不变 | 是（关闭） |
| `pdip` | true | **false** | 牧会训练课程 | 不变 | Pastoral Training Diploma | 不变 | 是（关闭） |
| `pastor` | true | **false** | 牧会者进修 | 不变 | Pastoral Continuing Education | 不变 | 是（关闭） |
| `preaching` | true | **false** | 讲道学校 | 不变 | School of Preaching | 不变 | 是（关闭） |
| `missionary` | true | **false** | 宣教士训练 | 不变 | Missionary Training | 不变 | 是（关闭） |

其余 8 列（`short_label` `category` `sort_order` `intake_note_zh`
`approved_at` `created_at`）**0022 一列都不写**。
但 `updated_at` 会因触发器被改（见 §4）。

执行后开放集合（按 `sort_order`）= `{bth, gdip, mdiv, dmin}` —— 与 0022 自带断言一致。

---

## §3 数据级恢复设计与破坏性沙箱验证

### 3.A 表结构（实测，不猜）

`public.program_catalog` 共 **11 列**：

```
1 code(text,PK) 2 name_zh 3 name_en 4 short_label 5 category
6 sort_order(int,def 100) 7 is_open_for_application(bool,def true)
8 intake_note_zh 9 approved_at(date)
10 created_at(timestamptz,def now()) 11 updated_at(timestamptz,def now())
```

约束：`program_catalog_pkey(code)`；无 CHECK；无出向外键；
入向外键 1 条 `student_records.program_code → program_catalog(code)`，
**无 ON UPDATE / ON DELETE 动作**。
RLS 已启用，策略仅 1 条 `pc_public_read`（SELECT，anon+authenticated）——
**没有任何写策略**；`postgres` 因 `rolbypassrls=true` 才写得进去。

### 3.B 快照格式

`pg_dump --data-only --column-inserts -t public.program_catalog`
—— 9 条 `INSERT`，每条 **11 列全覆盖**，确定性、可回灌。

### 3.C 破坏性沙箱验证（本地 PG 17.6，端口 5433）

前置条件先证明沙箱可信：本地 canonical 库的 `program_catalog`
业务 9 列与 live **逐字节一致**（`all` 业务指纹两侧同为
`84e0ea68e07150cc67c5909f6abedcac`）。

七步实测结果：

| 步骤 | 结果 |
|---|---|
| 1 建 canonical pre-0022 态 | 9 行，public 非扩展函数 59 |
| 2 BEFORE 指纹 | all `84e0ea68…` / affected `a2c3625e…` / unrelated `e99ab6d6…` |
| 3 捕获快照 | 9 条 INSERT × 11 列 |
| 4 应用 canonical 0022 | exit=0，自带断言通过 |
| 5 验证变更 | 开放集合 `{bth,gdip,mdiv,dmin}`，dmin 已更名 |
| 6 AFTER 指纹 | all `cd41beee…` / affected `8cab50fa…` / **unrelated `e99ab6d6…` 未变** |
| 7 再次破坏 6 行 | 覆盖 0022 写过的列，也覆盖它没写过的列（`short_label` `category` `sort_order` `intake_note_zh` `approved_at`） |
| 8 从快照恢复 | 见下 |

### 3.D 恢复结果（行级逐列对拍）

```
ROWPROOF|业务 9 列不符的行数              = 0
ROWPROOF|updated_at 不符的行数            = 6
ROWPROOF|updated_at 不符的具体 code       = dmin,laycert,missionary,pastor,pdip,preaching
ROWPROOF|无关行(bth,gdip,mdiv) 全列不符    = 0
```

- **业务 9 列逐字段精确还原**（`digest_business` 回到 `84e0ea68…`）。
- **无关行全程零改动**，含时间戳。这不是碰巧：恢复语句带
  `IS DISTINCT FROM` 守卫，无差异的行 0 次 UPDATE，
  所以不会被触发器把 `updated_at` 刷掉。
- `updated_at` 恰好 6 行不符 —— 就是被写过的那 6 行。

### 3.E `updated_at` 为什么不可还原，以及唯一可行的补救

`program_catalog_set_updated_at` 是 BEFORE UPDATE FOR EACH ROW，
函数体只有 `new.updated_at = now(); return new;`。
它会覆盖恢复语句写入的旧值。两条补救路径的 live 权限实测（只读得出）：

| 路径 | live 可行性 | 依据 |
|---|---|---|
| ① `alter table … disable trigger` | **可行** | `program_catalog` 的 owner 就是 `postgres`（当前连接身份） |
| ② `set session_replication_role='replica'` | **不可行** | `is_superuser=off`，且 `pg_parameter_acl` 中**没有** `session_replication_role` 条目 |

路径①已在沙箱证毕：同一事务内 disable → 恢复 → enable，
`digest_full` 完全回到 BEFORE 的 `f61a0f70…`（**全 11 列精确还原**），
且触发器事后 `tgenabled='O'`（启用）。

结论：`updated_at` **可以**完全还原，但需要一次 `ALTER TABLE`（DDL），
不在 STAGING-1A8 授权内，故工具不内置，只把路径写清楚。
若不做路径①，恢复后 `updated_at` = 恢复时刻 —— 这是审计元数据，
不影响任何业务语义。

工具归档为 `docs/operations/staging-1a8/RECOVERY-program_catalog-restore.sql`，
带保险丝（缺 `-v i_understand_this_writes=YES` 直接中止）、
表结构断言、键集合断言（只 UPDATE，不 INSERT / 不 DELETE）与事后断言。
它刻意**不**放在 `supabase/tests/` 下，以免与纯 SELECT 探针混淆。

---

## §4 FULL-DATABASE SAFETY QUESTION

不推理，直接测量：在同构沙箱上对 **26 张 public 表**逐表取
`行数 + 全行内容 md5`，push 0022 前后各一次。

```
发生变化的表 = 1 / 26   （program_catalog，行数仍为 9）
```

机制侧逐项核对，与测量结果互证：

| 检查项 | 结果 |
|---|---|
| 0022 是否只有直接 UPDATE | 是（2 条 UPDATE + 1 条纯断言 DO） |
| `program_catalog` 上的触发器 | **仅 1 个** `program_catalog_set_updated_at` |
| 该触发器是否写别的表 | **否**，函数体只有 `new.updated_at = now()` |
| 是否存在 RULE | 否 |
| 入向外键的级联 | `student_records_program_code_fkey` **无 ON UPDATE/DELETE 动作**，且 0022 不改 `code` |
| 出向外键 | 无 |
| 审计 / 日志触发器 | `program_catalog` 上没有 |
| 引用 `program_catalog` 的函数 | 3 个（`application_validate_form` / `application_validate_program` / `create_student_record`），实测**全都没有作为触发器挂载**，只被显式调用；且它们只读该表 |
| event trigger | 6 个，全是 Supabase 平台的 `ddl_command_end` / `sql_drop` 钩子；**0022 无 DDL，不触发** |
| UPDATE 是否产生持久化次生数据 | 否 —— 唯一次生影响是同表同行的 `updated_at` |

**回答：`program_catalog`-only 快照对 0022 的「数据」是充分的。**

但完整回滚需要两步，第二步不在 `program_catalog` 里：

1. 数据：本报告的快照 + 恢复工具（已证）
2. **ledger：`supabase migration repair --status reverted 0022`**
   —— R1 §C 已实测该操作只删 ledger 行、不动 schema。

只做第 1 步会留下「ledger 声称 0022 已执行、数据却是 0021 态」的骗人状态。
这一点必须写进执行runbook。

---

## §5 TRANSACTION ATOMICITY —— 实测为 PROVEN

问题的实质不是「PostgreSQL 事务是否原子」，而是
**`supabase db push` 是否把单个 migration 文件包在一个事务里**。
用合成工作区实测（不碰 canonical 文件）：

**失败路径**：`0002_b.sql` = `insert(id=2)` → `raise exception` → `insert(id=3)`

```
Applying migration 0002_b.sql...  → LegacyDbPushApplyError
atom_t rows : 1:from-0001      ← id=2 的 INSERT 被回滚
ledger      : 0001             ← 0002 未入账
```

**成功路径**：改成两条正常 INSERT 后重推 → `1,2,3` 全在，ledger `0001,0002`。

**结论：`db push` 对每个 migration 文件提供 all-or-nothing 边界。**

用真实 0022 复验（同构沙箱，ledger 停在 0021，人为把 `bth` 关掉
使 0022 自带断言必然失败）：

```
push 前 program_catalog 指纹 = push 后指纹（逐字节相同）→ 两条 UPDATE 全部回滚
ledger 版本数 21，0022 在 ledger 中的行数 = 0
```

因此 Supervisor 要求的边界**天然成立，且不需要修改 canonical 0022**：

```
（db push 隐式 BEGIN）
  UPDATE ×2
  DO $$ 断言开放集合 = {bth,gdip,mdiv,dmin} $$   ← 事务内后置断言
（隐式 COMMIT；断言失败则整体 ROLLBACK，ledger 不入账）
```

0022 自带的 `DO` 块**就是**事务内的 postcondition，失败即整包回滚。
前置断言无法塞进同一事务而不修改 canonical 0022（§10 明令禁止修改），
故设计为「执行前独立只读门禁 + ON_ERROR_STOP 阻断流水线」，
见 §6。这是本方案与 Supervisor 草图的唯一差别，且是刻意的。

---

## §6 执行前置门禁（已实现并双向验证）

`supabase/tests/0022_preconditions.sql`，纯 SELECT + `raise exception`。

| # | 断言 | live 现状 |
|---|---|---|
| 1 | ledger 恰为 0001–0021，行数 21 | PASS |
| 2 | ledger digest = `ec46316fd12ce62d09b0290aece90684` | PASS |
| 3 | 0022 不在 ledger | PASS |
| 4 | 数据态哨兵 `(open,five_closed,dmin_renamed) = (9,0,0)` | PASS |
| 5 | `program_catalog` 9 行且业务指纹 = `84e0ea68e07150cc67c5909f6abedcac` | PASS |

**本轮已在 live 只读跑过，5 项全 PASS。**
门禁的拦截能力也已反向验证：在 digest 不符的沙箱上运行 → `PRECOND-2 FAIL` 并中止。

第 6 项 `business schema 8/8 EXACT MATCH` 是库外比对
（`r2_schema_fingerprint.sql` vs `canonical-0021-fingerprint-v2.txt`），
SQL 内无法自证，必须单独执行且先于本门禁通过。
本轮已执行，结果 8/8（见 STAGING-1A7 §6）。

### 6.1 一个必须记录的发现：0008 的 ledger 文本漂移

`ec46316f…` **不可**由当前 canonical 文件集重算得出。
逐版本比对（沙箱 vs live）发现 21 个版本中**只有 0008 的
`statements` 文本不同**，条数同为 59，差异是 5 处 `::text`：

```
canonical 现在：missing := missing || f::text;
live 记录的  ：missing := missing || f;
```

`0008_applications.sql` 自引入提交 `53d36e4` 起**从未被 git 修改过**，
所以最可能的解释是：live 的 0008 是从一份尚未提交的工作区版本推送的。
**不做超出证据的归因。**

语义影响 = 0，原因是 `application_validate_form` 在 **0010** 中被
带 `::text` 的版本重新定义。实测 live 与沙箱的该函数
`prosrc md5` 同为 `d6533466749e95ebcc6be2e3f50673f8`，
这也解释了 R2 的 `F_function` 为何能 8/8 匹配。

后果：门禁的 digest 期望值已参数化
（`-v expect_ledger_digest=…`，默认取 live 值），
否则沙箱永远无法演练该门禁。

---

## §7 执行后置门禁（已实现并在沙箱通过）

`supabase/tests/0022_postconditions.sql`，纯 SELECT + `raise exception`。

| # | 断言 | 沙箱实测 |
|---|---|---|
| 1 | ledger 恰为 0001–0022，行数 22，末位 0022 | PASS |
| 2 | 0023–0027 全部缺席 | PASS |
| 3 | 开放集合按 `sort_order` = `{bth,gdip,mdiv,dmin}` | PASS |
| 4 | `dmin` = (`教牧学博士`, `Doctor of Ministry`) | PASS |
| 5 | `program_catalog` 仍为 9 行（无增删） | PASS |
| 6 | 业务指纹 all=`cd41beee…` · affected=`8cab50fa…` · **unrelated=`e99ab6d6…`（与执行前完全相同）** | PASS |
| 7 | `created_at` 指纹（须与执行前记录比对） | 输出供比对 |
| 8 | 无 0027 权限变更：开放 EXECUTE 函数 = 11、RLS 表 = 26 | PASS（与 live 现值相同） |

第 6 项的 `unrelated` 分量就是「无关字段未被改动」的机械化断言。
`business schema unchanged` 同样是库外比对项：0022 无任何 DDL，
故执行前后必须完全相同。

---

## §8 BACKUP DECISION

```
A. 0022-SPECIFIC DATA RECOVERY IS PROVEN SUFFICIENT WITHOUT HOSTED BACKUP
```

理由，逐条对应证据：

1. **爆炸半径是实测的，不是推断的** —— 26 张表中只有 1 张变化，行数不变。
2. **该表小且完整可捕获** —— 9 行 × 11 列，`pg_dump --column-inserts`
   一次拿全，恢复经行级逐列对拍证明精确。
3. **恢复不波及无关行** —— `IS DISTINCT FROM` 守卫使无关行 0 次 UPDATE，
   沙箱全程 `unrelated` 指纹（含时间戳）逐字节不变。
4. **失败根本不会留下脏状态** —— `db push` 单文件事务边界实测为
   all-or-nothing，且 0022 自带断言就在同一事务内。
   最可能的失败模式（断言不满足）连一行都写不进去。
5. **唯一不可精确还原的字段是 `updated_at`**，属审计元数据，
   且路径①（`disable trigger`）已证可把它也还原。

边界（任一情形立即退回 **B**）：

- 任何 DDL / GRANT / REVOKE → `0023`–`0027`、DB-4 全部属于此类
- 任何触及 `auth.users` 或多表联动的 DML
- 任何会因外键级联而扩散的写入
- Production

故本判定是「**0022 这一次可以不等 hosted backup**」，
**不是**「AMAS staging 不需要 hosted backup」。
Free Plan 无项目备份这一事实未改变。

---

## §9 建议的执行 runbook（PLAN ONLY，未执行）

```
0. 确认 STAGING DB MUTATION OWNER 唯一，其余会话只读
1. 库外：r2_schema_fingerprint vs canonical-0021-fingerprint-v2  → 必须 8/8
2. 只读记录：created_at 指纹、open_execute_funcs、rls_tables
3. 快照：pg_dump --data-only --column-inserts -t public.program_catalog
        （存到 repo 之外，永不提交，永不粘贴）
4. 门禁：psql -v ON_ERROR_STOP=1 -f supabase/tests/0022_preconditions.sql
5. 隔离工作区（只含 0001–0022，绝不含 0023–0027）执行：
        supabase db push --db-url "$URL"
6. 门禁：psql -v ON_ERROR_STOP=1 -f supabase/tests/0022_postconditions.sql
7. 库外：指纹复跑，必须仍 8/8
失败处置：
   push 报错   → 事务已回滚，什么都不用做，只需复跑 §6 门禁确认
   push 成功但 §7 门禁不过 → ① 恢复工具回灌快照
                              ② migration repair --status reverted 0022
                              ③ 复跑 §6 门禁 + 指纹
```

第 5 步的工作区保险丝沿用 STAGING-1A7 §2：文件数必须为 22、
最大版本必须为 `0022`、`0023`–`0027` 必须不存在 —— 由 R1 §B 的实测
（`repair`/`push` 在文件缺失时整体失败零写入）把障碍变成保险丝。

---

## §10 本轮产出的仓库文件

| 文件 | 性质 |
|---|---|
| `supabase/tests/program_catalog_digest.sql` | 纯 SELECT，行级指纹（full / business 两支） |
| `supabase/tests/0022_preconditions.sql` | 纯 SELECT + raise，§6 门禁 |
| `supabase/tests/0022_postconditions.sql` | 纯 SELECT + raise，§7 门禁 |
| `docs/operations/staging-1a8/RECOVERY-program_catalog-restore.sql` | **会写库**，带保险丝，刻意不放 tests/ |
| 本报告 | 文档 |

`supabase/migrations/0022_program_offering_scope.sql` **未被修改**
（md5 仍为 `dd62b7827970a1c10ecfd23ac116a2cd`）。

---

## §11 绝对禁止项（全部遵守）

未在 live 做任何 UPDATE / INSERT / DELETE / migration apply / 0022 /
0027 / DB-4 / STAGING-1B / Production / GRANT / REVOKE / user mutation /
ledger repair。本轮 live 访问 = `SELECT` 与 `pg_dump` 读取。
