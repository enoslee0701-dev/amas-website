-- ============================================================
-- 0037_submissions_cohort · 官网报名收件箱加「班级」
--
-- 2026-10-26 Enos：报名的学员分成两个班——第一班已开课，第二班 10/28（周三）开课。
-- 这些报名人还没有门户账号、没有学籍，进不了 course_enrollments；先在收件箱里记下分班，
-- 建档后再按这里编班。空串 = 未分班。读写权限沿用 0036（只有教务类角色）。
-- ============================================================

alter table public.submissions add column if not exists cohort text not null default '';
create index if not exists submissions_cohort_idx on public.submissions (cohort);
