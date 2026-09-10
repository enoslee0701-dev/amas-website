# DB-3 PRE-EXECUTION GATE REPORT

日期：2026-09-10 · 目标：`amas-staging`（D-41）
WRITER：**STAGING-DB-WRITER-A**（本 AMAS-website Claude 会话）
**LIVE MUTATION = NONE** —— 本轮对 live 只有 `SELECT`。
`0023`–`0026` **未在 live 执行**。

---

## §0 关于两次「转达的执行授权」

本轮 peer（`amas-seminar-app-e6`）先后转达了两份 Owner 授权，
内容是让我直接开始执行 0023–0026。**我没有据此执行。**

理由不是怀疑 peer 的诚信 —— 它的转达内容与我的取证互相印证，也主动纠正了自己的错误。
理由是流程：本会话收到的直接裁定写明 DB-3 执行**未授权**，须先过四道 Gate，
其中 §3 CREDENTIAL ISOLATION 由 Owner 轮换口令后才成立。
经由第三方会话转达的授权不能替代直接指令 —— 上一轮的两次
UNKNOWN EXTERNAL WRITER 事件，根因正是「两套授权链指向同一个数据库」。
再用同样的方式解除阻塞，等于重演它。

Gate 2/3/4 全部是本地工作，与授权无关，已全部完成，见下。

---

## §1 CREDENTIAL ISOLATION GATE = **BLOCKED BY OWNER ROTATION**

| 项 | 状态 |
|---|---|
| `AMAS Seminar App/backend/.env` 的 `DATABASE_URL` | 仍是轮换前的值，mtime `2026-09-09 11:14:40`，本轮未改动 |
| 该文件是否仍被两个会话共读 | **是** |
| 口令是否已轮换 | **否**（须由 Owner 在控制台执行） |

取证已证明因果链：该文件在 `11:14:40` 被修复，`11:17:22` 即出现第一次 live 写入。
**只要旧口令仍在共享文件里，「约定只读」就不是隔离。**

本会话不持有、也不会请求新口令。执行窗口开启时，请在本会话的终端内
临时注入，用完即清；不写入任何仓库或共享文件，不进入聊天。

**在轮换完成前，DB-3 EXECUTION = BLOCKED。**

---

## §2 EXACT BLAST RADIUS（源码逐字解析）

### 新建对象

| 类别 | 数量 | 说明 |
|---|---|---|
| `public` 表 | **28** | 全部 `app_*` |
| `migration` 表 | **4** | `legacy_identity_crosswalk` · `admin_role_migration_manifest` · `row_manifest` · `schema_baseline` |
| 函数 | 1 | `app_rooms_mark_host_orphaned` |
| enum | 9 | `app_*` 系列 |
| `create policy` | **0** | —— |
| `grant` | **0** | —— |

### 修改的既有对象（只有两张表，全部是加列）

```
public.profiles       ADD bio
public.course_catalog ADD thumbnail_path · thumbnail_image_id · created_at · created_by_provenance
```

无 `drop column`、无类型变更、无既有约束改动。

### 唯一的 INSERT

`migration.schema_baseline` 一行元数据（`contract_version='DB-3.0'`），
带 `on conflict do nothing`。实测 post-0026 该表 1 行。
**零业务数据写入**，DB-4 仍 PAUSED。

---

## §3 PG 17.6 POST-0026 BASELINE = **PASS**

沙箱 `amas_db3`（本地 PG 17.6，端口 5433）。
起点先自证可信：post-0022 与 live 已接受基线逐项吻合 ——
ledger 22 · public 表 26 · RLS 26 · 策略 33 · 非扩展函数 59 ·
`migration` schema 不存在 · `profiles.bio` 不存在 · `app_*` = 0 ·
`program_catalog` 业务指纹 `cd41beee2463a78e68b8fc39c67f9c07`（与 live **相同**）。

按「隔离工作区 + 每次只放到目标版本」逐级推进，每级先 `--dry-run`
确认恰好只列一个 migration，再 apply。四级保险丝全 PASS（文件数、最大版本、
更晚版本数=0、目标文件 md5 与 canonical 一致）。

### 版本无关的对象计数（可跨 PG 版本，适合做硬门禁）

| stage | pub 表 | pub RLS | pub 无 RLS | mig 表 | mig RLS | 策略 | 函数 |
|---|---|---|---|---|---|---|---|
| post-0022 | 26 | 26 | 0 | 0 | 0 | 33 | 59 |
| post-0023 | 27 | 27 | 0 | 4 | 0 | 33 | 59 |
| post-0024 | 31 | 31 | 0 | 4 | 0 | 33 | 59 |
| post-0025 | 43 | 43 | 0 | 4 | 0 | 33 | 60 |
| **post-0026** | **54** | **54** | **0** | **4** | **0** | **33** | **60** |

与 Supervisor 钉死的 post-0026 门禁**逐格吻合**。

### PG 17.6 确定性指纹（A–F/H 域，`public` schema）

```
post-0026
  A_column      434  e655f5d26c430d6f76ecc6e439eed699
  B_constraint  166  032a9c98a2e3df4b7fc04de5f761809d
  C_index       123  8956d7006a4fcc20aa93a65c421ecc81
  D_trigger      19  38695e309ed38faadc75976b33babbc7
  E_policy       33  d06a9b7f90dd2697420ed043350a5d5f   ← 与 post-0022 完全相同
  E_rls_enabled  54  02f74bc9c984907645ec6ab432029bb4
  F_function     60  dd89f4e9027b7e2050ae2d91031dc21c
  H_enum         24  681c5f7d761305047d22212cb8e242ed
```

五级全部归档于 `docs/operations/db3/pg176-db3-fingerprints.txt`，
post-0026 完整行级基线归档于 `pg176-post-0026-fingerprint.txt`。

**未采用任何 PG 18.6 来源的 digest。** peer 的 18.6 数字仅作交叉参考：
其行数更大是因为它的指纹跨 `public + migration` 两个 schema 且每对象一行；
本基线是 `public`-only，与既有 R2 方法论一致。

### POSTCOND-8 两个常量必须分别重算，不得互相推导

| 常量 | post-0022 | post-0026 | 说明 |
|---|---|---|---|
| `rls_tables` | 26 | **54** | +28 |
| `open_execute_funcs` | 11 | **12** | **+1**，不是 54 |

`open_execute_funcs` 的 +1 是 `app_rooms_mark_host_orphaned` —— 它和既有 11 个
trigger function 一样，默认带 `PUBLIC EXECUTE`。
沙箱 post-0022 实测 `11 / 26`，与 live 现值**完全相同**，反证沙箱口径可信。

---

## §4 APP ACCESS-PATH AUDIT = **A（NO CLIENT DIRECT ACCESS）**

对 `AMAS Seminar App` 现行代码做机械审计（排除 `node_modules`、构建产物、
`android`/`ios` 打包资源）。

引用 `@supabase/supabase-js` 的源码文件只有 **1 个**：`services/supabaseAuth.ts`。
（另两处命中是后端测试与一个构建产物。）

全部 PostgREST 调用共 **3 处**，全部指向 0023 之前就存在的对象：

| 位置 | 调用 | 目标 | 分类 |
|---|---|---|---|
| `services/supabaseAuth.ts:60` | `.from('profiles').select('display_name')` | `profiles`（既有表） | DIRECT DATABASE ACCESS，但对象既有 |
| `services/supabaseAuth.ts:70` | `.rpc('my_roles')` | 既有 RPC | AUTH ONLY |
| `services/recoveryDeepLink.ts:111` | `.rpc('start_recovery_flow')` | 既有 RPC | AUTH ONLY |

**28 张新表名在前端源码中出现 0 次。** 无任何 `.schema()` 调用。

`profiles` 这一处需单独说明：0023 只对它 **ADD bio**，
不动其 RLS 策略、不动 `display_name`。加列不影响既有 `select`。

```
决策 A：NO CLIENT DIRECT ACCESS TO 0023–0026 TABLES
        DENY-ALL IS COMPATIBLE
```

`migration` schema 的 deny 亦在 PG 17.6 实测确认：
`anon` / `authenticated` / `service_role` 的 `USAGE` **三者皆 false**
（由 0023 的 `revoke all on schema migration from public`
+ `revoke usage ... from anon, authenticated` 达成，全文无任何 grant 回授）。
所以那 4 张表不启 RLS 是安全的 —— 不是遗漏，是 schema 层不可达。

---

## §5 `db3_schema_contract.sql` FIXTURE 缺陷 —— 已复现、已修复

这是本轮最有价值的发现，而且是我自己文件里的真实缺陷。

**它在 live 上会失败。**

机理：`auth.users` 上挂着 `on_auth_user_created → handle_new_user`，
其段 1 执行 `insert into public.profiles ... on conflict (id) do nothing`，
并引用 `new.email_confirmed_at` 与 `new.raw_user_meta_data`。
合约测试第 32 行随后又做了一次**裸** `insert into public.profiles`。

两种环境行为分叉，实测双向复现：

| 环境 | `auth.users` 列数 | `email_confirmed_at` | 触发器段 1 | 裸 insert 结果 |
|---|---|---|---|---|
| 最小 shim | 5 | **缺** | 运行时报错，被自身 `exception when others` 吞掉并记入 `security_events` | **侥幸成功** |
| 真实 Supabase（live） | **35** | **有** | **成功建 profiles 行** | **撞 `profiles_pkey`** |

我先在原始沙箱上跑，53 断言全过 —— 那是**假象**。
补上 `email_confirmed_at` 一列后重跑，立刻精确复现：

```
ERROR: duplicate key value violates unique constraint "profiles_pkey"  （第 34 行）
```

**修复**：把 fixture 的 profiles 写入改为 upsert，使其对触发器是否生效保持中立 ——
触发器建了就改写，没建就插入。两种形态下 `display_name` 都确定为 `A` / `B`。

验证：两种 `auth.users` 形态下**各跑一遍，均 53 断言全过、0 错误、0 残留**
（`begin`/`rollback` 边界完好，`auth.users` 与 `profiles` 跑后均为 0 行）。

若不修就上 live，它会在 DB-3 验证的第一步炸掉，并且会**看起来像 schema 问题**。

---

## §6 DB-3 BACKUP / RECOVERY GATE

### 6.1 per-file 原子性（含 DDL）= PROVEN

合成实验：一个 migration 内 `create table` + `alter table add column`
+ `create index` + `raise exception` + 再 `create table`。

```
t2 存在        = false
t1.extra 存在  = false
t1_extra_idx   = false
ledger         = 仅 0001   （失败的 0002 未入账）
```

PostgreSQL 的 DDL 是事务性的，`db push` 的单文件事务边界因此对 DDL 同样成立。
0023–0026 各自是一个文件 → 各自 all-or-nothing。

### 6.2 `db3_rollback.sql` 精确性 = PASS

在 post-0026 的克隆库上执行：

```
public 表 54 → 26
migration schema  → 不存在
profiles.bio      → 不存在
A–F/H 八域指纹 vs post-0022 → 逐域全等 PASS
```

**但它不动 ledger** —— 回滚后 ledger 仍停在 `0026`。
完整回退必须再做 `supabase migration repair --status reverted 0026 0025 0024 0023`。
只做前一半会留下「ledger 声称已执行、schema 却是 0022 态」的骗人状态。
这一点必须写进执行 runbook，且该操作**需要单独授权**。

### 6.3 全量逻辑快照还原 = 语义精确

`pg_dump -Fc` 全库（322,481 bytes）→ 还原进裸库：
`pg_restore exit=0`，**0 个 ERROR**。

八域中七域逐字节相同；唯一不同的是 `A_column`，行数两侧同为 245。
定位结果：差异全部来自 `student_number_registry` 的 **`attnum` 位移** ——
0015 对该表 `drop` 了 2 列留下空洞，dump/restore 会压实编号。
**去掉 `attnum` 后两侧 md5 完全相同（`643e54f4…`）**，无任何对象或定义差异。

这正是 R2 报告中已记录、当时刻意不改的指纹脆弱点，现在得到了实测确认。
`program_catalog` 业务指纹还原后仍为 `cd41beee2463a78e68b8fc39c67f9c07`。

### 6.4 判定

```
A. DB-3 RECOVERY PROVEN SUFFICIENT WITHOUT HOSTED BACKUP
```

依据，逐条对应证据：

1. **爆炸半径小且完全枚举** —— 32 张新表、2 张既有表各加列、1 函数、9 enum、
   1 行元数据。无 drop、无类型变更、无业务数据。
2. **失败不会留下脏状态** —— per-file 事务边界对 DDL 实测成立。
3. **前向回滚已证** —— `db3_rollback.sql` 使 schema 逐域精确回到 post-0022。
4. **后向还原已证** —— 全量逻辑快照还原 0 错误、语义精确。
5. **可验证性** —— 每一级都有 PG 17.6 上实测的确定性指纹可比对。

边界（任一情形退回 **B**）：进入 DB-4 或任何业务数据迁移 ·
`0027` 权限变更 · 触及 `auth.users` · Production。
特别提醒：`db3_rollback.sql` 在 DB-4 之后会**连同业务数据一起删除**，
届时本判定立即失效。

---

## §7 本轮改动的文件

| 文件 | 性质 |
|---|---|
| `supabase/tests/db3_schema_contract.sql` | **修复** fixture 主键冲突（upsert），附机理注释 |
| `docs/operations/db3/pg176-db3-fingerprints.txt` | 新增，五级 PG 17.6 指纹 |
| `docs/operations/db3/pg176-post-0026-fingerprint.txt` | 新增，post-0026 完整行级基线 |
| 本报告 | 新增 |

`supabase/migrations/` 改动 **0** 个文件 —— `0023`–`0026` 未被触碰。

---

## §8 VERDICT

```
WRITER                     : STAGING-DB-WRITER-A
CREDENTIAL ISOLATION       : BLOCKED BY OWNER ROTATION
PG17.6 POST-0026 BASELINE  : PASS
EXPECTED PUBLIC RLS TABLES : 54
EXPECTED open_execute_funcs: 12   （post-0022 为 11，不得由 54 推导）
CLIENT DIRECT DB ACCESS    : NONE
DENY-ALL COMPATIBILITY     : PASS
CONTRACT FIXTURE DEFECT    : FOUND / REPRODUCED / FIXED / RE-VERIFIED
DB-3 RECOVERY              : A
LIVE MUTATION              : NONE
```

四道 Gate 中 §2 §3 §4 全部 PASS，**只剩 §1 凭据隔离**，且它只能由 Owner 完成。
轮换完成后本会话可立即进入执行，无需任何额外准备。

**WAIT FOR SUPERVISOR.**
