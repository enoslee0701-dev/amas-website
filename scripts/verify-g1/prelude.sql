-- ============================================================
-- 只为「在一个全新的一次性库里把 27 个迁移装起来」而补的最小垫片。
-- 仓库里的迁移写给 Supabase，用到三样本地 Postgres 没有的东西：
--   · 角色 anon / authenticated / service_role（73 + 26 + 3 处 grant）
--   · schema auth 与 auth.uid()（121 处）
--   · 表 auth.users（profiles 的外键目标，且挂着注册钩子触发器）
-- 这里只补到「迁移能装上、行为可被驱动」为止，**不模拟 Supabase 的任何安全行为**。
-- ============================================================

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon')          then create role anon nologin;          end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role')  then create role service_role nologin;  end if;
end $$;

create schema if not exists auth;

-- 触发器 handle_new_user 读的是这四列（0002_identity.sql:150-156）
create table if not exists auth.users (
  id                 uuid primary key,
  email              text,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  email_confirmed_at timestamptz,
  created_at         timestamptz not null default now()
);

/* auth.uid() 在 Supabase 里读 JWT。这里读一个会话级设置，
   测试用 select set_config('amas.test.uid', '<uuid>', true) 来「变成某个人」；
   设为空串就是「没有登录」（受保护 RPC 路径）。 */
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('amas.test.uid', true), '')::uuid
$$;

grant usage on schema auth to anon, authenticated, service_role;
