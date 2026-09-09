# R2 DOMAIN DIGEST RESULT

日期：2026-09-09 · canonical baseline：`docs/operations/r2/canonical-0021-fingerprint.txt`（609 行）
算法：`md5( 该 domain 全部 fingerprint 行按字典序排序、以单个 LF 连接、末行不追加 LF )`
**REMOTE MUTATION = NONE**（本会话未连接远端）

| domain | canon rows | canonical md5 | remote rows | remote md5 | verdict |
|---|---|---|---|---|---|
| `A_column` | 245 | `e910a2bb9c9aa67d6550509e719dd6bf` | 245 | `e910a2bb9c9aa67d6550509e719dd6bf` | **EXACT MATCH** |
| `B_constraint` | 72 | `9e38564adeb9358da98d2e7ae325c79f` | 72 | `9e38564adeb9358da98d2e7ae325c79f` | **EXACT MATCH** |
| `C_index` | 59 | `955c56a27c339f1f5cce1697bc6e5ede` | 59 | `955c56a27c339f1f5cce1697bc6e5ede` | **EXACT MATCH** |
| `D_trigger` | 18 | `d9b321ec390108ac712db55f02fa781f` | 18 | `d9b321ec390108ac712db55f02fa781f` | **EXACT MATCH** |
| `E_policy` | 33 | `26d20dcda2a372916156ff70f52f0524` | 33 | `ab4c134286d60e591e6e42a498241fd2` | **DIFFERENT** |
| `E_rls_enabled` | 26 | `6461fb5e99bd036f95525635b1fadbdc` | 26 | `6461fb5e99bd036f95525635b1fadbdc` | **EXACT MATCH** |
| `F_function` | 59 | `d55c53db0ee823e061293588367c673b` | 59 | `f1ea0c6bf033490d1750e6d1769b52b4` | **DIFFERENT** |
| `H_enum` | 15 | `22575b34ed9950448fc8157070cdeee8` | 15 | `22575b34ed9950448fc8157070cdeee8` | **EXACT MATCH** |

```
EXACT MATCH DOMAINS: 6 / 8
```

**两个差异域的行数与远端完全相同**（33 / 59）——
因此不是对象增减（`REMOTE_MISSING` / `REMOTE_EXTRA` 均不成立），
而是若干行的**内容**差异。

---

## 已排除的一个假设：`search_path` 渲染差异

`pg_get_expr` / `pg_get_functiondef` 的输出理论上可能随会话 `search_path` 改变
（函数引用是否 schema-qualified）。本地实测三种设置：

| `search_path` | `E_policy` | `F_function` |
|---|---|---|
| DEFAULT (`"$user", public`) | `26d20dcda2a37291…` | `d55c53db0ee823e0…` |
| `public, extensions` | `26d20dcda2a37291…` | `d55c53db0ee823e0…` |
| `''` | `26d20dcda2a37291…` | `d55c53db0ee823e0…` |

**三者完全相同 → `search_path` 不是原因。** 差异是真实内容差异。

---

## 下钻用的分层子投影 digest（canonical 侧）

在远端计算同样的子投影，即可**不搬运任何行**就定位差异层级。

### `F_function`

| 子投影 | 含义 | canonical md5 |
|---|---|---|
| `F1` | 仅 key（函数名 + 精确签名） | `aca09406eaf485373f15252c47937e15` |
| `F2` | key + 属性（不含 defmd5） | `c7d0e36907b23554d3f3a8e1608d08c1` |
| `F3` | key + defmd5（仅函数体） | `c9ed08d91248363dde4d1f7fece5991c` |
| `F2.lang` | key + `lang=` | `fccee63c53b33b57628cbf7adb8ff70d` |
| `F2.vol` | key + `vol=` | `bbcfad6f189fc28f228d56c3d37e459d` |
| `F2.secdef` | key + `secdef=` | `168adffc78c390e4e4c68e7e9627221e` |
| `F2.strict` | key + `strict=` | `fdf5b673bc26684d7461661191da45e0` |
| `F2.cfg` | key + `cfg=`（search_path 配置） | `c115a5985ba63ee568e8fb08879f533d` |

判读：`F1` 相同 → 函数集合与签名一致；差异只可能在属性或函数体。
`F3` 不同 → 至少一个函数**体**不同（这是最需要关注的一类）。

### `E_policy`

| 子投影 | 含义 | canonical md5 |
|---|---|---|
| `E1` | 仅 key（表.策略名） | `301fd04bf156f687e98791d527bfd049` |
| `E2` | key + cmd + permissive + roles | `723f29d533aedf9b14ae786ac8bc136d` |
| `E3` | key + `USING` 表达式 | `de2fa901133ca63b302ab544d0f9f39d` |
| `E4` | key + `WITH CHECK` 表达式 | `54b02072b96be64cb853a8d28c7cc224` |

---

## 逐行 digest（最省传输的定位方式）

已产出，两侧逐 key 对照即可精确定位到行，**无需回传任何策略/函数正文**：

```
docs/operations/r2/canonical-E_policy-rowdigest.txt     33 行  key|md5(payload)
docs/operations/r2/canonical-F_function-rowdigest.txt   59 行  key|md5(payload)
```

完整 canonical 行（供最终精确 diff）：

```
docs/operations/r2/canonical-E_policy-lines.txt
docs/operations/r2/canonical-F_function-lines.txt
```

逐行 digest 的算法：`md5(该行第三段 payload)`，即 `line.split("|",2)[2]`。

---

## G / G2 / G3 —— 按 Supervisor 更正

### G raw ACL = `PLATFORM-BASELINE-SENSITIVE` · **DO NOT RAW-DIFF**

远端实测 20 张表对 `anon` / `authenticated` 有 write-class ACL；
本地 shim canonical 侧为 0。**这是 Supabase 默认授权基线，不是 canonical drift。**

### `G2` 更名/改语义为 `G2_PRIVILEGE_SURFACE`

原写法把「必须为空」当成断言，在真实 Supabase 基线上**不成立**。
更正为：**只报告 ACL surface，不宣称必须为空**。

### 新增 `G3_EFFECTIVE_WRITE_POLICY_SURFACE`

`TABLE WRITE PRIVILEGE PRESENT` **不等于** `EFFECTIVE UNRESTRICTED WRITE`。
远端实测写策略均为预期业务路径：

```
applications                    authenticated INSERT / UPDATE，带 ownership 限制
profiles                        authenticated UPDATE self
submissions                     anon INSERT · authenticated UPDATE
teacher_verification_requests   authenticated INSERT / UPDATE self
```

真正要验证的不变式是：**不存在 `RLS_DISABLED` + `anon/authenticated write privilege`**。
Supervisor 已确认：**20 / 20 write-ACL 表均已启用 RLS**。

### 一项正面等价证据（不变）

`PUBLIC/anon EXECUTE` 函数 **11 个**，远端集合与 canonical 侧实测集合**完全一致**，
且恰为 0027 的 12 个目标减去已收口的 `has_active_role`。

### `TRUNCATE`

事实表述：

```
TRUNCATE PRIVILEGE PRESENT AT DB ROLE ACL LEVEL
RLS does not govern native PostgreSQL TRUNCATE
```

但**当前没有证据**证明普通 Supabase browser/client 存在 raw SQL / TRUNCATE 执行路径。
分类：**`PRIVILEGE HARDENING REVIEW REQUIRED`**。本轮**不 revoke、不 mutation**。

---

## FINAL

> # `R2 DIFFERENCE REQUIRES DRILLDOWN`
>
> 6 / 8 domain EXACT MATCH；`E_policy` 与 `F_function` 需下钻。
> 阶段状态维持 **`STAGING-1A NEEDS RECONCILIATION`**。
>
> **未开始 ledger repair。等待 Supervisor。**
