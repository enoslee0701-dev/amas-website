-- ============================================================
-- 0004_teacher_verification · Phase 2 教师验证闭环（规范 §6 / §11.2 / §18.5）
-- 原则：邀请一次性/限时/绑定邮箱；库中只存邀请码哈希；
--       审核通过与角色授予同一事务；教师不能自授角色；
--       暂停/撤销即时失权（角色实时查询，不依赖 JWT 内容）。
-- ============================================================

do $$ begin
  create type teacher_verification_status as enum
    ('invited','draft','email_verified','submitted','needs_information',
     'approved','rejected','expired','suspended','revoked');
exception when duplicate_object then null; end $$;

do $$ begin
  create type teacher_profile_status as enum ('active','leave','suspended','departed');
exception when duplicate_object then null; end $$;

-- ---------- 邀请（只存哈希）----------
create table if not exists public.teacher_invitations (
  id               uuid primary key default gen_random_uuid(),
  email_normalized text not null,
  expected_name    text not null default '',
  staff_number     text,
  token_hash       text not null unique,          -- sha256(base64url_token)
  expires_at       timestamptz not null,
  max_uses         int not null default 1,
  used_count       int not null default 0,
  created_by       uuid not null references public.profiles(id),
  revoked_at       timestamptz,
  created_at       timestamptz not null default now(),
  constraint uses_within_limit check (used_count <= max_uses)
);
create index if not exists teacher_invitations_email on public.teacher_invitations (email_normalized);

-- ---------- 验证申请（申请人可见字段与内部备注分表，杜绝混用）----------
create table if not exists public.teacher_verification_requests (
  id                        uuid primary key default gen_random_uuid(),
  user_id                   uuid not null references public.profiles(id) on delete cascade,
  invitation_id             uuid references public.teacher_invitations(id),
  status                    teacher_verification_status not null default 'draft',
  submitted_data            jsonb not null default '{}'::jsonb,
  public_profile_consent    boolean not null default false,
  submitted_at              timestamptz,
  reviewed_by               uuid references public.profiles(id),
  reviewed_at               timestamptz,
  applicant_visible_message text,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);
create unique index if not exists tvr_one_active_per_user
  on public.teacher_verification_requests (user_id)
  where status not in ('rejected','expired','revoked');

create table if not exists public.teacher_verification_internal (
  request_id uuid primary key references public.teacher_verification_requests(id) on delete cascade,
  notes      text not null default '',
  updated_by uuid,
  updated_at timestamptz not null default now()
);

drop trigger if exists tvr_set_updated_at on public.teacher_verification_requests;
create trigger tvr_set_updated_at before update on public.teacher_verification_requests
  for each row execute function public.set_updated_at();

-- ---------- 教师档案 ----------
create table if not exists public.teacher_profiles (
  user_id                  uuid primary key references public.profiles(id) on delete cascade,
  staff_number             text unique,
  public_name              text not null default '',
  public_bio               text,
  status                   teacher_profile_status not null default 'active',
  verified_at              timestamptz not null default now(),
  verification_expires_at  timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);
create table if not exists public.teacher_profiles_internal (
  user_id    uuid primary key references public.teacher_profiles(user_id) on delete cascade,
  notes      text not null default '',
  updated_by uuid,
  updated_at timestamptz not null default now()
);
drop trigger if exists teacher_profiles_set_updated_at on public.teacher_profiles;
create trigger teacher_profiles_set_updated_at before update on public.teacher_profiles
  for each row execute function public.set_updated_at();

-- ---------- 状态机校验（§6.6 允许的迁移之外一律拒绝）----------
create or replace function public.tvr_validate_transition()
returns trigger language plpgsql set search_path = '' as $$
declare ok boolean := false;
begin
  if old.status = new.status then return new; end if;
  ok := (old.status, new.status) in (
    ('invited','draft'), ('draft','email_verified'), ('email_verified','submitted'),
    ('draft','submitted'),                              -- 邮箱已在账号层验证的快捷路径
    ('submitted','approved'), ('submitted','needs_information'), ('submitted','rejected'),
    ('needs_information','submitted'),
    ('approved','suspended'), ('approved','revoked'),
    ('suspended','approved'), ('suspended','revoked'),
    ('invited','expired'), ('draft','expired')
  );
  if not ok then
    raise exception 'invalid teacher verification transition: % -> %', old.status, new.status;
  end if;
  -- 终审动作只能由受保护流程执行（服务端连接 auth.uid() 为空；申请人自身禁止）
  if new.status in ('approved','rejected','needs_information','suspended','revoked')
     and auth.uid() is not null
     and not public.is_admin_any(auth.uid()) then
    raise exception 'review transitions require protected server flow';
  end if;
  return new;
end $$;
drop trigger if exists tvr_transition_guard on public.teacher_verification_requests;
create trigger tvr_transition_guard before update on public.teacher_verification_requests
  for each row execute function public.tvr_validate_transition();

-- ---------- 核心事务：审核 + 角色授予/撤销 原子完成（§18.5/6）----------
-- 仅 service_role（Edge Function 已验证 reviewer 的管理员身份与 MFA aal2）可执行。
create or replace function public.review_teacher_verification(
  p_request uuid, p_reviewer uuid, p_action text,
  p_message text default null, p_staff_number text default null,
  p_grant_mentor boolean default false, p_internal_note text default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  r public.teacher_verification_requests;
  v_new public.teacher_verification_status;
begin
  if not public.is_admin_any(p_reviewer) then
    raise exception 'reviewer lacks admin role';
  end if;
  select * into r from public.teacher_verification_requests where id = p_request for update;
  if not found then raise exception 'request not found'; end if;

  v_new := case p_action
    when 'approve' then 'approved'
    when 'needs_information' then 'needs_information'
    when 'reject' then 'rejected'
    when 'suspend' then 'suspended'
    when 'reinstate' then 'approved'
    when 'revoke' then 'revoked'
    else null end;
  if v_new is null then raise exception 'unknown action %', p_action; end if;

  update public.teacher_verification_requests
     set status = v_new, reviewed_by = p_reviewer, reviewed_at = now(),
         applicant_visible_message = coalesce(p_message, applicant_visible_message)
   where id = p_request;

  if p_internal_note is not null then
    insert into public.teacher_verification_internal (request_id, notes, updated_by)
    values (p_request, p_internal_note, p_reviewer)
    on conflict (request_id) do update
      set notes = public.teacher_verification_internal.notes || E'\n' || excluded.notes,
          updated_by = excluded.updated_by, updated_at = now();
  end if;

  if p_action in ('approve','reinstate') then
    insert into public.teacher_profiles (user_id, staff_number, public_name, status)
    values (r.user_id, p_staff_number,
            coalesce(r.submitted_data->>'name',''), 'active')
    on conflict (user_id) do update
      set status = 'active',
          staff_number = coalesce(excluded.staff_number, public.teacher_profiles.staff_number);

    insert into public.user_roles (user_id, role, granted_by)
    values (r.user_id, 'teacher', p_reviewer)
    on conflict do nothing;
    update public.user_roles set revoked_at = null
      where user_id = r.user_id and role = 'teacher';
    if p_grant_mentor then
      insert into public.user_roles (user_id, role, granted_by)
      values (r.user_id, 'mentor', p_reviewer)
      on conflict do nothing;
      update public.user_roles set revoked_at = null
        where user_id = r.user_id and role = 'mentor';
    end if;
    if p_staff_number is not null then
      insert into public.login_aliases (user_id, alias_type, alias_normalized, created_by)
      values (r.user_id, 'staff_number', upper(replace(p_staff_number,' ','')), p_reviewer)
      on conflict (alias_normalized) do nothing;
    end if;
  elsif p_action in ('suspend','revoke') then
    update public.user_roles set revoked_at = now()
      where user_id = r.user_id and role in ('teacher','mentor') and revoked_at is null;
    update public.teacher_profiles
      set status = case when p_action = 'suspend' then 'suspended'::public.teacher_profile_status
                        else 'departed'::public.teacher_profile_status end
      where user_id = r.user_id;
    update public.login_aliases set revoked_at = now()
      where user_id = r.user_id and alias_type = 'staff_number' and revoked_at is null;
  end if;

  insert into public.audit_logs (actor_id, actor_role, event_type, target_type, target_id,
                                 category, old_value, new_value, reason)
  values (p_reviewer, 'admin', 'teacher_verification_' || p_action,
          'teacher_verification_requests', p_request::text, 'academic',
          jsonb_build_object('status', r.status),
          jsonb_build_object('status', v_new, 'grant_mentor', p_grant_mentor),
          p_message);

  return jsonb_build_object('ok', true, 'status', v_new);
end $$;
revoke execute on function public.review_teacher_verification(uuid,uuid,text,text,text,boolean,text)
  from public, anon, authenticated;
grant execute on function public.review_teacher_verification(uuid,uuid,text,text,text,boolean,text)
  to service_role;

-- 邀请核销（原子：条件自增，一次性/限时/未撤销）
create or replace function public.consume_teacher_invitation(p_token_hash text, p_email text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  update public.teacher_invitations
     set used_count = used_count + 1
   where token_hash = p_token_hash
     and revoked_at is null
     and expires_at > now()
     and used_count < max_uses
     and email_normalized = lower(trim(p_email))
  returning id into v_id;
  if v_id is null then raise exception 'invitation invalid'; end if;
  return v_id;
end $$;
revoke execute on function public.consume_teacher_invitation(text,text) from public, anon, authenticated;
grant execute on function public.consume_teacher_invitation(text,text) to service_role;

-- 本人验证状态（仅安全字段，§6.8）
create or replace function public.my_teacher_verification()
returns table (id uuid, status text, submitted_at timestamptz, reviewed_at timestamptz,
               applicant_visible_message text, updated_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select q.id, q.status::text, q.submitted_at, q.reviewed_at,
         q.applicant_visible_message, q.updated_at
  from public.teacher_verification_requests q
  where q.user_id = auth.uid()
  order by q.created_at desc limit 1;
$$;
revoke execute on function public.my_teacher_verification() from public, anon;
grant execute on function public.my_teacher_verification() to authenticated;

-- ---------- RLS ----------
alter table public.teacher_invitations enable row level security;
alter table public.teacher_verification_requests enable row level security;
alter table public.teacher_verification_internal enable row level security;
alter table public.teacher_profiles enable row level security;
alter table public.teacher_profiles_internal enable row level security;

-- 邀请：仅管理员可读；一切写入走服务端
drop policy if exists ti_admin_select on public.teacher_invitations;
create policy ti_admin_select on public.teacher_invitations
  for select to authenticated using (public.is_admin_any(auth.uid()));
revoke insert, update, delete on public.teacher_invitations from anon, authenticated;

-- 验证申请：本人读自己的行（内部备注在独立表，天然隔离 #TV-013）；管理员读全部
drop policy if exists tvr_self_select on public.teacher_verification_requests;
create policy tvr_self_select on public.teacher_verification_requests
  for select to authenticated
  using (user_id = auth.uid() or public.is_admin_any(auth.uid()));
-- 本人可建草稿、在 draft/needs_information 阶段修改资料；状态跃迁由触发器把关
drop policy if exists tvr_self_insert on public.teacher_verification_requests;
create policy tvr_self_insert on public.teacher_verification_requests
  for insert to authenticated
  with check (user_id = auth.uid() and status = 'draft');
drop policy if exists tvr_self_update on public.teacher_verification_requests;
create policy tvr_self_update on public.teacher_verification_requests
  for update to authenticated
  using (user_id = auth.uid() and status in ('draft','needs_information'))
  with check (user_id = auth.uid());

-- 内部备注：仅管理员
drop policy if exists tvi_admin_all on public.teacher_verification_internal;
create policy tvi_admin_all on public.teacher_verification_internal
  for select to authenticated using (public.is_admin_any(auth.uid()));
revoke insert, update, delete on public.teacher_verification_internal from anon, authenticated;

-- 教师档案：本人 + 管理员可读；写入走服务端
drop policy if exists tp_select on public.teacher_profiles;
create policy tp_select on public.teacher_profiles
  for select to authenticated
  using (user_id = auth.uid() or public.is_admin_any(auth.uid()));
revoke insert, update, delete on public.teacher_profiles from anon, authenticated;
drop policy if exists tpi_admin on public.teacher_profiles_internal;
create policy tpi_admin on public.teacher_profiles_internal
  for select to authenticated using (public.is_admin_any(auth.uid()));
revoke insert, update, delete on public.teacher_profiles_internal from anon, authenticated;
