# SEC-3 Production Acceptance Report

**范围**：SEC-1（身份与权限地基）+ SEC-2（教师验证闭环）在真实 Supabase 环境的完整验收
**环境**：Supabase staging `amas-staging`（ref `sdrwyebizfdwldlfjyim`，ap-southeast-1 / 新加坡，Postgres 17.6）
**日期**：2026-09-03
**执行**：迁移 0001–0007、Edge Functions ×4、Auth（TOTP MFA 开启）、三层自动化 + UI 探针
**结论**：**98 项自动化断言 + 6 项 UI 断言全部 PASS**；验收过程发现并修复 3 个真实缺陷，修复后完成全量回归。

---

## 0. 环境与部署事实

| 项目 | 结果 |
|---|---|
| 项目创建 | `amas-staging` / ACTIVE_HEALTHY / ap-southeast-1 |
| 迁移应用 | 0001_init、0002_identity、0003_hardening、0004_teacher_verification、**0005_ratelimit_fix**、**0006_trigger_isolation**、**0007_actor_fk_policy** 全部成功 |
| Edge Functions | `login-by-identifier`、`create-teacher-invitation`、`submit-teacher-verification`、`review-teacher-verification` 四个 ACTIVE |
| Auth 配置 | `mfa_totp_enroll_enabled=true`、`mfa_totp_verify_enabled=true`、`password_min_length=8`、回调白名单已设 |
| 前端 | 验收期间临时指向 staging；**验收后已还原为空配置**，仓库内不含任何密钥 |

---

## 1. 甲方指定 12 项必测 —— 逐项结论

### ① 两个并发会话同时触发同一 identifier 限流 —— **PASS**
- `H25`：4 次失败后并发 10 次判定，全部放行（未误锁）→ `allowed=10/10`
- `H26`：达到第 5 次失败后并发 10 次判定，**0 次放行** → `allowed=0/10`
- 机制：`auth_rate_check` 内 `pg_advisory_xact_lock(hash(identifier))` 串行化，多 Edge 实例共库，锁全局生效，不可竞争绕过。

### ② max_uses=1 邀请码并发核销 —— **PASS**
- `H27`：并发 5 次 `consume_teacher_invitation` → **仅 1 次成功**（`success=1/5`）
- 机制：条件自增 `used_count = used_count + 1 WHERE used_count < max_uses AND …` 单语句原子。

### ③ AAL1 管理员访问敏感操作必须 403，AAL2 才放行 —— **PASS**
- `H04/H05/M08`：AAL1 学术管理员调用创建邀请 / 审核 → `403 mfa_required`
- `M03`：真实 TOTP（RFC 6238 自建算法）enroll→challenge→verify，换发 JWT 的 `aal=aal2`
- `M05/M09`：AAL2 后创建邀请、审核通过 → `200`
- `M04`：错误动态码 → `422` 拒绝

### ④ 前端伪造 role / 改 localStorage / 直调 Edge Function 不得提权 —— **PASS**
- `H21`：学员自插 `super_admin` 角色 → `403`
- `H22`：学员 PATCH 自身 `email/account_status` → 触发器还原（邮箱仍为原值）
- `H06/H07`：学员、教师直调管理类 Edge Function → `403`
- `H09`：伪造 JWT（自称 `aal2` + `service_role`）→ `403`
- `U06`：浏览器内写入伪造 `localStorage` 角色后访问 `/portal/admin/` → 仍重定向登录页

### ⑤ 五角色经 REST/RPC 直测 RLS（非 UI）—— **PASS**
| 角色 | 结果 |
|---|---|
| student | 只读到自己的 profile（`rows=1`）、只读自己的角色行、审计 0 行、邀请表 0 行 |
| teacher | 审计 0 行、邀请表 0 行、内部备注 0 行 |
| academic_admin | 审计仅 `academic/admissions` 类 |
| finance | 审计仅 `finance` 类且 `actor_id = 自己` |
| super_admin | 审计全量可读（`rows=6`） |
- `H13`：任何客户端角色读 `login_aliases` → `403`（表级授权已回收，RLS 之外的第二道锁）

### ⑥ suspend/revoke 后不重登即时失权（不依赖 stale JWT）—— **PASS**
- `H28`：撤销角色后同一 JWT 调 `my_roles()` → teacher 消失
- `M17`：审核 `suspend` 后教师同一 JWT → 仅剩 `applicant`
- `M18`：暂停后学号登录 → `401`（别名同事务撤销）

### ⑦ profile trigger 故障注入 → 注册仍成功 / 审计 / fail-closed / 自愈 —— **PASS（并修复缺陷）**
- `T28`：角色段人为失败时，`auth.users` 注册仍成功
- `T29`：**档案段不被牵连**（修复后）
- `T30`：`security_events('trigger_error')` 记录且带 `stage=user_roles`
- `T31`：缺角色状态 fail-closed（无任何有效角色）
- `T32`：`heal_missing_profile()` 自愈成功并写 identity 审计

### ⑧ 邀请码 replay / 过期 / 错误邮箱 / 已使用 / 伪造 / 规范化边界 —— **PASS**
`T08` 一次性、`T09` 伪造 token、`T10` 邮箱不匹配、`T11` 过期、`H32` 用他人邀请码、`H34/M-replay` 重放 → 全部拒绝；`M14` 学号大小写规范化（`SEC3-xxx` 存为大写）登录成功。

### ⑨ JWT 边界：过期 / 无 token / AAL1 / 伪造 —— **PASS**
`H08` 无用户 JWT → 403；`H09` 伪造签名 → 403；`H10` 过期/无效 JWT 访问 REST → 401；`H03` 密码登录为 `aal1`；AAL1 敏感操作 → 403。

### ⑩ MFA secret / otpauth URI / 邀请明文不得进入库、日志、前端存储 —— **PASS**
- `M06`：库中仅存邀请码 sha256 哈希；`M19`：MFA secret 与邀请明文均**未出现**在 `audit_logs` / `security_events`
- `M20`：日志中无 `otpauth://`；`H29/H30/H31/T33`：无明文 token、无 password/secret 字样
- 前端：明文邀请码仅在创建响应中一次性显示，不写 localStorage/sessionStorage（`portal/admin` 仅渲染到 DOM 供复制）

### ⑪ service_role 专用 RPC 被 anon/authenticated 直呼必须失败 —— **PASS**
`auth_rate_check`、`auth_record_attempt`、`review_teacher_verification`、`consume_teacher_invitation`、`heal_missing_profile` 五个 × 两种身份 = 10 项，全部 `401/403`（`H23.*` / `H24.*`；`T25–T27` 在 DB 层复验）。

### ⑫ acceptance_tests.sql 全 PASS 后端到端人工流程 —— **PASS**
`M01→M21` 完整链路：建号 → 管理员 MFA 注册 → 创建邀请 → 教师提交 → AAL1 审核被拒 → AAL2 审核通过（teacher+mentor+学号别名+审计同事务）→ 教师读档案 → 学号登录 → 暂停 → 即时失权 → 学号登录失效。

---

## 2. 分层结果汇总

| 层 | 断言数 | 结果 |
|---|---:|---|
| 数据库（`acceptance_tests.sql`，T01–T33） | 33 | 33 PASS |
| HTTP/REST/Edge（`sec3_http.mjs`，H01–H36 含子项） | 44 | 44 PASS |
| MFA / 端到端（`sec3_mfa.mjs`，M01–M21） | 21 | 21 PASS |
| 浏览器 UI 探针（U01–U06） | 6 | 6 PASS |
| **合计** | **104** | **全部 PASS** |

---

## 3. 发现的问题与修复

### 缺陷 1（高）：成功登录未清零失败计数
- **现象**：`T07 FAIL — success did not reset counter`
- **根因**：`auth_rate_check` 以 `created_at >= 最后成功时间` 比较；同事务内 `now()` 为事务开始时间，同刻失败被判为"成功之后"，计数未清零。真实场景下也存在同一秒多事件的排序歧义。
- **修复**：改用单调递增主键 `id > 最后成功事件 id` 作为分界（`0005_ratelimit_fix.sql`）。
- **验证**：T06/T07 PASS；H25/H26 并发行为符合预期。

### 缺陷 2（高）：注册触发器段间未隔离
- **现象**：角色插入失败导致 `profiles` 一并回滚，用户"注册成功但无档案无角色"。
- **根因**：`handle_new_user` 将三段写入放在同一 `BEGIN…EXCEPTION` 子事务。
- **修复**：拆为 profiles / user_roles / audit 三段独立子事务，失败仅记 `trigger_error` 并带 `stage`；新增 `heal_missing_profile()` 幂等自愈（`0006_trigger_isolation.sql`）。
- **验证**：T28–T32 PASS。

### 缺陷 3（中）：操作者外键阻塞账号删除
- **现象**：删除管理员账号被 `teacher_invitations_created_by_fkey` 阻塞。
- **影响**：与数据保留/删除权（§17.4）冲突，运维无法清退账号。
- **修复**：`granted_by / created_by / reviewed_by / updated_by` 等操作者引用统一 `ON DELETE SET NULL`，历史记录与审计保留（`0007_actor_fk_policy.sql`）。
- **验证**：`DELETE 8` 成功，邀请与审计行仍在。

### 测试自身缺陷（已修）
初版 `acceptance_tests.sql` 直插 `profiles` 违反对 `auth.users` 的外键；已改为经 `auth.users` 建种子用户，顺带真实覆盖注册触发器链路。

---

## 4. 修复提交

| 提交内容 | 文件 |
|---|---|
| 限流分界改用事件 id | `supabase/migrations/0005_ratelimit_fix.sql` |
| 触发器段隔离 + 自愈函数 | `supabase/migrations/0006_trigger_isolation.sql` |
| 操作者外键置空策略 | `supabase/migrations/0007_actor_fk_policy.sql` |
| 验收脚本重写（T01–T33） | `supabase/tests/acceptance_tests.sql` |
| 本报告 | `docs/operations/SEC-3-acceptance-report.md` |

（HTTP 与 MFA 测试脚本位于会话临时目录，未入库：`sec3_http.mjs` / `sec3_mfa.mjs`；如需纳入 CI 可移入 `supabase/tests/`。）

---

## 5. 残余风险

| 级别 | 风险 | 说明与建议 |
|---|---|---|
| 中 | **仅 staging 验收，未在生产项目执行** | 本报告结论适用于 staging；生产项目需重跑同一套脚本（迁移已幂等，脚本可直接复用）。 |
| 中 | **IP 维度限流可被伪造 header 影响** | `x-forwarded-for` 由 Supabase 边缘注入，自建代理场景可伪造；已将 IP 设为宽阈值（20）辅助维度，主维度为标识（5），伪造不能绕过标识限流。若需强化，可接 Cloudflare Turnstile。 |
| 中 | **邮件发送依赖 Supabase 内建 SMTP** | 验收期为便于自动化设置了 `mailer_autoconfirm=true`；**上生产前必须改回 false** 并配置自有 SMTP（内建发信有频率限制且易进垃圾箱）。 |
| 中 | **MFA 恢复依赖人工** | 丢失设备须教务人工核验 + super_admin 控制台删除 factor；尚无自助备份码流程（Supabase TOTP 暂不提供恢复码）。 |
| 低 | **邀请码人工转交** | 当前不自动发信，管理员需经可信渠道转交；上线邮件通道后可自动化。 |
| 低 | **`login.html` 为客户端重定向而非 302** | GitHub Pages 限制；迁移 Cloudflare Pages 后用 `_redirects` 升级。 |
| 低 | **占位权限函数仍 fail-closed 返回 false** | `is_assigned_teacher/is_enrolled_student/is_assigned_mentor` 待 PORTAL 阶段建真实关系表后由新 migration 替换，并补"未分配教师读任何学员 = 0 行"测试。 |
| 低 | **审计表无自动归档** | 长期运行需设保留策略（建议 pg_cron 定期归档 + 冷存）。 |

---

## 6. 上生产前必做清单

1. 生产项目重跑 0001–0007 + `acceptance_tests.sql`（须全 PASS）
2. `mailer_autoconfirm` 改回 **false**，配置自有 SMTP 与发件域
3. Auth 回调白名单改为正式域名；Site URL 同步
4. 首个 `super_admin` 建号后**立即注册 MFA**
5. `assets/js/supabase-config.js` 填生产 URL + publishable key（**service key 永不入前端**）
6. 部署四个 Edge Function 到生产项目
7. 重跑 `sec3_http.mjs` / `sec3_mfa.mjs` 指向生产（用测试账号，跑完清理）
8. 确认 staging 项目与测试账号已清理或隔离

---

## 7. 状态声明

> **SEC-1 + SEC-2 已在 staging 环境完成真实认证、JWT、RLS、Edge Function、MFA 与越权验收（104/104 PASS），三个真实缺陷已修复并回归通过。**
> 生产环境验收尚未执行；在生产项目完成上述清单并重跑全套脚本之前，**不开放真实教师使用**。
