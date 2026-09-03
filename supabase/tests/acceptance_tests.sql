-- ============================================================
-- AMAS 门户 · 数据库验收测试（SEC-3）
-- 运行：psql -f supabase/tests/acceptance_tests.sql   （postgres 身份）
-- 前置：0001 → 0004 已应用。全部输出 NOTICE: PASS ... 即通过；结束自动回滚测试数据。
-- 注意：profiles.id 外键指向 auth.users，测试先在 auth.users 建种子用户（含注册触发器链路）。
-- ============================================================

do $$
declare
  u1 uuid := gen_random_uuid();
  u2 uuid := gen_random_uuid();
  v_cnt int;
  v_dup boolean := false;
  v_ok jsonb;
  r_id uuid;
  v_prof int;
begin
  ------------------------------------------------------------
  -- 种子：经 auth.users 建两名用户（同时验证注册触发器 handle_new_user）
  ------------------------------------------------------------
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                          email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
                          created_at, updated_at)
  values
    (u1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
     'sec3-u1@test.amas', crypt('TestPass123!', gen_salt('bf')), now(),
     '{"provider":"email","providers":["email"]}', '{"display_name":"SEC3 U1"}', now(), now()),
    (u2, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
     'sec3-u2@test.amas', crypt('TestPass123!', gen_salt('bf')), now(),
     '{"provider":"email","providers":["email"]}', '{"display_name":"SEC3 U2"}', now(), now());

  select count(*) into v_prof from public.profiles where id in (u1,u2);
  if v_prof <> 2 then raise exception 'FAIL trigger: profiles not created (got %)', v_prof; end if;
  raise notice 'PASS T01 registration trigger created profiles';

  select count(*) into v_cnt from public.user_roles
   where user_id in (u1,u2) and role = 'applicant' and revoked_at is null;
  if v_cnt <> 2 then raise exception 'FAIL trigger: applicant role not granted (got %)', v_cnt; end if;
  raise notice 'PASS T02 registration trigger granted applicant only';

  ------------------------------------------------------------
  -- #3 user_roles：全局角色（scope 为 NULL）重复插入必须失败
  ------------------------------------------------------------
  insert into public.user_roles (user_id, role, granted_by) values (u1, 'teacher', u1);
  begin
    insert into public.user_roles (user_id, role, granted_by) values (u1, 'teacher', u1);
  exception when unique_violation then v_dup := true;
  end;
  if v_dup then raise notice 'PASS T03 duplicate global role rejected (NULL scope collapsed)';
  else raise exception 'FAIL T03 duplicate global role accepted'; end if;

  update public.user_roles set revoked_at = now() where user_id = u1 and role = 'teacher';
  insert into public.user_roles (user_id, role, granted_by) values (u1, 'teacher', u1);
  raise notice 'PASS T04 re-grant after revoke allowed';
  update public.user_roles set revoked_at = now() where user_id = u1 and role = 'teacher';

  ------------------------------------------------------------
  -- #5 占位权限函数 fail-closed
  ------------------------------------------------------------
  if public.is_assigned_teacher(u1, gen_random_uuid())
     or public.is_enrolled_student(u1, gen_random_uuid())
     or public.is_assigned_mentor(u1, u2) then
    raise exception 'FAIL T05 placeholder permission functions not fail-closed';
  end if;
  raise notice 'PASS T05 placeholder permission functions fail closed';

  ------------------------------------------------------------
  -- #2 限流：5 次失败即锁；成功后计数清零
  ------------------------------------------------------------
  for i in 1..5 loop
    perform public.auth_record_attempt('SEC3TEST', '1.2.3.4', false, null);
  end loop;
  v_ok := public.auth_rate_check('SEC3TEST', '1.2.3.4');
  if (v_ok->>'allowed')::boolean then raise exception 'FAIL T06 rate limit not triggered'; end if;
  raise notice 'PASS T06 identifier lockout after 5 failures';

  perform public.auth_record_attempt('SEC3TEST', '1.2.3.4', true, u1);
  v_ok := public.auth_rate_check('SEC3TEST', '1.2.3.4');
  if not (v_ok->>'allowed')::boolean then raise exception 'FAIL T07 success did not reset counter'; end if;
  raise notice 'PASS T07 successful login resets failure counter';

  ------------------------------------------------------------
  -- 邀请：一次性 / 无效码拒绝 / 邮箱不匹配拒绝
  ------------------------------------------------------------
  insert into public.teacher_invitations (email_normalized, expected_name, token_hash, expires_at, created_by)
  values ('sec3-u2@test.amas', 'U2', 'hash_once', now() + interval '1 day', u1);
  perform public.consume_teacher_invitation('hash_once', 'sec3-u2@test.amas');
  begin
    perform public.consume_teacher_invitation('hash_once', 'sec3-u2@test.amas');
    raise exception 'FAIL T08 invitation reused';
  exception when others then
    if sqlerrm like '%invitation invalid%' then raise notice 'PASS T08 invitation is one-time';
    else raise; end if;
  end;
  begin
    perform public.consume_teacher_invitation('hash_none', 'x@test.amas');
    raise exception 'FAIL T09 forged token accepted';
  exception when others then
    if sqlerrm like '%invitation invalid%' then raise notice 'PASS T09 forged/unknown token rejected';
    else raise; end if;
  end;
  insert into public.teacher_invitations (email_normalized, expected_name, token_hash, expires_at, created_by)
  values ('sec3-u2@test.amas', 'U2', 'hash_mismatch', now() + interval '1 day', u1);
  begin
    perform public.consume_teacher_invitation('hash_mismatch', 'someone-else@test.amas');
    raise exception 'FAIL T10 wrong-email consumption accepted';
  exception when others then
    if sqlerrm like '%invitation invalid%' then raise notice 'PASS T10 wrong email rejected';
    else raise; end if;
  end;
  insert into public.teacher_invitations (email_normalized, expected_name, token_hash, expires_at, created_by)
  values ('sec3-u2@test.amas', 'U2', 'hash_expired', now() - interval '1 hour', u1);
  begin
    perform public.consume_teacher_invitation('hash_expired', 'sec3-u2@test.amas');
    raise exception 'FAIL T11 expired invitation accepted';
  exception when others then
    if sqlerrm like '%invitation invalid%' then raise notice 'PASS T11 expired invitation rejected';
    else raise; end if;
  end;

  ------------------------------------------------------------
  -- 状态机 + 审核事务
  ------------------------------------------------------------
  insert into public.teacher_verification_requests (user_id, status, submitted_data, submitted_at)
  values (u2, 'submitted', '{"name":"SEC3 U2"}', now()) returning id into r_id;
  begin
    update public.teacher_verification_requests set status = 'draft' where id = r_id;
    raise exception 'FAIL T12 illegal transition accepted';
  exception when others then
    if sqlerrm like '%invalid teacher verification transition%' then
      raise notice 'PASS T12 illegal status transition rejected';
    else raise; end if;
  end;

  insert into public.user_roles (user_id, role, granted_by) values (u1, 'academic_admin', u1);
  perform public.review_teacher_verification(r_id, u1, 'approve', '欢迎', 'SEC3-STAFF-1', true, '初审通过');
  select count(*) into v_cnt from public.user_roles
   where user_id = u2 and role in ('teacher','mentor') and revoked_at is null;
  if v_cnt <> 2 then raise exception 'FAIL T13 approve did not grant both roles (got %)', v_cnt; end if;
  raise notice 'PASS T13 approve grants teacher+mentor atomically';

  select count(*) into v_cnt from public.login_aliases
   where user_id = u2 and alias_type = 'staff_number' and revoked_at is null;
  if v_cnt <> 1 then raise exception 'FAIL T14 staff alias not created'; end if;
  raise notice 'PASS T14 staff number alias created in same transaction';

  select count(*) into v_cnt from public.audit_logs
   where target_id = r_id::text and event_type = 'teacher_verification_approve' and category = 'academic';
  if v_cnt < 1 then raise exception 'FAIL T15 audit row missing'; end if;
  raise notice 'PASS T15 review wrote academic audit entry';

  perform public.review_teacher_verification(r_id, u1, 'suspend', '暂停', null, false, null);
  select count(*) into v_cnt from public.user_roles
   where user_id = u2 and role in ('teacher','mentor') and revoked_at is null;
  if v_cnt <> 0 then raise exception 'FAIL T16 suspend did not revoke roles'; end if;
  select count(*) into v_cnt from public.login_aliases
   where user_id = u2 and alias_type = 'staff_number' and revoked_at is null;
  if v_cnt <> 0 then raise exception 'FAIL T17 suspend did not revoke alias'; end if;
  raise notice 'PASS T16 suspend revokes roles immediately';
  raise notice 'PASS T17 suspend revokes staff alias immediately';

  -- 非管理员不得审核
  begin
    perform public.review_teacher_verification(r_id, u2, 'reinstate', null, null, false, null);
    raise exception 'FAIL T18 non-admin review accepted';
  exception when others then
    if sqlerrm like '%reviewer lacks admin role%' then raise notice 'PASS T18 non-admin reviewer rejected';
    else raise; end if;
  end;

  ------------------------------------------------------------
  -- RLS（模拟 authenticated 身份）
  ------------------------------------------------------------
  perform set_config('request.jwt.claims',
    json_build_object('sub', u2, 'role', 'authenticated', 'aal','aal1')::text, true);
  set local role authenticated;

  select count(*) into v_cnt from public.teacher_verification_requests where user_id <> u2;
  if v_cnt <> 0 then raise exception 'FAIL T19 user sees others requests'; end if;
  raise notice 'PASS T19 verification requests isolated to owner';

  select count(*) into v_cnt from public.teacher_verification_internal;
  if v_cnt <> 0 then raise exception 'FAIL T20 internal notes visible to non-admin'; end if;
  raise notice 'PASS T20 internal review notes hidden from applicant';

  select count(*) into v_cnt from public.teacher_invitations;
  if v_cnt <> 0 then raise exception 'FAIL T21 invitations visible to non-admin'; end if;
  raise notice 'PASS T21 invitations hidden from non-admin';

  begin
    select count(*) into v_cnt from public.login_aliases;
    raise exception 'FAIL T22 login_aliases readable by client role';
  exception when insufficient_privilege then
    raise notice 'PASS T22 login_aliases blocked at table grant level';
  end;

  select count(*) into v_cnt from public.audit_logs;
  if v_cnt <> 0 then raise exception 'FAIL T23 audit logs readable by ordinary user'; end if;
  raise notice 'PASS T23 audit logs hidden from ordinary user';

  -- 客户端不得自授角色
  begin
    insert into public.user_roles (user_id, role, granted_by) values (u2, 'super_admin', u2);
    raise exception 'FAIL T24 self role escalation accepted';
  exception when insufficient_privilege then
    raise notice 'PASS T24 client cannot insert user_roles (table grant)';
  when others then
    if sqlerrm like '%row-level security%' or sqlerrm like '%policy%' then
      raise notice 'PASS T24 client cannot insert user_roles (RLS)';
    else raise; end if;
  end;

  -- service_role 专用 RPC 对 authenticated 必须无执行权限
  begin
    perform public.auth_rate_check('X','1.1.1.1');
    raise exception 'FAIL T25 auth_rate_check callable by authenticated';
  exception when insufficient_privilege then
    raise notice 'PASS T25 auth_rate_check restricted to service_role';
  end;
  begin
    perform public.review_teacher_verification(r_id, u2, 'approve', null, null, false, null);
    raise exception 'FAIL T26 review RPC callable by authenticated';
  exception when insufficient_privilege then
    raise notice 'PASS T26 review_teacher_verification restricted to service_role';
  end;
  begin
    perform public.consume_teacher_invitation('x','y');
    raise exception 'FAIL T27 consume RPC callable by authenticated';
  exception when insufficient_privilege then
    raise notice 'PASS T27 consume_teacher_invitation restricted to service_role';
  end;

  reset role;

  ------------------------------------------------------------
  -- #7 触发器故障注入：注册仍成功 + profiles 不被牵连 + trigger_error 审计 + 自愈
  ------------------------------------------------------------
  declare u3 uuid := gen_random_uuid();
  begin
    -- 让「角色插入」这一段必然失败（not valid 只作用于新行）
    alter table public.user_roles add constraint sec3_break check (role::text <> 'applicant') not valid;

    insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                            email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
    values (u3, '00000000-0000-0000-0000-000000000000','authenticated','authenticated',
            'sec3-u3@test.amas', crypt('TestPass123!', gen_salt('bf')), now(),
            '{"provider":"email","providers":["email"]}','{"display_name":"SEC3 U3"}', now(), now());

    if not exists (select 1 from auth.users where id = u3) then
      raise exception 'FAIL T28 registration blocked by trigger failure'; end if;
    raise notice 'PASS T28 registration succeeds despite trigger failure';

    -- 段隔离：角色段失败，档案段仍应成功
    if not exists (select 1 from public.profiles where id = u3) then
      raise exception 'FAIL T29 profiles rolled back by unrelated stage failure'; end if;
    raise notice 'PASS T29 trigger stages isolated (profile survived role failure)';

    if not exists (select 1 from public.security_events
                   where event_type = 'trigger_error'
                     and detail->>'user_id' = u3::text
                     and detail->>'stage' = 'user_roles') then
      raise exception 'FAIL T30 trigger_error not recorded with stage'; end if;
    raise notice 'PASS T30 trigger failure recorded with stage in security_events';

    -- fail-closed：角色缺失时不得有任何有效角色
    if exists (select 1 from public.user_roles where user_id = u3 and revoked_at is null) then
      raise exception 'FAIL T31 unexpected role granted despite failure'; end if;
    raise notice 'PASS T31 missing-role state is fail-closed (no roles)';

    -- 自愈
    alter table public.user_roles drop constraint sec3_break;
    perform public.heal_missing_profile(u3);
    if not exists (select 1 from public.user_roles
                   where user_id = u3 and role='applicant' and revoked_at is null) then
      raise exception 'FAIL T32 self-heal failed'; end if;
    if not exists (select 1 from public.audit_logs
                   where event_type='profile_healed' and target_id = u3::text) then
      raise exception 'FAIL T32 heal not audited'; end if;
    raise notice 'PASS T32 heal_missing_profile restores role and writes audit';
  end;

  ------------------------------------------------------------
  -- #10 敏感值不入库：邀请明文/审计不含 token 或 MFA secret
  ------------------------------------------------------------
  select count(*) into v_cnt from public.teacher_invitations
   where token_hash ilike 'sbp_%' or length(token_hash) > 100;
  if v_cnt <> 0 then raise exception 'FAIL T33 plaintext-like token stored'; end if;
  select count(*) into v_cnt from public.audit_logs
   where coalesce(new_value::text,'') || coalesce(old_value::text,'') ilike '%secret%'
      or coalesce(new_value::text,'') || coalesce(old_value::text,'') ilike '%otpauth%'
      or coalesce(new_value::text,'') || coalesce(old_value::text,'') ilike '%password%';
  if v_cnt <> 0 then raise exception 'FAIL T33 audit contains sensitive material'; end if;
  raise notice 'PASS T33 no plaintext token / secret / password in DB records';

  raise notice '=== ALL DB ACCEPTANCE TESTS PASSED ===';
  raise exception 'ROLLBACK_TEST_DATA';
exception when others then
  if sqlerrm = 'ROLLBACK_TEST_DATA' then
    raise notice '(test data rolled back)';
  else
    raise;
  end if;
end $$;
