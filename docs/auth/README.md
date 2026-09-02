# AMAS 门户 · 认证体系（Phase 1）

> 规范依据：《教师验证与双端门户系统开发总规范 V1.0》§5 / §14 / §18。
> **阶段状态**：Phase 1 代码已落地并部署；静态与未配置状态测试通过；
> 真实认证、JWT、RLS、Edge Function 和越权测试等待 Supabase 环境验收。
> 生效前提：Supabase 项目创建并按 `docs/SUPABASE-SETUP.md` + 本文完成配置。

## 路由

| 路由 | 文件 | 说明 |
|---|---|---|
| `/login/` | `login/index.html` | 邮箱或学号 + 密码；未启用时显示真实状态并禁用按钮 |
| `/register/` | `register/index.html` | 自助注册 → 邮箱验证 → 自动成为 applicant（§5.2） |
| `/forgot-password/` | `forgot-password/index.html` | 重置邮件；文案不区分邮箱是否存在 |
| `/auth/callback/` | `auth/callback/index.html` | 邮箱验证回调 + 重置密码设定页 |
| `/portal/` | `portal/index.html` | 多角色工作空间选择（单角色自动跳转） |
| `/portal/applicant/` | `portal/applicant/index.html` | 申请者中心（Phase 1 最小版） |
| `/faculty/verify/` | `faculty/verify/index.html` | Phase 2：邀请码 → 资料 → 提交 → 状态跟踪（真实流程） |
| `/help/` | `help/index.html` | 帮助中心 |
| `login.html` | 旧地址 | **客户端重定向**（meta refresh + JS，HTTP 仍为 200；GitHub Pages 无法配置服务器 302）到 `/login/` |

## 登录流程

- **邮箱**：前端直接 `signInWithPassword`。
- **学号/教职工号**：前端调用 Edge Function `login-by-identifier`（服务端解析 `login_aliases`，前端永远拿不到"学号→邮箱"映射）；函数内置 15 分钟 5 次失败限流（按标识与按 IP 双维度），失败统一返回 `bad_credentials`。
- 登录成功后 `my_roles()` 取活动角色 → §5.4 规则跳转；多空间角色进 `/portal/` 选择页。
- 越权防护：门户页守卫 `AmasAuth.requireRole([...])` 仅是第一层；数据层由 RLS 强制（改 URL/localStorage 无效）。

## Supabase 控制台需要的配置（项目建好后一次完成）

1. 跑 `supabase/migrations/0001 → 0002`
2. Auth → URL Configuration：Site URL = 站点根；Redirect URLs 加 `…/auth/callback/`（含 `?type=recovery`）
3. Auth → Email：启用确认邮件（默认即可；正式域后建议配自有 SMTP）
4. Auth → MFA：启用 TOTP（教师与管理员激活时强制注册，Phase 2 接入）
5. Edge Functions：`supabase functions deploy login-by-identifier --no-verify-jwt`
6. 建首个管理员：Auth 添加用户 → SQL 授 `super_admin`（0002 末尾有语句模板）

## 硬性纪律（§24 摘要）

- 公开注册只产生 applicant；student/teacher/管理角色只能由受保护流程授予
- `user_roles` / `login_aliases` 客户端不可写；别名表客户端不可读
- service_role / secret key 永不进前端与 Git
- 日志与审计不保存密码、token、正文内容


## Phase 2 新增（教师验证 + MFA）

| 路由/组件 | 说明 |
|---|---|
| `/portal/mfa/` | TOTP 注册（二维码+密钥+确认码）与登录后挑战；`requireRoleAal2` 强制教师/管理员达到 aal2 |
| `/portal/teacher/` | 教师工作台外壳（角色 + aal2 双闸；教学模块 Phase 4） |
| `/portal/admin/` | 教师验证管理：创建邀请（明文码仅显示一次）+ 审核队列（通过/补充/拒绝/暂停/恢复/撤销） |
| Edge `create-teacher-invitation` | 管理员 + aal2；库存哈希，返回一次性链接 |
| Edge `submit-teacher-verification` | 登录+邮箱已验证；原子核销邀请（一次性/限时/邮箱绑定）后置为 submitted |
| Edge `review-teacher-verification` | 管理员 + aal2；委托 DB 函数在**同一事务**内完成状态迁移+档案+角色授予/撤销+审计 |

### 部署追加（在 Phase 1 步骤之后）
1. 跑 `0003_hardening.sql`、`0004_teacher_verification.sql`
2. Auth → MFA：启用 TOTP
3. `supabase functions deploy create-teacher-invitation submit-teacher-verification review-teacher-verification`
4. 用 `supabase/tests/acceptance_tests.sql` 在 SQL Editor 验收（全部 NOTICE: PASS）

### MFA 丢失设备恢复（人工流程）
1. 教务通过既有联系方式人工核验身份；
2. super_admin：Supabase 控制台 → Authentication → 该用户 → 删除 TOTP factor；
3. SQL 留痕：
   `insert into public.audit_logs(actor_id,event_type,target_type,target_id,category,reason) values ('<admin-uuid>','mfa_factor_reset','auth','<user-uuid>','security','人工核验后重置');`
4. 通知用户重新登录并重新注册 TOTP。
