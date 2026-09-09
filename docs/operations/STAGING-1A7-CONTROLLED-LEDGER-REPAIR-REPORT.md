# STAGING-1A7 CONTROLLED LEDGER REPAIR — 执行报告

日期：2026-09-09 · 目标：`amas-staging`（D-41）
结论：**REPAIR NOT EXECUTED — PRE-WRITE BASELINE MISMATCH**
**REMOTE MUTATION BY THIS SESSION = NONE**（本会话对远端只做 SELECT 与 pg_dump 读取）

---

## §1 CREDENTIAL GATE = PASS

三项均通过，全过程未回显任何 credential 值。

| 检查 | 结果 |
|---|---|
| 无 `[YOUR-PASSWORD]` | PASS |
| 无方括号残留 | PASS |
| 口令非空 | PASS |
| `SUPABASE_URL` / `SERVICE_ROLE_KEY` 已配置 | PASS |
| scheme = postgres 系 | PASS |
| user = `postgres.<ref>` | PASS |
| host = pooler（session mode） | PASS |
| port = 5432 · database = postgres | PASS |
| body 中 `@` 恰好 1 个 | PASS |
| 无空白 / 引号 | PASS |
| `SELECT 1` 连续三次 | PASS（exit=0 ×3） |

### 本轮修正的两处（均为 URI 编码问题，未改动口令内容）

Owner 替换占位符时保留了外层方括号，形成 `user:[password]@host`。
`psql` 把前导 `[` 当作 IPv6 字面量语法，于是把 `]@aws-0-...pooler.supabase.com`
整体当成主机名，报 `could not translate host name`。

进一步实测发现**口令本身含一个 `@`**，因此仅删方括号仍不够 ——
`libpq` 会在错误的 `@` 处切分 userinfo。结构证据（不回显任何值）：
`]@` 在整串中恰好出现 1 次且正是 host 分界；userinfo 中 `:` 恰好 1 个；
host 段不含 `@` 且为 pooler 主机。故 `user:[X]@host` 中的 `X` 唯一确定，
且 `X` 内含 `@`。

处置：只重写 `backend/.env` 的 `DATABASE_URL` 一行，去掉外层方括号并对口令做
percent-encoding（`urllib.parse.quote(safe='')`），其余 35 行字节未变，行尾保持 LF。
**未猜口令、未生成假口令、未 Reset database password、未新建任何 `.env.bak`。**
（不建备份文件是刻意的：`backend/.gitignore` 只匹配 `.env`，`.env.bak-*` 不被忽略，
此前已因此产生过一次真实泄漏风险。）

### 一次瞬时失败的如实记录

修正后的第一次 `SELECT 1` 返回 `FATAL: password authentication failed`。
为区分「我的编码破坏了口令」与「口令本身不对」，用完全绕开 URI 解析的
keyword conninfo（口令走 `PGPASSWORD`）复测 → exit=0。随后四种 URI 变体
（.env 原样 / 加 `sslmode=require` / 重新 quote / 仅编码 `@`）全部 exit=0，
且 bash 提取值与 python 读取值 md5 逐字节相同。
结论：那次是**瞬时认证失败**，不是配置缺陷。已用连续三次 `SELECT 1` 确认。

---

## §2 ISOLATED WORKSPACE = PASS

工作区位于 session scratchpad 的 `ledger_repair_ws/`，在 canonical repo 之外。

| 保险丝断言 | 结果 |
|---|---|
| migrations 文件数 = 21 | PASS |
| 最大版本 = `0021` | PASS |
| `0022`–`0027` 均不存在 | PASS（count=0） |
| `supabase/config.toml` 存在 | PASS |
| 21 个文件与 canonical 逐文件 md5 一致 | PASS（不一致 = 0） |
| canonical `supabase/` 改动文件数 | 0 |

保险丝原理见 R1 §B：`repair --status applied` 要求本地存在对应 migration 文件，
文件缺失会使整条命令失败且零写入 —— 把「文件不在」变成防止误标 `0022` 的硬保险。

---

## §3 PRE-WRITE REMOTE CHECK = **FAIL**

授权书给定的 live baseline 与实测不符：

| 项 | 授权 baseline | 实测（2026-09-09） | 判定 |
|---|---|---|---|
| ledger 版本 | `0001`–`0010` | `0001`–`0021` | **MISMATCH** |
| row_count | 10 | **21** | **MISMATCH** |
| ledger digest | `779baa849645081d9f8ba68b18ec7224` | 见下 | 无法比对 |
| `0011`–`0021` 已存在 | 0 | **11** | **MISMATCH** |
| `0022`–`0027` 存在 | 0 | 0 | 一致 |
| `0022` 数据态 | 未生效 | 未生效 | 一致 |

按 §7 失败规则与 R-5 fail-closed：**立即停止，不执行 repair。**
授权的写操作已无对象 —— ledger 中 `0011`–`0021` 已经存在。

### digest 说明

`779baa84…` 的算法未记入仓库，仅出现在 Supervisor 消息中。
我在远端就地计算了五种候选（逗号连接 / LF 连接 / 直接串接 /
`version|name` / `version|name|statements长度`），当前 21 行状态下分别为
`414566b1…` / `f5b44075…` / `676c5aef…` / `53cda8c9…` / `3e5d6140…`，
均不等于 `779baa84…`。这不构成矛盾 —— 该 digest 是 10 行状态的值，
而当前是 21 行状态。**故本项无法作为反向校验，需 Supervisor 提供算法定义。**

### 取证：这 11 行是怎么进去的

`0011`–`0021` 的 `statements` 数组**全部有值**（6/69/2/4/45/15/19/10/23/27/19），
`name` 全部正确。`repair --status applied` 会读取本地 migration 文件并写入
statements，`db push` 亦然，故 statements 有值**不能**区分二者。

【SUPERVISOR 裁定更正】原文此处写有「provenance 指向 `migration repair`，
而非 `db push`」。该表述超出证据所能支撑的范围，已按裁定作废。
可陈述的事实止于：`0011`–`0021` 的对象在 R2 之前已由带外 `psql` 应用过，
且业务 schema 逐字节未变。**执行者与方法无法仅凭 `schema_migrations` 证明。**
canonical 表述见 §10。

`0001`–`0010` 的 name 与 statements 长度与 R1 快照记录一致
（`0001`=16 · `0002`=58 · `0003`=44），说明既有行未被覆盖。

---

## §4 LEDGER SNAPSHOT = 已捕获（只读）

`pg_dump --data-only --column-inserts -n supabase_migrations` exit=0，
21 条 INSERT，落在 canonical repo 之外的 session scratchpad。
**内容未打印、未入库、未粘贴。** 保留作为后续动作的回滚保险。

---

## §5 REPAIR = **NOT EXECUTED**

未运行任何 `supabase migration repair`。未使用无 version 形式。
未手工 INSERT `schema_migrations`。未使用 SQL Editor。
未把 service_role 当作数据库凭据。

---

## §6 读取式验证（对当前实际态执行，A–F 全项）

虽然 repair 未由本会话执行，A–F 六项验证仍可对现状只读执行：

| 项 | 期望 | 实测 | 判定 |
|---|---|---|---|
| A `0001`–`0021` 全 PRESENT | 21 | 21 | PASS |
| B `0022`–`0027` 全 ABSENT | 0 | 0 | PASS |
| C row_count = 21 | 21 | 21 | PASS |
| D `0001`–`0010` name/statements 与快照一致 | 一致 | 一致 | PASS |
| E 业务 schema 指纹与 canonical 逐字节一致 | 8/8 | **8/8** | PASS |
| F `0022` 数据态仍未生效 | open=9 / closed=0 / renamed=0 | 9 / 0 / 0 | PASS |

### E 的细节 —— 本轮首次由本会话直连远端实测

用 v2 指纹（已修复 E/F 两处序列化缺陷）对 `canonical-0021-fingerprint-v2.txt` 比对：

| domain | rows | md5 | verdict |
|---|---|---|---|
| `A_column` | 245 | `e910a2bb9c9aa67d6550509e719dd6bf` | EXACT MATCH |
| `B_constraint` | 72 | `9e38564adeb9358da98d2e7ae325c79f` | EXACT MATCH |
| `C_index` | 59 | `955c56a27c339f1f5cce1697bc6e5ede` | EXACT MATCH |
| `D_trigger` | 18 | `d9b321ec390108ac712db55f02fa781f` | EXACT MATCH |
| `E_policy` | 33 | `d06a9b7f90dd2697420ed043350a5d5f` | EXACT MATCH |
| `E_rls_enabled` | 26 | `6461fb5e99bd036f95525635b1fadbdc` | EXACT MATCH |
| `F_function` | 59 | `6fe5410b84f57ca13c55cfc65f66601b` | EXACT MATCH |
| `H_enum` | 15 | `22575b34ed9950448fc8157070cdeee8` | EXACT MATCH |

```
EXACT MATCH DOMAINS: 8 / 8
```

R2 当时 `E_policy` 与 `F_function` 报 DIFFERENT，是我的序列化缺陷所致，
由 Supervisor 裁定为语义等价。**v2 指纹下两域已直接逐字节相等，裁定得到独立复现。**

G 系为平台基线敏感，按既定规则不做 raw diff，只报 surface：
`G_table_grant`=66 · `G_func_grant`=122 · `G2_privilege_surface`=40 ·
`G2_func_exec_open`=**11** · `G3_write_policy`=7 ·
不变式 `G3_VIOLATION_write_acl_without_rls` = **0 行 PASS**。

`G2_func_exec_open` 的 11 个与 R2 记录完全一致，且全部是 trigger function
（`append_only_guard` · `application_protect_locked` · `application_strip_forbidden` ·
`application_validate_form` · `application_validate_program` ·
`application_validate_transition` · `course_catalog_guard` ·
`normalize_student_number` · `student_guard` · `sync_alias_on_role_revoke` ·
`tvr_validate_transition`）。仍维持 `PRIVILEGE HARDENING REVIEW REQUIRED`，
本轮不 revoke。

---

## §7 需要 Supervisor 裁定的一点

远端 ledger 在授权书写下 baseline 之后、本会话执行之前发生了变化。
本会话未做任何写入，因此**这次变更来自本会话之外的写者**。
业务 schema 8/8 未变、`0022` 未被误标、既有行未被覆盖 —— 状态本身是干净的，
恰好等于 STAGING-1A7 期望达成的终态。

但按 **D-38 ONE CANONICAL WRITER PER REPOSITORY**，需要确认：

1. 该 repair 是否由 Supervisor 亲自执行？若是，请确认后本项即可关闭。
2. 若不是，则存在第二个写者接触了 staging，需按 D-38 处置。
3. 请提供 `779baa84…` 的 digest 算法定义，以便把它固化进仓库、
   使后续 baseline 可被本地独立复算，不再依赖聊天中的一次性值。

---

## §8 绝对排除项（全部遵守）

未 `db push`；未 apply `0022`；未 apply `0027`；未跑 DB-4；
未做任何 DDL / DML；未创建 Supabase user；未 upgrade plan；
未 reset 数据库口令；未 commit / 打印 / 粘贴任何 secret。

## §9 VERDICT

```
§1 CREDENTIAL GATE            = PASS
§2 ISOLATED WORKSPACE         = PASS
§3 PRE-WRITE BASELINE CHECK   = FAIL (baseline mismatch)
§5 LEDGER REPAIR              = NOT EXECUTED
§6 READ-ONLY VERIFICATION A-F = 6/6 PASS
REMOTE MUTATION BY THIS SESSION = NONE
```

**STAGING-1A7 STOPPED AT §3. AWAITING SUPERVISOR RULING ON LEDGER PROVENANCE.**
未进入 `0022` Gate，未进入 STAGING-1B。

---

# §10 ADDENDUM — SUPERVISOR RULING（2026-09-09）

本节由 Supervisor 裁定后追加。**无任何数据库写操作。**

## 10.1 PROVENANCE — 最终定性

Supervisor 已独立确认：**Supervisor 未执行**该 repair；本 Claude 会话亦未执行。
因此按裁定，采用以下**唯一 canonical 表述**：

```
LEDGER MUTATION PROVENANCE:
UNKNOWN EXTERNAL WRITER

LIKELY CONSISTENT WITH LEDGER-ONLY REPAIR
BUT NOT PROVEN
```

明确禁止写成：Supervisor 执行了它 · Claude 执行了它 ·
`db push` 确定做了它 · `migration repair` 确定做了它。
**仅凭 `schema_migrations` 不足以做执行者归因。**

§3 中我原先写的「provenance 指向 `migration repair`」已按此作废（见该节更正标注）。
066b27f 的 commit message 中含同样表述，因不得 amend / rewrite history，
以本节作为其 canonical 更正。

## 10.2 STAGING-1A7 结论

```
STAGING-1A7 TECHNICAL STATE = ACCEPTED

LEDGER RECONCILIATION STATE:
COMPLETED / VERIFIED PRESENT

EXECUTION PROVENANCE:
UNRESOLVED
```

这是**基于状态的接受，不是对执行行为的归因**。

## 10.3 CANONICAL LEDGER DIGEST ALGORITHM

固化如下，供后续 baseline 本地独立复算，不再依赖聊天中的一次性值：

```sql
md5(
  string_agg(
    version || '|' ||
    coalesce(name,'') || '|' ||
    coalesce(md5(array_to_string(statements, E'\n')), ''),
    E'\n'
    order by version
  )
)
```

可执行版本已归档为 `supabase/tests/ledger_digest.sql`（纯 SELECT，无任何写语句）。

| baseline | 范围 | row_count | digest |
|---|---|---|---|
| OLD（授权书 baseline） | `version between '0001' and '0010'` | 10 | `779baa849645081d9f8ba68b18ec7224` |
| NEW（当前终态） | `version between '0001' and '0021'` | 21 | `ec46316fd12ce62d09b0290aece90684` |

本会话已对 live 只读复算，**两个 digest 均逐字符复现**，与 Supervisor 独立复算一致。
OLD digest 复现即证明 **`0001`–`0010` 的原始行完好未被覆盖**。

## 10.4 当前 live 终态（已接受）

```
ledger            = 0001–0021
row_count         = 21
0022–0027         = ABSENT
0022 data         = NOT APPLIED   (open=9 / five_closed=0 / dmin_renamed=0)
business schema   = 8/8 EXACT MATCH
G3 violation      = 0
```

裁定：**该状态即预期的安全终态。**
禁止 repair retry · 禁止 reverted repair · 禁止手工改 ledger · 禁止 `db push`。

## 10.5 DATABASE WRITER FREEZE

在下一个 gate 被授权前：

- 必须先声明**唯一一个** `STAGING DB MUTATION OWNER`。
- **其余所有 Claude 会话 / 终端 / agent 对 `amas-staging` 一律只读。**

本轮不得进入：`0022` Gate · `0027` · DB-4 · STAGING-1B · Production ·
任何 DDL/DML · 任何 GRANT/REVOKE · 任何 user mutation。

## 10.6 GITHUB CANONICAL

`066b27f` 推送前三项前置全部 PASS —— `origin/master == a795003`、
`parent(066b27f) == a795003`、工作区干净 —— 以 fast-forward 推送成功
（`a795003..066b27f`）。未 amend、未 recreate、未 force push、未触发 cache-bust hook。
