# 甲方八项审查 · 逐项回复（随 Phase 2 提交）

> 状态口径（甲方指定）：**Phase 1 代码已落地并部署；静态与未配置状态测试通过；真实认证、JWT、RLS、Edge Function 和越权测试等待 Supabase 环境验收。** 未经真实环境全链路测试，不宣布正式验收，不开放真实教师使用。

## 1. 登录页跳转 —— 措辞更正
GitHub Pages 不支持服务器级 301/302 配置。`login.html` 实为**客户端重定向**（meta refresh + `location.replace`），HTTP 状态为 200。文档已改为"客户端重定向"；已有静态测试断言跳转后落在 `/login/`。若未来迁移 Cloudflare Pages，将改用 `_redirects` 实现真 302 并加响应状态测试。

## 2. 学号登录限流 —— 重构为持久化 + 原子
- **存储位置**：Postgres `public.security_events`（跨 Edge 实例共享、持久化），非 Deno 内存/Map/单实例变量。
- **原子性**：放行判定移入数据库函数 `auth_rate_check(identifier, ip)`，以 `pg_advisory_xact_lock(hash(identifier))` 将同一标识的判定**串行化**，并发下不会超额放行（多实例同库，锁全局生效 → 多实例不可绕过）。
- **成功登录计数处理**：成功写入 `login_success`，计数只统计"最后一次成功之后"的失败 → 成功即清零。
- **到期清理**：`auth_rate_check` 内机会式删除 48 小时前的登录事件（每次 ≤200 行）；正式环境另可开 pg_cron 定时清理（已在运维文档列为可选项）。
- **代理/伪造 Header**：`x-forwarded-for` 第一跳由 Supabase 边缘网关注入；因客户端可在自建代理场景伪造，**IP 仅作宽阈值（20 次）辅助维度**，主维度是登录标识（5 次）——伪造头无法绕过标识限流；IP 阈值放宽也避免 NAT 群体被单人锁死。
- **测试**：`supabase/tests/acceptance_tests.sql` 含"5 次失败即锁 / 成功后清零"；并发与多实例用例写在测试文件尾部（需真实环境两会话并行执行，属环境验收项）。

## 3. `user_roles` 全局角色唯一 —— 已用 coalesce 表达式索引
实际 DDL（0002）：
```sql
create unique index user_roles_active_unique
  on public.user_roles (user_id, role,
      coalesce(scope_type,''),
      coalesce(scope_id,'00000000-0000-0000-0000-000000000000'::uuid))
  where revoked_at is null;
```
`scope_id IS NULL` 被折叠为固定 UUID，两条全局 teacher 角色必然冲突；部分索引只约束活动行（撤销后可重新授予）。验收测试含"重复全局角色插入必须失败 + 撤销后重授成功"。

## 4. SECURITY DEFINER 函数 —— 0003 全量收紧
- 全部 definer 函数改为 `set search_path = ''`，表/类型/函数全限定（`public.*` / `auth.uid()`）；
- `revoke execute on all functions in schema public from public, anon` 后按最小集合重授：`my_roles/my_profile` 仅 authenticated；`auth_rate_check / auth_record_attempt / review_teacher_verification / consume_teacher_invitation` 仅 service_role；
- 函数只返回调用者自身（`auth.uid()`）范围数据；
- **注册触发器容错**：`handle_new_user` 等三个 auth 触发器包裹 `EXCEPTION` 块——任何失败仅写 `security_events('trigger_error')`，绝不回滚 auth 注册；前端在 `my_profile()` 为空时提示联系同工（自愈路径），验收用例：人为制造 profiles 冲突后注册仍成功。

## 5. 占位权限函数 —— fail closed 已锁定
`is_assigned_teacher / is_enrolled_student / is_assigned_mentor` 三个占位在 0003 重申并加注释：**恒 false，禁止临时改 true**；0005/0006 建真实关系表时由新 migration 替换实现。验收测试断言三者对任意输入返回 false；Phase 4 验收将加"未分配教师读任何学员 = 0 行"的数据库测试。

## 6. 审计日志读取 —— 按类别拆分（0003）
`audit_logs` 新增 `category`（identity/security/academic/admissions/finance/export/system），策略：
- super_admin：全量；
- academic_admin / registrar：仅 `academic`、`admissions`；
- finance：仅 `finance` 且 `actor_id = auth.uid()`；
- 教师/学员/申请者：无策略命中 = 不可读。
所有写入点（登录、注册、邮箱变更、教师验证审核）已带正确类别。

## 7. 邮箱同步 —— 新增可信触发器
`on_auth_user_email_changed`（0003）：Auth 侧邮箱变更成功后同步 `profiles.email` 并写 identity 类审计；客户端仍不可直改 `profiles.email`。两处邮箱以 auth.users 为唯一权威。

## 8. MFA —— 三层真实实现（非仅开开关）
- **前端**：`/portal/mfa/` 完整实现 TOTP 注册（enroll → 内联 SVG 二维码 + 手输密钥 → challenge+verify 确认）与登录后挑战；`AmasAuth.requireRoleAal2()` 使教师/管理门户在 `currentLevel !== 'aal2'` 时强制跳转 MFA 页。
- **Edge Function**：`create-teacher-invitation`、`review-teacher-verification` 解析 JWT `aal` 声明，非 `aal2` 一律 403 `mfa_required`（改前端代码无法绕过）。
- **数据库**：敏感写路径不存在客户端直写（角色授予、审核、别名全在 service 专用函数内），Edge 层的 aal2 即数据入口闸门；后续若开放任何客户端敏感写，将在 RLS 中加 `auth.jwt()->>'aal' = 'aal2'` 条件。
- **丢失设备恢复**：教务人工核验身份（邮件+视频/电话）→ super_admin 在 Supabase 控制台删除该用户 MFA factor → SQL 写一条 `security` 类审计（模板见 docs/auth/README.md）→ 用户重新注册 TOTP。
- 控制台仍需勾选启用 TOTP（这是平台前提，不是实现本体）。
