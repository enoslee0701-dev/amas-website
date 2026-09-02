# AMAS 权限矩阵（规范 §4.3 落地对照 · Phase 1 基线）

角色枚举：applicant / student / teacher / mentor / registrar / finance / content_admin / academic_admin / super_admin
（多角色并存；授予记录在 `user_roles`，禁止 metadata 承载角色。）

## Phase 1 已实施

| 能力 | 实现 |
|---|---|
| 查看/修改本人资料 | `profiles` RLS：本人 select/update；`account_status`、`email`、角色等字段由触发器冻结 |
| 查看本人角色 | RPC `my_roles()`（仅 auth.uid()） |
| 管理用户角色 | 客户端零写权限；待 Phase 2 受保护函数 + 审计 |
| 学号→账号解析 | 仅 `login-by-identifier` Edge Function（service key）；`login_aliases` 无任何客户端策略 |
| 审计日志读取 | 仅 super_admin / academic_admin |
| 安全事件/导出日志 | 仅 super_admin |
| submissions 收件箱 | 沿用 0001：匿名只写、登录读改、无删除 |

## 后续阶段落点（占位函数已建，防止 RLS 写死）

- `is_assigned_teacher(user, offering)` → 0005 后按 `teacher_assignments` 实现（教师仅见被分配课程/班级）
- `is_enrolled_student(user, offering)` → 0005 后按 `course_enrollments` 实现（学员仅见本人注册课程）
- `is_assigned_mentor(mentor, student)` → 0006 后按 `mentor_assignments` 实现（导师仅见被授权摘要）

## §4.3 原始矩阵（目标态，供各阶段验收对照）

见规范原文；每一格的授权都必须能在「RLS 策略 + 受保护函数」中指出对应实现，凡不能指出的视为未实现，禁止仅靠前端隐藏。
