-- ============================================================
-- PORTAL-2 · 数据库层验收（学籍生命周期 / HQ 审核门禁 / 学号 / 角色 / RLS）
-- 运行：psql -f supabase/tests/portal2_acceptance.sql
-- 全部 NOTICE: PASS 即通过；结束自动回滚。
-- ============================================================
do $$
declare
  ap  uuid := gen_random_uuid();   -- 申请人 → 学生
  ap2 uuid := gen_random_uuid();   -- 另一申请人 → 另一学生
  adm uuid := gen_random_uuid();   -- registrar
  fin uuid := gen_random_uuid();   -- finance
  app_id uuid; app2_id uuid;
  stu_id uuid; stu2_id uuid;
  v jsonb; v_cnt int; v_txt text; good jsonb;
begin
  ------------------------------------------------------------
  -- 种子
  ------------------------------------------------------------
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
                          raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  values
   (ap , '00000000-0000-0000-0000-000000000000','authenticated','authenticated','p2-ap@test.amas',
    crypt('T!123456', gen_salt('bf')), now(), '{"provider":"email"}','{"display_name":"AP"}', now(), now()),
   (ap2, '00000000-0000-0000-0000-000000000000','authenticated','authenticated','p2-ap2@test.amas',
    crypt('T!123456', gen_salt('bf')), now(), '{"provider":"email"}','{"display_name":"AP2"}', now(), now()),
   (adm, '00000000-0000-0000-0000-000000000000','authenticated','authenticated','p2-adm@test.amas',
    crypt('T!123456', gen_salt('bf')), now(), '{"provider":"email"}','{"display_name":"REG"}', now(), now()),
   (fin, '00000000-0000-0000-0000-000000000000','authenticated','authenticated','p2-fin@test.amas',
    crypt('T!123456', gen_salt('bf')), now(), '{"provider":"email"}','{"display_name":"FIN"}', now(), now());
  insert into public.user_roles (user_id, role, granted_by) values (adm, 'registrar', adm);
  insert into public.user_roles (user_id, role, granted_by) values (fin, 'finance',   adm);

  good := jsonb_build_object(
    'name_zh','学籍测试','birth_ym','1995-06','gender','male','nationality','中国',
    'phone','+86 13800000000','address','广州市','church_name','测试教会',
    'church_role','小组同工','conversion_date','2015-03','calling','愿意接受装备',
    'testimony','这是见证内容。','declaration_accepted', true,
    'programs', jsonb_build_array('bth'),
    'languages', jsonb_build_array('mandarin'),
    'education', jsonb_build_array(jsonb_build_object('school','某大学','city','广州','start_ym','2013-09','end_ym','2017-06','degree','本科'))
  );

  -- 走真实招生流程把两份申请推到 accepted
  insert into public.applications (applicant_id, pathway, status, form_data)
  values (ap, 'bth', 'draft', good) returning id into app_id;
  perform set_config('request.jwt.claims', json_build_object('sub', ap, 'role','authenticated')::text, true);
  v := public.submit_application(app_id);
  perform set_config('request.jwt.claims', null, true);
  v := public.review_application(app_id, adm, 'start_review', null, null, null);
  v := public.review_application(app_id, adm, 'accept', '恭喜录取', null, null);

  insert into public.applications (applicant_id, pathway, status, form_data)
  values (ap2, 'common_learning', 'draft', good) returning id into app2_id;
  perform set_config('request.jwt.claims', json_build_object('sub', ap2, 'role','authenticated')::text, true);
  v := public.submit_application(app2_id);
  perform set_config('request.jwt.claims', null, true);
  v := public.review_application(app2_id, adm, 'start_review', null, null, null);
  v := public.review_application(app2_id, adm, 'accept', null, null, null);

  ------------------------------------------------------------
  -- P2-D01 accepted 但无 HQ 确认 → 建档必须失败
  ------------------------------------------------------------
  v := public.create_student_record(app_id, adm, 'AMAS-0001', null);
  if (v->>'ok')::boolean or v->>'error' <> 'hq_approval_required' then
    raise exception 'FAIL P2-D01 student created without HQ approval: %', v;
  end if;
  if exists (select 1 from public.student_records where user_id = ap) then
    raise exception 'FAIL P2-D01 student record leaked';
  end if;
  raise notice 'PASS P2-D01 accepted without HQ approval cannot create student';

  ------------------------------------------------------------
  -- P2-D02 HQ 确认为 pending / rejected 时同样不得建档
  ------------------------------------------------------------
  v := public.confirm_hq_approval(app_id, adm, 'pending', null, null, null);
  v := public.create_student_record(app_id, adm, 'AMAS-0001', null);
  if (v->>'ok')::boolean then raise exception 'FAIL P2-D02 pending HQ allowed enrollment'; end if;
  v := public.confirm_hq_approval(app_id, adm, 'rejected', null, null, null);
  v := public.create_student_record(app_id, adm, 'AMAS-0001', null);
  if (v->>'ok')::boolean then raise exception 'FAIL P2-D02 rejected HQ allowed enrollment'; end if;
  raise notice 'PASS P2-D02 pending/rejected HQ approval still blocks enrollment';

  ------------------------------------------------------------
  -- P2-D03 非管理员不得记录 HQ 确认
  ------------------------------------------------------------
  begin
    v := public.confirm_hq_approval(app_id, ap, 'approved', null, null, null);
    raise exception 'FAIL P2-D03 non-admin confirmed HQ approval';
  exception when others then
    if sqlerrm like '%actor lacks admin role%' then raise notice 'PASS P2-D03 non-admin cannot confirm HQ approval';
    else raise; end if;
  end;

  ------------------------------------------------------------
  -- P2-D04 HQ approved → 建档成功且必须是 pre_enrolled
  ------------------------------------------------------------
  v := public.confirm_hq_approval(app_id, adm, 'approved', 'HQ-2026-001', '总校已确认', '内部：批文已归档');
  if v->>'hq_status' <> 'approved' then raise exception 'FAIL P2-D04 hq not approved: %', v; end if;

  v := public.create_student_record(app_id, adm, 'amas 0001', null);
  if not (v->>'ok')::boolean then raise exception 'FAIL P2-D04 create failed: %', v; end if;
  stu_id := (v->>'student_id')::uuid;
  if (select status from public.student_records where id = stu_id) <> 'pre_enrolled' then
    raise exception 'FAIL P2-D04 initial status is not pre_enrolled';
  end if;
  if (select hq_approval_reference from public.student_records where id = stu_id) <> 'HQ-2026-001' then
    raise exception 'FAIL P2-D04 approval reference not carried';
  end if;
  raise notice 'PASS P2-D04 HQ approved enables enrollment, starts at pre_enrolled';

  ------------------------------------------------------------
  -- P2-D05 学号归一化（去空白 + 大写），原样值保留
  ------------------------------------------------------------
  select student_number_normalized into v_txt from public.student_records where id = stu_id;
  if v_txt <> 'AMAS0001' then raise exception 'FAIL P2-D05 normalization wrong: %', v_txt; end if;
  if (select student_number from public.student_records where id = stu_id) <> 'amas 0001' then
    raise exception 'FAIL P2-D05 original student number not preserved';
  end if;
  raise notice 'PASS P2-D05 student number normalized, original preserved';

  ------------------------------------------------------------
  -- P2-D06 重复建档被拒
  ------------------------------------------------------------
  v := public.create_student_record(app_id, adm, 'AMAS-0002', null);
  if (v->>'ok')::boolean or v->>'error' <> 'student_already_exists' then
    raise exception 'FAIL P2-D06 duplicate student record allowed: %', v;
  end if;
  raise notice 'PASS P2-D06 duplicate student record rejected';

  ------------------------------------------------------------
  -- P2-D07 重复学号被拒（含归一化后相同）
  ------------------------------------------------------------
  v := public.confirm_hq_approval(app2_id, adm, 'approved', 'HQ-2026-002', null, null);
  v := public.create_student_record(app2_id, adm, ' AMAS0001 ', null);
  if (v->>'ok')::boolean or v->>'error' <> 'student_number_taken' then
    raise exception 'FAIL P2-D07 duplicate student number allowed: %', v;
  end if;
  raise notice 'PASS P2-D07 duplicate student number rejected (normalized match)';

  v := public.create_student_record(app2_id, adm, 'AMAS-0002', null);
  if not (v->>'ok')::boolean then raise exception 'FAIL P2-D07 second student create failed: %', v; end if;
  stu2_id := (v->>'student_id')::uuid;

  ------------------------------------------------------------
  -- P2-D08 角色转换：授予 student，撤销 applicant
  ------------------------------------------------------------
  if not public.has_active_role(ap, 'student') then
    raise exception 'FAIL P2-D08 student role not granted';
  end if;
  if public.has_active_role(ap, 'applicant') then
    raise exception 'FAIL P2-D08 applicant role not revoked';
  end if;
  raise notice 'PASS P2-D08 student role granted, applicant role revoked';

  ------------------------------------------------------------
  -- P2-D09 学号登录别名已建立
  ------------------------------------------------------------
  select count(*) into v_cnt from public.login_aliases
   where user_id = ap and alias_type = 'student_number'
     and alias_normalized = 'AMAS0001' and revoked_at is null;
  if v_cnt <> 1 then raise exception 'FAIL P2-D09 login alias missing'; end if;
  raise notice 'PASS P2-D09 student number login alias created';

  ------------------------------------------------------------
  -- P2-D10 直接 INSERT student_records（无 RPC 上下文）被拒
  ------------------------------------------------------------
  begin
    insert into public.student_records (user_id, status) values (fin, 'pre_enrolled');
    raise exception 'FAIL P2-D10 direct insert accepted';
  exception when others then
    if sqlerrm like '%protected server flow%' then raise notice 'PASS P2-D10 direct student record insert rejected';
    else raise; end if;
  end;

  ------------------------------------------------------------
  -- P2-D11 直接 UPDATE status（pre_enrolled → active）被拒
  ------------------------------------------------------------
  begin
    update public.student_records set status = 'active' where id = stu_id;
    raise exception 'FAIL P2-D11 direct status update accepted';
  exception when others then
    if sqlerrm like '%protected server flow%' then raise notice 'PASS P2-D11 direct status change rejected';
    else raise; end if;
  end;

  ------------------------------------------------------------
  -- P2-D12 直接改学号被拒
  ------------------------------------------------------------
  begin
    update public.student_records set student_number = 'HACK-1' where id = stu_id;
    raise exception 'FAIL P2-D12 direct student number update accepted';
  exception when others then
    if sqlerrm like '%dedicated server flow%' then raise notice 'PASS P2-D12 direct student number change rejected';
    else raise; end if;
  end;

  ------------------------------------------------------------
  -- P2-D13 非管理员不得激活
  ------------------------------------------------------------
  begin
    v := public.activate_student(stu_id, ap, null, null);
    raise exception 'FAIL P2-D13 non-admin activation accepted';
  exception when others then
    if sqlerrm like '%actor lacks admin role%' then raise notice 'PASS P2-D13 non-admin cannot activate';
    else raise; end if;
  end;

  ------------------------------------------------------------
  -- P2-D14 没有学号不得激活
  ------------------------------------------------------------
  v := public.confirm_hq_approval(app2_id, adm, 'approved', null, null, null);
  perform set_config('amas.rpc_context', 'student', true);
  update public.student_records set student_number = null, student_number_normalized = null where id = stu2_id;
  perform set_config('amas.rpc_context', '', true);
  v := public.activate_student(stu2_id, adm, null, null);
  if (v->>'ok')::boolean or v->>'error' <> 'student_number_required' then
    raise exception 'FAIL P2-D14 activated without student number: %', v;
  end if;
  raise notice 'PASS P2-D14 activation requires a student number';

  ------------------------------------------------------------
  -- P2-D15 registrar 激活成功 + history + audit
  ------------------------------------------------------------
  v := public.activate_student(stu_id, adm, '学籍已生效', '内部：已通知班主任');
  if not (v->>'ok')::boolean then raise exception 'FAIL P2-D15 activation failed: %', v; end if;
  if (select status from public.student_records where id = stu_id) <> 'active' then
    raise exception 'FAIL P2-D15 status not active';
  end if;
  if (select activated_at from public.student_records where id = stu_id) is null then
    raise exception 'FAIL P2-D15 activated_at not set';
  end if;
  select count(*) into v_cnt from public.student_status_history where student_id = stu_id;
  if v_cnt <> 2 then raise exception 'FAIL P2-D15 history incomplete (got %)', v_cnt; end if;
  select count(*) into v_cnt from public.audit_logs
   where target_id = stu_id::text and category = 'academic';
  if v_cnt < 2 then raise exception 'FAIL P2-D15 audit entries missing (got %)', v_cnt; end if;
  raise notice 'PASS P2-D15 registrar activation writes status, history and audit';

  ------------------------------------------------------------
  -- P2-D16 已 active 不得重复激活
  ------------------------------------------------------------
  v := public.activate_student(stu_id, adm, null, null);
  if (v->>'ok')::boolean or v->>'error' <> 'invalid_state' then
    raise exception 'FAIL P2-D16 re-activation allowed: %', v;
  end if;
  raise notice 'PASS P2-D16 active student cannot be re-activated';

  ------------------------------------------------------------
  -- P2-D17 状态历史 append-only
  ------------------------------------------------------------
  begin
    update public.student_status_history set to_status = 'pre_enrolled' where student_id = stu_id;
    raise exception 'FAIL P2-D17 history mutated';
  exception when others then
    if sqlerrm like '%append-only%' then raise notice 'PASS P2-D17 status history is append-only';
    else raise; end if;
  end;

  ------------------------------------------------------------
  -- P2-D18 学号更正：必须有原因
  ------------------------------------------------------------
  begin
    v := public.correct_student_number(stu_id, adm, 'AMAS-9999', '  ');
    raise exception 'FAIL P2-D18 correction without reason accepted';
  exception when others then
    if sqlerrm like '%reason required%' then raise notice 'PASS P2-D18 student number correction requires a reason';
    else raise; end if;
  end;

  ------------------------------------------------------------
  -- P2-D19 学号更正成功：新号生效、旧号留痕、别名同步、审计含前后值
  ------------------------------------------------------------
  v := public.correct_student_number(stu_id, adm, 'AMAS-0009', '总校更正编号');
  if not (v->>'ok')::boolean then raise exception 'FAIL P2-D19 correction failed: %', v; end if;
  if (select student_number_normalized from public.student_records where id = stu_id) <> 'AMAS-0009' then
    raise exception 'FAIL P2-D19 new number not applied';
  end if;
  -- 0015 状态模型：换号属 A 类（真实用过）→ 旧号 retired，永久占用；不是纠错
  if not exists (select 1 from public.student_number_registry
                  where normalized = 'AMAS0001' and state = 'retired' and retired_at is not null) then
    raise exception 'FAIL P2-D19 old number not marked retired';
  end if;
  select count(*) into v_cnt from public.login_aliases
   where alias_normalized = 'AMAS0001' and revoked_at is not null;
  if v_cnt <> 1 then raise exception 'FAIL P2-D19 old alias not revoked'; end if;
  select count(*) into v_cnt from public.audit_logs
   where event_type = 'student_number_corrected' and target_id = stu_id::text
     and old_value->>'student_number' = 'amas 0001'
     and new_value->>'student_number' = 'AMAS-0009'
     and reason = '总校更正编号' and actor_id = adm;
  if v_cnt <> 1 then raise exception 'FAIL P2-D19 correction audit incomplete'; end if;
  raise notice 'PASS P2-D19 correction applies new number, retains old, syncs alias, audits both values';

  ------------------------------------------------------------
  -- P2-D20 retired（真实使用过）的旧学号不得回收给他人（核心规则）
  ------------------------------------------------------------
  v := public.correct_student_number(stu2_id, adm, 'AMAS 0001', '试图回收旧号');
  if (v->>'ok')::boolean or v->>'error' <> 'student_number_taken' then
    raise exception 'FAIL P2-D20 released student number was reassigned: %', v;
  end if;
  raise notice 'PASS P2-D20 retired student number can never be reassigned';

  ------------------------------------------------------------
  -- P2-D21 student 角色撤销 → 学号别名同事务失权
  ------------------------------------------------------------
  update public.user_roles set revoked_at = now()
   where user_id = ap and role = 'student' and revoked_at is null;
  select count(*) into v_cnt from public.login_aliases
   where user_id = ap and alias_type = 'student_number' and revoked_at is null;
  if v_cnt <> 0 then raise exception 'FAIL P2-D21 alias survived role revocation (% active)', v_cnt; end if;
  raise notice 'PASS P2-D21 revoking student role revokes the student number alias';

  -- 复原，供后续 RLS 测试
  insert into public.user_roles (user_id, role, granted_by) values (ap, 'student', adm);

  ------------------------------------------------------------
  -- P2-D22 ～ D26 RLS（切换到真实 authenticated 身份）
  ------------------------------------------------------------
  perform set_config('request.jwt.claims', json_build_object('sub', ap, 'role','authenticated')::text, true);
  set local role authenticated;

  select count(*) into v_cnt from public.student_records where user_id <> ap;
  if v_cnt <> 0 then raise exception 'FAIL P2-D22 student can read others records (% rows)', v_cnt; end if;
  raise notice 'PASS P2-D22 student cannot read other student records';

  select count(*) into v_cnt from public.student_records;
  if v_cnt <> 1 then raise exception 'FAIL P2-D23 own record not readable (% rows)', v_cnt; end if;
  raise notice 'PASS P2-D23 student can read own record';

  begin
    select count(*) into v_cnt from public.student_number_registry;
    raise exception 'FAIL P2-D24 student read the student number registry';
  exception when insufficient_privilege then
    raise notice 'PASS P2-D24 student number registry not readable by clients';
  end;

  begin
    select internal_note into v_txt from public.student_status_history limit 1;
    raise exception 'FAIL P2-D25 internal_note column readable';
  exception when insufficient_privilege then
    raise notice 'PASS P2-D25 internal_note column not granted to authenticated';
  end;

  begin
    v := public.create_student_record(app2_id, ap, 'X1', null);
    raise exception 'FAIL P2-D26 authenticated executed create_student_record';
  exception when insufficient_privilege then
    raise notice 'PASS P2-D26 privileged RPCs not executable by authenticated';
  when others then
    if sqlerrm like '%permission denied%' then raise notice 'PASS P2-D26 privileged RPCs not executable by authenticated';
    else raise; end if;
  end;

  ------------------------------------------------------------
  -- P2-D27 finance 读不到学籍记录（P2-9 ⑥ 边界）
  ------------------------------------------------------------
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', fin, 'role','authenticated')::text, true);
  set local role authenticated;
  select count(*) into v_cnt from public.student_records;
  if v_cnt <> 0 then raise exception 'FAIL P2-D27 finance read student records (% rows)', v_cnt; end if;
  raise notice 'PASS P2-D27 finance cannot read student records';

  ------------------------------------------------------------
  -- P2-D28 my_student_record 只返回自己
  ------------------------------------------------------------
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', ap, 'role','authenticated')::text, true);
  set local role authenticated;
  select count(*) into v_cnt from public.my_student_record();
  if v_cnt <> 1 then raise exception 'FAIL P2-D28 my_student_record returned % rows', v_cnt; end if;
  select count(*) into v_cnt from public.my_student_timeline();
  if v_cnt < 2 then raise exception 'FAIL P2-D28 my_student_timeline incomplete (% rows)', v_cnt; end if;
  raise notice 'PASS P2-D28 my_student_record / timeline scoped to self';

  ------------------------------------------------------------
  -- P2-D29 申请人可见自己的 HQ 结论，但看不到内部备注
  ------------------------------------------------------------
  select count(*) into v_cnt from public.application_hq_approvals;
  if v_cnt <> 1 then raise exception 'FAIL P2-D29 hq approval visibility wrong (% rows)', v_cnt; end if;
  select count(*) into v_cnt from public.hq_approval_internal;
  if v_cnt <> 0 then raise exception 'FAIL P2-D29 applicant saw HQ internal notes'; end if;
  raise notice 'PASS P2-D29 applicant sees own HQ result, never the internal note';

  ------------------------------------------------------------
  -- P2-D30 待建档队列对非管理员为空
  ------------------------------------------------------------
  select count(*) into v_cnt from public.admissions_ready_for_enrollment();
  if v_cnt <> 0 then raise exception 'FAIL P2-D30 non-admin saw enrollment queue (% rows)', v_cnt; end if;
  raise notice 'PASS P2-D30 enrollment queue empty for non-admin';

  reset role;
  -- 注销走服务端路径：auth.uid() 为空（与生产一致）。若保留申请人的 claims，
  -- application_protect_locked 会把 assigned_reviewer 钉回被删账号，产生假失败。
  perform set_config('request.jwt.claims', null, true);

  ------------------------------------------------------------
  -- P2-D31 账号注销不被历史写保护挡住（0014 回归）
  -- 学籍流程留痕的账号必须仍能删除：actor_id 置空 + 历史级联清理。
  ------------------------------------------------------------
  delete from auth.users where id = adm;
  if exists (select 1 from auth.users where id = adm) then
    raise exception 'FAIL P2-D31 actor account could not be deleted';
  end if;
  select count(*) into v_cnt from public.student_status_history
   where student_id = stu_id and actor_id is null;
  if v_cnt < 1 then raise exception 'FAIL P2-D31 actor_id not nulled on history'; end if;
  raise notice 'PASS P2-D31 actor account deletable, history retained with actor_id nulled';

  delete from auth.users where id = ap;
  select count(*) into v_cnt from public.student_status_history where student_id = stu_id;
  if v_cnt <> 0 then raise exception 'FAIL P2-D31 history not cascaded (% rows)', v_cnt; end if;
  raise notice 'PASS P2-D32 deleting the student cascades their status history';

  raise notice '=== PORTAL-2 DB ACCEPTANCE PASSED ===';
  raise exception 'ROLLBACK_OK';
exception when others then
  if sqlerrm = 'ROLLBACK_OK' then return; end if;
  raise;
end $$;
