-- ============================================================
-- 0033_sis_transfer_transcript_roles · 学员管理系统补全
--   1. 外校转入学分：教务录入（可对应某门必修课 = 免修，或只记学分），可撤回；不计 GPA
--   2. 成绩单读模型：学员本人 / 教务
--   3. 课程班总览加授课次数与最近一次上课日期
--   4. 角色管理：super_admin 授予 / 撤销 registrar、academic_admin、mentor
--
-- Enos 2026-10-23：「做吧都做全，最后我检查」。
-- 政策未定、按默认值先做（program_catalog 列，可改）：转入学分上限 max_transfer_credits 默认不设（null）。
-- 角色管理属权限类改动：只限 super_admin + aal2（Edge 校验），不能改自己，不能授予 super_admin、
-- teacher（教授走认证流程）、student / applicant（走招生与建档流程）；每次授予 / 撤销写审计。
-- ============================================================

-- ============================================================
-- 1. 外校转入学分
-- ============================================================
alter table public.credit_ledger drop constraint if exists cl_source;
alter table public.credit_ledger add constraint cl_source check (source in ('course','practicum','transfer'));
alter table public.credit_ledger add column if not exists evidence text;
alter table public.program_catalog add column if not exists max_transfer_credits numeric;
comment on column public.program_catalog.max_transfer_credits is
  '外校转入学分上限；null = 不设上限。待 Enos 确认（2026-10-23）。';

-- 某门课的净学分：本校修读与转入（免修）都算
create or replace function public.student_course_net_credits(p_student uuid, p_course text)
returns numeric language sql stable security definer set search_path = '' as $$
  select coalesce(sum(credits), 0) from public.credit_ledger
   where student_id = p_student and source in ('course','transfer') and course_code = p_course;
$$;
revoke execute on function public.student_course_net_credits(uuid,text) from public, anon, authenticated;

-- 发布 / 更正时同步本校修读的学分：
--   及格且这门课还没有任何学分（含转入）→ 入账；
--   不再及格 → 只扣回本校修读入账的那部分，**不动转入学分**。
create or replace function public.sis_sync_course_credit(p_enrollment uuid, p_actor uuid, p_reason text)
returns numeric language plpgsql security definer set search_path = '' as $$
declare
  v_student uuid; v_course text; v_credits numeric; v_pass boolean; v_net_all numeric; v_net_course numeric; v_delta numeric := 0;
begin
  select e.student_id, o.course_code, c.credits
    into v_student, v_course, v_credits
  from public.final_grades g
  join public.course_enrollments e on e.id = g.enrollment_id
  join public.course_offerings o on o.id = e.offering_id
  join public.course_catalog c on c.code = o.course_code
  where g.enrollment_id = p_enrollment and g.status = 'published';
  if not found or v_credits is null then return 0; end if;

  select exists (
    select 1 from public.final_grades g2
    join public.course_enrollments e2 on e2.id = g2.enrollment_id
    join public.course_offerings o2 on o2.id = e2.offering_id
    join public.grade_scale gs2 on gs2.letter = g2.grade
    where e2.student_id = v_student and o2.course_code = v_course
      and g2.status = 'published' and gs2.passing) into v_pass;

  v_net_all := public.student_course_net_credits(v_student, v_course);
  select coalesce(sum(credits), 0) into v_net_course from public.credit_ledger
   where student_id = v_student and source = 'course' and course_code = v_course;
  if v_pass and v_net_all = 0 then v_delta := v_credits;
  elsif not v_pass and v_net_course > 0 then v_delta := -v_net_course;
  end if;
  if v_delta <> 0 then
    insert into public.credit_ledger (student_id, source, course_code, ref_id, credits, reason, created_by)
    values (v_student, 'course', v_course, p_enrollment::text, v_delta, p_reason, p_actor);
  end if;
  return v_delta;
end $$;
revoke execute on function public.sis_sync_course_credit(uuid,uuid,text) from public, anon, authenticated;
grant execute on function public.sis_sync_course_credit(uuid,uuid,text) to service_role;

create or replace function public.sis_add_transfer_credit(
  p_student uuid, p_actor uuid, p_course_code text, p_credits numeric, p_reason text, p_evidence text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare s public.student_records; c public.course_catalog; v_credits numeric; v_cap numeric; v_have numeric; v_id bigint;
begin
  if not public.is_admin_any(p_actor) then raise exception 'actor lacks admin role'; end if;
  if coalesce(trim(p_reason), '') = '' then return jsonb_build_object('ok', false, 'error', 'reason_required'); end if;
  select * into s from public.student_records where id = p_student for update;
  if not found then raise exception 'not_found'; end if;
  if s.status not in ('active','on_leave') then return jsonb_build_object('ok', false, 'error', 'invalid_state'); end if;

  if nullif(trim(p_course_code), '') is not null then
    select * into c from public.course_catalog where code = p_course_code;
    if not found or c.credits is null or c.level is distinct from s.program_code then
      return jsonb_build_object('ok', false, 'error', 'unknown_course');
    end if;
    if public.student_course_net_credits(p_student, p_course_code) > 0 then
      return jsonb_build_object('ok', false, 'error', 'already_credited');
    end if;
    v_credits := c.credits;
  else
    if p_credits is null or p_credits <= 0 or p_credits > 30 then
      return jsonb_build_object('ok', false, 'error', 'bad_credits');
    end if;
    v_credits := p_credits;
  end if;

  select max_transfer_credits into v_cap from public.program_catalog where code = s.program_code;
  select coalesce(sum(credits), 0) into v_have from public.credit_ledger where student_id = p_student and source = 'transfer';
  if v_cap is not null and v_have + v_credits > v_cap then
    return jsonb_build_object('ok', false, 'error', 'over_cap', 'cap', v_cap, 'have', v_have);
  end if;

  insert into public.credit_ledger (student_id, source, course_code, credits, reason, evidence, created_by)
  values (p_student, 'transfer', nullif(trim(p_course_code), ''), v_credits, trim(p_reason), nullif(trim(p_evidence), ''), p_actor)
  returning id into v_id;
  perform public.sis_audit(p_actor, 'transfer_credit_added', 'student_records', p_student::text, null,
    jsonb_build_object('ledger_id', v_id, 'course', p_course_code, 'credits', v_credits, 'evidence', p_evidence), p_reason);
  return jsonb_build_object('ok', true, 'ledger_id', v_id, 'credits', v_credits);
end $$;

create or replace function public.sis_revoke_transfer(p_ledger bigint, p_actor uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare l public.credit_ledger;
begin
  if not public.is_admin_any(p_actor) then raise exception 'actor lacks admin role'; end if;
  if coalesce(trim(p_reason), '') = '' then return jsonb_build_object('ok', false, 'error', 'reason_required'); end if;
  select * into l from public.credit_ledger where id = p_ledger and source = 'transfer' and credits > 0;
  if not found then raise exception 'not_found'; end if;
  if exists (select 1 from public.credit_ledger where source = 'transfer' and ref_id = p_ledger::text) then
    return jsonb_build_object('ok', false, 'error', 'already_revoked');
  end if;
  insert into public.credit_ledger (student_id, source, course_code, ref_id, credits, reason, created_by)
  values (l.student_id, 'transfer', l.course_code, p_ledger::text, -l.credits, trim(p_reason), p_actor);
  perform public.sis_audit(p_actor, 'transfer_credit_revoked', 'student_records', l.student_id::text,
    jsonb_build_object('ledger_id', p_ledger, 'credits', l.credits), null, p_reason);
  return jsonb_build_object('ok', true);
end $$;

-- 毕业审核：转入学分计入总学分，免修的课不再算未修；GPA 只看本校成绩（student_gpa 不变）
create or replace function public.graduation_audit(p_student uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  s public.student_records; p public.program_catalog;
  v_total numeric; v_course numeric; v_prac numeric; v_trans numeric; v_gpa numeric; v_missing jsonb; v_prac_list jsonb;
begin
  select * into s from public.student_records where id = p_student;
  if not found then return null; end if;
  select * into p from public.program_catalog where code = s.program_code;

  select coalesce(sum(credits) filter (where source = 'course'), 0),
         coalesce(sum(credits) filter (where source = 'practicum'), 0),
         coalesce(sum(credits) filter (where source = 'transfer'), 0)
    into v_course, v_prac, v_trans
  from public.credit_ledger where student_id = p_student;
  v_total := v_course + v_prac + v_trans;
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
    'credits_earned', v_total, 'course_credits', v_course, 'practicum_credits', v_prac, 'transfer_credits', v_trans,
    'gpa', v_gpa, 'missing_courses', v_missing, 'practicum', v_prac_list,
    'eligible', s.status = 'active' and p.credits_required is not null
                and v_total >= p.credits_required
                and (p.min_gpa is null or coalesce(v_gpa, 0) >= p.min_gpa)
                and jsonb_array_length(v_missing) = 0);
end $$;
revoke execute on function public.graduation_audit(uuid) from public, anon, authenticated;

create or replace function public.sis_student_transfers(p_student uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('ledger_id', l.id, 'course_code', l.course_code, 'title_zh', c.title_zh,
           'credits', l.credits, 'reason', l.reason, 'evidence', l.evidence, 'created_at', l.created_at,
           'revoked', exists (select 1 from public.credit_ledger r where r.source = 'transfer' and r.ref_id = l.id::text))
           order by l.created_at), '[]'::jsonb)
  from public.credit_ledger l left join public.course_catalog c on c.code = l.course_code
  where l.student_id = p_student and l.source = 'transfer' and l.credits > 0;
$$;
revoke execute on function public.sis_student_transfers(uuid) from public, anon, authenticated;

create or replace function public.admin_student_overview(p_student uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_admin_any(auth.uid()) then return null; end if;
  return public.graduation_audit(p_student) || jsonb_build_object(
    'mentors', coalesce((select jsonb_agg(jsonb_build_object('assignment_id', m.id, 'mentor_id', m.mentor_id,
                   'name', p.display_name, 'started_at', m.started_at) order by m.started_at)
              from public.mentor_assignments m join public.profiles p on p.id = m.mentor_id
             where m.student_id = p_student and m.ended_at is null), '[]'::jsonb),
    'graduation', (select to_jsonb(g) - 'audited_by' from public.graduation_records g where g.student_id = p_student),
    'transfers', public.sis_student_transfers(p_student));
end $$;

-- ============================================================
-- 2. 成绩单
-- ============================================================
create or replace function public.sis_transcript(p_student uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare s public.student_records; v_name text; v_prog text;
begin
  select * into s from public.student_records where id = p_student;
  if not found then return null; end if;
  select coalesce(nullif(legal_name, ''), display_name) into v_name from public.profiles where id = s.user_id;
  select name_zh into v_prog from public.program_catalog where code = s.program_code;
  return public.graduation_audit(p_student) || jsonb_build_object(
    'name', v_name, 'student_number', s.student_number, 'program_name', v_prog, 'activated_at', s.activated_at,
    'courses', coalesce((
      select jsonb_agg(jsonb_build_object('course_code', x.course_code, 'title_zh', x.title_zh, 'academic_year', x.academic_year,
               'credits', x.credits, 'grade', x.grade, 'points', x.points, 'passing', x.passing) order by x.academic_year, x.sort_order)
      from (select distinct on (o.course_code) o.course_code, c.title_zh, c.sort_order, o.academic_year, c.credits,
                   g.grade, gs.points, gs.passing
              from public.final_grades g
              join public.course_enrollments e on e.id = g.enrollment_id
              join public.course_offerings o on o.id = e.offering_id
              join public.course_catalog c on c.code = o.course_code
              join public.grade_scale gs on gs.letter = g.grade
             where e.student_id = p_student and g.status = 'published'
             order by o.course_code, g.published_at desc) x), '[]'::jsonb),
    'transfers', (select coalesce(jsonb_agg(t) filter (where not (t->>'revoked')::boolean), '[]'::jsonb)
                    from jsonb_array_elements(public.sis_student_transfers(p_student)) t),
    'graduation', (select jsonb_build_object('graduated_on', g.graduated_on, 'total_credits', g.total_credits, 'gpa', g.gpa)
                     from public.graduation_records g where g.student_id = p_student));
end $$;
revoke execute on function public.sis_transcript(uuid) from public, anon, authenticated;

create or replace function public.my_transcript()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v uuid := public.my_student_id();
begin
  if v is null then return null; end if;
  return public.sis_transcript(v);
end $$;

create or replace function public.admin_transcript(p_student uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_admin_any(auth.uid()) then return null; end if;
  return public.sis_transcript(p_student);
end $$;

-- ============================================================
-- 3. 课程班总览加授课次数（返回列变了，须先删再建）
-- ============================================================
drop function if exists public.admin_list_offerings(text);
create function public.admin_list_offerings(p_year text default null)
returns table (
  offering_id uuid, course_code text, title_zh text, level text, credits numeric, academic_year text,
  section_label text, delivery_mode text, starts_on date, ends_on date, schedule_note text,
  capacity integer, offering_status text, teachers jsonb, enrolled_count bigint,
  session_count bigint, last_session_on date
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
         (select count(*) from public.course_enrollments e where e.offering_id = o.id and e.status = 'enrolled'),
         (select count(*) from public.class_sessions cs where cs.offering_id = o.id),
         (select max(cs.held_on) from public.class_sessions cs where cs.offering_id = o.id)
  from public.course_offerings o
  join public.course_catalog c on c.code = o.course_code
  where public.is_admin_any(auth.uid())
    and (p_year is null or o.academic_year = p_year)
  order by o.academic_year desc, o.starts_on nulls last, c.title_zh;
$$;

-- ============================================================
-- 4. 角色管理（只 super_admin；Edge 另验 aal2）
-- ============================================================
create or replace function public.sis_set_staff_role(
  p_actor uuid, p_user uuid, p_role text, p_grant boolean, p_reason text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_n int;
begin
  if not public.has_active_role(p_actor, 'super_admin') then raise exception 'actor lacks admin role'; end if;
  if p_role not in ('registrar','academic_admin','mentor') then
    return jsonb_build_object('ok', false, 'error', 'role_not_manageable');
  end if;
  if p_user = p_actor then return jsonb_build_object('ok', false, 'error', 'cannot_change_self'); end if;
  if coalesce(trim(p_reason), '') = '' then return jsonb_build_object('ok', false, 'error', 'reason_required'); end if;
  if not exists (select 1 from public.profiles where id = p_user) then raise exception 'not_found'; end if;

  if p_grant then
    if public.has_active_role(p_user, p_role) then return jsonb_build_object('ok', false, 'error', 'already_assigned'); end if;
    insert into public.user_roles (user_id, role, granted_by) values (p_user, p_role::public.user_role, p_actor);
  else
    update public.user_roles set revoked_at = now()
     where user_id = p_user and role::text = p_role and revoked_at is null;
    get diagnostics v_n = row_count;
    if v_n = 0 then return jsonb_build_object('ok', false, 'error', 'not_assigned'); end if;
  end if;
  insert into public.audit_logs (actor_id, actor_role, event_type, target_type, target_id, category, old_value, new_value, reason)
  values (p_actor, 'super_admin', case when p_grant then 'role_granted' else 'role_revoked' end, 'user_roles', p_user::text,
          'security', null, jsonb_build_object('role', p_role), trim(p_reason));
  return jsonb_build_object('ok', true);
end $$;
revoke execute on function public.sis_set_staff_role(uuid,uuid,text,boolean,text) from public, anon, authenticated;
grant execute on function public.sis_set_staff_role(uuid,uuid,text,boolean,text) to service_role;

-- 按邮箱找人（精确匹配，不做模糊搜索，避免拉取全部用户名单）
create or replace function public.admin_find_user(p_email text)
returns table (user_id uuid, display_name text, email text, roles text[])
language sql stable security definer set search_path = '' as $$
  select p.id, p.display_name, p.email,
         array(select r.role::text from public.user_roles r
                where r.user_id = p.id and r.revoked_at is null and (r.expires_at is null or r.expires_at > now())
                order by 1)
  from public.profiles p
  where lower(p.email) = lower(trim(p_email)) and public.has_active_role(auth.uid(), 'super_admin');
$$;

create or replace function public.admin_list_staff()
returns table (user_id uuid, display_name text, email text, roles text[])
language sql stable security definer set search_path = '' as $$
  select p.id, p.display_name, p.email,
         array(select r.role::text from public.user_roles r
                where r.user_id = p.id and r.revoked_at is null and (r.expires_at is null or r.expires_at > now())
                  and r.role::text in ('registrar','academic_admin','super_admin','mentor','teacher') order by 1)
  from public.profiles p
  where public.has_active_role(auth.uid(), 'super_admin')
    and exists (select 1 from public.user_roles r where r.user_id = p.id and r.revoked_at is null
                  and r.role::text in ('registrar','academic_admin','super_admin','mentor'))
  order by p.display_name;
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'public.sis_add_transfer_credit(uuid,uuid,text,numeric,text,text)', 'public.sis_revoke_transfer(bigint,uuid,text)'
  ] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
  foreach f in array array[
    'public.admin_student_overview(uuid)', 'public.my_transcript()', 'public.admin_transcript(uuid)',
    'public.admin_list_offerings(text)', 'public.admin_find_user(text)', 'public.admin_list_staff()'
  ] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
