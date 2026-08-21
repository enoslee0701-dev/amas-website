-- ============================================================
-- AMAS 招生后台数据库初始化脚本
-- 用法：Supabase 控制台 → SQL Editor → 粘贴全部 → Run
-- ============================================================

create table if not exists public.submissions (
  id          bigint generated always as identity primary key,
  created_at  timestamptz not null default now(),
  type        text not null,            -- application / inquiry / chat / registration
  name        text not null default '',
  contact     text not null default '',
  program     text not null default '',
  lang        text not null default '',
  status      text not null default '待处理',   -- 待处理 / 已联系 / 已录取 / 不合适
  note        text not null default '',
  data        jsonb
);

alter table public.submissions enable row level security;

-- 访客（匿名）只允许写入，不能读、不能改、不能删
drop policy if exists anon_insert on public.submissions;
create policy anon_insert on public.submissions
  for insert to anon with check (true);

-- 登录的管理员可以读取与更新
drop policy if exists auth_select on public.submissions;
create policy auth_select on public.submissions
  for select to authenticated using (true);

drop policy if exists auth_update on public.submissions;
create policy auth_update on public.submissions
  for update to authenticated using (true) with check (true);

-- ============================================================
-- 建管理员账号（二选一）：
-- A. 控制台 → Authentication → Users → Add user → 填邮箱+密码（勾选 Auto Confirm）
-- B. 或直接在此追加执行：
--    select auth.admin 相关接口仅服务端可用，建议用方式 A。
-- 之后用该邮箱+密码登录 /admin.html
-- ============================================================
