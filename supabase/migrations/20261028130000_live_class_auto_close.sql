-- 线上课堂自动关闭（Enos 2026-10-28：Zoom 链接每次上课自己贴）。
-- 总览「开课堂」写入 live_class.close_at；过了这个时间，官网和学员中心都不再给出入口，
-- 免得允许旁听的会议链接一直挂在官网上。没有 close_at（公告与课堂页手动开的）照旧一直显示。
-- 其余内容与 0041 相同。
create or replace function public.site_public()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'cohorts', coalesce((select jsonb_agg(jsonb_build_object('name', c.name, 'phase', c.phase, 'starts_on', c.starts_on)
                                          order by c.sort, c.name)
                           from public.submission_cohorts c where c.show_on_site), '[]'::jsonb),
    'live_class', coalesce((select case when (s.value->>'enabled')::boolean and (s.value->>'allow_guests')::boolean
                                        and coalesce((s.value->>'close_at')::timestamptz > now(), true)
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
    'live_class', coalesce((select case when (s.value->>'enabled')::boolean and coalesce((s.value->>'close_at')::timestamptz > now(), true)
                                        then s.value else '{"enabled": false}'::jsonb end
                              from public.site_settings s where s.key = 'live_class'), '{"enabled": false}'::jsonb),
    'intro_video', coalesce((select case when (s.value->>'enabled')::boolean then s.value else '{"enabled": false}'::jsonb end
                               from public.site_settings s where s.key = 'intro_video'), '{"enabled": false}'::jsonb)) end;
$$;
revoke execute on function public.portal_board() from public, anon;
grant execute on function public.portal_board() to authenticated;
