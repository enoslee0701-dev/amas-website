# R2 FINAL CORRECTION + R1 BACKUP/RECOVERY PREFLIGHT

日期：2026-09-09 · **REMOTE MUTATION = NONE**（本会话未连接远端）

---

# A. R2 FINAL CORRECTION

## A.1 两个序列化缺陷已修（`r2_schema_fingerprint.sql` v2）

### E —— 一个数据库逻辑行必须等于一个物理输出行

v1 把含 embedded newline 的表达式原样输出，逐行 digest 工具按物理行切分，
只对第一段算了哈希 → 4 条 policy 报出**假差异**。

**修正**：所有可能含 CR/LF 的字段一律先编码为字面 `\r` / `\n` 再输出 ——
不只 `E_policy`，还包括 `A_column` 默认值、`B_constraint` CHECK 表达式、
`C_index` 谓词、`D_trigger` 定义、`G3` 策略表达式。

**验证**：v2 输出 608 个物理行，**不以 `domain|` 开头的残行 = 0**；
原先出问题的 4 条 policy 现在各占**恰好 1 个物理行**且换行已转义。

### F —— 不得用 line-ending 敏感的 `md5(pg_get_functiondef())` 作语义判据

canonical 本地库的 0008 系函数 `prosrc` 是 CRLF、remote 是 LF → 4 个函数假差异。

**修正**：改为由**语义分量**组装指纹，并把 `prosrc` 归一为 LF：

```
srcmd5 = md5( replace(replace(prosrc, CRLF, LF), CR, LF) )
```

指纹字段：`lang · vol · secdef · strict · cfg · ret · srcmd5`（+ 精确签名作 key）。
**不再依赖 `pg_get_functiondef` 的原始字节。**

### v2 canonical digest（序列化修正后，与 v1 不可混用）

| domain | rows | v2 md5 |
|---|---|---|
| `A_column` | 245 | `e910a2bb9c9aa67d6550509e719dd6bf`（与 v1 相同） |
| `B_constraint` | 72 | `9e38564adeb9358da98d2e7ae325c79f`（同） |
| `C_index` | 59 | `955c56a27c339f1f5cce1697bc6e5ede`（同） |
| `D_trigger` | 18 | `d9b321ec390108ac712db55f02fa781f`（同） |
| **`E_policy`** | 33 | **`d06a9b7f90dd2697420ed043350a5d5f`**（新，换行已转义） |
| `E_rls_enabled` | 26 | `6461fb5e99bd036f95525635b1fadbdc`（同） |
| **`F_function`** | 59 | **`6fe5410b84f57ca13c55cfc65f66601b`**（新，语义分量指纹） |
| `H_enum` | 15 | `22575b34ed9950448fc8157070cdeee8`（同） |

基线：`docs/operations/r2/canonical-0021-fingerprint-v2.txt`

## A.2 R2 最终结论（记录 Supervisor 裁定）

```
A_column       MATCH
B_constraint   MATCH
C_index        MATCH
D_trigger      MATCH
E_policy       SEMANTIC MATCH   （序列化 artifact，4/4 逐条证实）
E_rls_enabled  MATCH
F_function     SEMANTIC MATCH   （line-ending artifact，4/4 defmd5 精确吻合）
H_enum         MATCH

8 / 8 SEMANTIC EXACT MATCH
```

> **REMOTE 0011–0021 CANONICAL EQUIVALENCE VERIFIED FOR AUDITED A–F/H DOMAINS**

## A.3 G / G2 / G3 已按更正落地

| 项 | 状态 |
|---|---|
| `G` raw ACL | `PLATFORM-BASELINE-SENSITIVE` · **DO NOT RAW-DIFF**（已写入工具注释） |
| `G2` | 更名为 **`G2_PRIVILEGE_SURFACE`** —— 只报告 surface，**不再宣称必须为空** |
| `G2_func_exec_open` | canonical 11 个，与远端集合一致（正面等价证据） |
| **`G3_EFFECTIVE_WRITE_POLICY_SURFACE`** | 新增：表 + RLS 开关 + 写类策略（cmd / roles / USING / WITH CHECK）并列 |
| **`G3_VIOLATION_write_acl_without_rls`** | 新增**不变式**：有写 ACL 却未启用 RLS 的表。canonical 侧实测 **0 行 ✔**。远端已由 Supervisor 确认 20/20 write-ACL 表均启用 RLS |
| `TRUNCATE` | `PRIVILEGE HARDENING REVIEW REQUIRED` —— 本轮不 revoke |
| `0027` | `PROPOSED` · `DO NOT APPLY` |

## A.4 ★ 本轮新发现的一个指纹脆弱点（建议后续加固，本轮未改）

R1 恢复演练时（§B.1）发现：`A_column` 的 `attnum` **不是语义属性** ——
它反映 `ALTER TABLE DROP COLUMN` 的物理历史。

实证：`0015_student_number_states.sql:70-71` 对 `student_number_registry`
`drop column released_at` / `release_reason`，在源库留下 2 个空洞
（`attisdropped = 2`）；`pg_dump` / `restore` 重建该表时 attnum **压实**
（`attisdropped = 0`），9 列序号整体前移 2 → `A_column` 报出 18 行差异。

**去掉 attnum 后两侧 md5 完全一致**（`5ee1ef17c0ec31a3…`）。

> **本轮不改 A_column 定义** —— 它在当前定义下已与远端 MATCH，
> 改了会使已达成的比对失效。但必须记录：**若任何一侧将来经 dump/restore 重建，
> 现有 A_column 指纹会报假差异。** 建议后续版本改用
> 「非 dropped 列中的序位」而非裸 `attnum`。

---

# B. R1 BACKUP / RECOVERY PREFLIGHT

## B.1 可在本地证明的（已实测）

| # | 证据 | 结果 |
|---|---|---|
| 1 | 逻辑备份工具版本与目标一致 | `pg_dump` / `pg_restore` / `psql` 均为 **17.6** |
| 2 | `pg_dump --schema-only` 可对 17.6 产出备份 | exit 0 · 148,835 bytes · 0 错误 |
| 3 | **恢复演练**：dump → 裸库 restore | exit 0 · **225 ms** · **0 ERROR** |
| 4 | **恢复保真度**：对恢复库取指纹与源库逐域比对 | B / C / D / E_policy / E_rls / F / H **七域 MATCH**；`A_column` 唯一差异是 attnum（§A.4），去 attnum 后完全一致 → **语义 8/8 保真** |

> 第一次演练出现 6 个错误，全部是**我的演练程序问题**（先灌了 shim，dump 里又含同样的
> `auth` 对象导致重复创建）。改为恢复进裸库后 0 错误。如实记录，不掩盖。

**因此可以确证**：逻辑备份 + 恢复这条路径**在 17.6 上是通的、且语义保真**。

## B.2 ★ 本地**无法**证明的（必须 Owner / Supabase 控制台取证）

`wal_level = logical` 与 `archive_mode = on` **只说明平台具备做备份的技术前提**，
**不满足本闸门**。下面六项一项都答不了：

| 要求 | 本地可证？ | 为什么不行 |
|---|---|---|
| **A. hosted backup availability** | ❌ | 是否提供托管备份取决于**项目档位**，数据库内部查不到 |
| **B. backup status** | ❌ | 最近一次备份成功与否是平台侧状态 |
| **C. retention period** | ❌ | 保留期是计费档位属性 |
| **D. restore mechanism** | ❌ | 托管恢复是控制台 / API 操作，非 `pg_restore` |
| **E. expected restore path / procedure** | ❌ | 需平台文档与档位确认 |
| **F. ability to recover immediately before ledger mutation** | ❌ | 需确认能否**按需**创建恢复点 |

> **不猜档位能力。** 我不知道该项目是 Free 还是付费档，两者的备份能力差别很大。

## B.3 Owner 取证：最短 UI 路径

请在 Supabase 控制台按下列路径查看，并把**结论**告诉我（不要贴任何凭据）：

**① 档位与备份能力**

```
控制台 → 选中 amas-staging
  → 左下角 Project Settings（齿轮）
  → General
     记下 Plan（Free / Pro / …）
```

**② 托管备份是否存在、保留期、最近一次成功时间**

```
控制台 → 左侧 Database
  → Backups
     记下：是否有备份列表 · 最近一次时间 · 保留天数
     以及是否提供 Point-in-Time Recovery（PITR）
```

**③ 恢复方式与预计耗时**

```
同一 Backups 页面
  → 查看恢复入口的措辞（Restore / Download）
     记下：是原地恢复还是恢复到新项目 · 是否给出预计耗时
```

**④ 能否在变更前按需建一个恢复点**

```
若 Backups 页面提供手动 / 按需备份按钮 → 记下它的名称
若没有 → 记为「无按需恢复点，只能依赖计划备份」
```

> **本轮不代为执行任何备份或恢复操作。** 只需要上述四项的**事实**。

## B.4 一条 fallback（若托管备份不可用）

即便托管备份档位不支持，仍有一条**已在本地验证可行**的路径：

```
ledger mutation 之前，用 pg_dump 取一份 schema-only 逻辑备份并离线保存
```

依据：§B.1 第 2–4 项已证明该路径在 17.6 上 exit 0、0 错误、语义 8/8 保真。

**但必须讲清它的边界**：它只覆盖 schema，**不覆盖数据**；
且执行它需要数据库直连（当前 `DATABASE_URL` 未配置）。
**它不能替代 A–F 六项证据**，只能作为托管备份之外的额外保险。

## B.5 R1 当前判定

```
BACKUP / RECOVERY = INCOMPLETE
NO MUTATION AUTHORIZED
```

本地路径已证；托管侧 A–F 六项**全部待 Owner 取证**。

---

# C. `3021f6d` D-38 PROVENANCE RESULT（只读审计）

## C.1 结论

```
PROVENANCE = 本仓库自身的 pre-commit hook 自动生成
NOT another session · NOT pre-existing in worktree
supabase/migrations 改动文件数 = 0  ->  R2 数据库结论不受影响
```

## C.2 证据链

**① 机制**：`git config core.hooksPath = .githooks`，`.githooks/pre-commit` 会运行
`scripts/bump.py`，对**硬编码的 13 个 HTML 文件**把
`href|src="assets/(css|js)/…"` 的 `?v=` 戳成 `time.strftime("%Y%m%d%H%M")`，
再把改动过的文件名交给 `git add` **自动暂存**。

**② 时间戳吻合**：`3021f6d` 提交时刻 `202609090957`，
HTML 中新戳恰为 `?v=202609090957` —— **提交那一刻生成，不是预先存在于工作区**。

**③ 系统性**：我在本仓的每一次提交都带同样 11 个 HTML 改动 ——
`3021f6d` / `5a4c368` / `630a8d3` / `b0c1c31` / `7e9e89a` / `be8e2cd` 全部 = 11。

**④ 内容**：纯 `?v=202609081909` → `?v=202609090957`，无逻辑改动。

**⑤ 当前工作区**：`git status --porcelain -- '*.html'` = **0**（已随提交固化）。

## C.3 我的责任与后续

这个 hook **是我在本项目早期建的**（用于修「每次提交后 8 个文件恒为 dirty」）。
它按设计工作，但它使**每一次 website 提交都必然携带 11 个 HTML 改动** ——
**我在 R2 报告中没有披露这一点，这是我的疏漏。**

**未做**（遵守指示）：`reset` / `revert` / `amend` / `force-push` / 改写历史，
以及**未修改 `.gitignore`**。

**后续处置**：

| 方案 | 说明 |
|---|---|
| A | 在每次 website 提交的报告中**显式声明** hook 会附带 11 个 HTML 戳记 |
| B | 纯文档提交时用 `git commit --no-verify` 跳过 hook，使提交范围严格等于文档 |
| C | 改 hook：仅当本次提交已包含 `assets/` 下的改动时才戳记 |

**本轮已采用 B + A**：本文件所在的提交使用 `--no-verify`，
提交范围严格等于文档与工具；并在此声明该 hook 的存在与副作用。
方案 C 属改动 hook 行为，**待 Supervisor 裁定后再做**。

---

## 停止条件确认

| 禁令 | 遵守 |
|---|---|
| ledger mutation · migration repair · db push | ✅ 未做 |
| 0022 application · 0027 application | ✅ 未做 |
| GRANT / REVOKE · DDL / DML · user mutation | ✅ 未做 |
| DB-4 · STAGING-1B · Production | ✅ 未触碰 |
| reset / revert / amend / force-push / 改写历史 | ✅ 未做 |
| 连接远端 | ✅ **本会话未连接** |
| **REMOTE MUTATION** | ✅ **NONE** |

## LEDGER REPAIR 状态（记录，不推进）

```
CONTROLLED LEDGER REPAIR = ELIGIBLE FOR PLANNING
                           NOT AUTHORIZED FOR EXECUTION

可纳入考虑：0011 0012 0013 0014 0015 0016 0017 0018 0019 0020 0021
明确排除：  0022 0023 0024 0025 0026 0027

0022 = NOT APPLIED，且 MUST NOT be ledger-repaired
```
