-- ============================================================
-- PORTAL-1 · 数据库层验收（状态机 / RLS / 锁定 / 校验 / 审计）
-- 运行：psql -f supabase/tests/portal1_acceptance.sql
-- 全部 NOTICE: PASS 即通过；结束自动回滚。
-- ============================================================
do $$
declare
  ap uuid := gen_random_uuid();     -- 申请人
  ap2 uuid := gen_random_uuid();    -- 另一申请人
  adm uuid := gen_random_uuid();    -- 教务
  app_id uuid; app2_id uuid;
  v jsonb; v_cnt int; req_id uuid;
  good jsonb;
begin
  ------------------------------------------------------------
  -- 种子
  ------------------------------------------------------------
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
                          raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  values
   (ap , '00000000-0000-0000-0000-000000000000','authenticated','authenticated','p1-ap@test.amas',
    crypt('T!123456', gen_salt('bf')), now(), '{"provider":"email"}','{"display_name":"AP"}', now(), now()),
   (ap2, '00000000-0000-0000-0000-000000000000','authenticated','authenticated','p1-ap2@test.amas',
    crypt('T!123456', gen_salt('bf')), now(), '{"provider":"email"}','{"display_name":"AP2"}', now(), now()),
   (adm, '00000000-0000-0000-0000-000000000000','authenticated','authenticated','p1-adm@test.amas',
    crypt('T!123456', gen_salt('bf')), now(), '{"provider":"email"}','{"display_name":"ADM"}', now(), now());
  insert into public.user_roles (user_id, role, granted_by) values (adm, 'registrar', adm);

  good := jsonb_build_object(
    'name_zh','测试申请人','birth_ym','1995-06','gender','male','nationality','中国',
    'phone','+86 13800000000','address','广州市','church_name','测试教会',
    'church_role','小组同工','conversion_date','2015-03','calling','愿意接受装备',
    'testimony','这是见证内容。','declaration_accepted', true,
    'programs', jsonb_build_array('bth'),
    'languages', jsonb_build_array('mandarin'),
    'education', jsonb_build_array(jsonb_build_object('school','某大学','city','广州','start_ym','2013-09','end_ym','2017-06','degree','本科'))
  );

  ------------------------------------------------------------
  -- P1-D01 校验函数：缺字段被识别
  ------------------------------------------------------------
  if array_length(public.application_validate_form('{}'::jsonb, 'bth'), 1) is null then
    raise exception 'FAIL P1-D01 empty form passed validation';
  end if;
  if array_length(public.application_validate_form(good, 'bth'), 1) is not null then
    raise exception 'FAIL P1-D01 complete form rejected: %', public.application_validate_form(good,'bth');
  end if;
  raise notice 'PASS P1-D01 form validation detects missing/complete';

  ------------------------------------------------------------
  -- P1-D02 建草稿 + 唯一活动申请约束
  ------------------------------------------------------------
  insert into public.applications (applicant_id, pathway, status, form_data)
  values (ap, 'bth', 'draft', good) returning id into app_id;
  raise notice 'PASS P1-D02 draft created';

  begin
    insert into public.applications (applicant_id, pathway, status) values (ap, 'bth', 'draft');
    raise exception 'FAIL P1-D03 second active application accepted';
  exception when unique_violation then
    raise notice 'PASS P1-D03 only one active application per applicant';
  end;

  ------------------------------------------------------------
  -- P1-D04 非法状态跳转被拒
  ------------------------------------------------------------
  begin
    update public.applications set status = 'accepted' where id = app_id;
    raise exception 'FAIL P1-D04 draft->accepted accepted';
  exception when others then
    if sqlerrm like '%invalid application transition%' or sqlerrm like '%protected server flow%' then
      raise notice 'PASS P1-D04 illegal transition draft->accepted rejected';
    else raise; end if;
  end;

  ------------------------------------------------------------
  -- P1-D05 提交（模拟申请人身份）
  ------------------------------------------------------------
  perform set_config('request.jwt.claims', json_build_object('sub', ap, 'role','authenticated')::text, true);
  v := public.submit_application(app_id);
  if not (v->>'ok')::boolean then raise exception 'FAIL P1-D05 submit failed: %', v; end if;
  raise notice 'PASS P1-D05 submit_application succeeded';

  if (select status from public.applications where id = app_id) <> 'submitted' then
    raise exception 'FAIL P1-D05 status not submitted';
  end if;
  if (select array_length(locked_fields,1) from public.applications where id = app_id) is null then
    raise exception 'FAIL P1-D06 locked_fields empty after submit';
  end if;
  raise notice 'PASS P1-D06 locked_fields populated on submit';

  ------------------------------------------------------------
  -- P1-D07 重复提交被拒
  ------------------------------------------------------------
  begin
    v := public.submit_application(app_id);
    raise exception 'FAIL P1-D07 duplicate submit accepted';
  exception when others then
    if sqlerrm like '%invalid_state%' then raise notice 'PASS P1-D07 duplicate submit rejected';
    else raise; end if;
  end;

  ------------------------------------------------------------
  -- P1-D08 提交后锁定字段不可改
  ------------------------------------------------------------
  begin
    update public.applications
       set form_data = jsonb_set(form_data, '{name_zh}', '"改名字"')
     where id = app_id;
    raise exception 'FAIL P1-D08 locked field modified';
  exception when others then
    if sqlerrm like '%locked field cannot be modified%' then
      raise notice 'PASS P1-D08 locked field protected';
    else raise; end if;
  end;

  ------------------------------------------------------------
  -- P1-D09 非管理员不得审核
  ------------------------------------------------------------
  begin
    v := public.review_application(app_id, ap, 'accept', null, null, null);
    raise exception 'FAIL P1-D09 non-admin review accepted';
  exception when others then
    if sqlerrm like '%reviewer lacks admin role%' then raise notice 'PASS P1-D09 non-admin reviewer rejected';
    else raise; end if;
  end;

  ------------------------------------------------------------
  -- P1-D10 审核：要求补充资料（条目化）
  ------------------------------------------------------------
  reset role;
  perform set_config('request.jwt.claims', null, true);
  v := public.review_application(app_id, adm, 'needs_information', '请补充受洗日期',
        jsonb_build_array(jsonb_build_object('label','受洗日期','detail','请填写受洗年月','field','baptism_date')), '内部：材料不全');
  if (select status from public.applications where id = app_id) <> 'needs_information' then
    raise exception 'FAIL P1-D10 status not needs_information';
  end if;
  select count(*) into v_cnt from public.application_requirements where application_id = app_id and resolved = false;
  if v_cnt <> 1 then raise exception 'FAIL P1-D10 requirement not created'; end if;
  raise notice 'PASS P1-D10 needs_information creates requirement item';

  ------------------------------------------------------------
  -- P1-D10b 被要求补充的字段精确解锁（其余仍锁定）· migration 0011
  ------------------------------------------------------------
  if exists (select 1 from public.applications a, unnest(a.locked_fields) x
               where a.id = app_id and x = 'baptism_date') then
    raise exception 'FAIL P1-D10b requested field still locked';
  end if;
  if not exists (select 1 from public.applications a, unnest(a.locked_fields) x
               where a.id = app_id and x = 'name_zh') then
    raise exception 'FAIL P1-D10b unrelated field was unlocked';
  end if;
  raise notice 'PASS P1-D10b requested field unlocked, others stay locked';

  -- 申请人确实能改被解锁的字段
  perform set_config('request.jwt.claims', json_build_object('sub', ap, 'role','authenticated')::text, true);
  update public.applications set form_data = good || '{"baptism_date":"2016-05"}'::jsonb where id = app_id;
  if (select form_data->>'baptism_date' from public.applications where id = app_id) <> '2016-05' then
    raise exception 'FAIL P1-D10c unlocked field not writable by applicant';
  end if;
  raise notice 'PASS P1-D10c applicant can correct the unlocked field';
  perform set_config('request.jwt.claims', null, true);

  ------------------------------------------------------------
  -- P1-D11 未完成补件不得重新提交
  ------------------------------------------------------------
  perform set_config('request.jwt.claims', json_build_object('sub', ap, 'role','authenticated')::text, true);
  v := public.submit_application(app_id);
  if (v->>'ok')::boolean then raise exception 'FAIL P1-D11 resubmit with pending requirements accepted'; end if;
  if v->>'error' <> 'requirements_pending' then raise exception 'FAIL P1-D11 wrong error: %', v; end if;
  raise notice 'PASS P1-D11 resubmit blocked while requirements pending';

  ------------------------------------------------------------
  -- P1-D12 完成补件后可重新提交
  ------------------------------------------------------------
  select id into req_id from public.application_requirements where application_id = app_id limit 1;
  v := public.resolve_requirement(req_id);
  v := public.submit_application(app_id);
  if not (v->>'ok')::boolean then raise exception 'FAIL P1-D12 resubmit failed: %', v; end if;
  raise notice 'PASS P1-D12 resubmit after resolving requirements';

  -- P1-D12b 重新提交后再次全量锁定
  if not exists (select 1 from public.applications a, unnest(a.locked_fields) x
               where a.id = app_id and x = 'baptism_date') then
    raise exception 'FAIL P1-D12b field not re-locked after resubmit';
  end if;
  raise notice 'PASS P1-D12b fields re-locked on resubmit';

  ------------------------------------------------------------
  -- P1-D13 录取 + 审计 + 时间线
  ------------------------------------------------------------
  perform set_config('request.jwt.claims', null, true);
  v := public.review_application(app_id, adm, 'accept', '恭喜录取', null, '内部：通过');
  if (select status from public.applications where id = app_id) <> 'accepted' then
    raise exception 'FAIL P1-D13 not accepted';
  end if;
  if (select decided_at from public.applications where id = app_id) is null then
    raise exception 'FAIL P1-D13 decided_at not set';
  end if;
  select count(*) into v_cnt from public.audit_logs
   where target_id = app_id::text and category = 'admissions';
  if v_cnt < 3 then raise exception 'FAIL P1-D13 audit entries missing (got %)', v_cnt; end if;
  raise notice 'PASS P1-D13 accept sets status/decided_at and writes admissions audit';

  select count(*) into v_cnt from public.application_status_history where application_id = app_id;
  if v_cnt < 4 then raise exception 'FAIL P1-D14 timeline incomplete (got %)', v_cnt; end if;
  raise notice 'PASS P1-D14 status history recorded';

  ------------------------------------------------------------
  -- P1-D15 终态不可再改
  ------------------------------------------------------------
  begin
    v := public.review_application(app_id, adm, 'start_review', null, null, null);
    raise exception 'FAIL P1-D15 transition from accepted accepted';
  exception when others then
    if sqlerrm like '%invalid application transition%' then raise notice 'PASS P1-D15 terminal state is final';
    else raise; end if;
  end;

  ------------------------------------------------------------
  -- P1-D16..19 RLS（模拟另一申请人）
  ------------------------------------------------------------
  insert into public.applications (applicant_id, pathway, status, form_data)
  values (ap2, 'common_learning', 'draft', good) returning id into app2_id;

  perform set_config('request.jwt.claims', json_build_object('sub', ap2, 'role','authenticated')::text, true);
  set local role authenticated;

  select count(*) into v_cnt from public.applications where applicant_id <> ap2;
  if v_cnt <> 0 then raise exception 'FAIL P1-D16 cross-user application readable'; end if;
  raise notice 'PASS P1-D16 cannot read others applications';

  begin
    update public.applications set form_data = '{"hacked":true}' where id = app_id;
    if found then raise exception 'FAIL P1-D17 cross-user update succeeded'; end if;
    raise notice 'PASS P1-D17 cross-user update blocked (no rows)';
  exception when insufficient_privilege or others then
    raise notice 'PASS P1-D17 cross-user update blocked';
  end;

  select count(*) into v_cnt from public.application_internal;
  if v_cnt <> 0 then raise exception 'FAIL P1-D18 internal notes visible to applicant'; end if;
  raise notice 'PASS P1-D18 internal notes hidden from applicant';

  begin
    perform public.review_application(app2_id, ap2, 'accept', null, null, null);
    raise exception 'FAIL P1-D19 review RPC callable by applicant';
  exception when insufficient_privilege then
    raise notice 'PASS P1-D19 review_application is service-only';
  end;

  -- 时间线内部备注列不可读
  begin
    perform internal_note from public.application_status_history limit 1;
    raise exception 'FAIL P1-D20 internal_note column readable';
  exception when insufficient_privilege then
    raise notice 'PASS P1-D20 internal_note column not granted';
  when others then
    if sqlerrm like '%permission denied%' then raise notice 'PASS P1-D20 internal_note column not granted';
    else raise; end if;
  end;

  reset role;
  raise notice '=== PORTAL-1 DB ACCEPTANCE PASSED ===';
  raise exception 'ROLLBACK_TEST_DATA';
exception when others then
  if sqlerrm = 'ROLLBACK_TEST_DATA' then raise notice '(test data rolled back)';
  else raise; end if;
end $$;
