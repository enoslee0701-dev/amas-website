# AUTH RECONCILIATION REPORT

**日期**：2026-09-07 · **阶段**：Phase R1
**执行**：两侧基线冻结 → 5 处冲突手工解决 → 修正一次静默丢功能 → R1-3 legacy 政策 → 全量回归 → merge commit
**约束遵守**：未做 DAL 重构 / SQLite→Postgres / UX 重写 / 新功能 / CP 修改 / Course model 重构 / 无关清理

> ## ⛔ 结论前置：合并已完成并本地验证，但**尚未 push**
>
> 收尾时发现**另一条工作流正在并行做同一件事，且已走到 AUTH-M7**。
> 这是一次真实的 R-9 并发碰撞。在你裁定采用哪条世系之前，我不推送。
> 详见 §13。

---

## 1. Pre-Merge Main Baseline

```
commit    a43597bd8522b04ea243da1ae7efeabdca5a477c
subject   RB-06 生产启动护栏 + CP 算法回归护栏 + 项目记忆同步
tree      clean

前端  vitest        18 files / 158 tests / 158 pass / 0 fail / 0 skip
后端  node --test   116 tests / 116 pass / 0 fail / 0 skip
      （smoke 103 + startup-guard 13）
typecheck  前端 clean · 后端 clean
build      exit 0
```

## 2. Pre-Merge Auth Baseline

在**独立 worktree** 中测量（R-9：高风险任务不共享工作树），依赖独立安装。

```
commit    4af8307ae711c45389967b1439ab7c539f4be62b
subject   文档修正：adb 示例改用非秘密占位值…

前端  vitest        17 files / 135 tests / 135 pass / 0 fail
后端  node --test    88 tests /  88 pass / 0 fail / 0 skip（仅 smoke）
typecheck  前端 clean · 后端 clean
build      exit 0
```

### AUTH 验收测试 —— 全部 `BLOCKED_BY_ENV`，不计为 PASS

逐个实跑，无一例外：

| 文件 | tests | pass | fail | skipped |
|---|---|---|---|---|
| `credential-recovery.test.ts` | 1 | **0** | 0 | **1** |
| `credential-recovery-expiry.test.ts` | 1 | **0** | 0 | **1** |
| `identity-migration.test.ts` | 1 | **0** | 0 | **1** |
| `password-change-reauth.test.ts` | 1 | **0** | 0 | **1** |
| `redirect-matrix.test.ts` | 1 | **0** | 0 | **1** |
| `supabase-auth.test.ts` | 1 | **0** | 0 | **1** |

原因：均在缺 `AMAS_ENV` / `staging.env` 时整组跳过（设计如此，避免 CI 假失败）。

> **历史报告中的 23/23、8/8、17/17、20/20、135/135 目前一条都复现不了。**
> 那些数字是当时有人在本机带环境跑出来的，**不构成持续保护**。RB-22 由此获得硬证据。

---

## 3. Conflict Resolution

`git merge --no-commit --no-ff` 实际产生 **5 处冲突**（低于预测的 10 处；
`db.ts` / `routes/prayer.ts` / `PrayerRoomPanel.tsx` / `package*.json` 自动合并成功）。

### 3.1 自动合并的语义校验（最危险的一处）

`db.ts` 未报冲突，但必须人工确认两侧 schema 都在：

| 标记 | 出现 | 归属 |
|---|---|---|
| `room_reading_state` | 1 ✓ | main（P1-2 共享阅读位置） |
| `author_state` | 3 ✓ | auth（R-10 tombstone） |
| `deleted_account` | 1 ✓ | auth |
| `user_id TEXT,`（可空） | 3 ✓ | auth |

`routes/prayer.ts`：`author_state` 3 处 ✓ + presence 10 处 ✓ 并存。
阅读位置逻辑在独立文件 `routes/roomReading.ts`，未被本次合并触及。

### 3.2 五处冲突逐一处置

| 文件 | 处置 | 理由 |
|---|---|---|
| `.gitignore` | **两侧全保留** | 规则互不冲突，无一丢弃 |
| `backend/src/auth/users.ts` | 取 main 侧 | 两侧都删了 `promoteToAdmin`；main 额外留了「为什么删、别再留无调用者的提权函数」的说明，有长期价值 |
| `backend/src/routes/auth.ts` | **合并两侧说明** | main 讲「一次性机器凭据变成挂在真人账号上的持久管理员权限」；auth 讲「Supabase 成为唯一授权 SoT 后它是第二套权限入口」。两条理由都成立，都保留 |
| `backend/src/test/smoke.test.ts` | 取 main 侧 + 删孤儿 | main 的 `seedAdminInFixtureDb` **断言 `changes === 1`**，播种失败会立刻报错；auth 版本无断言。合并后 auth 的 `seedAdmin`/`SMOKE_DB` 已无调用者，一并删除——留一个写入另一个数据库的播种函数只会给下一个人一个现成的坑 |
| `backend/src/test/supabase-auth.test.ts` | **恢复** | main 曾于 `d3e860d` 删除，理由是「AUTH 代码不该以未验收状态留在 Prayer Room 基线上」；本次正式合并使该前提消失 |

### 3.3 ★ 修正一次静默丢功能（本轮最重要的发现）

**问题**：`d3e860d` 从 main 删除了 `backend/src/auth/supabase.ts`、`services/supabaseAuth.ts`
等实现文件。auth 分支之后未再修改它们，git 遂判定「一侧删除、一侧未改 → 删除生效」，
**不报冲突**。

**后果**：合并把 `supabase-auth.test.ts`（266 行）带回来了，**却没带回被测代码**。
而且 **typecheck 仍然是绿的** —— 该测试 spawn 子进程运行服务器，不直接 import 模块。
若不逐文件核对，这次合并会以「全绿」的姿态交付一个**空的 AUTH reconciliation**。

**处置**：先核实 main 在 `d3e860d` 之后**未再改动**这些文件（0 个提交），
且 auth 侧即 merge-base 版本，故取 auth 侧恢复，不覆盖任何 main 独有改进：

```
backend/src/auth/supabase.ts       144 行
backend/src/middleware/auth.ts     240 行   （含 AUTH-M2 的 fail-closed 修复）
backend/src/config.ts               92 行
services/supabaseAuth.ts            75 行
services/authService.ts            415 行
package.json                       补回 @supabase/supabase-js ^2.114.0
```

---

## 4. Authentication Architecture After Merge

`middleware/auth.ts` 三级身份路径，每一类都有明确用途，**无来历不明的认证入口**：

| # | 路径 | 用途 | 实现 |
|---|---|---|---|
| 1 | **service principal** | 机器对机器（内部工具、CI） | `APP_SECRET` 常数时间比较；`APP_SECRET` 为空时该分支永不成立 |
| 2 | **Supabase user** | 目标态的唯一用户身份来源 | 本地 JWKS **ES256 非对称验签**，后端不持有任何 Supabase secret；角色**每次现查不缓存**，保证撤销即时生效；**不检查 `aal`**（普通 student 全程 AAL1 即可学习） |
| 3 | **legacy user** | **临时迁移兼容**，AUTH-M7 移除 | 自签 HS256 token，受 `acceptLegacy` 控制 |

**fail closed**：无凭据一律 401，**不因 `APP_SECRET` 未配置而放行**（AUTH-M2 修复，两侧均有）。

**提权后门已根除**：全后端 `promoteToAdmin` 仅剩 1 处注释；`_promote` 仅出现在注释与测试中；
**无任何活跃提权路由**（`grep` 路由注册零命中）。`SET role` 的其余出现为
`room_members`（房间运营权，不同权限域）与测试内直写。

---

## 5. Legacy Auth Status

**R1-3 政策已实施**（`backend/src/config.ts`）：

```ts
acceptLegacy: (() => {
  const raw = envOr('AUTH_ACCEPT_LEGACY');
  if (raw) return raw !== 'false';                       // 显式设置优先
  return (process.env.NODE_ENV ?? '').trim() !== 'production';
})(),
```

| 环境 | 缺省 | 依据 |
|---|---|---|
| **production** | **关闭** | 不得因环境变量缺失而默认打开双轨。要保留必须显式 `AUTH_ACCEPT_LEGACY=true` |
| development / test | 开启 | 不断掉现有迁移链——现有测试仍依赖 legacy token |

**AUTH-M7 移除计划**：本开关是过渡设施，M7 落地后整体删除。
当前 main 上 **AUTH-M7 未实施**（但另一条工作流已做，见 §13）。

---

## 6. Database Schema Preservation

**两侧 schema 全部保留，无一丢失**（§3.1 已逐项核对）。
本次合并**未新增、未删除、未修改任何表结构**，仅完成两侧既有 DDL 的并集。

`db.ts` 仍是 SQLite。**本次合并不改变 Application Database SoT** —— 与 D-11 认定一致：
AUTH MIGRATION ≠ APPLICATION DATABASE MIGRATION。

---

## 7. Prayer / Voice Regression

```
前端 20 files / 181 tests / 181 pass / 0 fail
后端 116 / 116 pass / 0 fail
build exit 0，[voice-guard] ok — transport="(none)"
```

presence、共享阅读位置、房间渲染守卫、Phase 5、moderator 等既有套件全部在上述总数内且全绿。
`author_state` tombstone 与 presence/阅读位置行为并存，无一被覆盖。

---

## 8. Security Review

| 项 | 结果 |
|---|---|
| fail closed | ✓ 保留（无凭据 401，不因 secret 未配置放行） |
| `requireAdmin` 用实时 server-side role | ✓ `findById(payload.sub)` 查库，不读 JWT 声明 |
| 提权后门 | ✓ 已根除，无活跃端点 |
| service principal 可否匿名获得 | ✓ 否 |
| legacy 生产默认 | ✓ 已改为**关闭** |
| RB-06 启动护栏 | ✓ 合并后完好，13/13 |
| secret 泄漏 | ✓ 未发现 secret 进入 Git / 前端 bundle |

---

## 9. Post-Merge Test Baseline

| | main (a43597b) | auth (4af8307) | **合并后 (4c139ec)** |
|---|---|---|---|
| 前端文件 | 18 | 17 | **20** |
| 前端用例 | 158 | 135 | **181** |
| 后端用例 | 116 | 88 | **116** |
| 前端 tsc | clean | clean | **clean** |
| 后端 tsc | clean | clean | **clean** |
| build | 0 | 0 | **0** |
| FAIL | 0 | 0 | **0** |

### 测试增减核对 —— 无一丢失，全部可解释

**前端**：18 + auth 独有 2 文件（`androidDeepLinkPreflight` 127 行、`recoveryDeepLink` 42 行）= **20** ✓
158 + 那 2 文件的 23 个用例 = **181** ✓

**后端 smoke.test.ts**：

```
merge-base  88 用例
auth        88 用例   ← auth 增加 0 个用例，19 行改动纯粹是播种机制
main       103 用例   ← main 新增 15 个（P1-1 / P1-2）
合并后     103 用例   ✓
```

**专项回归**：
- Christian Profile **20/20**，3 个 golden snapshot **未变** —— 合并没让算法漂移
- 启动护栏 **13/13**

---

## 10. Merge Commit

```
SHA      4c139ec50df7f313c14056c0f8dd04bef2acbb2d
parents  a43597bd8522b04ea243da1ae7efeabdca5a477c   (main)
         4af8307ae711c45389967b1439ab7c539f4be62b   (auth/supabase-unification)
files    87 changed, 5130 insertions(+), 24 deletions(-)
状态      已提交到本地 main，**未 push**（原因见 §13）
```

---

## 11. Remaining AUTH Work

| 项 | 状态 |
|---|---|
| **AUTH-M7**（移除 legacy 自签路径） | 本世系 **NOT_STARTED**；另一世系已实施（§13） |
| 6 个 AUTH 验收测试进 CI | **BLOCKED_BY_ENV**，需 staging 或 CI secret（RB-22） |
| Supabase 侧真实配置 | 未做（production 未建立） |
| 真实邮件链路验证 | 未做（SMTP 未配置） |

---

## 12. Documentation Updates

待 §13 裁定后统一更新，避免为一条可能被废弃的世系写入记录：
`CURRENT_STATE.md` · `OPEN_ISSUES.md` · `ACCEPTANCE_HISTORY.md` · `DECISION_LOG.md`

---

## 13. New / Remaining Blockers

### ⛔ RB-23｜并发工作流碰撞：两条世系在做同一次 AUTH 合并

```
Severity:  P1
Status:    PENDING_DECISION（阻断 push）
Owner:     用户 / GPT
```

清理基线 worktree 时发现**两个不是我创建的 worktree**，属于另一个 Claude 会话
（`amas-seminar-app-24`，scratchpad 路径 `c--Users-enosl-Desktop-AMAS-Seminar-App/bcde6449-…`）：

```
integration/auth-strategy-b        78985e5
rehearsal/auth-merge-2026-09-07    03bb842   （worktree 内有 88 项未提交，仍在进行中）
```

`integration/auth-strategy-b` 的提交序列：

```
78985e5  AUTH-M7: 运行时身份解析 —— Supabase 登录成功不再等于拥有 AMAS 身份
68e4b59  merge(strategy B): auth/supabase-unification 合入 —— revert 世系后三方合并语义恢复正确
cf90eb7  Revert "revert(auth): 从 main 移出未经独立验收的 Supabase Auth 变更"
```

#### 两条世系比较

**核心 AUTH 实现文件逐字节相同** —— 殊途同归：

```
✓ backend/src/auth/supabase.ts       相同
✓ backend/src/middleware/auth.ts     相同
✓ services/supabaseAuth.ts           相同
✓ services/authService.ts            相同
```

差异仅 3 个文件：

| 文件 | 本世系 (4c139ec) | strategy B (68e4b59) |
|---|---|---|
| `config.ts` | **已实施 R1-3**：production 默认关闭 legacy | 仍为 `'true'` 默认 —— **不满足 R1-3** |
| `routes/auth.ts` | 合并两侧说明 | 取单侧 |
| `smoke.test.ts` | 删除孤儿 `seedAdmin`/`SMOKE_DB` | 保留（7 行死代码） |

**他们的方法更干净**：先 `Revert` 掉 `d3e860d`，三方合并语义自动恢复正确，
不会出现我遇到的「静默丢实现文件」。我是发现后手工 `checkout` 补回 5 个文件——
结果等价，但他们的路径更不容易出错，值得作为此类 revert 世系合并的标准做法。

**他们走得更远**：已实施 **AUTH-M7**（运行时身份解析：Supabase 登录成功 ≠ 拥有 AMAS 身份），
这正是 §11 里我这边尚未开始的工作。

#### 建议

**推荐：采用 strategy B 世系为基础，把本世系的三项差异 cherry-pick 过去。**

理由：strategy B 的合并路径更规范（revert-the-revert），且已含 AUTH-M7；
本世系的独有价值是三项策略性改进，体量小、易移植，其中
**R1-3 legacy 生产默认关闭是 Supervisor 明确要求的，strategy B 尚未满足**。

**在你裁定前我不 push**，避免在 origin 上造出第二条竞争世系。
本世系的 merge commit `4c139ec` 保留在本地 main，随时可 reset 放弃。

---

### RB-22｜AUTH 验收测试在 CI 中从未执行（本轮获得硬证据）

见 §2：6 个文件逐个实跑，**全部 0 pass / 1 skipped**。维持 P2。

---

## 14. Recommended Next Step

1. **裁定 RB-23 世系归属**（唯一阻断项）
2. 裁定后：把胜出世系推送到 origin，另一条明确废弃并记入 DECISION_LOG
3. 补齐 §12 的四份文档
4. 与另一条工作流建立明确的分工边界 —— 本次碰撞的根因是**两条工作流收到了同一个任务**，
   不是任一方操作失误

---

# 状态

```
MERGED / LOCALLY VERIFIED
```

合并已完成，三方基线逐项对比，全部测试实跑通过，无测试丢失，CP 算法无漂移。

**但未 push**：存在并发世系需先裁定（RB-23）。
按 Supervisor 规定，本阶段不得使用 INTEGRATION VERIFIED / STAGING VERIFIED /
READY FOR PRODUCTION / PRODUCTION VERIFIED。
