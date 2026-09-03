-- ============================================================
-- 0006_trigger_isolation · SEC-3 验收发现缺陷修复（#7 相关）
-- 缺陷：handle_new_user 将 profiles 插入与 user_roles 插入放在同一个
--       BEGIN...EXCEPTION 子事务中；角色插入失败会连带回滚 profiles 插入，
--       导致用户注册成功却「既无档案也无角色」，自愈需要两步且顺序敏感。
-- 修复：三段独立子事务（profiles / user_roles / audit），互不牵连；
--       任一段失败只写 security_events('trigger_error') 并标注 stage。
-- 另补：public.heal_missing_profile() 供管理员一键自愈（service_role 专用）。
-- ============================================================

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  -- 段 1：档案
  begin
    insert into public.profiles (id, email, display_name, account_status)
    values (new.id, coalesce(new.email,''),
            coalesce(new.raw_user_meta_data->>'display_name',''),
            case when new.email_confirmed_at is null
                 then 'pending_email'::public.account_status
                 else 'active'::public.account_status end)
    on conflict (id) do nothing;
  exception when others then
    insert into public.security_events (event_type, identifier, detail)
    values ('trigger_error', 'handle_new_user',
            jsonb_build_object('user_id', new.id, 'stage', 'profiles', 'err', sqlerrm));
  end;

  -- 段 2：默认角色（失败不影响档案）
  begin
    insert into public.user_roles (user_id, role, granted_by)
    values (new.id, 'applicant', new.id)
    on conflict do nothing;
  exception when others then
    insert into public.security_events (event_type, identifier, detail)
    values ('trigger_error', 'handle_new_user',
            jsonb_build_object('user_id', new.id, 'stage', 'user_roles', 'err', sqlerrm));
  end;

  -- 段 3：审计（失败不影响前两段）
  begin
    insert into public.audit_logs (actor_id, event_type, target_type, target_id, category)
    values (new.id, 'user_registered', 'profiles', new.id::text, 'identity');
  exception when others then
    insert into public.security_events (event_type, identifier, detail)
    values ('trigger_error', 'handle_new_user',
            jsonb_build_object('user_id', new.id, 'stage', 'audit', 'err', sqlerrm));
  end;

  return new;
end $$;

-- 自愈：为缺失档案/角色的账号补齐（幂等；仅 service_role，可由管理员后台调用）
create or replace function public.heal_missing_profile(p_user uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_email text; v_name text; v_confirmed timestamptz; v_p int := 0; v_r int := 0;
begin
  select email, raw_user_meta_data->>'display_name', email_confirmed_at
    into v_email, v_name, v_confirmed
  from auth.users where id = p_user;
  if not found then raise exception 'auth user not found'; end if;

  insert into public.profiles (id, email, display_name, account_status)
  values (p_user, coalesce(v_email,''), coalesce(v_name,''),
          case when v_confirmed is null then 'pending_email'::public.account_status
               else 'active'::public.account_status end)
  on conflict (id) do nothing;
  get diagnostics v_p = row_count;

  insert into public.user_roles (user_id, role, granted_by)
  values (p_user, 'applicant', p_user)
  on conflict do nothing;
  get diagnostics v_r = row_count;

  insert into public.audit_logs (actor_id, event_type, target_type, target_id, category, reason)
  values (p_user, 'profile_healed', 'profiles', p_user::text, 'identity',
          format('profile_rows=%s role_rows=%s', v_p, v_r));

  return jsonb_build_object('profile_created', v_p > 0, 'role_created', v_r > 0);
end $$;
revoke execute on function public.heal_missing_profile(uuid) from public, anon, authenticated;
grant execute on function public.heal_missing_profile(uuid) to service_role;

comment on function public.handle_new_user is
  '注册钩子（SEC-3 修复版）：三段独立子事务，任一失败不牵连其他，绝不阻断 auth 注册。';
comment on function public.heal_missing_profile is
  '自愈：补齐缺失的 profiles/applicant 角色，幂等，写 identity 审计；仅 service_role。';
