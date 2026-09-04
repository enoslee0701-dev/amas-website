# AMAS PROJECT HANDOFF

> 本文档用于 AMAS 项目的长期跨对话、跨 Agent、跨工作流交接。
> 每次重大阶段结束、架构决策、Production 状态变化或 blocker 变化后必须更新。

**独立可读**：本文件不依赖任何聊天上下文。凡出现「某个决定」，必须写出决定内容本身。

---

## Source of Truth Priority

信息冲突时，按以下优先级采信：

1. 当前实际 Production / Staging Runtime
2. 当前数据库 / Supabase 实际状态
3. 当前 Git HEAD 与代码
4. 已批准正式规范 / migrations / security rules
5. `AMAS_PROJECT_HANDOFF.md`（本文件）
6. 历史报告
7. 聊天记录

**本文件是长期记忆与决策交接文件，不是替代 Git / DB / Runtime 的事实来源。**

读取本文件后若发现实际代码与本文件不一致：**必须报告差异并更新本文件**。
**不得因为本文件写了 PASS 就忽略当前实际 FAIL。**

标记约定：
`UNKNOWN` = 尚未查证 · `DECISION_REQUIRED` = 需用户决定 · `BLOCKED` = 等待外部条件
**不得用猜测填空。**

## 关联协议

| 文件 | 作用 |
|---|---|
| `docs/operations/AI_COLLABORATION_RULES.md` | **GPT × Claude 双模型协同开发协议 v1.0**：角色分工、主导范围、Stop Conditions、六步开发流程、标准 DEVELOPMENT REPORT 格式、状态语言规范、技术争议处理机制 |
| `docs/operations/engineering-security-rules.md` | 工程安全规则 R-1 ～ R-10 全文 |

> **`AI_COLLABORATION_RULES.md` 的 Source of Truth = `amas-website/docs/operations/AI_COLLABORATION_RULES.md`**（见 D-9）。
> `AMAS-Seminary/docs/project-memory/AI_COLLABORATION_RULES.md` 是**逐字节镜像**。
> 修改流程：先改权威版本 → 提交 → 原样复制到镜像 → 提交。漂移检测：
> `diff -q <两份文件路径>`（两份必须始终逐字节相同，**禁止**给它们加不同的说明文字）。

## 关于 Main HEAD 的记录口径

§0 与 §24 的 `Main HEAD` 记录的是**刷新本文件时仓库的 HEAD**，因此它必然落后一个提交——
落后的那个正是「更新本文件」这次提交本身。文档无法记录自己所在的哈希，**这是约定而非缺漏，不必追平**。
核对时若只有这一个提交的差距且该提交就是本文件的更新，**不算不一致**。

---

# 0. Document Control

| 项 | 值 |
|---|---|
| **Project** | AMAS 亚洲宣教神学院（Asia Missionary Association Seminary，泰国清迈） |
| **Document** | `docs/operations/AMAS_PROJECT_HANDOFF.md` |
| **Version** | 1.1 |
| **Last Updated** | 2026-09-04 |
| **Updated By** | Claude（依据两仓库真实 Git 状态与已归档报告，非聊天记忆） |
| **Main Repository** | `enoslee0701-dev/amas-website`（官网 + 门户 + Supabase） |
| **Secondary Repository** | `enoslee0701-dev/AMAS-Seminary`（App；本地目录名 `Desktop/AMAS Seminar App`） |
| **Main HEAD（website）** | `1388668` 重建 AMAS_PROJECT_HANDOFF 为跨对话长期记忆总档（v1.0） |
| **Main HEAD（App）** | `8921c9b` docs: 补齐项目记忆的四块缺失 |
| **Active Branches** | website: `master`（唯一）· App: `main`、`auth/supabase-unification`(`4af8307`) |
| **Active Worktrees** | website: `C:\Users\enosl\Desktop\AMAS-website` · App: `C:\Users\enosl\Desktop\AMAS Seminar App` |
| **Current Environment** | Supabase **staging** `amas-staging`（ref `sdrwyebizfdwldlfjyim`，ap-southeast-1，PG 17.6） |
| **Production Status** | **NOT ESTABLISHED** —— 无 production Supabase、无正式域名、无 SMTP |

---

# 1. Project Mission

**要解决的问题**：AMAS 是一所设在泰国清迈的神学院，招生与教学此前依赖线下与零散渠道。
本项目要建立一套**从公开发现 → 申请 → 学籍 → 学习 → 成长追踪**的完整数字系统，
并让网站与移动 App 共用同一套身份与权限。

**真实用户**：

| 用户 | 需求 |
|---|---|
| 慕道者 / 潜在学生 | 了解学院、做快速信仰成长探索、提交入学申请 |
| 申请人（applicant） | 填报、补件、查看审核进度 |
| 在读学生（student） | 查看学籍、课程、待处理事项、成长画像 |
| 教师（teacher） | 通过邀请码完成资质验证、进入教师工作台 |
| 教务 / 招生 / 财务 / 管理员 | 审核申请、建立学籍、管理学号、查审计 |

**主要模块**：官网与招生入口 · 四空间门户（申请人/学生/教师/管理）· Supabase 身份与权限
· Christian Profile 成长画像 · 学习读模型 · 移动 App（含公共房间与语音）

**Production Ready 的定义**（必须全部满足，缺一不可）：

1. Production Supabase 建立，0001–0021 迁移与 7 个 Edge Function 全部部署
2. 全量验收脚本在 **production** 重跑通过（staging PASS 不能替代）
3. `mailer_autoconfirm = false` 且自有 SMTP 配置完成并实测收信
4. 正式域名确定，Site URL / Redirect URLs 收敛为精确 URL（不使用 `/**` 通配）
5. 四语言正式申请表升版完成
6. 备份与回滚方案就绪并演练过

---

# 2. System Architecture

## 2.1 仓库与职责

```
enoslee0701-dev/amas-website          官网 + 四空间门户 + Supabase 全部 migrations/Edge Functions
  └── GitHub Pages（master 分支直发）  https://enoslee0701-dev.github.io/amas-website/

enoslee0701-dev/AMAS-Seminary          移动 App（React + Vite + Capacitor）+ 自有 backend
  ├── main                             公共房间 / 祷告室 / 语音 / Christian Profile
  └── auth/supabase-unification        AUTH 身份统一工作（尚未合入 main）
```

**分工**：网站负责发现与招生，App 负责持续装备与成长。

## 2.2 身份原则（核心）

```
auth.users.id  ──►  唯一 Person Identity
```

由它关联：

```
auth.users.id
 ├── profile                  基础资料
 ├── user_roles               角色授予（唯一权威，不用 JWT metadata）
 ├── login_aliases            学号/教职工号 → 账号（仅服务端可解析）
 ├── application              入学申请
 ├── student_record           学籍
 ├── Christian Profile        成长画像
 ├── learning                 学习读模型
 ├── evidence                 实践证据
 ├── prayer identity          App 房间身份
 └── mentor relationship      （未实现）
```

**禁止**把 email / 学号 / role 当作 Person ID。

## 2.3 组件现状

| 组件 | 位置 | 状态 |
|---|---|---|
| Web 官网 | `amas-website` 根目录静态页 | 已上线（GitHub Pages） |
| Portal | `amas-website/portal/**` 13 页 | staging PASS |
| Auth 页面 | `login/ register/ forgot-password/ auth/callback/ auth/recovery/ portal/mfa/` | staging PASS |
| Database | Supabase Postgres 17.6 · migrations `0001`–`0021` | staging |
| Edge Functions | 7 个（见 §7） | staging |
| App 前端 | `AMAS Seminar App/`（React + Vite） | code-stage |
| App backend | `AMAS Seminar App/backend/` | code-stage |
| Christian Profile | 规格见 §9 | Level 0 已上线，Level 1/2 在 App |
| Prayer Room | App 五个公共房间 | P1-2 完成 |
| Voice | LiveKit 接入 | **BLOCKED** |
| Android | Capacitor 8.5.1 | Native Build READY，真机验收 PENDING |

---

# 3. Non-Negotiable Architecture Rules

正式全文见 **`docs/operations/engineering-security-rules.md`**（R-1 ～ R-10，每条来自一次真实事故或明确决策）。
本节只做索引与摘要，**不重复全文**。冲突时以该文件为准。

| 编号 | 规则摘要 |
|---|---|
| **R-1** | 临时特权 / context bypass token 必须最小作用域且**用后即焚**；安全性不得依赖调用方事务边界、连接池或框架默认实现。新增 GUC/flag 必须有「合法 RPC 之后同事务内直写」的逃逸测试 |
| **R-2** | **权限展示 ≠ 权限控制**。按钮显隐/导航过滤/路由跳转只是展示；门禁必须同时在 RLS + RPC 角色复核 + Edge 入口校验（角色 + aal）。上线前必须验证绕过 UI 直打 REST/RPC/Edge 会被拒 |
| **R-3** | 身份标识级操作（释放/重分配/撤销学号、教职工号、登录别名）**必须双人控制**：发起 ≠ 确认，两人中必须有 super_admin，前置条件确认时刻原子重验，全程审计 |
| **R-4** | 外键维护动作不得被写保护触发器误伤；写保护只拦 UPDATE 并放行「仅置空 actor 外键」，DELETE 交给级联 |
| **R-5** | fail-closed 占位函数（`is_assigned_teacher` / `is_enrolled_student` / `is_assigned_mentor`）**不得为了让页面看到数据而改成 true** |
| **R-6** | `service_role` / secret 永不进前端、永不进 Git；MFA secret、otpauth URI、邀请码明文不得进审计/日志/前端存储 |
| **R-7** | **不制造假数据**：无真实数据显示真实空态，不填充占位，不建空页面 |
| **R-8** | 新增正式业务记录必须在 `irreversible_record_sources` 登记并回答「是否构成学号的不可逆记录」；`pending_decision` 一律 fail closed。守卫 `portal2b_irreversible_guard.sql` 每次新增 migration 必跑 |
| **R-9** | **不同工作流不得共享同一个 Git working tree**；高风险任务用独立 branch + worktree；已混合的历史禁止 force push / amend / rebase，改补 provenance manifest |
| **R-10** | **缺失作者 ≠ system author**；用 `user_id = NULL` + `author_state = deleted_account` 的 tombstone，不建 fake system user，前端显示「已注销用户」而非「匿名用户」 |

**补充架构铁律**（与上表并列，不可擅自推翻）：

- Supabase Auth 是**统一身份方向**（D-2B-1 批准方案 A）
- `auth.users.id` 是唯一 Person Identity
- UI role visibility ≠ authorization；authorization 必须 **server-side**
- 普通 student **AAL1 即可正常学习**；仅敏感管理动作要求 **AAL2**
- `requireAdmin` 必须使用**实时 server-side role**，不得读 token 里的旧角色
- client 传来的 userId / role / email **一律不可信**
- Legacy `_promote` 提权路径**不得恢复**
- **fail closed** 是默认姿态
- issuer 严格分流，**不允许 token verification fallback**
- **不允许生产 mock 冒充真实能力**
- **不允许凭空制造课程、学分、成绩、统计**
- **account role ≠ room role**（App 房间运营权只以 `room_members.role` 存在）

---

# 4. Product / Policy Decisions

### D-2B-1｜App 迁移到 Supabase Auth

**Status**：`APPROVED`
**Decision**：App 迁移到 Supabase Auth，Supabase 成为 AMAS App / Portal 的**统一身份与权限 Source of Truth**。
**Reason**：两端各自维护身份会产生两套 Person ID，学籍、画像、学习记录无法可靠归属同一个人。
**Do Not**：不得在 App 侧保留独立的身份签发路径；不得让 email/学号充当 Person ID。
**Source**：`docs/operations/AUTH-M1-identity-audit.md`

### D-2B-2｜课程名称漂移以 App 权威目录为准

**Status**：`APPROVED`（读模型层）／官网文案同步 `DECISION_REQUIRED`
**Decision**：官网作「世界观理解」，App 权威目录作「世界观」，**同一门课，非新增非删除**。读模型按权威源采用「世界观」（`0016_course_catalog.sql` 中 `c_worldview` 即 `世界观`）。
**Do Not**：不得当成两门课；不得因名称不同而新增条目。
**待定**：官网文案是否同步改为「世界观」尚未拍板。
**Source**：`docs/operations/PORTAL-2B-acceptance-report.md`、`docs/operations/PORTAL-learning-data-audit.md`

### D-AUTH-R2｜Web canonical recovery route

**Status**：`APPROVED`
**Decision**：Web 端密码恢复的规范路由为 **`/auth/recovery`**（`auth/recovery/index.html` 已存在）。
**Do Not**：不得让 recovery 复用 `/auth/callback` 作为最终落点。
**Source**：website commit `64ab70f`

### D-AUTH-R3｜Android deep link 精确匹配

**Status**：`APPROVED`
**Decision**：移动端 redirect 使用精确的 **`amas-seminary://auth/recovery`**，**不使用** `scheme://**` 通配。
**Reason**：M6.5B-Preflight 实测：配了 `/**` 之后该 origin 下任意路径都可作回跳目标。
**Do Not**：不得写进 `capacitor.config.ts`（Capacitor `App` 插件无此配置项，会触发类型错误且不生效）。
**Source**：App branch `auth/supabase-unification`，`docs/AUTH_DEEP_LINK_SETUP.md`

### D-AUTH-R5｜Production 强制改密重认证

**Status**：`APPROVED`（Decision Closed）
**Decision**：production 设 `security_update_password_require_reauthentication = true`。
**实测结论**：Flow A（忘记密码 / recovery session）**不受影响**，仍可直接设新密码，不要求旧密码与 nonce；Flow B（已登录改密）按 session 新鲜度要求 `reauthenticate()`。伪造/畸形 nonce 一律 403 fail closed；nonce 不进审计。
**Do Not**：**Flow A 与 Flow B 必须是两个不同的 UI / 状态机**，不得让 recovery 用户走「输入当前密码」路径。
**Source**：App branch，`docs/operations/AUTH-production-auth-config.md`

### D-AUTH-R6｜Recovery Finalization 幂等

**Status**：`APPROVED`
**Decision**：不把「recovery credential 只能成功消费一次」当作唯一保护。即使底层 verification 在极端并发下出现多个成功结果，**AMAS 最终 password finalization 仍最多执行一次**——由数据库条件 UPDATE 原子裁决，ROW_COUNT 必须为 1。
**Do Not**：不得用 check-then-act；失败只进 `failed_retryable`，**不得重新创建身份**，一次网络失败不得永久锁死用户。
**Source**：`supabase/migrations/0020_recovery_finalization.sql`

### D-2｜Applicant ≠ Student

**Status**：`APPROVED`
**Decision**：公开注册**只产生 applicant**。`accepted` 状态**不等于**已进入学籍名册；`student` 角色只能由受保护的学籍建立流程授予。
**Reason**：学籍由 AMAS 总校审核建立（《新生入学手册 V2.0》第十节 + 官网多处）。
**Do Not**：不得因申请被批准就自动授予 student 角色或生成学号。
**Source**：`docs/operations/PORTAL-blueprint.md`、`docs/permissions/matrix.md`

### D-3｜学号纠错 vs 学号退役

**Status**：`APPROVED`
**Decision**：区分 `retired`（正常退役）与 `voided_clerical_error`（笔误作废）两种终态，释放走**双人控制**（见 R-3）。闸门 `student_number_has_irreversible_records()` 遍历 `irreversible_record_sources` 登记表动态求值。
**Do Not**：不得把检查逻辑写死在函数里靠注释提醒后人扩展。
**Source**：`0015_student_number_states.sql`、`0018_irreversible_record_registry.sql`

### D-4｜两条学习路径

**Status**：`APPROVED`
**Decision**：正式 B.Th 学籍路径 / 共同学习路径。**共同学习不自动建立 B.Th 学籍、不自动授予学位、记录不自动转换为学位学分或毕业资格**；日后申请正式 B.Th 须重新完成当时有效的申请与审核。
**Source**：《新生入学手册 V2.0 中文完善版》（甲方审定）

### D-5｜Christian Profile 不做综合属灵分数

**Status**：`APPROVED`
**Decision**：四层（A 信仰基础 / B 门徒生命 / C 事奉倾向 / D 事奉准备度）分别测量、分别呈现，**永远不合成一个总分**。12 项是独立倾向维度而非互斥类型，永远呈现 Top 3 + 全 12 维。
**Do Not**：不做综合属灵分数；不说「你就是 X」；不用红绿表示好坏；未经样本验证前不得宣称「科学验证 / 标准化 / 准确率」。
**Source**：`AMAS Seminar App/docs/CHRISTIAN_PROFILE_SPEC.md`

### D-6｜评分确定性，AI 只解释

**Status**：`APPROVED`
**Decision**：评分是**确定性引擎**（同样答案永远同样结果）；AI 只能做解释与推荐，**不能打分、不能改分**。
**Source**：同上

### D-7｜course completion ≠ ministry orientation

**Status**：`APPROVED`
**Decision**：信仰知识、灵修实践、事奉经验**永远不进入** 12 项事奉倾向的计算；倾向只由 C 类（Likert/频率）+ D 类（情境）题目决定。
**Source**：同上

### D-9｜治理文档的 Source of Truth 集中在 amas-website

**Status**：`APPROVED`
**Decision**：`AI_COLLABORATION_RULES.md` 的权威版本位于 **`amas-website/docs/operations/`**；
`AMAS-Seminary/docs/project-memory/` 下为**逐字节镜像**。两份必须始终完全相同（含其内的 Source of Truth 一节）。
**Reason**：其余治理文档（`engineering-security-rules.md`、`AMAS_PROJECT_HANDOFF.md`、`permissions/matrix.md`）
均只存在于 `amas-website`。协议若另置他处，治理文档会分裂到两个仓库。
沿用 `discover.html` 的既有约定，不引入新机制。
**Do Not**：不得只改镜像；**不得给两份加不同的说明文字**——那会使 `diff -q` 漂移检测永久失效，漂移从此不可见。
**Source**：website `2bc4d29` 起；App 镜像 `914bb7c`

### D-8｜Production 域名未确认时不得编造

**Status**：`DECISION_REQUIRED`
**Decision**：`PRODUCTION_DOMAIN = DECISION_REQUIRED`。**GitHub Pages URL 不作为 production 域名。**
**Do Not**：不得在任何配置、文档或代码中填入猜测的正式域名。
**Source**：App branch，`docs/operations/AUTH-production-auth-config.md`

---

# 5. Formal Course Boundary

```
当前正式课程总数：67 门 / 7 类
```

**权威来源**：

| 层级 | 文件 |
|---|---|
| 数据库权威目录 | `supabase/migrations/0016_course_catalog.sql` |
| 一致性守卫 | `supabase/tests/portal2b_catalog_consistency.mjs`、`supabase/tests/program_catalog_consistency.mjs` |
| 业务规则来源 | 《AMAS 新生入学手册 V2.0 中文完善版》（甲方审定） |
| 名称漂移审计 | `docs/operations/PORTAL-learning-data-audit.md` |

## 课程名称

正式课程名称包括 **`世界观`**（数据库 `c_worldview`）。

**不得擅自改成 `世界观理解`。** 官网当前文案仍作「世界观理解」，
是否同步修改属 `DECISION_REQUIRED`（见 D-2B-2）。这是同一门课，**非新增非删除**。

## Credits

```
正式学分表尚未批准  →  全部 credits 保持 null
```

`credits = null` 显示为「不显示学分信息」。

**禁止**：

- 自动推算学分
- GPA
- graduation progress / 进度百分比
- fake completion
- fake enrollment（无 enrollment 时显示空态，不创建空记录）

**11 项实践训练不计毕业学分**，未完成不影响毕业。

**毕业审核、授位、转学分、插班**等流程手册标注「待学院确认」，未获批准前不实现。

> 课程若正式变动，必须在此注明**谁批准、何时批准**。当前无任何已批准的变动。

---

# 6. Authentication & Identity Status

## 6.1 状态分级定义（不得混为「完成」）

```
CODE COMPLETE     代码写完，自测通过
STAGING PASS      在 staging 环境跑通全量验收
MERGED            已合入各自仓库主分支
DEPLOYED          已部署到目标环境
PRODUCTION PASS   在 production 重跑全量验收通过
```

## 6.2 各阶段现状

| 阶段 | 内容 | 状态 | 证据 |
|---|---|---|---|
| Legacy Auth | App 原 SQLite 身份 | 待迁移 | `AUTH-M1-identity-audit.md` |
| **AUTH-M1** | App 身份系统只读审计与迁移映射（未做任何修改） | **STAGING PASS**（审计完成，结论经甲方修正） | website `docs/operations/AUTH-M1-identity-audit.md` |
| **AUTH-M2 / M3** | 身份迁移前置 | **CODE COMPLETE**，未合 main | App branch `docs/operations/AUTH-M2-M3-provenance.md` |
| **AUTH-M4** | `UNKNOWN` —— 未在两仓库找到独立 M4 报告 | `UNKNOWN` | — |
| **AUTH-M5 / M6** | 真实身份 provision + 1:1 mapping + orphan tombstone | **CODE COMPLETE 11/11**，未合 main | App `a85e2c1` |
| **AUTH-M6.5A** | Credential Recovery Security Acceptance | **CODE COMPLETE 23/23**，未合 main | App `fe7cde8` |
| **AUTH-M6.5B-Preflight** | Redirect & Deep Link Preflight | **PASS**（reauth 8/8 · 矩阵 17/17 · M6.5A 复跑 20/20） | App `998cb66` |
| **AUTH-M6.5B-Mobile** | Android platform + `amas-seminary` deep link | **PASS 135/135** | App `d88c3b5` |
| **D-AUTH-R2 / R6** | canonical `/auth/recovery` + Finalization 幂等 | **STAGING PASS 29/29**，**已合 website master** | website `64ab70f` |
| **AUTH-R6.1** | Recovery Flow Liveness（幂等锁不锁死合法用户） | **STAGING PASS 13/13**，**已合 website master** | website `e13503e` |
| **AUTH-M7** | `NOT_STARTED` | — | — |

## 6.3 关键事实

- **website 侧的 AUTH 工作直接提交在 `master` 上**，未使用独立分支——与 **R-9** 的要求不符，是否为有意为之属 `DECISION_REQUIRED`（见 §19 BLOCKER-05）。
- **App 侧的 AUTH 工作全部在 `auth/supabase-unification` 分支（`4af8307`），尚未合入 `main`。** App `main`（`8921c9b`）不含任何 AUTH 迁移代码。
- **Production 是否真实启用 Supabase Auth：否。** production 尚未建立。

---

# 7. Authorization Security Model

## 7.1 角色

```
anonymous · applicant · student · teacher · mentor
registrar · finance · content_admin · academic_admin · super_admin
```

多角色并存；授予记录在 **`user_roles`** 表，**禁止 metadata 承载角色**。

## 7.2 强制层次（三层缺一不可，见 R-2）

| 层 | 机制 |
|---|---|
| 数据层 | RLS 策略（默认拒绝） |
| 函数层 | RPC / SECURITY DEFINER 内的角色复核 |
| 入口层 | Edge Function 校验（角色 + `aal`） |
| 展示层 | **仅是展示**，不构成门禁 |

## 7.3 Edge Functions（7 个）

```
login-by-identifier              学号/教职工号登录代理（service key，前端永远拿不到映射）
create-teacher-invitation        教师邀请码签发
submit-teacher-verification      教师资质提交
review-teacher-verification      教师审核 + 同事务授权
review-application               入学申请审核
student-lifecycle                学籍生命周期
recovery-finalize                密码恢复最终化（幂等）
```

## 7.4 AAL 策略

```
普通 student           AAL1 全程即可正常学习
敏感管理动作            强制 AAL2（教师与管理员激活时强制注册 TOTP）
```

## 7.5 已验证 / 未验证

**已验证（staging）**：

- 绕过 UI 直打 REST / RPC / Edge 被拒（PORTAL-1/2/2B 三层验收共 475 项断言）
- RLS 越权、跨账号读取、角色伪造被拒
- 管理员操作强制 aal2
- 学号登录限流（按标识 5 次 / 按 IP 20 次，advisory-lock 原子化，成功即清零）
- 临时特权用后即焚的逃逸测试（`P2-D10` / `P2-D11` / `V14`）
- 角色撤销即时生效（suspend/revoke 同时撤角色与学号别名）
- 注销参与过学籍流程的账号不被写保护触发器阻断

**未验证**：

- **以上全部未在 production 环境验证**
- 真实 SMTP 邮件链路（staging 用 `mailer_autoconfirm=true` 绕过）
- 生产并发规模下的限流表现
- 备份 / 回滚 / 可观测性（见 §20）

---

# 8. Portal Status

## Applicant

**Status**：`PASS`（staging）
**Completed**：申请数据模型（`0008`–`0011`）、状态机、字段锁定、补件、审计时间线、`review-application` Edge、招生审核闭环。验收 103/103（DB 23 + HTTP 46 + UI 28 + D-2 一致性 6），修复 3 个真实缺陷。
**Not Implemented**：四语言正式申请表升版。
**Forbidden Assumptions**：`accepted` 不等于已入学籍；不得自动授予 student 角色或生成学号。
**Current Blockers**：BLOCKER-03（正式申请表升版）。

## Student

**Status**：`PASS`（staging）
**Completed**：学籍身份与生命周期、HQ 审核门禁、学号规则与纠错（双人控制）、角色转换、学员中心、教务学籍管理（`0012`–`0015`）；学生资料页、课程目录只读模型、学习读模型 adapter、待处理事项、能力门禁、不可逆记录登记（`0016`–`0019`）。验收 164/164 + 208/208。
**Not Implemented**：真实成绩、学分、毕业进度（无已批准数据源）。
**Forbidden Assumptions**：credits 必须保持 null；不得推算任何进度百分比；无 enrollment 不创建空记录。
**Current Blockers**：无（阶段内）。

## Teacher

**Status**：`PARTIAL`
**Completed**：教师验证闭环（邀请码哈希 + 一次性核销、验证状态机、内部备注物理分表、审核与授权同事务 RPC）、教师工作台 v1、MFA 强制。SEC-2 部分含在 104/104 内。
**Not Implemented**：`is_assigned_teacher` 仍是 **fail-closed 占位**（恒 false）——教师「仅见被分配课程/班级」的能力**未实现**，需 `teacher_assignments` 关系表。
**Forbidden Assumptions**：**不得为了让教师页面看到数据而把占位函数改成 true**（R-5）。
**Current Blockers**：无（等待后续阶段排期）。

## Admin

**Status**：`PARTIAL`
**Completed**：管理后台 v1、审计日志按类别分读（super_admin 全量；academic_admin/registrar 仅 academic+admissions；finance 仅本人 finance）、招生审核、学籍管理、学号双人控制释放。
**Not Implemented**：角色授予/撤销的通用管理界面（当前仅通过受保护流程）。
**Forbidden Assumptions**：不得开放客户端直接写 `user_roles`。
**Current Blockers**：无。

---

# 9. Christian Profile Status

## 9.1 闭环

```
Assessment → Profile → Recommendation → Learning → Practice → Evidence
    ↑                                                              │
    └──────────────  Profile Update → New Recommendation  ─────────┘
```

## 9.2 当前规范版本

```
题库    CP_STANDARD_V1.0 / CP_QUICK_V1.0
评分    provisional_v1
语言    zh-CN
标注    Development Edition（尚未完成心理测量验证）
```

规格文件：`AMAS Seminar App/docs/CHRISTIAN_PROFILE_SPEC.md`
（由 `backend/scripts/gen-profile-spec.ts` 从代码自动导出，保证与 App 一致）

## 9.3 三个层级

| 层级 | 名称 | 题数 | 输出 |
|---|---|---|---|
| **Level 0** | 信仰成长快速探索（网页 `discover.html`） | 10 | 5 项初步状态 + 一条下一步建议；**不判定任何倾向** |
| **Level 1** | 事奉倾向画像 · 精简版（App） | 30 | 12 项倾向指数、Top 3、组合标签、平衡解读 |
| **Level 2** | Christian Profile 完整版（App） | 84 | 以上 + 信仰基础、门徒生命、事奉准备度、倾向×准备度矩阵 |

## 9.4 12 项事奉倾向

12 项是**独立维度**而非互斥类型：每个人都有全部 12 项，只是强弱组合不同。

```
01 教导者 Teacher            02 研道者 Scripture Explorer
03 装备者 Equipper           04 牧养者 Shepherd
05 劝勉者 Encourager         06 怜悯者 Mercy Giver
07 代祷者 Intercessor        08 传福音者 Evangelist
09 差传者 Missionary         10 领袖者 Leader
11 建造者 Builder            12 服事者 Servant
```

## 9.5 铁律

- 四层**永远不合成一个总分**（D-5）
- 信仰知识/灵修实践/事奉经验**永远不进入**倾向计算（D-7）
- 评分**确定性**，AI 只解释不打分（D-6）
- 每项倾向必须平衡解读：潜在优势 + 典型贡献 + 可能盲点 + 成长方向
- 措辞只用「评估/探索/画像/呈现倾向/建议尝试」，不用「诊断」「你就是」「你不适合」
- **Level 0 的 Source of Truth 是 `amas-website/discover.html`**；App 侧为同源副本，改动一律先在官网仓库完成再同步

> **不得建立新的第二套 Profile。**

## 9.6 实现状态

| 项 | 状态 |
|---|---|
| Level 0（官网） | 已上线 |
| Level 1 / Level 2（App） | 在 App `main` 分支，`UNKNOWN` 是否已完成真实数据闭环 |
| Portal 侧呈现 | PORTAL 只调用与呈现，**不重新实现评分** |
| evidence 分类 | `UNKNOWN` |
| Profile Update 回路 | `UNKNOWN` |

---

# 10. Learning System Status

| 能力 | 真实数据源 | 状态 |
|---|---|---|
| **catalogued** | `0016_course_catalog.sql`（67 门 / 7 类） | 已实现 |
| **accessible** | 能力门禁（`0019_student_role_gating.sql`） | 已实现 |
| **recommended** | Christian Profile 推荐 | `UNKNOWN`（Portal 只呈现，不实现评分） |
| **assigned** | `teacher_assignments` 表 | **NOT IMPLEMENTED** |
| **in_progress** | — | **NOT IMPLEMENTED** |
| **completed** | — | **NOT IMPLEMENTED** |
| **growth_state** | App 侧 | `UNKNOWN` |
| **evidence** | — | **NOT IMPLEMENTED** |

学习读模型 adapter 见 `0017_student_experience.sql`；审计见 `docs/operations/PORTAL-learning-data-audit.md`。

> `credits` 全部为 `null`，因此**不存在**任何真实的学分累计、GPA 或毕业进度。
> 不得用 placeholder 填补上表中标 NOT IMPLEMENTED 的项。

---

# 11. Prayer Room / Voice Status

## Prayer Room

**当前阶段**：P1-2 完成（App `d0d6030`）；**NEXT** 为 P1-3 交通室分享墙。

| 能力 | 状态 |
|---|---|
| 创建 | 五个内置公共房间，`host_id = 'system'`，**永远没有真人房主** |
| 加入 | 真实 membership（P1-1 `5d2df0f`） |
| presence | 真实 presence，唯一实现 `backend/src/rooms/presence.ts`，表 `room_presence` |
| host / 运营权 | 只以 `room_members.role = 'moderator'` 存在；**当前五个房间均为 0 moderator** |
| history | 读经室共享阅读位置持久化（`room_reading_state`，P1-2） |

**roomId**：`prayer_room` · `praise_room` · `bible_reading` · `preaching_room` · `fellowship_room`（前后端 1:1，无 alias）

**presence 生命周期**：轮询 10s · heartbeat 20s · TTL 45s；identity 全部来自 JWT，
**前端不得发送、后端不得信任** `userId / role / name / avatar`。

**测试基线（2026-09-04 实测）**：

```
frontend 123/123 · backend 103/103
room presence E2E 54/54 · room reading position E2E 44/44
rooms render guard 51/51 · prayer Phase 5 E2E 24/24
system room moderator E2E 26/26
tsc clean · build PASS · FAIL 0
```

**验收级别**：`Code-stage acceptance` —— 尚未在真实生产环境完成验证，**不得写成生产正式验收通过**。

## Voice

```
当前生产形态：  mock / demo（隔离的 build:voice-demo）
LiveKit：       代码侧已接入，凭据未配置

Production Voice Acceptance: PENDING
Phase 4B 实时语音: BLOCKED
```

**阻塞原因**：缺两台真实手机 + LiveKit 凭据，无法完成真人双向互听验证。
代码侧准备已完成（token 硬化、错误码、诊断面板、生产 mock 硬护栏、真机验收清单）。

**有设备之后只执行验收，不继续开发。**
真机验收表：`AMAS Seminar App/docs/PRAYER_VOICE_DEVICE_ACCEPTANCE.md`

> **不得**因为 token / SDK 测试通过就写 Production PASS。
> **不允许生产 mock 冒充真实能力。**

## 权限域分离

```
account role  ≠  room role
```

账号角色（`user_roles`）与房间运营权（`room_members.role`）是**两个不同的权限域**，
不得互相推导。

---

# 12. Recovery Security Status

## 12.1 规范路由

```
Web canonical:   /auth/recovery              （website，auth/recovery/index.html）
Android:         amas-seminary://auth/recovery（精确匹配，不用 scheme://**）
```

## 12.2 状态机

```
pending → processing → completed
             ↓
        failed_retryable → processing（可重试）
             ↓
          expired（终态，与 completed 一样不可再激活）
```

定义于 `0020_recovery_finalization.sql`（前四态）与 `0021_recovery_flow_liveness.sql`（新增 `expired`）。

## 12.3 关键设计与常量

| 项 | 值 / 机制 |
|---|---|
| **flow `expires_at` 来源** | **取自签发时调用者 JWT 的 `exp` claim**，不是写死的业务 TTL。凭据什么时候失效，flow 就什么时候失效 |
| **`PROCESSING_STALE_THRESHOLD`** | **`interval '10 minutes'`** |
| active unique constraint | 活动态（含 `failed_retryable`）唯一，防止用户绕开陈旧 flow 另建新 flow |
| atomic claim | `UPDATE ... SET status='processing' WHERE id=? AND status IN ('pending','failed_retryable')`，由 DB 裁决，ROW_COUNT 必须为 1 |
| password mutation | **exactly once**（幂等） |
| replay | 已验证被拒 |
| concurrency | 已验证（29/29） |
| liveness | 已验证（13/13）——幂等锁不会把合法用户永久锁死 |
| secret leakage | `recovery_flow_id` 是**非秘密**，不能作认证凭据，只用于流程关联与幂等控制；真正身份验证始终由 Supabase 完成 |
| Person ID preservation | 失败只进 `failed_retryable`，**不重新创建身份** |
| role preservation | 恢复流程不触碰 `user_roles` |
| 自愈 | `start_recovery_flow` 先回收调用者**自己**的陈旧 flow，不依赖后台 cron |
| reaper | 只做**状态迁移，绝不删除行**；只碰 `recovery_flows`，不触碰 application / student / CP / learning 数据 |

> **`PROCESSING_STALE_THRESHOLD = 10 minutes` 是当前 AMAS stale recovery 运行策略，
> 不是 Supabase Edge Function 最大执行时间的平台保证。**
> （此口径修正记录于 website commit `f72aba2`）

---

# 13. Android Status

| 项 | 值 |
|---|---|
| Capacitor | `@capacitor/android` **8.5.1** |
| AGP | **8.13.0**（`android/build.gradle`） |
| Gradle | **8.14.3**（`gradle-wrapper.properties`） |
| SDK | `minSdk 24` · `compileSdk 36` · `targetSdk 36` |
| JDK | Temurin **21.0.12.1 LTS**（AGP 8.x 需 17+，Capacitor 8 走 21） |
| Android SDK | scoop `android-clt`，`platforms/android-36`、`build-tools/36.0.0` |
| Platform Tools | adb **1.0.41** |
| SDK licenses | 7 项全部接受 |
| Manifest / deep link | `amas-seminary://auth/recovery`（**不写进 `capacitor.config.ts`**——该插件无此配置项，写了会类型报错且不生效） |

## 状态分级（严格区分，不得合并）

```
Deep Link Preflight        PASS      （App d88c3b5，135/135）
Native Build               READY     （App 4c0c2ca，完成一次真实 native build）
APK 产物                    UNKNOWN
Emulator 验收               UNKNOWN
Real Device Acceptance     PENDING
Production Recovery        PENDING
```

文档：App branch `docs/ANDROID_BUILD_ENV.md`、`docs/AUTH_DEEP_LINK_SETUP.md`

---

# 14. Deployment Reality

| 组件 | SOURCE | BUILD | DEPLOY | RUNTIME | E2E |
|---|---|---|---|---|---|
| **Website** | `amas-website` master | 无构建（纯静态） | GitHub Pages 从 master 直发 | ✅ https://enoslee0701-dev.github.io/amas-website/ | 已验证线上内容与 `origin/master` 逐字节一致 |
| **Portal** | 同上 `portal/**` | 同上 | 同上 | ✅ 页面可达 | 数据依赖 staging Supabase |
| **API（App backend）** | `AMAS Seminary App/backend` | `UNKNOWN` | `UNKNOWN` | `UNKNOWN` | code-stage 103/103 |
| **Supabase** | `amas-website/supabase` | migrations `0001`–`0021` | staging 已部署 | staging | 621 项 staging 断言 |
| **Edge Functions** | 同上 `supabase/functions` | 7 个 | staging 已部署 | staging | 含在上述断言内 |
| **Android** | App branch | Native Build READY | 未分发 | — | Real Device PENDING |

```
PRODUCTION_DOMAIN = DECISION_REQUIRED
```

**GitHub Pages URL 不作为 production 域名。** 未确定前不得在任何配置或文档中填入猜测值。

---

# 15. Environment Matrix

| Environment | Status | URL / Ref | Purpose |
|---|---|---|---|
| **Local** | 可用 | website: `python -m http.server`；App: Vite + 本地 backend | 开发与预览 |
| **Staging** | 运行中 | Supabase `amas-staging` · ref `sdrwyebizfdwldlfjyim` · ap-southeast-1 · PG 17.6 | 全部已完成的验收均在此执行 |
| **Production** | **NOT ESTABLISHED** | `DECISION_REQUIRED` | — |

## 配置项现状（**不写任何 secret 值**）

| 配置项 | Staging | Production 目标 | 状态 |
|---|---|---|---|
| Supabase project | CONFIGURED | NOT CONFIGURED | BLOCKER-01 |
| `mailer_autoconfirm` | `true` | **`false`** | 已定；BLOCKER-02 |
| SMTP | **NOT CONFIGURED** | REQUIRED（自有 SMTP） | BLOCKER-02 |
| `smtp_admin_email` / 发信域 | None | `DECISION_REQUIRED` | 依赖域名 |
| Site URL | `http://localhost:8090` | `DECISION_REQUIRED` | 依赖域名 |
| Web redirect URLs | `http://localhost:8090/**` 等通配 | **精确 URL**，禁用 `/**` | `DECISION_REQUIRED` |
| Mobile deep-link redirect | 无 | `amas-seminary://auth/recovery` | **已定**（D-AUTH-R3） |
| `security_update_password_require_reauthentication` | `false` | **`true`** | **已定**（D-AUTH-R5） |
| `mailer_otp_exp`（recovery TTL） | `3600s` | `3600s` | 已定（已实测过期生效） |
| `jwt_exp` | `3600s` | `3600s` | 已定 |
| `password_min_length` | `8` | `8`（是否提高属产品决策） | 已定 |
| MFA / TOTP | CONFIGURED | 不变 | 已定 |
| Allowed origins（CORS） | `http://localhost:5173` | `DECISION_REQUIRED` | 依赖域名 |
| LiveKit | **NOT CONFIGURED** | REQUIRED | BLOCKER-04 |
| Android build 环境 | CONFIGURED（本机） | — | — |
| `service_role` key | 仅后端环境变量 | 永不进前端 / Git | 已定 |

> ⚠️ `mailer_autoconfirm` 的真实值位于**托管项目 Auth 设置**中，**无法从仓库核验**。
> 仓库 `supabase/config.toml` 的 `enable_confirmations = false` 是 CLI 本地配置，
> **与之不是同一处**。上表 staging 值取自 `AUTH-production-auth-config.md` 的记录。

---

# 16. Security & Secrets Rules

**任何真实 secret 不得进入**：

```
Git · frontend bundle · logs · reports · audit_logs · security_events
shell history · adb command examples · CI logs · 本文件
```

具体禁止项：

- `service_role` / secret key 永不进前端、永不进 Git（R-6）
- MFA secret、otpauth URI、邀请码明文不得进入数据库审计、console log、network error log 或前端持久存储
- 前端只允许 `PUBLIC_SUPABASE_URL` + anon / publishable key
- 本地跑 UI 探针时临时填入 staging 配置，**跑完必须还原为空配置**
- LiveKit secret 只放服务端，**绝不进 `VITE_*`**

**Routing-only 验证**只能使用占位值：

```
TEST_ONLY_NON_SECRET
```

**真实 recovery 验收必须走真实邮件链路。**
**不得复制真实 token 塞进 shell / adb 命令。**
（此规则来源：App commit `4af8307` 文档修正——adb 示例改用非秘密占位值，
并区分 routing-only 与真实 recovery 验收。）

---

# 17. Git / Branch / Worktree State

## Website —— `amas-website`

```
Main HEAD:          1388668  重建 AMAS_PROJECT_HANDOFF（v1.0）
Main Status:        与 origin/master 完全同步（0 / 0）
Active Branches:    master（唯一，本地与远端）
Active Worktrees:   C:\Users\enosl\Desktop\AMAS-website
Dirty Worktrees:    无
Pending Merge:      无
Merge Blocker:      无
```

## App —— `AMAS-Seminary`（本地目录 `AMAS Seminar App`）

```
Main HEAD:          8921c9b  docs: 补齐项目记忆的四块缺失
Main Status:        有未跟踪文件（见下）
Active Branches:    main
                    auth/supabase-unification        4af8307   ← AUTH 工作全部在此，未合 main
                    backup/auth-supabase-before-reconcile  fe7cde8
                    backup/main-before-auth-cleanup        fd33fbe
                    archive/vite-2026-04                   2607049
Active Worktrees:   C:\Users\enosl\Desktop\AMAS Seminar App
Dirty Worktrees:    main 有未跟踪：
                      .git-backup-before-history-rewrite/
                      docs/project-memory/AI_COLLABORATION_RULES.md
Pending Merge:      auth/supabase-unification → main
Merge Blocker:      DECISION_REQUIRED —— 合并时机未定；合并前须按 R-9 走完整合并窗口
```

**最近一次 merge**：App `4f04acc`「合并窗口：main → auth 合入完成 + 测试产物显式清单 + 守恒式迁移报告」（2026-09-03）

## 并发纪律（R-9）

```
website 工作流   →  C:\Users\enosl\Desktop\AMAS-website
App 工作流       →  C:\Users\enosl\Desktop\AMAS Seminar App
```

**禁止**：

- 另一个 Agent 代提交
- shared working tree 并发修改
- 随意 stash
- destructive reset
- force push shared history
- amend / rebase 已共享提交

高风险或跨域任务必须开独立 branch + `git worktree`（独立目录、独立 `node_modules`）。
baseline 必须在自己的 worktree 中重新取得，不引用混合 commit 上的旧结果。

---

# 18. Completed Milestones

| Milestone | Status | Evidence |
|---|---|---|
| SEC-1 / SEC-2 / SEC-3 | **PASS**（staging） | 104/104（98 自动化 + 6 UI），修复 3 缺陷 · `SEC-3-acceptance-report.md` |
| PORTAL-SHARED / PORTAL-1 | **PASS**（staging） | 103/103（DB 23 + HTTP 46 + UI 28 + D-2 6），修复 3 缺陷 · `PORTAL-1-acceptance-report.md` |
| PORTAL-2A（Student Core） | **PASS**（staging） | 164/164（DB 32 + 学号 19 + HTTP 72 + UI 41），修复 2 缺陷 · `PORTAL-2-acceptance-report.md` |
| PORTAL-2B | **PASS**（staging） | 208/208（DB 129 + HTTP 31 + UI 38 + 目录 10），修复 1 缺陷 · `PORTAL-2B-acceptance-report.md` |
| AUTH-M1 | **PASS**（只读审计） | `AUTH-M1-identity-audit.md`（结论经甲方修正） |
| AUTH-M2 / M3 | **PARTIAL**（未合 main） | App `docs/operations/AUTH-M2-M3-provenance.md` |
| AUTH-M4 | **NOT_STARTED** / `UNKNOWN` | 未找到独立报告 |
| AUTH-M5 / M6 | **PARTIAL**（11/11，未合 main） | App `a85e2c1` |
| AUTH-M6.5A | **PARTIAL**（23/23，未合 main） | App `fe7cde8` |
| AUTH-M6.5B-Preflight | **PARTIAL**（8/8 · 17/17 · 20/20） | App `998cb66` |
| AUTH-M6.5B-Mobile | **PARTIAL**（135/135） | App `d88c3b5` |
| D-AUTH-R2 / R6 | **PASS**（已合 website master） | website `64ab70f`，29/29 |
| AUTH-R6.1 | **PASS**（已合 website master） | website `e13503e`，13/13 |
| AUTH-M7 | **NOT_STARTED** | — |
| Prayer P0（拆除假象） | **PASS**（code-stage） | App `d8abbd6` / `9609d22` |
| Prayer P1-1（Membership + Presence） | **PASS**（code-stage） | App `5d2df0f`，54/54 |
| Prayer P1-2（共享阅读位置） | **PASS**（code-stage） | App `d0d6030`，44/44 |
| Prayer P1-3（交通室分享墙） | **NOT_STARTED** | — |
| Voice Phase 4B（实时语音） | **BLOCKED** | 缺真机 + LiveKit 凭据 |
| Praise 音频（P2） | **BLOCKED** | 版权授权未取得 |
| Android Native Build | **PASS** | App `4c0c2ca` |
| Android Real Device Acceptance | **BLOCKED** | 缺真实设备 |
| Production Acceptance | **NOT_STARTED** | 见 §20 |

**website 累计 staging 断言：621 PASS**（104 + 103 + 164 + 208 + 29 + 13）
**App 累计 code-stage：425 PASS**（frontend 123 + backend 103 + presence 54 + reading 44 + render 51 + phase5 24 + moderator 26）

> 以上**无一项**为 Production Acceptance。

---

# 19. Current Blockers

### BLOCKER-01｜Production Supabase 尚未建立

```
Severity:  P0
Status:    BLOCKED
Owner:     用户
```

**Problem**：不存在 production Supabase 项目。
**Why it blocks**：一切 production 验收、真实用户开放、正式招生都无从谈起。
**Required external action**：用户创建 production 项目并提供访问方式。
**Next engineering action**：建项目后跑 `0001`–`0021` → 部署 7 个 Edge Function → 重跑全量验收脚本（迁移已幂等，脚本可直接复用）。

---

### BLOCKER-02｜`mailer_autoconfirm` 与 SMTP

```
Severity:  P0
Status:    BLOCKED
Owner:     用户（需提供 SMTP 服务与发信域）
```

**Problem**：staging 用 `mailer_autoconfirm = true` 绕过邮件验证；production 必须为 `false` 并配自有 SMTP，当前 SMTP **NOT CONFIGURED**。
**Why it blocks**：注册、邮箱验证、密码恢复全部依赖真实邮件链路；未配置则真实用户无法完成注册与找回。
**Required external action**：确定发信域名与 SMTP 服务商，提供配置。
**Next engineering action**：配置后实测收信，并执行真实 recovery 端到端验收（不得用复制 token 的方式替代）。

---

### BLOCKER-03｜四语言正式申请表未升版

```
Severity:  P1
Status:    BLOCKED
Owner:     用户 / 学院
```

**Problem**：正式申请表（中/英/韩/泰）尚未升版。
**Why it blocks**：阻断真实招生开放。
**Required external action**：学院提供审定后的正式申请表内容。
**Next engineering action**：按新版字段更新 `form_version` 与字段映射，重跑 PORTAL-1 验收。

---

### BLOCKER-04｜Phase 4B 实时语音

```
Severity:  P1
Status:    BLOCKED
Owner:     用户（需提供两台真实设备 + LiveKit 凭据）
```

**Problem**：无法完成真人双向互听验证。
**Why it blocks**：整条语音产品线卡住；生产不得以 mock 冒充。
**Required external action**：两台真实手机 + LiveKit URL / API Key / Secret。
**Next engineering action**：**有设备之后只执行 `PRAYER_VOICE_DEVICE_ACCEPTANCE.md` 的验收，不继续开发。**

---

### BLOCKER-05｜website 侧 AUTH 工作未走独立分支（R-9 合规性）

```
Severity:  P2
Status:    PENDING_DECISION
Owner:     用户 / GPT
```

**Problem**：website 的 AUTH 提交（`64ab70f`、`e13503e`、`f72aba2`）直接落在 `master`，未使用独立 branch + worktree，与 R-9 要求不符。
**Why it blocks**：不阻断当前工作，但该类高风险改动**失去了独立回滚边界**。
**Required external action**：确认是否为有意为之。
**Next engineering action**：若判定不合规，按 R-9「万一已经混合」的处置——**禁止** force push / rebase，改补 provenance / rollback manifest。

---

### BLOCKER-06｜App `auth/supabase-unification` 未合入 main

```
Severity:  P1
Status:    PENDING_DECISION
Owner:     用户 / GPT
```

**Problem**：AUTH-M2～M6.5B 全部成果只在分支 `4af8307` 上，App `main`（`8921c9b`）不含任何 AUTH 迁移代码。
**Why it blocks**：身份统一未真正生效于 App 主线。
**Required external action**：确定合并窗口。
**Next engineering action**：按 R-9 合并窗口执行——暂停其他工作流自动提交 → fetch/rebase → 处理冲突 → **全量回归（本分支 + 被合并方 + 前后端）** → merge → 恢复。

---

### BLOCKER-07｜Production 域名未确定

```
Severity:  P1
Status:    PENDING_DECISION
Owner:     用户
```

**Problem**：`PRODUCTION_DOMAIN = DECISION_REQUIRED`。
**Why it blocks**：Site URL、Redirect URLs、CORS allowed origins、发信域全部依赖它；且 production 禁用 `/**` 通配，必须填精确 URL。
**Required external action**：用户确定正式域名。**GitHub Pages URL 不作为 production 域名。**
**Next engineering action**：域名确定后按 `AUTH-production-auth-config.md` §3 收敛为精确 URL。

---

# 20. Production Acceptance Matrix

| Area | Status | Evidence / Blocker |
|---|---|---|
| Web Deployment | **PASS** | GitHub Pages 从 master 直发，线上与 `origin/master` 逐字节一致（15 文件 SHA256 核验） |
| Auth | **BLOCKED** | staging PASS；production 未建立（BLOCKER-01） |
| Authorization | **BLOCKED** | staging 已验三层门禁；production 未验（BLOCKER-01） |
| Applicant | **BLOCKED** | staging 103/103；正式申请表未升版（BLOCKER-03） |
| Student | **BLOCKED** | staging 164/164 + 208/208；production 未验 |
| Teacher | **BLOCKED** | `is_assigned_teacher` 仍 fail-closed 占位；production 未验 |
| Admin | **BLOCKED** | staging 已验；production 未验 |
| Christian Profile | **BLOCKED** | Level 0 已上线；Level 1/2 为 Development Edition，未完成心理测量验证 |
| Learning | **BLOCKED** | in_progress / completed / evidence 均 NOT IMPLEMENTED |
| Prayer | **BLOCKED** | code-stage PASS；production 未验 |
| Voice | **FAIL** | Production Voice Acceptance PENDING（BLOCKER-04）——**不得以 mock 记 PASS** |
| Android | **BLOCKED** | Native Build READY；Real Device Acceptance PENDING |
| Email | **FAIL** | SMTP NOT CONFIGURED（BLOCKER-02） |
| Recovery | **BLOCKED** | staging 29/29 + 13/13；真实邮件链路未验（BLOCKER-02） |
| RLS | **BLOCKED** | staging 已验；production 未验 |
| Edge Functions | **BLOCKED** | 7 个已部署 staging；production 未部署 |
| Backup | **UNKNOWN** | 无备份方案记录 |
| Rollback | **UNKNOWN** | 无回滚演练记录 |
| Observability | **UNKNOWN** | 无监控/告警方案记录 |
| Security | **BLOCKED** | staging 安全验收 PASS；production 未验 |

---

# 21. Known Risks / Technical Debt

> 本节只放**已知但不阻断当前工作**的真实风险。阻断项一律进 §19。

### 风险 1｜`is_assigned_teacher` 等占位函数长期 fail-closed

**Risk**：三个权限占位函数恒返回 false，教师/学生/导师的「仅见被分配对象」能力实际未实现。
**Impact**：教师工作台能力受限；未来实现时需同时补 `teacher_assignments` / `course_enrollments` / `mentor_assignments` 三张关系表与对应验收。
**Mitigation**：R-5 已明令禁止临时改 true；当前以真实空态呈现。
**When to revisit**：教师/学生真实分配关系进入排期时。

### 风险 2｜presence TTL 45s 导致离线判定延迟

**Risk**：用户离线后最多 45 秒仍显示在线。
**Impact**：房间人数短时不准确。
**Mitigation**：已记入 App backlog，本阶段不重新设计。
**When to revisit**：实时语音上线时一并评估。

### 风险 3｜读经室 3s 轮询而非实时推送

**Risk**：主持人切换阅读位置后，其他人最多 3 秒才看到。
**Impact**：体验延迟，非数据错误。
**Mitigation**：接受当前实现。
**When to revisit**：P1-3 之后或实时通道引入时。

### 风险 4｜官网课程名「世界观理解」与权威目录「世界观」不一致

**Risk**：两处文案不同，可能被误认为两门课。
**Impact**：读模型已统一取「世界观」，无数据错误；仅文案层不一致。
**Mitigation**：已在 `PORTAL-learning-data-audit.md` 记录；读模型按权威源。
**When to revisit**：见 D-2B-2，待用户拍板是否同步官网文案。

### 风险 5｜五个公共房间当前 0 moderator

**Risk**：运营权机制齐备但未授予任何人。
**Impact**：房间无人可发布共享阅读位置等运营动作。
**Mitigation**：`backend/scripts/room-moderator.ts` 可随时授予。
**When to revisit**：房间正式对外开放前。

### 风险 6｜App 仓库存在多个 backup / archive 分支与历史重写备份目录

**Risk**：`backup/*`、`archive/*` 分支与未跟踪的 `.git-backup-before-history-rewrite/` 长期存在，易造成误用。
**Impact**：仓库体积与认知负担。
**Mitigation**：暂不清理，保留回滚能力。
**When to revisit**：`auth/supabase-unification` 合入 main 并稳定后。

### 风险 7｜PORTAL-2 提交信息与验收报告断言数不一致

**Risk**：commit `5f8bc09` 写 114/114，验收报告写 164/164（分项 32+19+72+41=164）。
**Impact**：仅记录口径不一致，无功能影响。本文件按报告取 **164**。
**Mitigation**：已记录。
**When to revisit**：确认为笔误后归档。

---

# 22. Decision Required From User

> 只列**仅用户可决定**的事项。开发缺陷不进此节，应直接修复。

| # | 事项 | 说明 |
|---|---|---|
| 1 | **`PRODUCTION_DOMAIN`** | 正式域名。GitHub Pages URL 不作为 production 域名。Site URL / Redirect URLs / CORS / 发信域全部依赖它 |
| 2 | **SMTP 服务与发信域** | production 必须自有 SMTP；决定服务商与发信地址 |
| 3 | **正式申请表（四语言）内容** | 学院审定后提供，工程侧才能升版 |
| 4 | **67 门课程的正式学分表** | 未批准前 `credits` 一律 null，不得推算 |
| 5 | **官网课程文案是否改为「世界观」** | 与权威目录统一，属文案决策（D-2B-2） |
| 6 | **LiveKit 凭据 + 两台真实设备** | 解除 Phase 4B 语音 BLOCKED 的唯一路径 |
| 7 | **诗歌版权授权与音频托管方案** | 赞美室音频（P2）；产品/法务问题，非技术任务 |
| 8 | **`auth/supabase-unification` 合并窗口** | 何时把 App 的 AUTH 成果合入 main |
| 9 | **website AUTH 直提 master 是否为有意为之** | 关系到是否需要补 provenance manifest（BLOCKER-05） |
| 10 | **毕业审核 / 授位 / 转学分 / 插班规则** | 手册标注「待学院确认」，未批准前不实现 |
| 11 | **Account Deletion / Content Retention 政策** | R-10 只解决迁移中的归属问题，完整政策未经批准不得制定 |
| 12 | **P1-3 分享墙的表结构选择** | 复用 `prayer_shares` / `prayer_intercessions`（表名带 prayer 前缀但结构 room-generic），还是泛化表名？泛化会动到已上线真实数据 |

---

# 23. Next Approved Action

```
Current Priority:   Production Acceptance 准备（BLOCKER-01 + BLOCKER-02）

Next Action:        等待用户提供 production Supabase 项目与 SMTP 配置。
                    在此之前，工程侧无可推进的 production 工作。

Preconditions:      1. production Supabase 项目已创建且可访问
                    2. PRODUCTION_DOMAIN 已确定
                    3. SMTP 服务已确定

Do Not Start:       AUTH-M7
                    在 production 执行任何 migration
                    开放真实申请人 / 学生 / 教师使用
                    宣布任何 Production Acceptance
                    auth/supabase-unification 合并（未获合并窗口批准）
                    Phase 4B 语音的进一步开发（有设备后只验收，不开发）
```

---

# 24. CURRENT CHECKPOINT

> 新对话最优先读取本节。只看这一节也应知道项目当前在哪里。

```
Updated:                2026-09-04

Main HEAD:              website  1388668  重建 AMAS_PROJECT_HANDOFF（v1.0）
                        （按 §0「Main HEAD 记录口径」，落后的一个提交为本文件自身的更新）
                        App      8921c9b  docs: 补齐项目记忆的四块缺失

Active Branch:          website  master（唯一）
                        App      main + auth/supabase-unification (4af8307，未合并)

Active Worktree:        C:\Users\enosl\Desktop\AMAS-website          （clean）
                        C:\Users\enosl\Desktop\AMAS Seminar App       （main 有未跟踪文件）

Environment:            Supabase staging amas-staging
                        ref sdrwyebizfdwldlfjyim · ap-southeast-1 · PG 17.6
                        Production: NOT ESTABLISHED

Last Completed:         website  建立 AI_COLLABORATION_RULES 协议副本并入库
                        website  iOS 输入聚焦自动放大修复 · 首页 12 角色走马灯（含手机端）
                        website  AUTH-R6.1 Recovery Flow Liveness 13/13
                        App      P1-2 读经室共享阅读位置 44/44

Current PASS:           website  621 项 staging 断言（SEC 104 + P1 103 + P2 164
                                 + P2B 208 + D-AUTH 29 + R6.1 13）
                        App      425 项 code-stage 断言
                        以上无一项为 Production Acceptance

Current Blockers:       P0  BLOCKER-01  Production Supabase 未建立
                        P0  BLOCKER-02  mailer_autoconfirm=true / SMTP 未配置
                        P1  BLOCKER-03  四语言正式申请表未升版
                        P1  BLOCKER-04  Phase 4B 实时语音（缺真机 + LiveKit）
                        P1  BLOCKER-06  App auth 分支未合入 main
                        P1  BLOCKER-07  PRODUCTION_DOMAIN 未确定
                        P2  BLOCKER-05  website AUTH 直提 master 的 R-9 合规性

Waiting External        production Supabase 项目 · SMTP 配置 · 正式域名
Trigger:                两台真实设备 + LiveKit 凭据 · 四语言正式申请表
                        67 门课程正式学分表 · 诗歌版权授权

Next Approved Action:   等待 BLOCKER-01 / BLOCKER-02 的外部条件。
                        工程侧当前无可推进的 production 工作。

Do Not Do:              AUTH-M7
                        在 production 执行 migration
                        开放真实用户
                        宣布 Production Acceptance
                        合并 auth/supabase-unification（未获批准）
                        Phase 4B 语音的进一步开发
                        把 fail-closed 占位函数改成 true
                        为 credits 填入任何非 null 值
                        force push / amend / rebase 已共享提交

Production Status:      NOT READY —— 六项 Production Ready 条件（见 §1）全部未满足
```

---

## 维护规则

发生以下任一事件**必须**更新本文件：

```
Phase PASS · test 结果重要变化 · merge · deployment · migration
new blocker · blocker resolved · architecture decision · security decision
production configuration change · real-device acceptance · SMTP acceptance
domain confirmation · rollback / backup change
```

**更新流程**：

1. 读取当前本文件
2. 检查 Git / Runtime 当前事实
3. 更新受影响章节
4. 更新 §24 CURRENT CHECKPOINT
5. 更新 §0 Last Updated
6. 提交本文件与相关代码

> 若只是聊天讨论、未改变项目事实，**不要为了更新时间戳而制造无意义 commit**。

**不要写成流水账**：不记录 shell command、微小代码修改、console output、
token / password / secret、临时调试值。**只记录长期有用的事实、决策、状态和证据。**

## 新对话启动语

```
请先读取 docs/operations/AMAS_PROJECT_HANDOFF.md，然后核对当前 Git / Runtime
是否与 handoff 一致。不要直接改代码。报告差异后等待任务。
```
