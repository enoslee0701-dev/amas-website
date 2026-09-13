-- ============================================================
-- G1「指派审核人」的真实 SQL 断言。
-- 跑法见 run.sh —— 它只在自己新建的一次性库里跑。
-- 每条断言失败就 raise exception；配合 psql -v ON_ERROR_STOP=1，第一条红就停。
--
-- 覆盖：草稿/终态拒绝 · expected 并发 · 撤销/过期审核角色 ·
--       审计原子性 · 申请人 timeline 不新增 · 授权面（仅 service_role）
-- 不覆盖：aal2（那道闸在 Edge 里，不在数据库里）——见 edge-gate.test.ts。
-- ============================================================
\set ON_ERROR_STOP on

-- ---------- 合成 fixture（全部是这一次新建的，不来自任何真实数据）----------
do $$
declare
  v_appl uuid := '00000000-0000-4000-8000-000000000001';
  v_r1   uuid := '00000000-0000-4000-8000-000000000002';  -- 有效 registrar
  v_r2   uuid := '00000000-0000-4000-8000-000000000003';  -- 有效 academic_admin
  v_rev  uuid := '00000000-0000-4000-8000-000000000004';  -- 已撤销
  v_exp  uuid := '00000000-0000-4000-8000-000000000005';  -- 已过期
begin
  insert into auth.users(id, email, email_confirmed_at) values
    (v_appl,'appl@example.invalid', now()),
    (v_r1,  'r1@example.invalid',  now()),
    (v_r2,  'r2@example.invalid',  now()),
    (v_rev, 'rev@example.invalid', now()),
    (v_exp, 'exp@example.invalid', now());

  insert into public.user_roles(user_id, role, granted_by, revoked_at, expires_at) values
    (v_r1,  'registrar',      v_r1, null, null),
    (v_r2,  'academic_admin', v_r2, null, now() + interval '30 days'),
    (v_rev, 'registrar',      v_rev, now() - interval '1 day', null),
    (v_exp, 'registrar',      v_exp, null, now() - interval '1 day');
end $$;

-- 造一份各状态的申请。直接插表，绕开客户端路径。
do $$
declare v_appl uuid := '00000000-0000-4000-8000-000000000001'; st text;
begin
  foreach st in array array['draft','submitted','under_review','needs_information','accepted','rejected','withdrawn'] loop
    insert into public.applications(id, applicant_id, pathway, status, form_data, form_version)
    values (('00000000-0000-4000-9000-0000000000' ||
             lpad((array_position(array['draft','submitted','under_review','needs_information','accepted','rejected','withdrawn'], st))::text, 2, '0'))::uuid,
            v_appl, 'degree', st::public.application_status, '{"name_zh":"测试"}'::jsonb, 'v1');
  end loop;
end $$;

\echo '--- A 只有在审的三个状态可以改指派 ---'
do $$
declare r jsonb; st text; id uuid; i int := 0;
  v_r1 uuid := '00000000-0000-4000-8000-000000000002';
begin
  foreach st in array array['draft','submitted','under_review','needs_information','accepted','rejected','withdrawn'] loop
    i := i + 1;
    id := ('00000000-0000-4000-9000-0000000000' || lpad(i::text,2,'0'))::uuid;
    r := public.assign_application_reviewer(id, v_r1, v_r1, null, null);
    if st in ('submitted','under_review','needs_information') then
      if (r ->> 'ok') <> 'true' then
        raise exception 'A: 状态 % 应当可以指派，却返回 %', st, r;
      end if;
    else
      if (r ->> 'ok') <> 'false' or (r ->> 'error') <> 'not_assignable' then
        raise exception 'A: 状态 % 应当被拒为 not_assignable，却返回 %', st, r;
      end if;
      if (r ->> 'status') <> st then
        raise exception 'A: 拒绝时应当带回真实状态 %，却是 %', st, (r ->> 'status');
      end if;
    end if;
  end loop;
end $$;

\echo '--- B expected 对不上就不覆盖 ---'
do $$
declare r jsonb;
  app uuid := '00000000-0000-4000-9000-000000000002';   -- submitted，A 段已指给 r1
  v_r1 uuid := '00000000-0000-4000-8000-000000000002';
  v_r2 uuid := '00000000-0000-4000-8000-000000000003';
  cur uuid;
begin
  select assigned_reviewer into cur from public.applications where id = app;
  if cur is distinct from v_r1 then raise exception 'B 前提不成立：当前应是 r1，却是 %', cur; end if;

  r := public.assign_application_reviewer(app, v_r1, v_r2, null, null);   -- 带的是过时的 null
  if (r ->> 'ok') <> 'false' or (r ->> 'error') <> 'reassigned' then
    raise exception 'B: expected 不符应当返回 reassigned，却是 %', r;
  end if;
  if (r ->> 'current')::uuid is distinct from v_r1 then
    raise exception 'B: 应当带回当前值 r1，却是 %', (r ->> 'current');
  end if;
  select assigned_reviewer into cur from public.applications where id = app;
  if cur is distinct from v_r1 then raise exception 'B: 被拒之后不该改动数据，却成了 %', cur; end if;

  r := public.assign_application_reviewer(app, v_r1, v_r2, v_r1, null);   -- 带对了
  if (r ->> 'ok') <> 'true' or (r ->> 'assigned_reviewer')::uuid is distinct from v_r2 then
    raise exception 'B: expected 正确时应当成功改为 r2，却是 %', r;
  end if;
end $$;

\echo '--- C 撤销 / 过期的角色不能被指派 ---'
do $$
declare r jsonb;
  app uuid := '00000000-0000-4000-9000-000000000003';   -- under_review
  v_r1 uuid := '00000000-0000-4000-8000-000000000002';
  v_rev uuid := '00000000-0000-4000-8000-000000000004';
  v_exp uuid := '00000000-0000-4000-8000-000000000005';
  cur uuid;
begin
  r := public.assign_application_reviewer(app, v_r1, v_rev, null, null);
  if (r ->> 'ok') <> 'false' or (r ->> 'error') <> 'not_a_reviewer' then
    raise exception 'C: 已撤销的角色应当被拒，却是 %', r;
  end if;
  r := public.assign_application_reviewer(app, v_r1, v_exp, null, null);
  if (r ->> 'ok') <> 'false' or (r ->> 'error') <> 'not_a_reviewer' then
    raise exception 'C: 已过期的角色应当被拒，却是 %', r;
  end if;
  select assigned_reviewer into cur from public.applications where id = app;
  if cur is not null then raise exception 'C: 被拒之后不该写入，却成了 %', cur; end if;
end $$;

\echo '--- D 审计：成功写一条，被拒一条都不写；history 与 timeline 不动 ---'
do $$
declare
  app uuid := '00000000-0000-4000-9000-000000000004';   -- needs_information
  v_r1 uuid := '00000000-0000-4000-8000-000000000002';
  v_r2 uuid := '00000000-0000-4000-8000-000000000003';
  v_appl uuid := '00000000-0000-4000-8000-000000000001';
  a0 int; a1 int; h0 int; h1 int; t0 int; t1 int; r jsonb; ev text;
begin
  select count(*) into a0 from public.audit_logs where target_id = app::text;
  select count(*) into h0 from public.application_status_history where application_id = app;
  perform set_config('amas.test.uid', v_appl::text, true);
  select count(*) into t0 from public.my_application_timeline(app);
  perform set_config('amas.test.uid', '', true);

  -- ① 成功一次
  r := public.assign_application_reviewer(app, v_r1, v_r1, null, '内部说明');
  if (r ->> 'ok') <> 'true' then raise exception 'D: 这一次应当成功，却是 %', r; end if;

  select count(*) into a1 from public.audit_logs where target_id = app::text;
  if a1 <> a0 + 1 then raise exception 'D: 成功应当**只**写一条审计，实际多了 %', a1 - a0; end if;
  select event_type into ev from public.audit_logs where target_id = app::text order by id desc limit 1;
  if ev <> 'application_assign' then raise exception 'D: 首次指派的 event_type 应为 application_assign，实际 %', ev; end if;

  -- ② 重新指派 → reassign
  r := public.assign_application_reviewer(app, v_r1, v_r2, v_r1, null);
  select event_type into ev from public.audit_logs where target_id = app::text order by id desc limit 1;
  if ev <> 'application_reassign' then raise exception 'D: 重新指派应为 application_reassign，实际 %', ev; end if;

  -- ③ 取消 → unassign
  r := public.assign_application_reviewer(app, v_r1, null, v_r2, null);
  select event_type into ev from public.audit_logs where target_id = app::text order by id desc limit 1;
  if ev <> 'application_unassign' then raise exception 'D: 取消应为 application_unassign，实际 %', ev; end if;

  -- ④ 一次被拒的调用：审计一条都不该写
  select count(*) into a0 from public.audit_logs where target_id = app::text;
  r := public.assign_application_reviewer(app, v_r1, v_r1, v_r2, null);   -- expected 已过时
  if (r ->> 'ok') <> 'false' then raise exception 'D: 这一次应当被拒，却是 %', r; end if;
  select count(*) into a1 from public.audit_logs where target_id = app::text;
  if a1 <> a0 then raise exception 'D: 被拒的调用写了 % 条审计，应当是 0', a1 - a0; end if;

  -- ⑤ 申请人这一侧：history 与 timeline 一行都不该多
  select count(*) into h1 from public.application_status_history where application_id = app;
  if h1 <> h0 then raise exception 'D: 指派往 application_status_history 写了 % 行，应当是 0', h1 - h0; end if;
  perform set_config('amas.test.uid', v_appl::text, true);
  select count(*) into t1 from public.my_application_timeline(app);
  perform set_config('amas.test.uid', '', true);
  if t1 <> t0 then raise exception 'D: 申请人 timeline 多出了 % 行，应当是 0', t1 - t0; end if;
end $$;

\echo '--- E 非管理员不能调；执行权限只给 service_role ---'
do $$
declare
  app uuid := '00000000-0000-4000-9000-000000000002';
  v_appl uuid := '00000000-0000-4000-8000-000000000001';
  v_r1 uuid := '00000000-0000-4000-8000-000000000002';
  got text;
begin
  begin
    perform public.assign_application_reviewer(app, v_appl, v_r1, null, null);
    raise exception 'E: 申请人当 actor 竟然没被拒';
  exception when others then
    got := sqlerrm;
    if position('actor lacks admin role' in got) = 0 then
      raise exception 'E: 期望 actor lacks admin role，实际 %', got;
    end if;
  end;

  if has_function_privilege('authenticated',
       'public.assign_application_reviewer(uuid,uuid,uuid,uuid,text)', 'execute') then
    raise exception 'E: authenticated 不该有执行权限';
  end if;
  if has_function_privilege('anon',
       'public.assign_application_reviewer(uuid,uuid,uuid,uuid,text)', 'execute') then
    raise exception 'E: anon 不该有执行权限';
  end if;
  if not has_function_privilege('service_role',
       'public.assign_application_reviewer(uuid,uuid,uuid,uuid,text)', 'execute') then
    raise exception 'E: service_role 应当有执行权限';
  end if;
end $$;

\echo 'checks.sql: 全部断言通过'
