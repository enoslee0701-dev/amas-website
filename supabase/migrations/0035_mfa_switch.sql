-- ============================================================
-- 0035_mfa_switch · 两步验证开关（Enos 2026-10-23：「先隐藏，暂时不用」）
--
-- 管理员与教授原本一律要求两步验证（aal2），由三层分别强制：页面守卫、Edge Function、数据库 RPC。
-- 这里加一个**全站唯一**的开关，三层都读它：
--   · 默认 = 开（true）。迁移装上后行为与之前完全一样；
--   · 读不到 / 读出非布尔值 = 按「开」处理（fail-closed）；
--   · 只有显式设为 false 才放行 aal1。
-- 关闭方式（只能由数据库所有者在 SQL Editor 执行，客户端无写权限）：
--   update public.portal_settings set value = 'false' where key = 'mfa_required';
-- 恢复：把 'false' 改回 'true'。
-- ============================================================

create table if not exists public.portal_settings (
  key        text primary key,
  value      jsonb not null,
  note       text,
  updated_at timestamptz not null default now()
);
insert into public.portal_settings (key, value, note) values
  ('mfa_required', 'true', '管理员 / 教授是否必须两步验证；false = 暂时不要求（Enos 2026-10-23 要求可关闭）')
on conflict (key) do nothing;

alter table public.portal_settings enable row level security;
revoke all on public.portal_settings from anon, authenticated;

create or replace function public.mfa_required()
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((select value = 'false'::jsonb from public.portal_settings where key = 'mfa_required'), false) is not true;
$$;
comment on function public.mfa_required is
  '两步验证开关。只有 portal_settings.mfa_required 明确为 false 才返回 false；缺行、读不到一律返回 true。';
revoke execute on function public.mfa_required() from public, anon;
grant execute on function public.mfa_required() to authenticated, service_role;

-- 数据库层（教授 / 导师写入）：开关关闭时视同已两步验证
create or replace function public.request_is_aal2()
returns boolean language sql stable set search_path = '' as $$
  select not public.mfa_required()
      or coalesce((nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'aal') = 'aal2', false);
$$;
