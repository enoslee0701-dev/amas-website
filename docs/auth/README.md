# AMAS 门户 · 认证体系（Phase 1）

> 规范依据：《教师验证与双端门户系统开发总规范 V1.0》§5 / §14 / §18。
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
| `/faculty/verify/` | `faculty/verify/index.html` | Phase 2 前为真实状态占位（可联系教务），不假装可用 |
| `/help/` | `help/index.html` | 帮助中心 |
| `login.html` | 旧地址 | 302 跳转到 `/login/`，保留外部旧链接 |

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
