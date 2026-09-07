# DB-6.1 COURSE INTEGRITY & LINEAGE CLOSURE REPORT

**RB-01 · PHASE DB-6.1 —— 课程引用完整性与世系收尾**
日期：2026-09-07 · 执行：Claude

> **最终状态：`DB-6.1 LOCALLY VERIFIED`**
> `DBR-25 CLOSED` · `DBR-27 CLOSED` ·
> active production 中指向不存在 canonical course 的引用 = **0** ·
> 全量回归 PASS / FAIL / SKIP / BLOCKED_BY_ENV = **全部 PASS，无 SKIP、无 BLOCKED**。
> **未开始 STAGING-0。**

---

## 1. Starting Commit

| 项 | 值 |
|---|---|
| App `origin/main`（BASE_COMMIT） | `51bfd11` Merge remote-tracking branch 'origin/main' |
| website `origin/master`（BASE_COMMIT） | `fb0e444` DB-6 COURSE MIGRATION：LOCALLY VERIFIED |
| 启动时 drift 检查 | `git fetch origin` → 两仓均**无漂移**（local == origin） |
| ACTIVE TASK | DB-6.1（唯一） |
| 冻结世系 | `release/post-legacy-gate@e35923b` —— 本轮只读比对，未 merge / rebase / delete |

---

## 2. `c_healing` Root Cause

### 它的确切作用：**可导航的课程推荐**（不是纯文案、不是隐藏元数据）

`components/CustomTheologyView.tsx` 的 `SCENARIOS`（场景化推荐）：

```ts
{
  id: 'care', label: '正在关怀陪伴软弱/受伤的肢体', theme: '牧养关怀与医治事工',
  learn: ['倾听与协谈基础', '内在医治原则', '以福音施行安慰'],
  courseIds: ['c_counseling', 'c_healing'], boost: 'ministry',   // ← 244 行
}
```

`courseIds` 的消费链：

```
CustomTheologyView.tsx:2052
  portrait.scenario.courseIds.map(id => courseById(id)).filter(Boolean).map(c => (
    <button onClick={() => onCourseClick(c!.id)} …>      ← 渲染成可点击按钮
```

`courseById = (id) => courses.find(c => c.id === id)`（1331 行）。

**因此它是 navigation target。**

### 为什么一直没被发现

`courseById('c_healing')` 返回 `undefined` → `.filter(Boolean)` 把它丢掉 →
按钮从不渲染。**不报错、不崩溃、不进日志**，只是「关怀陪伴」场景静默地
少显示一张课程卡片（本该 2 张，实际 1 张）。

这类缺陷靠人眼审查发现不了 —— 这正是 §4 要建通用闸门的理由。

### 三项判据（Supervisor TASK 2 的分支条件）

| 判据 | 结论 |
|---|---|
| 它只是失效的课程链接 / 推荐？ | **是** —— `courseIds` 唯一用途就是渲染导航按钮 |
| 产品文案是否仍需表达「医治/关怀」主题？ | **是** —— 但 `theme` 与 `learn` 已是纯文本，本就承担了这件事 |
| 代码是否证明它代表一门仍应存在的正式课程？ | **否** —— 见下 |

第三条的证据：App `OFFICIAL_CATALOG` 67 门无它；Portal `course_catalog` 67 条无它；
`services/catalog.ts:117` 明确把它列入 `RETIRED_COURSE_IDS`，
注释为「旧的合并课程 → 已按书卷/主题拆分，迁移后删除」。
它不是「漏掉的第 68 门课」，是**已被拆分掉的旧合并课**。

### 全仓 active reference 复查

| retired id | 非 `RETIRED_COURSE_IDS` 声明处的引用数 |
|---|---|
| `c_healing` | **1**（`CustomTheologyView.tsx:244`） |
| `c_dr_pastoral` | 0 |
| `c_dr_peter` | 0 |
| `c_dr_johannine` | 0 |

扫描范围：`components/` `services/` `hooks/` `contexts/` `App.tsx` `constants.ts`；
共 71 个不同的 `c_*` 字面量，其中 67 个 ∈ `OFFICIAL_CATALOG`，
另 4 个即上表（3 个只出现在退役登记行内）。

---

## 3. `c_healing` Resolution

移除该失效的 canonical course 引用：

```ts
// 移除前
courseIds: ['c_counseling', 'c_healing'], boost: 'ministry',
// 移除后
courseIds: ['c_counseling'], boost: 'ministry',
```

`theme: '牧养关怀与医治事工'` 与 `learn: [… '内在医治原则' …]` **原样保留** ——
它们是纯文本，不伪装成有效 course ID。**主题没有丢，丢的只是一个指向不存在课程的 ID。**

### 用户可见行为：无变化

移除前该按钮就已经因为 `.filter(Boolean)` 而不渲染。
本次改动消除的是**源码里的无效 canonical 引用**，不是界面上的东西。

### 刻意没有做的事

| 没做 | 原因 |
|---|---|
| 映射到 `c_healing_word` / `c_healing_inner` | 两者都在正式目录里，但**哪一门该进这条推荐属产品判断**。D-37 与 DB-6 均禁止按名称相近回填 |
| 新增第 68 门课程 | Supervisor 明令禁止 |
| 删除 `theme` / `learn` 里的医治文案 | 它们是产品表达，不是 course ID |

已在代码内留下注释说明来龙去脉，并标注「待 Product Owner 决定是否补一门拆分后的课程」。

### 验收

```
active production reference to nonexistent canonical course ID = 0
```

---

## 4. Course Reference Integrity Gate

`tests/services/courseReferenceIntegrity.test.ts` —— **通用闸门，不是 `c_healing` 的一次性特判**。

### 做法

- 扫描 active production source：`components/` `services/` `hooks/` `contexts/` `i18n/`
  + `App.tsx` `constants.ts` `index.tsx` `types.ts`。
- **排除**（Supervisor 明确要求）：`tests/` `backend/` `scripts/` `docs/` `dist/` `android/` `ios/`
  等目录，以及 `*.test.ts(x)`。
- **排除 `RETIRED_COURSE_IDS` 声明行** —— 那一行的职责就是列出不再存在的 ID；
  把它算成 active 引用会让闸门永远红着，反过来诱使人删掉退役登记，那才是真正的信息损失。
- 断言：所有被当作 canonical course ID 使用的字面量 **⊆ `OFFICIAL_CATALOG`**。

### 6 条断言

| 断言 | 守住的东西 |
|---|---|
| 扫到的文件数 > 20 且引用数 > 50 | **防止 glob 静默扫空** —— 扫不到文件的闸门永远是绿的，比没有闸门更危险 |
| 每个 canonical course 引用都在 `OFFICIAL_CATALOG` | 主判据；失败时输出 `file:line` + 出问题的整行 |
| 退役课程 ID 在生产代码中零引用 | 退役的课不得继续被当作可导航目标 |
| 退役登记与正式目录不重叠 | 退役的课不得复活 |
| `OFFICIAL_CATALOG` 无重复 ID 且恰为 67 条 | 目录自身完整性 |
| 反证：不存在的 ID 必须落进 dangling | 证明匹配逻辑真的在工作 |

### 变异测试 —— 证明它真的会红

绿色本身不是证据。注入一个坏引用：

```
components/CustomTheologyView.tsx:252
    courseIds: ['c_counseling', 'c_abc_that_does_not_exist'], boost: 'ministry',
```

结果：

```
FAIL  tests/services/courseReferenceIntegrity.test.ts > 课程引用完整性 >
      生产代码中的每一个 canonical course 引用都存在于 OFFICIAL_CATALOG
AssertionError: 发现指向不存在课程的引用：
    components/CustomTheologyView.tsx:252  c_abc_that_does_not_exist
      courseIds: ['c_counseling', 'c_abc_that_does_not_exist'], boost: 'ministry',
```

已干净还原（残留坏引用数 0，还原后 6/6 PASS）。

> 以后任何人写下 `courseId: 'abc_that_does_not_exist'`，测试直接变红，并指出行号。

---

## 5. Retired Manifest

按 TASK 3 把 4 个 retired ID 正式固定进 migration manifest。
产物：`docs/operations/db6/retired-course-manifest.json`（同时并入 `course-mapping-manifest.json`）。

| legacy_course_id | status | canonical_replacement | historical_progress_count | migration_action |
|---|---|---|---|---|
| `c_dr_pastoral` | `RETIRED` | **null** | **0** | `PRESERVE_AS_RETIRED_REFERENCE` |
| `c_dr_peter` | `RETIRED` | **null** | **0** | `PRESERVE_AS_RETIRED_REFERENCE` |
| `c_dr_johannine` | `RETIRED` | **null** | **0** | `PRESERVE_AS_RETIRED_REFERENCE` |
| `c_healing` | `RETIRED` | **null** | **0** | `PRESERVE_AS_RETIRED_REFERENCE` |

`mapping_basis`（四条相同）：

> `services/catalog.ts:117` `RETIRED_COURSE_IDS` 声明 + 同处注释
> 「旧的合并课程 → 已按书卷/主题拆分，迁移后删除」；
> 拆分为一对多，无单一 canonical 替代，且仓库全历史未记录过其课程标题。

**没有编造标题。** 全历史 `git grep` 证实这 4 个 ID 从未在任何版本中有过 title 定义。

### D-37 相关的三个字段

```
active_course_progress_policy   NEVER_WRITE_TO_ACTIVE_COURSE_PROGRESS
on_encounter_in_future_dataset  FAIL_CLOSED_AND_QUARANTINE_FOR_PRODUCT_OWNER
quarantine_state                LEGACY_RETIRED / MIGRATION_REVIEW_REQUIRED
```

manifest 顶部注明：**当前 `historical_progress_count` 全为 0，
因此本轮不新增任何 legacy-retired 业务表** —— 不为不存在的数据增加永久 schema。

---

## 6. DBR-26 Status

**保持不变：迁移阶段逐字保留，本轮 `NO DATA NORMALIZATION`。**

- SQLite `courses.thumbnail` 的 **32 条空串**已原样迁入 `course_catalog.thumbnail_path`。
- **没有**改成 `NULL`。契约测试里那条
  `thumbnail_path: 32 条空串逐字保留（未被归一成 NULL）` 会挡住任何未来的偷偷归一化。
- 记为 DB-12 的 **DAL / presentation semantics** 项：后续须统一定义

  ```
  NULL         —— 从未设置过封面
  ''           —— 历史上写入过空串（等价「无封面」，但来源不同）
  valid path   —— 有封面
  ```

  在读取层与展示层分别意味着什么。**但不能借 migration 偷偷改历史数据。**

`DBR-26` 保持 `OPEN`，phase 由「App 写入路径」细化为「DAL / presentation semantics」。

---

## 7. Regression Results

| 套件 | PASS | FAIL | SKIP | BLOCKED_BY_ENV |
|---|---|---|---|---|
| 前端测试（`npm run test`） | **187** | 0 | 0 | 0 |
| ↳ 其中新增的课程引用完整性闸门 | 6 | 0 | 0 | 0 |
| 后端 `test:local` | **159** | 0 | 0 | 0 |
| 前端 typecheck（`tsc --noEmit`） | exit 0 | — | — | — |
| 后端 typecheck（`tsc --noEmit`） | exit 0 | — | — | — |
| `npm run build` | ✅ 13.11s | — | — | — |
| DB-6 契约 · PostgreSQL **17.6** | **36** | 0 | 0 | 0 |
| DB-6 契约 · PostgreSQL 18.6 | **36** | 0 | 0 | 0 |
| DB-3 契约 · PostgreSQL **17.6** | **53** | 0 | 0 | 0 |
| DB-3 契约 · PostgreSQL 18.6 | **53** | 0 | 0 | 0 |

前端测试文件数由 20 增至 21，用例数由 181 增至 187（+6 = 新闸门）。

**无 SKIP，无 BLOCKED_BY_ENV** —— 本阶段的全部检查都能在本地真实执行。

---

## 8. Canonical Writer Rule

D-38 已落地到 `AI_HANDOFF_RULES.md` 顶部（在原 ACTIVE TASK OWNER 表之前）：

```
| REPOSITORY      | CANONICAL_WRITE_OWNER | ACTIVE_TASK | ACTIVE_BRANCH | BASE_COMMIT | STARTED_AT | STATUS |
| AMAS-Seminary   | （无）                 | —           | —             | —           | —          | IDLE   |
| amas-website    | （无）                 | —           | —             | —           | —          | IDLE   |
```

规则原文：同一仓库任一时刻只能有一个会话拥有 canonical write authority；
其他会话可 `READ` / `AUDIT` / `REVIEW` / `ISOLATED EXPERIMENT`，
**不得直接 push** `origin/main` / `origin/master`；发现已有 `ACTIVE` writer →
`STOP CANONICAL WRITE`。

同时写入 **Main Drift Rule**：认领时记录 `BASE_COMMIT`；push 前必须 `git fetch origin`；
若 `origin/main` 已不是预期世系，**不得直接 push**，先做 LINEAGE RECONCILIATION
（真实合并 → 逐项证明双方成果都在 → 全量回归 → 再 push）。

并附一句本项目特有的告诫：**`CONFLICT = 0` 不构成证据**（本仓有过静默删除事故）。

`AI_HANDOFF_RULES.md` 另记了最近三次认领与交回（DB-3.5 / DB-6 / DB-6.1），
其中 DB-6 那次注明「push 时遇 main 漂移，已做 lineage reconciliation」。

---

## 9. Frozen Release Candidate Comparison

**只读比对，未 merge、未删除、未修改。**

`release/post-legacy-gate@e35923b` vs `origin/main`：

```
冻结候选独有的文件（main 中不存在）：0 个
main 相对冻结候选：+1459 行 / −17 行（10 个文件）
```

那 17 行「删除」全部是**被更替的文档行**：ACTIVE_TASK_OWNER 的旧 IDLE 行、
被我按 D-36 重排的 roadmap 行，以及已关闭的 OPEN_ISSUES 条目
（含 `#14 /api/auth/me 不走 requireAuth`）。
`#14` 经核实是**真修好了**，不是被抹掉 —— `routes/auth.ts:31/51` 的
`GET` 与 `PATCH /api/auth/me` 都挂在 `requireAuth` 上。

### 8 项关键能力在 main 中的存在性

| # | 能力 | 结果 | 证据 |
|---|---|---|---|
| 1 | SINGLE TEST AUTH HARNESS | ✅ | `backend/src/test/helpers/supabaseHarness.ts`（`startFakeSupabase` / `provisionUser`） |
| 2 | post-legacy regression suites | ✅ 2/2 | `auth-post-legacy-audit.test.ts` · `auth-migration-cutover.test.ts` |
| 3 | `verify:local-release` | ✅ | 根 `package.json` 已定义 |
| 4 | migration cutover regression | ✅ | `auth-migration-cutover.test.ts` 中 2 处 cutover 断言 |
| 5 | migrated-user login proof | ✅ | 同文件 7 处登录路径断言 |
| 6 | idempotency proof | ✅ | 后端测试中 7 处幂等断言 |
| 7 | authorization SoT tests | ✅ | `auth-post-legacy-audit.test.ts` 中 9 处授权 SoT 断言 |
| 8 | legacy admin dead-code removal | ✅ | 生产代码中 `issueTokens` / `verifyAccess` / `acceptLegacy` 的**定义 0 处、调用 0 处**；仅剩 3 行历史注释（`jwt.ts:7-8` 的 JSDoc、`middleware/auth.ts:211` 的说明）。`jwt.ts` 现在只导出 `AccessPayload` |

**8/8 全部具备。** 因此：

> ## `RELEASE CANDIDATE SUPERSEDED`

`release/post-legacy-gate@e35923b` 与 `safety/release/post-legacy-gate@e35923b`
**保留为 recovery ref，本轮不删除、不合并**。

---

## 10. Documentation Updates

- **新增** `docs/operations/DB-6.1-COURSE-INTEGRITY-AND-LINEAGE-CLOSURE-REPORT.md`（本文）
- **新增** App `tests/services/courseReferenceIntegrity.test.ts`（6 条断言，已变异验证）
- **新增** `docs/operations/db6/retired-course-manifest.json`
- **更新** App `components/CustomTheologyView.tsx`（移除失效引用 + 说明注释）
- **更新** App `backend/scripts/db6-course-migration.mjs`（retired manifest 契约字段，D-37）
- **更新** `AMAS_PROJECT_HANDOFF.md` → v2.4，新增 **D-37 / D-38**
- **更新** App `docs/project-memory/`：
  `DECISION_LOG.md`（D-37 / D-38）·
  `OPEN_ISSUES.md`（DBR-25 CLOSED · DBR-27 CLOSED · DBR-26 归属细化）·
  `CURRENT_STATE.md` · `DEVELOPMENT_ROADMAP.md`（STAGING-0 为下一阶段）·
  `ACCEPTANCE_HISTORY.md`（DB-6.1 验收条目）·
  `AI_HANDOFF_RULES.md`（D-38 所有权表 + Main Drift Rule + 冻结候选状态）

### D-37｜未映射的 retired 课程进度永不进入 active `course_progress`

修订 DB-1 §4.3。active `course_progress` 只能引用 canonical `course_catalog`。
未映射的 retired 进度以 `LEGACY_RETIRED` / `MIGRATION_REVIEW_REQUIRED`
留在 migration manifest 与 quarantine 证据中，不写入业务表。
当前 `retired course_progress rows = 0`，**不新增 legacy-retired 业务表**。
将来遇到此类数据，迁移必须 fail closed / quarantine 并提交 Product Owner。

### D-38｜ONE CANONICAL WRITER PER REPOSITORY

同一仓库任一时刻只能有一个 canonical writer。不同 task 可以并行，
但**不得并行写同一仓库的 canonical branch**。

---

## 11. Commits

| 仓库 | commit | 内容 |
|---|---|---|
| App | `47bd23d` | 移除 `c_healing` 失效引用 · 课程引用完整性闸门 · retired manifest 契约 · D-37/D-38 · 六个记忆文档 |
| website | *(本次提交)* | DB-6.1 报告 · retired manifest 产物 · HANDOFF v2.4 |

**Main Drift Rule 执行记录**（D-38）：push 前对两仓各做一次 `git fetch origin`，
确认 `origin/main = 51bfd11`、`origin/master = fb0e444` 与认领时的 `BASE_COMMIT` 一致，
**无漂移**，因此本轮直接 push，未触发 LINEAGE RECONCILIATION。

---

## 12. Remaining Blockers

| ID | 状态 | 内容 | 解除条件 |
|---|---|---|---|
| **DB-4** | `BLOCKED_BY_EXTERNAL_ENV` | identity migration 需要真实 staging Supabase（D-35 的五项检查在垫片环境中一项都答不了） | STAGING-0 |
| **RB-22** | `BLOCKED_BY_ENV` | 6 个 AUTH external tests | STAGING-0 |
| **RLS runtime** | `ENVIRONMENT-UNVERIFIED` | Portal 既有 33 条 policy 只做过存在性回归，未做真实 JWT 下的否定式测试 | STAGING-0 |
| DBR-26 | `OPEN` | `thumbnail` 空串语义 | DB-12 |
| DBR-23 | `OPEN` | Portal RLS policy 计数口径 36 vs 33 | DB-4 |
| — | 产品待决 | 「关怀陪伴」场景是否补一门拆分后的医治课程 | Product Owner |

**本地课程迁移工作到此正式结束**（DBR-25 CLOSED · 引用完整性 PASS · 全量回归 PASS）。

---

## 13. STAGING-0 Recommendation

**未开始。** 以下是建议范围，交由 Supervisor 决定是否启动。

STAGING-0 要解决的三个卡点：

```
DB-4 identity migration      BLOCKED_BY_EXTERNAL_ENV
AUTH external tests          BLOCKED_BY_ENV
RLS runtime                  ENVIRONMENT-UNVERIFIED
```

建议先产出 **checklist 而不是先建资源**，因为多数条目需要 Product Owner 提供或授权：

| 类别 | 待确认项 |
|---|---|
| **Provisioning** | staging Supabase 项目是否已存在（`amas-staging` ref `sdrwyebizfdwldlfjyim` 是否仍可用）· PostgreSQL 版本是否为 **17.6**（DBR-22 的同款要求）· region · 计划 |
| **Credentials** | `service_role` / `anon` key 的取得与保管方式 —— **不得进入 Git / 前端 bundle / 日志 / 报告 / shell history**；仅以 `CONFIGURED` / `NOT CONFIGURED` 记录 |
| **Isolation** | staging 与未来 production 的隔离边界 · staging 数据可随时销毁重建 · `STAGING-ONLY TEST FIXTURES` 的创建/销毁流程（D-34） |
| **Auth** | GoTrue 可用性 · 邮件链路（RB-04 SMTP 未建）· recovery 流程能否走真实邮件 |
| **Migration 入口** | migration 如何施加到 staging（Supabase CLI 需要 Docker，**本机未安装** —— 需确定替代路径：直连 psql / CI / 其他） |
| **验证清单** | 迁移后须重跑：DB-3 契约 53 · DB-6 契约 36 · STEP 5 否定式授权全套 · 6 个 AUTH external tests |

> ⚠ 一个已知的实操障碍：**本机没有 Docker**，`supabase start` / `supabase db push`
> 的常规路径走不通。STAGING-0 的第一件事应当是确定 migration 的施加通道，
> 否则后面每一步都会卡在同一个地方。

---

## 停止条件确认

| 禁令 | 遵守情况 |
|---|---|
| 不开始 DB-4 | ✅ |
| 不自动开始 STAGING-0 | ✅ 只产出建议清单 |
| 不为 `c_healing` 写一次性特判 | ✅ 闸门是通用的，且已变异验证 |
| 不把 retired id 映射到名字相近的课程 | ✅ 4 条 `canonical_replacement = null` |
| 不新增第 68 门课程 | ✅ `OFFICIAL_CATALOG` 仍为 67，闸门有断言 |
| 不为不存在的数据增加永久 schema | ✅ 未新增 legacy-retired 业务表 |
| `thumbnail` 不做数据归一化 | ✅ 32 条空串原样保留，契约测试有断言把守 |
| 不编造 retired 课程标题 | ✅ 全历史证实从未记录过 |
| 不删除冻结候选分支 | ✅ 只读比对，`e35923b` 未动 |
| 不 force push | ✅ |

---

## 最终状态

> # `DB-6.1 LOCALLY VERIFIED`
>
> `DBR-25 CLOSED` · `DBR-27 CLOSED`（D-37 裁定 schema 不改）
> active production 中指向不存在 canonical course 的引用 = **0**
> 前端 187/187 · 后端 159/159 · typecheck ×2 · build ✅ · DB-6 36/36 ×2 版本 · DB-3 53/53 ×2 版本
> SKIP 0 · BLOCKED_BY_ENV 0
> `release/post-legacy-gate@e35923b` = `RELEASE CANDIDATE SUPERSEDED`（保留，未删未合）
>
> **本地课程迁移工作正式结束。未开始 STAGING-0。**
