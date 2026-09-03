-- ============================================================
-- PORTAL-2 · 学号状态模型与纯行政误录纠错验收（0015）
-- 覆盖甲方指定的 12 项 Acceptance + 强制的"同事务逃逸测试"
-- 运行：psql -f supabase/tests/portal2_number_void.sql   结束自动回滚
-- ============================================================
do $$
declare
  apA uuid := gen_random_uuid();   -- 误录学号的学生（pre_enrolled）
  apB uuid := gen_random_uuid();   -- 真正拥有 N_WRONG 的学生
  apC uuid := gen_random_uuid();   -- 已 active 的学生
  reg uuid := gen_random_uuid();   -- registrar
  reg2 uuid := gen_random_uuid();  -- 第二个 registrar（验证"两人之中须有 super_admin"）
  sup uuid := gen_random_uuid();   -- super_admin
  appA uuid; appB uuid; appC uuid;
  stuA uuid; stuB uuid; stuC uuid;
  reqA uuid;
  v jsonb; v_cnt int; v_txt text; good jsonb;
  seed_users uuid[]; seed_apps uuid[] := '{}'; i int; aid uuid;
  N_WRONG text := 'AMAS0012';      -- 误录：总校其实把它分给了 apB
  N_RIGHT text := 'AMAS0013';      -- 正确应属于 apA
  N_C     text := 'AMAS0099';
begin
  ------------------------------------------------------------
  -- 种子
  ------------------------------------------------------------
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
                          raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  select u.id, '00000000-0000-0000-0000-000000000000','authenticated','authenticated', u.em,
         crypt('T!123456', gen_salt('bf')), now(), '{"provider":"email"}',
         jsonb_build_object('display_name', u.nm), now(), now()
  from (values (apA,'v-apa@test.amas','APA'), (apB,'v-apb@test.amas','APB'), (apC,'v-apc@test.amas','APC'),
               (reg,'v-reg@test.amas','REG'), (reg2,'v-reg2@test.amas','REG2'), (sup,'v-sup@test.amas','SUP'))
       as u(id, em, nm);
  insert into public.user_roles (user_id, role, granted_by) values
    (reg,'registrar',reg), (reg2,'registrar',reg), (sup,'super_admin',sup);

  good := jsonb_build_object(
    'name_zh','纠错测试','birth_ym','1995-06','gender','male','nationality','中国',
    'phone','+86 13800000000','address','广州市','church_name','测试教会',
    'church_role','小组同工','conversion_date','2015-03','calling','愿意接受装备',
    'testimony','见证内容。','declaration_accepted', true,
    'programs', jsonb_build_array('bth'), 'languages', jsonb_build_array('mandarin'),
    'education', jsonb_build_array(jsonb_build_object('school','某大学','city','广州','start_ym','2013-09','end_ym','2017-06','degree','本科')));

  -- 把三份申请推到 accepted + HQ approved（走真实招生闭环，不直接造数据）
  seed_users := array[apA, apB, apC];
  for i in 1..3 loop
    insert into public.applications (applicant_id, pathway, status, form_data)
    values (seed_users[i], 'bth', 'draft', good) returning id into aid;
    perform set_config('request.jwt.claims',
      json_build_object('sub', seed_users[i], 'role','authenticated')::text, true);
    v := public.submit_application(aid);
    perform set_config('request.jwt.claims', null, true);
    v := public.review_application(aid, reg, 'start_review', null, null, null);
    v := public.review_application(aid, reg, 'accept', null, null, null);
    v := public.confirm_hq_approval(aid, reg, 'approved', 'HQ-SEED-' || i, null, null);
    seed_apps := seed_apps || aid;
  end loop;
  appA := seed_apps[1]; appB := seed_apps[2]; appC := seed_apps[3];

  ------------------------------------------------------------
  -- 建档：apA 被误录成 N_WRONG；apC 建档后激活（用于"active 不得 void"）
  ------------------------------------------------------------
  v := public.create_student_record(appA, reg, N_WRONG, null);
  stuA := (v->>'student_id')::uuid;
  v := public.create_student_record(appC, reg, N_C, null);
  stuC := (v->>'student_id')::uuid;
  v := public.activate_student(stuC, reg, null, null);

  ------------------------------------------------------------
  -- V01 pre_enrolled + 纯行政误录 → 可以发起纠正申请
  ------------------------------------------------------------
  v := public.request_student_number_void(stuA, reg, N_RIGHT, '总校实际分配为 AMAS0013，录入手误', 'HQ-LETTER-2026-07');
  if not (v->>'ok')::boolean then raise exception 'FAIL V01 request rejected: %', v; end if;
  reqA := (v->>'request_id')::uuid;
  raise notice 'PASS V01 pre_enrolled clerical error can request correction';

  ------------------------------------------------------------
  -- V02 active 学生不得 void
  ------------------------------------------------------------
  v := public.request_student_number_void(stuC, reg, 'AMAS0100', '想改', 'X-1');
  if (v->>'ok')::boolean or v->>'error' <> 'student_not_pre_enrolled' then
    raise exception 'FAIL V02 active student allowed void: %', v;
  end if;
  raise notice 'PASS V02 active student cannot be voided';

  ------------------------------------------------------------
  -- V03 retired 号码不得重新分配
  ------------------------------------------------------------
  -- apC 换号：旧号 N_C 变成 retired（真实用过 → 永久占用）
  v := public.correct_student_number(stuC, reg, 'AMAS0101', '总校换发');
  if (v->>'old_number_state') <> 'retired' then raise exception 'FAIL V03 old number not retired: %', v; end if;
  if not exists (select 1 from public.student_number_registry
                  where normalized = N_C and state = 'retired') then
    raise exception 'FAIL V03 retired row missing';
  end if;
  -- 任何人都不能再取得 N_C
  v := public.create_student_record(appB, reg, N_C, null);
  if (v->>'ok')::boolean or v->>'error' <> 'student_number_taken' then
    raise exception 'FAIL V03 retired number was reassigned: %', v;
  end if;
  raise notice 'PASS V03 retired number can never be reassigned';

  ------------------------------------------------------------
  -- V04 同一 actor 不得既发起又确认
  ------------------------------------------------------------
  v := public.approve_student_number_void(reqA, reg, null);
  if (v->>'ok')::boolean or v->>'error' <> 'same_actor_not_allowed' then
    raise exception 'FAIL V04 same actor approved own request: %', v;
  end if;
  raise notice 'PASS V04 initiator cannot approve their own request';

  ------------------------------------------------------------
  -- V05 registrar 单独不能最终释放（两人之中必须有 super_admin）
  ------------------------------------------------------------
  v := public.approve_student_number_void(reqA, reg2, null);
  if (v->>'ok')::boolean or v->>'error' <> 'super_admin_required' then
    raise exception 'FAIL V05 two registrars released a number: %', v;
  end if;
  raise notice 'PASS V05 registrar alone cannot release a number';

  ------------------------------------------------------------
  -- V06 super_admin 绕过流程直接 PATCH registry / student_records → 拒绝
  ------------------------------------------------------------
  perform set_config('request.jwt.claims', json_build_object('sub', sup, 'role','authenticated')::text, true);
  set local role authenticated;
  begin
    update public.student_number_registry set state = 'voided_clerical_error' where normalized = N_WRONG;
    raise exception 'FAIL V06 super_admin patched registry directly';
  exception when insufficient_privilege then
    raise notice 'PASS V06a registry not writable even by super_admin session';
  end;
  begin
    update public.student_records set student_number = N_RIGHT where id = stuA;
    raise exception 'FAIL V06 super_admin patched student number directly';
  exception when insufficient_privilege then
    raise notice 'PASS V06b student_records not writable by client session';
  when others then
    if sqlerrm like '%dedicated server flow%' then raise notice 'PASS V06b student number change rejected';
    else raise; end if;
  end;
  reset role;
  perform set_config('request.jwt.claims', null, true);

  ------------------------------------------------------------
  -- V07 super_admin 确认 → 误录号进入 voided_clerical_error
  ------------------------------------------------------------
  v := public.approve_student_number_void(reqA, sup, '已核对总校批文');
  if not (v->>'ok')::boolean then raise exception 'FAIL V07 approve failed: %', v; end if;
  if (select student_number_normalized from public.student_records where id = stuA) <> N_RIGHT then
    raise exception 'FAIL V07 replacement number not applied';
  end if;
  if not exists (select 1 from public.student_number_registry
                  where normalized = N_WRONG and state = 'voided_clerical_error'
                    and voided_by = sup and replacement_normalized = N_RIGHT) then
    raise exception 'FAIL V07 wrong number not marked voided_clerical_error';
  end if;
  raise notice 'PASS V07 dual-control approval voids the clerical error';

  ------------------------------------------------------------
  -- V08 旧号历史仍完整存在（绝不删除）
  ------------------------------------------------------------
  select count(*) into v_cnt from public.student_number_registry where normalized = N_WRONG;
  if v_cnt <> 1 then raise exception 'FAIL V08 history row deleted or duplicated (% rows)', v_cnt; end if;
  select void_reason into v_txt from public.student_number_registry where normalized = N_WRONG;
  if v_txt is null then raise exception 'FAIL V08 void reason not retained'; end if;
  if (select void_evidence_reference from public.student_number_registry where normalized = N_WRONG)
     <> 'HQ-LETTER-2026-07' then
    raise exception 'FAIL V08 evidence reference not retained';
  end if;
  raise notice 'PASS V08 voided number keeps its full history row';

  ------------------------------------------------------------
  -- V09 voided_clerical_error 的号码可以重新分配给真正的持有人
  ------------------------------------------------------------
  v := public.create_student_record(appB, reg, N_WRONG, null);
  if not (v->>'ok')::boolean then raise exception 'FAIL V09 voided number not reassignable: %', v; end if;
  stuB := (v->>'student_id')::uuid;
  select count(*) into v_cnt from public.student_number_registry where normalized = N_WRONG;
  if v_cnt <> 2 then raise exception 'FAIL V09 expected 2 history rows, got %', v_cnt; end if;
  if not exists (select 1 from public.student_number_registry
                  where normalized = N_WRONG and state = 'assigned' and first_assigned_to = apB) then
    raise exception 'FAIL V09 new assignment row missing';
  end if;
  raise notice 'PASS V09 voided clerical-error number is reassignable to the true holder';

  ------------------------------------------------------------
  -- V10 替代号与现有号码冲突 → 原子失败
  ------------------------------------------------------------
  v := public.request_student_number_void(stuB, reg, N_RIGHT, '试图抢占已被占用的号', 'HQ-X');
  if (v->>'ok')::boolean or v->>'error' <> 'replacement_number_taken' then
    raise exception 'FAIL V10 conflicting replacement accepted: %', v;
  end if;
  if (select student_number_normalized from public.student_records where id = stuB) <> N_WRONG then
    raise exception 'FAIL V10 student number mutated on failed request';
  end if;
  raise notice 'PASS V10 conflicting replacement fails atomically';

  ------------------------------------------------------------
  -- V11 alias 同事务更新
  ------------------------------------------------------------
  select count(*) into v_cnt from public.login_aliases
   where user_id = apA and alias_normalized = N_RIGHT and revoked_at is null;
  if v_cnt <> 1 then raise exception 'FAIL V11 new alias missing (% rows)', v_cnt; end if;
  select count(*) into v_cnt from public.login_aliases
   where user_id = apA and alias_normalized = N_WRONG and revoked_at is null;
  if v_cnt <> 0 then raise exception 'FAIL V11 old alias still active'; end if;
  raise notice 'PASS V11 login alias swapped in the same transaction';

  ------------------------------------------------------------
  -- V12 审计含 old/new/reason/依据，且不泄漏其他敏感信息
  ------------------------------------------------------------
  select count(*) into v_cnt from public.audit_logs
   where event_type = 'student_number_void_approved' and target_id = stuA::text
     and old_value->>'student_number' = N_WRONG
     and new_value->>'student_number' = N_RIGHT
     and new_value->>'initiated_by' = reg::text
     and reason like '%录入手误%'
     and actor_id = sup and category = 'academic';
  if v_cnt <> 1 then raise exception 'FAIL V12 approval audit incomplete (% rows)', v_cnt; end if;
  select count(*) into v_cnt from public.audit_logs
   where target_id in (stuA::text, stuB::text)
     and (old_value::text ~* 'secret|otpauth|password|encrypted'
       or new_value::text ~* 'secret|otpauth|password|encrypted');
  if v_cnt <> 0 then raise exception 'FAIL V12 sensitive data leaked into audit'; end if;
  raise notice 'PASS V12 audit carries old/new/reason/evidence and nothing sensitive';

  ------------------------------------------------------------
  -- V13 并发：两名管理员抢同一个已 void 的号 → 只能一个成功
  --   同一事务内无法真并发；这里验证的是裁决机制本身——
  --   部分唯一索引在号码已被 assigned 后拒绝第二次登记（并发时同样由它裁决）。
  ------------------------------------------------------------
  begin
    insert into public.student_number_registry (normalized, original, first_assigned_to, state)
    values (N_WRONG, N_WRONG, apC, 'assigned');
    raise exception 'FAIL V13 second concurrent assignment succeeded';
  exception when unique_violation then
    raise notice 'PASS V13 partial unique index arbitrates concurrent claims (only one wins)';
  end;

  ------------------------------------------------------------
  -- V14 ★ 强制逃逸测试：合法 RPC 之后，同事务继续直接写入必须失败
  --   （rpc_context 令牌用后即焚 —— 见全局工程规则）
  ------------------------------------------------------------
  begin
    -- approve_student_number_void 内部曾设置 amas.rpc_context='student'
    update public.student_records set status = 'active' where id = stuA;
    raise exception 'FAIL V14 context token survived the RPC (privilege escaped)';
  exception when others then
    if sqlerrm like '%protected server flow%' then
      raise notice 'PASS V14 rpc_context token expired on first use (no same-transaction escape)';
    else raise; end if;
  end;

  ------------------------------------------------------------
  -- V15 缺原因 / 缺依据 → 拒绝（条件 4 与条件 6）
  ------------------------------------------------------------
  begin
    v := public.request_student_number_void(stuB, reg, 'AMAS0500', '   ', 'HQ-Y');
    raise exception 'FAIL V15 request without reason accepted';
  exception when others then
    if sqlerrm like '%reason required%' then raise notice 'PASS V15a correction reason is mandatory';
    else raise; end if;
  end;
  begin
    v := public.request_student_number_void(stuB, reg, 'AMAS0500', '有原因', '  ');
    raise exception 'FAIL V15 request without evidence accepted';
  exception when others then
    if sqlerrm like '%evidence required%' then raise notice 'PASS V15b HQ/registrar evidence is mandatory';
    else raise; end if;
  end;

  ------------------------------------------------------------
  -- V16 非管理员不得发起 / 确认
  ------------------------------------------------------------
  begin
    v := public.request_student_number_void(stuB, apA, 'AMAS0500', '原因', '依据');
    raise exception 'FAIL V16 non-admin initiated a void request';
  exception when others then
    if sqlerrm like '%actor lacks admin role%' then raise notice 'PASS V16 non-admin cannot initiate correction';
    else raise; end if;
  end;

  ------------------------------------------------------------
  -- V17 特权 RPC 对 authenticated 不可执行
  ------------------------------------------------------------
  perform set_config('request.jwt.claims', json_build_object('sub', sup, 'role','authenticated')::text, true);
  set local role authenticated;
  begin
    v := public.approve_student_number_void(reqA, sup, null);
    raise exception 'FAIL V17 authenticated executed approve RPC';
  exception when insufficient_privilege then
    raise notice 'PASS V17 void RPCs are service-role only';
  when others then
    if sqlerrm like '%permission denied%' then raise notice 'PASS V17 void RPCs are service-role only';
    else raise; end if;
  end;
  reset role;
  perform set_config('request.jwt.claims', null, true);

  raise notice '=== PORTAL-2 NUMBER VOID ACCEPTANCE PASSED ===';
  raise exception 'ROLLBACK_OK';
exception when others then
  if sqlerrm = 'ROLLBACK_OK' then return; end if;
  raise;
end $$;
