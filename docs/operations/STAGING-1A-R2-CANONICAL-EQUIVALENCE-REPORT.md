# STAGING-1A · R2 CANONICAL EQUIVALENCE PLAN / REPORT

**AMAS · STAGING-1A R2 —— canonical 定义等价审计**
日期：2026-09-08 · canonical：website `630a8d3`

> # 阶段状态：`STAGING-1A NEEDS RECONCILIATION`
>
> **REMOTE MUTATION = NONE。** 本会话未连接远端。
> 本轮完成的是 **R2 的 canonical 侧**：建立可确定性复现的基准指纹与提取工具，
> 并修复 R0 阶段三处探针缺陷。**远端指纹待 Supervisor 经授权通道执行后回传。**

---

## 1. R0 更正（四项）

### 1.1 P4 实际结果 —— 我的报告已 STALE

| migration | expected | present | absent |
|---|---|---|---|
| 0011 | 1 | **1** | 0 |
| 0012 | 30 | **30** | 0 |
| 0013 | 1 | **1** | 0 |
| 0015 | 13 | **13** | 0 |
| 0016 | 7 | **7** | 0 |
| 0017 | 5 | **5** | 0 |
| 0018 | 2 | **2** | 0 |
| 0020 | 11 | **11** | 0 |
| 0021 | 1 | **1** | 0 |
| 0023 | 17 | 0 | **17** |
| 0024 | 7 | 0 | **7** |
| 0025 | 29 | 0 | **29** |
| 0026 | 25 | 0 | **25** |

> 我在 `630a8d3` 写的「0012 确认 13 个 / 剩余 17 个未探测」**已作废** ——
> 实测 **0012 P4 OBJECT PRESENCE = 30 / 30**。
>
> **但绝不能就此写成「0012 fully canonical equivalent」。**
> presence 只证明**对象名在**，不证明列 / 约束 / 索引定义 / 触发器定义 /
> 策略表达式 / 函数定义 / 授权与 canonical 一致。**那正是 R2 的职责。**

### 1.2 P10 `my_action_items` 是**探针假阴性**（我的错）

原判别子串 `'union all select'` 在 `pg_get_functiondef()` 的输出里被换行与空白拆开，
`position()` 找不到 → 报 `FALSE`。**远端其实是 0019 版。**

Supervisor 独立读取远端定义，确认 0019 特有的角色门禁存在：

```sql
case when public.has_active_role(p.id, 'student') then s.id end
```

且远端 `student_self_select` / `ssh_select` 策略含 `current_user_has_role('student')`，
与 0019 行为一致。

```
my_action_items_0019_gate  = TRUE
0019 FINAL ROLE-GATING EVIDENCE = MATCH
```

**已修**：判别子串改为 `has_active_role(p.id, 'student')` —— 它在
`pg_get_functiondef` 输出中是连续的一段，不会被空白拆开。

**并已加固 P10**：原本按 `proname` + `LIMIT 1` 取函数，一旦将来出现重载会**静默取错**。
现改为聚合并显式输出 `overload_count` 与 `signatures`；
`overload_count > 1` 时该行结论不可信，须人工定签名。

### 1.3 P8 全局计数 bug（我的错）

v2 的「业务足迹」用的是**全局表计数**。`audit_logs` / `security_events` 是全库共享表
（实测 497 / 4 行），把它们当作「该账号的足迹」是错的。

Supervisor 的按用户关联计数：

```
applications_for_user      0
student_records_for_user   0
recovery_flows_for_user    0
security_events_for_user   0
audit_logs_as_actor        1     ← event_type=user_registered · category=identity
```

**已修**：P8 改为 `join auth.users` 关联计数，并单列该账号的 audit 事件类型/分类，
全局总量单独标注 `GLOBAL_ONLY_do_not_use_for_classification`。不输出任何 UUID / email / name。

### 1.4 0022 = `NOT APPLIED`（新增 P11）

`0022_program_offering_scope.sql` **不创建任何对象**，只做 UPDATE ——
P4 的对象矩阵与 P10 的函数指纹对它**都天然无效**。

Supervisor 数据态实测：开放列表仍含全部 9 个项目 · `five_closed = 0` · `dmin_renamed = 0`。

**已新增 P11 数据态哨兵**，并做了**双向验证**（哨兵必须能区分两种状态才有判别力）：

| 参照库 | P11 判定 |
|---|---|
| `amas_r2_canonical`（0001–0021） | `0022_NOT_APPLIED` ✅ |
| `amas_r2_with0022`（同库 + 单独应用 0022） | `0022_APPLIED` ✅ |

---

## 2. 准确的远端世系解读

```
ledger        0001–0010 only
0011–0021     APPLIED OUT-OF-BAND（presence 30/30 等 + 演进函数 final 版命中）
0022          NOT APPLIED（数据态哨兵实测）
0023–0026     NOT APPLIED（78 个对象全部 ABSENT）
```

> **不写 `0011–0021 FULLY CANONICAL EQUIVALENT`。**
> 现有证据是「对象齐全 + 演进函数是 final 版」，
> 尚未证明每一个列 / 约束 / FK / 默认值 / 索引定义 / 触发器定义 /
> 策略表达式 / 函数定义 / GRANT-REVOKE 都与 canonical 相同。
> **这正是 R2 的目的。**

---

## 3. ★ 三处「看似 drift、实为口径错误」的发现

本轮建 canonical 参照库时，与 Supervisor §7 的远端计数对照，出现三处显著差异。
**逐一查证后，三处全部是查询口径问题，不是 drift。**
如果按原样报成 drift，会把整个 reconciliation 带向错误方向。

| 项 | 我最初的 canonical 计数 | 远端报告 | 查证结论 |
|---|---|---|---|
| public 函数 | 95 | 59 | **本地垫片把 `pgcrypto` 装进 `public`（36 个函数）**，Supabase 装在 `extensions` schema。剔除扩展自带对象后**两侧都是 59** ✅ |
| 触发器 | 21（全库） | 26 | 远端计数含 Supabase 原生 `auth` schema 的触发器，本地垫片没有。**仅 `public` 时本地为 18** |
| 外键 | 38（全库） | 61 | 同理，远端含 `auth` / `storage` 等 schema。**仅 `public` 时两侧都是 38** ✅ |

**因此 R2 指纹的取数口径被硬性固定为**：

```
只取 public schema
剔除扩展自带对象（pg_depend deptype = 'e'）
定义一律取 pg_get_*def 的规范化输出，不取源文件文本
```

---

## 4. R2 工具：确定性 canonical-vs-remote 指纹

### 4.1 交付物

| 文件 | 用途 |
|---|---|
| `supabase/tests/r2_schema_fingerprint.sql` | **两侧共用同一份**。全文件只有 SELECT。输出 `domain\|key\|fingerprint`，全局有序，可直接 `diff` |
| `docs/operations/r2/canonical-0021-fingerprint.txt` | canonical 侧基线（本地 PG **17.6** 应用 `0001..0021` 后提取，**609 行**） |

### 4.2 覆盖的七个域（对应要求 A–G）

| 域 | 内容 | canonical 行数 |
|---|---|---|
| **A** columns | 序号 · 类型 · 可空性 · 默认值 · generated | 245 |
| **B** constraints | PK · UNIQUE · **FK 含 ON DELETE/UPDATE** · CHECK（`pg_get_constraintdef`） | 72 |
| **C** indexes | 精确定义 · 谓词 · 唯一性（`pg_get_indexdef`） | 59 |
| **D** triggers | 时机 · 事件 · 表 · 函数（`pg_get_triggerdef`） | 18 |
| **E** policies | 命令 · permissive · 角色 · USING · WITH CHECK | 33 |
| **E** rls_enabled | 表级 RLS 开关（policy 为 0 时尤其重要） | 26 |
| **F** functions | **精确签名** · 语言 · volatility · SECDEF · strict · search_path · **定义 md5** | 59 |
| **G** grants | 表级 + 函数 EXECUTE（PUBLIC / anon / authenticated / service_role） | 63 |
| **G2** 绝对属性 | 见 §4.4 | 11 |
| **H** enums | 值域**与顺序** | 15 |
| | **合计** | **609** |

### 4.3 确定性已自证

同一库连续跑两次，输出**逐字节一致** —— 指纹可用于 `diff`，不会产生噪声差异。

### 4.4 ★ G 域不能做裸 diff（否则必然大量假阳性）

Supabase 对 `public` 的新表**默认授予** `anon` / `authenticated`；本地垫片没有这层默认。
迁移里的 `revoke ... from anon, authenticated` 在两侧作用于**不同基线**，
最终 ACL 必然不同 —— **这是平台差异，不是 canonical drift**。
实测 canonical 侧 `G_table_grant` 仅 1 行、7 张表 `relacl` 为 NULL（owner-only）。

因此增设 **G2 绝对属性断言**：不做 diff，两侧各自判真伪即可。

```
G2_writable_by_anon             canonical: 0 行  ← 没有任何表对 anon 开放写
G2_writable_by_authenticated    canonical: 0 行  ← 同上
G2_func_exec_open               canonical: 11 行 ← 仍对 PUBLIC/anon 开放 EXECUTE
```

### 4.5 ★ 一项强正面证据：11 个开放函数完全吻合

canonical 侧 `G2_func_exec_open` 实测 **11 个**：

```
append_only_guard · application_protect_locked · application_strip_forbidden
application_validate_form · application_validate_program · application_validate_transition
course_catalog_guard · normalize_student_number · student_guard
sync_alias_on_role_revoke · tvr_validate_transition
```

与 0027 的 12 个目标相比，**恰好少一个 `has_active_role`**（它已收口）——
**与 Supervisor 远端实测的「11 个仍开放 / `has_active_role` 已收口」完全一致。**

两层意义：

1. **该授权缺口是 canonical 迁移本身固有的**，不是 staging 特有事故 ——
   本地从零应用 `0001..0021` 同样复现出这 11 个；
2. 这是远端与 canonical 在**授权维度等价**的一项正面证据（G 域首个 MATCH）。

---

## 5. R2 执行计划（PLAN —— 远端侧待 Supervisor 执行）

### 步骤

1. **Supervisor** 经授权通道执行 `supabase/tests/r2_schema_fingerprint.sql`
   （只读，写操作语句数 = 0），输出保存为 `remote.txt`；
2. 与 `docs/operations/r2/canonical-0021-fingerprint.txt` 做 `diff`；
3. 逐行归类：

| 结果 | 含义 |
|---|---|
| 两侧同行 | `MATCH` |
| key 相同、fingerprint 不同 | **`REMOTE_DIFFERENT`** |
| 仅 canonical 有 | **`REMOTE_MISSING`** |
| 仅 remote 有 | **`REMOTE_EXTRA`** |
| G 域 / 已知平台差异 | `UNRESOLVED`（须人工判读，不得计入 drift） |

### 已知的、必须排除在 drift 之外的合法差异

| 差异来源 | 为什么合法 |
|---|---|
| `G_table_grant` 行数与内容 | §4.4 —— Supabase 默认授权基线不同 |
| 远端多出 `auth` / `storage` 等 schema 的对象 | 指纹已限定 `public`，不应出现；若出现说明过滤失效 |
| 扩展自带对象 | 指纹已按 `pg_depend deptype='e'` 剔除 |
| `0022` 相关的**数据**差异 | 0022 未应用，属已知状态，不是 schema drift |

### R2 的判定门槛

**只有当 A–F + H 六个域全部 `MATCH`（G 域按 G2 绝对属性判定通过）时**，
才可以说 remote `0011–0021` 与 canonical 等价。

任何一处 **material definition mismatch** →

```
MANUAL SCHEMA RECONCILIATION REQUIRED
```

**不得 ledger-repair 覆盖它。**

---

## 6. Reconciliation 决策规则（不变，重申）

只有在 R2 证明

```
remote actual 0011–0021  ==  canonical intended 0011–0021
```

之后，才可以**提议**：

```
CONTROLLED LEDGER REPAIR FOR 0011–0021
```

**即便如此，仍为 PLAN ONLY。** mutation 之前必须先有：

```
BACKUP / RECOVERY gate 通过
Supervisor 批准
canonical writer ownership 明确
rollback plan
```

---

## 7. 本地 PG 17.6 的最小修复（按既定规则报告）

Supervisor 此前指示：仅当 schema comparison 确实需要本地 PG 17.6 且无法复用既有基准时，
才单独报告原因与最小修复方案。**本轮触发该条件。**

**为什么必需**：`pg_get_indexdef` / `pg_get_constraintdef` / `pg_get_expr(polqual)` /
`pg_get_functiondef` 输出的是 PostgreSQL **规范化**后的文本，
与迁移源文件的写法不同。拿远端规范化输出去比对源文件文本，会产生大量假差异。
唯一严谨的做法是：**把 canonical 迁移应用到同版本的本地 PG，用同一组查询提取，再 diff。**

**上次 exit 4 的真实原因**：日志显示实例一直正常运行到 `2026-09-07 20:56`，
之后是会话结束时后台任务被拆除，留下 stale `postmaster.pid`。**不是 PG 故障。**

**最小修复**：直接 `pg_ctl start`（无需重建 data 目录、无需重新 initdb）。
已恢复，`select version()` 确认 `PostgreSQL 17.6`。

---

## 8. 其余项状态（不变）

| 项 | 状态 |
|---|---|
| 人口分类 | `POTENTIAL REAL DATA` / `NO BUSINESS FOOTPRINT BEYOND REGISTRATION` / **`CLASSIFICATION UNRESOLVED`** —— 可能是 fixture，但**未被证明** |
| backup / recovery | `INCOMPLETE` · `NO MUTATION AUTHORIZED` |
| `0027` | `PROPOSED — DO NOT APPLY`；`REMOTE ACTUAL RLS IMPACT = 17`，patch 注释 `13` 为 `STALE`（跨仓 D-38，本轮不改 patch） |
| DB push | `DB_PUSH_REQUIRES_SCHEMA_RECONCILIATION` |
| `OPEN_ISSUES #22` IPv6 限流 | `P2 SECURITY HARDENING` · 阻塞公开 staging 暴露 |

---

## 9. 停止条件遵守

| 禁令 | 遵守 |
|---|---|
| ledger repair · db push · migration apply · 0027 apply | ✅ 未做 |
| DDL / DML / user mutation | ✅ 未做（本地参照库的建库属本机行为，与远端无关） |
| DB-4 · STAGING-1B · Production | ✅ 未触碰 |
| 连接远端 | ✅ **本会话未连接** |
| **REMOTE MUTATION = NONE** | ✅ **成立** |

---

## 最终状态

> # `STAGING-1A NEEDS RECONCILIATION`
>
> R0 三处探针缺陷已修（P10 假阴性 · P8 全局计数 · 0022 无哨兵）；
> R2 canonical 侧基线已建成并自证确定性（609 行，两次输出逐字节一致）；
> 已发现并排除三处会污染比对的口径错误；
> 已取得一项授权维度的正面等价证据（11 个开放函数完全吻合）。
>
> **远端指纹待 Supervisor 执行后回传。等待裁定，未开始 STAGING-1B。**
