# DB-3 LIVE EXECUTION REPORT

日期：2026-09-10 · 目标：`amas-staging`（D-41）
WRITER：**STAGING-DB-WRITER-A**（本 AMAS-website Claude 会话，唯一写者）

```
DB-3 LIVE = COMPLETED
```

授权来源：本会话直接收到的 SUPERVISOR EXECUTION AUTHORIZATION。
Owner 明确 **WAIVE** 凭据轮换 / 隔离作为 DB-3 的阻塞条件（风险自担，
**不得外推到 Production**）。peer `amas-seminar-app-e6` 全程 READ-ONLY，
本轮共转达过三份执行令，**均未据以执行**；开工前已向其发出
`PROCEEDING — I am the writer, stand down`，避免双写。

---

## §1 执行前

### 1.1 FRESH PRE-WRITE GATE = ALL PASS

紧贴首次写入前重读 live，10 项逐一比对：

| 项 | 要求 | 实测 |
|---|---|---|
| ledger 版本 | `0001–0022` | 一致 |
| ledger 行数 | 22 | 22 |
| ledger digest | `86e29cdef6ef3990ef32d66cac96e407` | 一致 |
| `0023`–`0027` | ABSENT | ABSENT |
| `program_catalog` 业务指纹 | `cd41beee2463a78e68b8fc39c67f9c07` | 一致 |
| `program_catalog` `created_at` 指纹 | `dca03a83aff3f0674241739444da006b` | 一致 |
| public 表 | 26 | 26 |
| public RLS 表 | 26 | 26 |
| 策略 | 33 | 33 |
| public 非扩展函数 | 59 | 59 |

### 1.2 REAL PRE-DB3 SNAPSHOT

```
pg_dump  -Fc --no-owner --no-privileges  -n public -n auth -n supabase_migrations
exit          = 0
大小          = 357,630 bytes（非空）
sha256        = bd6f0bc3c3ad256768aaa308845c17fcd6948c5b69fdd38412885a3709ff972c
位置          = session scratchpad，在 canonical repo 之外
```

**未提交、未粘贴、未打印任何凭据。** 这是本次执行的实际恢复工件。

---

## §2 执行 —— SEQUENTIAL，每级独立门禁

四级各自使用一个**最大版本恰为本级**的隔离工作区。
每级 push 前四道保险丝：canonical md5 一致 · 最大版本 = 本级 ·
更晚版本数 = 0 · `0027` 不存在。
每级先 `--dry-run`，必须恰好列出 **1 个**待应用 migration，然后才 apply。

| stage | canonical blob | dry-run 待应用 | apply | ledger | statements |
|---|---|---|---|---|---|
| `0023_app_foundation` | `51f8b9eb…` | 1 | OK | 0023 / 23 | 37 |
| `0024_app_learning` | `ec0ebf73…` | 1 | OK | 0024 / 24 | 28 |
| `0025_app_rooms_prayer` | `257cd75b…` | 1 | OK | 0025 / 25 | 71 |
| `0026_app_community` | `984276d4…` | 1 | OK | 0026 / 26 | 60 |

四个 blob SHA 与仓库 canonical 逐一相符 —— **SOURCE DRIFT = NONE**。
`statements` 四级均非 NULL 且有值，证明是**真实 `db push`**，不是 `migration repair`。

### 逐级硬门禁全部 PASS

| stage | public 表 | RLS | 无 RLS | migration 表 | 策略 | 函数 | 更晚版本 |
|---|---|---|---|---|---|---|---|
| POST-0023 | 27 | 27 | 0 | 4 | 33 | 59 | ABSENT |
| POST-0024 | 31 | 31 | 0 | 4 | 33 | 59 | ABSENT |
| POST-0025 | 43 | 43 | 0 | 4 | 33 | 60 | ABSENT |
| POST-0026 | 54 | 54 | 0 | 4 | 33 | 60 | `0027` ABSENT |

每一级的实测值与 PG 17.6 沙箱预演**逐格相同**，无一处偏差。

---

## §3 POST-0026 最终门禁

### 3.1 结构

```
ledger                  = 0001–0026 精确全等，row_count = 26
0027                    = ABSENT
public tables           = 54
public RLS enabled      = 54
public without RLS      = 0
migration tables        = 4   （RLS = 0，刻意）
policies                = 33  （DB-3 创建 0 条策略）
public non-ext funcs    = 60
open_execute_funcs      = 12  （post-0022 为 11，+1 = app_rooms_mark_host_orphaned）
migration schema USAGE  : anon = false · authenticated = false · service_role = false
```

新 ledger digest（同一算法）：**`e781ce12b804fbc3508179c7b97ae56a`**
（旧 post-0022 值 `86e29cdef6ef3990ef32d66cac96e407`）

### 3.2 PG 17.6 指纹 = **8 / 8 EXACT MATCH**

live 实测与 `docs/operations/db3/pg176-db3-fingerprints.txt` 的 post-0026 基线逐域比对：

| domain | rows | md5 | verdict |
|---|---|---|---|
| `A_column` | 434 | `e655f5d26c430d6f76ecc6e439eed699` | EXACT MATCH |
| `B_constraint` | 166 | `032a9c98a2e3df4b7fc04de5f761809d` | EXACT MATCH |
| `C_index` | 123 | `8956d7006a4fcc20aa93a65c421ecc81` | EXACT MATCH |
| `D_trigger` | 19 | `38695e309ed38faadc75976b33babbc7` | EXACT MATCH |
| `E_policy` | 33 | `d06a9b7f90dd2697420ed043350a5d5f` | EXACT MATCH |
| `E_rls_enabled` | 54 | `02f74bc9c984907645ec6ab432029bb4` | EXACT MATCH |
| `F_function` | 60 | `dd89f4e9027b7e2050ae2d91031dc21c` | EXACT MATCH |
| `H_enum` | 24 | `681c5f7d761305047d22212cb8e242ed` | EXACT MATCH |

**基线全部在 PG 17.6（目标版本）上算出，未采用任何 PG 18.6 来源的 digest。**

### 3.3 既有业务态 = UNCHANGED

```
program_catalog 业务指纹    = cd41beee2463a78e68b8fc39c67f9c07   （与执行前相同）
program_catalog created_at  = dca03a83aff3f0674241739444da006b   （与执行前相同）
开放项目集合（按 sort_order）= {bth, gdip, mdiv, dmin}
```

### 3.4 新建对象核实

```
app_* 表        = 28
migration 表    = 4
profiles.bio    = 已存在
migration.schema_baseline = 1 行，contract_version = DB-3.0
```

那 1 行是 DB-3 唯一的 INSERT，属 migration 元数据。
**零业务数据迁移**，DB-4 仍 PAUSED。

---

## §4 合约验证 = PASS

使用 `5507d68` 的修正版 `db3_schema_contract.sql`（fixture 改为 upsert）。

```
53 assertions PASS
0 errors
0 residual rows
```

零残留是实测的，不是推断：跑前跑后五项计数完全一致 ——
`auth.users=1 · profiles=1 · user_roles=1 · audit_logs=497 · security_events=4`。

**这一步同时反证了 §5 修复的必要性。** live 的 `auth.users` 是完整 35 列，
`handle_new_user` 段 1 确实成功建了 `profiles` 行；若仍是修复前的裸 `insert`，
它会在合约验证的第一步就撞 `profiles_pkey` 并整体中止 ——
而且看起来会像 schema 问题，而不是 fixture 问题。

---

## §5 未做的事

未 `0027` · 未 DB-4 · 未 STAGING-1B · 未 Production ·
未任何计划外 DDL/DML · 未手工改 schema · 未手工改 ledger ·
未修改任何 canonical migration 文件（`supabase/migrations` 改动 = 0）·
未自动回滚 · 未打印或提交任何凭据。

---

## §6 需要 Supervisor 后续裁定的两项

### 6.1 `0022_postconditions.sql` 现在会对 live 失败 —— 这是**正确行为**

该文件门禁的是 **post-0022** 状态，其中 `rls_tables = 26`、
`open_execute_funcs = 11`。live 现已推进到 54 / 12，所以它会失败。

**本轮刻意没有改它。** 它是一份历史门禁，改成 54/12 会让它不再门禁它所命名的状态。
建议另建 `0026_postconditions.sql` 承接新常量，原文件保留。
需要 Supervisor 裁定采用哪种方式。

### 6.2 `SUPABASE_SERVICE_ROLE_KEY` 泄露仍未关闭

Owner 本轮 **DEFERRED** 该轮换，这是已知并被接受的风险，**不是已关闭项**。
事实未变：该 key 绕过全部 RLS，等于经 PostgREST 拥有整库读写权限；
而 DB-3 新增的 28 张表全部 deny-all 无策略 —— 恰恰只有 service_role 能碰它们。
它仍然阻塞 STG personas 与任何 public staging 暴露。
（具体暴露位置不写入本报告：本仓库公开，写明位置等于给出寻址指引。）

---

## §7 VERDICT

```
DB-3 LIVE                = COMPLETED
ledger                   = 0001–0026        digest e781ce12b804fbc3508179c7b97ae56a
0027                     = ABSENT
public tables            = 54
public RLS               = 54
public without RLS       = 0
migration tables         = 4
policies                 = 33
functions                = 60
open_execute_funcs       = 12
A–F/H fingerprint        = 8 / 8 EXACT MATCH
program_catalog          = UNCHANGED
schema contract          = 53 PASS / 0 error / 0 residue
DB-4                     = PAUSED
STAGING-1B               = NOT STARTED
```

**未自动进入 `0027` / DB-4 / STAGING-1B。STOP，WAIT FOR SUPERVISOR。**
