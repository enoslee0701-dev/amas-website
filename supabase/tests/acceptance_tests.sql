-- ============================================================
-- AMAS 门户 · 数据库验收测试（在 Supabase SQL Editor 以 postgres 身份运行）
-- 前置：0001 → 0004 已全部执行。输出全部为 NOTICE: PASS ... 即通过。
-- 说明：模拟 authenticated 身份使用 set_config('request.jwt.claims', ...)。
-- ============================================================

do $$
declare
  u1 uuid := gen_random_uuid();
  u2 uuid := gen_random_uuid();
  v_cnt int;
  v_dup boolean := false;
  v_ok jsonb;
  r_id uuid;
begin
  -- 种子：两名用户（绕过 auth，直接建 profiles 供约束测试）
  insert into public.profiles (id, email, display_name, account_status)
  values (u1, 'u1@test.amas', 'U1', 'active'), (u2, 'u2@test.amas', 'U2', 'active');

  ------------------------------------------------------------
  -- #3 user_roles：全局角色（scope 为 NULL）重复插入必须失败
  ------------------------------------------------------------
  insert into public.user_roles (user_id, role, granted_by) values (u1, 'teacher', u1);
  begin
    insert into public.user_roles (user_id, role, granted_by) values (u1, 'teacher', u1);
  exception when unique_violation then v_dup := true;
  end;
  if v_dup then raise notice 'PASS #3 duplicate global role rejected';
  else raise exception 'FAIL #3 duplicate global role was accepted'; end if;

  -- 撤销后允许重新授予（部分索引只约束活动行）
  update public.user_roles set revoked_at = now() where user_id = u1 and role = 'teacher';
  insert into public.user_roles (user_id, role, granted_by) values (u1, 'teacher', u1);
  raise notice 'PASS #3b re-grant after revoke allowed';

  ------------------------------------------------------------
  -- #5 占位权限函数 fail-closed
  ------------------------------------------------------------
  if public.is_assigned_teacher(u1, gen_random_uuid()) then
    raise exception 'FAIL #5 is_assigned_teacher not fail-closed'; end if;
  if public.is_enrolled_student(u1, gen_random_uuid()) then
    raise exception 'FAIL #5 is_enrolled_student not fail-closed'; end if;
  if public.is_assigned_mentor(u1, u2) then
    raise exception 'FAIL #5 is_assigned_mentor not fail-closed'; end if;
  raise notice 'PASS #5 placeholder permission functions fail closed';

  ------------------------------------------------------------
  -- #2 限流：同一标识 5 次失败后拒绝；成功后计数清零
  ------------------------------------------------------------
  for i in 1..5 loop
    perform public.auth_record_attempt('TEST001', '1.2.3.4', false, null);
  end loop;
  v_ok := public.auth_rate_check('TEST001', '1.2.3.4');
  if (v_ok->>'allowed')::boolean then
    raise exception 'FAIL #2 rate limit did not trigger after 5 failures'; end if;
  raise notice 'PASS #2 identifier lockout after 5 failures';

  perform public.auth_record_attempt('TEST001', '1.2.3.4', true, u1);
  v_ok := public.auth_rate_check('TEST001', '1.2.3.4');
  if not (v_ok->>'allowed')::boolean then
    raise exception 'FAIL #2 success did not reset failure counter'; end if;
  raise notice 'PASS #2b success resets counter';

  ------------------------------------------------------------
  -- Phase 2：邀请核销一次性 / 过期拒绝
  ------------------------------------------------------------
  insert into public.teacher_invitations (email_normalized, expected_name, token_hash, expires_at, created_by)
  values ('t@test.amas', 'T', 'hash_once', now() + interval '1 day', u1);
  perform public.consume_teacher_invitation('hash_once', 't@test.amas');
  begin
    perform public.consume_teacher_invitation('hash_once', 't@test.amas');
    raise exception 'FAIL invite reused';
  exception when others then
    if sqlerrm like '%invitation invalid%' then raise notice 'PASS invite one-time';
    else raise; end if;
  end;
  begin
    perform public.consume_teacher_invitation('hash_none', 'x@test.amas');
    raise exception 'FAIL invalid invite accepted';
  exception when others then
    if sqlerrm like '%invitation invalid%' then raise notice 'PASS invalid/expired invite rejected';
    else raise; end if;
  end;

  ------------------------------------------------------------
  -- Phase 2：非法状态跃迁被拒；审核事务授予角色
  ------------------------------------------------------------
  insert into public.teacher_verification_requests (user_id, status, submitted_data, submitted_at)
  values (u2, 'submitted', '{"name":"U2"}', now()) returning id into r_id;
  begin
    update public.teacher_verification_requests set status = 'draft' where id = r_id;
    raise exception 'FAIL illegal transition accepted';
  exception when others then
    if sqlerrm like '%invalid teacher verification transition%' then
      raise notice 'PASS illegal status transition rejected';
    else raise; end if;
  end;

  -- 授予 u1 管理角色后审核
  insert into public.user_roles (user_id, role, granted_by) values (u1, 'academic_admin', u1);
  perform public.review_teacher_verification(r_id, u1, 'approve', '欢迎', 'STAFF-001', true, '初审通过');
  select count(*) into v_cnt from public.user_roles
   where user_id = u2 and role in ('teacher','mentor') and revoked_at is null;
  if v_cnt <> 2 then raise exception 'FAIL approve did not grant roles atomically'; end if;
  raise notice 'PASS approve grants teacher+mentor in one transaction';

  perform public.review_teacher_verification(r_id, u1, 'suspend', '暂停', null, false, null);
  select count(*) into v_cnt from public.user_roles
   where user_id = u2 and role in ('teacher','mentor') and revoked_at is null;
  if v_cnt <> 0 then raise exception 'FAIL suspend did not revoke roles'; end if;
  raise notice 'PASS suspend revokes roles immediately';

  ------------------------------------------------------------
  -- RLS：普通登录用户读不到他人验证资料 / 别名表 / 邀请表
  ------------------------------------------------------------
  perform set_config('request.jwt.claims',
    json_build_object('sub', u2, 'role', 'authenticated')::text, true);
  set local role authenticated;

  select count(*) into v_cnt from public.teacher_verification_requests where user_id <> u2;
  if v_cnt <> 0 then raise exception 'FAIL RLS: user sees others'' requests'; end if;
  select count(*) into v_cnt from public.teacher_verification_internal;
  if v_cnt <> 0 then raise exception 'FAIL RLS: user sees internal notes'; end if;
  begin
    select count(*) into v_cnt from public.login_aliases;
    raise exception 'FAIL RLS: login_aliases readable';
  exception when insufficient_privilege then
    raise notice 'PASS login_aliases blocked for clients';
  end;
  select count(*) into v_cnt from public.teacher_invitations;
  if v_cnt <> 0 then raise exception 'FAIL RLS: invitations visible to non-admin'; end if;
  raise notice 'PASS RLS isolation (requests/internal/invitations)';

  reset role;
  raise notice '=== ALL ACCEPTANCE TESTS PASSED ===';
  raise exception 'ROLLBACK_TEST_DATA';   -- 故意回滚，清除全部测试数据
exception when others then
  if sqlerrm = 'ROLLBACK_TEST_DATA' then
    raise notice '(test data rolled back)';
  else
    raise;
  end if;
end $$;

-- 并发限流验收（需真实环境手工执行）：
--   两个 SQL 会话同时执行 select public.auth_rate_check('CONC01','9.9.9.9');
--   由于 pg_advisory_xact_lock 串行化，观察到第二个会话阻塞至第一个提交，
--   连续制造 5 次失败后并发 10 个请求，放行数不得超过剩余额度。
