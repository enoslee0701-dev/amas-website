# RELEASE READINESS REPORT

**日期**：2026-09-07
**阶段切换**：功能开发 → **RELEASE READINESS → STAGING → PRODUCTION VERIFICATION**
**执行**：只读审计 + 本地测试实跑，未修改任何产品代码
**依据**：两仓库当前 HEAD 的真实代码与实测输出，非文档引用、非聊天记忆

> **最终状态：`NOT READY`**（判定依据见 §12、§13）

---

## 1. Current Reality

AMAS 由**两个独立部署单元**组成，成熟度差异很大：

| 单元 | 仓库 | 当前形态 | 实际可用性 |
|---|---|---|---|
| **官网（含 Portal 前端）** | `amas-website` | GitHub Pages 静态托管，已上线 | 官网可用；**Portal 未接数据库，不可用** |
| **Supabase 后端** | `amas-website/supabase` | 22 migrations + 7 Edge Functions | **仅 staging 存在**，production 未建立 |
| **App 前端** | `AMAS-Seminary` | Vite 构建产物 `dist/` | **无任何部署目标** |
| **App 后端** | `AMAS-Seminary/backend` | Express + **本地 SQLite 文件** | **无任何部署目标** |

**核心事实**：代码量与自动化测试确实充分，但**没有任何一个组件在真实托管环境中运行过**。
官网是唯一真正上线的部分，而它上线的是「数据库未接通」的降级形态。

**身份架构处于半迁移状态**：D-2B-1 已批准 Supabase 为统一身份 SoT，
但 App 后端仍在用自己的 SQLite + 自签 JWT；迁移成果全部滞留在未合并分支。

---

## 2. Documentation Corrections

审计中发现并已修正的文档失真：

| # | 文档 | 原记录 | 实测 | 处置 |
|---|---|---|---|---|
| 1 | `project-memory/CURRENT_STATE.md` | 前端 `123/123`（16 文件） | **`138/138`（17 文件）** | 已更新 |
| 2 | `project-memory/CURRENT_STATE.md` | 最近 commit `ecff6cc` | **`03bb842`**（其后 4 个提交） | 已更新 |
| 3 | `project-memory/CURRENT_STATE.md` | 「`main` 与 `origin/main` 同步」 | **本地领先 2 个未推送提交**，且 `main` 已丢失上游追踪配置 | 已更新 |
| 4 | `AMAS_PROJECT_HANDOFF.md` | App HEAD `8921c9b` | `03bb842` | 已更新 |
| 5 | 本轮自身的误报 | 「`APP_SECRET` 为空 → API 鉴权完全旁路（P0）」 | **错误**。`requireAppSecret` 未挂载任何路由；真实路由走 fail-closed 的 `requireAuth` | 已在 §9 更正 |

**没有为了让文档好看而抬高任何模块状态。** 无证据的一律保持低位。

---

## 3. Current Commit

```
amas-website
  branch        master
  HEAD          088dce70e69d4d53cd66e067b7fe500de69b9204
  subject       BLOCKER-08 重新定性：P1 -> P2，当前无用户影响
  上游           origin/master  差距 0/0
  working tree  clean

AMAS-Seminary（本地目录 "AMAS Seminar App"）
  branch        main
  HEAD          03bb842bea3b3323d6247b04bd0b913945b587f1
  subject       ux: App 界面统一改用中文「信仰成长档案」，与官网口径对齐
  上游           ⚠ 无追踪配置；对比 origin/main 本地领先 2 个提交（未推送）
  working tree  clean
  其他分支       auth/supabase-unification (4af8307) —— AUTH 成果全在此，未合 main
```

---

## 4. Test Baseline

**2026-09-07 本机实跑，非引用文档：**

```
AMAS-Seminary 前端
  vitest              17 files / 138 tests / 138 passed / 0 failed   exit 0
  tsc --noEmit        clean (exit 0)
  npm run build       exit 0，产物写入 dist/
                      [voice-guard] ok — transport="(none)"

AMAS-Seminary 后端
  node --test         103 tests / 103 pass / 0 fail                  exit 0
  tsc --noEmit        clean (exit 0)

amas-website
  ⚠ 11 个 .mjs 验收套件全部需要 AMAS_ENV=staging.env
    staging.env 本地不存在 → 本轮一个都未能执行
```

**判定**：App 侧达到 `TESTED LOCALLY`。
**未达到 `INTEGRATION VERIFIED`** —— 现有测试全部在本机进程内运行，
未跨真实 HTTP 边界、未连真实托管数据库。
amas-website 侧**连 `TESTED LOCALLY` 都无法自证**，因为测试跑不起来。

---

## 5. Deployment Architecture

### Frontend — 官网

| 项 | 现状 |
|---|---|
| 部署方式 | GitHub Pages，从 `master` 分支根目录直发 |
| build command | **无**（纯静态，无构建步骤） |
| output | 仓库根目录本身 |
| URL / HTTPS | https://enoslee0701-dev.github.io/amas-website/ ✅ HTTPS |
| SPA routing | 不适用（多页静态站，目录式路由） |
| static assets | 同源 `assets/`，`?v=` 时间戳缓存刷新（pre-commit hook 自动） |
| environment injection | `assets/js/supabase-config.js` 硬编码 —— **线上为空配置** |

### Frontend — App

| 项 | 现状 |
|---|---|
| 部署方式 | **无** |
| build command | `npm run build`（voice-guard + vite build），实测 exit 0 |
| output | `dist/` |
| URL / HTTPS | **无** |
| environment injection | `.env.local` 的 `VITE_*`，构建期注入 |

### Backend — App

| 项 | 现状 |
|---|---|
| 运行方式 | `node dist/server.js`（Express），**仅本机手工启动** |
| API URL | `.env.local` 的 `VITE_API_BASE_URL` —— **指向 localhost** |
| database | **`better-sqlite3` 本地文件 `backend/data/amas.sqlite`** |
| persistent storage | 单机文件，**无托管持久化、无卷、无备份** |
| process lifecycle | **无进程管理器**（无 systemd / pm2 / Docker / Procfile） |
| logging | `console.log` 到 stdout，**无落盘、无聚合** |
| crash recovery | **无**。且 JWT secret 为 ephemeral（见 §7），重启即全员登出 |
| CI | `.github/workflows/ci.yml`：type-check + test + build，**不部署** |

---

## 6. Environment Status

**仅列变量名与是否设置，不含任何值。**

### `AMAS-Seminary/backend/.env`

| 变量 | 状态 | 影响 |
|---|---|---|
| `PORT` | 已设置 | — |
| `CORS_ORIGINS` | 已设置（含 localhost） | 生产需替换为正式域名 |
| `APP_SECRET` | **空** | 无 service principal 通道（见 §9，非漏洞） |
| `JWT_SECRET` | **空** | → ephemeral 签名密钥，**重启即全员登出**（P1） |
| `LIVEKIT_URL` / `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` | **全空** | 语音不可用 |
| `AGORA_APP_ID` / `AGORA_APP_CERTIFICATE` | 全空 | 备选语音方案未启用 |
| `GEMINI_API_KEY` | 空 | 依赖它的功能不可用 |
| `ROOM_STORE_URL` | 空 | — |
| `DB_PATH` | 空 → 落回 `backend/data/amas.sqlite` | 见 §8 |
| `APNS_KEY_PATH` / `APNS_KEY_ID` / `APNS_TEAM_ID` | 全空 | 推送不可用 |
| `APNS_BUNDLE_ID` / `APNS_PRODUCTION` | 已设置 | — |

### `AMAS-Seminary/.env.local`

| 变量 | 状态 |
|---|---|
| `VITE_API_BASE_URL` | 已设置，**指向 localhost** |
| `VITE_VOICE_TRANSPORT` | **空**（构建日志确认 `transport="(none)"`） |

### `amas-website`

| 变量 | 状态 |
|---|---|
| `staging.env` | **不存在** —— 11 个验收套件因此无法执行 |
| `window.SUPA.url` / `.anonKey` | 线上**均为空字符串** |

**结论**：当前是一套完整的 **development-only 配置**。
存在 localhost 依赖、存在空密钥、不存在任何 production profile。

---

## 7. Authentication Status

**当前实际在用的是两套并存的 Auth，尚未统一：**

| | 官网 / Portal | App |
|---|---|---|
| 提供方 | Supabase Auth | **App 后端自签 JWT** |
| 用户表 | Supabase `auth.users` | **本地 SQLite `users`** |
| 线上是否连通 | **否**（`SUPA` 空配置） | 无部署，仅本机 |

### App 侧 JWT 实测

```
ACCESS_TTL   15 分钟
REFRESH_TTL  30 天
签名密钥      JWT_SECRET 未设 且 APP_SECRET 未设
             → crypto.randomBytes(48) 每进程随机生成（source: 'ephemeral'）
```

**后果**：后端每次重启/崩溃，所有已签发 token 立即失效，**全员被登出**。
代码注释明确写着这是「fine for dev/tests」。这是 **P1 生产阻塞**。

### Supabase 侧（依 `AUTH-production-auth-config.md`，未复验）

| 项 | staging | production 目标 |
|---|---|---|
| `mailer_autoconfirm` | `true` | `false`（未完成） |
| SMTP | **未配置** | 必须自有 SMTP |
| Site URL | `http://localhost:8090` | `DECISION_REQUIRED` |
| Redirect URLs | `localhost:8090/**` 通配 | 精确 URL，禁用 `/**` |
| Mobile deep link | 无 | `amas-seminary://auth/recovery`（已定） |
| 改密重认证 | `false` | `true`（已定，D-AUTH-R5） |

**email verification / reset password / session refresh / logout / token expiry
在真实邮件链路下均未验证** —— staging 用 `mailer_autoconfirm=true` 绕过了收信环节。

---

## 8. Database / Migration Status

### Supabase（官网 / Portal）

```
schema          22 个 migration：0001 → 0022
最新             0022_program_offering_scope.sql
staging          0001–0021 已应用；0022 未执行
production       环境不存在
rollback 方法    ⚠ 无书面回滚方案
backup 方法      ⚠ 无书面备份方案
```

### SQLite（App 后端）

```
类型            better-sqlite3 单文件
位置            backend/data/amas.sqlite（DB_PATH 未设时的默认值）
迁移机制         ⚠ 未发现独立的 migration 版本管理
persistence     单机文件，无托管卷、无副本
backup          ⚠ 无
rollback        ⚠ 无
```

**这是 §13 中最重的一条**：一个用本地 SQLite 文件、无备份、无进程管理、
无部署目标的后端，**不具备承载真实用户数据的条件**。

---

## 9. Security Status

### ✅ 已验证为正确的设计（读代码确认，非推测）

| 项 | 证据 |
|---|---|
| `requireAuth` **fail closed** | `backend/src/middleware/auth.ts:130` —— 无 bearer token 一律 401，**不因 APP_SECRET 未设而放行**。代码内有显式注释禁止恢复旧的「无 secret 即开门」逻辑 |
| `requireAdmin` 使用**实时 server-side role** | `auth.ts:143` `findById(payload.sub)` 从数据库取用户，**不读 JWT 里的角色声明** |
| 常量时间比较 | `constantTimeStringEqual`，先哈希再比较，掩盖长度 |
| service principal 不可匿名获得 | `if (config.appSecret && ...)` —— `APP_SECRET` 为空时该分支永不成立 |

### ⚠ 本轮更正的误报

> 审计中途我曾判定「`APP_SECRET` 为空 → API 鉴权完全旁路，P0」。**这是错的。**
> `requireAppSecret` 虽然在未设 secret 时确实 `next()` 放行，但它
> **没有被挂载到任何一条路由上**（全仓库检索：除定义处外零引用）。
> 所有真实路由使用 `requireAuth` / `requireAdmin`。原判定已撤回。

### ⚠ 尚未验证的部分（STEP 5 要求，本轮无法执行）

STEP 5 要求的全部否定式测试 —— anon→学生数据 DENY、student A→student B DENY、
student→admin API DENY、普通用户自授 admin DENY 等 —— **一项都没有在真实环境跑过**。

原因：Supabase 侧 11 个验收套件需 `staging.env`（不存在）；
App 侧无部署环境，只能在本机进程内测试。

历史上 PORTAL-1/2/2B 报告记载过等价的越权测试并 PASS，但那是
**staging 环境的历史结论，不能替代本阶段的重新验证**。

### 其他

- **无 production 启动护栏**：`warnIfNoAppSecret()` 只打印一行 `console.warn`，
  没有任何机制阻止带着 dev 配置部署上线（P1）
- 未发现 secret 进入 Git（`staging.env` 不存在；`.env` 系列均被忽略）
- 未发现前端 bundle 内含 service key

---

## 10. E2E Acceptance Matrix

**图例**：`NOT IMPLEMENTED` = 产品未实现 · `IMPL/UNVERIFIED` = 已实现未验证 ·
`BLOCKED` = 缺环境无法验证 · 无一项达到 `E2E VERIFIED`

### A. Public

| 流程 | 状态 | 说明 |
|---|---|---|
| 访客进入官网 → 浏览 | **IMPL/UNVERIFIED** | 官网线上可达；未做真实浏览器 E2E |
| 注册 | **BLOCKED** | 线上 `SUPA` 空配置，注册页显示未启用状态 |
| 登录 / 登出 | **BLOCKED** | 同上 |
| 忘记密码 | **BLOCKED** | 同上 + SMTP 未配置 |
| 邮件验证 | **BLOCKED** | SMTP 未配置；staging 靠 `mailer_autoconfirm` 绕过 |

### B. Applicant

| 流程 | 状态 |
|---|---|
| 注册 → 申请入学 → 提交 → 查看状态 | **BLOCKED**（数据模型完备，环境不通） |
| 管理员审核 → 要求补件 → 补件 → 录取 | **BLOCKED** |
| 身份转换 → 进入学员中心 | **BLOCKED** |

### C. Student

| 流程 | 状态 |
|---|---|
| 登录 → 学员首页 → 查看课程 | **BLOCKED** |
| 查看学习进度 | **NOT IMPLEMENTED**（无 `in_progress` 数据源） |
| 作业 / 出勤 / 成绩 | **NOT IMPLEMENTED** |
| 实践训练 | **NOT IMPLEMENTED** |
| Christian Profile | **IMPL/UNVERIFIED**（Level 0 官网已上线；Level 1/2 在 App） |
| 成长路径 | **NOT IMPLEMENTED** |

### D. Teacher

| 流程 | 状态 |
|---|---|
| 教师邀请 → 身份验证 → 提交 | **BLOCKED** |
| 邮件验证 | **BLOCKED**（SMTP） |
| 管理员审核 → 激活 → 登录 → 工作台 | **BLOCKED** |
| 查看被分配课程 | **NOT IMPLEMENTED** —— `is_assigned_teacher` 仍是 fail-closed 占位（恒 false），缺 `teacher_assignments` 表 |
| 查看授权学员 | **NOT IMPLEMENTED** |
| 出勤 / 作业 / 成绩 | **NOT IMPLEMENTED** |

### E. Admin

| 流程 | 状态 |
|---|---|
| 申请管理 / 教师审核 / 学生管理 | **BLOCKED**（已实现，环境不通） |
| 课程 / 班级 | 课程目录只读**已实现**；班级 **NOT IMPLEMENTED** |
| 账号 / 权限 / 审计 | **BLOCKED** |

**汇总**：可执行的 E2E 用例数 = **0**。全部因环境缺失而阻塞或产品未实现。

---

## 11. Staging Status

```
状态：不存在真正的 staging
```

- Supabase `amas-staging` 项目**存在**，但没有部署在其之上的前端或后端
- 无 staging URL、无 HTTPS 端点、无真实浏览器可访问的完整栈
- `staging.env` 本地不存在，连既有验收脚本都无法执行

**当前一切「PASS」均为 `Code-stage` / `TESTED LOCALLY`，
不构成 `STAGING VERIFIED`。**

---

## 12. Production Status

```
状态：PRODUCTION 不存在
```

- 无 production Supabase 项目
- `PRODUCTION_DOMAIN = DECISION_REQUIRED`（GitHub Pages URL 明确不作为正式域名）
- App 前后端无任何部署目标
- 无备份、无回滚、无监控

---

## 13. P0 / P1 Blockers

| ID | Area | Issue | Sev | Status | Evidence | Blocks Staging? | Blocks Prod? | Required Action |
|---|---|---|---|---|---|---|---|---|
| **RB-01** | Database | App 后端使用本地 SQLite 单文件，无托管持久化、无备份、无回滚 | **P0** | OPEN | `backend/src/db.ts:36,46` | 是 | 是 | 决定托管数据库方案（迁 Supabase Postgres 或托管卷）；属架构决策，需拍板 |
| **RB-02** | Deployment | App 前端与后端**无任何部署目标**（无 Docker/Procfile/平台配置，CI 只构建不部署） | **P0** | OPEN | 仓库根目录检索 + `ci.yml` | 是 | 是 | 选定托管平台并建立部署流水线 |
| **RB-03** | Database | Production Supabase 不存在 | **P0** | BLOCKED | HANDOFF BLOCKER-01 | 否 | 是 | 用户创建项目并提供访问方式 |
| **RB-04** | Email | SMTP 未配置；`mailer_autoconfirm=true` | **P0** | BLOCKED | `AUTH-production-auth-config.md` | 是 | 是 | 确定发信域与服务商 |
| **RB-05** | Auth | `JWT_SECRET`/`APP_SECRET` 均未设 → ephemeral 签名密钥，后端重启即全员登出 | **P1** | OPEN | `config.ts:17-28` 实测 `.env` 为空 | 是 | 是 | 部署时注入持久 `JWT_SECRET` |
| **RB-06** | Security | 无 production 启动护栏，dev 配置可被直接部署上线 | **P1** | OPEN | `auth.ts:76-84` 仅 `console.warn` | 否 | 是 | 增加 `NODE_ENV=production` 下的 fail-fast 校验 |
| **RB-07** | Environment | `VITE_API_BASE_URL` 与 `CORS_ORIGINS` 均含 localhost | **P1** | OPEN | `.env.local` / `backend/.env` | 是 | 是 | 建立 production env profile |
| **RB-08** | Auth | 官网 Portal 线上 `SUPA` 为空配置，门户完全不可用 | **P1** | OPEN | 线上 `supabase-config.js` 实测 | 是 | 是 | 接入环境配置注入机制 |
| **RB-09** | Domain | `PRODUCTION_DOMAIN` 未确定，Site URL / Redirect / CORS 全部悬空 | **P1** | PENDING_DECISION | HANDOFF BLOCKER-07 | 否 | 是 | 用户确定正式域名 |
| **RB-10** | Security | STEP 5 全部否定式越权测试**一项未跑** | **P1** | BLOCKED | 11 套件需 `staging.env`（不存在） | 是 | 是 | 建 staging 后按 STEP 5 逐项执行 |
| **RB-11** | Auth | App `auth/supabase-unification` 未合入 main，身份统一未生效 | **P1** | PENDING_DECISION | 分支 `4af8307` | 是 | 是 | 按 R-9 合并窗口执行 |
| **RB-12** | Voice | LiveKit 三个变量全空，`transport="(none)"` | **P1** | BLOCKED | 构建日志实测 | 否 | 是（若语音属上线范围） | 提供凭据 + 两台真机 |
| **RB-13** | Ops | 无备份 / 回滚 / 监控方案 | **P1** | OPEN | `docs/` 检索无专门文档 | 否 | 是 | 建立并演练 |

---

## 14. P2 / P3 Issues

| ID | Issue | Sev | Action |
|---|---|---|---|
| RB-14 | `0022` 迁移未执行（线上 Portal 未接库，当前零影响） | P2 | `supabase login` 后执行 |
| RB-15 | App `main` 有 2 个未推送提交，且丢失上游追踪配置 | P2 | 推送并 `git branch -u origin/main main` |
| RB-16 | `is_assigned_teacher` 等三个占位函数恒 false，教师能力未实现 | P2 | 需 `teacher_assignments` 等关系表 |
| RB-17 | 官网课程文案「世界观理解」与权威目录「世界观」不一致 | P3 | 待拍板（D-2B-2） |
| RB-18 | 五个公共房间 0 moderator | P3 | 开放前授予 |
| RB-19 | presence TTL 45s 离线判定延迟 | P3 | 已知 backlog |
| RB-20 | 韩/泰申请引导文案由 AI 生成，未经母语复核 | P3 | 找母语同工校对 |

---

## 15. Evidence

```
Current branch    website: master        App: main
Current commit    website: 088dce7       App: 03bb842
Git status        website: clean         App: clean（但 2 个提交未推送）
Build result      App 前端 npm run build  exit 0
Frontend test     App vitest             17 files / 138 pass / 0 fail
Backend test      App node --test        103 pass / 0 fail
Typecheck         App 前端 tsc clean · App 后端 tsc clean
Integration tests 无（现有测试均在本机进程内）
E2E results       0 条可执行
Deployment env    官网 = GitHub Pages（唯一真实部署）；App 前后端 = 无
Staging URL       无
Production URL    无
Auth test         未在真实环境执行
Permission test   未在真实环境执行
Migration status  Supabase: 0001–0021 已应用 staging，0022 未执行
                  SQLite: 无版本化迁移机制
Backup/rollback   均无
```

---

## 16. Changes Made

本轮**未修改任何产品代码**，仅：

1. 修正 `AMAS-Seminary/docs/project-memory/CURRENT_STATE.md` 的失真记录（测试数字、HEAD、推送状态）
2. 新增本报告 `amas-website/docs/operations/RELEASE-READINESS-REPORT.md`
3. 更新 `AMAS_PROJECT_HANDOFF.md` 指向本报告并同步 App HEAD

---

## 17. Remaining Work

**按依赖顺序，非并行：**

1. **架构决策（必须先做）**：App 后端数据库与托管方案（RB-01 / RB-02）
   —— 这是 Stop Condition #8「必须做重大架构改变才能上线」，需拍板
2. 确定 `PRODUCTION_DOMAIN` 与 SMTP（RB-09 / RB-04）
3. 建立 production Supabase（RB-03）
4. 建立 production env profile，注入持久 `JWT_SECRET`（RB-05 / RB-07 / RB-08）
5. 增加生产启动护栏（RB-06）—— 可立即做，不依赖外部条件
6. 部署到真实 staging URL
7. 执行 STEP 4 的 E2E 矩阵与 STEP 5 的全部否定式测试
8. 建立备份 / 回滚 / 监控（RB-13）
9. Production 部署与 STEP 9 smoke test

---

## 18. Recommended Next Action

**唯一推荐动作**：先解决 **RB-01 / RB-02**（App 后端的数据库与部署形态）。

理由：其余所有 blocker 都是「配置缺失」，可在数天内补齐；
而 App 后端目前是「本地 SQLite + 手工启动 + 无备份」，
**这不是配置问题，是架构问题**——在它有确定的托管形态之前，
建 staging、跑 E2E、做备份方案全都无处落地。

三个候选方向（需拍板，本报告不代为决定）：

| 方案 | 要点 |
|---|---|
| A. 合并 `auth/supabase-unification`，数据迁向 Supabase Postgres | 与 D-2B-1 统一身份方向一致；工作量最大；一次到位 |
| B. App 后端保留 SQLite，部署到带持久卷的托管平台 | 改动最小；备份与扩展受限；与 D-2B-1 方向背离 |
| C. 先只上线官网 + Portal（Supabase 侧），App 延后 | 可最快拿到一个真实 STAGING VERIFIED；范围最小 |

**在获得明确方向前，工程侧可继续推进且不需要授权的工作**：
RB-06（生产启动护栏）、RB-15（推送与追踪修复）、STEP 6 的 Christian Profile
regression fixture 建设、STEP 4 矩阵的脚本化准备。

---

# 最终状态

```
NOT READY
```

**判定依据**：4 项 P0 未关闭（RB-01 / 02 / 03 / 04），
E2E 可执行用例数为 0，无 staging 环境，无备份与回滚方案。

距离 `READY FOR STAGING` 的最短路径 = 关闭 RB-01 + RB-02。
