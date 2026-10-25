-- 学员管理系统补全（0033）数据库验收：外校转入学分、成绩单、授课次数、角色管理。
-- 纯 SQL，一个事务，结束回滚。全部 NOTICE: PASS 即通过。扮演方式同 sis1 / sis2。

begin;

do $$
declare
  v_a   uuid := '00000000-0000-4000-c000-000000000001';   -- 教务
  v_sa  uuid := '00000000-0000-4000-c000-000000000002';   -- super_admin
  v_t   uuid := '00000000-0000-4000-c000-000000000003';   -- 教授
  v_u1  uuid := '00000000-0000-4000-c000-000000000004';   -- 学员一
  v_u2  uuid := '00000000-0000-4000-c000-000000000005';   -- 学员二（将退学）
  v_x   uuid := '00000000-0000-4000-c000-000000000006';   -- 普通账号（将被授予导师）
  v_fin uuid := '00000000-0000-4000-c000-000000000007';
  s1 uuid; s2 uuid; v_c1 text; v_c1cr numeric; v_c2 text; r jsonb; n bigint; v_gen bigint; v_off uuid; v_e uuid;
begin
  insert into auth.users (id, email) values
    (v_a, 't-a@amas-test.dev'), (v_sa, 't-sa@amas-test.dev'), (v_t, 't-t@amas-test.dev'),
    (v_u1, 't-s1@amas-test.dev'), (v_u2, 't-s2@amas-test.dev'), (v_x, 'T-X@amas-test.dev'), (v_fin, 't-f@amas-test.dev');
  update public.profiles set display_name = '学员一', legal_name = '张学一' where id = v_u1;
  update public.profiles set display_name = '新同工' where id = v_x;
  insert into public.user_roles (user_id, role) values
    (v_a, 'registrar'), (v_sa, 'super_admin'), (v_t, 'teacher'), (v_u1, 'student'), (v_u2, 'student'), (v_fin, 'finance');
  insert into public.student_number_registry (normalized, original, first_assigned_to) values ('T-001', 'T-001', v_u1), ('T-002', 'T-002', v_u2);
  perform set_config('amas.rpc_context', 'student', true);
  insert into public.student_records (user_id, status, student_number, student_number_normalized, program_code)
  values (v_u1, 'pre_enrolled', 'T-001', 'T-001', 'bth') returning id into s1;
  perform set_config('amas.rpc_context', 'student', true);
  insert into public.student_records (user_id, status, student_number, student_number_normalized, program_code)
  values (v_u2, 'pre_enrolled', 'T-002', 'T-002', 'bth') returning id into s2;
  perform set_config('amas.rpc_context', 'student', true);
  update public.student_records set status = 'active', activated_at = now() where id = s1;
  perform set_config('amas.rpc_context', 'student', true);
  update public.student_records set status = 'active', activated_at = now() where id = s2;
  select code, credits into v_c1, v_c1cr from public.course_catalog where level = 'bth' and credits is not null order by sort_order limit 1;
  select code into v_c2 from public.course_catalog where level = 'bth' and credits is not null order by sort_order offset 1 limit 1;

  -- ---------- X01 转入学分：对应必修课（免修） ----------
  r := public.sis_add_transfer_credit(s1, v_a, v_c1, null, '', null);
  if r->>'error' <> 'reason_required' then raise exception 'FAIL X01 无原因未拒绝 %', r; end if;
  r := public.sis_add_transfer_credit(s1, v_a, v_c1, 99, '外校已修', '原校成绩单 2024-01');
  if (r->>'credits')::numeric <> v_c1cr then raise exception 'FAIL X01b 免修应按课程学分 % 计，不按填写的 99 %', v_c1cr, r; end if;
  r := public.sis_add_transfer_credit(s1, v_a, v_c1, null, '再来一次', null);
  if r->>'error' <> 'already_credited' then raise exception 'FAIL X01c 同一门课重复转入未拒绝 %', r; end if;
  r := public.sis_add_transfer_credit(s1, v_a, 'c_counseling', null, '非本项目课程', null);
  if r->>'error' <> 'unknown_course' then raise exception 'FAIL X01d 非本项目课程可转入 %', r; end if;
  r := public.graduation_audit(s1);
  if (r->>'transfer_credits')::numeric <> v_c1cr or (r->'missing_courses') @> jsonb_build_array(jsonb_build_object('code', v_c1)) then
    raise exception 'FAIL X01e 转入后应计学分且不再列为未修 %', r;
  end if;
  if r->>'gpa' is not null then raise exception 'FAIL X01f 转入学分不应产生 GPA'; end if;
  raise notice 'PASS X01 免修转入：须原因、按课程学分计、不重复、只限本项目课程、清出未修、不计 GPA';

  -- ---------- X02 转入与本校修读不重复计、不被误扣 ----------
  r := public.sis_create_offering(v_a, v_c1, '2026-2027');
  v_off := (r->>'offering_id')::uuid;
  perform public.sis_enroll_students(v_off, v_a, array[s1]);
  perform public.sis_set_offering_status(v_off, v_a, 'in_progress');
  select id into v_e from public.course_enrollments where offering_id = v_off and student_id = s1;
  insert into public.final_grades (enrollment_id, grade, status, published_at, published_by) values (v_e, 'A', 'published', now(), v_a);
  if public.sis_sync_course_credit(v_e, v_a, '测试') <> 0 then raise exception 'FAIL X02 已免修的课再修及格不应重复给学分'; end if;
  update public.final_grades set grade = 'F' where enrollment_id = v_e;
  if public.sis_sync_course_credit(v_e, v_a, '测试') <> 0 then raise exception 'FAIL X02b 本校不及格不应扣掉转入学分'; end if;
  if public.student_course_net_credits(s1, v_c1) <> v_c1cr then raise exception 'FAIL X02c 该课净学分应仍为 %', v_c1cr; end if;
  raise notice 'PASS X02 转入与本校成绩互不干扰：不重复计、不误扣';

  -- ---------- X03 一般转入学分、上限、撤回 ----------
  r := public.sis_add_transfer_credit(s1, v_a, null, 0, '一般转入', null);
  if r->>'error' <> 'bad_credits' then raise exception 'FAIL X03 0 学分未拒绝 %', r; end if;
  r := public.sis_add_transfer_credit(s1, v_a, null, 5, '外校选修', '证明 A');
  v_gen := (r->>'ledger_id')::bigint;
  update public.program_catalog set max_transfer_credits = v_c1cr + 6 where code = 'bth';
  r := public.sis_add_transfer_credit(s1, v_a, null, 2, '超过上限', null);
  if r->>'error' <> 'over_cap' then raise exception 'FAIL X03b 超上限未拒绝 %', r; end if;
  update public.program_catalog set max_transfer_credits = null where code = 'bth';
  r := public.sis_revoke_transfer(v_gen, v_a, '');
  if r->>'error' <> 'reason_required' then raise exception 'FAIL X03c 撤回无原因未拒绝 %', r; end if;
  r := public.sis_revoke_transfer(v_gen, v_a, '证明不符');
  r := public.sis_revoke_transfer(v_gen, v_a, '再撤一次');
  if r->>'error' <> 'already_revoked' then raise exception 'FAIL X03d 重复撤回未拒绝 %', r; end if;
  if (public.graduation_audit(s1)->>'transfer_credits')::numeric <> v_c1cr then raise exception 'FAIL X03e 撤回后转入学分不对'; end if;
  perform public.sis_change_student_status(s2, v_a, 'withdrawn', '退学');
  r := public.sis_add_transfer_credit(s2, v_a, null, 3, '退学后', null);
  if r->>'error' <> 'invalid_state' then raise exception 'FAIL X03f 已退学学员仍可转入 %', r; end if;
  raise notice 'PASS X03 一般转入：学分范围、上限、撤回须原因且不能重复、退学后不可转入';

  -- ---------- X04 成绩单 ----------
  perform set_config('amas.test.uid', v_u1::text, true);
  execute 'set role authenticated';
  r := public.my_transcript();
  if r->>'name' <> '张学一' or r->>'student_number' <> 'T-001' then raise exception 'FAIL X04 成绩单身份信息不对 %', r->>'name'; end if;
  if jsonb_array_length(r->'transfers') <> 1 then raise exception 'FAIL X04b 成绩单应只列未撤回的转入 1 条'; end if;
  if jsonb_array_length(r->'courses') <> 1 or r->'courses'->0->>'grade' <> 'F' then raise exception 'FAIL X04c 成绩单课程行不对 %', r->'courses'; end if;
  if public.admin_transcript(s1) is not null then raise exception 'FAIL X04d 学员能调教务成绩单'; end if;
  execute 'reset role';
  perform set_config('amas.test.uid', v_a::text, true);
  execute 'set role authenticated';
  if public.admin_transcript(s1) is null then raise exception 'FAIL X04e 教务读不到成绩单'; end if;
  if jsonb_array_length(public.admin_student_overview(s1)->'transfers') <> 2 then raise exception 'FAIL X04f 学业总览应列全部转入记录（含已撤回）'; end if;
  execute 'reset role';
  perform set_config('amas.test.uid', v_fin::text, true);
  execute 'set role authenticated';
  if public.admin_transcript(s1) is not null or public.my_transcript() is not null then raise exception 'FAIL X04g 财务读到成绩单'; end if;
  execute 'reset role';
  raise notice 'PASS X04 成绩单：本人与教务可读、只列有效转入、财务与他人不可读';

  -- ---------- X05 授课次数 ----------
  perform public.sis_assign_teacher(v_off, v_a, v_t, 'lead');
  perform set_config('amas.test.uid', v_t::text, true);
  perform set_config('request.jwt.claims', '{"aal":"aal2"}', true);
  execute 'set role authenticated';
  perform public.teacher_save_session(v_off, null, '2026-10-06', '第一课', null, null);
  perform public.teacher_save_session(v_off, null, '2026-10-08', '第二课', null, null);
  execute 'reset role';
  perform set_config('amas.test.uid', v_a::text, true);
  execute 'set role authenticated';
  select session_count into n from public.admin_list_offerings('2026-2027') where offering_id = v_off;
  if n <> 2 then raise exception 'FAIL X05 授课次数应为 2，实际 %', n; end if;
  if (select last_session_on from public.admin_list_offerings('2026-2027') where offering_id = v_off) <> '2026-10-08' then
    raise exception 'FAIL X05b 最近上课日期不对';
  end if;
  execute 'reset role';
  raise notice 'PASS X05 课程班总览显示授课次数与最近上课日';

  -- ---------- X06 角色管理 ----------
  begin
    r := public.sis_set_staff_role(v_a, v_x, 'mentor', true, '教务越权');
    raise exception 'FAIL X06 教务能授予角色';
  exception when others then if sqlerrm not like '%lacks admin role%' then raise; end if;
  end;
  r := public.sis_set_staff_role(v_sa, v_x, 'mentor', true, '');
  if r->>'error' <> 'reason_required' then raise exception 'FAIL X06b 无原因未拒绝 %', r; end if;
  r := public.sis_set_staff_role(v_sa, v_x, 'mentor', true, '新任导师');
  if not public.has_active_role(v_x, 'mentor') then raise exception 'FAIL X06c 授予导师失败 %', r; end if;
  r := public.sis_set_staff_role(v_sa, v_x, 'mentor', true, '重复');
  if r->>'error' <> 'already_assigned' then raise exception 'FAIL X06d 重复授予未拒绝 %', r; end if;
  r := public.sis_set_staff_role(v_sa, v_x, 'super_admin', true, '想升超管');
  if r->>'error' <> 'role_not_manageable' then raise exception 'FAIL X06e 能经页面授予 super_admin %', r; end if;
  r := public.sis_set_staff_role(v_sa, v_x, 'teacher', true, '跳过认证');
  if r->>'error' <> 'role_not_manageable' then raise exception 'FAIL X06f 能绕过教授认证 %', r; end if;
  r := public.sis_set_staff_role(v_sa, v_sa, 'registrar', true, '给自己');
  if r->>'error' <> 'cannot_change_self' then raise exception 'FAIL X06g 能改自己的角色 %', r; end if;
  r := public.sis_set_staff_role(v_sa, v_x, 'mentor', false, '卸任');
  if public.has_active_role(v_x, 'mentor') then raise exception 'FAIL X06h 撤销失败'; end if;
  r := public.sis_set_staff_role(v_sa, v_x, 'mentor', false, '再撤');
  if r->>'error' <> 'not_assigned' then raise exception 'FAIL X06i 重复撤销未拒绝 %', r; end if;
  if (select count(*) from public.audit_logs where category = 'security' and target_id = v_x::text
        and event_type in ('role_granted','role_revoked')) <> 2 then
    raise exception 'FAIL X06j 角色变更审计不对';
  end if;
  perform set_config('amas.test.uid', v_sa::text, true);
  execute 'set role authenticated';
  select count(*) into n from public.admin_find_user('t-x@AMAS-TEST.dev');
  if n <> 1 then raise exception 'FAIL X06k 超管按邮箱（不分大小写）找不到人'; end if;
  select count(*) into n from public.admin_list_staff();
  if n < 2 then raise exception 'FAIL X06l 同工名单不对：%', n; end if;
  execute 'reset role';
  perform set_config('amas.test.uid', v_a::text, true);
  execute 'set role authenticated';
  select count(*) into n from public.admin_find_user('t-x@amas-test.dev');
  if n <> 0 then raise exception 'FAIL X06m 教务能按邮箱查人'; end if;
  select count(*) into n from public.admin_list_staff();
  if n <> 0 then raise exception 'FAIL X06n 教务能读同工角色名单'; end if;
  execute 'reset role';
  if has_function_privilege('authenticated', 'public.sis_set_staff_role(uuid,uuid,text,boolean,text)', 'execute')
     or has_function_privilege('authenticated', 'public.sis_add_transfer_credit(uuid,uuid,text,numeric,text,text)', 'execute') then
    raise exception 'FAIL X06o 角色 / 转入学分写入对客户端可执行';
  end if;
  raise notice 'PASS X06 角色管理：只限超管、须原因、不能授超管与教授、不能改自己、审计、查人只限超管';

  -- ---------- X07 B.Th 毕业政策（0034） ----------
  if (select min_gpa from public.program_catalog where code = 'bth') is not null
     or (select max_transfer_credits from public.program_catalog where code = 'bth') is not null
     or (select credits_required from public.program_catalog where code = 'bth') <> 77 then
    raise exception 'FAIL X07 B.Th 应为 77 学分、无 GPA 门槛、转入不设上限';
  end if;
  raise notice 'PASS X07 B.Th 毕业政策：77 学分、无 GPA 门槛、转入不设上限';

  -- ---------- X08 两步验证开关（0035） ----------
  if not public.mfa_required() then raise exception 'FAIL X08 开关默认应为「要求两步验证」'; end if;
  perform set_config('amas.test.uid', v_t::text, true);
  perform set_config('request.jwt.claims', '{"aal":"aal1"}', true);
  execute 'set role authenticated';
  r := public.teacher_save_session(v_off, null, '2026-10-09', '开关开着', null, null);
  if r->>'error' is distinct from 'mfa_required' then raise exception 'FAIL X08b 开关开着时 aal1 不应能写 %', r; end if;
  begin
    update public.portal_settings set value = 'false' where key = 'mfa_required';
    raise exception 'FAIL X08c 客户端能改开关';
  exception when insufficient_privilege then null;
  end;
  execute 'reset role';
  update public.portal_settings set value = 'false' where key = 'mfa_required';
  execute 'set role authenticated';
  r := public.teacher_save_session(v_off, null, '2026-10-09', '开关关了', null, null);
  if not (r->>'ok')::boolean then raise exception 'FAIL X08d 开关关闭后 aal1 应能写 %', r; end if;
  perform set_config('amas.test.uid', v_u1::text, true);
  r := public.teacher_save_session(v_off, null, '2026-10-09', '学员越权', null, null);
  if r->>'error' is distinct from 'not_assigned' then raise exception 'FAIL X08e 开关关闭不应放松任课门禁 %', r; end if;
  execute 'reset role';
  update public.portal_settings set value = '"no"' where key = 'mfa_required';
  if not public.mfa_required() then raise exception 'FAIL X08f 开关为非布尔值时应按「要求」处理'; end if;
  delete from public.portal_settings where key = 'mfa_required';
  if not public.mfa_required() then raise exception 'FAIL X08g 开关缺行时应按「要求」处理'; end if;
  raise notice 'PASS X08 两步验证开关：默认要求、客户端改不了、只有明确 false 才放行、不放松任课门禁、异常值按要求';

  -- ---------- X09 官网报名收件箱只给教务（0036） ----------
  execute 'set role anon';
  insert into public.submissions (type, name, contact, program) values ('application', '访客甲', 'guest@example.invalid', 'bth');
  begin
    select count(*) into n from public.submissions;
    raise exception 'FAIL X09 匿名访客能回读收件箱';
  exception when insufficient_privilege then null;
  end;
  execute 'reset role';
  perform set_config('amas.test.uid', v_u1::text, true);
  execute 'set role authenticated';
  select count(*) into n from public.submissions;
  if n <> 0 then raise exception 'FAIL X09b 普通登录用户（学员 / 申请人）能读到报名收件箱 % 条', n; end if;
  update public.submissions set status = '已联系' where name = '访客甲';
  execute 'reset role';
  if (select status from public.submissions where name = '访客甲') <> '待处理' then raise exception 'FAIL X09c 普通用户能改报名状态'; end if;
  perform set_config('amas.test.uid', v_a::text, true);
  execute 'set role authenticated';
  select count(*) into n from public.submissions where name = '访客甲';
  if n <> 1 then raise exception 'FAIL X09d 教务读不到报名'; end if;
  update public.submissions set status = '已联系', note = '已电话' where name = '访客甲';
  execute 'reset role';
  if (select status from public.submissions where name = '访客甲') <> '已联系' then raise exception 'FAIL X09e 教务改不了报名状态'; end if;
  raise notice 'PASS X09 报名收件箱：访客可投递不可回读，普通用户看不到也改不了，教务可读可改';

  raise notice '=== SIS COMPLETION ACCEPTANCE PASSED ===';
end $$;

rollback;
