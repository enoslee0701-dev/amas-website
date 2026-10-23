-- ============================================================
-- 0030_sis_offerings_enrollment · 学员管理系统第一期：学籍状态 / 课程班 / 排教授 / 编班
--
-- 依据：《AMAS 学员管理系统策划书与开发文档》第一期（M1–M3），Enos 2026-10-23 批准开工，
-- 同日拍板：不设固定学期，按「学年 + 课程班」管理；由教务编班，学员暂不自选。
--
-- 硬规则（沿用 0012 的做法）：
--   1. 客户端对三张新表一律不可写；所有写入走 service_role RPC（由 Edge Function 校验角色 + aal2 后调用）。
--   2. 每个写操作同事务写 audit_logs。
--   3. 学籍状态迁移仍由 student_guard 白名单把关；新增 active⇄on_leave、→withdrawn。
--   4. 教授只看自己所授课程班；学员只看自己的；教授拿不到学员联系方式。
--   5. 0002/0003 的三个 fail-closed 占位函数，其中两个在此换成查真表；导师（mentor）留到第四期。
-- ============================================================

-- ============================================================
-- 1. 学籍状态机：在 0012 白名单上扩展
-- ============================================================
create or replace function public.student_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  in_rpc boolean := coalesce(current_setting('amas.rpc_context', true), '') = 'student';
begin
  if in_rpc then perform set_config('amas.rpc_context', '', true); end if;   -- 用后即焚
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

-- ============================================================
-- 2. 课程班 / 教授指派 / 编班
-- ============================================================
create table if not exists public.course_offerings (
  id             uuid primary key default gen_random_uuid(),
  course_code    text not null references public.course_catalog(code),
  academic_year  text not null,
  section_label  text,
  delivery_mode  text not null default 'online',
  starts_on      date,
  ends_on        date,
  schedule_note  text,
  capacity       integer,
  status         text not null default 'planned',
  created_by     uuid references public.profiles(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint co_year_format check (
    academic_year ~ '^[0-9]{4}-[0-9]{4}$'
    and substr(academic_year, 6, 4)::int = substr(academic_year, 1, 4)::int + 1),
  constraint co_mode check (delivery_mode in ('online','onsite','hybrid')),
  constraint co_status check (status in ('planned','in_progress','completed','cancelled')),
  constraint co_dates check (starts_on is null or ends_on is null or ends_on >= starts_on),
  constraint co_capacity check (capacity is null or capacity > 0),
  constraint co_schedule_len check (schedule_note is null or char_length(schedule_note) <= 200),
  constraint co_section_len check (section_label is null or char_length(section_label) <= 40)
);
comment on table public.course_offerings is
  '课程班：某学年开出的某门课。不设固定学期，每班自带起止日期与上课安排（0030）。';
create unique index if not exists co_unique_section
  on public.course_offerings (course_code, academic_year, coalesce(section_label, ''));
create index if not exists co_by_year on public.course_offerings (academic_year, status);

drop trigger if exists co_set_updated_at on public.course_offerings;
create trigger co_set_updated_at before update on public.course_offerings
  for each row execute function public.set_updated_at();

create table if not exists public.teacher_assignments (
  id           uuid primary key default gen_random_uuid(),
  offering_id  uuid not null references public.course_offerings(id),
  teacher_id   uuid not null references public.profiles(id),
  role         text not null default 'lead',
  assigned_by  uuid references public.profiles(id) on delete set null,
  assigned_at  timestamptz not null default now(),
  removed_at   timestamptz,
  removed_by   uuid references public.profiles(id) on delete set null,
  constraint ta_role check (role in ('lead','assistant'))
);
create unique index if not exists ta_one_active
  on public.teacher_assignments (offering_id, teacher_id) where removed_at is null;
create index if not exists ta_by_teacher on public.teacher_assignments (teacher_id) where removed_at is null;

create table if not exists public.course_enrollments (
  id           uuid primary key default gen_random_uuid(),
  offering_id  uuid not null references public.course_offerings(id),
  student_id   uuid not null references public.student_records(id),
  status       text not null default 'enrolled',
  enrolled_by  uuid references public.profiles(id) on delete set null,
  enrolled_at  timestamptz not null default now(),
  dropped_at   timestamptz,
  dropped_by   uuid references public.profiles(id) on delete set null,
  drop_reason  text,
  updated_at   timestamptz not null default now(),
  constraint ce_status check (status in ('enrolled','dropped')),
  constraint ce_unique unique (offering_id, student_id)
);
create index if not exists ce_by_student on public.course_enrollments (student_id, status);

drop trigger if exists ce_set_updated_at on public.course_enrollments;
create trigger ce_set_updated_at before update on public.course_enrollments
  for each row execute function public.set_updated_at();

-- R-8：编班不是正式学业记录（可退选），成绩表在第二期登记为 yes
insert into public.irreversible_record_sources
  (source_key, table_name, record_kind, is_irreversible, check_sql, rationale, registered_by)
values
  ('course_enrollments', 'course_enrollments', 'other', 'no', null,
   '编班可由教务退选撤回，本身不产生成绩或学分；成绩与学分表在第二、三期单独登记为不可逆记录。', '0030')
on conflict (source_key) do nothing;

-- ============================================================
-- 3. 访问判断：占位函数换成查真表
-- ============================================================
create or replace function public.is_assigned_teacher(p_user uuid, p_offering uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select public.has_active_role(p_user, 'teacher')
     and exists (select 1 from public.teacher_assignments t
                  where t.offering_id = p_offering and t.teacher_id = p_user and t.removed_at is null);
$$;
comment on function public.is_assigned_teacher is
  '教授是否在该课程班任教：须同时持有有效 teacher 角色（停职即失权）。0030 起查 teacher_assignments。';

create or replace function public.is_enrolled_student(p_user uuid, p_offering uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select public.has_active_role(p_user, 'student')
     and exists (select 1 from public.course_enrollments e
                   join public.student_records s on s.id = e.student_id
                  where e.offering_id = p_offering and e.status = 'enrolled' and s.user_id = p_user);
$$;
comment on function public.is_enrolled_student is
  '学员是否在该课程班：须持有有效 student 角色且编班状态为 enrolled。0030 起查 course_enrollments。';

-- ============================================================
-- 4. RLS：客户端只读，且只读到自己有关的
-- ============================================================
alter table public.course_offerings    enable row level security;
alter table public.teacher_assignments enable row level security;
alter table public.course_enrollments  enable row level security;

revoke insert, update, delete on public.course_offerings    from anon, authenticated;
revoke insert, update, delete on public.teacher_assignments from anon, authenticated;
revoke insert, update, delete on public.course_enrollments  from anon, authenticated;
revoke all on public.course_offerings, public.teacher_assignments, public.course_enrollments from anon;
-- 显式授读：不依赖 Supabase 的默认授权，行级可见范围仍由下面的策略决定
grant select on public.course_offerings, public.teacher_assignments, public.course_enrollments to authenticated;

drop policy if exists co_select on public.course_offerings;
create policy co_select on public.course_offerings for select to authenticated using (
  public.is_admin_any(auth.uid())
  or public.is_assigned_teacher(auth.uid(), id)
  or public.is_enrolled_student(auth.uid(), id));

drop policy if exists ta_select on public.teacher_assignments;
create policy ta_select on public.teacher_assignments for select to authenticated using (
  public.is_admin_any(auth.uid())
  or (teacher_id = auth.uid() and public.has_active_role(auth.uid(), 'teacher')));

drop policy if exists ce_select on public.course_enrollments;
create policy ce_select on public.course_enrollments for select to authenticated using (
  public.is_admin_any(auth.uid())
  or public.is_assigned_teacher(auth.uid(), offering_id)
  or (public.has_active_role(auth.uid(), 'student')
      and exists (select 1 from public.student_records s
                   where s.id = student_id and s.user_id = auth.uid())));

-- ============================================================
-- 5. 服务端写入 RPC（service_role；Edge 已校验角色 + aal2，此处再验一次）
-- ============================================================
create or replace function public.sis_audit(
  p_actor uuid, p_event text, p_target_type text, p_target text,
  p_old jsonb, p_new jsonb, p_reason text
) returns void language sql security definer set search_path = '' as $$
  insert into public.audit_logs (actor_id, actor_role, event_type, target_type, target_id, category,
                                 old_value, new_value, reason)
  values (p_actor, 'admin', p_event, p_target_type, p_target, 'academic', p_old, p_new, p_reason);
$$;
revoke execute on function public.sis_audit(uuid,text,text,text,jsonb,jsonb,text) from public, anon, authenticated;

-- 5.1 学籍状态：休学 / 复学 / 退学（pre_enrolled → active 仍走 0012 的 activate_student）
create or replace function public.sis_change_student_status(
  p_student uuid, p_actor uuid, p_to text, p_reason text, p_message text default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare s public.student_records; v_to public.student_status; v_dropped int := 0;
begin
  if not public.is_admin_any(p_actor) then raise exception 'actor lacks admin role'; end if;
  if p_to not in ('on_leave','active','withdrawn') then
    return jsonb_build_object('ok', false, 'error', 'bad_target');
  end if;
  if coalesce(trim(p_reason), '') = '' then
    return jsonb_build_object('ok', false, 'error', 'reason_required');
  end if;
  v_to := p_to::public.student_status;

  select * into s from public.student_records where id = p_student for update;
  if not found then raise exception 'not_found'; end if;
  if s.status = v_to then
    return jsonb_build_object('ok', false, 'error', 'unchanged', 'status', s.status);
  end if;
  if s.status = 'pre_enrolled' and v_to = 'active' then
    return jsonb_build_object('ok', false, 'error', 'use_activate', 'status', s.status);
  end if;
  if not (
       (s.status = 'active' and v_to = 'on_leave')
    or (s.status = 'on_leave' and v_to = 'active')
    or (s.status in ('pre_enrolled','active','on_leave') and v_to = 'withdrawn')
  ) then
    return jsonb_build_object('ok', false, 'error', 'invalid_state', 'status', s.status);
  end if;

  perform set_config('amas.rpc_context', 'student', true);
  update public.student_records set status = v_to where id = p_student;

  insert into public.student_status_history
    (student_id, from_status, to_status, actor_id, actor_role, student_visible_message, internal_note)
  values (p_student, s.status, v_to, p_actor, 'admin', p_message, p_reason);

  -- 退学：退出所有在读课程班，并撤销 student 角色（别名随 0012 的触发器同步撤销，即时失权）
  if v_to = 'withdrawn' then
    update public.course_enrollments
       set status = 'dropped', dropped_at = now(), dropped_by = p_actor, drop_reason = '学籍退学'
     where student_id = p_student and status = 'enrolled';
    get diagnostics v_dropped = row_count;
    update public.user_roles set revoked_at = now()
     where user_id = s.user_id and role = 'student' and revoked_at is null;
  end if;

  perform public.sis_audit(p_actor, 'student_status_changed', 'student_records', p_student::text,
    jsonb_build_object('status', s.status),
    jsonb_build_object('status', v_to, 'enrollments_dropped', v_dropped), p_reason);
  return jsonb_build_object('ok', true, 'status', v_to, 'enrollments_dropped', v_dropped);
end $$;

-- 5.2 开课
create or replace function public.sis_create_offering(
  p_actor uuid, p_course_code text, p_academic_year text,
  p_delivery_mode text default 'online', p_starts_on date default null, p_ends_on date default null,
  p_schedule_note text default null, p_section_label text default null, p_capacity integer default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if not public.is_admin_any(p_actor) then raise exception 'actor lacks admin role'; end if;
  if not exists (select 1 from public.course_catalog where code = p_course_code) then
    return jsonb_build_object('ok', false, 'error', 'unknown_course');
  end if;
  begin
    insert into public.course_offerings
      (course_code, academic_year, section_label, delivery_mode, starts_on, ends_on,
       schedule_note, capacity, created_by)
    values (p_course_code, p_academic_year, nullif(trim(p_section_label), ''), coalesce(p_delivery_mode, 'online'),
            p_starts_on, p_ends_on, nullif(trim(p_schedule_note), ''), p_capacity, p_actor)
    returning id into v_id;
  exception
    when unique_violation then return jsonb_build_object('ok', false, 'error', 'offering_exists');
    when check_violation then return jsonb_build_object('ok', false, 'error', 'invalid_fields');
  end;
  perform public.sis_audit(p_actor, 'offering_created', 'course_offerings', v_id::text, null,
    jsonb_build_object('course', p_course_code, 'year', p_academic_year, 'section', p_section_label,
                       'mode', p_delivery_mode, 'starts_on', p_starts_on, 'ends_on', p_ends_on), null);
  return jsonb_build_object('ok', true, 'offering_id', v_id);
end $$;

-- 5.3 改课程班资料（已结课 / 已取消的不可再改）
create or replace function public.sis_update_offering(
  p_offering uuid, p_actor uuid, p_delivery_mode text, p_starts_on date, p_ends_on date,
  p_schedule_note text, p_section_label text, p_capacity integer
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare o public.course_offerings; v_count int;
begin
  if not public.is_admin_any(p_actor) then raise exception 'actor lacks admin role'; end if;
  select * into o from public.course_offerings where id = p_offering for update;
  if not found then raise exception 'not_found'; end if;
  if o.status in ('completed','cancelled') then
    return jsonb_build_object('ok', false, 'error', 'invalid_state', 'status', o.status);
  end if;
  if p_capacity is not null then
    select count(*) into v_count from public.course_enrollments
     where offering_id = p_offering and status = 'enrolled';
    if v_count > p_capacity then
      return jsonb_build_object('ok', false, 'error', 'capacity_below_enrolled', 'enrolled', v_count);
    end if;
  end if;
  begin
    update public.course_offerings
       set delivery_mode = coalesce(p_delivery_mode, delivery_mode), starts_on = p_starts_on, ends_on = p_ends_on,
           schedule_note = nullif(trim(p_schedule_note), ''), section_label = nullif(trim(p_section_label), ''),
           capacity = p_capacity
     where id = p_offering;
  exception
    when unique_violation then return jsonb_build_object('ok', false, 'error', 'offering_exists');
    when check_violation then return jsonb_build_object('ok', false, 'error', 'invalid_fields');
  end;
  perform public.sis_audit(p_actor, 'offering_updated', 'course_offerings', p_offering::text,
    jsonb_build_object('mode', o.delivery_mode, 'starts_on', o.starts_on, 'ends_on', o.ends_on,
                       'schedule', o.schedule_note, 'section', o.section_label, 'capacity', o.capacity),
    jsonb_build_object('mode', p_delivery_mode, 'starts_on', p_starts_on, 'ends_on', p_ends_on,
                       'schedule', p_schedule_note, 'section', p_section_label, 'capacity', p_capacity), null);
  return jsonb_build_object('ok', true);
end $$;

-- 5.4 课程班状态：planned → in_progress → completed；未结课的可取消
create or replace function public.sis_set_offering_status(
  p_offering uuid, p_actor uuid, p_status text, p_reason text default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare o public.course_offerings;
begin
  if not public.is_admin_any(p_actor) then raise exception 'actor lacks admin role'; end if;
  select * into o from public.course_offerings where id = p_offering for update;
  if not found then raise exception 'not_found'; end if;
  if not (
       (o.status = 'planned' and p_status = 'in_progress')
    or (o.status = 'in_progress' and p_status = 'completed')
    or (o.status in ('planned','in_progress') and p_status = 'cancelled')
  ) then
    return jsonb_build_object('ok', false, 'error', 'invalid_state', 'status', o.status);
  end if;
  if p_status = 'cancelled' and coalesce(trim(p_reason), '') = '' then
    return jsonb_build_object('ok', false, 'error', 'reason_required');
  end if;
  update public.course_offerings set status = p_status where id = p_offering;
  perform public.sis_audit(p_actor, 'offering_status_changed', 'course_offerings', p_offering::text,
    jsonb_build_object('status', o.status), jsonb_build_object('status', p_status), p_reason);
  return jsonb_build_object('ok', true, 'status', p_status);
end $$;

-- 5.5 排教授 / 撤下教授
create or replace function public.sis_assign_teacher(
  p_offering uuid, p_actor uuid, p_teacher uuid, p_role text default 'lead'
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare o public.course_offerings; v_id uuid;
begin
  if not public.is_admin_any(p_actor) then raise exception 'actor lacks admin role'; end if;
  if coalesce(p_role, '') not in ('lead','assistant') then
    return jsonb_build_object('ok', false, 'error', 'bad_role');
  end if;
  select * into o from public.course_offerings where id = p_offering for update;
  if not found then raise exception 'not_found'; end if;
  if o.status in ('completed','cancelled') then
    return jsonb_build_object('ok', false, 'error', 'invalid_state', 'status', o.status);
  end if;
  if not public.has_active_role(p_teacher, 'teacher') then
    return jsonb_build_object('ok', false, 'error', 'not_a_teacher');
  end if;
  if exists (select 1 from public.teacher_assignments
              where offering_id = p_offering and teacher_id = p_teacher and removed_at is null) then
    return jsonb_build_object('ok', false, 'error', 'already_assigned');
  end if;
  insert into public.teacher_assignments (offering_id, teacher_id, role, assigned_by)
  values (p_offering, p_teacher, p_role, p_actor) returning id into v_id;
  perform public.sis_audit(p_actor, 'teacher_assigned', 'course_offerings', p_offering::text, null,
    jsonb_build_object('teacher', p_teacher, 'role', p_role), null);
  return jsonb_build_object('ok', true, 'assignment_id', v_id);
end $$;

create or replace function public.sis_remove_teacher(
  p_offering uuid, p_actor uuid, p_teacher uuid, p_reason text default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_n int;
begin
  if not public.is_admin_any(p_actor) then raise exception 'actor lacks admin role'; end if;
  update public.teacher_assignments set removed_at = now(), removed_by = p_actor
   where offering_id = p_offering and teacher_id = p_teacher and removed_at is null;
  get diagnostics v_n = row_count;
  if v_n = 0 then return jsonb_build_object('ok', false, 'error', 'not_assigned'); end if;
  perform public.sis_audit(p_actor, 'teacher_removed', 'course_offerings', p_offering::text,
    jsonb_build_object('teacher', p_teacher), null, p_reason);
  return jsonb_build_object('ok', true);
end $$;

-- 5.6 编班（批量）：只有「在读」学员能编入；重复的跳过并说明原因，不整批失败
create or replace function public.sis_enroll_students(
  p_offering uuid, p_actor uuid, p_students uuid[]
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  o public.course_offerings; sid uuid; s public.student_records; e public.course_enrollments;
  v_count int; v_added uuid[] := '{}'; v_skipped jsonb := '[]'::jsonb;
begin
  if not public.is_admin_any(p_actor) then raise exception 'actor lacks admin role'; end if;
  if p_students is null or cardinality(p_students) = 0 then
    return jsonb_build_object('ok', false, 'error', 'no_students');
  end if;
  if cardinality(p_students) > 200 then
    return jsonb_build_object('ok', false, 'error', 'too_many');
  end if;
  select * into o from public.course_offerings where id = p_offering for update;
  if not found then raise exception 'not_found'; end if;
  if o.status not in ('planned','in_progress') then
    return jsonb_build_object('ok', false, 'error', 'invalid_state', 'status', o.status);
  end if;
  select count(*) into v_count from public.course_enrollments
   where offering_id = p_offering and status = 'enrolled';

  foreach sid in array (select array_agg(distinct x) from unnest(p_students) x) loop
    select * into s from public.student_records where id = sid;
    if not found then
      v_skipped := v_skipped || jsonb_build_object('student_id', sid, 'reason', 'not_found'); continue;
    end if;
    if s.status <> 'active' then
      v_skipped := v_skipped || jsonb_build_object('student_id', sid, 'reason', 'not_active', 'status', s.status); continue;
    end if;
    if o.capacity is not null and v_count >= o.capacity then
      v_skipped := v_skipped || jsonb_build_object('student_id', sid, 'reason', 'full'); continue;
    end if;
    select * into e from public.course_enrollments where offering_id = p_offering and student_id = sid for update;
    if found and e.status = 'enrolled' then
      v_skipped := v_skipped || jsonb_build_object('student_id', sid, 'reason', 'already_enrolled'); continue;
    end if;
    if found then
      update public.course_enrollments
         set status = 'enrolled', enrolled_by = p_actor, enrolled_at = now(),
             dropped_at = null, dropped_by = null, drop_reason = null
       where id = e.id;
    else
      insert into public.course_enrollments (offering_id, student_id, enrolled_by)
      values (p_offering, sid, p_actor);
    end if;
    v_count := v_count + 1;
    v_added := v_added || sid;
  end loop;

  if cardinality(v_added) > 0 then
    perform public.sis_audit(p_actor, 'students_enrolled', 'course_offerings', p_offering::text, null,
      jsonb_build_object('students', to_jsonb(v_added)), null);
  end if;
  return jsonb_build_object('ok', true, 'enrolled', cardinality(v_added), 'skipped', v_skipped);
end $$;

-- 5.7 退选（必须写原因）
create or replace function public.sis_drop_enrollment(
  p_enrollment uuid, p_actor uuid, p_reason text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare e public.course_enrollments;
begin
  if not public.is_admin_any(p_actor) then raise exception 'actor lacks admin role'; end if;
  if coalesce(trim(p_reason), '') = '' then
    return jsonb_build_object('ok', false, 'error', 'reason_required');
  end if;
  select * into e from public.course_enrollments where id = p_enrollment for update;
  if not found then raise exception 'not_found'; end if;
  if e.status <> 'enrolled' then
    return jsonb_build_object('ok', false, 'error', 'invalid_state', 'status', e.status);
  end if;
  update public.course_enrollments
     set status = 'dropped', dropped_at = now(), dropped_by = p_actor, drop_reason = p_reason
   where id = p_enrollment;
  perform public.sis_audit(p_actor, 'enrollment_dropped', 'course_enrollments', p_enrollment::text,
    jsonb_build_object('status', 'enrolled', 'offering', e.offering_id, 'student', e.student_id),
    jsonb_build_object('status', 'dropped'), p_reason);
  return jsonb_build_object('ok', true);
end $$;

do $$
declare f text;
begin
  foreach f in array array[
    'public.sis_change_student_status(uuid,uuid,text,text,text)',
    'public.sis_create_offering(uuid,text,text,text,date,date,text,text,integer)',
    'public.sis_update_offering(uuid,uuid,text,date,date,text,text,integer)',
    'public.sis_set_offering_status(uuid,uuid,text,text)',
    'public.sis_assign_teacher(uuid,uuid,uuid,text)',
    'public.sis_remove_teacher(uuid,uuid,uuid,text)',
    'public.sis_enroll_students(uuid,uuid,uuid[])',
    'public.sis_drop_enrollment(uuid,uuid,text)'
  ] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;

-- ============================================================
-- 6. 读模型 RPC（authenticated；定义者权限下自行复核调用者）
-- ============================================================

-- 6.1 学员：我的课程
create or replace function public.my_courses()
returns table (
  offering_id uuid, course_code text, title_zh text, credits numeric, academic_year text,
  section_label text, delivery_mode text, starts_on date, ends_on date, schedule_note text,
  offering_status text, teachers text
) language sql stable security definer set search_path = '' as $$
  select o.id, o.course_code, c.title_zh, c.credits, o.academic_year, o.section_label, o.delivery_mode,
         o.starts_on, o.ends_on, o.schedule_note, o.status,
         (select string_agg(coalesce(nullif(tp.public_name, ''), p.display_name), '、' order by t.role, t.assigned_at)
            from public.teacher_assignments t
            join public.profiles p on p.id = t.teacher_id
            left join public.teacher_profiles tp on tp.user_id = t.teacher_id
           where t.offering_id = o.id and t.removed_at is null)
  from public.course_enrollments e
  join public.student_records s on s.id = e.student_id
  join public.course_offerings o on o.id = e.offering_id
  join public.course_catalog c on c.code = o.course_code
  where s.user_id = auth.uid() and e.status = 'enrolled'
    and public.has_active_role(auth.uid(), 'student')
  order by o.starts_on nulls last, c.title_zh;
$$;

-- 6.2 教授：我任教的课程班
create or replace function public.my_teaching()
returns table (
  offering_id uuid, course_code text, title_zh text, academic_year text, section_label text,
  delivery_mode text, starts_on date, ends_on date, schedule_note text, offering_status text,
  my_role text, enrolled_count bigint
) language sql stable security definer set search_path = '' as $$
  select o.id, o.course_code, c.title_zh, o.academic_year, o.section_label, o.delivery_mode,
         o.starts_on, o.ends_on, o.schedule_note, o.status, t.role,
         (select count(*) from public.course_enrollments e where e.offering_id = o.id and e.status = 'enrolled')
  from public.teacher_assignments t
  join public.course_offerings o on o.id = t.offering_id
  join public.course_catalog c on c.code = o.course_code
  where t.teacher_id = auth.uid() and t.removed_at is null
    and public.has_active_role(auth.uid(), 'teacher')
  order by o.starts_on nulls last, c.title_zh;
$$;

-- 6.3 课程班名单：任课教授与教务可看；只给姓名与学号，不给联系方式
create or replace function public.offering_roster(p_offering uuid)
returns table (enrollment_id uuid, student_id uuid, display_name text, student_number text,
               student_status text, enrollment_status text, enrolled_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select e.id, s.id, p.display_name, s.student_number, s.status::text, e.status, e.enrolled_at
  from public.course_enrollments e
  join public.student_records s on s.id = e.student_id
  join public.profiles p on p.id = s.user_id
  where e.offering_id = p_offering
    and (public.is_admin_any(auth.uid())
         or (public.is_assigned_teacher(auth.uid(), p_offering) and e.status = 'enrolled'))
  order by e.status, p.display_name;
$$;

-- 6.4 教务：课程班总览
create or replace function public.admin_list_offerings(p_year text default null)
returns table (
  offering_id uuid, course_code text, title_zh text, level text, credits numeric, academic_year text,
  section_label text, delivery_mode text, starts_on date, ends_on date, schedule_note text,
  capacity integer, offering_status text, teachers jsonb, enrolled_count bigint
) language sql stable security definer set search_path = '' as $$
  select o.id, o.course_code, c.title_zh, c.level, c.credits, o.academic_year, o.section_label,
         o.delivery_mode, o.starts_on, o.ends_on, o.schedule_note, o.capacity, o.status,
         coalesce((select jsonb_agg(jsonb_build_object(
                    'teacher_id', t.teacher_id, 'role', t.role,
                    'name', coalesce(nullif(tp.public_name, ''), p.display_name)) order by t.role, t.assigned_at)
                   from public.teacher_assignments t
                   join public.profiles p on p.id = t.teacher_id
                   left join public.teacher_profiles tp on tp.user_id = t.teacher_id
                  where t.offering_id = o.id and t.removed_at is null), '[]'::jsonb),
         (select count(*) from public.course_enrollments e where e.offering_id = o.id and e.status = 'enrolled')
  from public.course_offerings o
  join public.course_catalog c on c.code = o.course_code
  where public.is_admin_any(auth.uid())
    and (p_year is null or o.academic_year = p_year)
  order by o.academic_year desc, o.starts_on nulls last, c.title_zh;
$$;

-- 6.5 教务：可排课的教授（有效 teacher 角色）
create or replace function public.admin_list_teachers()
returns table (user_id uuid, name text, staff_number text, profile_status text)
language sql stable security definer set search_path = '' as $$
  select p.id, coalesce(nullif(tp.public_name, ''), p.display_name), tp.staff_number, tp.status::text
  from public.profiles p
  left join public.teacher_profiles tp on tp.user_id = p.id
  where public.has_active_role(p.id, 'teacher')
    and public.is_admin_any(auth.uid())
  order by 2;
$$;

-- 6.6 教务：学员名册（编班与学籍状态用）
create or replace function public.admin_list_students()
returns table (student_id uuid, user_id uuid, display_name text, student_number text,
               status text, program_code text, activated_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select s.id, s.user_id, p.display_name, s.student_number, s.status::text, s.program_code, s.activated_at
  from public.student_records s
  join public.profiles p on p.id = s.user_id
  where public.is_admin_any(auth.uid())
  order by s.status, p.display_name;
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'public.my_courses()', 'public.my_teaching()', 'public.offering_roster(uuid)',
    'public.admin_list_offerings(text)', 'public.admin_list_teachers()', 'public.admin_list_students()'
  ] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
