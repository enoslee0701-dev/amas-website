-- 学员管理系统第二至四期（0031 + 0032）数据库验收：授课 / 出勤 / 作业 / 总评 / 更正 / 学分 / 实践训练 / 毕业 / 导师。
-- 纯 SQL，一个事务，结束回滚。全部 NOTICE: PASS 即通过。扮演方式同 sis1_acceptance.sql；
-- 两步验证用 request.jwt.claims 里的 aal（与真实 Supabase 同一个设置名）。

begin;

do $$
declare
  v_a   uuid := '00000000-0000-4000-b000-000000000001';   -- 教务（registrar）
  v_b   uuid := '00000000-0000-4000-b000-000000000002';   -- 教学主管（academic_admin）
  v_t1  uuid := '00000000-0000-4000-b000-000000000003';   -- 任课教授
  v_t2  uuid := '00000000-0000-4000-b000-000000000004';   -- 非任课教授
  v_m   uuid := '00000000-0000-4000-b000-000000000005';   -- 导师
  v_u1  uuid := '00000000-0000-4000-b000-000000000006';
  v_u2  uuid := '00000000-0000-4000-b000-000000000007';
  v_fin uuid := '00000000-0000-4000-b000-000000000008';
  s1 uuid; s2 uuid; v_course text; v_cred numeric; v_off uuid; e1 uuid; e2 uuid;
  v_sess uuid; v_asg uuid; r jsonb; v_txt text; n bigint; v_corr uuid; c record; v_o uuid; v_e uuid;
begin
  -- ---------- 种子 ----------
  insert into auth.users (id, email) values
    (v_a, 'g-a@amas-test.dev'), (v_b, 'g-b@amas-test.dev'), (v_t1, 'g-t1@amas-test.dev'), (v_t2, 'g-t2@amas-test.dev'),
    (v_m, 'g-m@amas-test.dev'), (v_u1, 'g-s1@amas-test.dev'), (v_u2, 'g-s2@amas-test.dev'), (v_fin, 'g-f@amas-test.dev');
  update public.profiles set display_name = '学员一' where id = v_u1;
  update public.profiles set display_name = '学员二' where id = v_u2;
  insert into public.user_roles (user_id, role) values
    (v_a, 'registrar'), (v_b, 'academic_admin'), (v_t1, 'teacher'), (v_t2, 'teacher'), (v_m, 'mentor'),
    (v_u1, 'student'), (v_u2, 'student'), (v_fin, 'finance');
  perform set_config('amas.rpc_context', 'student', true);
  insert into public.student_number_registry (normalized, original, first_assigned_to) values ('G-001', 'G-001', v_u1), ('G-002', 'G-002', v_u2);
  insert into public.student_records (user_id, status, student_number, student_number_normalized, program_code)
  values (v_u1, 'pre_enrolled', 'G-001', 'G-001', 'bth') returning id into s1;
  perform set_config('amas.rpc_context', 'student', true);
  insert into public.student_records (user_id, status, student_number, student_number_normalized, program_code)
  values (v_u2, 'pre_enrolled', 'G-002', 'G-002', 'bth') returning id into s2;
  perform set_config('amas.rpc_context', 'student', true);
  update public.student_records set status = 'active', activated_at = now() where id = s1;
  perform set_config('amas.rpc_context', 'student', true);
  update public.student_records set status = 'active', activated_at = now() where id = s2;

  select code, credits into v_course, v_cred from public.course_catalog
   where level = 'bth' and credits is not null order by sort_order limit 1;
  if v_course is null then raise exception 'FAIL G00 没有带学分的 B.Th 课程'; end if;
  r := public.sis_create_offering(v_a, v_course, '2026-2027', 'online', '2026-10-05', '2026-12-20');
  v_off := (r->>'offering_id')::uuid;
  perform public.sis_assign_teacher(v_off, v_a, v_t1, 'lead');
  perform public.sis_enroll_students(v_off, v_a, array[s1, s2]);
  perform public.sis_set_offering_status(v_off, v_a, 'in_progress');
  select id into e1 from public.course_enrollments where offering_id = v_off and student_id = s1;
  select id into e2 from public.course_enrollments where offering_id = v_off and student_id = s2;
  if (select credits_required from public.program_catalog where code = 'bth') <> 77 then
    raise exception 'FAIL G00b B.Th 毕业学分应为 77';
  end if;

  -- ---------- G01 上课记录：两步验证与任课门禁 ----------
  perform set_config('amas.test.uid', v_t1::text, true);
  perform set_config('request.jwt.claims', '{"aal":"aal1"}', true);
  execute 'set role authenticated';
  r := public.teacher_save_session(v_off, null, '2026-10-06', '第一课', null, null);
  if r->>'error' is distinct from 'mfa_required' then raise exception 'FAIL G01 未两步验证也能记课 %', r; end if;
  perform set_config('request.jwt.claims', '{"aal":"aal2"}', true);
  r := public.teacher_save_session(v_off, null, '2026-10-06', '第一课：福音书导论', 'https://example.org/s1.pdf', null);
  if not (r->>'ok')::boolean then raise exception 'FAIL G01b 记课失败 %', r; end if;
  v_sess := (r->>'session_id')::uuid;
  r := public.teacher_save_session(v_off, null, '2026-10-08', '第二课', 'ftp://bad', null);
  if r->>'error' <> 'invalid_fields' then raise exception 'FAIL G01c 非 https 讲义链接未拒绝 %', r; end if;
  execute 'reset role';
  perform set_config('amas.test.uid', v_t2::text, true);
  execute 'set role authenticated';
  perform set_config('request.jwt.claims', '{"aal":"aal2"}', true);
  r := public.teacher_save_session(v_off, null, '2026-10-06', '越权', null, null);
  if r->>'error' is distinct from 'not_assigned' then raise exception 'FAIL G01d 非任课教授能记课 %', r; end if;
  r := public.teacher_save_grades(v_off, jsonb_build_array(jsonb_build_object('enrollment_id', e1, 'grade', 'A+')));
  if r->>'error' is distinct from 'not_assigned' then raise exception 'FAIL G01d2 非任课教授能录成绩 %', r; end if;
  select count(*) into n from public.teacher_offering_detail(v_off) x where x is not null;
  if n <> 0 then raise exception 'FAIL G01e 非任课教授读到班级详情'; end if;
  execute 'reset role';
  raise notice 'PASS G01 记课：须两步验证、须本班任课、讲义链接须 https';

  -- ---------- G02 出勤 / 作业 ----------
  perform set_config('amas.test.uid', v_t1::text, true);
  execute 'set role authenticated';
  r := public.teacher_set_attendance(v_sess, jsonb_build_array(
        jsonb_build_object('enrollment_id', e1, 'status', 'present'),
        jsonb_build_object('enrollment_id', e2, 'status', 'absent', 'note', '请假未批'),
        jsonb_build_object('enrollment_id', gen_random_uuid(), 'status', 'present'),
        jsonb_build_object('enrollment_id', e1, 'status', 'sleeping')));
  if (r->>'saved')::int <> 2 or (r->>'rejected')::int <> 2 then raise exception 'FAIL G02 出勤应存 2 拒 2 %', r; end if;
  r := public.teacher_save_assignment(v_off, null, '读书报告', '马太福音 5-7 章', '2026-10-20', 30);
  v_asg := (r->>'assignment_id')::uuid;
  r := public.teacher_save_assignment(v_off, null, '权重越界', null, null, 150);
  if r->>'error' <> 'invalid_fields' then raise exception 'FAIL G02b 权重越界未拒绝 %', r; end if;
  r := public.teacher_set_scores(v_asg, jsonb_build_array(
        jsonb_build_object('enrollment_id', e1, 'grade', 'A', 'comment', '结构清楚'),
        jsonb_build_object('enrollment_id', e2, 'grade', 'Z')));
  if (r->>'saved')::int <> 1 or (r->>'rejected')::int <> 1 then raise exception 'FAIL G02c 评分应存 1 拒 1 %', r; end if;
  begin
    select count(*) into n from public.attendance_records;
    raise exception 'FAIL G02d 教授能直读出勤表';
  exception when insufficient_privilege then null;
  end;
  execute 'reset role';
  raise notice 'PASS G02 出勤与作业：只收本班在读学员、只收合法等级、表不可直读';

  -- ---------- G03 总评：草稿 → 提交 → 锁定 ----------
  perform set_config('amas.test.uid', v_t1::text, true);
  execute 'set role authenticated';
  r := public.teacher_save_grades(v_off, jsonb_build_array(jsonb_build_object('enrollment_id', e1, 'grade', 'B+')));
  r := public.teacher_submit_grades(v_off);
  if r->>'error' <> 'grades_incomplete' then raise exception 'FAIL G03 有人没成绩也能提交 %', r; end if;
  r := public.teacher_save_grades(v_off, jsonb_build_array(jsonb_build_object('enrollment_id', e2, 'grade', 'F')));
  r := public.teacher_submit_grades(v_off);
  if (r->>'submitted')::int <> 2 then raise exception 'FAIL G03b 提交应 2 人 %', r; end if;
  r := public.teacher_save_grades(v_off, jsonb_build_array(jsonb_build_object('enrollment_id', e1, 'grade', 'A')));
  if (r->>'locked')::int <> 1 then raise exception 'FAIL G03c 已提交的成绩还能改 %', r; end if;
  execute 'reset role';
  r := public.sis_return_grades(v_off, v_a, '');
  if r->>'error' <> 'reason_required' then raise exception 'FAIL G03d 退回无原因未拒绝 %', r; end if;
  r := public.sis_return_grades(v_off, v_a, '请核对学员二的成绩');
  if (r->>'returned')::int <> 2 then raise exception 'FAIL G03e 退回应 2 人 %', r; end if;
  perform set_config('amas.test.uid', v_t1::text, true);
  execute 'set role authenticated';
  select (x->>'returned_reason') into v_txt from jsonb_array_elements(public.teacher_offering_detail(v_off)->'roster') x limit 1;
  if coalesce(v_txt, '') not like '%核对%' then raise exception 'FAIL G03f 教授看不到退回原因'; end if;
  r := public.teacher_submit_grades(v_off);
  execute 'reset role';
  raise notice 'PASS G03 总评：缺成绩不能提交、提交后锁定、教务退回须原因且教授看得到';

  -- ---------- G04 发布与学分 ----------
  perform set_config('amas.test.uid', v_u1::text, true);
  execute 'set role authenticated';
  select count(*) into n from public.my_grades();
  if n <> 0 then raise exception 'FAIL G04 未发布的成绩学员已看得到'; end if;
  execute 'reset role';
  r := public.sis_publish_grades(v_off, v_a);
  if (r->>'published')::int <> 2 or (r->>'credits_added')::numeric <> v_cred then
    raise exception 'FAIL G04b 发布 2 人、只给及格者 % 学分 %', v_cred, r;
  end if;
  r := public.sis_publish_grades(v_off, v_a);
  if r->>'error' <> 'nothing_to_publish' then raise exception 'FAIL G04c 重复发布未拒绝 %', r; end if;
  perform set_config('amas.test.uid', v_u1::text, true);
  execute 'set role authenticated';
  select count(*) into n from public.my_grades() where grade = 'B+' and points = 3.3;
  if n <> 1 then raise exception 'FAIL G04d 学员一应看到 B+ / 3.3'; end if;
  r := public.my_progress();
  if (r->>'credits_earned')::numeric <> v_cred or (r->>'gpa')::numeric <> 3.3 then
    raise exception 'FAIL G04e 学员一学分 / GPA 不对 %', r;
  end if;
  r := public.my_course_detail(v_off);
  if r->'attendance'->0->>'status' <> 'present' or r->'assignments'->0->>'grade' <> 'A' or r->>'final_grade' <> 'B+' then
    raise exception 'FAIL G04f 学员一课程详情不对 %', r;
  end if;
  begin
    select count(*) into n from public.credit_ledger;
    raise exception 'FAIL G04g 学员能直读学分账本';
  exception when insufficient_privilege then null;
  end;
  execute 'reset role';
  perform set_config('amas.test.uid', v_u2::text, true);
  execute 'set role authenticated';
  r := public.my_progress();
  if (r->>'credits_earned')::numeric <> 0 or not (r->'missing_courses' @> jsonb_build_array(jsonb_build_object('code', v_course))) then
    raise exception 'FAIL G04h 不及格不应得学分，且应列为未修 %', r;
  end if;
  r := public.my_course_detail(v_off);
  if r->'attendance'->0->>'status' <> 'absent' then raise exception 'FAIL G04i 学员二出勤不对'; end if;
  execute 'reset role';
  raise notice 'PASS G04 发布：之前学员看不到、只给及格者学分、GPA 正确、不能重复发布、账本不可直读';

  -- ---------- G05 成绩更正 ----------
  perform set_config('amas.test.uid', v_t1::text, true);
  execute 'set role authenticated';
  r := public.teacher_request_correction(e2, 'C', '');
  if r->>'error' <> 'reason_required' then raise exception 'FAIL G05 更正无原因未拒绝 %', r; end if;
  r := public.teacher_request_correction(e2, 'C', '期末论文漏登');
  v_corr := (r->>'correction_id')::uuid;
  r := public.teacher_request_correction(e2, 'B', '再来一次');
  if r->>'error' <> 'correction_pending' then raise exception 'FAIL G05b 重复申请未拒绝 %', r; end if;
  execute 'reset role';
  r := public.sis_decide_correction(v_corr, v_b, false, '');
  if r->>'error' <> 'reason_required' then raise exception 'FAIL G05c 驳回无理由未拒绝 %', r; end if;
  r := public.sis_decide_correction(v_corr, v_b, true, '核实无误');
  if (r->>'credit_delta')::numeric <> v_cred then raise exception 'FAIL G05d F→C 应补 % 学分 %', v_cred, r; end if;
  perform set_config('amas.test.uid', v_t1::text, true);
  execute 'set role authenticated';
  r := public.teacher_request_correction(e2, 'F', '误改，恢复原成绩');
  v_corr := (r->>'correction_id')::uuid;
  execute 'reset role';
  r := public.sis_decide_correction(v_corr, v_a, true, '同意');
  if (r->>'credit_delta')::numeric <> -v_cred then raise exception 'FAIL G05e C→F 应扣回学分 %', r; end if;
  if public.student_course_net_credits(s2, v_course) <> 0 then raise exception 'FAIL G05f 净学分应归零'; end if;
  begin
    update public.credit_ledger set credits = 99 where student_id = s2;
    raise exception 'FAIL G05g 学分账本可被改写';
  exception when others then if sqlerrm not like '%append-only%' then raise; end if;
  end;
  raise notice 'PASS G05 更正：须原因、不能重复、批准后学分随之增减、账本只增不改';

  -- ---------- G06 实践训练自报 ----------
  perform set_config('amas.test.uid', v_u1::text, true);
  execute 'set role authenticated';
  r := public.report_practicum('p_prayer', current_date + 3, null);
  if r->>'error' <> 'bad_date' then raise exception 'FAIL G06 未来日期未拒绝 %', r; end if;
  r := public.report_practicum('p_nope', current_date, null);
  if r->>'error' <> 'unknown_item' then raise exception 'FAIL G06b 未知项目未拒绝 %', r; end if;
  r := public.report_practicum('p_prayer', current_date, '每日早祷');
  if (r->>'credits_added')::numeric <> 2 then raise exception 'FAIL G06c 祷告训练应得 2 学分 %', r; end if;
  r := public.report_practicum('p_prayer', current_date - 1, '改日期');
  if (r->>'credits_added')::numeric <> 0 then raise exception 'FAIL G06d 重报不应重复给学分 %', r; end if;
  r := public.retract_practicum('p_prayer');
  r := public.my_progress();
  if (r->>'practicum_credits')::numeric <> 0 then raise exception 'FAIL G06e 撤回后应扣回 %', r; end if;
  r := public.report_practicum('p_prayer', current_date, null);
  r := public.my_progress();
  if (r->>'practicum_credits')::numeric <> 2 then raise exception 'FAIL G06f 再报应恢复 2 学分 %', r; end if;
  execute 'reset role';
  raise notice 'PASS G06 实践训练：学员自报即计学分、不重复计、可撤回、日期与项目校验';

  -- ---------- G07 毕业审核 ----------
  r := public.sis_graduate(s1, v_a, current_date);
  if r->>'error' <> 'not_eligible' then raise exception 'FAIL G07 学分不足也能毕业 %', r; end if;
  -- 让学员一修完全部 B.Th 课程（每门开一个已结课的班并发布 B 等成绩）
  for c in select code from public.course_catalog where level = 'bth' and credits is not null and code <> v_course loop
    r := public.sis_create_offering(v_a, c.code, '2026-2027');
    v_o := (r->>'offering_id')::uuid;
    perform public.sis_enroll_students(v_o, v_a, array[s1]);
    perform public.sis_set_offering_status(v_o, v_a, 'in_progress');
    select id into v_e from public.course_enrollments where offering_id = v_o and student_id = s1;
    insert into public.final_grades (enrollment_id, grade, status, published_at, published_by)
    values (v_e, 'B', 'published', now(), v_a);
    perform public.sis_sync_course_credit(v_e, v_a, '测试');
  end loop;
  r := public.graduation_audit(s1);
  if (r->>'course_credits')::numeric <> 70 then raise exception 'FAIL G07b 修完 B.Th 课程应 70 学分 %', r->>'course_credits'; end if;
  if (r->>'eligible')::boolean then raise exception 'FAIL G07c 实践训练没修满就判可毕业'; end if;
  perform set_config('amas.test.uid', v_u1::text, true);
  execute 'set role authenticated';
  perform public.report_practicum(x, current_date, null) from unnest(array['p_reading','p_devotion','p_evangelism','p_giving']) x;
  execute 'reset role';
  r := public.graduation_audit(s1);
  if not (r->>'eligible')::boolean or (r->>'credits_earned')::numeric <> 77 then
    raise exception 'FAIL G07d 修满 77 学分应可毕业 %', r;
  end if;
  update public.program_catalog set min_gpa = 3.5 where code = 'bth';
  if (public.graduation_audit(s1)->>'eligible')::boolean then raise exception 'FAIL G07e GPA 门槛没起作用'; end if;
  update public.program_catalog set min_gpa = 2.0 where code = 'bth';
  r := public.sis_graduate(s1, v_a, '2027-06-30');
  if r->>'status' <> 'graduated' then raise exception 'FAIL G07f 毕业登记失败 %', r; end if;
  if not exists (select 1 from public.graduation_records where student_id = s1 and total_credits = 77) then
    raise exception 'FAIL G07g 毕业记录缺失';
  end if;
  if not public.student_number_has_irreversible_records('G-001') then
    raise exception 'FAIL G07h 毕业学员的学号未被识别为有不可逆记录';
  end if;
  if (select count(*) from public.irreversible_record_sources src
       where src.is_irreversible = 'yes'
         and src.source_key in ('final_grades_published','credit_ledger','graduation_records')) <> 3 then
    raise exception 'FAIL G07h2 成绩 / 学分 / 毕业三类未全部登记为不可逆';
  end if;
  perform set_config('amas.test.uid', v_u1::text, true);
  execute 'set role authenticated';
  r := public.report_practicum('p_prayer', current_date, null);
  if r->>'error' <> 'invalid_state' then raise exception 'FAIL G07i 已毕业还能改实践训练 %', r; end if;
  select count(*) into n from public.my_grades();
  if n < 27 then raise exception 'FAIL G07j 毕业学员应仍能看到成绩'; end if;
  execute 'reset role';
  raise notice 'PASS G07 毕业：学分 / 课程 / 实践训练 / GPA 四项齐才可毕业，毕业后登记、成绩留存、学号进入不可逆';

  -- ---------- G08 导师 ----------
  r := public.sis_assign_mentor(s2, v_a, v_t2);
  if r->>'error' <> 'not_a_mentor' then raise exception 'FAIL G08 非导师可被指派 %', r; end if;
  r := public.sis_assign_mentor(s2, v_a, v_m);
  if not (r->>'ok')::boolean then raise exception 'FAIL G08b 指派导师失败 %', r; end if;
  perform set_config('amas.test.uid', v_m::text, true);
  perform set_config('request.jwt.claims', '{"aal":"aal2"}', true);
  execute 'set role authenticated';
  select count(*) into n from public.my_mentees();
  if n <> 1 then raise exception 'FAIL G08c 导师应看到 1 名学员'; end if;
  if public.mentee_detail(s2) is null then raise exception 'FAIL G08d 导师看不到所带学员进度'; end if;
  if public.mentee_detail(s1) is not null then raise exception 'FAIL G08e 导师看到非所带学员'; end if;
  r := public.mentor_add_note(s2, '本周谈了服事方向');
  if not (r->>'ok')::boolean then raise exception 'FAIL G08f 写陪伴记录失败 %', r; end if;
  r := public.mentor_add_note(s1, '越权');
  if r->>'error' is distinct from 'not_assigned' then raise exception 'FAIL G08g 导师能给非所带学员写记录 %', r; end if;
  execute 'reset role';
  perform set_config('amas.test.uid', v_u2::text, true);
  execute 'set role authenticated';
  begin
    select count(*) into n from public.mentor_notes;
    raise exception 'FAIL G08h 学员能直读陪伴记录';
  exception when insufficient_privilege then null;
  end;
  if public.mentee_detail(s2) is not null then raise exception 'FAIL G08i 学员能调导师视图'; end if;
  execute 'reset role';
  perform set_config('amas.test.uid', v_t1::text, true);
  execute 'set role authenticated';
  if public.mentee_detail(s2) is not null then raise exception 'FAIL G08j 教授能调导师视图'; end if;
  execute 'reset role';
  update public.user_roles set revoked_at = now() where user_id = v_m and role = 'mentor';
  perform set_config('amas.test.uid', v_m::text, true);
  execute 'set role authenticated';
  select count(*) into n from public.my_mentees();
  if n <> 0 then raise exception 'FAIL G08k 导师角色撤销后仍看得到学员'; end if;
  execute 'reset role';
  raise notice 'PASS G08 导师：只看所带学员、写记录须指派、学员与教授看不到陪伴记录、失权即失访问';

  -- ---------- G09 教务视图与权限 ----------
  perform set_config('amas.test.uid', v_a::text, true);
  execute 'set role authenticated';
  select count(*) into n from public.admin_grade_queue();
  if n < 1 then raise exception 'FAIL G09 教务成绩队列为空'; end if;
  if public.admin_student_overview(s2) is null then raise exception 'FAIL G09b 教务看不到学员总览'; end if;
  execute 'reset role';
  perform set_config('amas.test.uid', v_fin::text, true);
  execute 'set role authenticated';
  select count(*) into n from public.admin_grade_queue();
  if n <> 0 then raise exception 'FAIL G09c 财务读到成绩队列'; end if;
  if public.admin_student_overview(s2) is not null or public.my_progress() is not null then
    raise exception 'FAIL G09d 财务读到学员学业';
  end if;
  execute 'reset role';
  if has_function_privilege('authenticated', 'public.sis_publish_grades(uuid,uuid)', 'execute')
     or has_function_privilege('authenticated', 'public.sis_graduate(uuid,uuid,date)', 'execute')
     or has_function_privilege('authenticated', 'public.graduation_audit(uuid)', 'execute')
     or has_function_privilege('authenticated', 'public.sis_sync_course_credit(uuid,uuid,text)', 'execute')
     or has_function_privilege('anon', 'public.my_grades()', 'execute') then
    raise exception 'FAIL G09e 教务写入或内部计算对客户端可执行';
  end if;
  select count(*) into n from public.audit_logs where event_type in
    ('session_recorded','attendance_recorded','assignment_saved','assignment_scored','grades_drafted','grades_submitted',
     'grades_returned','grades_published','grade_correction_requested','grade_corrected','practicum_reported',
     'practicum_retracted','student_graduated','mentor_assigned','mentor_note_added');
  if n < 15 then raise exception 'FAIL G09f 审计条数不足：%', n; end if;
  raise notice 'PASS G09 教务视图可用、财务看不到学业、写入仅 service_role、审计 % 条', n;

  raise notice '=== SIS PHASE 2-4 ACCEPTANCE PASSED ===';
end $$;

rollback;
