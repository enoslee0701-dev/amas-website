-- ============================================================
-- 0008_applications · PORTAL-1 招生申请域
-- 依据：PORTAL-blueprint §2.1/§3.1，甲方最终规则 P1/P3/P4/P9，
--       字段映射 docs/operations/PORTAL-application-field-mapping.md
-- 硬约束：
--   * accepted ≠ 学籍；建档另见 0009（需 AMAS 总校审核确认记录）
--   * D-4/D-5/D-6（教会类型/家庭状况/健康状况）V1 不实现，表单与校验均不含
--   * 不含 waitlisted；不含文件上传（Documents Center 未批准）
--   * 内部备注与申请人可见说明物理分表（沿用 0004 模式）
-- ============================================================

do $$ begin
  create type application_pathway as enum ('bth','common_learning','undecided');
exception when duplicate_object then null; end $$;

do $$ begin
  create type application_status as enum
    ('draft','submitted','under_review','needs_information','accepted','rejected','withdrawn');
exception when duplicate_object then null; end $$;

-- ---------- 主表 ----------
create table if not exists public.applications (
  id                        uuid primary key default gen_random_uuid(),
  applicant_id              uuid not null references public.profiles(id) on delete cascade,
  pathway                   application_pathway not null default 'undecided',
  status                    application_status not null default 'draft',
  form_data                 jsonb not null default '{}'::jsonb,
  form_version              text not null default 'v1',
  locked_fields             text[] not null default '{}',
  assigned_reviewer         uuid references public.profiles(id) on delete set null,
  applicant_visible_message text,
  submitted_at              timestamptz,
  decided_at                timestamptz,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);
comment on table public.applications is
  'PORTAL-1 正式入学申请。form_data 为白名单字段集（见字段映射文档 v1）；accepted 不等于学籍建立。';

-- 每人同时只能有一份「活动」申请（终态除外）
create unique index if not exists applications_one_active
  on public.applications (applicant_id)
  where status not in ('rejected','withdrawn');

create index if not exists applications_queue
  on public.applications (status, submitted_at desc nulls last);
create index if not exists applications_reviewer
  on public.applications (assigned_reviewer) where assigned_reviewer is not null;

drop trigger if exists applications_set_updated_at on public.applications;
create trigger applications_set_updated_at before update on public.applications
  for each row execute function public.set_updated_at();

-- ---------- 内部备注（仅管理员）----------
create table if not exists public.application_internal (
  application_id uuid primary key references public.applications(id) on delete cascade,
  notes          text not null default '',
  updated_by     uuid references public.profiles(id) on delete set null,
  updated_at     timestamptz not null default now()
);

-- ---------- 状态时间线 ----------
create table if not exists public.application_status_history (
  id                        bigint generated always as identity primary key,
  application_id            uuid not null references public.applications(id) on delete cascade,
  from_status               application_status,
  to_status                 application_status not null,
  actor_id                  uuid references public.profiles(id) on delete set null,
  actor_role                text,
  applicant_visible_message text,
  internal_note             text,          -- 申请人视图经 RPC 剔除
  created_at                timestamptz not null default now()
);
create index if not exists ash_by_app on public.application_status_history (application_id, created_at);

-- ---------- 补件条目 ----------
create table if not exists public.application_requirements (
  id             uuid primary key default gen_random_uuid(),
  application_id uuid not null references public.applications(id) on delete cascade,
  label          text not null,
  detail         text,
  resolved       boolean not null default false,
  created_by     uuid references public.profiles(id) on delete set null,
  created_at     timestamptz not null default now(),
  resolved_at    timestamptz
);
create index if not exists areq_by_app on public.application_requirements (application_id, resolved);

-- ============================================================
-- 状态机（白名单迁移；终审动作仅受保护流程）
-- ============================================================
create or replace function public.application_validate_transition()
returns trigger language plpgsql set search_path = '' as $$
declare ok boolean := false;
begin
  if old.status = new.status then return new; end if;

  ok := (old.status::text, new.status::text) in (
    ('draft','submitted'),
    ('draft','withdrawn'),
    ('submitted','under_review'), ('submitted','needs_information'),
    ('submitted','accepted'), ('submitted','rejected'), ('submitted','withdrawn'),
    ('under_review','needs_information'), ('under_review','accepted'),
    ('under_review','rejected'), ('under_review','withdrawn'),
    ('needs_information','submitted'), ('needs_information','withdrawn')
  );
  if not ok then
    raise exception 'invalid application transition: % -> %', old.status, new.status;
  end if;

  -- 审核类迁移必须来自受保护服务端（auth.uid() 为空）或管理员
  if new.status::text in ('under_review','needs_information','accepted','rejected')
     and auth.uid() is not null
     and not public.is_admin_any(auth.uid()) then
    raise exception 'review transitions require protected server flow';
  end if;

  -- 终态时间戳
  if new.status::text in ('accepted','rejected') and new.decided_at is null then
    new.decided_at := now();
  end if;
  return new;
end $$;

drop trigger if exists applications_transition_guard on public.applications;
create trigger applications_transition_guard before update on public.applications
  for each row execute function public.application_validate_transition();

-- 提交后锁定字段：任何人（含本人）不得修改 locked_fields 内的键
create or replace function public.application_protect_locked()
returns trigger language plpgsql set search_path = '' as $$
declare k text;
begin
  if old.status::text = 'draft' then return new; end if;   -- 草稿阶段自由编辑
  foreach k in array coalesce(old.locked_fields, '{}') loop
    if (new.form_data -> k) is distinct from (old.form_data -> k) then
      raise exception 'locked field cannot be modified: %', k;
    end if;
  end loop;
  -- 申请人不得自行改 pathway / status / locked_fields / reviewer
  if auth.uid() is not null and auth.uid() = old.applicant_id and not public.is_admin_any(auth.uid()) then
    new.pathway := old.pathway;
    new.locked_fields := old.locked_fields;
    new.assigned_reviewer := old.assigned_reviewer;
    new.applicant_visible_message := old.applicant_visible_message;
    if new.status is distinct from old.status then
      raise exception 'applicant cannot change status directly';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists applications_lock_guard on public.applications;
create trigger applications_lock_guard before update on public.applications
  for each row execute function public.application_protect_locked();

-- ============================================================
-- 表单校验（服务端权威；V1 字段集见字段映射文档）
-- 不含 D-4/D-5/D-6（教会类型 / 家庭状况 / 健康状况）
-- ============================================================
create or replace function public.application_validate_form(p_form jsonb, p_pathway text)
returns text[] language plpgsql immutable set search_path = '' as $$
declare missing text[] := '{}';
  f text;
begin
  foreach f in array array[
    'name_zh','birth_ym','gender','nationality','phone','address',
    'church_name','church_role','conversion_date',
    'calling','testimony','declaration_accepted'
  ] loop
    if coalesce(btrim(p_form ->> f), '') = '' or (p_form ->> f) = 'false' then
      missing := missing || f::text;
    end if;
  end loop;

  if coalesce(jsonb_array_length(p_form -> 'programs'), 0) = 0 then
    missing := missing || 'programs'::text;
  end if;
  if coalesce(jsonb_array_length(p_form -> 'languages'), 0) = 0 then
    missing := missing || 'languages'::text;
  end if;
  if coalesce(jsonb_array_length(p_form -> 'education'), 0) = 0 then
    missing := missing || 'education'::text;
  end if;
  if p_pathway is null or p_pathway = 'undecided' then
    missing := missing || 'pathway'::text;
  end if;
  return missing;
end $$;

-- ============================================================
-- RPC：申请人侧
-- ============================================================
create or replace function public.my_application()
returns table (
  id uuid, pathway text, status text, form_data jsonb, form_version text,
  locked_fields text[], applicant_visible_message text,
  submitted_at timestamptz, decided_at timestamptz, updated_at timestamptz
) language sql stable security definer set search_path = '' as $$
  select a.id, a.pathway::text, a.status::text, a.form_data, a.form_version,
         a.locked_fields, a.applicant_visible_message,
         a.submitted_at, a.decided_at, a.updated_at
  from public.applications a
  where a.applicant_id = auth.uid()
    and a.status not in ('rejected','withdrawn')
  order by a.created_at desc limit 1;
$$;
revoke execute on function public.my_application() from public, anon;
grant execute on function public.my_application() to authenticated;

create or replace function public.my_application_timeline(p_app uuid)
returns table (to_status text, applicant_visible_message text, created_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select h.to_status::text, h.applicant_visible_message, h.created_at
  from public.application_status_history h
  join public.applications a on a.id = h.application_id
  where h.application_id = p_app and a.applicant_id = auth.uid()
  order by h.created_at;          -- 内部备注不返回
$$;
revoke execute on function public.my_application_timeline(uuid) from public, anon;
grant execute on function public.my_application_timeline(uuid) to authenticated;

-- 提交（draft / needs_information → submitted）
create or replace function public.submit_application(p_app uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare a public.applications; missing text[]; unresolved int;
begin
  select * into a from public.applications
   where id = p_app and applicant_id = auth.uid() for update;
  if not found then raise exception 'not_found'; end if;
  if a.status::text not in ('draft','needs_information') then
    raise exception 'invalid_state';
  end if;

  missing := public.application_validate_form(a.form_data, a.pathway::text);
  if array_length(missing,1) > 0 then
    return jsonb_build_object('ok', false, 'error', 'validation_failed', 'missing', to_jsonb(missing));
  end if;

  if a.status::text = 'needs_information' then
    select count(*) into unresolved from public.application_requirements
     where application_id = p_app and resolved = false;
    if unresolved > 0 then
      return jsonb_build_object('ok', false, 'error', 'requirements_pending', 'count', unresolved);
    end if;
  end if;

  update public.applications
     set status = 'submitted',
         submitted_at = coalesce(submitted_at, now()),
         locked_fields = array['name_zh','birth_ym','gender','nationality','conversion_date','baptism_date','programs']
   where id = p_app;

  insert into public.application_status_history (application_id, from_status, to_status, actor_id, actor_role)
  values (p_app, a.status, 'submitted', auth.uid(), 'applicant');

  insert into public.audit_logs (actor_id, actor_role, event_type, target_type, target_id, category,
                                 old_value, new_value)
  values (auth.uid(), 'applicant', 'application_submitted', 'applications', p_app::text, 'admissions',
          jsonb_build_object('status', a.status), jsonb_build_object('status','submitted'));

  return jsonb_build_object('ok', true, 'status', 'submitted');
end $$;
revoke execute on function public.submit_application(uuid) from public, anon;
grant execute on function public.submit_application(uuid) to authenticated;

-- 撤回
create or replace function public.withdraw_application(p_app uuid, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare a public.applications;
begin
  select * into a from public.applications
   where id = p_app and applicant_id = auth.uid() for update;
  if not found then raise exception 'not_found'; end if;
  if a.status::text in ('accepted','rejected','withdrawn') then raise exception 'invalid_state'; end if;

  update public.applications set status = 'withdrawn' where id = p_app;
  insert into public.application_status_history (application_id, from_status, to_status, actor_id, actor_role, applicant_visible_message)
  values (p_app, a.status, 'withdrawn', auth.uid(), 'applicant', p_reason);
  insert into public.audit_logs (actor_id, actor_role, event_type, target_type, target_id, category, old_value, new_value, reason)
  values (auth.uid(), 'applicant', 'application_withdrawn', 'applications', p_app::text, 'admissions',
          jsonb_build_object('status', a.status), jsonb_build_object('status','withdrawn'), p_reason);
  return jsonb_build_object('ok', true);
end $$;
revoke execute on function public.withdraw_application(uuid, text) from public, anon;
grant execute on function public.withdraw_application(uuid, text) to authenticated;

-- ============================================================
-- RPC：审核侧（service_role 专用；Edge 已校验角色 + aal2）
-- ============================================================
create or replace function public.review_application(
  p_app uuid, p_reviewer uuid, p_action text,
  p_message text default null, p_requirements jsonb default null,
  p_internal_note text default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare a public.applications; v_new public.application_status; r jsonb;
begin
  if not public.is_admin_any(p_reviewer) then raise exception 'reviewer lacks admin role'; end if;
  select * into a from public.applications where id = p_app for update;
  if not found then raise exception 'not_found'; end if;

  v_new := case p_action
    when 'start_review'      then 'under_review'
    when 'needs_information' then 'needs_information'
    when 'accept'            then 'accepted'
    when 'reject'            then 'rejected'
    else null end::public.application_status;
  if v_new is null then raise exception 'unknown action %', p_action; end if;

  update public.applications
     set status = v_new,
         assigned_reviewer = coalesce(assigned_reviewer, p_reviewer),
         applicant_visible_message = coalesce(p_message, applicant_visible_message)
   where id = p_app;

  -- 条目化补件
  if p_action = 'needs_information' and p_requirements is not null then
    for r in select * from jsonb_array_elements(p_requirements) loop
      insert into public.application_requirements (application_id, label, detail, created_by)
      values (p_app, coalesce(r ->> 'label','补充资料'), r ->> 'detail', p_reviewer);
    end loop;
  end if;

  if p_internal_note is not null then
    insert into public.application_internal (application_id, notes, updated_by)
    values (p_app, p_internal_note, p_reviewer)
    on conflict (application_id) do update
      set notes = public.application_internal.notes || E'\n' || excluded.notes,
          updated_by = excluded.updated_by, updated_at = now();
  end if;

  insert into public.application_status_history
    (application_id, from_status, to_status, actor_id, actor_role, applicant_visible_message, internal_note)
  values (p_app, a.status, v_new, p_reviewer, 'admin', p_message, p_internal_note);

  insert into public.audit_logs (actor_id, actor_role, event_type, target_type, target_id, category,
                                 old_value, new_value, reason)
  values (p_reviewer, 'admin', 'application_' || p_action, 'applications', p_app::text, 'admissions',
          jsonb_build_object('status', a.status), jsonb_build_object('status', v_new), p_message);

  return jsonb_build_object('ok', true, 'status', v_new);
end $$;
revoke execute on function public.review_application(uuid,uuid,text,text,jsonb,text) from public, anon, authenticated;
grant execute on function public.review_application(uuid,uuid,text,text,jsonb,text) to service_role;

-- 申请人标记补件条目完成
create or replace function public.resolve_requirement(p_req uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_app uuid;
begin
  select r.application_id into v_app
    from public.application_requirements r
    join public.applications a on a.id = r.application_id
   where r.id = p_req and a.applicant_id = auth.uid();
  if v_app is null then raise exception 'not_found'; end if;
  update public.application_requirements
     set resolved = true, resolved_at = now() where id = p_req;
  return jsonb_build_object('ok', true);
end $$;
revoke execute on function public.resolve_requirement(uuid) from public, anon;
grant execute on function public.resolve_requirement(uuid) to authenticated;

-- ============================================================
-- RLS
-- ============================================================
alter table public.applications enable row level security;
alter table public.application_internal enable row level security;
alter table public.application_status_history enable row level security;
alter table public.application_requirements enable row level security;

-- 申请人：读自己的；建自己的 draft；仅在 draft/needs_information 阶段改
drop policy if exists app_self_select on public.applications;
create policy app_self_select on public.applications
  for select to authenticated
  using (applicant_id = auth.uid() or public.is_admin_any(auth.uid()));

drop policy if exists app_self_insert on public.applications;
create policy app_self_insert on public.applications
  for insert to authenticated
  with check (applicant_id = auth.uid() and status = 'draft');

drop policy if exists app_self_update on public.applications;
create policy app_self_update on public.applications
  for update to authenticated
  using ((applicant_id = auth.uid() and status in ('draft','needs_information'))
         or public.is_admin_any(auth.uid()))
  with check (applicant_id = auth.uid() or public.is_admin_any(auth.uid()));
-- 无 delete 策略：申请只能撤回，不能删除（留痕）

-- 内部备注：仅管理员
drop policy if exists appint_admin on public.application_internal;
create policy appint_admin on public.application_internal
  for select to authenticated using (public.is_admin_any(auth.uid()));
revoke insert, update, delete on public.application_internal from anon, authenticated;

-- 时间线：本人可读（internal_note 列不授予）+ 管理员全读
revoke all on public.application_status_history from anon, authenticated;
grant select (id, application_id, from_status, to_status, actor_id, actor_role,
              applicant_visible_message, created_at)
  on public.application_status_history to authenticated;
drop policy if exists ash_select on public.application_status_history;
create policy ash_select on public.application_status_history
  for select to authenticated
  using (exists (select 1 from public.applications a
                 where a.id = application_id
                   and (a.applicant_id = auth.uid() or public.is_admin_any(auth.uid()))));

-- 补件条目：本人可读、可改 resolved（经 RPC）；管理员全读
drop policy if exists areq_select on public.application_requirements;
create policy areq_select on public.application_requirements
  for select to authenticated
  using (exists (select 1 from public.applications a
                 where a.id = application_id
                   and (a.applicant_id = auth.uid() or public.is_admin_any(auth.uid()))));
revoke insert, update, delete on public.application_requirements from anon, authenticated;
