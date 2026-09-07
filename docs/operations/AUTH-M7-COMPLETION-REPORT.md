# AUTH-M7 COMPLETION REPORT

**日期**：2026-09-07 · **ACTIVE TASK**：AUTH-M7（D-16 一任务一世系）
**约束遵守**：未做 DAL 重构 / SQLite→Postgres / UX 重写 / 新功能 / CP 修改 / Course model 重构

---

## 1. Starting Commit

```
起点   main = origin/main = 8d5b51b   工作区 clean
终点   main = origin/main = d564c4c   已推送
```

---

## 2. Legacy Consumer Audit

### Issuance — `issueTokens()` 的三个调用点

| 行 | 端点 | 性质 | M7 之后的 Supabase flow |
|---|---|---|---|
| `routes/auth.ts:80` | `POST /api/auth/register` | 注册 | `supabase.auth.signUp()`（前端直连） |
| `routes/auth.ts:113` | `POST /api/auth/login` | 登录 | `supabase.auth.signInWithPassword()` |
| `routes/auth.ts:149` | `POST /api/auth/refresh` | 会话刷新 | Supabase 客户端 SDK 自动刷新 |

审计中另发现两个未在原清单内的 legacy 端点：

| 端点 | M7 之后 |
|---|---|
| `POST /api/auth/change-password` | `supabase.auth.updateUser()` |
| `POST /api/auth/logout` | `supabase.auth.signOut()` |

### Validation

`middleware/auth.ts` 原有**三级** token 接受：

```
1) APP_SECRET       -> service principal
2) Supabase token   -> verifySupabaseAccess + 运行时身份解析
3) legacy 自签 token -> verifyAccess()，铸出 authSource:'legacy' principal   ← 本轮删除
```

另外 `routes/auth.ts` 的 4 个处理器（`change-password` / `logout` / `GET me` / `PATCH me`）
**不走中间件，自己调 `verifyAccess()` 验签** —— 这是原清单未列出的第二处 legacy 验证面。

---

## 3. Frontend Auth Consumer Audit

> 这是本轮最重要的前置检查。

`services/authService.ts` 是**完整双路实现**：

```
supabaseEnabled ?  supabase.auth.signUp / signInWithPassword / currentSession / signOut
                :  POST /api/auth/{register,login,refresh,logout}  + 本地存 accessToken/refreshToken
```

`supabaseEnabled = Boolean(VITE_SUPABASE_URL && VITE_SUPABASE_ANON_KEY)`。

**关键事实**：这两个变量当前**未配置**（`.env.local` 只有 `VITE_API_BASE_URL`
与 `VITE_VOICE_TRANSPORT`），因此 App 目前**整个跑在 legacy 链路上**。

> **Supabase 路径的代码已经就绪，缺的是配置。**
> 所以 M7 不是「先迁移 consumer」，而是「移除 legacy 分支，使 Supabase 成为唯一路径」——
> 代价是 `VITE_SUPABASE_*` 从此成为**硬依赖**（记入 RB-28）。

### 测试侧 consumer —— 一度判定为硬阻断

`smoke.test.ts`（103 项）用 `POST /api/auth/register` **45 次**作为 fixture 机制，
是测其余所有路由（rooms / courses / library / pt / growth / friends / push）
拿用户 token 的唯一途径。删掉 issuance 后它们无法迁移——因为 M7 之后
中间件只接受 Supabase 签发的 token，而测试进程造不出来。

**阻断解除**：审计发现 `auth-m7-identity.test.ts` 已经在用**本地假 Supabase**——
真 ES256 密钥对 + 真 JWKS 端点 + 真验签 + `user_roles` REST，
后端跑 100% 生产代码路径，只有 issuer 地址指向本地。
该文件自述「这**不是** mock，也不是测试逃生口」。smoke 可迁到同一套。

---

## 4. Final Authentication Contract

### User Login

```
Frontend
  → Supabase Auth（signIn / signUp / refresh / logout / password reset / email verification）
  → 取得 Supabase access token
  → 作为 Bearer 送给后端
  → verifySupabaseAccess()（本地 JWKS，ES256，iss/aud 校验）
  → 运行时身份解析（Supabase UUID → legacy_user_map → canonical SQLite user）
  → 授权（角色按 authId 现查，不缓存）
```

### Backend 职责（M7 之后）

```
✓ 验证 Supabase access token
✓ 解析 canonical application identity
✓ 现查角色
✓ 授权判定
✗ 不再作为任何 user JWT 的 issuer
```

### 合并后的三级身份路径

| # | 路径 | 用途 |
|---|---|---|
| 1 | **service principal** | `APP_SECRET` 机器对机器（内部工具、Gemini WS 代理） |
| 2 | **Supabase user** | **唯一** user 认证来源 |
| ~~3~~ | ~~legacy user~~ | **已删除** |

无凭据一律 401（fail closed）。走到末尾（既非 APP_SECRET 也非本 issuer 的
Supabase token）一律 401，**绝不回退到任何其他验签方式**。

---

## 5. Legacy Issuance Removed

`routes/auth.ts` **316 行 → 86 行**。

删除的端点：

```
POST /api/auth/register          POST /api/auth/change-password
POST /api/auth/login             POST /api/auth/logout
POST /api/auth/refresh           （POST /api/auth/_promote 早于 AUTH-M3 已移除）
```

保留的两个改用 `requireAuth`，身份取自 `req.principal.user`：

```
GET   /api/auth/me
PATCH /api/auth/me
```

`auth/jwt.ts` **190 行 → 41 行**：`issueTokens` / `verifyAccess` / `verifyRefresh` /
`revokeRefresh` / `revokeAllRefreshForUser` / `_resetSessions` 全部删除，
只保留 `AccessPayload` **类型**（中间件用作 `principal.payload` 的结构类型，
编译期擦除，**零运行时 legacy 代码**）。

> 留一份没有调用者的签发实现，等于给下一个人一个现成的第二套认证入口 —— 故整体删除，
> 而非移到 test-only。测试侧改用本地假 Supabase 铸造 token，不需要 legacy 签发能力。

---

## 6. Legacy Validation Removed

`middleware/auth.ts` 第 3 级分支删除。末尾行为：

```ts
// 走到这里说明：token 既不是 APP_SECRET，也不是本 issuer 签发的 Supabase token。
// 一律 401，绝不回退到任何其他验签方式。
res.status(401).json({ error: 'Invalid bearer token.' });
```

Supabase 身份解析失败仍保持 **403 `IDENTITY_NOT_PROVISIONED`**，fail closed，
**不自动 provision**（产品决策，未放宽）。

---

## 7. Legacy Config Removed

```
config.ts   acceptLegacy 整块删除
            AUTH_ACCEPT_LEGACY 环境变量不再被读取
```

**没有留下「legacy disabled」这种假开关。** 目标态是 legacy path **absent**。

前端同步清理：`IssuedTokens` 接口、`saveTokens()` 均已成孤儿，一并删除。

---

## 8. Service Principal Status

**保留，且与 legacy user authentication 严格区分。**

| 检查项 | 结论 |
|---|---|
| 1. 是否有真实 caller | ✅ 有。`requireAuth` 第 1 级（特权端点，`server.ts:62`）；`checkWsAuthToken` ← `routes/gemini.ts:48`（Gemini Live WebSocket，前端用 `VITE_APP_SECRET` 拼 WS URL） |
| 2. 使用场景 | 内部工具 / 服务器到服务器 / WebSocket 升级（无法设任意 HTTP 头） |
| 3. 是否 internal / server-to-server | ✅ 是 |
| 4. 缺 secret 是否 fail closed | ✅ `if (config.appSecret && ...)` —— secret 为空时该分支**永不成立** |
| 5. 是否可能被普通用户路径触发 | ❌ 否。用户持有的是 Supabase token，不可能等于 `APP_SECRET` |
| 6. 是否允许取得 user identity | ❌ 否。铸出的是 `kind: 'service'`，**没有 user** |

**`requireAppSecret`**：仍然**零路由挂载** → `DEAD ARCHITECTURE CANDIDATE`（RB-25）。
按指令本轮不删除，避免扩大 scope。

---

## 9. Identity Resolution Proof

关键安全边界**保留并测试**：

```
Supabase auth.users.id
  → legacy_user_map（deterministic mapping）
  → principal.user.id（canonical SQLite）
解析失败 → 403 IDENTITY_NOT_PROVISIONED
```

`auth-m7-identity.test.ts` **19 项**覆盖，全部通过：

```
mapping_status = provisioned          → 放行
              needs_provision         → 403
              provision_failed        → 403
              skipped_test_account    → 403（不因"测试账号"放宽）
              未知值                   → 403（白名单，不是黑名单）
完全没有映射                            → 403
映射存在但 canonical 用户不存在           → 403
supabase_user_id 为 NULL 的映射行不可匹配 → 403
ghost 身份无法写任何业务端点，数据库不留痕
principal 携带两个身份：authId=Supabase UUID，user.id=canonical
requireAdmin 用 authId 查角色（不是 canonical id）
token 里的 name/avatar 不得进入业务身份
token 自称 admin 不产生管理员权限
```

**不自动创建 local user · 不拿 Supabase UUID 当 SQLite id · 不回落 email ·
不回落 legacy identity · 不静默继续。** 全部由上述测试守住。

---

## 10. Security Negative Tests

**新增 3 项**（M7 落地的直接证明）：

| 用例 | 结果 |
|---|---|
| legacy 自签 HS256 token（按旧实现方式签发）→ 401 | ✅ PASS |
| 5 个已移除端点 → 一律 404 | ✅ PASS |
| 畸形 bearer（`Bearer` / `Bearer ` / `not-a-jwt` / `Basic abc` / `a.b.c`）→ 401 | ✅ PASS |

**已有覆盖**（`auth-m7-identity.test.ts`）：

| 要求 | 覆盖 |
|---|---|
| malformed bearer → rejected | ✅ |
| expired / invalid Supabase token → rejected | ✅ 伪造签名 401 · 过期 401 · issuer 不符 401 |
| valid Supabase token without application identity → 403 | ✅ |
| student Supabase token cannot become admin | ✅ token 自称 admin 无效 |
| removed `_promote` endpoint → unavailable | ✅ smoke 中带 APP_SECRET 打也是 404 |

**真实 Supabase 网络相关用例**：`BLOCKED_BY_ENV`（见 §13），未 fake pass。

---

## 11. Static Search Proof

active production source（`backend/src` + `services`，排除 `/test/` 与注释行）：

| 符号 | 引用数 |
|---|---|
| `issueTokens` | **0** ✓ |
| `verifyAccess` | **0** ✓ |
| `verifyRefresh` | **0** ✓ |
| `revokeRefresh` | **0** ✓ |
| `acceptLegacy` | **0** ✓ |
| `AUTH_ACCEPT_LEGACY` | **0** ✓ |
| `IssuedTokens` | **0** ✓ |

端点注册处：

```
/api/auth/register  0    /api/auth/change-password  0
/api/auth/login     0    /api/auth/logout          0
/api/auth/refresh   0    /api/auth/_promote        0
```

**仍存在但已说明的**：

| 位置 | 说明 |
|---|---|
| 注释 | `middleware/auth.ts` / `auth/users.ts` / `routes/auth.ts` 保留了「这里曾经有什么、为什么删」的说明，防止后人重新引入 |
| `auth/jwt.ts` | 仅剩 `AccessPayload` 类型，编译期擦除 |
| `db.ts` `refresh_jti` 表 | **未删除** —— 删表属 destructive migration，本轮禁止。已无写入方，记入 RB-27 |
| 测试 | `smoke.test.ts` 顶部保留 7 项被删测试的清单与理由 |

---

## 12. Full Test Accounting

| 套件 | PASS | FAIL | SKIPPED | BLOCKED_BY_ENV | NOT_IMPLEMENTED |
|---|---|---|---|---|---|
| 前端 vitest（20 files） | **181** | 0 | 0 | 0 | — |
| 后端 `test:local` | **138** | 0 | 0 | 0 | — |
| 后端 `test:external` | **0** | 0 | **6** | **6** | — |
| **合计（可执行）** | **319** | **0** | **6** | **6** | — |

```
前端 typecheck  clean       后端 typecheck  clean       build  exit 0
```

**专项回归**：

| 项 | 结果 |
|---|---|
| Christian Profile golden | **20/20**，3 个 snapshot **未变** —— M7 未让算法漂移 |
| startup guard (RB-06) | 含在 138 内，全绿 |
| auth adapter presence | 含在 138 内，全绿 |
| prayer / voice / presence / 阅读位置 | 含在 181 与 138 内，全绿 |

### 测试增减 —— 无一被删以换绿灯

```
删 7 项  对 /api/auth/{register,login,refresh} 的直接测试
        理由：测的是**已经不存在的 active production behavior**。
        等价安全保证由 auth-m7-identity 的 19 项承担，覆盖面比原来更强。
        被删清单与理由就地写在 smoke.test.ts 顶部。

增 3 项  AUTH-M7 否定式（legacy token 401 / 已移除端点 404 / 畸形 bearer 401）

迁 28 项 把注册当 fixture 的测试改用本地假 Supabase 铸造 token，
        一项未删。做法是替换 helper 的**实现**而非 28 个调用点 ——
        返回形状保持 { user, accessToken } 兼容。

后端 test:local  135 → 138
```

---

## 13. External AUTH Tests

```
credential-recovery.test.ts          0 pass / 1 skipped
credential-recovery-expiry.test.ts   0 pass / 1 skipped
identity-migration.test.ts           0 pass / 1 skipped
password-change-reauth.test.ts       0 pass / 1 skipped
redirect-matrix.test.ts              0 pass / 1 skipped
supabase-auth.test.ts                0 pass / 1 skipped
```

状态维持 **`IMPLEMENTED / ENVIRONMENT-UNVERIFIED`**。

> **AUTH-M7 code completion ≠ AUTH integration verification.**
> 本轮全部验证在本地假 Supabase 上完成。真实 Supabase 项目上的行为未验证。

---

## 14. Commits

```
d564c4c  AUTH-M7：删除 legacy user authentication（不是默认关闭）
         main = origin/main = d564c4c   ahead/behind 0/0
```

推送前 `git fetch origin` 复核：`origin/main = 8d5b51b`（本会话上轮推送值），
本轮期间无他人提交，本地包含 origin/main → 可安全推进。

---

## 15. Documentation Updates

| 文件 | 内容 |
|---|---|
| `DECISION_LOG.md` | **D-17** AUTH-M7 必须先于 RB-01（canonical identity 稳定后才能迁移用户数据） |
| `OPEN_ISSUES.md` | **RB-26** 未在真实 Supabase 验证 · **RB-27** `refresh_jti` 无写入方 · **RB-28** `VITE_SUPABASE_*` 成为硬依赖 |
| `ACCEPTANCE_HISTORY.md` | append-only 追加 AUTH-M7 条目，测试按 PASS/FAIL/SKIP 分列 |
| `CURRENT_STATE.md` | 基线更新为 181 / 138 / 6 SKIP |

---

## 16. Remaining AUTH Issues

| ID | 内容 | Sev |
|---|---|---|
| **RB-26** | AUTH-M7 未在真实 Supabase 环境验证 | P2 |
| **RB-22** | 6 个 external AUTH 测试 BLOCKED_BY_ENV；历史数字不可复现 | P2 |
| **RB-28** | `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` 成为硬依赖，**部署清单必须包含** | P2 |
| **RB-27** | `refresh_jti` 表已无写入方，待独立迁移清理 | P3 |
| **RB-25** | `requireAppSecret` 零路由，dead architecture candidate | P3 |

---

## 17. Recommended Next Step

按 D-17，AUTH-M7 已达 `IMPLEMENTED / LOCALLY VERIFIED`，
下一阶段自动进入 **RB-01 DATABASE MIGRATION — PHASE DB-0**：

```
仅限：SQLite schema inventory
     SQL usage inventory
     identity mapping inventory
     Postgres target schema design
不得修改 DAL。产出数据库事实报告后再由 Supervisor 决定 DB-1。
```

**一处需要你注意的部署影响**（RB-28）：M7 之后 `VITE_SUPABASE_URL` /
`VITE_SUPABASE_ANON_KEY` 是硬依赖 —— 未配置时 App **不能登录**（会抛 503
并说明原因，而不是静默 404）。这是目标态而非缺陷，但部署清单必须包含这两项。

---

# 状态

```
AUTH-M7 IMPLEMENTED / LOCALLY VERIFIED
```

legacy user authentication 已从 active production code **删除**，不是默认关闭。
全部验证在本地完成，真实 Supabase 环境未验证。
按 Supervisor 规定，**不使用** INTEGRATION VERIFIED / STAGING VERIFIED / PRODUCTION VERIFIED。
