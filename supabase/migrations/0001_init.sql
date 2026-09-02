-- ============================================================
-- AMAS 招生后台 · 数据库初始化迁移（0001_init）
-- 用法：Supabase 控制台 → SQL Editor → 粘贴全部 → Run
--（或 supabase CLI：supabase db push）
--
-- 安全模型：
--   * 前端只使用 anon/publishable key（assets/js/supabase-config.js）
--   * 匿名访客：只能写入（提交表单），不能读/改/删
--   * 管理员：必须通过 Supabase Auth 登录（authenticated 角色）
--     才能读取与更新；删除不开放给任何客户端角色
--   * 严禁把 service_role / secret key 放进任何前端代码或仓库
-- ============================================================

create table if not exists public.submissions (
  id          bigint generated always as identity primary key,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  type        text not null,            -- application / inquiry / chat / giving / upload
  name        text not null default '',
  contact     text not null default '',
  program     text not null default '',
  lang        text not null default '',
  status      text not null default '待处理',   -- 待处理 / 已联系 / 已录取 / 不合适
  note        text not null default '',
  data        jsonb
);

comment on table public.submissions is 'AMAS 官网所有表单提交（申请/咨询/客服留言/同工意向/上传登记）';

-- 常用查询索引
create index if not exists submissions_created_at_idx on public.submissions (created_at desc);
create index if not exists submissions_type_idx       on public.submissions (type);
create index if not exists submissions_status_idx     on public.submissions (status);

-- updated_at 自动维护
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists submissions_set_updated_at on public.submissions;
create trigger submissions_set_updated_at
  before update on public.submissions
  for each row execute function public.set_updated_at();

-- ============================================================
-- RLS：默认拒绝一切；只开放下面三条
-- ============================================================
alter table public.submissions enable row level security;

-- 匿名访客：仅允许写入（网站表单提交）
drop policy if exists anon_insert on public.submissions;
create policy anon_insert on public.submissions
  for insert to anon with check (true);

-- 登录管理员：可读取
drop policy if exists auth_select on public.submissions;
create policy auth_select on public.submissions
  for select to authenticated using (true);

-- 登录管理员：可更新（改状态、写备注）
drop policy if exists auth_update on public.submissions;
create policy auth_update on public.submissions
  for update to authenticated using (true) with check (true);

-- 注意：不创建 delete 策略 = 任何客户端角色都不能删除；
-- 需要删除时由管理员在 Supabase 控制台（服务端权限）操作。
