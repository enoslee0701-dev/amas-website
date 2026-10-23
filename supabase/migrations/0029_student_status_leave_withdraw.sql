-- ============================================================
-- 0029_student_status_leave_withdraw · 学籍状态：休学 / 退学
--
-- 依据：学员管理系统策划书第一期（M1，Enos 2026-10-23 批准开工）。
-- 只扩枚举；状态机白名单与 RPC 在 0030。
-- 单独成文件：Postgres 不允许在同一事务里新增枚举值后立刻使用它。
-- 毕业（graduated）随第三期毕业审核另起迁移，此处刻意不预置。
-- ============================================================

alter type public.student_status add value if not exists 'on_leave';
alter type public.student_status add value if not exists 'withdrawn';
