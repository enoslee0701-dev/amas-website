-- ============================================================
-- AMAS 门户系统 · Phase 1 身份与权限地基（0002_identity）
-- 依据《教师验证与双端门户系统开发总规范 V1.0》§4 / §11.1 / §14 / §18
-- 前置：0001_init.sql（submissions 收件箱，保持不变）
-- ============================================================

-- ---------- 枚举 ----------
do $$ begin
  create type account_status as enum ('pending_email','active','locked','suspended','disabled');
exception when duplicate_object then null; end $$;

do $$ begin
  create type user_role as enum ('applicant','student','teacher','mentor','registrar','finance','content_admin','academic_admin','super_admin');
exception when duplicate_object then null; end $$;

do $$ begin
  create type alias_type as enum ('student_number','staff_number');
exception when duplicate_object then null; end $$;

-- ---------- profiles ----------
create table if not exists public.profiles (
  id             uuid primary key references auth.users(id) on delete cascade,
  display_name   text not null default '',
  legal_name     text,
  email          text not null,
  phone          text,
  country_code   text,
  timezone       text not null default 'Asia/Bangkok',
  locale         text not null default 'zh-CN',
  avatar_path    text,
  account_status account_status not null default 'pending_email',
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
comment on table public.profiles is '用户主档案（1:1 auth.users）。account_status 与角色分离：能否登录 ≠ 登录后身份';

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at before update on public.profiles
  for each row execute function public.set_updated_at();

-- ---------- user_roles（多角色，可带范围与有效期）----------
create table if not exists public.user_roles (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles(id) on delete cascade,
  role       user_role not null,
  scope_type text,
  scope_id   uuid,
  granted_by uuid references public.profiles(id),
  granted_at timestamptz not null default now(),
  expires_at timestamptz,
  revoked_at timestamptz
);
comment on table public.user_roles is '角色授予表。禁止依赖客户端可改的 metadata；同一活动角色/范围唯一';

create unique index if not exists user_roles_active_unique
  on public.user_roles (user_id, role, coalesce(scope_type,''), coalesce(scope_id,'00000000-0000-0000-0000-000000000000'::uuid))
  where revoked_at is null;
create index if not exists user_roles_lookup on public.user_roles (user_id, role, revoked_at);

-- ---------- login_aliases（学号/教职工号 → 账号；严禁公开读）----------
create table if not exists public.login_aliases (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references public.profiles(id) on delete cascade,
  alias_type       alias_type not null,
  alias_normalized text not null unique,
  created_by       uuid references public.profiles(id),
  created_at       timestamptz not null default now(),
  revoked_at       timestamptz
);
comment on table public.login_aliases is '登录别名。仅受保护服务端（Edge Function/教务）可访问；规范 §5.3';
create index if not exists login_aliases_user on public.login_aliases (user_id);

-- ---------- audit_logs（普通用户不可写改）----------
create table if not exists public.audit_logs (
  id          bigint generated always as identity primary key,
  created_at  timestamptz not null default now(),
  actor_id    uuid,
  actor_role  text,
  event_type  text not null,
  target_type text,
  target_id   text,
  old_value   jsonb,
  new_value   jsonb,
  reason      text,
  ip          text,
  user_agent  text
);
comment on table public.audit_logs is '审计日志：只允许服务端写入；禁止保存密码/token/完整作业或申请正文（§17.3）';
create index if not exists audit_logs_actor on public.audit_logs (actor_id, event_type, created_at desc);
create index if not exists audit_logs_target on public.audit_logs (target_type, target_id, created_at desc);

-- ---------- security_events（限流与安全事件）----------
create table if not exists public.security_events (
  id          bigint generated always as identity primary key,
  created_at  timestamptz not null default now(),
  event_type  text not null,          -- login_failed / login_locked / password_reset / mfa_...
  identifier  text,                   -- 规范化后的登录标识（邮箱哈希或学号），不存密码
  user_id     uuid,
  ip          text,
  detail      jsonb
);
create index if not exists security_events_rate on public.security_events (event_type, identifier, created_at desc);
create index if not exists security_events_ip on public.security_events (event_type, ip, created_at desc);

-- ---------- data_export_logs（高权限导出审计，§10.2）----------
create table if not exists public.data_export_logs (
  id          bigint generated always as identity primary key,
  created_at  timestamptz not null default now(),
  actor_id    uuid not null,
  export_type text not null,
  filters     jsonb,
  row_count   int,
  purpose     text
);

-- ---------- 权限辅助函数（稳定、防递归；§14.2）----------
create or replace function public.has_active_role(p_user uuid, p_role text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.user_roles r
    where r.user_id = p_user and r.role::text = p_role
      and r.revoked_at is null
      and (r.expires_at is null or r.expires_at > now())
  );
$$;

create or replace function public.current_user_has_role(p_role text)
returns boolean language sql stable security definer set search_path = public as $$
  select public.has_active_role(auth.uid(), p_role);
$$;

create or replace function public.is_admin_any(p_user uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.has_active_role(p_user,'registrar')
      or public.has_active_role(p_user,'academic_admin')
      or public.has_active_role(p_user,'super_admin');
$$;

-- 预留：课程/导师范围函数在 0005/0006 落地后替换为真实实现
create or replace function public.is_assigned_teacher(p_user uuid, p_offering uuid)
returns boolean language sql stable security definer set search_path = public as $$ select false $$;
create or replace function public.is_enrolled_student(p_user uuid, p_offering uuid)
returns boolean language sql stable security definer set search_path = public as $$ select false $$;
create or replace function public.is_assigned_mentor(p_mentor uuid, p_student uuid)
returns boolean language sql stable security definer set search_path = public as $$ select false $$;

-- ---------- 注册钩子：auth.users → profiles + applicant 角色（§5.2）----------
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, display_name, account_status)
  values (new.id, coalesce(new.email,''),
          coalesce(new.raw_user_meta_data->>'display_name',''),
          case when new.email_confirmed_at is null then 'pending_email'::account_status else 'active'::account_status end)
  on conflict (id) do nothing;

  insert into public.user_roles (user_id, role, granted_by)
  values (new.id, 'applicant', new.id)
  on conflict do nothing;

  insert into public.audit_logs (actor_id, event_type, target_type, target_id)
  values (new.id, 'user_registered', 'profiles', new.id::text);
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- 邮箱确认后自动转 active
create or replace function public.handle_user_email_confirmed()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.email_confirmed_at is not null and old.email_confirmed_at is null then
    update public.profiles set account_status = 'active'
    where id = new.id and account_status = 'pending_email';
  end if;
  return new;
end $$;

drop trigger if exists on_auth_user_confirmed on auth.users;
create trigger on_auth_user_confirmed after update on auth.users
  for each row execute function public.handle_user_email_confirmed();

-- ---------- 角色读取 RPC（前端导航用，仅本人）----------
create or replace function public.my_roles()
returns table(role text, scope_type text, scope_id uuid)
language sql stable security definer set search_path = public as $$
  select r.role::text, r.scope_type, r.scope_id
  from public.user_roles r
  where r.user_id = auth.uid() and r.revoked_at is null
    and (r.expires_at is null or r.expires_at > now());
$$;

create or replace function public.my_profile()
returns public.profiles
language sql stable security definer set search_path = public as $$
  select p.* from public.profiles p where p.id = auth.uid();
$$;

-- ---------- RLS ----------
alter table public.profiles enable row level security;
alter table public.user_roles enable row level security;
alter table public.login_aliases enable row level security;
alter table public.audit_logs enable row level security;
alter table public.security_events enable row level security;
alter table public.data_export_logs enable row level security;

-- profiles：本人可读；本人仅可改基础字段（敏感字段用触发器冻结）；管理员可读
drop policy if exists profiles_self_select on public.profiles;
create policy profiles_self_select on public.profiles
  for select to authenticated using (id = auth.uid() or public.is_admin_any(auth.uid()));

drop policy if exists profiles_self_update on public.profiles;
create policy profiles_self_update on public.profiles
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

create or replace function public.protect_profile_fields()
returns trigger language plpgsql as $$
begin
  if auth.uid() = new.id and not public.is_admin_any(auth.uid()) then
    new.account_status := old.account_status;
    new.email := old.email;   -- 邮箱变更须走 Auth 流程
  end if;
  return new;
end $$;
drop trigger if exists profiles_protect on public.profiles;
create trigger profiles_protect before update on public.profiles
  for each row execute function public.protect_profile_fields();

-- user_roles：本人与管理员可读；任何客户端不可写（只经受保护函数）
drop policy if exists user_roles_select on public.user_roles;
create policy user_roles_select on public.user_roles
  for select to authenticated using (user_id = auth.uid() or public.is_admin_any(auth.uid()));
-- 无 insert/update/delete 策略 = 客户端全部拒绝

-- login_aliases：客户端零访问（无任何策略）；仅 service key 服务端可用

-- audit_logs：仅 super_admin 与 academic_admin 可读；客户端不可写
drop policy if exists audit_logs_select on public.audit_logs;
create policy audit_logs_select on public.audit_logs
  for select to authenticated
  using (public.current_user_has_role('super_admin') or public.current_user_has_role('academic_admin'));

-- security_events / data_export_logs：仅 super_admin 可读
drop policy if exists security_events_select on public.security_events;
create policy security_events_select on public.security_events
  for select to authenticated using (public.current_user_has_role('super_admin'));
drop policy if exists export_logs_select on public.data_export_logs;
create policy export_logs_select on public.data_export_logs
  for select to authenticated using (public.current_user_has_role('super_admin'));

-- ---------- 收尾 ----------
-- 首个 super_admin 由控制台创建用户后，用 service key 在 SQL Editor 手工授予：
--   insert into public.user_roles(user_id, role, granted_by)
--   values ('<admin-user-uuid>','super_admin','<admin-user-uuid>');
-- 此后所有高权限角色变更必须经受保护函数并留审计（§10.9）。
