-- ============================================================
-- 0041_site_content · 通知公告、线上课堂入口、开学导言视频、首页开课状态
--
-- 2026-10-26 Enos：
--   * 要有通知公告（学员登录能看到，公开的也挂在官网上）
--   * 每次线上学习允许旁听，网站要有一点就能进会议的入口（Zoom 会议号 / 链接由后台填）
--   * 上传第一次学习的内容作为课程介绍与开学导言（视频放在视频网站，这里只存链接）
--   * 首页「10月班已开课 · 11月班招生中」跟着后台班级状态自动变
-- 官网是匿名访客，只能经下面三个只读函数拿到**标了公开**的内容，表本身不对 anon 开放。
-- 注意：同库里的 app_announcements 属于 AMAS 手机 App，这里另起 site_announcements，互不干扰。
-- ============================================================

-- ---------- 1. 通知公告 ----------
create table if not exists public.site_announcements (
  id          uuid primary key default gen_random_uuid(),
  title       text not null check (length(btrim(title)) between 1 and 120),
  body        text not null default '' check (length(body) <= 5000),
  audience    text not null default 'students' check (audience in ('public', 'students')),
  pinned      boolean not null default false,
  published   boolean not null default true,
  created_by  uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
comment on table public.site_announcements is '官网 / 门户通知公告（0041）。public = 官网也显示；students = 只给登录的学员与同工';

drop trigger if exists site_announcements_set_updated_at on public.site_announcements;
create trigger site_announcements_set_updated_at before update on public.site_announcements
  for each row execute function public.set_updated_at();

alter table public.site_announcements enable row level security;
revoke all on public.site_announcements from anon;
drop policy if exists sa_admin on public.site_announcements;
create policy sa_admin on public.site_announcements for all to authenticated
  using (public.is_admin_any(auth.uid())) with check (public.is_admin_any(auth.uid()));

-- ---------- 2. 网站设置（线上课堂、开学导言视频） ----------
create table if not exists public.site_settings (
  key         text primary key check (key in ('live_class', 'intro_video')),
  value       jsonb not null default '{}'::jsonb,
  updated_by  uuid references public.profiles(id) on delete set null,
  updated_at  timestamptz not null default now()
);
comment on table public.site_settings is '官网可公开的设置项（0041）：live_class 线上课堂入口；intro_video 开学导言视频';
drop trigger if exists site_settings_set_updated_at on public.site_settings;
create trigger site_settings_set_updated_at before update on public.site_settings
  for each row execute function public.set_updated_at();
alter table public.site_settings enable row level security;
revoke all on public.site_settings from anon;
drop policy if exists ss_admin on public.site_settings;
create policy ss_admin on public.site_settings for all to authenticated
  using (public.is_admin_any(auth.uid())) with check (public.is_admin_any(auth.uid()));
insert into public.site_settings (key, value) values
  ('live_class', '{"enabled": false, "allow_guests": true}'::jsonb),
  ('intro_video', '{"enabled": false}'::jsonb)
on conflict (key) do nothing;

-- ---------- 3. 班级在官网上的状态 ----------
alter table public.submission_cohorts add column if not exists phase text not null default 'enrolling'
  check (phase in ('enrolling', 'in_session', 'finished'));
alter table public.submission_cohorts add column if not exists show_on_site boolean not null default true;
comment on column public.submission_cohorts.phase is '官网显示：enrolling 招生中 / in_session 已开课 / finished 已结业（0041）';

-- ---------- 4. 官网（匿名）只读入口 ----------
-- 首页开课状态 + 线上课堂 + 开学导言 + 公开公告，一次取齐（官网少一次往返）
create or replace function public.site_public()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'cohorts', coalesce((select jsonb_agg(jsonb_build_object('name', c.name, 'phase', c.phase, 'starts_on', c.starts_on)
                                          order by c.sort, c.name)
                           from public.submission_cohorts c where c.show_on_site), '[]'::jsonb),
    'live_class', coalesce((select case when (s.value->>'enabled')::boolean and (s.value->>'allow_guests')::boolean
                                        then s.value - 'passcode_private' else '{"enabled": false}'::jsonb end
                              from public.site_settings s where s.key = 'live_class'), '{"enabled": false}'::jsonb),
    'intro_video', coalesce((select case when (s.value->>'enabled')::boolean then s.value else '{"enabled": false}'::jsonb end
                               from public.site_settings s where s.key = 'intro_video'), '{"enabled": false}'::jsonb),
    'announcements', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'title', a.title, 'body', a.body,
                                                                    'pinned', a.pinned, 'created_at', a.created_at)
                                                 order by a.pinned desc, a.created_at desc)
                                 from (select * from public.site_announcements
                                        where published and audience = 'public'
                                        order by pinned desc, created_at desc limit 10) a), '[]'::jsonb));
$$;
revoke execute on function public.site_public() from public;
grant execute on function public.site_public() to anon, authenticated;

-- 登录后的门户：学员 / 同工能看到全部已发布公告与线上课堂（不论是否允许旁听）
create or replace function public.portal_board()
returns jsonb language sql stable security definer set search_path = '' as $$
  select case when auth.uid() is null then null else jsonb_build_object(
    'announcements', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'title', a.title, 'body', a.body,
                                                                    'audience', a.audience, 'pinned', a.pinned, 'created_at', a.created_at)
                                                 order by a.pinned desc, a.created_at desc)
                                 from (select * from public.site_announcements where published
                                        order by pinned desc, created_at desc limit 30) a), '[]'::jsonb),
    'live_class', coalesce((select case when (s.value->>'enabled')::boolean then s.value else '{"enabled": false}'::jsonb end
                              from public.site_settings s where s.key = 'live_class'), '{"enabled": false}'::jsonb),
    'intro_video', coalesce((select case when (s.value->>'enabled')::boolean then s.value else '{"enabled": false}'::jsonb end
                               from public.site_settings s where s.key = 'intro_video'), '{"enabled": false}'::jsonb)) end;
$$;
revoke execute on function public.portal_board() from public, anon;
grant execute on function public.portal_board() to authenticated;
