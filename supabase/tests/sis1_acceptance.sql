-- 学员管理系统第一期（0029 + 0030）数据库验收。
-- 纯 SQL，不用 psql 元命令：既可 `psql -f` 跑在测试库上，也可在一次性本地库里跑。
-- 全部包在一个事务里，结束回滚，不留任何数据。全部 NOTICE: PASS 即通过，任一失败即抛错。
-- 「扮演某人」= set_config('amas.test.uid', …) + set role authenticated（与 scripts/verify-g1/prelude.sql 一致；
-- 在真实 Supabase 上 auth.uid() 读 request.jwt.claims，见文件末尾说明）。

begin;

do $$
declare
  v_admin uuid := '00000000-0000-4000-a000-000000000001';
  v_t1    uuid := '00000000-0000-4000-a000-000000000002';
  v_t2    uuid := '00000000-0000-4000-a000-000000000003';
  v_u1    uuid := '00000000-0000-4000-a000-000000000004';
  v_u2    uuid := '00000000-0000-4000-a000-000000000005';
  v_u3    uuid := '00000000-0000-4000-a000-000000000006';
  v_fin   uuid := '00000000-0000-4000-a000-000000000007';
  s1 uuid; s2 uuid; s3 uuid;
  v_course text; v_off uuid; v_off2 uuid; r jsonb; n bigint; e2 uuid; v_txt text;
begin
  -- ---------- 种子 ----------
  insert into auth.users (id, email) values
    (v_admin, 'sis-admin@amas-test.dev'), (v_t1, 'sis-t1@amas-test.dev'), (v_t2, 'sis-t2@amas-test.dev'),
    (v_u1, 'sis-s1@amas-test.dev'), (v_u2, 'sis-s2@amas-test.dev'), (v_u3, 'sis-s3@amas-test.dev'),
    (v_fin, 'sis-fin@amas-test.dev');
  update public.profiles set display_name = '学员一' where id = v_u1;
  update public.profiles set display_name = '学员二' where id = v_u2;
  update public.profiles set display_name = '教授一' where id = v_t1;
  insert into public.user_roles (user_id, role) values
    (v_admin, 'registrar'), (v_t1, 'teacher'), (v_t2, 'teacher'), (v_fin, 'finance'),
    (v_u1, 'student'), (v_u2, 'student'), (v_u3, 'student');

  perform set_config('amas.rpc_context', 'student', true);
  insert into public.student_records (user_id, status, student_number) values (v_u1, 'pre_enrolled', 'SIS-T-001') returning id into s1;
  perform set_config('amas.rpc_context', 'student', true);
  insert into public.student_records (user_id, status, student_number) values (v_u2, 'pre_enrolled', 'SIS-T-002') returning id into s2;
  perform set_config('amas.rpc_context', 'student', true);
  insert into public.student_records (user_id, status) values (v_u3, 'pre_enrolled') returning id into s3;
  perform set_config('amas.rpc_context', 'student', true);
  update public.student_records set status = 'active', activated_at = now() where id = s1;
  perform set_config('amas.rpc_context', 'student', true);
  update public.student_records set status = 'active', activated_at = now() where id = s2;

  select code into v_course from public.course_catalog order by sort_order limit 1;
  if v_course is null then raise exception 'FAIL S00 课程目录为空，无法测试'; end if;

  -- ---------- S01 开课 ----------
  r := public.sis_create_offering(v_admin, v_course, '2026-2027', 'online', '2026-10-05', '2026-12-20', '每周二、四 19:30', null, null);
  if not (r->>'ok')::boolean then raise exception 'FAIL S01 开课失败 %', r; end if;
  v_off := (r->>'offering_id')::uuid;
  r := public.sis_create_offering(v_admin, v_course, '2026-2027');
  if r->>'error' <> 'offering_exists' then raise exception 'FAIL S01b 重复开课未拒绝 %', r; end if;
  r := public.sis_create_offering(v_admin, v_course, '2026-2028', 'online', null, null, null, 'B');
  if r->>'error' <> 'invalid_fields' then raise exception 'FAIL S01c 学年格式未校验 %', r; end if;
  r := public.sis_create_offering(v_admin, v_course, '2026-2027', 'online', '2026-12-01', '2026-11-01', null, 'C');
  if r->>'error' <> 'invalid_fields' then raise exception 'FAIL S01d 结课早于开课未拒绝 %', r; end if;
  r := public.sis_create_offering(v_admin, 'no-such-course', '2026-2027');
  if r->>'error' <> 'unknown_course' then raise exception 'FAIL S01e 未知课程未拒绝 %', r; end if;
  begin
    r := public.sis_create_offering(v_t1, v_course, '2026-2027', 'online', null, null, null, 'D');
    raise exception 'FAIL S01f 教授能开课';
  exception when others then
    if sqlerrm not like '%lacks admin role%' then raise; end if;
  end;
  raise notice 'PASS S01 开课：成功、重复、学年格式、日期顺序、未知课程、非教务 六种情况';

  -- ---------- S02 排教授 ----------
  r := public.sis_assign_teacher(v_off, v_admin, v_t1, 'lead');
  if not (r->>'ok')::boolean then raise exception 'FAIL S02 排教授失败 %', r; end if;
  r := public.sis_assign_teacher(v_off, v_admin, v_t1, 'assistant');
  if r->>'error' <> 'already_assigned' then raise exception 'FAIL S02b 重复指派未拒绝 %', r; end if;
  r := public.sis_assign_teacher(v_off, v_admin, v_u1, 'lead');
  if r->>'error' <> 'not_a_teacher' then raise exception 'FAIL S02c 非教授可被指派 %', r; end if;
  raise notice 'PASS S02 排教授：成功、重复、非教授';

  -- ---------- S03 编班 ----------
  r := public.sis_enroll_students(v_off, v_admin, array[s1, s2, s3, s1]);
  if (r->>'enrolled')::int <> 2 then raise exception 'FAIL S03 应编入 2 人 %', r; end if;
  if not (r->'skipped' @> jsonb_build_array(jsonb_build_object('student_id', s3, 'reason', 'not_active'))) then
    raise exception 'FAIL S03b 未在读学员应被跳过 %', r;
  end if;
  r := public.sis_enroll_students(v_off, v_admin, array[s1]);
  if not (r->'skipped' @> jsonb_build_array(jsonb_build_object('student_id', s1, 'reason', 'already_enrolled'))) then
    raise exception 'FAIL S03c 重复编班未跳过 %', r;
  end if;
  r := public.sis_update_offering(v_off, v_admin, 'online', '2026-10-05', '2026-12-20', '每周二、四 19:30', null, 1);
  if r->>'error' <> 'capacity_below_enrolled' then raise exception 'FAIL S03d 容量小于已编人数未拒绝 %', r; end if;
  raise notice 'PASS S03 编班：批量去重、跳过未在读、跳过已编入、容量保护';

  -- ---------- S04 学员视角 ----------
  perform set_config('amas.test.uid', v_u1::text, true);
  execute 'set role authenticated';
  select count(*) into n from public.my_courses();
  if n <> 1 then raise exception 'FAIL S04 学员应看到 1 门课，实际 %', n; end if;
  select teachers into v_txt from public.my_courses();
  if v_txt is distinct from '教授一' then raise exception 'FAIL S04b 学员看到的任课教授不对：%', v_txt; end if;
  select count(*) into n from public.course_enrollments;
  if n <> 1 then raise exception 'FAIL S04c 学员只应看到自己的编班，实际 % 行', n; end if;
  select count(*) into n from public.offering_roster(v_off);
  if n <> 0 then raise exception 'FAIL S04d 学员不应读到班级名单'; end if;
  begin
    insert into public.course_enrollments (offering_id, student_id) values (v_off, s3);
    raise exception 'FAIL S04e 学员能直接写编班表';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.student_records set status = 'on_leave' where id = s1;
    raise exception 'FAIL S04f 学员能直接改学籍状态';
  exception when insufficient_privilege then null;
  end;
  execute 'reset role';
  raise notice 'PASS S04 学员：只见自己的课与任课教授、读不到名单、不能直写';

  -- ---------- S05 任课教授视角 ----------
  perform set_config('amas.test.uid', v_t1::text, true);
  execute 'set role authenticated';
  select enrolled_count into n from public.my_teaching();
  if n is distinct from 2 then raise exception 'FAIL S05 教授应看到 2 名学员，实际 %', n; end if;
  select count(*) into n from public.offering_roster(v_off);
  if n <> 2 then raise exception 'FAIL S05b 名单应 2 人，实际 %', n; end if;
  select count(*) into n from public.profiles where id in (v_u1, v_u2);
  if n <> 0 then raise exception 'FAIL S05c 教授能直接读学员 profiles（含联系方式）'; end if;
  select count(*) into n from public.admin_list_students();
  if n <> 0 then raise exception 'FAIL S05d 教授能读全体学员名册'; end if;
  execute 'reset role';
  raise notice 'PASS S05 任课教授：见本班 2 人名单，读不到学员资料表与全体名册';

  -- ---------- S06 非任课教授 / 财务 ----------
  perform set_config('amas.test.uid', v_t2::text, true);
  execute 'set role authenticated';
  select count(*) into n from public.my_teaching();
  if n <> 0 then raise exception 'FAIL S06 非任课教授看到课程班'; end if;
  select count(*) into n from public.offering_roster(v_off);
  if n <> 0 then raise exception 'FAIL S06b 非任课教授读到名单'; end if;
  select count(*) into n from public.course_offerings;
  if n <> 0 then raise exception 'FAIL S06c 非任课教授直读课程班表'; end if;
  execute 'reset role';
  perform set_config('amas.test.uid', v_fin::text, true);
  execute 'set role authenticated';
  select count(*) into n from public.admin_list_offerings(null);
  if n <> 0 then raise exception 'FAIL S06d 财务读到课程班总览'; end if;
  select count(*) into n from public.course_enrollments;
  if n <> 0 then raise exception 'FAIL S06e 财务读到编班'; end if;
  execute 'reset role';
  raise notice 'PASS S06 非任课教授与财务：一律看不到';

  -- ---------- S07 教务视角 ----------
  perform set_config('amas.test.uid', v_admin::text, true);
  execute 'set role authenticated';
  select enrolled_count into n from public.admin_list_offerings('2026-2027');
  if n is distinct from 2 then raise exception 'FAIL S07 总览人数应 2，实际 %', n; end if;
  select count(*) into n from public.admin_list_teachers();
  if n <> 2 then raise exception 'FAIL S07b 可排课教授应 2 人，实际 %', n; end if;
  select count(*) into n from public.admin_list_students();
  if n <> 3 then raise exception 'FAIL S07c 学员名册应 3 人，实际 %', n; end if;
  execute 'reset role';
  raise notice 'PASS S07 教务：总览、可排课教授、学员名册';

  -- ---------- S08 退选 ----------
  select id into e2 from public.course_enrollments where offering_id = v_off and student_id = s2;
  r := public.sis_drop_enrollment(e2, v_admin, '  ');
  if r->>'error' <> 'reason_required' then raise exception 'FAIL S08 退选无原因未拒绝 %', r; end if;
  r := public.sis_drop_enrollment(e2, v_admin, '个人原因');
  if not (r->>'ok')::boolean then raise exception 'FAIL S08b 退选失败 %', r; end if;
  perform set_config('amas.test.uid', v_t1::text, true);
  execute 'set role authenticated';
  select count(*) into n from public.offering_roster(v_off);
  if n <> 1 then raise exception 'FAIL S08c 退选后名单应 1 人，实际 %', n; end if;
  execute 'reset role';
  r := public.sis_enroll_students(v_off, v_admin, array[s2]);
  if (r->>'enrolled')::int <> 1 then raise exception 'FAIL S08d 退选后可重新编入 %', r; end if;
  raise notice 'PASS S08 退选：须写原因、名单同步、可重新编入';

  -- ---------- S09 学籍状态 ----------
  r := public.sis_change_student_status(s1, v_admin, 'on_leave', '');
  if r->>'error' <> 'reason_required' then raise exception 'FAIL S09 休学无原因未拒绝 %', r; end if;
  r := public.sis_change_student_status(s1, v_admin, 'on_leave', '家庭原因');
  if r->>'status' <> 'on_leave' then raise exception 'FAIL S09b 休学失败 %', r; end if;
  r := public.sis_enroll_students(v_off, v_admin, array[s1]);
  r := public.sis_change_student_status(s1, v_admin, 'active', '复学');
  if r->>'status' <> 'active' then raise exception 'FAIL S09c 复学失败 %', r; end if;
  r := public.sis_change_student_status(s3, v_admin, 'active', '想跳过激活');
  if r->>'error' <> 'use_activate' then raise exception 'FAIL S09d 预注册不能经此直接转在读 %', r; end if;
  r := public.sis_change_student_status(s3, v_admin, 'on_leave', '未在读不能休学');
  if r->>'error' <> 'invalid_state' then raise exception 'FAIL S09e 预注册不能休学 %', r; end if;
  r := public.sis_change_student_status(s1, v_admin, 'withdrawn', '本人申请退学', '已按你的申请办理退学');
  if (r->>'enrollments_dropped')::int <> 1 then raise exception 'FAIL S09f 退学应退出 1 个课程班 %', r; end if;
  if public.has_active_role(v_u1, 'student') then raise exception 'FAIL S09g 退学后 student 角色未撤销'; end if;
  r := public.sis_change_student_status(s1, v_admin, 'active', '退学后想复学');
  if r->>'error' <> 'invalid_state' then raise exception 'FAIL S09h 退学后不应直接复学 %', r; end if;
  perform set_config('amas.test.uid', v_u1::text, true);
  execute 'set role authenticated';
  select count(*) into n from public.my_courses();
  if n <> 0 then raise exception 'FAIL S09i 退学学员仍看得到课程'; end if;
  execute 'reset role';
  select count(*) into n from public.student_status_history where student_id = s1 and to_status in ('on_leave','withdrawn');
  if n <> 2 then raise exception 'FAIL S09j 状态历史应有休学与退学两条，实际 %', n; end if;
  raise notice 'PASS S09 学籍：休学/复学/退学须原因，退学即退班并失权，预注册与已退学不能乱转';

  -- ---------- S10 课程班状态 ----------
  r := public.sis_set_offering_status(v_off, v_admin, 'completed');
  if r->>'error' <> 'invalid_state' then raise exception 'FAIL S10 未开课不能直接结课 %', r; end if;
  r := public.sis_set_offering_status(v_off, v_admin, 'in_progress');
  r := public.sis_set_offering_status(v_off, v_admin, 'completed');
  if r->>'status' <> 'completed' then raise exception 'FAIL S10b 结课失败 %', r; end if;
  r := public.sis_enroll_students(v_off, v_admin, array[s2]);
  if r->>'error' <> 'invalid_state' then raise exception 'FAIL S10c 结课后仍可编班 %', r; end if;
  r := public.sis_assign_teacher(v_off, v_admin, v_t2, 'assistant');
  if r->>'error' <> 'invalid_state' then raise exception 'FAIL S10d 结课后仍可排教授 %', r; end if;
  r := public.sis_create_offering(v_admin, v_course, '2026-2027', 'onsite', null, null, null, 'B');
  v_off2 := (r->>'offering_id')::uuid;
  r := public.sis_set_offering_status(v_off2, v_admin, 'cancelled');
  if r->>'error' <> 'reason_required' then raise exception 'FAIL S10e 取消无原因未拒绝 %', r; end if;
  raise notice 'PASS S10 课程班状态：顺序推进、结课后锁定、取消须原因';

  -- ---------- S11 教授失权即失去访问 ----------
  update public.user_roles set revoked_at = now() where user_id = v_t1 and role = 'teacher';
  perform set_config('amas.test.uid', v_t1::text, true);
  execute 'set role authenticated';
  select count(*) into n from public.offering_roster(v_off);
  if n <> 0 then raise exception 'FAIL S11 教授角色撤销后仍读到名单'; end if;
  select count(*) into n from public.my_teaching();
  if n <> 0 then raise exception 'FAIL S11b 教授角色撤销后仍看到课程班'; end if;
  execute 'reset role';
  raise notice 'PASS S11 教授角色撤销后即刻看不到课程班与名单';

  -- ---------- S12 权限与审计 ----------
  if has_function_privilege('authenticated', 'public.sis_create_offering(uuid,text,text,text,date,date,text,text,integer)', 'execute')
     or has_function_privilege('authenticated', 'public.sis_enroll_students(uuid,uuid,uuid[])', 'execute')
     or has_function_privilege('authenticated', 'public.sis_change_student_status(uuid,uuid,text,text,text)', 'execute')
     or has_function_privilege('anon', 'public.my_courses()', 'execute') then
    raise exception 'FAIL S12 写入 RPC 对客户端可执行，或读模型对匿名可执行';
  end if;
  select count(*) into n from public.audit_logs
   where event_type in ('offering_created','teacher_assigned','students_enrolled','enrollment_dropped',
                        'student_status_changed','offering_status_changed')
     and actor_id = v_admin;
  if n < 10 then raise exception 'FAIL S12b 审计条数不足：%', n; end if;
  if not exists (select 1 from public.irreversible_record_sources where table_name = 'course_enrollments') then
    raise exception 'FAIL S12c course_enrollments 未登记 R-8';
  end if;
  raise notice 'PASS S12 写入 RPC 仅 service_role、审计 % 条、R-8 已登记', n;

  raise notice '=== SIS PHASE 1 ACCEPTANCE PASSED ===';
end $$;

rollback;

-- 在真实 Supabase 测试库上跑：auth.uid() 读的是 request.jwt.claims 而不是 amas.test.uid。
-- 把本文件里的 set_config('amas.test.uid', X, true) 换成
-- set_config('request.jwt.claims', json_build_object('sub', X)::text, true) 即可。
