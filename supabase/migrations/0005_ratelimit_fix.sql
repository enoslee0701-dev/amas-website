-- ============================================================
-- 0005_ratelimit_fix · SEC-3 验收发现缺陷修复
-- 缺陷：auth_rate_check 以 created_at 与「最后一次成功」比较，
--       同一事务/同一时刻写入的事件时间戳相同（now() 为事务时间），
--       导致成功登录后同刻失败仍被计入 → 计数未真正清零（测试 T07 FAIL）。
-- 修复：改用单调递增主键 id 作为分界点（id > 最后成功事件 id），
--       与时间窗口 AND 组合；严格且不受同刻时间戳影响。
-- ============================================================

create or replace function public.auth_rate_check(p_identifier text, p_ip text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_since    timestamptz := now() - interval '15 minutes';
  v_last_ok  bigint;
  v_id_fails int;
  v_ip_fails int;
begin
  -- 同一标识的判定串行化，杜绝并发竞态下的超额放行
  perform pg_advisory_xact_lock(hashtextextended('amas_login:'||p_identifier, 0));

  -- 最后一次成功登录的事件 id（单调递增，不受同刻时间戳影响）
  select max(id) into v_last_ok
  from public.security_events
  where event_type = 'login_success' and identifier = p_identifier;

  select count(*) into v_id_fails
  from public.security_events
  where event_type = 'login_failed'
    and identifier = p_identifier
    and created_at >= v_since
    and id > coalesce(v_last_ok, 0);

  -- IP 维度：宽阈值辅助（可伪造 header，仅防粗暴扫描；不做成功清零）
  select count(*) into v_ip_fails
  from public.security_events
  where event_type = 'login_failed' and ip = p_ip and created_at >= v_since;

  -- 机会式清理到期记录（每次最多 200 行，避免长事务）
  delete from public.security_events
  where id in (
    select id from public.security_events
    where created_at < now() - interval '48 hours'
      and event_type in ('login_failed','login_success','login_locked')
    limit 200
  );

  if v_id_fails >= 5 or v_ip_fails >= 20 then
    insert into public.security_events (event_type, identifier, ip, detail)
    values ('login_locked', p_identifier, p_ip,
            jsonb_build_object('id_fails', v_id_fails, 'ip_fails', v_ip_fails));
    return jsonb_build_object('allowed', false);
  end if;
  return jsonb_build_object('allowed', true);
end $$;

revoke execute on function public.auth_rate_check(text,text) from public, anon, authenticated;
grant execute on function public.auth_rate_check(text,text) to service_role;

comment on function public.auth_rate_check is
  '登录限流判定（SEC-3 修复版）：advisory lock 串行化；标识维度以最后成功事件 id 为分界，成功即清零；IP 维度宽阈值仅防扫描。';
