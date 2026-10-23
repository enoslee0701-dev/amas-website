-- ============================================================
-- 0032_sis_teaching_grades_credits · 学员管理系统第二至四期
--   第二期：上课记录、出勤、作业与评分、课程总评（录入 → 提交 → 教务发布）、成绩更正
--   第三期：学分账本、实践训练自报、GPA、毕业审核与毕业登记
--   第四期：导师指派与陪伴记录
--
-- Enos 2026-10-23 拍板：等级制 A+ 至 F、4.0 绩点、D- 及以上给学分、F 须重修；
-- 实践训练 5 项 7 学分由学员自行填报，教务暂不审核；教务编班。
-- 暂按默认、待 Enos 确认：毕业 GPA 门槛 2.0（program_catalog.min_gpa，可改）；出勤只记录、不自动扣学分。
--
-- 访问模型：本迁移的新表**客户端一律不可直读直写**，只经定义者权限的 RPC：
--   · 教授写入：authenticated RPC，内部复核「本班任课 + 有效 teacher 角色 + 本次登录 aal2」；
--   · 学员 / 导师读取：authenticated RPC，只返回本人 / 所带学员；
--   · 教务写入：service_role RPC，由 sis-admin Edge Function 校验角色 + aal2 后调用。
-- 每个写操作同事务写 audit_logs。正式记录（总评、学分、毕业）登记 R-8。
-- ============================================================

-- ============================================================
-- 0. 公共
-- ============================================================

-- 本次请求是否两步验证（Supabase 把 JWT 声明放在 request.jwt.claims）
create or replace function public.request_is_aal2()
returns boolean language sql stable set search_path = '' as $$
  select coalesce((nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'aal') = 'aal2', false);
$$;

-- 学籍状态机：在 0030 基础上加 active → graduated（只经 sis_graduate）
create or replace function public.student_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  in_rpc boolean := coalesce(current_setting('amas.rpc_context', true), '') = 'student';
begin
  if in_rpc then perform set_config('amas.rpc_context', '', true); end if;
  if tg_op = 'INSERT' then
    if not in_rpc then
      raise exception 'student records are created through a protected server flow only';
    end if;
    if new.status <> 'pre_enrolled' then
      raise exception 'student record must start as pre_enrolled';
    end if;
    return new;
  end if;

  if new.status is distinct from old.status then
    if not in_rpc then
      raise exception 'student status is changed through a protected server flow only';
    end if;
    if not (
         (old.status = 'pre_enrolled' and new.status = 'active')
      or (old.status = 'active'       and new.status = 'on_leave')
      or (old.status = 'on_leave'     and new.status = 'active')
      or (old.status in ('pre_enrolled','active','on_leave') and new.status = 'withdrawn')
      or (old.status = 'active'       and new.status = 'graduated')
    ) then
      raise exception 'invalid student transition % -> %', old.status, new.status;
    end if;
    if new.status = 'active' and public.normalize_student_number(new.student_number) is null then
      raise exception 'student number required before activation';
    end if;
  end if;

  if not in_rpc then
    if new.student_number_normalized is distinct from old.student_number_normalized
       or new.student_number is distinct from old.student_number then
      raise exception 'student number is corrected through a dedicated server flow only';
    end if;
    if new.user_id is distinct from old.user_id
       or new.application_id is distinct from old.application_id then
      raise exception 'student identity binding is immutable from client';
    end if;
  end if;
  return new;
end $$;

-- 毕业要求：落成数字列，取代只写在说明文字里的「77 学分」
alter table public.program_catalog add column if not exists credits_required numeric;
alter table public.program_catalog add column if not exists min_gpa numeric;
update public.program_catalog set credits_required = 77, min_gpa = 2.0 where code = 'bth';
comment on column public.program_catalog.min_gpa is
  '毕业平均绩点门槛。B.Th 2.0 为默认值，待 Enos 确认（2026-10-23）。';

-- 只增不改：拒绝一切 UPDATE / DELETE；唯一放行的是账号注销时外键把 created_by 置空（同 0014 的口径）
create or replace function public.sis_append_only()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'UPDATE'
     and (to_jsonb(new) - 'created_by') = (to_jsonb(old) - 'created_by')
     and (to_jsonb(new) ->> 'created_by') is null then
    return new;
  end if;
  raise exception '% is append-only', tg_table_name;
end $$;

-- ============================================================
-- 1. 等级与绩点
-- ============================================================
create table if not exists public.grade_scale (
  letter   text primary key,
  points   numeric not null,
  passing  boolean not null,
  sort     int not null
);
insert into public.grade_scale (letter, points, passing, sort) values
  ('A+', 4.0, true, 1), ('A', 4.0, true, 2), ('A-', 3.7, true, 3),
  ('B+', 3.3, true, 4), ('B', 3.0, true, 5), ('B-', 2.7, true, 6),
  ('C+', 2.3, true, 7), ('C', 2.0, true, 8), ('C-', 1.7, true, 9),
  ('D+', 1.3, true, 10), ('D', 1.0, true, 11), ('D-', 0.7, true, 12),
  ('F', 0, false, 13)
on conflict (letter) do nothing;
alter table public.grade_scale enable row level security;
revoke insert, update, delete on public.grade_scale from anon, authenticated;
grant select on public.grade_scale to anon, authenticated;
drop policy if exists gs_read on public.grade_scale;
create policy gs_read on public.grade_scale for select to anon, authenticated using (true);

-- ============================================================
-- 2. 第二期表
-- ============================================================
create table if not exists public.class_sessions (
  id            uuid primary key default gen_random_uuid(),
  offering_id   uuid not null references public.course_offerings(id),
  held_on       date not null,
  topic         text not null,
  materials_url text,
  note          text,
  recorded_by   uuid references public.profiles(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint cs_topic check (char_length(topic) between 1 and 200),
  constraint cs_url check (materials_url is null or (materials_url ~ '^https://' and char_length(materials_url) <= 500)),
  constraint cs_note check (note is null or char_length(note) <= 1000)
);
create index if not exists cs_by_offering on public.class_sessions (offering_id, held_on);
drop trigger if exists cs_set_updated_at on public.class_sessions;
create trigger cs_set_updated_at before update on public.class_sessions
  for each row execute function public.set_updated_at();

create table if not exists public.attendance_records (
  session_id    uuid not null references public.class_sessions(id) on delete cascade,
  enrollment_id uuid not null references public.course_enrollments(id),
  status        text not null,
  note          text,
  recorded_by   uuid references public.profiles(id) on delete set null,
  recorded_at   timestamptz not null default now(),
  primary key (session_id, enrollment_id),
  constraint ar_status check (status in ('present','late','excused','absent')),
  constraint ar_note check (note is null or char_length(note) <= 300)
);

create table if not exists public.assignments (
  id           uuid primary key default gen_random_uuid(),
  offering_id  uuid not null references public.course_offerings(id),
  title        text not null,
  description  text,
  due_on       date,
  weight       numeric,
  created_by   uuid references public.profiles(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint as_title check (char_length(title) between 1 and 200),
  constraint as_desc check (description is null or char_length(description) <= 2000),
  constraint as_weight check (weight is null or (weight > 0 and weight <= 100))
);
create index if not exists as_by_offering on public.assignments (offering_id);
drop trigger if exists as_set_updated_at on public.assignments;
create trigger as_set_updated_at before update on public.assignments
  for each row execute function public.set_updated_at();

create table if not exists public.assignment_scores (
  assignment_id uuid not null references public.assignments(id) on delete cascade,
  enrollment_id uuid not null references public.course_enrollments(id),
  grade         text not null references public.grade_scale(letter),
  comment       text,
  scored_by     uuid references public.profiles(id) on delete set null,
  scored_at     timestamptz not null default now(),
  primary key (assignment_id, enrollment_id),
  constraint asc_comment check (comment is null or char_length(comment) <= 1000)
);

create table if not exists public.final_grades (
  enrollment_id   uuid primary key references public.course_enrollments(id),
  grade           text references public.grade_scale(letter),
  comment         text,
  status          text not null default 'draft',
  entered_by      uuid references public.profiles(id) on delete set null,
  entered_at      timestamptz not null default now(),
  submitted_at    timestamptz,
  published_at    timestamptz,
  published_by    uuid references public.profiles(id) on delete set null,
  returned_reason text,
  constraint fg_status check (status in ('draft','submitted','published')),
  constraint fg_comment check (comment is null or char_length(comment) <= 1000),
  constraint fg_published_has_grade check (status = 'draft' or grade is not null)
);

create table if not exists public.grade_corrections (
  id            uuid primary key default gen_random_uuid(),
  enrollment_id uuid not null references public.final_grades(enrollment_id),
  from_grade    text not null references public.grade_scale(letter),
  to_grade      text not null references public.grade_scale(letter),
  reason        text not null,
  requested_by  uuid references public.profiles(id) on delete set null,
  requested_at  timestamptz not null default now(),
  status        text not null default 'pending',
  decided_by    uuid references public.profiles(id) on delete set null,
  decided_at    timestamptz,
  decision_note text,
  constraint gc_status check (status in ('pending','approved','rejected')),
  constraint gc_reason check (char_length(reason) between 1 and 1000)
);
create unique index if not exists gc_one_pending on public.grade_corrections (enrollment_id) where status = 'pending';

-- ============================================================
-- 3. 第三期表
-- ============================================================
create table if not exists public.credit_ledger (
  id           bigint generated always as identity primary key,
  student_id   uuid not null references public.student_records(id),
  source       text not null,
  course_code  text,
  practicum_code text,
  ref_id       text,
  credits      numeric not null,
  reason       text,
  created_by   uuid references public.profiles(id) on delete set null,
  created_at   timestamptz not null default now(),
  constraint cl_source check (source in ('course','practicum')),
  constraint cl_nonzero check (credits <> 0)
);
create index if not exists cl_by_student on public.credit_ledger (student_id);
drop trigger if exists cl_append_only on public.credit_ledger;
create trigger cl_append_only before update or delete on public.credit_ledger
  for each row execute function public.sis_append_only();

create table if not exists public.practicum_items (
  code         text primary key,
  program_code text not null references public.program_catalog(code),
  title_zh     text not null,
  credits      numeric not null,
  sort         int not null
);
insert into public.practicum_items (code, program_code, title_zh, credits, sort) values
  ('p_reading',     'bth', '读经训练', 1, 1),
  ('p_devotion',    'bth', '灵修训练', 1, 2),
  ('p_prayer',      'bth', '祷告训练', 2, 3),
  ('p_evangelism',  'bth', '传道训练', 2, 4),
  ('p_giving',      'bth', '奉献训练', 1, 5)
on conflict (code) do nothing;

create table if not exists public.practicum_reports (
  student_id    uuid not null references public.student_records(id),
  item_code     text not null references public.practicum_items(code),
  completed_on  date not null,
  note          text,
  reported_at   timestamptz not null default now(),
  retracted_at  timestamptz,
  primary key (student_id, item_code),
  constraint pr_note check (note is null or char_length(note) <= 1000)
);

create table if not exists public.graduation_records (
  student_id    uuid primary key references public.student_records(id),
  program_code  text references public.program_catalog(code),
  total_credits numeric not null,
  gpa           numeric,
  graduated_on  date not null,
  audited_by    uuid references public.profiles(id) on delete set null,
  created_at    timestamptz not null default now()
);

-- ============================================================
-- 4. 第四期表
-- ============================================================
create table if not exists public.mentor_assignments (
  id          uuid primary key default gen_random_uuid(),
  mentor_id   uuid not null references public.profiles(id),
  student_id  uuid not null references public.student_records(id),
  assigned_by uuid references public.profiles(id) on delete set null,
  started_at  timestamptz not null default now(),
  ended_at    timestamptz,
  ended_by    uuid references public.profiles(id) on delete set null
);
create unique index if not exists ma_one_active on public.mentor_assignments (mentor_id, student_id) where ended_at is null;

create table if not exists public.mentor_notes (
  id          uuid primary key default gen_random_uuid(),
  mentor_id   uuid not null references public.profiles(id),
  student_id  uuid not null references public.student_records(id),
  body        text not null,
  created_at  timestamptz not null default now(),
  constraint mn_body check (char_length(body) between 1 and 4000)
);
create index if not exists mn_by_student on public.mentor_notes (student_id, created_at desc);
drop trigger if exists mn_append_only on public.mentor_notes;
create trigger mn_append_only before update or delete on public.mentor_notes
  for each row execute function public.sis_append_only();

-- ============================================================
-- 5. 客户端不可直读直写：只经 RPC
-- ============================================================
do $$
declare t text;
begin
  foreach t in array array['class_sessions','attendance_records','assignments','assignment_scores',
    'final_grades','grade_corrections','credit_ledger','practicum_items','practicum_reports',
    'graduation_records','mentor_assignments','mentor_notes'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end $$;

-- R-8：正式记录登记
insert into public.irreversible_record_sources
  (source_key, table_name, record_kind, is_irreversible, check_sql, rationale, registered_by)
values
  ('final_grades_published', 'final_grades', 'grade', 'yes',
   $chk$select exists (select 1 from public.final_grades g
                        join public.course_enrollments e on e.id = g.enrollment_id
                        join public.student_records s on s.id = e.student_id
                        where s.student_number_normalized = $1 and g.status = 'published')$chk$,
   '已发布的课程总评是正式成绩，学号已对外生效。', '0032'),
  ('credit_ledger', 'credit_ledger', 'earned_credit', 'yes',
   $chk$select exists (select 1 from public.credit_ledger c
                        join public.student_records s on s.id = c.student_id
                        where s.student_number_normalized = $1)$chk$,
   '学分账本只增不改，任何一笔都构成正式学分记录。', '0032'),
  ('graduation_records', 'graduation_records', 'graduation_record', 'yes',
   $chk$select exists (select 1 from public.graduation_records g
                        join public.student_records s on s.id = g.student_id
                        where s.student_number_normalized = $1)$chk$,
   '毕业登记是最终学籍结论。', '0032'),
  ('assignment_scores', 'assignment_scores', 'other', 'no', null,
   '平时作业评分是教学过程记录，不是正式成绩；正式成绩以 final_grades 为准。', '0032'),
  ('grade_corrections', 'grade_corrections', 'other', 'no', null,
   '更正申请本身不是成绩；批准后的结果落在 final_grades。', '0032'),
  ('grade_scale', 'grade_scale', 'other', 'no', null,
   '等级与绩点对照表，是全局参考数据，与个人学号无关。', '0032')
on conflict (source_key) do nothing;

-- ============================================================
-- 6. 计算：GPA、净学分、毕业审核
-- ============================================================

-- 每门课取最近一次发布的成绩（重修以新成绩为准），只计有学分的课程
create or replace function public.student_gpa(p_student uuid)
returns numeric language sql stable security definer set search_path = '' as $$
  with latest as (
    select distinct on (o.course_code) o.course_code, g.grade, c.credits
    from public.final_grades g
    join public.course_enrollments e on e.id = g.enrollment_id
    join public.course_offerings o on o.id = e.offering_id
    join public.course_catalog c on c.code = o.course_code
    where e.student_id = p_student and g.status = 'published' and c.credits is not null
    order by o.course_code, g.published_at desc
  )
  select round(sum(gs.points * l.credits) / nullif(sum(l.credits), 0), 2)
  from latest l join public.grade_scale gs on gs.letter = l.grade;
$$;

create or replace function public.student_course_net_credits(p_student uuid, p_course text)
returns numeric language sql stable security definer set search_path = '' as $$
  select coalesce(sum(credits), 0) from public.credit_ledger
   where student_id = p_student and source = 'course' and course_code = p_course;
$$;

-- 按某条总评的当前结果，把该课程的学分调到应有的状态（只追加，不改历史）
create or replace function public.sis_sync_course_credit(p_enrollment uuid, p_actor uuid, p_reason text)
returns numeric language plpgsql security definer set search_path = '' as $$
declare
  v_student uuid; v_course text; v_credits numeric; v_pass boolean; v_net numeric; v_delta numeric := 0;
begin
  select e.student_id, o.course_code, c.credits, coalesce(gs.passing, false)
    into v_student, v_course, v_credits, v_pass
  from public.final_grades g
  join public.course_enrollments e on e.id = g.enrollment_id
  join public.course_offerings o on o.id = e.offering_id
  join public.course_catalog c on c.code = o.course_code
  left join public.grade_scale gs on gs.letter = g.grade
  where g.enrollment_id = p_enrollment and g.status = 'published';
  if not found or v_credits is null then return 0; end if;

  -- 是否有**任何一次**已发布的及格成绩（重修及格后，旧的不及格不影响学分）
  select exists (
    select 1 from public.final_grades g2
    join public.course_enrollments e2 on e2.id = g2.enrollment_id
    join public.course_offerings o2 on o2.id = e2.offering_id
    join public.grade_scale gs2 on gs2.letter = g2.grade
    where e2.student_id = v_student and o2.course_code = v_course
      and g2.status = 'published' and gs2.passing) into v_pass;

  v_net := public.student_course_net_credits(v_student, v_course);
  if v_pass and v_net = 0 then v_delta := v_credits;
  elsif not v_pass and v_net > 0 then v_delta := -v_net;
  end if;
  if v_delta <> 0 then
    insert into public.credit_ledger (student_id, source, course_code, ref_id, credits, reason, created_by)
    values (v_student, 'course', v_course, p_enrollment::text, v_delta, p_reason, p_actor);
  end if;
  return v_delta;
end $$;

create or replace function public.graduation_audit(p_student uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  s public.student_records; p public.program_catalog;
  v_total numeric; v_course numeric; v_prac numeric; v_gpa numeric; v_missing jsonb; v_prac_list jsonb;
begin
  select * into s from public.student_records where id = p_student;
  if not found then return null; end if;
  select * into p from public.program_catalog where code = s.program_code;

  select coalesce(sum(credits) filter (where source = 'course'), 0),
         coalesce(sum(credits) filter (where source = 'practicum'), 0)
    into v_course, v_prac
  from public.credit_ledger where student_id = p_student;
  v_total := v_course + v_prac;
  v_gpa := public.student_gpa(p_student);

  select coalesce(jsonb_agg(jsonb_build_object('code', c.code, 'title_zh', c.title_zh, 'credits', c.credits)
                            order by c.sort_order), '[]'::jsonb)
    into v_missing
  from public.course_catalog c
  where c.level = s.program_code and c.credits is not null
    and public.student_course_net_credits(p_student, c.code) <= 0;

  select coalesce(jsonb_agg(jsonb_build_object('code', i.code, 'title_zh', i.title_zh, 'credits', i.credits,
                            'done', r.item_code is not null and r.retracted_at is null,
                            'completed_on', case when r.retracted_at is null then r.completed_on end)
                            order by i.sort), '[]'::jsonb)
    into v_prac_list
  from public.practicum_items i
  left join public.practicum_reports r on r.item_code = i.code and r.student_id = p_student
  where i.program_code = s.program_code;

  return jsonb_build_object(
    'student_id', p_student, 'status', s.status, 'program_code', s.program_code,
    'credits_required', p.credits_required, 'min_gpa', p.min_gpa,
    'credits_earned', v_total, 'course_credits', v_course, 'practicum_credits', v_prac,
    'gpa', v_gpa, 'missing_courses', v_missing, 'practicum', v_prac_list,
    'eligible', s.status = 'active' and p.credits_required is not null
                and v_total >= p.credits_required
                and (p.min_gpa is null or coalesce(v_gpa, 0) >= p.min_gpa)
                and jsonb_array_length(v_missing) = 0);
end $$;

-- ============================================================
-- 7. 教授 RPC（authenticated；本班任课 + 有效 teacher 角色 + aal2）
-- ============================================================
create or replace function public.sis_teacher_check(p_offering uuid, p_allow text[])
returns text language plpgsql stable security definer set search_path = '' as $$
declare v_status text;
begin
  -- 拒绝一律**返回**错误码而不是抛异常：抛出的异常经 PostgREST 到前端只剩 400，
  -- 页面分不清「没两步验证」「不是本班教授」「课程班已取消」。
  if not public.request_is_aal2() then return 'mfa_required'; end if;
  if not public.is_assigned_teacher(auth.uid(), p_offering) then return 'not_assigned'; end if;
  select status into v_status from public.course_offerings where id = p_offering;
  if not (v_status = any(p_allow)) then return 'invalid_state'; end if;
  return null;
end $$;
revoke execute on function public.sis_teacher_check(uuid,text[]) from public, anon, authenticated;

create or replace function public.teacher_save_session(
  p_offering uuid, p_session uuid, p_held_on date, p_topic text, p_materials_url text, p_note text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_gate text; v_id uuid; v_old public.class_sessions;
begin
  v_gate := public.sis_teacher_check(p_offering, array['planned','in_progress','completed']);
  if v_gate is not null then return jsonb_build_object('ok', false, 'error', v_gate); end if;
  if p_held_on is null or coalesce(trim(p_topic), '') = '' then
    return jsonb_build_object('ok', false, 'error', 'bad_request');
  end if;
  begin
    if p_session is null then
      insert into public.class_sessions (offering_id, held_on, topic, materials_url, note, recorded_by)
      values (p_offering, p_held_on, trim(p_topic), nullif(trim(p_materials_url), ''), nullif(trim(p_note), ''), auth.uid())
      returning id into v_id;
    else
      select * into v_old from public.class_sessions where id = p_session and offering_id = p_offering for update;
      if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
      update public.class_sessions set held_on = p_held_on, topic = trim(p_topic),
             materials_url = nullif(trim(p_materials_url), ''), note = nullif(trim(p_note), '')
       where id = p_session;
      v_id := p_session;
    end if;
  exception when check_violation then
    return jsonb_build_object('ok', false, 'error', 'invalid_fields');
  end;
  perform public.sis_audit(auth.uid(), case when p_session is null then 'session_recorded' else 'session_updated' end,
    'class_sessions', v_id::text,
    case when p_session is null then null else jsonb_build_object('held_on', v_old.held_on, 'topic', v_old.topic) end,
    jsonb_build_object('offering', p_offering, 'held_on', p_held_on, 'topic', p_topic), null);
  return jsonb_build_object('ok', true, 'session_id', v_id);
end $$;

create or replace function public.teacher_delete_session(p_session uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_gate text; v public.class_sessions;
begin
  select * into v from public.class_sessions where id = p_session for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  v_gate := public.sis_teacher_check(v.offering_id, array['planned','in_progress','completed']);
  if v_gate is not null then return jsonb_build_object('ok', false, 'error', v_gate); end if;
  delete from public.class_sessions where id = p_session;
  perform public.sis_audit(auth.uid(), 'session_deleted', 'class_sessions', p_session::text,
    jsonb_build_object('offering', v.offering_id, 'held_on', v.held_on, 'topic', v.topic), null, null);
  return jsonb_build_object('ok', true);
end $$;

-- p_entries: [{"enrollment_id": "...", "status": "present|late|excused|absent", "note": "..."}]
create or replace function public.teacher_set_attendance(p_session uuid, p_entries jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_gate text; v public.class_sessions; x jsonb; n int := 0; v_bad int := 0;
begin
  select * into v from public.class_sessions where id = p_session;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  v_gate := public.sis_teacher_check(v.offering_id, array['planned','in_progress','completed']);
  if v_gate is not null then return jsonb_build_object('ok', false, 'error', v_gate); end if;
  if jsonb_typeof(p_entries) <> 'array' then return jsonb_build_object('ok', false, 'error', 'bad_request'); end if;
  for x in select * from jsonb_array_elements(p_entries) loop
    if not exists (select 1 from public.course_enrollments e
                    where e.id = (x->>'enrollment_id')::uuid and e.offering_id = v.offering_id and e.status = 'enrolled')
       or coalesce(x->>'status', '') not in ('present','late','excused','absent') then
      v_bad := v_bad + 1; continue;
    end if;
    insert into public.attendance_records (session_id, enrollment_id, status, note, recorded_by)
    values (p_session, (x->>'enrollment_id')::uuid, x->>'status', nullif(left(trim(coalesce(x->>'note', '')), 300), ''), auth.uid())
    on conflict (session_id, enrollment_id) do update
      set status = excluded.status, note = excluded.note, recorded_by = excluded.recorded_by, recorded_at = now();
    n := n + 1;
  end loop;
  perform public.sis_audit(auth.uid(), 'attendance_recorded', 'class_sessions', p_session::text, null,
    jsonb_build_object('saved', n, 'rejected', v_bad), null);
  return jsonb_build_object('ok', true, 'saved', n, 'rejected', v_bad);
end $$;

create or replace function public.teacher_save_assignment(
  p_offering uuid, p_assignment uuid, p_title text, p_description text, p_due_on date, p_weight numeric
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_gate text; v_id uuid;
begin
  v_gate := public.sis_teacher_check(p_offering, array['planned','in_progress','completed']);
  if v_gate is not null then return jsonb_build_object('ok', false, 'error', v_gate); end if;
  if coalesce(trim(p_title), '') = '' then return jsonb_build_object('ok', false, 'error', 'bad_request'); end if;
  begin
    if p_assignment is null then
      insert into public.assignments (offering_id, title, description, due_on, weight, created_by)
      values (p_offering, trim(p_title), nullif(trim(p_description), ''), p_due_on, p_weight, auth.uid())
      returning id into v_id;
    else
      update public.assignments set title = trim(p_title), description = nullif(trim(p_description), ''),
             due_on = p_due_on, weight = p_weight
       where id = p_assignment and offering_id = p_offering returning id into v_id;
      if v_id is null then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
    end if;
  exception when check_violation then
    return jsonb_build_object('ok', false, 'error', 'invalid_fields');
  end;
  perform public.sis_audit(auth.uid(), 'assignment_saved', 'assignments', v_id::text, null,
    jsonb_build_object('offering', p_offering, 'title', p_title, 'due_on', p_due_on, 'weight', p_weight), null);
  return jsonb_build_object('ok', true, 'assignment_id', v_id);
end $$;

create or replace function public.teacher_delete_assignment(p_assignment uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_gate text; a public.assignments;
begin
  select * into a from public.assignments where id = p_assignment for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  v_gate := public.sis_teacher_check(a.offering_id, array['planned','in_progress','completed']);
  if v_gate is not null then return jsonb_build_object('ok', false, 'error', v_gate); end if;
  delete from public.assignments where id = p_assignment;
  perform public.sis_audit(auth.uid(), 'assignment_deleted', 'assignments', p_assignment::text,
    jsonb_build_object('offering', a.offering_id, 'title', a.title), null, null);
  return jsonb_build_object('ok', true);
end $$;

-- p_entries: [{"enrollment_id": "...", "grade": "A-", "comment": "..."}]；grade 为空 = 清除该生评分
create or replace function public.teacher_set_scores(p_assignment uuid, p_entries jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_gate text; a public.assignments; x jsonb; n int := 0; v_bad int := 0; g text;
begin
  select * into a from public.assignments where id = p_assignment;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  v_gate := public.sis_teacher_check(a.offering_id, array['planned','in_progress','completed']);
  if v_gate is not null then return jsonb_build_object('ok', false, 'error', v_gate); end if;
  if jsonb_typeof(p_entries) <> 'array' then return jsonb_build_object('ok', false, 'error', 'bad_request'); end if;
  for x in select * from jsonb_array_elements(p_entries) loop
    g := nullif(trim(coalesce(x->>'grade', '')), '');
    if not exists (select 1 from public.course_enrollments e
                    where e.id = (x->>'enrollment_id')::uuid and e.offering_id = a.offering_id and e.status = 'enrolled')
       or (g is not null and not exists (select 1 from public.grade_scale where letter = g)) then
      v_bad := v_bad + 1; continue;
    end if;
    if g is null then
      delete from public.assignment_scores where assignment_id = p_assignment and enrollment_id = (x->>'enrollment_id')::uuid;
    else
      insert into public.assignment_scores (assignment_id, enrollment_id, grade, comment, scored_by)
      values (p_assignment, (x->>'enrollment_id')::uuid, g, nullif(left(trim(coalesce(x->>'comment', '')), 1000), ''), auth.uid())
      on conflict (assignment_id, enrollment_id) do update
        set grade = excluded.grade, comment = excluded.comment, scored_by = excluded.scored_by, scored_at = now();
    end if;
    n := n + 1;
  end loop;
  perform public.sis_audit(auth.uid(), 'assignment_scored', 'assignments', p_assignment::text, null,
    jsonb_build_object('saved', n, 'rejected', v_bad), null);
  return jsonb_build_object('ok', true, 'saved', n, 'rejected', v_bad);
end $$;

-- 课程总评：只能改草稿；已提交 / 已发布的不动（发布后走更正）
create or replace function public.teacher_save_grades(p_offering uuid, p_entries jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_gate text; x jsonb; n int := 0; v_locked int := 0; v_bad int := 0; g text; v_eid uuid; cur public.final_grades;
begin
  v_gate := public.sis_teacher_check(p_offering, array['in_progress','completed']);
  if v_gate is not null then return jsonb_build_object('ok', false, 'error', v_gate); end if;
  if jsonb_typeof(p_entries) <> 'array' then return jsonb_build_object('ok', false, 'error', 'bad_request'); end if;
  for x in select * from jsonb_array_elements(p_entries) loop
    v_eid := (x->>'enrollment_id')::uuid;
    g := nullif(trim(coalesce(x->>'grade', '')), '');
    if not exists (select 1 from public.course_enrollments e
                    where e.id = v_eid and e.offering_id = p_offering and e.status = 'enrolled')
       or (g is not null and not exists (select 1 from public.grade_scale where letter = g)) then
      v_bad := v_bad + 1; continue;
    end if;
    select * into cur from public.final_grades where enrollment_id = v_eid for update;
    if found and cur.status <> 'draft' then v_locked := v_locked + 1; continue; end if;
    insert into public.final_grades (enrollment_id, grade, comment, status, entered_by)
    values (v_eid, g, nullif(left(trim(coalesce(x->>'comment', '')), 1000), ''), 'draft', auth.uid())
    on conflict (enrollment_id) do update
      set grade = excluded.grade, comment = excluded.comment, entered_by = excluded.entered_by, entered_at = now();
    n := n + 1;
  end loop;
  perform public.sis_audit(auth.uid(), 'grades_drafted', 'course_offerings', p_offering::text, null,
    jsonb_build_object('saved', n, 'locked', v_locked, 'rejected', v_bad), null);
  return jsonb_build_object('ok', true, 'saved', n, 'locked', v_locked, 'rejected', v_bad);
end $$;

create or replace function public.teacher_submit_grades(p_offering uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_gate text; n int; v_missing int;
begin
  v_gate := public.sis_teacher_check(p_offering, array['in_progress','completed']);
  if v_gate is not null then return jsonb_build_object('ok', false, 'error', v_gate); end if;
  select count(*) into v_missing from public.course_enrollments e
   left join public.final_grades g on g.enrollment_id = e.id
   where e.offering_id = p_offering and e.status = 'enrolled' and (g.enrollment_id is null or g.grade is null);
  if v_missing > 0 then
    return jsonb_build_object('ok', false, 'error', 'grades_incomplete', 'missing', v_missing);
  end if;
  update public.final_grades g set status = 'submitted', submitted_at = now(), returned_reason = null
   from public.course_enrollments e
   where e.id = g.enrollment_id and e.offering_id = p_offering and e.status = 'enrolled' and g.status = 'draft';
  get diagnostics n = row_count;
  if n = 0 then return jsonb_build_object('ok', false, 'error', 'nothing_to_submit'); end if;
  perform public.sis_audit(auth.uid(), 'grades_submitted', 'course_offerings', p_offering::text, null,
    jsonb_build_object('submitted', n), null);
  return jsonb_build_object('ok', true, 'submitted', n);
end $$;

create or replace function public.teacher_request_correction(p_enrollment uuid, p_to_grade text, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_gate text; g public.final_grades; v_off uuid; v_id uuid;
begin
  select e.offering_id into v_off from public.course_enrollments e where e.id = p_enrollment;
  if v_off is null then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  v_gate := public.sis_teacher_check(v_off, array['in_progress','completed']);
  if v_gate is not null then return jsonb_build_object('ok', false, 'error', v_gate); end if;
  if coalesce(trim(p_reason), '') = '' then return jsonb_build_object('ok', false, 'error', 'reason_required'); end if;
  if not exists (select 1 from public.grade_scale where letter = p_to_grade) then
    return jsonb_build_object('ok', false, 'error', 'bad_grade');
  end if;
  select * into g from public.final_grades where enrollment_id = p_enrollment;
  if not found or g.status <> 'published' then return jsonb_build_object('ok', false, 'error', 'not_published'); end if;
  if g.grade = p_to_grade then return jsonb_build_object('ok', false, 'error', 'unchanged'); end if;
  begin
    insert into public.grade_corrections (enrollment_id, from_grade, to_grade, reason, requested_by)
    values (p_enrollment, g.grade, p_to_grade, trim(p_reason), auth.uid()) returning id into v_id;
  exception when unique_violation then
    return jsonb_build_object('ok', false, 'error', 'correction_pending');
  end;
  perform public.sis_audit(auth.uid(), 'grade_correction_requested', 'final_grades', p_enrollment::text,
    jsonb_build_object('grade', g.grade), jsonb_build_object('grade', p_to_grade), p_reason);
  return jsonb_build_object('ok', true, 'correction_id', v_id);
end $$;

-- 教授读模型
create or replace function public.teacher_offering_detail(p_offering uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare o public.course_offerings; v jsonb;
begin
  if not public.is_assigned_teacher(auth.uid(), p_offering) then return null; end if;
  select * into o from public.course_offerings where id = p_offering;
  select jsonb_build_object(
    'offering', jsonb_build_object('id', o.id, 'course_code', o.course_code, 'title_zh', c.title_zh, 'credits', c.credits,
       'academic_year', o.academic_year, 'section_label', o.section_label, 'status', o.status,
       'starts_on', o.starts_on, 'ends_on', o.ends_on, 'schedule_note', o.schedule_note, 'delivery_mode', o.delivery_mode),
    'roster', coalesce((select jsonb_agg(jsonb_build_object('enrollment_id', e.id, 'display_name', p.display_name,
         'student_number', s.student_number,
         'final_grade', g.grade, 'final_status', g.status, 'final_comment', g.comment, 'returned_reason', g.returned_reason,
         'correction_pending', exists (select 1 from public.grade_corrections gc where gc.enrollment_id = e.id and gc.status = 'pending'))
         order by p.display_name)
       from public.course_enrollments e
       join public.student_records s on s.id = e.student_id
       join public.profiles p on p.id = s.user_id
       left join public.final_grades g on g.enrollment_id = e.id
       where e.offering_id = p_offering and e.status = 'enrolled'), '[]'::jsonb),
    'sessions', coalesce((select jsonb_agg(jsonb_build_object('id', cs.id, 'held_on', cs.held_on, 'topic', cs.topic,
         'materials_url', cs.materials_url, 'note', cs.note,
         'attendance', coalesce((select jsonb_object_agg(a.enrollment_id, jsonb_build_object('status', a.status, 'note', a.note))
                                  from public.attendance_records a where a.session_id = cs.id), '{}'::jsonb))
         order by cs.held_on desc, cs.created_at desc)
       from public.class_sessions cs where cs.offering_id = p_offering), '[]'::jsonb),
    'assignments', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'title', a.title, 'description', a.description,
         'due_on', a.due_on, 'weight', a.weight,
         'scores', coalesce((select jsonb_object_agg(x.enrollment_id, jsonb_build_object('grade', x.grade, 'comment', x.comment))
                              from public.assignment_scores x where x.assignment_id = a.id), '{}'::jsonb))
         order by a.due_on nulls last, a.created_at)
       from public.assignments a where a.offering_id = p_offering), '[]'::jsonb)
  ) into v
  from public.course_catalog c where c.code = o.course_code;
  return v;
end $$;

do $$
declare f text;
begin
  foreach f in array array[
    'public.teacher_save_session(uuid,uuid,date,text,text,text)', 'public.teacher_delete_session(uuid)',
    'public.teacher_set_attendance(uuid,jsonb)', 'public.teacher_save_assignment(uuid,uuid,text,text,date,numeric)',
    'public.teacher_delete_assignment(uuid)', 'public.teacher_set_scores(uuid,jsonb)',
    'public.teacher_save_grades(uuid,jsonb)', 'public.teacher_submit_grades(uuid)',
    'public.teacher_request_correction(uuid,text,text)', 'public.teacher_offering_detail(uuid)'
  ] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;

-- ============================================================
-- 8. 教务 RPC（service_role，经 sis-admin）
-- ============================================================
create or replace function public.sis_publish_grades(p_offering uuid, p_actor uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r record; n int := 0; v_credit numeric := 0;
begin
  if not public.is_admin_any(p_actor) then raise exception 'actor lacks admin role'; end if;
  for r in select g.enrollment_id from public.final_grades g
             join public.course_enrollments e on e.id = g.enrollment_id
            where e.offering_id = p_offering and g.status = 'submitted' for update of g loop
    update public.final_grades set status = 'published', published_at = now(), published_by = p_actor
     where enrollment_id = r.enrollment_id;
    v_credit := v_credit + public.sis_sync_course_credit(r.enrollment_id, p_actor, '成绩发布');
    n := n + 1;
  end loop;
  if n = 0 then return jsonb_build_object('ok', false, 'error', 'nothing_to_publish'); end if;
  perform public.sis_audit(p_actor, 'grades_published', 'course_offerings', p_offering::text, null,
    jsonb_build_object('published', n, 'credits_added', v_credit), null);
  return jsonb_build_object('ok', true, 'published', n, 'credits_added', v_credit);
end $$;

create or replace function public.sis_return_grades(p_offering uuid, p_actor uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  if not public.is_admin_any(p_actor) then raise exception 'actor lacks admin role'; end if;
  if coalesce(trim(p_reason), '') = '' then return jsonb_build_object('ok', false, 'error', 'reason_required'); end if;
  update public.final_grades g set status = 'draft', submitted_at = null, returned_reason = trim(p_reason)
    from public.course_enrollments e
   where e.id = g.enrollment_id and e.offering_id = p_offering and g.status = 'submitted';
  get diagnostics n = row_count;
  if n = 0 then return jsonb_build_object('ok', false, 'error', 'nothing_to_return'); end if;
  perform public.sis_audit(p_actor, 'grades_returned', 'course_offerings', p_offering::text, null,
    jsonb_build_object('returned', n), p_reason);
  return jsonb_build_object('ok', true, 'returned', n);
end $$;

-- 更正：批准人不能是申请人
create or replace function public.sis_decide_correction(p_correction uuid, p_actor uuid, p_approve boolean, p_note text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare c public.grade_corrections; v_delta numeric := 0;
begin
  if not public.is_admin_any(p_actor) then raise exception 'actor lacks admin role'; end if;
  select * into c from public.grade_corrections where id = p_correction for update;
  if not found then raise exception 'not_found'; end if;
  if c.status <> 'pending' then return jsonb_build_object('ok', false, 'error', 'invalid_state'); end if;
  if c.requested_by = p_actor then return jsonb_build_object('ok', false, 'error', 'same_actor_not_allowed'); end if;
  if not p_approve and coalesce(trim(p_note), '') = '' then
    return jsonb_build_object('ok', false, 'error', 'reason_required');
  end if;
  update public.grade_corrections set status = case when p_approve then 'approved' else 'rejected' end,
         decided_by = p_actor, decided_at = now(), decision_note = nullif(trim(p_note), '')
   where id = p_correction;
  if p_approve then
    if (select grade from public.final_grades where enrollment_id = c.enrollment_id) is distinct from c.from_grade then
      raise exception 'invalid_state';
    end if;
    update public.final_grades set grade = c.to_grade where enrollment_id = c.enrollment_id;
    v_delta := public.sis_sync_course_credit(c.enrollment_id, p_actor, '成绩更正');
  end if;
  perform public.sis_audit(p_actor, case when p_approve then 'grade_corrected' else 'grade_correction_rejected' end,
    'final_grades', c.enrollment_id::text, jsonb_build_object('grade', c.from_grade),
    jsonb_build_object('grade', case when p_approve then c.to_grade else c.from_grade end, 'credit_delta', v_delta),
    coalesce(p_note, c.reason));
  return jsonb_build_object('ok', true, 'approved', p_approve, 'credit_delta', v_delta);
end $$;

create or replace function public.sis_graduate(p_student uuid, p_actor uuid, p_graduated_on date)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare a jsonb; s public.student_records;
begin
  if not public.is_admin_any(p_actor) then raise exception 'actor lacks admin role'; end if;
  select * into s from public.student_records where id = p_student for update;
  if not found then raise exception 'not_found'; end if;
  a := public.graduation_audit(p_student);
  if not (a->>'eligible')::boolean then
    return jsonb_build_object('ok', false, 'error', 'not_eligible', 'audit', a);
  end if;
  perform set_config('amas.rpc_context', 'student', true);
  update public.student_records set status = 'graduated' where id = p_student;
  insert into public.student_status_history (student_id, from_status, to_status, actor_id, actor_role, student_visible_message)
  values (p_student, s.status, 'graduated', p_actor, 'admin', '恭喜毕业');
  insert into public.graduation_records (student_id, program_code, total_credits, gpa, graduated_on, audited_by)
  values (p_student, s.program_code, (a->>'credits_earned')::numeric, nullif(a->>'gpa', '')::numeric,
          coalesce(p_graduated_on, current_date), p_actor);
  perform public.sis_audit(p_actor, 'student_graduated', 'student_records', p_student::text,
    jsonb_build_object('status', s.status), a, null);
  return jsonb_build_object('ok', true, 'status', 'graduated');
end $$;

create or replace function public.sis_assign_mentor(p_student uuid, p_actor uuid, p_mentor uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if not public.is_admin_any(p_actor) then raise exception 'actor lacks admin role'; end if;
  if not exists (select 1 from public.student_records where id = p_student and status in ('active','on_leave')) then
    return jsonb_build_object('ok', false, 'error', 'not_active');
  end if;
  if not public.has_active_role(p_mentor, 'mentor') then
    return jsonb_build_object('ok', false, 'error', 'not_a_mentor');
  end if;
  begin
    insert into public.mentor_assignments (mentor_id, student_id, assigned_by) values (p_mentor, p_student, p_actor)
    returning id into v_id;
  exception when unique_violation then
    return jsonb_build_object('ok', false, 'error', 'already_assigned');
  end;
  perform public.sis_audit(p_actor, 'mentor_assigned', 'student_records', p_student::text, null,
    jsonb_build_object('mentor', p_mentor), null);
  return jsonb_build_object('ok', true, 'assignment_id', v_id);
end $$;

create or replace function public.sis_end_mentor(p_assignment uuid, p_actor uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare m public.mentor_assignments;
begin
  if not public.is_admin_any(p_actor) then raise exception 'actor lacks admin role'; end if;
  update public.mentor_assignments set ended_at = now(), ended_by = p_actor
   where id = p_assignment and ended_at is null returning * into m;
  if m.id is null then return jsonb_build_object('ok', false, 'error', 'not_assigned'); end if;
  perform public.sis_audit(p_actor, 'mentor_ended', 'student_records', m.student_id::text,
    jsonb_build_object('mentor', m.mentor_id), null, null);
  return jsonb_build_object('ok', true);
end $$;

do $$
declare f text;
begin
  foreach f in array array[
    'public.sis_publish_grades(uuid,uuid)', 'public.sis_return_grades(uuid,uuid,text)',
    'public.sis_decide_correction(uuid,uuid,boolean,text)', 'public.sis_graduate(uuid,uuid,date)',
    'public.sis_assign_mentor(uuid,uuid,uuid)', 'public.sis_end_mentor(uuid,uuid)',
    'public.sis_sync_course_credit(uuid,uuid,text)'
  ] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;
revoke execute on function public.student_course_net_credits(uuid,text) from public, anon, authenticated;
revoke execute on function public.student_gpa(uuid) from public, anon, authenticated;
revoke execute on function public.graduation_audit(uuid) from public, anon, authenticated;

-- 教务读模型
create or replace function public.admin_grade_queue()
returns table (offering_id uuid, title_zh text, academic_year text, section_label text, offering_status text,
               teachers text, enrolled bigint, drafts bigint, submitted bigint, published bigint)
language sql stable security definer set search_path = '' as $$
  select o.id, c.title_zh, o.academic_year, o.section_label, o.status,
         (select string_agg(coalesce(nullif(tp.public_name, ''), p.display_name), '、')
            from public.teacher_assignments t join public.profiles p on p.id = t.teacher_id
            left join public.teacher_profiles tp on tp.user_id = t.teacher_id
           where t.offering_id = o.id and t.removed_at is null),
         count(e.id) filter (where e.status = 'enrolled'),
         count(g.enrollment_id) filter (where g.status = 'draft'),
         count(g.enrollment_id) filter (where g.status = 'submitted'),
         count(g.enrollment_id) filter (where g.status = 'published')
  from public.course_offerings o
  join public.course_catalog c on c.code = o.course_code
  left join public.course_enrollments e on e.offering_id = o.id
  left join public.final_grades g on g.enrollment_id = e.id
  where public.is_admin_any(auth.uid()) and o.status in ('in_progress','completed')
  group by o.id, c.title_zh
  order by count(g.enrollment_id) filter (where g.status = 'submitted') desc, o.academic_year desc, c.title_zh;
$$;

create or replace function public.admin_offering_grades(p_offering uuid)
returns table (enrollment_id uuid, display_name text, student_number text, grade text, status text,
               comment text, returned_reason text, published_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select e.id, p.display_name, s.student_number, g.grade, coalesce(g.status, 'none'), g.comment, g.returned_reason, g.published_at
  from public.course_enrollments e
  join public.student_records s on s.id = e.student_id
  join public.profiles p on p.id = s.user_id
  left join public.final_grades g on g.enrollment_id = e.id
  where e.offering_id = p_offering and e.status = 'enrolled' and public.is_admin_any(auth.uid())
  order by p.display_name;
$$;

create or replace function public.admin_pending_corrections()
returns table (correction_id uuid, title_zh text, academic_year text, display_name text, student_number text,
               from_grade text, to_grade text, reason text, requested_by_name text, requested_by uuid, requested_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select gc.id, c.title_zh, o.academic_year, p.display_name, s.student_number, gc.from_grade, gc.to_grade, gc.reason,
         rp.display_name, gc.requested_by, gc.requested_at
  from public.grade_corrections gc
  join public.course_enrollments e on e.id = gc.enrollment_id
  join public.course_offerings o on o.id = e.offering_id
  join public.course_catalog c on c.code = o.course_code
  join public.student_records s on s.id = e.student_id
  join public.profiles p on p.id = s.user_id
  left join public.profiles rp on rp.id = gc.requested_by
  where gc.status = 'pending' and public.is_admin_any(auth.uid())
  order by gc.requested_at;
$$;

create or replace function public.admin_student_overview(p_student uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_admin_any(auth.uid()) then return null; end if;
  return public.graduation_audit(p_student) || jsonb_build_object(
    'mentors', coalesce((select jsonb_agg(jsonb_build_object('assignment_id', m.id, 'mentor_id', m.mentor_id,
                   'name', p.display_name, 'started_at', m.started_at) order by m.started_at)
              from public.mentor_assignments m join public.profiles p on p.id = m.mentor_id
             where m.student_id = p_student and m.ended_at is null), '[]'::jsonb),
    'graduation', (select to_jsonb(g) - 'audited_by' from public.graduation_records g where g.student_id = p_student));
end $$;

create or replace function public.admin_list_mentors()
returns table (user_id uuid, name text)
language sql stable security definer set search_path = '' as $$
  select p.id, coalesce(nullif(tp.public_name, ''), p.display_name)
  from public.profiles p left join public.teacher_profiles tp on tp.user_id = p.id
  where public.has_active_role(p.id, 'mentor') and public.is_admin_any(auth.uid())
  order by 2;
$$;

-- ============================================================
-- 9. 学员 RPC（authenticated；只读本人；实践训练自报）
-- ============================================================
create or replace function public.my_student_id()
returns uuid language sql stable security definer set search_path = '' as $$
  select s.id from public.student_records s
   where s.user_id = auth.uid() and public.has_active_role(auth.uid(), 'student');
$$;
revoke execute on function public.my_student_id() from public, anon, authenticated;

create or replace function public.my_grades()
returns table (offering_id uuid, course_code text, title_zh text, credits numeric, academic_year text,
               grade text, points numeric, passing boolean, published_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select o.id, o.course_code, c.title_zh, c.credits, o.academic_year, g.grade, gs.points, gs.passing, g.published_at
  from public.final_grades g
  join public.course_enrollments e on e.id = g.enrollment_id
  join public.course_offerings o on o.id = e.offering_id
  join public.course_catalog c on c.code = o.course_code
  join public.grade_scale gs on gs.letter = g.grade
  where e.student_id = public.my_student_id() and g.status = 'published'
  order by g.published_at desc;
$$;

create or replace function public.my_course_detail(p_offering uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_e public.course_enrollments;
begin
  select * into v_e from public.course_enrollments
   where offering_id = p_offering and student_id = public.my_student_id();
  if not found then return null; end if;
  return jsonb_build_object(
    'attendance', coalesce((select jsonb_agg(jsonb_build_object('held_on', cs.held_on, 'topic', cs.topic,
        'materials_url', cs.materials_url, 'status', a.status) order by cs.held_on desc)
      from public.class_sessions cs left join public.attendance_records a
        on a.session_id = cs.id and a.enrollment_id = v_e.id
      where cs.offering_id = p_offering), '[]'::jsonb),
    'assignments', coalesce((select jsonb_agg(jsonb_build_object('title', x.title, 'description', x.description,
        'due_on', x.due_on, 'weight', x.weight, 'grade', sc.grade, 'comment', sc.comment) order by x.due_on nulls last)
      from public.assignments x left join public.assignment_scores sc
        on sc.assignment_id = x.id and sc.enrollment_id = v_e.id
      where x.offering_id = p_offering), '[]'::jsonb),
    'final_grade', (select g.grade from public.final_grades g where g.enrollment_id = v_e.id and g.status = 'published'));
end $$;

create or replace function public.my_progress()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v uuid := public.my_student_id();
begin
  if v is null then return null; end if;
  return public.graduation_audit(v);
end $$;

create or replace function public.report_practicum(p_item text, p_completed_on date, p_note text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_sid uuid := public.my_student_id(); s public.student_records; i public.practicum_items; r public.practicum_reports;
begin
  if v_sid is null then return jsonb_build_object('ok', false, 'error', 'not_a_student'); end if;
  select * into s from public.student_records where id = v_sid;
  if s.status not in ('active','on_leave') then return jsonb_build_object('ok', false, 'error', 'invalid_state'); end if;
  select * into i from public.practicum_items where code = p_item and program_code = s.program_code;
  if not found then return jsonb_build_object('ok', false, 'error', 'unknown_item'); end if;
  if p_completed_on is null or p_completed_on > current_date then
    return jsonb_build_object('ok', false, 'error', 'bad_date');
  end if;
  select * into r from public.practicum_reports where student_id = v_sid and item_code = p_item for update;
  if found and r.retracted_at is null then
    update public.practicum_reports set completed_on = p_completed_on, note = nullif(left(trim(coalesce(p_note, '')), 1000), '')
     where student_id = v_sid and item_code = p_item;
    return jsonb_build_object('ok', true, 'credits_added', 0);
  end if;
  insert into public.practicum_reports (student_id, item_code, completed_on, note)
  values (v_sid, p_item, p_completed_on, nullif(left(trim(coalesce(p_note, '')), 1000), ''))
  on conflict (student_id, item_code) do update
    set completed_on = excluded.completed_on, note = excluded.note, reported_at = now(), retracted_at = null;
  insert into public.credit_ledger (student_id, source, practicum_code, credits, reason, created_by)
  values (v_sid, 'practicum', p_item, i.credits, '学员自报完成', auth.uid());
  perform public.sis_audit(auth.uid(), 'practicum_reported', 'student_records', v_sid::text, null,
    jsonb_build_object('item', p_item, 'completed_on', p_completed_on), null);
  return jsonb_build_object('ok', true, 'credits_added', i.credits);
end $$;

create or replace function public.retract_practicum(p_item text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_sid uuid := public.my_student_id(); s public.student_records; i public.practicum_items; r public.practicum_reports;
begin
  if v_sid is null then return jsonb_build_object('ok', false, 'error', 'not_a_student'); end if;
  select * into s from public.student_records where id = v_sid;
  if s.status not in ('active','on_leave') then return jsonb_build_object('ok', false, 'error', 'invalid_state'); end if;
  select * into r from public.practicum_reports where student_id = v_sid and item_code = p_item for update;
  if not found or r.retracted_at is not null then return jsonb_build_object('ok', false, 'error', 'not_reported'); end if;
  select * into i from public.practicum_items where code = p_item;
  update public.practicum_reports set retracted_at = now() where student_id = v_sid and item_code = p_item;
  insert into public.credit_ledger (student_id, source, practicum_code, credits, reason, created_by)
  values (v_sid, 'practicum', p_item, -i.credits, '学员撤回', auth.uid());
  perform public.sis_audit(auth.uid(), 'practicum_retracted', 'student_records', v_sid::text,
    jsonb_build_object('item', p_item), null, null);
  return jsonb_build_object('ok', true);
end $$;

-- ============================================================
-- 10. 导师
-- ============================================================
create or replace function public.is_assigned_mentor(p_mentor uuid, p_student uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select public.has_active_role(p_mentor, 'mentor')
     and exists (select 1 from public.mentor_assignments m
                  where m.mentor_id = p_mentor and m.student_id = p_student and m.ended_at is null);
$$;
comment on function public.is_assigned_mentor is '导师是否在带这名学员：须持有效 mentor 角色。0032 起查 mentor_assignments。';

create or replace function public.my_mentees()
returns table (student_id uuid, display_name text, student_number text, status text, program_code text,
               credits_earned numeric, credits_required numeric, gpa numeric)
language sql stable security definer set search_path = '' as $$
  select s.id, p.display_name, s.student_number, s.status::text, s.program_code,
         (select coalesce(sum(credits), 0) from public.credit_ledger c where c.student_id = s.id),
         pc.credits_required, public.student_gpa(s.id)
  from public.mentor_assignments m
  join public.student_records s on s.id = m.student_id
  join public.profiles p on p.id = s.user_id
  left join public.program_catalog pc on pc.code = s.program_code
  where m.mentor_id = auth.uid() and m.ended_at is null and public.has_active_role(auth.uid(), 'mentor')
  order by p.display_name;
$$;

create or replace function public.mentee_detail(p_student uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_assigned_mentor(auth.uid(), p_student) then return null; end if;
  return public.graduation_audit(p_student) || jsonb_build_object(
    'courses', coalesce((select jsonb_agg(jsonb_build_object('title_zh', c.title_zh, 'academic_year', o.academic_year,
          'offering_status', o.status,
          'grade', (select g.grade from public.final_grades g where g.enrollment_id = e.id and g.status = 'published'))
          order by o.starts_on nulls last)
        from public.course_enrollments e join public.course_offerings o on o.id = e.offering_id
        join public.course_catalog c on c.code = o.course_code
        where e.student_id = p_student and e.status = 'enrolled'), '[]'::jsonb),
    'notes', coalesce((select jsonb_agg(jsonb_build_object('body', n.body, 'created_at', n.created_at,
          'mine', n.mentor_id = auth.uid()) order by n.created_at desc)
        from public.mentor_notes n where n.student_id = p_student and n.mentor_id = auth.uid()), '[]'::jsonb));
end $$;

create or replace function public.mentor_add_note(p_student uuid, p_body text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if not public.request_is_aal2() then return jsonb_build_object('ok', false, 'error', 'mfa_required'); end if;
  if not public.is_assigned_mentor(auth.uid(), p_student) then return jsonb_build_object('ok', false, 'error', 'not_assigned'); end if;
  if coalesce(trim(p_body), '') = '' or char_length(p_body) > 4000 then
    return jsonb_build_object('ok', false, 'error', 'bad_request');
  end if;
  insert into public.mentor_notes (mentor_id, student_id, body) values (auth.uid(), p_student, trim(p_body))
  returning id into v_id;
  perform public.sis_audit(auth.uid(), 'mentor_note_added', 'student_records', p_student::text, null, null, null);
  return jsonb_build_object('ok', true, 'note_id', v_id);
end $$;

do $$
declare f text;
begin
  foreach f in array array[
    'public.admin_grade_queue()', 'public.admin_offering_grades(uuid)', 'public.admin_pending_corrections()',
    'public.admin_student_overview(uuid)', 'public.admin_list_mentors()',
    'public.my_grades()', 'public.my_course_detail(uuid)', 'public.my_progress()',
    'public.report_practicum(text,date,text)', 'public.retract_practicum(text)',
    'public.my_mentees()', 'public.mentee_detail(uuid)', 'public.mentor_add_note(uuid,text)'
  ] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
