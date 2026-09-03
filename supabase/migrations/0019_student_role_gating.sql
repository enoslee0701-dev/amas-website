-- ============================================================
-- 0019_student_role_gating · PORTAL-2B 验收发现的真实缺陷修复
--
-- 缺陷：学生侧的读取与能力判断只看**业务状态**（student_records.status），
--       没有同时要求持有**有效的 student 角色**。
--       后果：撤销某人的 student 角色后，他手上的旧 JWT 仍然能：
--         · 通过 RLS 读到自己的 student_records
--         · 从 my_student_capabilities() 拿到 official_student_services = true
--       前端路由守卫（allow:["student"]）会挡住页面，但**服务端没有挡**——
--       这正是"禁止只靠隐藏按钮实现权限控制"要防的那种情况（工程规则 R-2）。
--       2B-10 ⑫ 要求"revoke student role 后旧 JWT 即时失权"，当时并未覆盖读取路径。
--
-- 修复：把"持有有效 student 角色"加入 RLS 策略与全部学生侧 RPC 的前置条件。
--       角色撤销后：读 0 行、能力全否、学习读模型返回空、待办为空——与别名撤销一致，
--       全部即时生效（角色现查，不依赖 JWT 内容）。
--
-- 注意：管理员读取路径（is_admin_any）不变——学生离开后教务仍需查档。
-- ============================================================

-- ---------- 1. RLS：本人可读自己的学籍，但必须仍是学生 ----------
drop policy if exists student_self_select on public.student_records;
create policy student_self_select on public.student_records
  for select to authenticated
  using (user_id = auth.uid() and public.current_user_has_role('student'));

-- 状态历史同理
drop policy if exists ssh_select on public.student_status_history;
create policy ssh_select on public.student_status_history
  for select to authenticated
  using (
    (exists (select 1 from public.student_records s
              where s.id = student_id and s.user_id = auth.uid())
     and public.current_user_has_role('student'))
    or public.is_admin_any(auth.uid())
  );

-- ---------- 2. 能力门禁：无 student 角色一律全否 ----------
create or replace function public.my_student_capabilities()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare s public.student_records; v_active boolean; v_is_student boolean;
begin
  if auth.uid() is null then raise exception 'unauthenticated'; end if;

  -- ★ 角色现查：撤销后即时生效，不看 JWT 里写了什么
  v_is_student := public.has_active_role(auth.uid(), 'student');
  if not v_is_student then
    return jsonb_build_object(
      'status', 'none', 'view_identity', false, 'edit_own_contact', false,
      'browse_catalog', true,              -- 67 门目录本就是公开信息
      'build_christian_profile', true,     -- CP 不以学籍为前提
      'official_student_services', false,
      'course_content_access', false, 'course_access_source', 'none');
  end if;

  select * into s from public.student_records where user_id = auth.uid();
  v_active := coalesce(s.status = 'active', false);

  return jsonb_build_object(
    'status',              coalesce(s.status::text, 'none'),
    'view_identity',       s.id is not null,
    'edit_own_contact',    s.id is not null,
    'browse_catalog',      true,
    'build_christian_profile', true,
    'official_student_services', v_active,
    -- 课程内容访问：当前无数据源，一律 false，且不因 active 自动为真
    'course_content_access', false,
    'course_access_source',  'none'
  );
end $$;
revoke execute on function public.my_student_capabilities() from public, anon;
grant execute on function public.my_student_capabilities() to authenticated;

-- ---------- 3. 学生侧读模型统一加角色前置 ----------
create or replace function public.my_student_record()
returns table (
  id uuid, status text, student_number text, program_code text, pathway text,
  activated_at timestamptz, created_at timestamptz
)
language sql stable security definer set search_path = '' as $$
  select s.id, s.status::text, s.student_number, s.program_code, s.pathway::text,
         s.activated_at, s.created_at
  from public.student_records s
  where s.user_id = auth.uid()
    and public.has_active_role(auth.uid(), 'student');
$$;
revoke execute on function public.my_student_record() from public, anon;
grant execute on function public.my_student_record() to authenticated;

create or replace function public.my_student_timeline()
returns table (to_status text, student_visible_message text, created_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select h.to_status::text, h.student_visible_message, h.created_at
  from public.student_status_history h
  join public.student_records s on s.id = h.student_id
  where s.user_id = auth.uid()
    and public.has_active_role(auth.uid(), 'student')
  order by h.created_at;
$$;
revoke execute on function public.my_student_timeline() from public, anon;
grant execute on function public.my_student_timeline() to authenticated;

create or replace function public.my_learning()
returns table (
  code text, title_zh text, category text, level text,
  total_lessons int, availability text, credits numeric,
  learning_state text
)
language sql stable security definer set search_path = '' as $$
  select c.code, c.title_zh, c.category::text, c.level,
         c.total_lessons, c.availability::text, c.credits,
         case when c.availability = 'in_development' then 'content_pending'
              else 'catalogued' end
  from public.course_catalog c
  where public.has_active_role(auth.uid(), 'student')
  order by c.sort_order;
$$;
revoke execute on function public.my_learning() from public, anon;
grant execute on function public.my_learning() to authenticated;

-- 学生资料读模型：非学生只返回自助部分，学籍分区为空
create or replace function public.my_student_profile()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare p public.profiles; s public.student_records; hq jsonb;
begin
  if auth.uid() is null then raise exception 'unauthenticated'; end if;
  select * into p from public.profiles where id = auth.uid();
  if not found then raise exception 'not_found'; end if;

  if public.has_active_role(auth.uid(), 'student') then
    select * into s from public.student_records where user_id = auth.uid();
    if s.application_id is not null then
      select jsonb_build_object('status', h.status, 'confirmed_at', h.confirmed_at,
                                'reference', h.approval_reference, 'note', h.applicant_visible_note)
        into hq
        from public.application_hq_approvals h where h.application_id = s.application_id;
    end if;
  end if;

  return jsonb_build_object(
    'self_editable', jsonb_build_object(
      'display_name', p.display_name, 'phone', p.phone, 'contact_note', p.contact_note),
    'registrar_managed', jsonb_build_object(
      'email',          p.email,
      'student_number', s.student_number,
      'status',         s.status,
      'program_code',   s.program_code,
      'pathway',        s.pathway,
      'created_at',     s.created_at,
      'activated_at',   s.activated_at,
      'hq_approval',    hq),
    'has_student_record', s.id is not null
  );
end $$;
revoke execute on function public.my_student_profile() from public, anon;
grant execute on function public.my_student_profile() to authenticated;

-- 待办事项：学籍相关事项只对仍是学生的人产生
create or replace function public.my_action_items()
returns table (
  source_type text, source_id text, title text, reason text,
  target_url text, status text, priority int
)
language sql stable security definer set search_path = '' as $$
  with me as (
    select p.id, p.phone,
           case when public.has_active_role(p.id, 'student') then s.id end as student_id,
           case when public.has_active_role(p.id, 'student') then s.status::text end as st
    from public.profiles p
    left join public.student_records s on s.user_id = p.id
    where p.id = auth.uid()
  )
  select 'profile'::text, me.id::text, '完善联系方式'::text,
         '你还没有填写联系电话，教务在需要时无法联系到你。'::text,
         'portal/student/profile/'::text, 'open'::text, 20
    from me where me.phone is null

  union all
  select 'student_record', me.student_id::text, '等待教务完成正式注册',
         '你的学籍已建立，正在等待 AMAS 教务处完成正式注册。这一步无需你操作。',
         'portal/student/', 'waiting', 10
    from me where me.st = 'pre_enrolled'

  union all
  select 'christian_profile', me.id::text, '建立你的信仰成长档案',
         '完成评估后可以看到自己的成长画像与学习建议。评估在「AMAS 神学院」App 中进行。',
         'discover.html', 'open', 30
    from me

  order by 7, 1;
$$;
revoke execute on function public.my_action_items() from public, anon;
grant execute on function public.my_action_items() to authenticated;

comment on function public.my_student_capabilities is
  '学生能力门禁（0019 起同时要求持有有效 student 角色）。角色撤销即时生效，不依赖 JWT 内容。';
