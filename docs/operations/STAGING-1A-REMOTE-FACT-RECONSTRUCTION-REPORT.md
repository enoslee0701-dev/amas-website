# STAGING-1A REMOTE FACT RECONSTRUCTION REPORT

**AMAS · STAGING-1A —— 远端事实重建**
日期：2026-09-08 · canonical：website `b0c1c31` · App `0af8cc6`

> ### ⚠ 本报告的多处结论已被 R2 实测更正（2026-09-08）
>
> Supervisor 已执行 P4 / P10 / P8，结果推翻本报告的四处表述。
> **原文保留**，更正如下，详见
> [`STAGING-1A-R2-CANONICAL-EQUIVALENCE-REPORT.md`](./STAGING-1A-R2-CANONICAL-EQUIVALENCE-REPORT.md) §1：
>
> | 本报告写的 | 实测更正 |
> |---|---|
> | §3.3「0012 确认 13 个 / 剩余 17 个未探测」 | **STALE** —— 实测 `0012 P4 OBJECT PRESENCE = 30/30`（但仍不等于 canonical equivalent） |
> | §2.3「0014/0017/0019/0021 疑似执行、版本未定」 | 已定版：**P10 全部 TRUE**，`0011–0021` 均为 final 版 |
> | §2.3 `my_action_items` 判别子串 `union all select` | **探针假阴性**（我的错）—— `pg_get_functiondef` 输出中被空白拆开；已改为 `has_active_role(p.id, 'student')` |
> | §5 人口足迹判据 | **P8 用了全局表计数（我的错）** —— `audit_logs` 497 行是全库共享，与该账号无关。按用户关联后：`audit_logs_as_actor = 1`（`user_registered`），其余全 0 |
> | 未覆盖 `0022` | 新增 **P11 数据态哨兵**：`0022 = NOT APPLIED`（0022 不创建对象，P4/P10 对它天然无效） |

> # 最终状态：`STAGING-1A NEEDS RECONCILIATION`
>
> **REMOTE MUTATION = NONE。** 本会话**未连接远端** ——
> 全部远端事实由 Supervisor 经 Owner 授权通道只读取得并回传，
> 本报告负责把它们与仓库 canonical 基准对拍、分类、定量。
>
> **未 repair ledger · 未 db push · 未 apply 任何 migration · 未 apply 0027 ·
> 未 DDL/DML · 未动用户 · DB-4 保持 PAUSED · 未开始 STAGING-1B。**

---

## 1. Corrected Full Object Matrix 0011–0026

### 1.1 探测包已按 §6 修正（v2）

| # | v1 的错误 | v2 的修正 |
|---|---|---|
| 1 | 用 `consume_rpc_context` 作 **0013** 哨兵 | 改为 canonical 的 **`application_protect_locked`** |
| 2 | 用 `history_guard` 作 **0014** 哨兵 | 0014 没有该对象；改为 **`append_only_guard` 的定义演进**（见 §2） |
| 3 | P4 只是 representative sample | **补成 FULL OBJECT MATRIX**（选项 A） |
| 4 | 解析误判：`create table ... migration.legacy_identity_crosswalk` 被截成表名 `migration` | 改为 `('0023','schema','migration')`，并在 CASE 中加 schema 分支 |

> **因此 v1 中 `consume_rpc_context=false` 与 `history_guard=false` 不计入 drift** ——
> 它们本就不是 canonical 期望对象，是我的哨兵选错了。

### 1.2 FULL OBJECT MATRIX 规模

从 `0011..0026` 静态提取，**149 条**（同名对象归属最早创建它的 migration）：

| kind | 条数 |
|---|---|
| index | 47 |
| table | 37 |
| function | 31 |
| type / enum | 17 |
| trigger | 8 |
| policy | 8 |
| schema | 1 |
| **合计** | **149** |

（以上取自 `staging_readonly_probe.sql` 的 P4 `VALUES` 块本身，非草稿估算。）

覆盖 `0011 · 0012 · 0013 · 0015 · 0016 · 0017 · 0018 · 0020 · 0021 · 0023 · 0024 · 0025 · 0026`。

> **`0014` / `0019` / `0022` 不在其中，因为它们不创建任何新对象** ——
> `0014` 与 `0019` 只做 `CREATE OR REPLACE`，`0022` 只做数据修正。
> **这正是 §2 定义级指纹必须存在的理由**：对这三个 migration，
> 「对象存在性」这个维度天然无法回答「它执行过没有」。

### 1.3 已由 Supervisor 只读确认的 PRESENT 对象

```
0011  review_application                                          PRESENT
0012  5 表 · 2 枚举 · 6 函数（activate_student / append_only_guard /
      create_student_record / normalize_student_number /
      student_guard / sync_alias_on_role_revoke）                 PRESENT
0013  application_protect_locked                                  PRESENT
0015  student_number_void_requests                                PRESENT
0016  course_catalog · course_category · course_availability      PRESENT
0018  irreversible_record_sources                                 PRESENT
0020  recovery_flows                                              PRESENT
0017 / 0019 / 0021 相关函数                                        PRESENT（版本未定，见 §2）
```

### 1.4 DB-3（0023–0026）确认**未**应用

```
app_* tables    = 0
app_* enums     = 0
app_* functions = 0
public.migration schema = ABSENT

0023 app_image_uploads      ABSENT
0024 app_course_progress    ABSENT
0024 app_christian_profile  ABSENT
0025 app_rooms              ABSENT
0026 app_posts              ABSENT
```

> **明确表述：`0023–0026` 未应用。** 不得写成「已应用」。

---

## 2. Definition-level Version Fingerprint

### 2.1 为什么必须做

**`0001–0026` 中有 31 个函数经历过 `CREATE OR REPLACE` 演进。**
对它们做存在性检查**完全无效** —— 同名函数在，不代表是哪一版。
这正是 `0014` / `0019` / `0021` 无法用「对象存在」判断的原因：它们**不创建新对象**。

### 2.2 已解决的一组：0003 加固（10 个函数）

`current_user_has_role` · `has_active_role` · `is_admin_any` · `is_assigned_mentor` ·
`is_assigned_teacher` · `is_enrolled_student` · `my_profile` · `my_roles` ·
`handle_user_email_confirmed` · `protect_profile_fields` · `set_updated_at`

它们 0002 版与 0003 版的差异**只在 `search_path`**（`public` → `''`），不在函数体内：

```
0002   security definer set search_path = public
0003   security definer set search_path = ''
```

Supervisor §2 已实测 `has_active_role` / `is_admin_any` 均为 `search_path = ""`，
§7 进一步报告**远端全部 SECURITY DEFINER 函数（49 个）均为 `search_path = ""`**。

> **判定：`0003 HARDENING SENTINEL = MATCH`。该组视为 canonical 一致，不构成 drift。**

### 2.3 ★ 核心未知量：final 版落在 ledger 之外的 15 个函数

下列函数的 **final canonical 版本在 `0011+`**，而 ledger 只到 `0010`。
它们**存在**已被确认，但**是哪一版仍然未知**。探测包 **P10** 用「final 版独有、早期版没有」的判别子串定版：

| final | 函数 | 判别子串（final 有 / 早期无） | 早期版本来自 |
|---|---|---|---|
| 0011 | `review_application` | `locked_fields` | 0008 → 0009 |
| 0013 | `application_protect_locked` | `set_config` | 0008 → 0009 |
| 0014 | `append_only_guard` | `append-only` | 0012 |
| 0015 | `correct_student_number` | `old_number_state` | 0012 |
| 0015 | `create_student_record` | `assigned` | 0012 |
| 0018 | `student_number_has_irreversible_records` | `irreversible_record_sources` | 0015 |
| 0019 | `my_action_items` | `union all select` | 0017 |
| 0019 | `my_learning` | `has_active_role` | 0017 |
| 0019 | `my_student_capabilities` | `has_active_role` | 0017 |
| 0019 | `my_student_profile` | `has_active_role` | 0017 |
| 0019 | `my_student_record` | `has_active_role` | 0012 |
| 0019 | `my_student_timeline` | `has_active_role` | 0012 |
| 0021 | `claim_recovery_flow` | `reap_stale_recovery_flows` | 0020 |
| 0021 | `my_recovery_flow` | `reap_reason` | 0020 |
| 0021 | `start_recovery_flow` | `reap_stale_recovery_flows` | 0020 |

另 5 个 final 版在 ledger 内（`0005` `0006` `0009`×2 `0010`），P10 一并验证以确认 ledger 可信。

> **这 15 行是 reconciliation 的核心。** 在拿到 P10 结果之前，
> 「0017 / 0019 / 0021 是否执行过」**没有答案** ——
> 只知道同名函数在，不知道是 0017 版还是 0019 版。

---

## 3. Exact Drift Classification

### 3.1 四象限

| ledger 登记 | 对象存在 | 分类 | 当前实例 |
|---|---|---|---|
| ✅ | ✅ | `MATCH` | `0001–0010` 全部对象 · 0003 加固组 |
| ✅ | ❌ | `SCHEMA_ONLY_DRIFT` | **目前无证据**（0003 哨兵 MATCH 已排除最可疑的一类） |
| ❌ | ✅ | **`LEDGER_ONLY_DRIFT`** | **0011 · 0012 · 0013 · 0015 · 0016 · 0018 · 0020**（已确认）；`0014 / 0017 / 0019 / 0021` 待 P10 定版 |
| ❌ | ❌ | `MISSING_REMOTE` | **`0023 · 0024 · 0025 · 0026`**（DB-3 全部） |

### 3.2 结论

```
OUT-OF-BAND EXECUTION IS BROAD
NOT LIMITED TO 0012
```

**至少 7 个 migration（0011 · 0012 · 0013 · 0015 · 0016 · 0018 · 0020）在 ledger 之外被执行过**，
另有 4 个（0014 · 0017 · 0019 · 0021）**疑似执行但版本未定**。

### 3.3 一条必须写下的警告

**不得把「某 migration 的部分对象存在」推广成「该 migration 已完整执行」。**

0012 创建 **5 表 · 2 枚举 · 11 函数 · 5 触发器 · 5 策略 · 2 索引 = 30 个对象**，
Supervisor 已确认其中 13 个 PRESENT。**剩余 17 个未逐一探测。**
「部分执行」与「完整执行」是两种状态，修复方案完全不同 ——
前者说明当年是手工挑着跑的，任何按整个 migration 为单位的 repair 都会写下一个假事实。
P4 的 FULL MATRIX 正是为逐项定量而存在。

---

## 4. Exact 0027 Privilege / Policy Impact

### 4.1 EXECUTE hardening 已 REMOTE VERIFIED（不再是静态推理）

0027 的 12 个目标函数**全部远端存在**。授权现状：

| 组 | 数量 | 远端 EXECUTE 授权 |
|---|---|---|
| 需收口 | **11** | `PUBLIC` + `anon` + `authenticated` + `service_role` |
| 已收口 | **1**（`has_active_role`） | 仅 `authenticated` + `service_role`（**无** `PUBLIC` / `anon`） |

> 这证实了 0027 的根因推理：`0003_hardening.sql` 的
> `revoke execute on all functions in schema public` 只作用于执行那一刻已存在的函数，
> 之后新建的函数回到 PostgreSQL 默认的 `PUBLIC EXECUTE`。
> **现在这是 REMOTE VERIFIED 事实，不是推断。**

### 4.2 ★ `is_admin_any` 的实际影响面：**17，不是 13**

```
REMOTE ACTUAL RLS IMPACT = 17
PATCH COMMENT 13         = STALE
```

远端实测有 **17 条** RLS 策略引用 `is_admin_any`，且 **17/17 的调用形态均为
`is_admin_any(auth.uid())`**。

### 4.3 归属门禁的影响评估

远端 `is_admin_any` 当前：

```
SECURITY DEFINER = true
search_path      = ""
逻辑             无 p_user = auth.uid() 归属门禁
                 → 可按任意 p_user 查询三种 admin role
```

0027 提议加入归属门禁（只答「我自己」，问别人一律 false）。

**影响评估**：由于 17/17 的实际调用形态都是 `is_admin_any(auth.uid())`，
即传入的恒为调用者自身，**加门禁不会改变这 17 条策略的语义**。
换言之：**从现有 RLS call shape 看，proposed self-ownership gate 保持现有 policy 语义。**

真正被关闭的是**策略之外的直接调用面** —— 任何已登录用户当前可以拿它当
「枚举管理员的布尔预言机」。这是信息泄漏，不是提权。

### 4.4 但仍然：`0027 STILL PROPOSED — DO NOT APPLY`

三条独立理由，缺一不可：

1. **reconciliation 尚未完成** —— §2.3 的 15 个函数版本未定，§3.3 的 0012 完整度未定；
2. **backup / recovery gate 未通过** —— 见 §6；
3. **未获得 mutation authorization**。

### 4.5 patch 注释的 STALE 记录（本轮不修改 patch）

`docs/operations/patches/0027_function_execute_hardening.sql` 的注释写「13 处 RLS 策略引用」，
**实际为 17**。

**本轮不修改该 patch 文件** —— 它在 App repo，而 App 工作区当前有另一会话未提交的
`.gitignore` 改动，为改注释跨越 D-38 不划算。
**先在此处记录 `REMOTE ACTUAL RLS IMPACT = 17` / `PATCH COMMENT 13 = STALE`**，
待 App canonical write authority 明确后再更新 patch。

---

## 5. Unresolved Population Classification

```
auth.users   1
profiles     1
user_roles   1        role = applicant

账号结构     confirmed = 1
             signed_in = 0
```

### 判定

```
POTENTIAL REAL DATA
CLASSIFICATION UNRESOLVED
```

**不得仅据 `signed_in = 0` 判为 fixture。** 一个真人完成邮箱确认后从未登录，
与一个测试装置被创建后从未使用，在这两个字段上**完全同形**。

### 待补的判别证据（探测包 P8 已加入，只计数不取 PII）

```
applications · student_records · submissions
audit_logs · security_events · recovery_flows
```

- **全为 0** → 该账号从未产生任何业务足迹，倾向 fixture（仍需 Owner 确认）
- **任一非 0** → 有真实活动痕迹，**按真人处理**

在分类落定之前：**不创建、不修改、不映射、不迁移该账号。**
它同时也是 DB-4 的输入之一，而 **DB-4 保持 PAUSED**。

---

## 6. Backup / Recovery Evidence Gap

远端只读探测结果：

```
wal_level    = logical
archive_mode = on
pg_cron      = absent
```

### 判定

```
BACKUP / RECOVERY = INCOMPLETE
NO MUTATION AUTHORIZED
```

**`wal_level=logical` 与 `archive_mode=on` 只说明平台具备做备份的技术前提，
不等于 hosted backup / restore 证据。** 三个真正要回答的问题一个都没答：

| 问题 | 状态 |
|---|---|
| 该项目档位是否提供托管备份？ | **未知** |
| 保留期多久？ | **未知** |
| **恢复要多久、怎么恢复？** | **未知** ← 出事时决定停机时长，比「有没有备份」更关键 |

这三项在数据库内部查不到，必须从 Supabase 控制台 / Management API 侧确认。

> 已有可复用资产：`db3_rollback.sql` / `db6_rollback.sql` 已在本地 PG 17.6 实测逐列零残留。
> **但那是我们自己的脚本，不是托管侧的 backup/restore。** 不得混为一谈。

---

## 7. Reconciliation Plan（PLAN ONLY —— 本轮不执行任何一步）

### 阶段 R0 —— 补齐事实（纯只读，无 mutation）

1. 执行 `supabase/tests/staging_readonly_probe.sql` v2（写操作语句数 = 0，已机械复核）
2. 产出三份结果：**P4 FULL MATRIX（149 行）** · **P10 版本指纹（20 行）** · **P8 业务足迹**
3. 据此完成：0012 完整度定量 · 0014/0017/0019/0021 定版 · 人口分类

**R0 未完成前，后续阶段一律不得启动。**

### 阶段 R1 —— 备份能力证明（仍无 mutation）

在控制台 / Management API 侧确认 §6 的三个问题，并**演练一次恢复**。
「Supabase 大概会备份」不构成证据。**R1 未通过 → `NO MUTATION AUTHORIZED` 维持。**

### 阶段 R2 —— 逐对象定义比对（仍无 mutation）

对 P10 中 `has_final_version = false` 的每一个函数，
以及 P4 中 `present = true` 但属于「部分执行」migration 的每一个对象，
做 **canonical 定义 vs 远端定义**的逐项比对，分类为
`EQUIVALENT` / `OLDER` / `NEWER` / `CONFLICTING`。

### 阶段 R3 —— reconciliation 方案（仍不执行）

只有在 R0–R2 全部完成后，才能在下列四者中选择：

```
A. REMOTE ALREADY EQUIVALENT TO 0026     —— 已排除（0023–0026 确认 ABSENT）
B. SAFE FORWARD MIGRATION REQUIRED
C. LEDGER REPAIR REQUIRED
D. MANUAL SCHEMA RECONCILIATION REQUIRED
```

**当前证据只够排除 A，不足以在 B/C/D 中选择。**

### 贯穿全程的硬前提

```
remote actual object definition  ==  canonical intended object definition
```

**仅凭「对象名存在」绝对不能 repair ledger。** 这一条在 R2 完成前不可能被满足，
因此 **`LEDGER REPAIR` 在当前阶段不可能被授权**。

---

## 8. DB Push Safety Verdict

> # `DB_PUSH_REQUIRES_SCHEMA_RECONCILIATION`
>
> （较上一轮的 `DB_PUSH_REQUIRES_LEDGER_RECONCILIATION` **升级**）

**升级理由**：上一轮只知道 0012 有带外对象，问题看起来像「ledger 少记了」。
本轮证据显示 **out-of-band execution is broad**（至少 7 个 migration），
且 **15 个函数的实际版本未知**。

`db push` 会尝试应用 `0011`–`0026`。其中 `0011 · 0012 · 0013 · 0015 · 0016 · 0018 · 0020`
的对象**已经存在**，`create table` / `create type` 会直接失败；
即使加 `if not exists`，`CREATE OR REPLACE FUNCTION` 也会**静默覆盖**远端当前版本 ——
而我们**还不知道远端那一版是什么**。

**这已经不是 ledger 记账问题，而是 schema 实体状态问题。**

---

## 9. Stop Conditions Triggered

| 条件 | 是否触发 |
|---|---|
| 发现无法解释的真人数据 → mutation 前停止 | ⚠ **部分触发** —— 人口分类 `UNRESOLVED`，按最坏假设（真人）处理 |
| 备份能力无法证明 → `NO MUTATION AUTHORIZED` | ✅ **触发**（§6） |
| ledger 与实际 schema 不一致 → 不得 repair | ✅ **触发**（§3） |
| 项目身份不符 → STOP | ❌ 未触发（`amas-staging` 一致） |

---

## 10. Remaining Blockers

| # | 阻塞项 | 解除条件 |
|---|---|---|
| 1 | **15 个函数版本未定** | 执行 P10 |
| 2 | **0012 等 migration 的完整度未定量** | 执行 P4 FULL MATRIX |
| 3 | **人口分类未决**（`POTENTIAL REAL DATA`） | 执行 P8 业务足迹 + Owner 确认 |
| 4 | **备份/恢复能力未证明** | 控制台侧确认 + 恢复演练 |
| 5 | 0027 patch 注释 `13` 已 STALE（实际 17） | 待 App canonical write authority 明确 |
| 6 | `OPEN_ISSUES #22` IPv6 限流 | 公开 staging 暴露前必须 CLOSED |

---

## 11. Documentation Updates

- **新增** 本报告
- **更新** `supabase/tests/staging_readonly_probe.sql` → **v2**
  （修正 0013/0014 哨兵 · 补 FULL MATRIX 149 条 · 新增 P10 版本指纹 · 修正 migration schema 解析误判）
- **更新** `docs/operations/STAGING-1A-CANONICAL-EXPECTED-STATE.md`（§4 指向 FULL MATRIX）
- **未修改** `0027` patch（跨仓 D-38 约束，见 §4.5）
- **未修改** `.gitignore`（App 工作区有另一会话未提交改动）

---

## 12. Stop Conditions 遵守确认

| 禁令 | 遵守 |
|---|---|
| ledger repair | ✅ 未做 |
| db push | ✅ 未做 |
| apply migration | ✅ 未做 |
| apply 0027 | ✅ 未做 |
| DDL / DML | ✅ 未做 |
| user mutation | ✅ 未做 |
| DB-4 | ✅ 保持 PAUSED |
| STAGING-1B | ✅ 未开始 |
| Production | ✅ 未触碰 |
| 连接远端 | ✅ **本会话未连接** —— 远端事实全部来自 Supervisor 回传 |

---

## 最终状态

> # `STAGING-1A NEEDS RECONCILIATION`
>
> `REMOTE MUTATION = NONE` · `DB_PUSH_REQUIRES_SCHEMA_RECONCILIATION` ·
> `BACKUP / RECOVERY = INCOMPLETE` · `NO MUTATION AUTHORIZED` ·
> 人口 `CLASSIFICATION UNRESOLVED` · `0027 PROPOSED — DO NOT APPLY`
>
> **未写 READY FOR STAGING-1B。等待 Supervisor 裁定。**
