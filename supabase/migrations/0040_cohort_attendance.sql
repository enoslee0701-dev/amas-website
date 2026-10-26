-- ============================================================
-- 0040_cohort_attendance · 班级上课记录：考勤与作业
--
-- 2026-10-26 Enos：课在 Zoom 上，作业在 Zoom、考勤在 WhatsApp，需要在后台记下来；
-- 「开课与编班」那套（课程班 / 任课 / 选课）他暂时没空建，所以直接挂在报名分班（0037/0038）上：
--   cohort_sessions  一个班的一次上课（日期、第几课 / 主题、在哪里：Zoom / WhatsApp / 线下）
--   cohort_marks     这一次里每位学员的出勤与作业
-- 学员按报名记录（submissions.id）记，建了学籍的再用 submissions.student_user_id 对到账号，
-- 学员在门户里只能经 my_cohort_record() 看到自己的那几行。读写：教务类角色（与 0036 一致）。
-- ============================================================

alter table public.submissions add column if not exists student_user_id uuid references public.profiles(id) on delete set null;
create index if not exists submissions_student_user on public.submissions (student_user_id) where student_user_id is not null;

-- 已建学籍的报名对上账号（0038 之后建档时把报名 id 记在 applications.form_data.source_submission）
update public.submissions s set student_user_id = a.applicant_id
  from public.applications a
 where a.form_data ? 'source_submission'
   and (a.form_data->>'source_submission')::bigint = s.id
   and s.student_user_id is null;

create table if not exists public.cohort_sessions (
  id          uuid primary key default gen_random_uuid(),
  cohort      text not null references public.submission_cohorts(name) on update cascade on delete cascade,
  held_on     date not null,
  title       text not null default '' check (length(title) <= 120),
  source      text not null default '' check (source in ('', 'zoom', 'whatsapp', 'onsite', 'other')),
  note        text not null default '' check (length(note) <= 1000),
  created_by  uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists cohort_sessions_by_cohort on public.cohort_sessions (cohort, held_on desc);
comment on table public.cohort_sessions is '报名分班的一次上课（Zoom / WhatsApp / 线下），0040';

create table if not exists public.cohort_marks (
  session_id    uuid not null references public.cohort_sessions(id) on delete cascade,
  submission_id bigint not null references public.submissions(id) on delete cascade,
  attendance    text not null default '' check (attendance in ('', 'present', 'late', 'absent', 'excused')),
  homework      text not null default '' check (homework in ('', 'excellent', 'done', 'partial', 'missing')),
  note          text not null default '' check (length(note) <= 500),
  updated_at    timestamptz not null default now(),
  primary key (session_id, submission_id)
);
comment on table public.cohort_marks is '一次上课里每位学员的出勤与作业，0040';

drop trigger if exists cohort_sessions_set_updated_at on public.cohort_sessions;
create trigger cohort_sessions_set_updated_at before update on public.cohort_sessions
  for each row execute function public.set_updated_at();
drop trigger if exists cohort_marks_set_updated_at on public.cohort_marks;
create trigger cohort_marks_set_updated_at before update on public.cohort_marks
  for each row execute function public.set_updated_at();

alter table public.cohort_sessions enable row level security;
alter table public.cohort_marks enable row level security;
revoke all on public.cohort_sessions, public.cohort_marks from anon;

do $$ declare t text; begin
  foreach t in array array['cohort_sessions', 'cohort_marks'] loop
    execute format('drop policy if exists %I on public.%I', t || '_admin', t);
    execute format('create policy %I on public.%I for all to authenticated
                      using (public.is_admin_any(auth.uid())) with check (public.is_admin_any(auth.uid()))', t || '_admin', t);
  end loop;
end $$;

-- 学员看自己的：班级、每次上课的出勤与作业（不经表，经这一个只读函数）
create or replace function public.my_cohort_record()
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'cohort', s.cohort, 'held_on', cs.held_on, 'title', cs.title, 'source', cs.source,
           'attendance', coalesce(m.attendance, ''), 'homework', coalesce(m.homework, ''))
           order by cs.held_on desc), '[]'::jsonb)
    from public.submissions s
    join public.cohort_sessions cs on cs.cohort = s.cohort
    left join public.cohort_marks m on m.session_id = cs.id and m.submission_id = s.id
   where s.student_user_id = auth.uid() and s.type = 'application';
$$;
revoke execute on function public.my_cohort_record() from public, anon;
grant execute on function public.my_cohort_record() to authenticated;
