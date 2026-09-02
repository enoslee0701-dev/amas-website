-- ============================================================
-- 0003_hardening · Phase 1 安全加固（对应甲方审查 8 项中的 #2 #4 #5 #6 #7）
-- 覆盖：SECURITY DEFINER 收紧 / 执行权限最小化 / 原子限流 /
--       审计分类读取 / auth 邮箱同步 / 注册触发器容错 / 到期清理
-- ============================================================

-- ---------- #4 SECURITY DEFINER 收紧：search_path='' + 全限定名 ----------
create or replace function public.set_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at = now();
  return new;
end $$;

create or replace function public.has_active_role(p_user uuid, p_role text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.user_roles r
    where r.user_id = p_user and r.role::text = p_role
      and r.revoked_at is null
      and (r.expires_at is null or r.expires_at > now())
  );
$$;

create or replace function public.current_user_has_role(p_role text)
returns boolean language sql stable security definer set search_path = '' as $$
  select public.has_active_role(auth.uid(), p_role);
$$;

create or replace function public.is_admin_any(p_user uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select public.has_active_role(p_user,'registrar')
      or public.has_active_role(p_user,'academic_admin')
      or public.has_active_role(p_user,'super_admin');
$$;

-- #5 占位函数：正式关系表建立前必须 fail closed（永远 false，禁止临时改 true）
create or replace function public.is_assigned_teacher(p_user uuid, p_offering uuid)
returns boolean language sql stable security definer set search_path = '' as $$ select false $$;
create or replace function public.is_enrolled_student(p_user uuid, p_offering uuid)
returns boolean language sql stable security definer set search_path = '' as $$ select false $$;
create or replace function public.is_assigned_mentor(p_mentor uuid, p_student uuid)
returns boolean language sql stable security definer set search_path = '' as $$ select false $$;
comment on function public.is_assigned_teacher is 'FAIL-CLOSED 占位：0005 建 teacher_assignments 后由新 migration 替换';
comment on function public.is_enrolled_student is 'FAIL-CLOSED 占位：0005 建 course_enrollments 后由新 migration 替换';
comment on function public.is_assigned_mentor  is 'FAIL-CLOSED 占位：0006 建 mentor_assignments 后由新 migration 替换';

create or replace function public.my_roles()
returns table(role text, scope_type text, scope_id uuid)
language sql stable security definer set search_path = '' as $$
  select r.role::text, r.scope_type, r.scope_id
  from public.user_roles r
  where r.user_id = auth.uid() and r.revoked_at is null
    and (r.expires_at is null or r.expires_at > now());
$$;

create or replace function public.my_profile()
returns public.profiles
language sql stable security definer set search_path = '' as $$
  select p.* from public.profiles p where p.id = auth.uid();
$$;

-- #4 注册触发器：任何异常只记录、不回滚 auth 注册（避免阻断全部新用户）
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  begin
    insert into public.profiles (id, email, display_name, account_status)
    values (new.id, coalesce(new.email,''),
            coalesce(new.raw_user_meta_data->>'display_name',''),
            case when new.email_confirmed_at is null
                 then 'pending_email'::public.account_status
                 else 'active'::public.account_status end)
    on conflict (id) do nothing;

    insert into public.user_roles (user_id, role, granted_by)
    values (new.id, 'applicant', new.id)
    on conflict do nothing;

    insert into public.audit_logs (actor_id, event_type, target_type, target_id, category)
    values (new.id, 'user_registered', 'profiles', new.id::text, 'identity');
  exception when others then
    -- 自愈路径：登录后前端发现 my_profile() 为空会提示联系同工；此处仅留痕
    insert into public.security_events (event_type, identifier, detail)
    values ('trigger_error', 'handle_new_user',
            jsonb_build_object('user_id', new.id, 'err', sqlerrm));
  end;
  return new;
end $$;

create or replace function public.handle_user_email_confirmed()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  begin
    if new.email_confirmed_at is not null and old.email_confirmed_at is null then
      update public.profiles set account_status = 'active'
      where id = new.id and account_status = 'pending_email';
    end if;
  exception when others then
    insert into public.security_events (event_type, identifier, detail)
    values ('trigger_error','handle_user_email_confirmed',
            jsonb_build_object('user_id', new.id, 'err', sqlerrm));
  end;
  return new;
end $$;

-- #7 auth 邮箱变更 → profiles.email 可信同步（profiles.email 对客户端冻结，但跟随 Auth）
create or replace function public.handle_user_email_changed()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  begin
    if new.email is distinct from old.email then
      update public.profiles set email = coalesce(new.email,'') where id = new.id;
      insert into public.audit_logs (actor_id, event_type, target_type, target_id, category, old_value, new_value)
      values (new.id, 'email_changed', 'profiles', new.id::text, 'identity',
              jsonb_build_object('email', old.email), jsonb_build_object('email', new.email));
    end if;
  exception when others then
    insert into public.security_events (event_type, identifier, detail)
    values ('trigger_error','handle_user_email_changed',
            jsonb_build_object('user_id', new.id, 'err', sqlerrm));
  end;
  return new;
end $$;

drop trigger if exists on_auth_user_email_changed on auth.users;
create trigger on_auth_user_email_changed after update on auth.users
  for each row execute function public.handle_user_email_changed();

create or replace function public.protect_profile_fields()
returns trigger language plpgsql set search_path = '' as $$
begin
  if auth.uid() = new.id and not public.is_admin_any(auth.uid()) then
    new.account_status := old.account_status;
    new.email := old.email;
  end if;
  return new;
end $$;

-- ---------- #4 执行权限最小化 ----------
revoke execute on all functions in schema public from public, anon;
-- RLS 策略与前端需要的最小集合
grant execute on function public.has_active_role(uuid,text)        to authenticated, service_role;
grant execute on function public.current_user_has_role(text)       to authenticated, service_role;
grant execute on function public.is_admin_any(uuid)                to authenticated, service_role;
grant execute on function public.is_assigned_teacher(uuid,uuid)    to authenticated, service_role;
grant execute on function public.is_enrolled_student(uuid,uuid)    to authenticated, service_role;
grant execute on function public.is_assigned_mentor(uuid,uuid)     to authenticated, service_role;
grant execute on function public.my_roles()                        to authenticated;
grant execute on function public.my_profile()                      to authenticated;
-- 触发器函数无需被任何客户端角色执行（触发器以定义者身份运行）

-- ---------- #2 学号/邮箱登录限流：持久化 + 每标识原子（advisory lock 串行化）----------
-- 计数存于 security_events（Postgres，跨实例共享）；本函数由 Edge Function 以 service key RPC 调用。
-- 规则：15 分钟窗口内，自上次成功登录之后的失败 >=5（按标识或按 IP）即拒绝；
--       成功登录写 login_success，等效清零该标识计数。
create or replace function public.auth_rate_check(p_identifier text, p_ip text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_since timestamptz := now() - interval '15 minutes';
  v_last_ok timestamptz;
  v_id_fails int;
  v_ip_fails int;
begin
  -- 同一标识的判定串行化，杜绝并发竞态下的超额放行
  perform pg_advisory_xact_lock(hashtextextended('amas_login:'||p_identifier, 0));

  select max(created_at) into v_last_ok
  from public.security_events
  where event_type = 'login_success' and identifier = p_identifier;

  select count(*) into v_id_fails
  from public.security_events
  where event_type = 'login_failed' and identifier = p_identifier
    and created_at >= greatest(v_since, coalesce(v_last_ok, '-infinity'));

  select count(*) into v_ip_fails
  from public.security_events
  where event_type = 'login_failed' and ip = p_ip
    and created_at >= v_since;

  -- 顺带机会式清理（#2 到期清理；每次最多删 200 行，避免长事务）
  delete from public.security_events
  where id in (
    select id from public.security_events
    where created_at < now() - interval '48 hours'
      and event_type in ('login_failed','login_success','login_locked')
    limit 200
  );

  if v_id_fails >= 5 or v_ip_fails >= 20 then     -- IP 维度阈值放宽，避免 NAT 群体被单人锁死
    insert into public.security_events (event_type, identifier, ip, detail)
    values ('login_locked', p_identifier, p_ip,
            jsonb_build_object('id_fails', v_id_fails, 'ip_fails', v_ip_fails));
    return jsonb_build_object('allowed', false);
  end if;
  return jsonb_build_object('allowed', true);
end $$;
revoke execute on function public.auth_rate_check(text,text) from public, anon, authenticated;
grant execute on function public.auth_rate_check(text,text) to service_role;

-- 失败/成功记录（由 Edge Function 以 service key 调用；成功即成为新的计数起点）
create or replace function public.auth_record_attempt(p_identifier text, p_ip text, p_ok boolean, p_user uuid)
returns void language sql security definer set search_path = '' as $$
  insert into public.security_events (event_type, identifier, ip, user_id)
  values (case when p_ok then 'login_success' else 'login_failed' end, p_identifier, p_ip, p_user);
$$;
revoke execute on function public.auth_record_attempt(text,text,boolean,uuid) from public, anon, authenticated;
grant execute on function public.auth_record_attempt(text,text,boolean,uuid) to service_role;

-- ---------- #6 审计日志分类读取 ----------
alter table public.audit_logs add column if not exists category text not null default 'system';
comment on column public.audit_logs.category is
  'identity | security | academic | admissions | finance | export | system —— 决定谁能读（§17.3）';
create index if not exists audit_logs_category on public.audit_logs (category, created_at desc);

drop policy if exists audit_logs_select on public.audit_logs;

-- super_admin：全量
create policy audit_super_select on public.audit_logs
  for select to authenticated
  using (public.current_user_has_role('super_admin'));

-- academic_admin / registrar：仅学术与招生类
create policy audit_academic_select on public.audit_logs
  for select to authenticated
  using (
    category in ('academic','admissions')
    and (public.current_user_has_role('academic_admin') or public.current_user_has_role('registrar'))
  );

-- finance：仅本人的财务操作
create policy audit_finance_select on public.audit_logs
  for select to authenticated
  using (
    category = 'finance'
    and public.current_user_has_role('finance')
    and actor_id = auth.uid()
  );
-- 其余角色（教师/学员/申请者）无策略命中 = 不可读

-- ---------- 收尾说明 ----------
-- login_aliases / user_roles 的表级权限再收紧一次（RLS 之外的第二道锁）
revoke all on public.login_aliases from anon, authenticated;
revoke insert, update, delete on public.user_roles from anon, authenticated;
grant select on public.user_roles to authenticated;   -- 行级仍由 RLS 限制为本人/管理员
