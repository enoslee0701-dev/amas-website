-- ============================================================
-- 0012_student_core · PORTAL-2 学籍核心（生命周期 / HQ 审核 / 学号 / 角色转换）
--
-- 已批准生命周期（P2-1）：
--   application → accepted → HQ approval confirmed → create student record
--   → pre_enrolled → active
--
-- 硬规则：
--   1. accepted ≠ student；没有 hq_approval_status='approved' 建档 RPC 永远失败
--   2. student record 初始状态必须是 pre_enrolled
--   3. pre_enrolled → active 只能由 registrar / 授权角色经服务端动作完成
--   4. 状态迁移走 DB 白名单状态机，REST 直接改 status 一律拒绝
--   5. 每次状态变化写 append-only history + audit
--   6. 学号由 registrar 录入 AMAS 总校实际分配结果，系统不自行发明编码规则；
--      normalized 唯一，且**已使用过的学号永不重新分配给他人**（registry 永久留痕）
--   7. student_records 只存学籍特有数据；姓名/邮箱等一律从 profiles 取，不建第二套人物资料
--
-- V1 不实现（未经批准的业务规则，不得自行创造）：
--   休学/退学/毕业/开除等状态、选课系统、学分算法、成绩单、GPA、毕业审核、财务缴费。
--   student_status 目前只有 pre_enrolled / active；新增状态须先有政策批准，再另起 migration
--   （enum 可用 alter type ... add value 扩展，本迁移刻意不预置任何未批准状态）。
-- ============================================================

do $$ begin
  create type hq_approval_status as enum ('pending','approved','rejected');
exception when duplicate_object then null; end $$;

do $$ begin
  create type student_status as enum ('pre_enrolled','active');
exception when duplicate_object then null; end $$;

-- ============================================================
-- 1. AMAS 总校审核确认（P2-2）
-- ============================================================
create table if not exists public.application_hq_approvals (
  application_id         uuid primary key references public.applications(id) on delete cascade,
  status                 hq_approval_status not null default 'pending',
  approval_reference     text,                    -- 总校批文/会议纪要编号，可空
  confirmed_at           timestamptz,
  confirmed_by           uuid references public.profiles(id) on delete set null,
  applicant_visible_note text,                    -- 申请人可见
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);
comment on table public.application_hq_approvals is
  'AMAS 总校对录取的审核确认记录。没有 status=approved，create_student_record 永远失败（P2-2）。';

-- 内部备注物理分表（沿用 0004/0008 的隔离模式：不靠列权限，靠分表 + RLS）
create table if not exists public.hq_approval_internal (
  application_id uuid primary key references public.applications(id) on delete cascade,
  notes          text not null default '',
  updated_by     uuid references public.profiles(id) on delete set null,
  updated_at     timestamptz not null default now()
);

drop trigger if exists hq_approvals_set_updated_at on public.application_hq_approvals;
create trigger hq_approvals_set_updated_at before update on public.application_hq_approvals
  for each row execute function public.set_updated_at();

-- ============================================================
-- 2. 学号登记簿（P2-3：已用学号永不回收重发）
-- ============================================================
create table if not exists public.student_number_registry (
  normalized        text primary key,
  original          text not null,
  first_assigned_to uuid references public.profiles(id) on delete set null,
  first_assigned_at timestamptz not null default now(),
  released_at       timestamptz,          -- 更正后旧号在此留痕；**留痕不等于可重用**
  release_reason    text
);
comment on table public.student_number_registry is
  '所有曾经分配过的学号。主键即唯一性来源：更正学号后旧号仍留在表内，任何人不得再次取得。
   应用层没有任何删除路径（这是刻意的）；录错学号导致误占用时，只能由 DBA 直接删除对应行，
   并留下运维记录。是否给"从未真正使用过的误录学号"开一条受审计的解除通道，属未决策事项。';

-- 归一化：仅去空白 + 统一大写；**不假设任何编码格式**（不得自行发明 2026TH001 之类规则）
create or replace function public.normalize_student_number(p_raw text)
returns text language sql immutable set search_path = '' as $$
  select nullif(upper(regexp_replace(coalesce(p_raw,''), '\s+', '', 'g')), '');
$$;

-- ============================================================
-- 3. 学籍记录（P2-4：只存学籍特有数据）
-- ============================================================
create table if not exists public.student_records (
  id                        uuid primary key default gen_random_uuid(),
  user_id                   uuid not null unique references public.profiles(id) on delete cascade,
  application_id            uuid unique references public.applications(id) on delete set null,
  status                    student_status not null default 'pre_enrolled',
  student_number            text,                 -- registrar 录入总校实际分配结果
  student_number_normalized text unique references public.student_number_registry(normalized),
  program_code              text references public.program_catalog(code),
  pathway                   application_pathway,
  hq_approval_reference     text,
  activated_at              timestamptz,          -- 进入 active 的时间
  created_by                uuid references public.profiles(id) on delete set null,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);
comment on table public.student_records is
  '学籍记录。一人一条（user_id unique）；姓名/邮箱等从 profiles 取，此处不复制（P2-4）。';
comment on column public.student_records.student_number is
  '总校实际分配的学号原样值。建档时可暂缺，但没有学号不得激活为 active。';

create index if not exists student_records_status on public.student_records (status, created_at desc);

drop trigger if exists student_records_set_updated_at on public.student_records;
create trigger student_records_set_updated_at before update on public.student_records
  for each row execute function public.set_updated_at();

-- append-only 状态历史
create table if not exists public.student_status_history (
  id              bigint generated always as identity primary key,
  student_id      uuid not null references public.student_records(id) on delete cascade,
  from_status     student_status,
  to_status       student_status not null,
  actor_id        uuid references public.profiles(id) on delete set null,
  actor_role      text,
  student_visible_message text,
  internal_note   text,                    -- 学生视图经 RPC 剔除
  created_at      timestamptz not null default now()
);
create index if not exists ssh_by_student on public.student_status_history (student_id, created_at);

-- ============================================================
-- 4. 状态机 + 直改防护（P2-1 规则 4/5）
-- ============================================================
-- 受保护 RPC 在事务内置 amas.rpc_context，直连 REST 没有该上下文。
--
-- 与 0009 的差别：令牌**用后即焚**。set_config(..., true) 是事务级的，RPC 返回后标记
-- 仍留在同一事务里；PostgREST 一请求一事务时不构成风险，但只要有任何一处在同一事务内
-- 先调 RPC 再直写表，防线就形同虚设。这里由触发器在放行一次后立即清除令牌，
-- 每个受保护 RPC 因此只能写 student_records 一次，多写即被拒。
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
      raise exception 'student record must start as pre_enrolled';   -- P2-1 规则 3
    end if;
    return new;
  end if;

  -- UPDATE：状态迁移白名单
  if new.status is distinct from old.status then
    if not in_rpc then
      raise exception 'student status is changed through a protected server flow only';
    end if;
    if not (old.status = 'pre_enrolled' and new.status = 'active') then
      raise exception 'invalid student transition % -> %', old.status, new.status;
    end if;
    if public.normalize_student_number(new.student_number) is null then
      raise exception 'student number required before activation';
    end if;
  end if;

  -- 学号与身份归属只能经专用 RPC 变更（P2-3）
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

drop trigger if exists student_records_guard on public.student_records;
create trigger student_records_guard before insert or update on public.student_records
  for each row execute function public.student_guard();

-- 历史表 append-only：任何人不得改写/删除
create or replace function public.append_only_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'history is append-only';
end $$;
drop trigger if exists ssh_append_only on public.student_status_history;
create trigger ssh_append_only before update or delete on public.student_status_history
  for each row execute function public.append_only_guard();

-- ============================================================
-- 5. 学号别名与角色同步（P2-3：与 SEC-2 即时失权原则一致）
-- ============================================================
-- student 角色被撤销时，同一事务内撤销其学号登录别名——避免"角色没了别名还能登录"。
-- 未来若新增 suspended / inactive 等状态，必须沿用同一机制，不得只在 UI 隐藏。
create or replace function public.sync_alias_on_role_revoke()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.role = 'student' and new.revoked_at is not null and old.revoked_at is null then
    update public.login_aliases
       set revoked_at = now()
     where user_id = new.user_id and alias_type = 'student_number' and revoked_at is null;

    insert into public.audit_logs (actor_id, actor_role, event_type, target_type, target_id, category, reason)
    values (auth.uid(), 'system', 'student_alias_revoked', 'login_aliases', new.user_id::text, 'academic',
            'student role revoked');
  end if;
  return new;
end $$;
drop trigger if exists user_roles_alias_sync on public.user_roles;
create trigger user_roles_alias_sync after update on public.user_roles
  for each row execute function public.sync_alias_on_role_revoke();

-- ============================================================
-- 6. RLS
-- ============================================================
alter table public.application_hq_approvals   enable row level security;
alter table public.hq_approval_internal       enable row level security;
alter table public.student_number_registry    enable row level security;
alter table public.student_records            enable row level security;
alter table public.student_status_history     enable row level security;

-- HQ 审核：申请人可见自己的（不含内部备注）；教务/学术/超管可见全部
drop policy if exists hq_appr_select on public.application_hq_approvals;
create policy hq_appr_select on public.application_hq_approvals
  for select to authenticated
  using (
    exists (select 1 from public.applications a
             where a.id = application_id and a.applicant_id = auth.uid())
    or public.is_admin_any(auth.uid())
  );
revoke insert, update, delete on public.application_hq_approvals from anon, authenticated;

-- 内部备注：仅管理员；申请人无任何可见路径
drop policy if exists hq_internal_select on public.hq_approval_internal;
create policy hq_internal_select on public.hq_approval_internal
  for select to authenticated using (public.is_admin_any(auth.uid()));
revoke insert, update, delete on public.hq_approval_internal from anon, authenticated;

-- 学号登记簿：客户端完全不可见（含管理员——查询走 RPC，避免全量学号被拉走）
revoke all on public.student_number_registry from anon, authenticated;

-- 学籍记录：本人只读自己；registrar / academic_admin / super_admin 可读全部。
-- finance 不在其中（P2-9 ⑥：财务不应取得学习/成长数据）。
-- teacher / mentor 走 fail-closed 占位函数，V1 恒为 false。
drop policy if exists student_self_select on public.student_records;
create policy student_self_select on public.student_records
  for select to authenticated using (user_id = auth.uid());

drop policy if exists student_admin_select on public.student_records;
create policy student_admin_select on public.student_records
  for select to authenticated using (public.is_admin_any(auth.uid()));

-- 客户端一律不可写：建档/激活/更正学号全部经服务端 RPC
revoke insert, update, delete on public.student_records from anon, authenticated;

drop policy if exists ssh_select on public.student_status_history;
create policy ssh_select on public.student_status_history
  for select to authenticated
  using (
    exists (select 1 from public.student_records s
             where s.id = student_id and s.user_id = auth.uid())
    or public.is_admin_any(auth.uid())
  );
-- internal_note 列不授予：先 revoke all 再按列 grant（列级 revoke 无法削掉表级 SELECT）
revoke all on public.student_status_history from anon, authenticated;
grant select (id, student_id, from_status, to_status, actor_id, actor_role,
              student_visible_message, created_at)
  on public.student_status_history to authenticated;

-- ============================================================
-- 7. 学生侧 RPC（authenticated）
-- ============================================================
create or replace function public.my_student_record()
returns table (
  id uuid, status text, student_number text, program_code text, pathway text,
  activated_at timestamptz, created_at timestamptz
)
language sql stable security definer set search_path = '' as $$
  select s.id, s.status::text, s.student_number, s.program_code, s.pathway::text,
         s.activated_at, s.created_at
  from public.student_records s
  where s.user_id = auth.uid();
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
  order by h.created_at;              -- internal_note 不返回
$$;
revoke execute on function public.my_student_timeline() from public, anon;
grant execute on function public.my_student_timeline() to authenticated;

-- ============================================================
-- 8. 服务端 RPC（service_role 专用；Edge 已校验角色 + aal2）
-- ============================================================

-- 8.1 记录 AMAS 总校审核确认
create or replace function public.confirm_hq_approval(
  p_app uuid, p_actor uuid, p_status text,
  p_reference text default null, p_visible_note text default null,
  p_internal_note text default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare a public.applications; v_new public.hq_approval_status; v_old public.hq_approval_status;
begin
  if not public.is_admin_any(p_actor) then raise exception 'actor lacks admin role'; end if;
  if p_status not in ('pending','approved','rejected') then
    raise exception 'unknown hq approval status %', p_status;
  end if;
  v_new := p_status::public.hq_approval_status;

  select * into a from public.applications where id = p_app for update;
  if not found then raise exception 'not_found'; end if;
  -- 只有已录取的申请才谈得上总校确认
  if a.status <> 'accepted' then raise exception 'invalid_state'; end if;

  select status into v_old from public.application_hq_approvals where application_id = p_app;

  insert into public.application_hq_approvals
    (application_id, status, approval_reference, applicant_visible_note,
     confirmed_at, confirmed_by)
  values (p_app, v_new, p_reference, p_visible_note,
          case when v_new = 'approved' then now() end,
          case when v_new = 'approved' then p_actor end)
  on conflict (application_id) do update
    set status = excluded.status,
        approval_reference = coalesce(excluded.approval_reference, public.application_hq_approvals.approval_reference),
        applicant_visible_note = coalesce(excluded.applicant_visible_note, public.application_hq_approvals.applicant_visible_note),
        confirmed_at = case when excluded.status = 'approved' then now() end,
        confirmed_by = case when excluded.status = 'approved' then p_actor end;

  if p_internal_note is not null then
    insert into public.hq_approval_internal (application_id, notes, updated_by)
    values (p_app, p_internal_note, p_actor)
    on conflict (application_id) do update
      set notes = public.hq_approval_internal.notes || E'\n' || excluded.notes,
          updated_by = excluded.updated_by, updated_at = now();
  end if;

  insert into public.audit_logs (actor_id, actor_role, event_type, target_type, target_id, category,
                                 old_value, new_value, reason)
  values (p_actor, 'admin', 'hq_approval_' || p_status, 'applications', p_app::text, 'academic',
          jsonb_build_object('hq_status', v_old),
          jsonb_build_object('hq_status', v_new, 'reference', p_reference), p_visible_note);

  return jsonb_build_object('ok', true, 'hq_status', v_new);
end $$;
revoke execute on function public.confirm_hq_approval(uuid,uuid,text,text,text,text) from public, anon, authenticated;
grant execute on function public.confirm_hq_approval(uuid,uuid,text,text,text,text) to service_role;

-- 8.2 建档：唯一入口。没有 hq_approval_status='approved' 一律失败。
create or replace function public.create_student_record(
  p_app uuid, p_actor uuid,
  p_student_number text default null,
  p_program_code text default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  a public.applications;
  hq public.application_hq_approvals;
  v_norm text;
  v_program text;
  v_id uuid;
  v_other int;
begin
  perform set_config('amas.rpc_context', 'student', true);
  if not public.is_admin_any(p_actor) then raise exception 'actor lacks admin role'; end if;

  select * into a from public.applications where id = p_app for update;
  if not found then raise exception 'not_found'; end if;
  if a.status <> 'accepted' then raise exception 'application not accepted'; end if;

  -- ★ P2-2 硬门禁
  select * into hq from public.application_hq_approvals where application_id = p_app for update;
  if not found or hq.status <> 'approved' then
    return jsonb_build_object('ok', false, 'error', 'hq_approval_required');
  end if;

  if exists (select 1 from public.student_records where user_id = a.applicant_id) then
    return jsonb_build_object('ok', false, 'error', 'student_already_exists');
  end if;

  -- 学号：可暂缺（激活前必须补齐），一旦给出则登记且永不回收
  v_norm := public.normalize_student_number(p_student_number);
  if v_norm is not null then
    begin
      insert into public.student_number_registry (normalized, original, first_assigned_to)
      values (v_norm, p_student_number, a.applicant_id);
    exception when unique_violation then
      return jsonb_build_object('ok', false, 'error', 'student_number_taken');
    end;
  end if;

  v_program := coalesce(p_program_code, a.form_data #>> '{programs,0}');
  if v_program is not null and not exists (select 1 from public.program_catalog where code = v_program) then
    raise exception 'unknown program %', v_program;
  end if;

  insert into public.student_records
    (user_id, application_id, status, student_number, student_number_normalized,
     program_code, pathway, hq_approval_reference, created_by)
  values (a.applicant_id, p_app, 'pre_enrolled', p_student_number, v_norm,
          v_program, a.pathway, hq.approval_reference, p_actor)
  returning id into v_id;

  insert into public.student_status_history (student_id, from_status, to_status, actor_id, actor_role)
  values (v_id, null, 'pre_enrolled', p_actor, 'admin');

  -- 角色：授予 student
  insert into public.user_roles (user_id, role, granted_by)
  values (a.applicant_id, 'student', p_actor)
  on conflict do nothing;

  -- 学号登录别名（P2-3：与学号生命周期同步）
  if v_norm is not null then
    insert into public.login_aliases (user_id, alias_type, alias_normalized, created_by)
    values (a.applicant_id, 'student_number', v_norm, p_actor)
    on conflict (alias_normalized) do nothing;
  end if;

  -- P2-4 / P3：没有其他活动申请则撤销 applicant 角色
  select count(*) into v_other from public.applications
   where applicant_id = a.applicant_id and id <> p_app
     and status not in ('rejected','withdrawn');
  if v_other = 0 then
    update public.user_roles set revoked_at = now()
     where user_id = a.applicant_id and role = 'applicant' and revoked_at is null;
  end if;

  insert into public.audit_logs (actor_id, actor_role, event_type, target_type, target_id, category,
                                 old_value, new_value, reason)
  values (p_actor, 'admin', 'student_record_created', 'student_records', v_id::text, 'academic',
          jsonb_build_object('application', p_app),
          jsonb_build_object('status','pre_enrolled','student_number', p_student_number,
                             'program', v_program, 'applicant_role_revoked', v_other = 0),
          hq.approval_reference);

  return jsonb_build_object('ok', true, 'student_id', v_id, 'status', 'pre_enrolled',
                            'applicant_role_revoked', v_other = 0);
end $$;
revoke execute on function public.create_student_record(uuid,uuid,text,text) from public, anon, authenticated;
grant execute on function public.create_student_record(uuid,uuid,text,text) to service_role;

-- 8.3 激活：pre_enrolled → active
create or replace function public.activate_student(
  p_student uuid, p_actor uuid, p_message text default null, p_internal_note text default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare s public.student_records;
begin
  perform set_config('amas.rpc_context', 'student', true);
  -- 激活是学籍动作：registrar / academic_admin / super_admin
  if not public.is_admin_any(p_actor) then raise exception 'actor lacks admin role'; end if;

  select * into s from public.student_records where id = p_student for update;
  if not found then raise exception 'not_found'; end if;
  if s.status <> 'pre_enrolled' then
    return jsonb_build_object('ok', false, 'error', 'invalid_state', 'status', s.status);
  end if;
  if public.normalize_student_number(s.student_number) is null then
    return jsonb_build_object('ok', false, 'error', 'student_number_required');
  end if;

  update public.student_records
     set status = 'active', activated_at = now()
   where id = p_student;

  insert into public.student_status_history
    (student_id, from_status, to_status, actor_id, actor_role, student_visible_message, internal_note)
  values (p_student, 'pre_enrolled', 'active', p_actor, 'admin', p_message, p_internal_note);

  insert into public.audit_logs (actor_id, actor_role, event_type, target_type, target_id, category,
                                 old_value, new_value, reason)
  values (p_actor, 'admin', 'student_activated', 'student_records', p_student::text, 'academic',
          jsonb_build_object('status','pre_enrolled'), jsonb_build_object('status','active'), p_message);

  return jsonb_build_object('ok', true, 'status', 'active');
end $$;
revoke execute on function public.activate_student(uuid,uuid,text,text) from public, anon, authenticated;
grant execute on function public.activate_student(uuid,uuid,text,text) to service_role;

-- 8.4 学号更正：专用通道，前后值 + 操作者 + 原因全部审计
create or replace function public.correct_student_number(
  p_student uuid, p_actor uuid, p_new_number text, p_reason text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare s public.student_records; v_norm text;
begin
  perform set_config('amas.rpc_context', 'student', true);
  if not public.is_admin_any(p_actor) then raise exception 'actor lacks admin role'; end if;
  if coalesce(trim(p_reason),'') = '' then raise exception 'reason required'; end if;

  v_norm := public.normalize_student_number(p_new_number);
  if v_norm is null then raise exception 'student number required'; end if;

  select * into s from public.student_records where id = p_student for update;
  if not found then raise exception 'not_found'; end if;
  if s.student_number_normalized is not distinct from v_norm then
    return jsonb_build_object('ok', false, 'error', 'unchanged');
  end if;

  -- 新号必须从未被分配过（登记簿主键即唯一性来源）
  begin
    insert into public.student_number_registry (normalized, original, first_assigned_to)
    values (v_norm, p_new_number, s.user_id);
  exception when unique_violation then
    return jsonb_build_object('ok', false, 'error', 'student_number_taken');
  end;

  -- 旧号留痕：标记释放时间，但**仍留在登记簿内，永不重新分配**
  if s.student_number_normalized is not null then
    update public.student_number_registry
       set released_at = now(), release_reason = p_reason
     where normalized = s.student_number_normalized;
    update public.login_aliases set revoked_at = now()
     where alias_normalized = s.student_number_normalized and revoked_at is null;
  end if;

  update public.student_records
     set student_number = p_new_number, student_number_normalized = v_norm
   where id = p_student;

  insert into public.login_aliases (user_id, alias_type, alias_normalized, created_by)
  values (s.user_id, 'student_number', v_norm, p_actor)
  on conflict (alias_normalized) do nothing;

  insert into public.audit_logs (actor_id, actor_role, event_type, target_type, target_id, category,
                                 old_value, new_value, reason)
  values (p_actor, 'admin', 'student_number_corrected', 'student_records', p_student::text, 'academic',
          jsonb_build_object('student_number', s.student_number),
          jsonb_build_object('student_number', p_new_number), p_reason);

  return jsonb_build_object('ok', true, 'student_number', p_new_number);
end $$;
revoke execute on function public.correct_student_number(uuid,uuid,text,text) from public, anon, authenticated;
grant execute on function public.correct_student_number(uuid,uuid,text,text) to service_role;

-- 8.5 教务查询：待建档队列（已录取 + 总校已确认 + 尚未建档）
create or replace function public.admissions_ready_for_enrollment()
returns table (
  application_id uuid, applicant_id uuid, display_name text, email text,
  program_code text, pathway text, approval_reference text, confirmed_at timestamptz
)
language sql stable security definer set search_path = '' as $$
  select a.id, a.applicant_id, p.display_name, p.email,
         a.form_data #>> '{programs,0}', a.pathway::text,
         h.approval_reference, h.confirmed_at
  from public.applications a
  join public.application_hq_approvals h on h.application_id = a.id and h.status = 'approved'
  join public.profiles p on p.id = a.applicant_id
  where a.status = 'accepted'
    and not exists (select 1 from public.student_records s where s.user_id = a.applicant_id)
    and public.is_admin_any(auth.uid())          -- 定义者权限下必须自行复核调用者
  order by h.confirmed_at;
$$;
revoke execute on function public.admissions_ready_for_enrollment() from public, anon;
grant execute on function public.admissions_ready_for_enrollment() to authenticated;
