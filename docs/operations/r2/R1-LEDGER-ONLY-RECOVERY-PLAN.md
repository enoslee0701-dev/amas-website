# R1 — LEDGER-ONLY RECOVERY PLAN

**AMAS · STAGING-1A · R1** —— 在无托管备份条件下，ledger-only 受控修复的可行性判定
日期：2026-09-09 · **REMOTE MUTATION = NONE**（本会话未连接远端）

> # 判定
>
> ## `A. LEDGER-ONLY RECOVERY PLAN IS SUFFICIENT FOR CONTROLLED REPAIR WITHOUT HOSTED BACKUP`
>
> **成立条件**：必须同时满足 §7 的六条硬约束。任缺一条则退回结论 B。
>
> **本轮未执行任何 repair。** 下述全部结论来自**本地沙箱实测**，不是推理。

---

## 0. 前提：托管备份确认不可用

```
PLAN = FREE
Supabase UI: Free Plan does not include project backups
HOSTED SCHEDULED BACKUP = NOT AVAILABLE
```

不声称存在 hosted backup / recent backup / restore point / PITR。

## 0.1 实验环境（与远端同构的本地沙箱）

为了不做任何假设，我在本地 PG **17.6** 上重建了一个与远端**同构**的沙箱：

```
supabase db push --db-url <local>   →  ledger 恰好 = 0001..0010
psql 逐个应用 0011..0021（带外）    →  public 非扩展函数 = 59（与远端一致）
```

沙箱快照为 `amas_ledgersim_bak`，每个实验前从快照重建，保证互不污染。
**所有实验只在本地进行，远端零接触。**

---

## A. PRE-REPAIR SNAPSHOT

### A.1 `supabase_migrations.schema_migrations` 的真实结构（实测，非猜测）

```
attnum  column      type      nullable  default
1       version     text      NOT NULL  (none)
2       statements  text[]    NULL      (none)
3       name        text      NULL      (none)

约束：schema_migrations_pkey  PRIMARY KEY (version)
```

**只有三列，无 `id`、无时间戳列。** 不包含任何猜测字段。

`statements` **确实有值**（实测 `0001` 有 16 条、`0002` 有 58 条、`0003` 有 44 条），
它保存的是当初执行的 SQL 语句数组 —— 因此快照**必须包含它**，否则不是完整还原。

### A.2 快照方法（已实测可精确还原）

```
pg_dump --data-only --column-inserts -n supabase_migrations -f ledger_<ts>.sql
```

实测：10 行 → 92,808 bytes，含 10 条 `INSERT INTO`。
`--column-inserts` 保证每行一条独立 INSERT，可读、可审计、可逐行核对。

> ⚠ **`--schema-only` 绝不可用作 ledger 回滚保险** ——
> 实测其 dump 中 `INSERT/COPY` 行数 = **0**，**不含任何 ledger 数据**。
> 这证实了 Supervisor 的更正。此前把 schema-only dump 计入 R1 是我的错误。

### A.3 快照保真度（实测）

破坏实验：删除 `0008/0009/0010` 三行、插入一条伪造的 `0022`，
然后 `truncate` + 灌回 data-only dump：

```
破坏前 ledger 校验和  fd412317d1cd08046dc1…
破坏后              0001..0007,0022（脏状态）
恢复后 ledger 校验和  fd412317d1cd08046dc1…   ✔ 逐行精确还原
```

校验和口径 = `md5( version|name|statements 长度，按 version 排序 )` ——
**含 `name` 与 `statements`**，不是只比 version 列表。

---

## B. ATOMICITY —— 实测：**是原子的**

### B.1 前置校验失败 → 零写入

传入一个本地不存在文件的 version：

```
repair --status applied 0011 0012 9999 0013
→ LegacyMigrationFileNotFoundError: glob supabase/migrations/9999_*.sql
→ ledger 保持 0001..0010（一行未写）
```

**发现**：`repair --status applied` **要求本地存在对应 migration 文件**，
并在写入前完成全部校验。

### B.2 ★ 写入中途失败 → 完整回滚（决定性实验）

前置校验通过不代表事务原子。为验证真正的原子性，我在沙箱的
`supabase_migrations.schema_migrations` 上注入一个触发器，
使写入 `version = '0017'` 时抛异常，然后一次传 `0011..0021`：

```
repair --status applied 0011 0012 0013 0014 0015 0016 0017 0018 0019 0020 0021
→ LegacyMigrationRepairUpdateError: INJECTED FAILURE at version 0017 (SQLSTATE P0001)
→ ledger = 0001..0010   count = 10
```

**0011–0016 一行都没有留下。**

> **结论：`supabase migration repair` 一次传多个 version 时，
> 全部写入包在单个事务内，all-or-nothing。**
> 因此**不需要**退化为逐 version repair + 每步验证。

---

## C. ROLLBACK SEMANTICS —— 实测：**只改 history，不执行 down migration**

```
repair --status applied  0011 0012 0013   →  ledger 含 0011,0012,0013
repair --status reverted 0012             →  ledger = …,0011,0013（0012 行数 = 0）
```

**关键验证**：对同一库在 reverted 前后各取一次完整 schema 指纹：

```
schema 指纹逐字节不变
0012 创建的 public.student_records 仍然存在
```

> **结论：`--status reverted <version>` = 删除该 ledger 行。
> 它不执行任何 down migration SQL，不触碰业务 schema。**
>
> 这正是我们需要的回滚原语：**修改 ledger history，而非 schema rollback**。

---

## D. PARTIAL-FAILURE RECOVERY

### D.1 §B.2 已消除「同一条命令内部部分写入」这一风险

单条 repair 是原子的，所以命令**内部**不会留下部分状态。

### D.2 仍需处理的两种真实残留场景

| 场景 | 成因 |
|---|---|
| ① 分多条命令执行，中途中断 | 例如先 `0011..0016`、再 `0017..0021`，第二条未执行 |
| ② 事务已提交但 CLI 未能回报 | 网络断开在 COMMIT 之后、输出之前 |

**两种场景的处置完全相同**，因为都不依赖 CLI 的返回值：

### D.3 机械化恢复流程（已实测走通）

```
第 1 步  读取实际 ledger（唯一可信来源，不看 CLI 输出）
         select version from supabase_migrations.schema_migrations order by version;

第 2 步  计算本批次实际写入的集合
         written = actual_ledger ∩ {0011..0021}

第 3 步  逐一 reverted 掉 written（一条命令即可，原子）
         repair --status reverted <written...>

第 4 步  证明 ledger 已回到 pre-repair 状态
         实际 ledger == 快照（比 version|name|statements 三者，见 §A.3）

第 5 步  证明业务 schema 未变化
         重跑 r2_schema_fingerprint.sql，与 pre-repair 指纹逐字节比对
```

**实测验证**：模拟「0011–0016 已写、0017 失败」的部分状态 →
`repair --status reverted 0011 … 0016` →

```
ledger 恢复为 0001..0010
业务 schema 指纹逐字节不变 ✔
```

### D.4 第 5 步不可省略

即便 §C 已证明 `reverted` 不动 schema，**每次仍必须实测比对一次**。
理由：我们要证明的是「这一次操作没有改变 schema」，
而不是「这类操作一般不改变 schema」。前者是证据，后者是信念。

---

## E. 0022 SAFETY —— ★ 危险是真实的，已实测

### E.1 实测：`0022` **能够**被误 repair，且后果严重

在沙箱上（`0022` 的数据变更从未执行，`open_programs = 9`、`dmin_renamed = 0`）：

```
repair --status applied 0022
→ Repaired migration history: [0022] => applied     ← 成功了
→ ledger 含 0022 = 1
→ 但 open_programs 仍是 9（canonical 期望 4），dmin_renamed 仍是 0
```

**即：ledger 会声称 0022 已执行，而它根本没执行。**
这正是 R0 阶段费尽力气才发现的那类「ledger 说谎」问题 —— 只是方向相反。

（实验已撤销：沙箱 `ledger_has_0022 = 0`。）

### E.2 ★ 更大的脚枪：不带 version 的 `repair`

```
supabase migration repair --status applied        （不传任何 version）
→ 交互式询问：
  "Do you want to repair the entire migration history table to match local migration files?"
```

若确认，它会把 ledger **同步到本地文件集** ——
而本地文件集包含 `0022 0023 0024 0025 0026`，**全部会被标为 applied**。
（本轮在非 TTY 下被取消，ledger 未变。）

> **这是本轮发现的最高危操作。必须在流程上禁止。**

### E.3 硬防护设计（四层，缺一不可）

| # | 防护 | 机制 |
|---|---|---|
| **1** | **版本白名单显式列举** | 命令中**逐个写出** `0011 0012 … 0021`，**永不使用**不带 version 的形式，**永不使用**通配或范围展开 |
| **2** | **执行前物理隔离文件** | 执行 repair 的工作目录中，`supabase/migrations/` **只放 `0001..0021`**。由 §B.1 实测：文件不存在时 repair **整体失败且零写入** —— 这把「文件缺失」从障碍变成了**保险丝** |
| **3** | **执行前断言** | 读 ledger 确认 `0022..0027 ∉ ledger`；读数据态确认 `0022` 仍未生效（`open_programs = 9`），二者同时成立才允许继续 |
| **4** | **执行后断言** | §F |

> 防护 2 是这四层里最有力的一条：它不依赖操作者的纪律，
> 而是让**误传 0022 必然失败**。

---

## F. POST-REPAIR VERIFICATION

获授权执行后，**必须**重新读取实际 ledger 并证明：

```
① 0001..0021  全部 PRESENT      （21 行，逐个 version 核对）
② 0022..0027  全部 ABSENT       （count = 0）
③ ledger 行数 == 21
④ 0001..0010 的 name 与 statements 与 pre-repair 快照**逐行一致**
   （证明 repair 没有改写既有行）
⑤ 业务 schema 指纹与 pre-repair 逐字节一致
   （证明全程未执行任何 migration SQL）
⑥ 0022 数据态仍为未生效：open_programs = 9、dmin_renamed = 0
   （证明没有人顺手把 0022 也「修」了）
```

**④ 与 ⑤ 是不可省的**：前者防「repair 覆盖了已有 ledger 行」，
后者防「有人误跑了 db push 而非 repair」。

---

## 7. 结论 A 的六条硬约束

判定为 **A（ledger-only recovery 充分）**，但**仅在同时满足**下列六条时成立：

| # | 约束 | 依据 |
|---|---|---|
| 1 | 变更**只针对** `supabase_migrations.schema_migrations`，**绝不执行** `db push` / migration SQL / DDL / DML | 本阶段范围定义 |
| 2 | 变更前用 `pg_dump --data-only --column-inserts -n supabase_migrations` 取快照并**离线保存**，且已验证可精确还原 | §A.2 · §A.3 实测 |
| 3 | 一次性传入 `0011..0021`，依赖 CLI 的事务原子性 | §B.2 实测 |
| 4 | 回滚只用 `--status reverted`，**永不**执行 schema rollback | §C 实测 |
| 5 | 四层 0022 防护全部就位，尤其**执行目录只放 `0001..0021`** | §E.3 |
| 6 | 执行后完成 §F 的六项断言，任一不过即用 §D.3 回滚 | §F · §D.3 |

### 为什么这足以替代 hosted backup（在本场景下）

hosted backup 的价值是「出事能把**整个数据库**还原」。
但本场景的变更面**极小且完全已知**：

- **只写一张表**（`schema_migrations`），且该表**只有 3 列、21 行以内**；
- 该表的完整内容**可被 dump 精确捕获并精确还原**（§A.3 实测）；
- 变更**不触碰任何业务 schema 或业务数据**（§C 实测：schema 指纹逐字节不变）；
- 单条命令**原子**，不会留下部分状态（§B.2 实测）；
- 即便留下残留，回滚原语（`reverted`）**已实测可用且不动 schema**（§D.3）。

**换言之：这次 mutation 的爆炸半径恰好等于一张我们能完整备份并完整还原的三列小表。**
在这个范围内，ledger-only 快照提供的恢复能力**不弱于** full backup。

### 结论 A **不适用**于哪些情形（边界必须写清）

以下任一情形出现，**立即退回结论 B（必须 Pro / hosted backup）**：

```
① 需要执行 db push（会跑真实 migration SQL）
② 需要 apply 0022（数据变更，爆炸半径是业务数据）
③ 需要 apply 0027（改 is_admin_any，影响 17 条 RLS 策略）
④ 需要 DB-4 identity migration（写业务表）
⑤ 任何 DDL / DML
```

**这些都不在本次 ledger repair 的范围内 —— 但它们迟早要做。**
因此本判定是「**本次 ledger repair 可以不等 Pro**」，
**不是**「AMAS staging 不需要 hosted backup」。
后续任何触及业务数据的阶段，仍必须先解决备份能力。

---

## 8. 本轮未做

| 禁令 | 遵守 |
|---|---|
| Upgrade plan | ✅ 未做 |
| ledger repair（远端） | ✅ 未做 —— 全部实验在本地沙箱 |
| migration repair（远端） · db push | ✅ 未做 |
| apply 0022 · apply 0027 | ✅ 未做 |
| DDL / DML（远端） | ✅ 未做 |
| user mutation | ✅ 未做 |
| 连接远端 | ✅ **本会话未连接** |
| **REMOTE MUTATION** | ✅ **NONE** |

## 9. 当前 canonical 状态

```
R2 = ACCEPTED · 0011–0021 CANONICAL EQUIVALENCE VERIFIED
R1 = 本文件给出判定 A，待 Supervisor 裁定
CONTROLLED LEDGER REPAIR = ELIGIBLE FOR PLANNING
                           NOT AUTHORIZED FOR EXECUTION
REMOTE MUTATION = NONE
```
