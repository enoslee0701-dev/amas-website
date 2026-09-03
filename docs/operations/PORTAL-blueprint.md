# PORTAL Implementation Blueprint

**范围**：PORTAL-SHARED（门户共同底座）+ PORTAL-1（Applicant Center）+ PORTAL-2（Student Core）
**日期**：2026-09-03
**前置状态**：SEC-1 / SEC-2 staging 真实安全验收完成；SEC-3 staging acceptance 104/104 PASS；**Production Acceptance 尚未执行**；`mailer_autoconfirm=true` 为 **production blocker**（上生产前恢复 false 并配置正式 SMTP）；在 production 重跑验收前不开放真实教师使用。
**本文件性质**：实现前蓝图，**待确认后才动手**。第 14 节列出与既有业务规则的冲突核查结论与必须由甲方决定的政策点。

---

## 1. 代码现状审计

### 1.1 已存在（可直接复用）

| 类别 | 现状 | 复用方式 |
|---|---|---|
| 认证与会话 | `assets/js/portal/auth.js`：`getSession/getRoles/getProfile/homeForRoles/signIn/signUp/resetPassword/signOut/requireRole/requireRoleAal2/getAal/callFn/renderDisabled` | 升级为 PORTAL-SHARED 的 `auth.js`，保持 API 兼容 |
| 认证页 | `/login /register /forgot-password /auth/callback /portal/mfa` | 不改 |
| 门户外壳 | `/portal/`（多角色空间选择）、`/portal/applicant`（静态最小版）、`/portal/teacher`、`/portal/admin` | applicant 与 admin 将被 PORTAL-1 替换；teacher 保持 |
| 样式 | `assets/css/portal.css`（卡片/表单/状态条/spaces/badge/msg） | 扩展为含导航壳、时间线、空/错/载入态 |
| 数据库 | 0001 submissions；0002 profiles/user_roles/login_aliases/audit_logs/security_events；0003 加固+审计分类；0004 教师验证（**状态机 + 内部备注分表 + 同事务授权 RPC 的样板**）；0005-0007 修复 | 0004 是 PORTAL-1 申请状态机的直接范式 |
| Edge Functions | 4 个（登录代理、教师邀请/提交/审核） | 新增申请类函数沿用其鉴权骨架（JWT→角色→aal2→委托 DB 事务→审计） |
| 权限函数 | `has_active_role/current_user_has_role/is_admin_any` + 三个 **fail-closed 占位** | 占位在 PORTAL-2 建真实关系表后由新 migration 替换 |

### 1.2 缺口（本阶段要建）

- **没有申请数据模型**：官网申请弹窗当前只写 `submissions`（邮件/收件箱语义），无状态机、无归属、无补件、无审计时间线。
- **没有学籍数据模型**：`student_profiles`、学号规则、`student` 角色授予路径均未实现。
- **没有导航壳**：四个门户各写各的 header，没有统一的 nav/身份条/状态组件/审计钩子。
- **没有统一 API 层**：页面直接 `A.client.from(...)`，缺集中式错误映射、加载态、越权兜底。
- **移动端与可访问性**：现有门户页仅基础响应式，无键盘可达性与 aria 基线检查。

### 1.3 现有业务规则（**已审定，不得改动**）

来自《新生入学手册 V2.0 中文完善版》（甲方审定）与官网现行文案：

1. **学籍由 AMAS 总校审核建立**（官网多处 + 手册第十节）。
2. **两条路径**：正式 B.Th 学籍路径 / 共同学习路径。
3. **共同学习**：不自动建立 B.Th 学籍、不自动授予学位、**记录不自动转换为学位学分或毕业资格**；日后申请正式 B.Th 须**重新完成当时有效的申请与审核**。
4. **课程固定 67 门 / 7 类**；**各课学分待学院确认，确认前不显示、不推算**。
5. **11 项实践训练不计毕业学分，未完成不影响毕业**。
6. **毕业审核、授位、转学分、插班等流程「待学院确认」**（手册明确标注）。
7. **CP Source of Truth** = `amas-website/discover.html`（Level 0，`quick-faith-v1`），App 侧为同源副本；跳转参数 `source / assessment / areas`。PORTAL 只调用与呈现，不重新实现评分。

---

## 2. 数据模型（拟新增）

> 命名与 0002/0004 保持一致；所有表 RLS 默认拒绝；所有"操作者"外键 `ON DELETE SET NULL`（0007 既定策略）。

### 2.1 PORTAL-1 · 申请域

```
applications
  id uuid pk
  applicant_id uuid → profiles(id) on delete cascade      -- 归属者
  pathway         application_pathway                      -- bth | common_learning | undecided
  status          application_status                       -- 见 §3.1
  form_data       jsonb not null default '{}'              -- 白名单字段，服务端校验
  form_version    text not null default 'v1'
  locked_fields   text[] not null default '{}'             -- 提交后锁定的字段名
  submitted_at    timestamptz
  decided_at      timestamptz
  assigned_reviewer uuid → profiles(id) on delete set null
  applicant_visible_message text                           -- 申请人可见（与内部备注物理分离）
  created_at / updated_at
  部分唯一索引：每人同时只能有一份「活动」申请
    unique (applicant_id) where status not in ('rejected','withdrawn')

application_internal            -- 内部备注，仅管理员（照搬 0004 的分表模式）
  application_id uuid pk → applications on delete cascade
  notes text, updated_by uuid set null, updated_at

application_status_history      -- 时间线（申请人只可见安全字段）
  id bigint pk
  application_id uuid → applications on delete cascade
  from_status / to_status  application_status
  actor_id uuid set null, actor_role text
  applicant_visible_message text
  internal_note text                                       -- RLS 屏蔽给申请人
  created_at

application_requirements        -- 「要求补充资料」的条目化（可勾选完成）
  id uuid pk, application_id uuid → applications
  label text, detail text, resolved boolean default false
  created_by uuid set null, created_at, resolved_at
```

**文件上传**：本阶段**只预留接口不建 Documents Center**（甲方指示）。做法：`form_data` 内不放文件；新增 **空表 `application_documents`（结构占位、RLS 已配、无任何 UI）** ——否决，改为**完全不建表**，仅在 `applications` 保留 `documents_pending boolean default false` 标志位与 RPC 预留参数位；待招生文件规范（大小/类型/保存期限/隐私）批准后由 PORTAL-1b 建表。**本版不制造未批准业务规则。**

### 2.2 PORTAL-2 · 学籍域（本阶段只建模型与状态机，UI 待 PORTAL-2）

```
student_profiles
  user_id uuid pk → profiles(id) on delete cascade
  student_number text unique                    -- 仅 registrar 经受保护 RPC 创建
  pathway enum(bth, common_learning)
  enrollment_status enrollment_status            -- 见 §3.2
  source_application_id uuid → applications on delete set null   -- 生命周期链路
  cohort_label text                              -- 如「2026 届」；不引入未批准的班级实体
  enrolled_at timestamptz
  registrar_notes text                           -- 迁至 internal 分表
  created_at / updated_at

student_profiles_internal(user_id pk, notes, updated_by set null, updated_at)
```

学号（student_number）与教职工号一样进入 `login_aliases(alias_type='student_number')`，由受保护 RPC 写入，客户端不可读该表（SEC-1 既定）。

**不建**：课程注册表、成绩表、学分账 —— 这些属于 PORTAL-3+ 的教务域，且依赖"待学院确认"的学分制度，本阶段不碰。

---

## 3. 状态机

### 3.1 申请状态（`application_status`）

```
draft ──submit──► submitted ──assign──► under_review
  ▲                                        │
  │                            ┌───────────┼───────────┬──────────────┐
  │                            ▼           ▼           ▼              ▼
  └──resubmit── needs_information    accepted     rejected      (waitlisted?)
                                        │
                              §3.3 录取后转学籍（独立动作）

任意非终态 ──applicant withdraw──► withdrawn
```

允许迁移白名单（数据库触发器强制，照搬 0004 `tvr_validate_transition` 模式）：

| from | to | 谁可触发 |
|---|---|---|
| draft | submitted | 申请人（经 RPC `submit_application`） |
| submitted | under_review / needs_information / accepted / rejected | registrar / academic_admin（Edge + aal2） |
| under_review | needs_information / accepted / rejected | 同上 |
| needs_information | submitted | 申请人（经 RPC，requirements 需全部 resolved） |
| draft / submitted / under_review / needs_information | withdrawn | 申请人本人 |
| accepted / rejected / withdrawn | —— | **终态**（改判须新建申请，留审计） |

`waitlisted`（候补）**不纳入本版**——现行招生文案无候补制度，属未批准政策。

### 3.2 学籍状态（`enrollment_status`，沿用 SEC 规划）

```
pre_enrolled ──registrar 建档──► active ──► leave ⇄ active
                                   ├──► suspended ⇄ active
                                   ├──► completed   (终)
                                   └──► withdrawn   (终)
```

### 3.3 Applicant → Student 生命周期（**关键，含待确认点**）

```
auth.users ──(0002 触发器)──► profiles + role:applicant
    │
    ├─► applications (draft → submitted → under_review)
    │
    ├─► 录取决定 accepted            ← academic_admin/registrar，Edge+aal2，写审计
    │        ⚠ accepted ≠ 自动在籍
    │
    └─► 【建档动作】registrar 执行 RPC `enroll_student(application_id, ...)`
             ├ 创建 student_profiles（pathway 承自申请）
             ├ 生成 student_number（规则见 §14-P2）
             ├ 写 login_aliases(student_number)
             ├ 授予 role:student（保留 applicant 历史角色，见 §14-P3）
             ├ enrollment_status = 'active'（或 pre_enrolled，见 §14-P4）
             └ 全部同一事务 + audit(category='admissions')
```

**依据既有规则**：手册"学籍由 AMAS 总校审核建立"、"共同学习不自动建立 B.Th 学籍" → 录取与建档必须是**两个独立动作**，本设计与之一致。
**未定义之处**（§14 待确认，不自创）：建档的前置条件（是否须缴费/签署）、学号编码规则、accepted 后是否先 `pre_enrolled`、`applicant` 角色是否保留。

---

## 4. 权限矩阵（九角色 × 四层强制）

每格四层：**UI 可见性 / 路由守卫 / REST·RPC 权限 / RLS**；审计列注明写入类别。禁止只隐藏按钮。

| 能力 | anonymous | applicant | student | teacher | mentor | academic_admin | registrar | finance | super_admin | 审计 |
|---|---|---|---|---|---|---|---|---|---|---|
| 访问 `/portal/*` | ✗ 跳登录 | ✓ 自己空间 | ✓ | ✓(aal2) | ✓(aal2) | ✓(aal2) | ✓(aal2) | ✓(aal2) | ✓(aal2) | — |
| 读本人 profile | ✗ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — |
| 建/改**本人** draft 申请 | ✗ | ✓ RLS owner | ✓(如仍有活动申请) | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | 无（草稿不写审计） |
| 提交申请 | ✗ | ✓ RPC | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | admissions |
| 撤回申请 | ✗ | ✓ RPC(本人) | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | admissions |
| 读**他人**申请 | ✗ | ✗ RLS | ✗ | ✗ | ✗ | ✓ | ✓ | ✗ | ✓ | — |
| 审核决定 | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ Edge+aal2 | ✓ Edge+aal2 | ✗ | ✓ | admissions |
| 要求补充资料 | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ | ✓ | ✗ | ✓ | admissions |
| 读申请**内部备注** | ✗ | ✗ 分表隔离 | ✗ | ✗ | ✗ | ✓ | ✓ | ✗ | ✓ | — |
| 建学籍/发学号 | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ RPC+aal2 | ✗ | ✓ | admissions |
| 读本人学籍 | ✗ | ✗ | ✓ | ✗ | ✗ | ✓ | ✓ | ✗ | ✓ | — |
| 读 `login_aliases` | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗（仅 service） | — |
| 读财务 | ✗ | 本人（PORTAL-3） | 本人 | ✗ | ✗ | ✗ | ✗ | ✓ | ✓ | finance |
| 读审计 | ✗ | ✗ | ✗ | ✗ | ✗ | academic+admissions | academic+admissions | 本人 finance | 全量 | — |

> `student` 建/改申请：允许（在读学员可申请另一项目），但受"同时只有一份活动申请"约束。
> `finance` 在 PORTAL-1/2 **不接触**申请正文与 CP（SEC 既定）。

---

## 5. PORTAL-SHARED 架构

```
assets/js/portal/
  auth.js        （现有，扩展）会话、角色、aal、路由守卫、callFn
  api.js         （新）统一数据访问层：
                   - table(name).selectOwn() 等薄封装
                   - rpc(name, args) 统一错误映射（401/403/409/429/5xx → 文案键）
                   - fn(name, body) Edge 调用 + aal2 预检
                   - 所有失败返回 {code, message}，不抛裸错误、不泄漏 SQL/表名
  guard.js       （新）requireRole / requireRoleAal2 / requireOwner 的页面级组合
                   + 会话过期监听（onAuthStateChange → 提示并跳登录，不静默失败）
  ui.js          （新）共享状态组件：
                   renderLoading / renderEmpty(action) / renderUnauthorized / renderError(retry)
                   renderOffline / toast / confirmDialog / formGuard(未保存离开提醒)
  shell.js       （新）门户导航壳：
                   - 顶栏：校徽 + 空间名 + 身份条（姓名/角色徽章/学号）+ 语言 + 退出
                   - 侧栏/底栏导航（桌面侧栏；≤760px 底部 5 项 + 更多）
                   - 面包屑、页面标题、aria-live 区域
  audit.js       （新）前端审计钩子：敏感动作前置确认 + 结果回执展示
                   （真实审计一律由服务端写，前端只做用户可见回执）
assets/css/portal.css （扩展）导航壳、时间线、骨架屏、表单栅格、44px 触控、焦点环
```

**服务端权威原则**（写入代码注释与文档）：前端角色仅决定"显示什么"，任何数据可见性与写入以 RLS + RPC/Edge 为准；页面守卫失效时数据层必须仍然拒绝——acceptance matrix 用直连 REST/RPC 验证。

**可访问性基线**：所有表单控件有 `<label>`；焦点可见；对比度 ≥ WCAG AA；错误不只靠颜色；`aria-live` 播报状态变化；200% 缩放可用；触控目标 ≥44px；键盘可完成全流程。

---

## 6. PORTAL-1 页面树（Applicant Center）

```
/portal/applicant/                     首页：状态卡 + 下一步 + 通知
  ├─ application/                      我的申请（当前活动申请详情）
  │    ├─ #form                        分步表单（1 基本 2 信仰与教会 3 学习意向 4 复核）
  │    ├─ #requirements                管理员要求补充的条目（勾选完成）
  │    └─ #timeline                    状态时间线（申请人可见字段）
  ├─ history/                          历史申请（终态列表，只读）
  └─ profile/                          个人资料（姓名/联系方式/语言/时区）

/portal/admin/admissions/              招生审核台（registrar / academic_admin，aal2）
  ├─ 队列（筛选：状态/路径/时间）
  ├─ 详情抽屉：表单只读视图 + 内部备注 + 决定动作
  └─ 动作：进入审核 / 要求补充（条目化）/ 录取 / 拒绝 / 指派审核人
```

**表单行为**：草稿本地 debounce 800ms + 服务端 `updated_at` 乐观并发；提交前校验（必填、格式、一致性）在**前端提示 + RPC 二次校验**；提交后 `locked_fields` 内字段只读（姓名/证件类信息/路径），可改字段仍开放；`needs_information` 时解锁被要求补充的字段。

---

## 7. PORTAL-2 页面树（Student Core，本蓝图定义，实现待 PORTAL-1 验收后）

```
/portal/student/
  ├─ (首页) Dashboard：学籍卡（学号/路径/状态/届别）+ 待办 + 通知 + 下一步
  ├─ profile/          基本资料（本人可改字段有限，学号/状态只读）
  ├─ courses/          课程入口 —— **只呈现真实数据**：
  │                     未有课程注册数据时显示明确空态
  │                     「课程注册与学习记录将在教务模块开通后可见」
  │                     并链接官网 67 门课程目录（只读参考，不伪造进度）
  ├─ records/          学习记录入口（同上，真实空态；不显示 0 学分）
  ├─ growth/           Christian Profile 入口 —— 调用既有 CP：
  │                     链接 /discover.html（Level 0）+ App 完整档案说明
  │                     **不重新实现评分**，不展示未经 CP 引擎产生的结论
  └─ notifications/    通知与需处理事项
```

**硬约束**：不新增/改名正式课程（固定 67 门）；不把候选课程算作正式课程；不造空课程页假装已有课程；不因建门户重定义学分规则；CP 边界 `Assessment → Profile → Recommendation → Learning → Practice → Evidence → Profile Update` 不被破坏。

---

## 8. API / RPC / Edge Function 清单

### 8.1 客户端直连（RLS 保护，无需函数）
| 操作 | 表 | 约束 |
|---|---|---|
| 读/改本人 draft 申请 | `applications` | RLS owner + `status='draft'` |
| 读本人申请时间线 | `application_status_history` | RLS owner，`internal_note` 列不授予 |
| 读本人补件条目 | `application_requirements` | RLS owner |
| 读本人学籍 | `student_profiles` | RLS owner 或管理员 |
| 管理员读申请队列 | `applications` | RLS `is_admin_any()` |

### 8.2 数据库 RPC（`security definer`，最小授权）
| 函数 | 调用者 | 作用 |
|---|---|---|
| `my_application()` | authenticated | 返回本人当前活动申请（安全字段） |
| `my_application_timeline()` | authenticated | 时间线（剔除 internal_note） |
| `submit_application(p_app uuid)` | authenticated（本人） | 完整性校验 → `draft/needs_information → submitted`、写锁定字段、写 history、审计 |
| `withdraw_application(p_app uuid, p_reason text)` | authenticated（本人） | 转 `withdrawn` + 审计 |
| `review_application(p_app, p_reviewer, p_action, p_message, p_requirements jsonb, p_internal_note)` | **service_role** | 审核动作全家桶，单事务：状态迁移 + 条目化补件 + history + 审计 |
| `enroll_student(p_app, p_registrar, p_student_number, p_pathway, p_status)` | **service_role** | 录取后建档：student_profiles + login_aliases + role:student + 审计，单事务 |
| `my_student_record()` | authenticated | 本人学籍（安全字段） |

### 8.3 Edge Functions（JWT → 角色 → **aal2** → 委托 RPC）
| 函数 | 说明 |
|---|---|
| `review-application` | 招生审核（registrar/academic_admin，aal2） |
| `enroll-student` | 建档发学号（registrar，aal2；学号规则见 §14-P2） |

沿用 SEC-2 骨架：解析 `aal`≠aal2 → 403 `mfa_required`；角色不符 → 403；异常统一 `server_error`；全部写审计。

---

## 9. 拟新增 migrations

| 编号 | 内容 | 阶段 |
|---|---|---|
| `0008_applications.sql` | 枚举、`applications`、`application_internal`、`application_status_history`、`application_requirements`、状态机触发器、RLS、`my_application*` / `submit_application` / `withdraw_application` / `review_application` | PORTAL-1 |
| `0009_student_records.sql` | `enrollment_status` 枚举、`student_profiles`(+internal)、`enroll_student` RPC、RLS、`my_student_record` | PORTAL-1 尾（模型先行）/ PORTAL-2 用 |
| `0010_portal_indexes.sql` | 队列与时间线索引（`applications(status, submitted_at desc)`、`application_status_history(application_id, created_at)`、`student_profiles(enrollment_status)`） | PORTAL-1 |

**不含**：课程/成绩/学分/文件表（未批准或属后续阶段）。

---

## 10. 拟修改文件

| 文件 | 改动 |
|---|---|
| `assets/js/portal/auth.js` | 抽出 guard/api/ui；保留现有导出以免破坏 SEC 页面 |
| `assets/js/portal/{api,guard,ui,shell,audit}.js` | 新建 |
| `assets/css/portal.css` | 导航壳、时间线、骨架屏、移动端底栏、焦点样式 |
| `portal/index.html` | 接入 shell（多空间选择保持逻辑不变） |
| `portal/applicant/index.html` | 重写为 Dashboard（接真实数据） |
| `portal/applicant/application/index.html`、`history/`、`profile/` | 新建 |
| `portal/admin/index.html` | 拆为 `admin/`（总览）+ `admin/admissions/`（新建）+ 保留教师验证页 |
| `portal/student/**` | PORTAL-2 阶段新建（本次只建目录规划，不产出空页面） |
| `supabase/tests/portal1_acceptance.sql` / `portal1_http.mjs` | 新建验收脚本 |
| `docs/permissions/matrix.md`、`docs/auth/README.md` | 增补 PORTAL 章节 |

---

## 11. Acceptance Matrix（PORTAL-1，实现同步编写；PORTAL-2 另立）

| ID | 场景 | 期望 |
|---|---|---|
| P1-01 | 未登录访问 `/portal/applicant/**` | 重定向 `/login/?next=` |
| P1-02 | applicant 访问 `/portal/admin/admissions/` | 重定向回自己空间（非 403 白屏） |
| P1-03 | teacher（aal2）访问招生台 | 拒绝（无 registrar/academic_admin） |
| P1-04 | REST 直读他人 `applications` | 0 行 |
| P1-05 | REST 直改他人 `applications` | 4xx |
| P1-06 | REST 直读 `application_internal` | 0 行（申请人/教师） |
| P1-07 | RPC `review_application` 由 authenticated 直呼 | 403（service-only） |
| P1-08 | Edge `review-application` 用 aal1 管理员 | 403 `mfa_required` |
| P1-09 | 非法状态跳转（`accepted → draft`） | 触发器拒绝 |
| P1-10 | 终态申请再提交 | RPC 拒绝 |
| P1-11 | 重复提交（双击/并发两次 submit） | 仅一次生效，状态不重复推进 |
| P1-12 | 同时创建第二份活动申请 | 唯一索引拒绝 |
| P1-13 | 提交后修改锁定字段 | RLS/触发器拒绝 |
| P1-14 | `needs_information` 未完成条目即提交 | RPC 拒绝并回列缺失项 |
| P1-15 | 浏览器刷新 / 恢复草稿 | 草稿完整恢复，无数据丢失 |
| P1-16 | session 过期后操作 | 明确提示并跳登录（非静默失败） |
| P1-17 | 审核中撤销 applicant 角色 | 同一 JWT 立即失权 |
| P1-18 | 审核动作审计 | `audit_logs(category='admissions')` 有记录，含 from/to |
| P1-19 | 时间线内部备注 | 申请人视图不含 `internal_note` |
| P1-20 | 移动端 390px | 无横向滚动、触控 ≥44px、底栏可用 |
| P1-21 | 空/载入/无权/错误四态 | 均有明确文案与下一步动作 |
| P1-22 | console runtime error | **= 0** |
| P1-23 | 键盘可完成全流程 | 可 Tab 到所有控件并提交 |
| P1-24 | 错误信息不泄漏 | 无 SQL/表名/内部 ID/token |

测试与实现同步进行（不等做完再测）：每完成一页立即跑对应用例。

---

## 12. 风险与回滚

| 风险 | 缓解 | 回滚 |
|---|---|---|
| 与既有 `submissions`（官网表单）双轨并存造成混乱 | 明确边界：`submissions`=匿名咨询/邮件收件箱；`applications`=登录后的正式申请。官网弹窗暂不改动 | 无需回滚（互不影响） |
| 政策未定就实现（建档条件/学号规则） | §14 待确认项**不写死默认值**，UI 显示"待学院确认"，RPC 参数化 | — |
| 状态机改动影响进行中申请 | 迁移只增不改；状态枚举新增值不删旧值 | `0008` 全部对象可独立 drop |
| 前端拆分破坏 SEC 页面 | `auth.js` 保持现有导出签名；SEC 页面不改 | 还原单文件 auth.js |
| Student Core 提前展示不存在的课程/学分 | 硬约束写入代码与验收：无真实数据一律显示空态说明 | — |
| production blocker 遗忘 | 报告与 README 顶部常驻提醒；上生产清单第 2 条 | — |

---

## 13. 交付顺序

1. **本蓝图确认**（含 §14 政策点）
2. PORTAL-SHARED：`api/guard/ui/shell/audit` + portal.css 扩展 + 现有页面接入（不改行为）
3. `0008_applications.sql` + RPC/Edge（**状态机先行**）
4. PORTAL-1 页面（申请人端 → 管理端），每页即时跑用例
5. PORTAL-1 acceptance matrix 全绿 → 提交报告
6. **甲方确认后**才进入 PORTAL-2（`0009` + Student Core）

---

## 14. 与既有规则的冲突核查 & 待甲方确认政策点

**冲突核查结论**：本蓝图与手册 V2.0、官网现行文案、SEC 既定安全模型**无冲突**。两条路径、学籍由总校审核建立、共同学习不自动转学分、67 门课程、11 项实践训练、CP 边界均被原样承接。

**必须由甲方决定（不自创，实现前需回答）**：

| 编号 | 待确认 | 影响 |
|---|---|---|
| **P1** | 录取（accepted）后建档的**前置条件**：是否需缴费确认 / 签署学习协议 / 提交纸质材料？ | `enroll_student` 的守卫条件；UI 提示文案 |
| **P2** | **学号编码规则**（如 `B26-0001`：路径+届别+序号？谁分配？是否可重号回收？） | `enroll_student` 生成逻辑；`login_aliases` |
| **P3** | 学员建档后 **`applicant` 角色是否保留**（保留=可再申请其他项目；撤销=更干净） | 角色授予事务；门户空间显示 |
| **P4** | accepted 后是否先 `pre_enrolled`（待注册）再 `active`，还是直接 `active` | 状态机初值 |
| **P5** | **共同学习路径**是否也建 `student_profiles`（不同 pathway）与学号？还是仅登记不发学号？ | 数据模型分支；手册称"不自动建立 B.Th 学籍"，但未说共同学习者有无学号 |
| **P6** | 申请是否允许**同时申请两个项目**（当前设计：同时只有一份活动申请） | 唯一索引 |
| **P7** | 招生**文件上传**规范（类型/大小/保存期限/隐私/谁可见）——未批准前不建 Documents Center | PORTAL-1b |
| **P8** | 审核决定是否需要**双人复核**（一人建议、一人批准）？ | 状态机是否加 `recommended` 中间态 |
| **P9** | 申请表单字段是否沿用现有官网弹窗字段集（基本/信仰与教会/学历/意向），还是采用完整版 Word 申请表字段？ | `form_data` 白名单与 UI 分步 |

**P1–P4、P9 是 PORTAL-1 实现的阻塞项**（P5–P8 可在 PORTAL-1 后处理）。若暂不决定，我可按"最小且可逆"的默认实现：**accepted 后 `pre_enrolled`；学号规则参数化由 registrar 手填；保留 applicant 角色；共同学习也建档但 pathway 区分、学号可留空；申请字段沿用官网弹窗字段集**——但这些默认值**必须由你明确批准**后才写入代码。
