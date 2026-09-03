# AUTH-M1 · App 身份系统只读审计与迁移映射

**日期**：2026-09-03
**决策依据**：D-2B-1 批准方案 A —— App 迁移到 Supabase Auth，Supabase 成为 AMAS App / Portal 的统一身份与权限 Source of Truth
**方法**：只读检查 App 代码与 SQLite 实际内容，未做任何修改
**对象**：`C:\Users\enosl\Desktop\amas---asian-missionary-theological-seminary`（活跃仓库）

---

## 结论摘要

> **结论修正（2026-09-03 甲方拍板）**
>
> 原表述「course_progress / growth_state 为 0，所以身份迁移近乎空数据迁移」正式修正为：
>
> **「Learning / CP 核心表当前为空，但 App 数据库已经存在用户关联历史数据，
> 因此身份统一属于真实数据迁移，不是空库切换。」**
>
> 依据：7 个账号 · 23 张带用户关联的数据表 · 268 行相关记录 ·
> 仅 5/31 张相关表存在数据库 FK 约束。
>
> 因此 **AUTH-M6 升级为正式阻断验收项**：任何 legacy user → Supabase `auth.users.id`
> 的替换之前，都必须先完成完整的 orphan / mapping / collision audit。
> 工具与报告见 App 仓库 `auth/supabase-unification` 分支：
> `backend/scripts/identity-migration-dryrun.mjs` →
> `docs/operations/AUTH-identity-migration-dry-run-report.md`。

迁移可行，且**现在是成本最低的时点**。但这不等于"空库切换"：
学习与 CP 表确实是 0 行，**另有 23 张表、268 行数据带用户外键**，
以及 7 个账号（其中 1 个是真实用户邮箱）。迁移安全设计不能省。

一个关键的有利事实：**App 的用户 ID 用 `crypto.randomUUID()` 生成，与 Supabase
`auth.users.id` 同为 UUID**，且所有外键列都是 `TEXT`。因此迁移是**值替换**，
不是类型改造——这大幅降低了风险。

---

## 1. 当前登录 / 注册实现

| 端点 | 说明 |
|---|---|
| `POST /api/auth/register` | 自建；`authLimiter` 限流 |
| `POST /api/auth/login` | 自建；返回 access + refresh |
| `POST /api/auth/refresh` | 轮换 refresh，写 `refresh_jti` |
| `POST /api/auth/change-password` | 需当前密码 |
| `POST /api/auth/logout` | 删除 `refresh_jti` 行 |
| `POST /api/auth/_promote` | **`requireAppSecret`**，机器对机器提权为 admin |
| `GET /api/auth/me` | 返回 PublicUser |

**密码存储**：`password_hash` + `salt`，在 `users` 表内自管。
**密码找回**：**完全没有实现**（grep `forgot` / `reset-password` / `recovery` 零命中）。
→ 迁移到 Supabase 后这项能力是白得的。

## 2. student / admin 两级身份来源

`users.role TEXT CHECK(role IN ('student','admin')) DEFAULT 'student'`，单列、无 scope、无有效期、无撤销时间。

前端 `services/permissions.ts` 另外识别 `dean` / `teacher` 字符串
（`canEditCourses`、`canUploadCourses`），但**数据库 CHECK 约束根本不允许这两个值** ——
这两条分支目前永远走不到。属于要在 AUTH-M4 清理的死逻辑。

对照 Portal 已验收的 9 角色（applicant/student/teacher/mentor/registrar/finance/
content_admin/academic_admin/super_admin）+ scope + `revoked_at` + `expires_at`，
App 侧的授权模型明显更弱。

## 3. token / session 保存位置

- **localStorage**：access token、refresh token、缓存的 PublicUser（三个 key）
- 理由（代码注释）：Capacitor WebView 无 SameSite cookie 方案，静态 SPA 也需显式 bearer
- `fetchAuthed()` 自动附 bearer，401 时刷新一次重试；`REFRESH_LEEWAY_SEC` 内提前刷新，
  用单例 in-flight promise 防并发竞争

Supabase JS 默认同样用 localStorage，**存储介质不变**，迁移不影响 Capacitor 行为。

## 4. JWT 结构

```ts
AccessPayload  { sub, email, role: 'student'|'admin', type: 'access' }   // HS256, 15min
RefreshPayload { sub, type: 'refresh', jti }                            // HS256, 30d
ISS='amas-backend'  AUD='amas-app'
```

`refresh_jti(user_id, jti)` 表做撤销（logout / 轮换时删行）。**108 行**，全是开发期残留。

> ⚠️ 迁移期风险：Supabase JWT 与 App JWT 都是 HS256 且都放在同一个 Authorization 头。
> 后端必须**显式按 `iss` 区分**并分别验签，绝不能"哪个能验过就用哪个"。

## 5. `/api/growth/state`

`GET/PUT`，`requireAuth`，一人一份 JSON（`growth_state`）。前端拥有 merge 语义。
`MAX_STATE_BYTES = 512KB`。**当前 0 行。**

## 6. `course_progress`

`(user_id, course_id, progress 0..100, completed_lessons, updated_at)`，主键 `(user_id, course_id)`。
写入仅做 `clampInt` 范围钳制，**不校验是否真的学过**。**当前 0 行。**

## 7. `growth_state` / Christian Profile

评估引擎在客户端（`services/christianProfile/*`），画像文档存 `localStorage`
（`amas_ct_state_v2`）并经 `growthSyncService` 同步到 `growth_state`。**当前 0 行。**
`evidence.ts` 的证据模型完整且设计正确，迁移后应原样保留、只换用户主键。

## 8. 用户 ID 作为外键的使用面

**23 张表带用户外键，共 268 行**：

| 行数 | 表 | 列 |
|---:|---|---|
| 108 | `refresh_jti` | user_id |
| 68 | `course_files` | uploader_id |
| 67 | `courses` | created_by |
| 12 | `prayer_shares` | user_id |
| 7 | `rooms` | host_id |
| 3 | `room_members` | user_id |
| 2 | `room_prayer_topics` | created_by |
| 1 | `prayer_intercessions` | user_id |
| 0 | `course_progress`、`growth_state`、`pt_state`、`posts`、`post_likes`、`post_comments`、`friend_requests`、`friendships`、`library_favorites`、`push_tokens`、`recordings`、`room_presence`、`prayer_sessions`、`prayer_session_events`、`prayer_share_reports` | — |

**只有 5 / 31 张表声明了 FOREIGN KEY 约束**（room_members、prayer_share_reports、
prayer_sessions、prayer_session_items、prayer_session_events）。`db.ts` 虽然开了
`pragma foreign_keys = ON`，但绝大多数用户外键**没有约束保护** ——
这意味着 orphan 只能靠显式检测发现，数据库不会报错（AUTH-M6 必须覆盖）。

## 9. Legacy Auth 与 Supabase user ID 的潜在冲突

**有利**：App 用 `crypto.randomUUID()`，Supabase 也是 UUID，外键列都是 `TEXT`
→ 迁移是值替换，不改类型、不改 schema 形状。

**风险点**：

1. **邮箱重复**：`users.email` 是 `UNIQUE COLLATE NOCASE`；Supabase `auth.users` 亦唯一。
   若同一人在两边都注册过，需要合并策略（AUTH-M6）。
2. **测试账号污染**：现有 7 个账号中 6 个是开发产物
   （`@amas.test` ×3、`@amas.local` ×3），**1 个是真实邮箱**（`estherzh0528@gmail.com`）。
   迁移脚本必须区分对待，不能把测试账号带进生产身份体系。
3. **`_promote` 后门**：`requireAppSecret` 可把任意账号提为 admin。
   迁移后角色由 Supabase `user_roles` 决定，该端点必须**移除**，不能保留成第二条提权路径。

## 10. 依赖旧 auth middleware 的 API

`requireAuth` / `requireAdmin` / `requireAppSecret` 出现在 **16 个路由文件**：

```
prayer 13 · friends 9 · courses 7 · library 6 · push 5 · posts 5
rooms 3 · roomStream 3 · pt 3 · prayerSession 3 · growth 3 · announcements 3
cooperation 2 · auth 2 · voice 1 · courseFiles 1
```

**这是迁移的主要工作量**，但形状很好：所有路由都只通过 `req.principal` 取用户，
不直接解析 token。**只要 `requireAuth` 内部换成验 Supabase JWT，`req.principal` 契约不变，
16 个路由文件一行都不用改。** 这正是 AUTH-M2 compatibility layer 的着力点。

前端侧有 **18 个文件**引用 `authService` / `fetchAuthed` / `currentUser` ——
同理，只要 `authService` 的对外签名不变，业务组件不必逐个改。

## 11. logout / session expiry / password reset

| 能力 | 现状 | 迁移后 |
|---|---|---|
| logout | 删 `refresh_jti` 行 | Supabase `signOut()` |
| session expiry | access 15min，客户端提前刷新 | Supabase 自动刷新 |
| refresh 撤销 | `refresh_jti` 表 | Supabase 会话管理 |
| password reset | **未实现** | Supabase 内置（需配 SMTP） |
| 角色撤销即时失权 | **不支持**（role 在 JWT 里，15 分钟内有效） | Portal 已验收：DB 现查，撤销即时生效 |

> 「角色撤销即时失权」是 App 现在**完全不具备**的能力，也是迁移的主要安全收益之一。

## 12. Capacitor / Web 双端行为

`capacitor.config.ts`：`appId=com.amas.seminary`，`webDir=dist`，无自定义 scheme / 服务端配置。
两端跑同一份 SPA，认证差异仅在 localStorage 可用性。

**迁移影响**：Supabase JS 默认 localStorage，**双端行为不变**。
唯一需要额外验证的是**密码重置的深链回跳**（`capacitor://` vs `https://`）——
这是新增能力，Web 与真机都要单独验收（AUTH-M7）。

---

## 身份迁移映射（Identity Migration Map）

| 维度 | Legacy（App） | 目标（Supabase） | 迁移动作 |
|---|---|---|---|
| 用户主键 | `users.id`（randomUUID） | `auth.users.id`（UUID） | 值替换；建 `legacy_user_map` 留痕 |
| 人物资料 | `users.name/avatar/bio/degree` | `public.profiles` | 迁入 profiles，**不建第二套** |
| 邮箱 | `users.email` UNIQUE NOCASE | `auth.users.email` | 冲突检测；重复须人工合并 |
| 密码 | `password_hash + salt`（自管） | Supabase Auth | **不迁移哈希**；改为邀请/重置流程 |
| 角色 | `users.role`（student/admin） | `public.user_roles`（9 角色 + scope + revoked_at） | admin → 对应管理角色；student → student |
| 会话 | 自签 HS256 + `refresh_jti` | Supabase 会话 | 直接弃用；`refresh_jti` 108 行全部作废 |
| 授权 | `requireAuth/requireAdmin` | RLS + RPC + Edge + 角色现查 | AUTH-M4 |
| 学习进度 | `course_progress`（0 行） | 待定表，主键 = `auth.users.id` | 结构迁移，无数据 |
| CP / 成长 | `growth_state`（0 行） | 待定表，主键 = `auth.users.id` | 结构迁移，无数据 |
| 其余用户数据 | 23 表 / 268 行 | 同表、换 user id | 按 `legacy_user_map` 批量替换 |

---

## 迁移阶段与风险控制

### AUTH-M2｜Compatibility Layer（下一步实施）

**后端**：`requireAuth` 内部改为验 Supabase JWT，`req.principal` 契约保持不变
→ 16 个路由文件零改动。迁移期内按 `iss` 分辨两种 token，**分别验签，绝不互相兜底**。

**前端**：`authService` 对外签名保持不变（`login/logout/fetchAuthed/currentUser`），
内部换成 Supabase 客户端 → 18 个业务文件零改动。

这一层是"不要大爆炸替换"的具体保证：任何时刻都可以只切一层。

### AUTH-M6｜迁移安全设计（不因数据少而跳过）

1. **legacy user mapping**：`legacy_user_map(legacy_id, supabase_id, email, migrated_at, source)`，
   保留全量映射，永不删除。
2. **dry-run**：迁移脚本默认只报告不写入，输出将要改动的表 / 行数 / 冲突。
3. **orphan detection**：23 张表逐一检查 `user_id` 是否都能在映射表命中 ——
   因为只有 5 张表有 FK 约束，数据库**不会**替我们报错。
4. **duplicate email detection**：App `users.email` ↔ Supabase `auth.users.email`
   大小写不敏感比对，任何重复必须人工裁决后才继续。
5. **foreign-key integrity test**：迁移前后各跑一次全表用户外键完整性核对。
6. **rollback**：迁移在事务内进行；映射表保留反向查询能力，可整体回退到 legacy id。

### 普通学生不强制 MFA

Portal 现有实现已符合该要求，无需改动，但要在迁移中**明确保持**：

- `requireRole()`（不带 aal2）用于学生日常路径 —— 学员中心、课程目录、资料页
- `requireRoleAal2()` 只用于管理端敏感动作 —— 招生审核、学籍管理、学号纠错
- Edge Function 的 `aal2` 强制只加在管理类函数上

迁移后 App 的学习路径**一律走非 MFA 路径**。这一条将写进 AUTH-M4 的验收：
「普通 student 全程无 TOTP 即可完成学习动作」必须是一条 PASS 用例。

### AUTH-M7｜删除 Legacy Auth 的前置条件

App Web、Capacitor 真机、Portal、session restore、logout、revoke、RLS、CP、
growth state、learning state 全部验收通过后，才删除：

- `backend/src/auth/jwt.ts` 的签发路径
- `refresh_jti` 表
- `POST /api/auth/_promote`（提权后门）
- `users.password_hash` / `salt`
- 前端 `permissions.ts` 中永远走不到的 `dean` / `teacher` 分支

**不允许两套身份系统长期双写。**

---

## Decision Required

无。本审计未发现与已批准政策冲突之处，按 AUTH-M2 继续实施。

以下三项属实施细节，我按最保守方式处理，不单独占用决策：

1. **密码不迁移**：Supabase 不接受外部 bcrypt 哈希作为登录凭据，
   现有 7 个账号中 6 个是测试产物，唯一真实账号走密码重置邮件即可。
2. **测试账号不迁移**：`@amas.test` / `@amas.local` 共 6 个账号只做映射留痕，
   不在 Supabase 建号。
3. **`_promote` 端点在 AUTH-M3 落地时同步移除**，不等到 AUTH-M7 ——
   它是一条绕过 Supabase 角色体系的提权路径，不应与新体系并存哪怕一天。
