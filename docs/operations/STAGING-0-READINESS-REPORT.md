# STAGING-0 READINESS REPORT

**AMAS · STAGING-0 —— Supabase Staging 就绪度设计与审计**
日期：2026-09-07 · 执行：Claude · 性质：**只设计、审计、准备**

> **最终状态：`STAGING-0 NEEDS OWNER ACTION`**
>
> 技术侧该做的都做完了，且**迁移交付通道已在本地真实验证跑通**（§4–§5）。
> 剩下的全部是需要 Product Owner 提供或授权的资源与凭据（§20）。
> **本轮未创建任何资源、未申请任何付费服务、未创建任何账号、未开始 DB-4。**

---

## 1. Current Readiness

| 维度 | 现状 | 证据 |
|---|---|---|
| **Schema** | ✅ `0001`–`0026` 在 PG 17.6 上 26/26 应用成功 | DB-3.5 · DB-6 · DB-6.1 |
| **Schema 契约** | ✅ DB-3 53/53 · DB-6 36/36（17.6 与 18.6 各一次） | 同上 |
| **回退** | ✅ DB-3 / DB-6 回退均已实测，逐列零残留 | DB-3.5 §6 · DB-6 §12 |
| **迁移交付通道** | ✅ **本轮已验证**（§4） | 见下 |
| **迁移版本记账** | ✅ 已有 canonical SoT，无需自建（§6） | 见下 |
| **Staging Supabase 项目** | ⚠ **本地留有此前 `supabase link` 的缓存**，证实项目曾存在且为 PG **17.6.1.166**（§3.1）。但本机**无已登录的 CLI 访问令牌**，因此**无法核实它当前是否仍存活** | `supabase/.temp/`（已 gitignore） |
| **Supabase 凭据** | ❌ 本地 `NOT CONFIGURED` | §16 |
| **SMTP** | ❌ `NOT CONFIGURED` —— BLOCKER-02 | §15 |
| **Production 域名** | ❌ `DECISION_REQUIRED` —— D-8 | §14 |
| **Backend 部署目标** | ❌ 不存在 | §13 |
| **Backend DAL** | ❌ **仍是 SQLite**（DB-12 未开始） | §13 |
| **DB-4 身份迁移** | ⛔ `BLOCKED_BY_EXTERNAL_ENV` | §9 · §10 |
| **6 个 AUTH external 测试** | ⛔ `NOT RUN / BLOCKED_BY_ENV` | §11 |
| **RLS runtime** | ⛔ `ENVIRONMENT-UNVERIFIED` | §12 |

---

## 2. Staging Architecture

**原则：Staging 与 Production 必须隔离**（D-40）。下表每一行都独立成实例，不与 production 共享。

| 组件 | purpose | staging 实例必需？ | 将来需要 production 实例？ | 共享 or 隔离 | credential type | 网络 / 访问路径 |
|---|---|---|---|---|---|---|
| **AMAS Website（官网 + Portal）** | 招生官网 · 申请入口 · Portal 前端 | ✅ 必需 | ✅ | **隔离** —— 独立部署目标 | 无后端密钥；只有 Supabase `anonKey`（公开值） | 静态托管（当前 GitHub Pages from `master`；staging 需另一个部署目标） |
| **AMAS App Frontend** | Capacitor / Web 前端 | ✅ 必需 | ✅ | **隔离** —— 独立 build 产物 | `VITE_SUPABASE_ANON_KEY`（公开值） | 静态托管 / 移动端打包 |
| **AMAS Backend API** | App 业务 API（房间 / 祷告 / 社群 / 课程附件 / 推送） | ✅ 必需 | ✅ | **隔离** | `SUPABASE_SERVICE_ROLE_KEY`（**高敏**）· `APP_SECRET` · `JWT_SECRET` | 需要一个 Node ≥20 的托管；**当前有本地文件系统依赖**（§13） |
| **Supabase Auth (GoTrue)** | 唯一用户身份来源（D-2B-1 方案 A） | ✅ 必需 | ✅ | **隔离**（不同 project） | 项目内建 | `https://<ref>.supabase.co/auth/v1` |
| **Supabase PostgreSQL** | Portal + App 的唯一数据库 | ✅ 必需 | ✅ | **隔离**（不同 project） | DB 连接串（**高敏**） | 迁移经 §5 通道；运行期经 PostgREST / 后端 |
| **SMTP** | 邮箱验证 · 密码重置 | ⚠ 见 §15 | ✅ | **隔离**（收件人白名单） | SMTP 凭据（**高敏**） | Supabase Auth 的自定义 SMTP 配置 |
| **Storage** | 课程附件 · 图片 · 录音 | ⚠ **本阶段不必需** | ✅ | 隔离 | 同项目凭据 | 当前后端写本地 `uploads/`，迁 Storage 属 DB-12 之后 |
| **LiveKit** | 实时语音 | ❌ **本阶段不需要** | 待定 | 隔离 | `LIVEKIT_*` | Phase 4B 已 BLOCKED，与 staging 入场无关 |

> **Storage 与 LiveKit 刻意排除在 STAGING-0 之外** —— 把它们拉进来只会让入场门槛变高，
> 而它们都不影响本阶段要解决的三个卡点（身份迁移 / AUTH 外部测试 / RLS runtime）。

---

## 3. Required Supabase Resources

**只列需求，不创建。**

| 项 | 要求 | 理由 |
|---|---|---|
| Project | 1 个**独立** staging project | D-40 隔离 |
| Region | 建议 `ap-southeast-1`（新加坡） | 与已记录的 `amas-staging` 一致；对泰国清迈延迟合理 |
| **PostgreSQL 版本** | **必须 17.6** | DBR-22 的同款要求：DB-3/DB-6 的验证基准就是 17.6 |
| Auth | 启用 | 唯一身份来源 |
| Database | 启用 | Portal + App 共库 |
| Storage | **本阶段不启用** | §2 |
| Realtime | **本阶段不启用** | App 实时事件当前走后端轮询表，未接 Supabase Realtime |

### 3.1 本地缓存中的既有 staging 事实（本轮新发现）

`supabase/.temp/` 保留着**此前某次 `supabase link` 的缓存**
（本轮全程用 `--db-url`，未执行 link，因此这些不是本轮产生的）。
该目录已被 `supabase/.gitignore:3` 忽略，**未进入 Git**，且**不含任何口令**
（`pooler-url` 只有 `用户名@主机`，口令不在其中）。

| 缓存项 | 值 | 意义 |
|---|---|---|
| `project-ref` | `sdrwyebizfdwldlfjyim` | 与 HANDOFF 记录一致 |
| `linked-project.json` → name | `amas-staging` | 同上 |
| `pooler-url` → region | `aws-0-ap-southeast-1` | 新加坡，符合 §3 建议 |
| **`postgres-version`** | **`17.6.1.166`** | ✅ **与 DB-3.5 的 gate 版本一致** —— 项目 link 时确为 PG 17.6 |
| `gotrue-version` | `v2.196.0` | Auth 服务存在 |
| `rest-version` | `v14.5` | PostgREST 存在 |

**这把 §19 第 1 项从「完全未知」变成「曾经存在且版本正确」。**
仍需 Owner 确认的是：**它现在是否仍然存活、是否仍在同一版本**。
本机没有已登录的 CLI 访问令牌，因此**无法只读核实当前状态** ——
这也是刻意的：核实需要 Owner 的账号授权，不应由我自行取得。

---

### 需要的配置项（**只写变量名与用途，不写值**）

| 变量名 | 消费方 | 敏感度 | 用途 |
|---|---|---|---|
| `SUPABASE_URL` | Backend（`backend/src/config.ts:52`） | 低（公开） | JWKS 验签 issuer · PostgREST 基址 |
| `SUPABASE_SERVICE_ROLE_KEY` | Backend（`config.ts:53`） | **高** | 角色现查 · profiles 回落读取。**绝不下发到任何客户端** |
| `VITE_SUPABASE_URL` | App 前端（`services/supabaseAuth.ts`） | 低（公开） | Supabase Auth 客户端 |
| `VITE_SUPABASE_ANON_KEY` | App 前端（同上） | 低（公开，受 RLS 约束） | Supabase Auth 客户端 |
| `window.SUPA.url` / `window.SUPA.anonKey` | Portal 官网（`assets/js/supabase-config.js`） | 低（公开） | 官网提交写入 `submissions` |
| database connection string | 迁移通道（§5） | **高** | `supabase db push --db-url` |
| JWKS 端点 | Backend 自动推导 | — | `${SUPABASE_URL}/auth/v1/.well-known/jwks.json`（ES256，`jose` 内建缓存轮转） |

> **JWT/JWKS 无需单独配置**：后端由 `SUPABASE_URL` 推导 issuer 与 JWKS 地址
> （`backend/src/auth/supabase.ts:39,45`），不使用共享 JWT secret。

### ⚠ 本轮发现的缺口

**两份 `.env.example` 都没有列出任何 `SUPABASE_*` 变量**，
而前后端都依赖它们。这不是运行期缺陷，是**上手缺陷**：
照着 `.env.example` 配置的人会得到一个「登录直接 503」的环境却不知道缺什么。
记为 **RB-29**（§21）。

---

## 4. Migration Delivery Options

三种方式，评价维度统一。**其中 Option B / C 本轮已在本地真实跑通**（靶子是本地 PG 17.6，不是任何真 Supabase）。

### Option A — CI Migration Runner

```
Git migration files → CI（受保护环境）→ staging DB
```

| 维度 | 评价 |
|---|---|
| security | **最好** —— 凭据只存在于 CI 的 protected secret，本机不落盘 |
| reproducibility | **最好** —— 每次都是干净 runner，无「我本地能跑」 |
| auditability | **最好** —— 每次执行有 run 记录、日志、触发人 |
| rollback | 中 —— 需要额外把回退脚本也做成 job |
| secret handling | **最好** |
| operator complexity | **较高** —— App 仓已有 `.github/workflows/ci.yml`，但 **website 仓当前完全没有 CI**，要从零建 |

### Option B — Controlled `psql`

```
已批准的 staging 连接 → psql → 版本化 migrations
```

| 维度 | 评价 |
|---|---|
| security | 中 —— 凭据出现在操作者机器上；靠 `.env` + gitignore 与操作纪律 |
| reproducibility | 中 —— 顺序靠脚本或人，**没有版本记账**（除非自建，而 TASK 4 禁止） |
| auditability | **弱** —— 只有本地 shell 记录 |
| rollback | 好 —— 回退脚本已存在且已实测 |
| secret handling | 中 |
| operator complexity | **最低** —— 本轮 DB-3/DB-6 全程用的就是它 |

### Option C — Supabase CLI Remote Operations

```
supabase db push --db-url <staging 连接串>
```

**不假设，本轮实测：**

| 检验项 | 结果 |
|---|---|
| 是否需要 Docker | **不需要** —— `db push --db-url` 直连远端，只有 `supabase start` 才要 Docker |
| 是否需要 `link` | 不需要 —— `--db-url` 即可 |
| 是否接受现有 `0001_` 命名 | ✅ **接受**，26 个全部按序识别（CLI 通常生成 14 位时间戳前缀，但 4 位数字前缀同样被解析） |
| 实际应用 | ✅ 26/26 全部 applied |
| 版本记账 | ✅ 写入 **`supabase_migrations.schema_migrations`**（version + name），26 行 |
| 幂等重放 | ✅ 第二次执行返回 `{"upToDate":true,"migrations":[]}` |
| 差异查询 | ✅ `supabase migration list --db-url` 输出 local / remote 逐条对照 |
| 输出可解析 | ✅ 全部 JSON，适合 CI 断言 |
| 产出是否与 psql 通道一致 | ✅ **`information_schema.columns` 全表 md5 完全相同**；在 CLI 推出来的库上跑 DB-3 契约 **53/53 PASS** |

> 实测连接串需要 `?sslmode=disable`（本地无 SSL）；**真实 Supabase 必须使用 TLS，不得沿用该参数**。

---

## 5. Recommended Migration Channel

> # 推荐：**Option C（Supabase CLI `db push`）作为执行引擎 + Option A（CI）作为执行外壳**
>
> 过渡期允许 **Option B 受控 `psql`** 作为应急通道。

理由：

1. **只有 Option C 自带版本记账。** `psql` 通道无法回答「staging 现在跑到第几个 migration」——
   而这正是 TASK 4 要解决的问题。CLI 用的是 Supabase 官方的 `supabase_migrations.schema_migrations`，
   不需要自建第二套系统（TASK 4 明令禁止）。
2. **本轮已证明它不需要 Docker**，因此 D-39 成立，不必为了 staging 去装 Docker。
3. **它产出的 schema 与 psql 通道逐字节一致**（md5 相同 + 契约 53/53），
   所以切换通道不会改变已验证的结果。
4. CI 外壳解决 Option C 唯一的短板 —— 凭据与审计。
   凭据放 CI protected secret，本机不落盘；每次执行有 run 记录。
5. **不推荐纯 Option B**：它最省事，但「最容易手工漏 migration」正是要避免的目标。

### 落地顺序建议

| 阶段 | 通道 | 说明 |
|---|---|---|
| 首次 bootstrap | **Option C 手动执行**（受控环境，操作者本机） | 首次要人盯着，CI 反而不便于观察 |
| 之后每次变更 | **Option A + C**（CI 里跑 `supabase db push`） | 常态 |
| 应急 | Option B `psql` | 仅在 CLI 不可用时，且事后必须用 `supabase migration repair` 补记账 |

> **硬性要求**：无论走哪条，**都必须先 `--dry-run`**，确认待推列表符合预期再执行。

---

## 6. Migration Version Tracking

**已有 canonical SoT，直接复用，不自建。**

```sql
supabase_migrations.schema_migrations  (version, name, …)
```

本轮实测（本地靶库）：

```
version | name
0001    | init
…
0026    | app_community
(26 行)
```

三个问题的回答方式：

| 问题 | 命令 |
|---|---|
| **Current staging migration version** | `supabase migration list --db-url <conn>` → 每条的 `remote` 字段 |
| **Expected migration version** | 同一输出的 `local` 字段（= 仓库里的文件） |
| **Pending migrations** | `supabase db push --db-url <conn> --dry-run` → `Would push these migrations` |

**禁止**再建任何与它冲突的记账系统。

> `migration.schema_baseline`（DB-3 建的那张）**不冲突**：它记的是「本套 schema 对应哪个 SQLite 源基线」，
> 是**溯源**而不是**执行进度**，两者职责不同。

---

## 7. Bootstrap Order

按真实依赖排过序 —— 原清单里「Configure Auth」在「Apply migrations」之前，
但 `0002_identity.sql` 依赖 `auth.users` 已存在，而 Supabase 建项目时就自带 `auth` schema，
所以 Auth 的**存在**是自动的，需要配置的是**行为**（redirect / SMTP / confirmations），
那部分应当在迁移之后、跑测试之前。

| # | 步骤 | 依赖 | 完成判据 |
|---|---|---|---|
| 1 | 创建 staging Supabase project（**PG 17.6**，`ap-southeast-1`） | Owner | 项目可访问 |
| 2 | 记录连接串与 keys 到受控 secret 存储 | 1 | §16 的三处各就位 |
| 3 | **确认迁移通道可连通**：`supabase db push --dry-run` | 2 | 输出「Would push 26 migrations」 |
| 4 | **建立 pre-migration 备份点** | 3 | §17 —— 空库也要有，用于确认 restore 流程可用 |
| 5 | 应用 `0001` → `0026` | 3,4 | `db push` 返回 26 applied |
| 6 | **验证 schema**：DB-3 契约 53 + DB-6 契约 36 | 5 | 89/89 PASS |
| 7 | 配置 Auth 行为：site_url · redirect URLs · confirmations | 5 | §14 的 redirect matrix 可跑 |
| 8 | 配置 SMTP（或明确采用 autoconfirm 并标注） | 7 | §15 |
| 9 | 播种**仅限已批准的 staging fixtures** | 6 | §8 · D-34 |
| 10 | 配置 App backend（`SUPABASE_URL` / `SERVICE_ROLE_KEY` / `CORS_ORIGINS`） | 2,5 | `GET /api/health` 200 且启动护栏通过 |
| 11 | 配置 App 前端 build（`VITE_SUPABASE_*`） | 2 | 登录页不再 503 |
| 12 | 配置 Portal 官网 `supabase-config.js` | 2 | 提交写入 `submissions` |
| 13 | **DB-4 identity 演练**（dry-run → review → apply → verify → rerun） | 9,10,11 | §10 |
| 14 | 跑 **6 个 AUTH external 测试** | 8,10,11 | §11 |
| 15 | 跑 **RLS 否定式矩阵** | 9,11 | §12 |
| 16 | 跑 **E2E 验收矩阵**（63 用例） | 10–15 | 目前 53 BLOCKED_BY_ENV 应转为实际结果 |

> 第 4 步刻意提前：**在还没有数据的时候先验证一次 restore 流程**，
> 成本最低。等有了数据才第一次尝试恢复，就是在最坏的时刻做最不熟的操作。

---

## 8. Staging Data Policy

**D-40：Staging 与 Production 的数据群体隔离；staging fixtures 默认永不成为 Production 身份。**

### Allowed（可以有）

| 类别 | 说明 |
|---|---|
| synthetic test users | 明确 test 标识的合成账号（如 `staging+student1@<staging域>`），可随时重建/销毁 |
| staging-only applicants | 走真实申请流程产生的测试申请 |
| staging-only students | 由 staging applicant 经真实流程转正的测试学籍 |
| course references | `course_catalog` 的 67 条正式课程（**它们是配置数据，不是个人数据**） |
| program catalog | 9 个项目 · 4 个开放申请 |
| non-sensitive fixtures | 公告 · 图书条目 · 内置房间等无个人信息的内容 |

### Conditionally Allowed（需明确批准，逐条）

| 类别 | 条件 |
|---|---|
| sanitized copy | 必须去标识化：邮箱 / 姓名 / 电话 / 学号全部替换；且**须 Product Owner 逐次批准** |
| 特定的已批准 legacy 记录 | 仅在 DB-4 演练需要时，且只用于**验证映射逻辑**，不得作为正式人口 |

### Forbidden（禁止）

| 类别 | 理由 |
|---|---|
| 未经批准的 production 个人数据 | 隐私 |
| production secrets | 泄露面 |
| 真实用户口令（任何形式，含 hash） | AUTH-M7 已删除 legacy 凭据体系；复制凭据是纯负债 |
| production service-role 凭据 | 一旦泄露即全库可读写 |
| **把旧的 6 个 legacy 测试账号当作「迁移成功人口」** | D-34 · §7 |

---

## 9. Esther Identity Verification Plan

> # `ESTHER_IDENTITY_VERIFICATION_PLAN`
>
> **本阶段只设计流程。本轮未创建、未修改、未查询任何真实账号。**

对象：`estherzh0528@gmail.com` —— 状态 `POTENTIAL_REAL_USER` / `IDENTITY_VERIFICATION_REQUIRED`（D-35）。
它是 7 个 legacy 账号中**唯一**可能对应真人的一个（其余 6 个见 §7）。

### 证据采集顺序

| # | 步骤 | 数据源 | 产出 |
|---|---|---|---|
| 1 | **legacy identity evidence** | SQLite `users`（只读）：`id` / `email` / `name` / `created_at` / `role` / 关联业务数据行数 | legacy 侧画像 |
| 2 | **Supabase identity lookup** | staging Auth：按邮箱查是否已有账号；记录 `auth.users.id` / `created_at` / 确认状态 | 是否已存在 |
| 3 | **profile lookup** | staging `public.profiles`：是否已有对应 `profiles.id` 及其 `display_name` / `account_status` | canonical 侧画像 |
| 4 | **existing mapping evidence** | `migration.legacy_identity_crosswalk` · SQLite `legacy_user_map`（实测 0 行）· AUTH-M5/M6 的确定性映射证据 | 是否已有既存映射 |
| 5 | **conflict detection** | 一个 `supabase_auth_user_id` 是否已被别的 legacy 记录认领；反向亦然（crosswalk 的两个 partial unique index 会在数据库层拦截） | 有无碰撞 |

### 决策状态机

```
        采集 1–5
            │
   ┌────────┼──────────────────┬─────────────────┐
   ▼        ▼                  ▼                 ▼
步骤2/3 命中          步骤2/3 未命中        步骤5 命中冲突     仅邮箱相同
且有 4 的确定性证据      且 Owner 明确授权                     无其他证据
   │                        │                   │                 │
   ▼                        ▼                   ▼                 ▼
VERIFIED_EXISTING_    PROVISIONED_NEW_      CONFLICT       MANUAL_REVIEW_
IDENTITY              IDENTITY                                REQUIRED
   │                        │                   │                 │
   └──── 可进入正式 migration ┘            停止，提交 Owner   停止，人工复核
```

### 硬性规则

- **`email 相同` 本身不充分**（D-35）。它只能得到 `MANUAL_REVIEW_REQUIRED`。
  数据库层已经把这条钉死：`crosswalk_email_only_requires_review` CHECK
  禁止 `email_match_unreviewed` 带着 `verified = true` 落库（DB-3 已实测被拒）。
- 只有 `VERIFIED_EXISTING_IDENTITY`，或经**明确授权**的 `PROVISIONED_NEW_IDENTITY`，
  才能进入后续正式 migration。
- 人工复核路径必须留痕：`verified_by` + `verified_at` + `evidence` 三者同生同灭
  （`crosswalk_verified_shape` CHECK 已强制）。

### 本阶段不做

创建账号 · 修改账号 · 发送任何邮件 · 写入任何 crosswalk 行。

---

## 10. DB-4 Rehearsal Plan

**本轮不执行。** 设计如下闭环：

| # | 阶段 | 动作 | 通过判据 | 失败处置 |
|---|---|---|---|---|
| 1 | **dry-run** | 离线工具读 SQLite（只读）+ staging Auth 查询，产出 crosswalk manifest，**零写入** | 7 条 legacy 记录全部有明确 `mapping_method`；`email_match_unreviewed` 计数已知 | 直接停 |
| 2 | **review manifest** | 逐条人工复核；6 个测试账号标 `SKIPPED_TEST_ACCOUNT`（D-34），Esther 走 §9 | `email_match_unreviewed` 且 `verified=true` 的行数 = **0** | 停在人工复核 |
| 3 | **apply** | 只写 `migration.legacy_identity_crosswalk`，**不动业务表** | manifest 行数 == crosswalk 行数 | 事务回滚 |
| 4 | **verify login** | 用 staging fixture 账号走完整登录链路 | 拿到 Supabase token 且后端解析出 canonical 身份 | 停 |
| 5 | **verify canonical identity** | `auth.users.id == profiles.id == crosswalk.canonical_profile_id` | 三者一致 | 停 |
| 6 | **verify user-owned data** | 该身份能读到自己的、且**读不到别人的**（与 §12 联动） | 正向 + 否定式都过 | 停 |
| 7 | **rerun apply** | 重复执行 | crosswalk 行数与内容 md5 不变 | 幂等缺陷，停 |
| 8 | **prove idempotency** | 同上，并确认无重复行（两个 partial unique index 把守） | 无 unique violation，无新增行 | 停 |
| 9 | **rollback / recovery** | 删除本批次 crosswalk 行 → 库回到 DB-3 状态 | 业务表**从未被写过**，因此回退只需清 crosswalk | — |

> **DB-4 的回退天然廉价**：它只写迁移工具表，不写业务数据。
> 这正是 DB-1 §13 把身份迁移单列一阶段的原因 —— 让最难的一步拥有最便宜的回退。

---

## 11. AUTH External Test Matrix

当前全部 **`NOT RUN / BLOCKED_BY_ENV`**。

命令：`npm run --prefix backend test:external`

| # | 测试 | required environment | fixture | expected behavior | cleanup | evidence |
|---|---|---|---|---|---|---|
| 1 | `supabase-auth.test.ts` | `AMAS_ENV` | staging 合成账号 | Supabase 签发的 token 能通过后端 ES256 JWKS 验签并解析出 canonical 身份 | 删除合成账号 | 测试输出 + 后端日志（**不含 token**） |
| 2 | `identity-migration.test.ts` | `MIGRATED_DB` | 已迁移身份的库 | 迁移后的用户能登录且拿到正确的 canonical 身份 | 恢复库快照 | 同上 |
| 3 | `credential-recovery.test.ts` | `AMAS_ENV` · `MIGRATED_DB` · `SB_ACCESS_TOKEN` | 合成账号 + 真实邮件链路 | 密码重置全链路可走通 | 删除账号 + 清邮件 | 收信截图（打码）+ 测试输出 |
| 4 | `credential-recovery-expiry.test.ts` | `AMAS_ENV` · `SB_ACCESS_TOKEN` · `SB_PROJECT_REF` | 合成账号 | 过期 recovery token 必须被拒 | 同上 | 同上 |
| 5 | `password-change-reauth.test.ts` | `AMAS_ENV` · `SB_ACCESS_TOKEN` · `SB_PROJECT_REF` | 合成账号 | 改密必须强制重认证 | 同上 | 同上 |
| 6 | `redirect-matrix.test.ts` | `AMAS_ENV` · `SITE_DIR` | 已构建的站点产物 | 各 redirect 目标与 Supabase 白名单精确匹配，不允许开放重定向 | — | 矩阵输出 |

### 环境变量含义（**只写名称与用途**）

| 变量 | 用途 | 敏感度 |
|---|---|---|
| `AMAS_ENV` | 指明跑在哪个环境（`staging`） | 低 |
| `MIGRATED_DB` | 指向已完成身份迁移的库 | 中 |
| `SB_ACCESS_TOKEN` | Supabase **管理 API** 访问令牌 | **高** |
| `SB_PROJECT_REF` | staging 项目 ref | 低 |
| `SITE_DIR` | 已构建站点产物目录 | 低 |

### 硬性纪律（沿用既有约束）

- **Routing-only 验证只能用 `TEST_ONLY_NON_SECRET`。**
- **真实 recovery 必须走真实邮件链路**；不得把真实 token 复制进 shell / adb 命令。
- 任何真实 token 不得进入报告、日志、截图、shell history。

---

## 12. RLS Runtime Matrix

> **核心原则：能进去不够，还必须证明不该进去的人进不去。**

DB-3 只证明了 schema 与授权**边界**（表级 grant + RLS 开关）。
Supabase runtime 下的 RLS 行为**从未验证** —— 垫片里的 `auth.uid()` 是本地函数，不是真 JWT。

### 当前 schema 事实（本轮实测）

| | 数量 |
|---|---|
| `public` 有 policy 的表 | **23** 张，共 **33** 条 policy |
| 启用 RLS 但**零 policy**（fail-closed）的表 | **31** 张 |
| ↳ 其中 App 表 | 28 张 `app_*` |
| ↳ 其中 Portal 表 | 3 张：`irreversible_record_sources` · `login_aliases` · `student_number_registry` |

### 五种访问身份 × 重点表

| 表 | anon | authenticated（本人） | authenticated（他人） | backend / service_role | admin |
|---|---|---|---|---|---|
| `profiles` | **拒** | 读本人 | **拒读他人** | 允许 | 按 `is_admin_any` |
| `user_roles` | **拒** | 读本人角色 | **拒** | 允许 | 允许 |
| `student_records` | **拒** | 读本人 | **拒** | 允许 | 允许（`student_admin_select`） |
| `student_number_registry` | **拒** | **拒**（含管理员，走 RPC） | **拒** | 允许 | **拒** |
| `app_course_progress` | **拒** | **拒**（TYPE A，后端拥有） | **拒** | 允许 | **拒** |
| `app_christian_profile` | **拒** | **拒**（同上） | **拒** | 允许 | **拒** |
| `app_posts` / `app_prayer_shares` / 社群祷告 12 张 | **拒** | **拒** | **拒** | 允许 | **拒** |
| `course_catalog` | 读（公开目录） | 读 | 读 | 允许 | 允许 |
| `submissions` | **只写不读** | 按 policy | **拒** | 允许 | 允许 |

### 必测的否定式用例（每一条都必须**失败**才算通过）

```
1. anon 直连 PostgREST 读 profiles                     → 必须 401/403 或空集
2. authenticated 用户 A 读用户 B 的 profiles            → 必须空集
3. authenticated 读 app_course_progress                → 必须 403（表级无 grant）
4. authenticated 读 app_christian_profile              → 必须 403
5. authenticated 直接 insert user_roles 给自己加 admin  → 必须失败
6. authenticated 读 student_number_registry            → 必须失败
7. anon 读 migration.* 任意表                          → 必须失败（schema 无 usage）
8. 已注销/未激活账号访问受保护资源                       → 必须失败
9. 跨用户改写 app_posts / app_prayer_shares            → 必须失败
10. 浏览器直连 Portal 数据（真实 browser-direct 路径）    → 与 1–9 结论一致
```

> 第 10 条要单独跑：**浏览器直连和 curl 不是同一条路径**（CORS / preflight / cookie / anon key 注入方式都不同）。

---

## 13. Backend Deployment Requirements

| 项 | 值 / 要求 | 来源 |
|---|---|---|
| runtime | Node.js | `backend/package.json` |
| **Node 版本** | **`>=20`** | `engines: {"node":">=20"}` |
| 模块体系 | ESM（`"type":"module"`） | 同上 |
| build command | `npm run build`（= `tsc`） | 同上 |
| start command | `npm start`（= `node dist/server.js`） | 同上 |
| **health check** | **`GET /api/health`** | `backend/src/routes/health.ts:5`（已在 rate limit 中豁免） |
| 环境变量（必需） | `PORT` · `CORS_ORIGINS` · `SUPABASE_URL` · `SUPABASE_SERVICE_ROLE_KEY` · `JWT_SECRET` · `APP_SECRET` | `config.ts` · `startupGuard.ts` |
| 环境变量（可选） | `GEMINI_API_KEY` · `LIVEKIT_*` · `AGORA_*` · `APNS_*` · `ROOM_STORE_URL` | 同上 |
| 启动护栏 | production 下缺 `JWT_SECRET`(<32 字符) / `DB_PATH`(或 `:memory:`) / `CORS_ORIGINS`(或 loopback) **直接启动失败**，**绝不自动生成密钥** | RB-06 `startupGuard.ts`，13 个测试把守 |
| CORS | `CORS_ORIGINS` 必须显式列出 staging 前端域名 | 同上 |
| logging | 现有 console 输出；**须确认托管平台不把请求头/日志外泄** | — |

### ⚠ 两个必须写清楚的现实

**① `SCHEMA READY ≠ BACKEND POSTGRES READY`**

DB-3/DB-6 让**数据库 schema** 就绪，但 **DAL 尚未切换**（DB-12 未开始）。
后端目前仍然：

```
better-sqlite3  +  DB_PATH 指向本地 .sqlite 文件
```

因此**不能**把「schema 已迁 Postgres」当成「后端可以连 Postgres 跑」。
staging 部署 backend 时必须明确它连的是哪个库：

| 选项 | 含义 |
|---|---|
| **A（推荐本阶段）** | backend 仍用 SQLite，只把 **Auth** 接到 staging Supabase —— 足以跑通 §11 的 6 个 AUTH 测试 |
| B | 等 DB-12 完成后再部署 backend —— 但那会让 AUTH 外部测试继续 blocked 很久 |

**A 的代价必须讲明**：此时 backend 的业务数据仍在 SQLite，
所以 §12 的 App 表 RLS 测试**测不到真实业务读写**，只能测表级授权边界。

**② 后端有本地文件系统依赖**

`backend/uploads/{course-files,images}` 是真实目录（课程附件与图片落盘）。
放到无状态平台（如无持久卷的容器 / Serverless）会**每次重启丢文件**。
staging 需要：持久卷，或先接受「上传功能在 staging 不可用」并显式标注。

---

## 14. Frontend Deployment Requirements

### App 前端

| 变量 | 必需 | 用途 |
|---|---|---|
| `VITE_SUPABASE_URL` | ✅ | Supabase Auth 客户端 |
| `VITE_SUPABASE_ANON_KEY` | ✅ | 同上 |
| `VITE_API_BASE_URL` | ✅ | 指向 staging backend |
| `VITE_APP_SECRET` | 视功能 | 见 `.env.example` |
| `VITE_VOICE_TRANSPORT` | ❌ 本阶段不需要 | 语音 |

### Portal 官网

`assets/js/supabase-config.js` 的 `window.SUPA = { url, anonKey }` —— **当前两项都是空串**。

### Auth redirect URLs

必须在 Supabase Auth 里显式登记（`redirect-matrix.test.ts` 会逐条比对）：

```
staging 站点根 URL
密码重置回跳 URL
邮箱确认回跳 URL
App（Capacitor）deep link —— 须精确匹配（D-AUTH-R3）
```

### environment build separation

staging 与 production **必须是不同的构建产物**（不同 `.env` → 不同 bundle）。
`anonKey` 会被打进前端 bundle，它本身是公开值，但**指向哪个项目是环境事实**——
一次构建复用两个环境，等于让 staging 前端连 production 库。

### RB-28 复核 —— 本轮的准确结论

原记录担心「missing Supabase config → silent fallback」。逐处核对：

| 位置 | 实际行为 | 判定 |
|---|---|---|
| App 认证（`services/authService.ts:221`） | `requireSupabase()` **抛 503 并附明确提示** —— 注释写明「未配置就是不能用，而不是悄悄回落到一条已经不存在的链路上」 | ✅ **已修好**，不是静默回落 |
| Portal 官网（`assets/js/main.js:861`） | `if(!S.url || !S.anonKey) return;` 静默跳过 | ⚠ **设计如此且有文档**：该通道是邮件通道之外的**次要**数据库通道，注释明写「留空 = 仅邮件通道，网站正常工作」。不是缺陷，但**是 staging 配置清单项** —— 忘了填就没有任何提示，提交不会入库 |

**RB-28 的认证部分可以关闭**；官网数据库通道部分转为 §19 的检查项。

---

## 15. SMTP Requirements

**现状：`NOT CONFIGURED`（BLOCKER-02）。staging 当前用 `mailer_autoconfirm = true` 绕过邮件验证。**

### staging 最低要求

| 场景 | 是否必需 | 说明 |
|---|---|---|
| email verification | ⚠ 见下 | 决定 `enable_confirmations` 的取值 |
| password reset | **✅ 必需** | §11 的测试 3/4/5 全部依赖真实邮件链路 |
| invitation | ❌ 不适用 | 当前无邀请流程 |

### 两条路，必须明确选一条

| 方案 | 做法 | 代价 |
|---|---|---|
| **A. 配真实 SMTP** | staging 用独立发信身份 + **收件人白名单** | 需要 Owner 提供 SMTP 服务与发信域（§20） |
| **B. 暂用 autoconfirm** | 保持 `mailer_autoconfirm = true` | §11 的**测试 3/4/5 继续 BLOCKED**，且必须**显式标注为未验证**，绝不能写成「邮件流程通过」 |

### 测试策略（选 A 时）

- staging 专用 sender identity，与 production 分开
- **限制收件人**：只允许项目内测试邮箱，避免误发给真人
- **绝不使用 production 邮件列表**
- **绝不用 autoconfirm 伪装成已验证流程** —— 那会让「邮箱验证有效」变成一个没有证据的声明

---

## 16. Secrets Model

### 绝对不得进入

```
Git  ·  markdown 报告  ·  聊天  ·  截图  ·  console 日志  ·  frontend bundle
shell history  ·  adb 命令示例  ·  CI 日志  ·  audit_logs  ·  security_events
```

报告里一律只写 `CONFIGURED` / `NOT CONFIGURED`，**不写值**（本报告全程遵守）。

### 三处存放，各自的消费者

| 存放处 | 存什么 | 谁消费 | 现状 |
|---|---|---|---|
| **本机受控 env** | `backend/.env`（已 gitignore：`backend/.gitignore:3`）· `App/.env.local`（`.gitignore:14` `*.local`） | 本机开发与手动迁移 | ✅ 两者都已被忽略，实测确认 |
| **CI protected secret** | staging DB 连接串 · `SUPABASE_SERVICE_ROLE_KEY` · `SB_ACCESS_TOKEN` | CI 里的 `supabase db push` 与外部测试 | ❌ website 仓**尚无 CI**；App 仓 CI 已存在但未配 secret |
| **Staging 平台 secret** | backend 托管平台的环境变量 | 运行期后端 | ❌ 平台尚不存在 |

### 分级

| 级别 | 变量 | 处置 |
|---|---|---|
| **高敏** | `SUPABASE_SERVICE_ROLE_KEY` · DB 连接串 · `SB_ACCESS_TOKEN` · SMTP 凭据 · `JWT_SECRET` · `APP_SECRET` | 只进 CI protected secret 与平台 secret；**永不进前端** |
| 公开值 | `SUPABASE_URL` · `VITE_SUPABASE_ANON_KEY` · `window.SUPA.anonKey` | 会进前端 bundle，靠 RLS 约束；**因此 §12 的否定式测试是它们的唯一防线** |

---

## 17. Backup / Rollback Model

| 层次 | 现状 | staging 需要验证的 |
|---|---|---|
| **pre-migration backup** | ❌ 未建立 | hosted Supabase 的备份创建方式与**恢复耗时** |
| **schema migration rollback** | ✅ **已在 PG 17.6 实测**（DB-3 回退逐列零残留；DB-6 回退 Portal 列 md5 不变） | 同样的脚本在 hosted 环境执行一次 |
| **data migration rollback** | ✅ 设计完成（DB-4 只写 crosswalk，回退 = 清该表） | 实际演练 |
| **failed deployment rollback** | ❌ 未定义（无部署目标） | 平台侧回滚上一版本的方式 |

> ⚠ **必须明确标注**：DB-3 rollback 已在 PG 17.6 验证，
> 但 **hosted Supabase 的 backup / restore 完全未验证** ——
> 托管环境的备份是平台功能，不是我们的脚本能覆盖的。
> 列为 staging verification item，**不得因为「本地回退过」就认为托管侧也没问题**。

---

## 18. Resource / Cost Requirements

**只调查最小必需，不购买。**

| service | free tier 可行？ | 可能付费？ | 最低要求 | 必要性 | 可否延后？ |
|---|---|---|---|---|---|
| **Supabase staging project** | ✅ 通常可 | 若需常驻不休眠 / 更大存储则可能 | PG **17.6** · Auth · Database | **必需** | ❌ 不可 —— 三个卡点全依赖它 |
| **Backend 托管** | ✅ 多家有免费层 | 持久卷 / 常驻实例可能付费 | Node ≥20 · 可设环境变量 · 健康检查 · **持久卷（见 §13②）** | **必需** | ❌ 不可 —— 否则 AUTH 外部测试跑不了 |
| **前端 staging 托管** | ✅ | 一般免费足够 | 静态托管 + 可设置环境构建 | **必需** | ❌ 不可 |
| **staging 域名 / 子域** | ✅ 平台默认子域通常够用 | 自有域名需注册费 | 一个稳定 URL（用于 redirect 白名单） | **必需**（可先用平台默认子域） | ⚠ 自有域名可延后 |
| **SMTP** | ⚠ 部分服务商有免费额度 | 多数需付费或验证发信域 | 能发验证/重置邮件 | **条件必需**（见 §15 两条路） | ✅ 选方案 B 可暂缓 |
| Storage | ✅ | — | — | **本阶段不需要** | ✅ |
| Realtime | ✅ | — | — | **本阶段不需要** | ✅ |
| LiveKit | — | 是 | — | **本阶段不需要** | ✅ |
| Production Supabase | — | — | — | **本阶段禁止创建** | ✅ |

**结论：本阶段真正必需的付费风险点只有两个** —— backend 托管的持久卷，以及 SMTP（若选方案 A）。
其余都有免费路径。

---

## 19. STAGING ENTRY CHECKLIST

| # | 项 | 状态 | 说明 |
|---|---|---|---|
| 1 | Staging Supabase project 存在 | **NEEDS_OWNER** | 本地 CLI 缓存证实它**曾存在**且为 **PG 17.6.1.166**、region `ap-southeast-1`（§3.1）。本机无访问令牌，**无法核实当前是否仍存活** —— 需 Owner 确认 |
| 2 | credentials 已配置 | **NEEDS_OWNER** | 本地 `SUPABASE_*` 全部 `NOT CONFIGURED` |
| 3 | **migration channel 已批准** | **READY** | §4–§5 已实测跑通（无 Docker、接受现命名、幂等、可查 pending） |
| 4 | backup path 已知 | **BLOCKED** | hosted 备份/恢复未验证（§17） |
| 5 | `0001–0026` 已应用 | **BLOCKED** | 依赖 1、2 |
| 6 | DB schema 已验证 | **READY**（工具就绪） | DB-3 契约 53 + DB-6 契约 36 可直接对 staging 跑 |
| 7 | SMTP 已配置 | **NEEDS_OWNER** | 或明确选择方案 B 并标注（§15） |
| 8 | backend 部署目标存在 | **NEEDS_OWNER** | §13 |
| 9 | frontend staging 目标存在 | **NEEDS_OWNER** | §14 |
| 10 | test fixtures 就绪 | **READY**（政策就绪） | §8 政策已定；实际创建依赖 1 |
| 11 | DB-4 rehearsal 就绪 | **READY**（计划就绪） | §10 闭环已设计；crosswalk 表与全部护栏已在 schema 中 |
| 12 | external AUTH tests 就绪 | **READY**（测试就绪） | 6 个测试文件都在；缺的是环境（§11） |
| 13 | RLS matrix 就绪 | **READY**（矩阵就绪） | §12 已列 10 条否定式用例 |
| 14 | Storage | **NOT_REQUIRED** | §2 |
| 15 | Realtime | **NOT_REQUIRED** | §2 |
| 16 | LiveKit | **NOT_REQUIRED** | §2 |
| 17 | Production Supabase | **NOT_REQUIRED** | 本阶段明令禁止 |

**汇总：`READY` 7 · `NEEDS_OWNER` 5 · `BLOCKED` 2 · `NOT_REQUIRED` 4。**

> 两个 `BLOCKED` 都只是**依赖前面的 `NEEDS_OWNER`**，不是技术难题。
> 也就是说：**技术侧已经没有挡路的东西了。**

---

## 20. PRODUCT OWNER ACTIONS

> 这一节写给非技术的项目负责人。**只列真正需要您做的事**，
> Claude 自己能做的都已经做完了。

### 现在就需要做的（4 件）

**① 提供 Staging Supabase 项目**

- **为什么需要**：这是整个下一阶段的地基。没有它，用户登录、密码重置、权限隔离这三件事一件都验证不了。
- **是否付费**：通常**免费额度够用**。
- **现在还是以后**：**现在。** 其余三件事都要等它。
- **具体要什么**：一个**独立于将来正式环境**的 Supabase 项目，数据库版本必须是 **PostgreSQL 17.6**，地区建议新加坡。
- **好消息**：这台电脑上留有以前连接过的记录，显示项目 **`amas-staging` 曾经存在**，
  数据库版本 **17.6.1.166**（正是我们需要的），地区新加坡。
  所以**多半不用新建** —— 您只需要登录 Supabase 确认这个项目**还在**，然后把连接信息给我。
  如果它已经被删除或休眠了，才需要按上面的规格新建一个。
- **需要给我什么**：项目的连接信息与两个密钥。**请不要贴在聊天里** —— 放进项目的密钥配置处即可，我只会记录「已配置 / 未配置」。

**② 选择 Backend 的托管平台**

- **为什么需要**：App 的后台程序得有个地方跑，否则 App 连不上服务器。
- **是否付费**：多数平台有免费层。**但有一个可能要花钱的点**：后台目前会把课程附件和图片存成本地文件，免费层重启会清空。要么选带持久存储的方案（可能小额付费），要么先接受「staging 上传功能不可用」。
- **现在还是以后**：**现在**，否则 6 项登录相关测试跑不了。
- **需要的规格**：能跑 Node.js 20 以上，能设置环境变量。

**③ 提供一个 Staging 网址**

- **为什么需要**：邮件里的重置链接、登录后的跳转，都必须指向一个固定网址并提前登记，否则 Supabase 会拒绝跳转。
- **是否付费**：**免费** —— 用托管平台送的默认网址即可，不必买域名。
- **现在还是以后**：**现在**。正式域名的事可以以后再说（那是另一个待决事项 D-8）。

**④ 决定邮件（SMTP）怎么办**

- **为什么需要**：密码重置必须真的发出邮件才能验证。现在是「自动确认」绕过去的，等于这条链路从没被验证过。
- **是否付费**：视服务商，部分有免费额度。
- **现在还是以后**：**可以稍后**，但请现在做个选择：
  - **选 A** — 配真实邮件服务：那 3 项测试可以真正跑通。
  - **选 B** — 暂时继续绕过：那 3 项测试会**继续标记为「未验证」**，正式上线前必须补。
- 我的建议：**先选 B 把其他事推进**，等正式上线前再做 A。但这必须是您明确的选择，不能默认。

### 暂时不需要您做的

存储服务 · 实时服务 · 语音服务（LiveKit）· 正式环境 Supabase · 购买域名 —— 这些本阶段都用不上。

---

## 21. Documentation Updates

- **新增** `docs/operations/STAGING-0-READINESS-REPORT.md`（本文）
- **更新** `AMAS_PROJECT_HANDOFF.md` → v2.5，新增 **D-39 / D-40**
- **更新** App `docs/project-memory/`：`DECISION_LOG.md`（D-39/D-40）·
  `OPEN_ISSUES.md`（**RB-29** 新增；RB-28 认证部分澄清）·
  `CURRENT_STATE.md` · `DEVELOPMENT_ROADMAP.md` · `ACCEPTANCE_HISTORY.md` · `AI_HANDOFF_RULES.md`

### D-39｜Docker 不是 Staging 的前置条件

本地 PostgreSQL 17.6 已足以承担 schema 开发 / migration 重放 / 回退测试 / 契约测试。
真正的 staging migration 走**版本化 SQL migrations → 受控 runner / CI → Supabase Staging PostgreSQL**，
或经批准的 `psql` 直连。**不得因为 `supabase start` 跑不起来就让项目停摆。**
本轮已实测：`supabase db push --db-url` 不需要 Docker。

### D-40｜Staging 与 Production 的基础设施与数据群体相互隔离

Staging fixtures 默认**永不**成为 Production 身份。

### RB-29（新增）｜`.env.example` 缺少 `SUPABASE_*`

两份 `.env.example` 都没有列出 `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` /
`VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`，而前后端都依赖它们。
照着示例配置的人会得到一个「登录直接 503」却不知道缺什么的环境。
**修法属文档/配置范畴，但本轮按 TASK 20「除文档更新外不改业务代码」未动 `.env.example`** ——
它在 App 仓且属配置文件，留待下一个有写权限的实施阶段一并修。

---

## 22. Recommended Next Step

**不自动开始。** 建议顺序：

1. **Product Owner 完成 §20 的 ①②③，并对 ④ 做出选择。**
2. 凭据就位后，由**一个** canonical writer（D-38）执行 §7 的 bootstrap 第 1–6 步，
   产出 **STAGING-1 报告**：只做「项目连通 + 26 个 migration 应用 + schema 契约 89 条验证」，
   **不碰身份、不碰数据**。
3. STAGING-1 通过后再进 DB-4 演练（§10）。

### 为什么建议把 STAGING-1 单独切出来

第一次连真实 Supabase 会暴露一批本地环境看不见的东西
（TLS 要求、连接池、平台角色、扩展差异、备份耗时）。
把它和身份迁移混在一起，一旦出问题就分不清是环境还是逻辑 ——
这正是 DB-3.5 在版本问题上已经验证过一次的教训。

---

## 停止条件确认

| 禁令 | 遵守情况 |
|---|---|
| 不创建 Production Supabase | ✅ |
| 不创建付费资源 | ✅ 本轮零资源创建 |
| 不修改 DNS | ✅ |
| 不导入真实 Production 数据 | ✅ |
| 不创建 Esther 的正式账号 | ✅ §9 只设计流程，未查询未创建 |
| 不开始 DB-4 identity apply | ✅ §10 只设计闭环 |
| 不把任何状态写成 STAGING VERIFIED | ✅ 全文无此表述 |
| 除文档外不改业务代码 | ✅ 本轮仅新增/更新文档；`db push` 验证的靶子是本地临时库 |
| 遵守 D-38 单一 canonical writer | ✅ STAGING-0 为唯一 active task |

---

## 最终状态

> # `STAGING-0 NEEDS OWNER ACTION`
>
> 技术侧 `READY` 7 项 · `NOT_REQUIRED` 4 项 · 待 Owner 5 项 · 因待 Owner 而阻塞 2 项。
> **迁移交付通道已实测跑通**（无 Docker · 接受现有命名 · 幂等 · 有官方版本记账 ·
> 产出与 psql 通道 md5 一致 · 契约 53/53）。
>
> **未创建任何资源。未开始 DB-4。未开始 STAGING-1。**
