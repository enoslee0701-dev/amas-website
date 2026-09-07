# AUTH CANONICALIZATION REPORT

**日期**：2026-09-07 · **依据**：Supervisor Decision RB-23（D-14 / D-15 / D-16）
**约束遵守**：未做 DAL 重构 / SQLite→Postgres / UX 重写 / 新功能 / CP 修改 / Course model 重构 / 无关清理

---

## 1. Canonical Branch / Commit

```
canonical lineage   integration/auth-strategy-b @ 78985e5
consolidation       consolidation/auth-canonical
最终 main           8d5b51b
origin/main         8d5b51b        ahead/behind 0/0   ✅ 已推送
```

提交序列（自 `a43597b` 起）：

```
8d5b51b  docs: D-14/15/16 + ACTIVE TASK OWNER + 静默删除盲区与历史验收降级
8b820d6  canonical consolidation：R1-3 legacy 政策 + 静默删除回归护栏
78985e5  AUTH-M7: 运行时身份解析（实为 Runtime Identity Resolution，见 §5）
68e4b59  merge(strategy B)：revert 世系后三方合并语义恢复正确
cf90eb7  Revert "revert(auth): 从 main 移出未经独立验收的 Supabase Auth 变更"
```

---

## 2. Why Strategy B Won

按 Supervisor 批准理由执行，其中第 3、4 条在本轮获得实证：

| # | 理由 | 本轮验证 |
|---|---|---|
| 1 | 已完成 AUTH-M7 | ⚠ 部分成立 —— 它完成的是 Runtime Identity Resolution，不是 D-15 定义的 M7（§5） |
| 2 | 更接近 Supabase 单一认证来源 | ✓ `auth/identity.ts` 解决幽灵身份 |
| 3 | revert `d3e860d` 恢复正确 merge semantics | ✓ 这是关键 —— 见 §8 |
| 4 | 避免 silent deletion | ✓ 另一世系实际遭遇了它 |
| 5 | 四个核心 AUTH 文件高度趋同 | ✓ 逐字节相同 |
| 6 | 无理由维持第二条正式世系 | ✓ |

---

## 3. Semantic Deltas Ported

### Difference 1 — `config.ts` / `acceptLegacy` ✅ 已移植

```ts
acceptLegacy: (() => {
  const raw = envOr('AUTH_ACCEPT_LEGACY');
  if (raw) return raw !== 'false';                       // 显式设置优先
  return (process.env.NODE_ENV ?? '').trim() !== 'production';
})(),
```

| 环境 | 缺省 |
|---|---|
| **production** | **关闭** —— 要保留必须显式 `AUTH_ACCEPT_LEGACY=true` |
| development / test | 开启 —— 不断掉现有迁移链 |

**为什么没有按 D-15 直接删除 legacy config**：Supervisor 的前置条件是
「AUTH-M7 已删除 legacy validation / issuance 且 middleware 不再读 `acceptLegacy`」。
**该前置条件不成立**（§5、§6），故按指令停止删除并报告，改以生产默认关闭作过渡防护。

---

## 4. Semantic Deltas Rejected

### Difference 2 — `routes/auth.ts` ❌ 拒绝

剥离注释后逐行比对两侧**可执行代码完全相同**：

```
git show recovery/lineage-a-4c139ec:backend/src/routes/auth.ts | 去注释
git show 78985e5:backend/src/routes/auth.ts                    | 去注释
→ diff 无差异
```

Supabase auth flow / identity provisioning / password-recovery semantics /
错误处理 / main 后续行为，**一项未丢**。纯注释差异，不为保持 lineage 风格
制造无意义 cherry-pick。

### Difference 3 — `smoke.test.ts` / `seedAdmin` ❌ 无需

canonical 分支上只存在 `seedAdminInFixtureDb`（48 行定义、787 行调用），
孤儿 `seedAdmin` / `SMOKE_DB` **本就不存在**。之前观察到的 7 行差异是
另一世系里我自己加的说明注释，不是死代码。无可清理。

---

## 5. AUTH-M7 Static Proof

> ## ⛔ 结论：按 D-15 定义，**AUTH-M7 尚未完成**

### 命名冲突

`78985e5` 提交标题写「AUTH-M7」，但它实际完成的是 **Runtime Identity Resolution**：

> Supabase 登录成功 ≠ 拥有 AMAS 身份。新增 `legacy_user_map` 运行时解析，
> 解析不出一律 **403 `IDENTITY_NOT_PROVISIONED`，fail closed，不自动 provision**。
>
> 起因（`AUTH-P1-GHOST-IDENTITY-FINDING.md`）：此前 Supabase 分支直接拿
> `payload.sub` 当 `principal.user.id`，从头到尾不碰 SQLite。于是一个只存在于
> Supabase 的身份可以写 `growth_state` / `pt_state` / `posts` / `course_progress` /
> `library_favorites` / `push_tokens` —— **19 张用户相关表里 16 张没有外键，
> 数据库层根本挡不住。**

这是一项真实且重要的安全修复，但**不是** D-15 定义的 AUTH-M7。

### 静态审计实测

| 检查项 | 结果 |
|---|---|
| **Legacy issuance** | ⚠ **仍活跃** —— `routes/auth.ts:80 / 113 / 149` 调用 `issueTokens()`（登录 / 注册 / 刷新） |
| **Legacy validation** | ⚠ **仍活跃** —— `middleware/auth.ts:215` 调用 `verifyAccess()`，仍会铸出 `authSource: 'legacy'` principal |
| **Legacy config** | ⚠ **仍有 consumer** —— `config.supabase.acceptLegacy` 被 `middleware/auth.ts:210` 读取 |
| **Legacy endpoints** | ✅ 已根除 —— `_promote` / `promoteToAdmin` 全部 3 处命中**均为注释**，零活跃代码，无任何提权路由 |

---

## 6. Legacy Auth Search Results

```
issueTokens        auth/jwt.ts:95 定义
                   routes/auth.ts:12 导入 · :80 :113 :149 调用      ← 活跃
verifyAccess       middleware/auth.ts:8 导入 · :215 调用             ← 活跃
acceptLegacy       config.ts 定义 · middleware/auth.ts:210 读取      ← 活跃
_promote           3 处命中，全部注释                                ← 已根除
promoteToAdmin     1 处命中，注释                                    ← 已根除
legacy login bypass 0 命中
```

**Tests**：6 个 AUTH 验收测试保护的是历史 migration helper 与真实环境行为，
已被 canonical 分支隔离到 `test:external`，与 `test:local` 分开计数，**予以保留**。

---

## 7. Service Principal Callers

`APP_SECRET` service principal **有真实调用场景，不是 dead architecture**：

| 调用路径 | 用途 | 状态 |
|---|---|---|
| `requireAuth` 第 1 级 | 特权端点的机器对机器调用（`server.ts:62`） | ✅ 活跃 |
| `checkWsAuthToken` ← `routes/gemini.ts:48` | Gemini Live WebSocket 代理（前端用 `VITE_APP_SECRET` 拼 WS URL） | ✅ 活跃 |
| `routes/courses.ts` / `routes/library.ts` | admin 或 service caller 可增删改 | ✅ 活跃 |
| **`requireAppSecret`** | **零路由挂载** | ⚠ **dead architecture candidate**（RB-25，本轮只标记不删除） |

边界满足要求：与用户登录完全分离 · 常数时间比较 · secret 缺失时该分支永不成立
（`if (config.appSecret && ...)`）· 用户无法通过该路径获得身份。

---

## 8. Silent Deletion Regression Guard

### 根因

`d3e860d` 从 main 删除实现文件 → auth 分支之后未再修改它们 →
git 判定「一侧删除、一侧未改 → **删除生效**」→ **不报冲突**。

结果：`supabase-auth.test.ts`（266 行）被带回，**被测实现没回来**，
而 **typecheck 与全部测试仍然全绿**（该测试 spawn 子进程，不直接 import）。

> 这是一类 **测试存在 / 实现消失 / CI 全绿** 的盲区。
> Strategy B 用 `Revert the revert` 恢复三方语义规避了它 —— 这应作为
> 合并 revert 世系的标准做法。

### 护栏

新增 `backend/src/test/auth-adapter-presence.test.ts`，**7/7 PASS**，已进 `test:local`。

刻意最小：**不做 AST 分析、不 mock、不连网络**。import 成功本身即最可靠的
存在性证明——文件缺失、依赖缺失、语法错误、循环依赖，任一都会让它失败。

| # | 断言 |
|---|---|
| 1 | 生产 auth adapter 存在且可真实 `import` |
| 2 | adapter 六个契约函数齐备（`verifySupabaseAccess` / `fetchActiveRoles` 等） |
| 3 | 活跃中间件**确实 import 并调用** `verifySupabaseAccess`，不是引用幽灵 |
| 4 | 中间件本身可 import（依赖链完整、无悬空引用） |
| 5 | `@supabase/supabase-js` 在 `package.json` 中被声明（它曾随 revert 一并被删） |
| 6 | 前端 `services/supabaseAuth.ts` 存在 |
| 7 | 每个 AUTH 测试都有对应实现文件存在 |

**残留风险**：护栏只覆盖 AUTH adapter。其他领域若发生同型 revert 世系合并，
仍可能静默丢文件。已记入 RB-24。

---

## 9. Full Test Accounting

按 Supervisor 要求分项计数，**SKIP 不并入 PASS**：

| 套件 | PASS | FAIL | SKIPPED | BLOCKED_BY_ENV | NOT_IMPLEMENTED |
|---|---|---|---|---|---|
| 前端 vitest（20 files） | **181** | 0 | 0 | 0 | — |
| 后端 `test:local` | **142** | 0 | 0 | 0 | — |
| 后端 `test:external` | **0** | 0 | **6** | **6** | — |
| **合计（可执行）** | **323** | **0** | **6** | **6** | — |

```
前端 typecheck   clean
后端 typecheck   clean
build            exit 0
```

**专项回归**：

| 项 | 结果 |
|---|---|
| Christian Profile golden | **20/20**，3 个 snapshot **未变** —— 合并与 canonicalization 均未让算法漂移 |
| startup guard (RB-06) | **13/13** |
| auth adapter presence（新增） | **7/7** |
| prayer / voice / presence / 阅读位置 | 含在前端 181 与后端 142 内，全绿 |

`test:local` 142 = smoke 103 + startup-guard 13 + auth-m7-identity 19 + adapter-presence 7。

---

## 10. AUTH Tests Blocked By Environment

6 个文件逐个实跑，**全部 0 PASS / 1 SKIPPED**：

```
credential-recovery.test.ts          0 pass / 1 skipped
credential-recovery-expiry.test.ts   0 pass / 1 skipped
identity-migration.test.ts           0 pass / 1 skipped
password-change-reauth.test.ts       0 pass / 1 skipped
redirect-matrix.test.ts              0 pass / 1 skipped
supabase-auth.test.ts                0 pass / 1 skipped
```

原因：均在缺 `AMAS_ENV` / `staging.env` 时整组跳过。

> **历史报告中的 `23/23` `8/8` `17/17` `135/135` 在当前环境 NOT REPRODUCIBLE。**
> 自即日起不得再作为当前验收证据。相关状态统一降级为
> **`IMPLEMENTED / ENVIRONMENT-UNVERIFIED`**。
>
> 这不等于代码有错，而是：**当前没有可复现证据**证明真实 Supabase AUTH
> integration 已通过。

---

## 11. Origin/Main Recheck

```
push 前 fetch origin
origin/main = a43597b   （即本会话早些时候推送的 RB-06/CP 提交）
a43597b..origin/main 之间无他人提交
canonical 包含 origin/main → 可安全推进，不丢任何远端提交
```

> **一处更正**：我最初拿 `95dc954` 作比对基准并报了「origin/main 已变化」。
> 那是**我的基准过时**——`95dc954` 是本会话推送 `a43597b` 之前的旧值。
> 复核后确认 origin/main 自 `a43597b` 起未被他人改动。

---

## 12. Push Result

```
a43597b..8d5b51b  main -> main        ✅
main = origin/main = 8d5b51b          ahead/behind 0/0
工作区 clean
```

---

## 13. Competing Lineages Status

| 世系 | 状态 | 处置 |
|---|---|---|
| **canonical** `main` @ `8d5b51b` | **ACTIVE** | 已推送，唯一权威 |
| `recovery/lineage-a-4c139ec` | **RETIRED / RECOVERY EVIDENCE** | 保全为本地分支，不再演进。canonical 已推送并验证，可在建立 backup ref 后退休 |
| `rehearsal/auth-merge-2026-09-07` | **FROZEN / NON-CANONICAL** | **未做任何操作** —— 其 worktree 内有另一会话 **88 项未提交工作**。禁止 reset / clean / delete / prune / checkout 覆盖。归档方式待单独决定 |
| `integration/auth-strategy-b` | 已并入 canonical | 保留 |

**已确认冻结**：`rehearsal` worktree 仍为 `03bb842` + 88 项未提交，与发现时一致。

---

## 14. Documentation Updates

| 文件 | 内容 |
|---|---|
| `DECISION_LOG.md` | **D-14** canonical lineage · **D-15** AUTH-M7 定义与命名冲突 · **D-16** 一任务一世系 |
| `AI_HANDOFF_RULES.md` | 顶部建立 **ACTIVE TASK OWNER** 表（OWNER / BRANCH / PHASE / STARTED_AT / STATUS），写代码前必查 |
| `OPEN_ISSUES.md` | **RB-24** 静默删除盲区 · **RB-22** 历史验收降级 · **RB-25** `requireAppSecret` dead candidate |
| `ACCEPTANCE_HISTORY.md` | append-only 追加 canonicalization 条目，测试按 PASS/FAIL/SKIP 分列 |
| `CURRENT_STATE.md` | 基线改为分项计数，external 6 项明确标 BLOCKED_BY_ENV |

---

## 15. Remaining AUTH Blockers

| ID | 内容 | Sev |
|---|---|---|
| **AUTH-M7（真）** | 按 D-15 定义**尚未开始**：需删除 legacy issuance（`issueTokens` 在登录/注册/刷新路径）+ legacy validation（`verifyAccess`）+ `acceptLegacy` 配置 | P1 |
| **RB-22** | 6 个 AUTH 验收测试 BLOCKED_BY_ENV，历史数字不可复现 | P2 |
| **RB-24** | 静默删除盲区残留风险（护栏只覆盖 AUTH adapter） | 已缓解 |
| **RB-25** | `requireAppSecret` 零路由，dead architecture candidate | P3 |
| **RB-01** | App 后端仍为本地 SQLite（D-11/D-12/D-13 已定方向，未实施） | P1 |

---

## 16. Recommended Next Step

**推荐：实施真正的 AUTH-M7（按 D-15 定义）。**

理由：canonicalization 已完成且推送，legacy 目前只靠「production 缺省关闭」这一层
过渡防护 —— 它防住了误配置，但**没有消除双轨架构本身**。而 M7 的范围现在很清晰：

```
删除 routes/auth.ts 的 issueTokens 调用（登录 / 注册 / 刷新三处）
删除 middleware/auth.ts 的 legacy 分支与 verifyAccess 导入
删除 config.ts 的 acceptLegacy 与 AUTH_ACCEPT_LEGACY
更新依赖 legacy token 的测试（明确标为 isolated migration helper 或删除并记录理由）
```

**前置依赖**：`auth-m7-identity.test.ts`（19 项）与新增的 adapter presence 护栏
已就位，可作为 M7 的回归基线。

**需要你决定**：M7 是否现在立项，还是先推进 RB-01（SQLite→Postgres，D-13 已批准立项
但未批准开始 DAL 重构）。二者都不依赖付费资源，但**不建议并行**——D-16 刚确立
一任务一世系，且两者都会动 `middleware/auth.ts` 与 `db.ts`。

---

# 状态

```
CANONICALIZED / PUSHED
```

canonical 世系已合并、验证、推送；main = origin/main = `8d5b51b`。
按 Supervisor 规定，不使用 INTEGRATION VERIFIED / STAGING VERIFIED / PRODUCTION VERIFIED。
