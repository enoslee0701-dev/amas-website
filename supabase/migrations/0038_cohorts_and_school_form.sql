-- ============================================================
-- 0038_cohorts_and_school_form · 报名分班的班级档案 + 总校《神学校入学申请表》
--
-- 2026-10-26 Enos：两个班改名「10月班」（已开课，记录课程进度）与「11月班」；
-- 每位报名人要有一份按总校纸本格式填写的入学申请表，可补填、可打印递交总校。
--
-- submission_cohorts：班级名、开课日、课程进度（自由文字）。submissions.cohort 按名称引用。
-- submissions.school_form：申请表的填写内容（键 = 表格栏位），初次打开由报名资料预填，教务补填后保存。
-- 两者都只给教务类角色读写（与 0036 一致）。
-- ============================================================

create table if not exists public.submission_cohorts (
  name        text primary key check (length(btrim(name)) between 1 and 40),
  starts_on   date,
  progress    text not null default '' check (length(progress) <= 2000),
  sort        int  not null default 0,
  updated_at  timestamptz not null default now()
);
comment on table public.submission_cohorts is '报名分班的班级（10月班 / 11月班 …）与课程进度';

drop trigger if exists submission_cohorts_set_updated_at on public.submission_cohorts;
create trigger submission_cohorts_set_updated_at
  before update on public.submission_cohorts
  for each row execute function public.set_updated_at();

alter table public.submission_cohorts enable row level security;
revoke all on public.submission_cohorts from anon;
drop policy if exists sc_select on public.submission_cohorts;
create policy sc_select on public.submission_cohorts
  for select to authenticated using (public.is_admin_any(auth.uid()));
drop policy if exists sc_insert on public.submission_cohorts;
create policy sc_insert on public.submission_cohorts
  for insert to authenticated with check (public.is_admin_any(auth.uid()));
drop policy if exists sc_update on public.submission_cohorts;
create policy sc_update on public.submission_cohorts
  for update to authenticated
  using (public.is_admin_any(auth.uid())) with check (public.is_admin_any(auth.uid()));

alter table public.submissions add column if not exists school_form jsonb not null default '{}'::jsonb;
