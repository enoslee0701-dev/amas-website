-- 全流程闭环：从申请到毕业，一个人走完 AMAS B.Th 的整条路。
--   申请人注册 → 填表（D-4/5/6 字段被剥离）→ 提交 → 招生审核 → 录取 → 总校确认 → 建档发学号 → 正式注册
--   → 27 门 B.Th 课逐门开班、排教授、编班、上课点名、作业评分、录总评、提交、教务发布
--   → 5 项实践训练自报 → 毕业审核（77 学分）→ 登记毕业 → 成绩单 → 学号进入不可逆
-- 每一步都用页面实际调用的 RPC，并以对应身份执行（申请人 / 学员 / 教授走 authenticated，教务写入走 service 函数）。
-- 纯 SQL，一个事务，结束回滚。全部 NOTICE: PASS 即通过。

begin;

do $$
declare
  v_app_user uuid := '00000000-0000-4000-e000-000000000001';
  v_admin    uuid := '00000000-0000-4000-e000-000000000002';
  v_admin2   uuid := '00000000-0000-4000-e000-000000000003';
  v_teacher  uuid := '00000000-0000-4000-e000-000000000004';
  v_mentor   uuid := '00000000-0000-4000-e000-000000000005';
  v_app uuid; v_sid uuid; r jsonb; n bigint; c record; v_off uuid; v_sess uuid; v_asg uuid; v_e uuid; v_txt text;
  v_form jsonb := jsonb_build_object(
    'name_zh', '闭环学员', 'name_en', 'E2E Student', 'gender', 'female', 'birth_ym', '1995-04',
    'nationality', '泰国', 'languages', jsonb_build_array('mandarin'), 'address', '清迈市',
    'phone', '+66 80 000 0000', 'church_name', '清迈恩典堂', 'church_role', '小组长',
    'conversion_date', '2015-06', 'calling', '愿意在东南亚华人中服事', 'testimony', '信主经过……',
    'declaration_accepted', true, 'programs', jsonb_build_array('bth'),
    'education', jsonb_build_array(jsonb_build_object('school', '清迈大学', 'city', '清迈', 'start_ym', '2013-09', 'end_ym', '2017-06', 'degree', '学士')),
    'church_type', '家庭教会', 'family', jsonb_build_array(jsonb_build_object('relation', '父')), 'health', '良好');
begin
  -- ---------- E01 注册与填表 ----------
  insert into auth.users (id, email) values
    (v_app_user, 'e2e-s@amas-test.dev'), (v_admin, 'e2e-a@amas-test.dev'), (v_admin2, 'e2e-b@amas-test.dev'),
    (v_teacher, 'e2e-t@amas-test.dev'), (v_mentor, 'e2e-m@amas-test.dev');
  update public.profiles set display_name = '闭环学员' where id = v_app_user;
  insert into public.user_roles (user_id, role) values
    (v_admin, 'registrar'), (v_admin2, 'academic_admin'), (v_teacher, 'teacher'), (v_mentor, 'mentor');
  if not public.has_active_role(v_app_user, 'applicant') then raise exception 'FAIL E01 注册后应自动成为申请者'; end if;

  perform set_config('amas.test.uid', v_app_user::text, true);
  execute 'set role authenticated';
  insert into public.applications (applicant_id, pathway, status, form_data)
  values (v_app_user, 'bth', 'draft', v_form) returning id into v_app;
  execute 'reset role';
  if (select form_data ?| array['church_type','family','health'] from public.applications where id = v_app) then
    raise exception 'FAIL E01b 教会类型 / 家庭 / 健康字段应被服务端剥离（D-4/5/6）';
  end if;
  raise notice 'PASS E01 注册即为申请者；草稿入库时 D-4/D-5/D-6 字段被剥离';

  -- ---------- E02 提交与审核 ----------
  perform set_config('amas.test.uid', v_app_user::text, true);
  execute 'set role authenticated';
  r := public.submit_application(v_app);
  execute 'reset role';
  if (select status from public.applications where id = v_app) <> 'submitted' then raise exception 'FAIL E02 提交失败 %', r; end if;
  perform set_config('amas.test.uid', '', true);
  r := public.review_application(v_app, v_admin, 'start_review', '已开始审核');
  r := public.review_application(v_app, v_admin, 'accept', '恭喜录取');
  if (select status from public.applications where id = v_app) <> 'accepted' then raise exception 'FAIL E02b 录取失败 %', r; end if;
  raise notice 'PASS E02 申请提交 → 审核 → 录取';

  -- ---------- E03 总校确认、建档、正式注册 ----------
  r := public.create_student_record(v_app, v_admin, 'E2E-001', 'bth');
  if r->>'error' <> 'hq_approval_required' then raise exception 'FAIL E03 没有总校确认也能建档 %', r; end if;
  r := public.confirm_hq_approval(v_app, v_admin, 'approved', 'HQ-2026-001');
  r := public.create_student_record(v_app, v_admin, 'E2E-001', 'bth');
  v_sid := (r->>'student_id')::uuid;
  if v_sid is null then raise exception 'FAIL E03b 建档失败 %', r; end if;
  r := public.activate_student(v_sid, v_admin, '学籍已正式生效');
  if not public.has_active_role(v_app_user, 'student') or public.has_active_role(v_app_user, 'applicant') then
    raise exception 'FAIL E03c 建档后应是学员、不再是申请者';
  end if;
  if (select status from public.student_records where id = v_sid) <> 'active' then raise exception 'FAIL E03d 应已正式注册'; end if;
  raise notice 'PASS E03 总校确认 → 建档发学号 → 正式注册；角色由申请者转为学员';

  -- ---------- E04 导师 ----------
  r := public.sis_assign_mentor(v_sid, v_admin, v_mentor);
  if not (r->>'ok')::boolean then raise exception 'FAIL E04 指派导师失败 %', r; end if;
  raise notice 'PASS E04 指派导师';

  -- ---------- E05 修完 27 门 B.Th 课 ----------
  n := 0;
  for c in select code from public.course_catalog where level = 'bth' and credits is not null order by sort_order loop
    r := public.sis_create_offering(v_admin, c.code, '2026-2027', 'online', '2026-10-05', '2027-06-30', '每周二、四 19:30');
    v_off := (r->>'offering_id')::uuid;
    perform public.sis_assign_teacher(v_off, v_admin, v_teacher, 'lead');
    perform public.sis_enroll_students(v_off, v_admin, array[v_sid]);
    perform public.sis_set_offering_status(v_off, v_admin, 'in_progress');

    perform set_config('amas.test.uid', v_teacher::text, true);
    perform set_config('request.jwt.claims', '{"aal":"aal2"}', true);
    execute 'set role authenticated';
    v_sess := (public.teacher_save_session(v_off, null, '2026-10-06', '第一课', null, null)->>'session_id')::uuid;
    select (x->>'enrollment_id')::uuid into v_e from jsonb_array_elements(public.teacher_offering_detail(v_off)->'roster') x;
    perform public.teacher_set_attendance(v_sess, jsonb_build_array(jsonb_build_object('enrollment_id', v_e, 'status', 'present')));
    v_asg := (public.teacher_save_assignment(v_off, null, '读书报告', null, '2026-10-20', 30)->>'assignment_id')::uuid;
    perform public.teacher_set_scores(v_asg, jsonb_build_array(jsonb_build_object('enrollment_id', v_e, 'grade', 'A-')));
    r := public.teacher_save_grades(v_off, jsonb_build_array(jsonb_build_object('enrollment_id', v_e, 'grade', case when n % 3 = 0 then 'A' when n % 3 = 1 then 'B+' else 'C' end)));
    r := public.teacher_submit_grades(v_off);
    if not (r->>'ok')::boolean then raise exception 'FAIL E05 第 % 门提交失败 %', n + 1, r; end if;
    execute 'reset role';
    perform set_config('request.jwt.claims', '', true);

    perform public.sis_set_offering_status(v_off, v_admin, 'completed');
    r := public.sis_publish_grades(v_off, v_admin);
    if not (r->>'ok')::boolean then raise exception 'FAIL E05b 第 % 门发布失败 %', n + 1, r; end if;
    n := n + 1;
  end loop;
  if n <> 27 then raise exception 'FAIL E05c B.Th 应有 27 门带学分的课，实际 %', n; end if;
  raise notice 'PASS E05 27 门课：开班 → 排教授 → 编班 → 上课点名 → 作业评分 → 录总评 → 提交 → 结课 → 发布';

  -- ---------- E06 学员看到的进度、实践训练 ----------
  perform set_config('amas.test.uid', v_app_user::text, true);
  execute 'set role authenticated';
  r := public.my_progress();
  if (r->>'course_credits')::numeric <> 70 or jsonb_array_length(r->'missing_courses') <> 0 or (r->>'eligible')::boolean then
    raise exception 'FAIL E06 修完 27 门应得 70 学分、无未修课，但实践训练未报时不可毕业 %', r;
  end if;
  select count(*) into n from public.my_courses();
  if n <> 27 then raise exception 'FAIL E06b 结课后「我的课程」仍应列出全部 27 门，实际 %', n; end if;
  -- 与页面一致：项目清单来自 my_progress()，学员不能直读 practicum_items
  perform public.report_practicum(x->>'code', current_date, null) from jsonb_array_elements(r->'practicum') x;
  r := public.my_progress();
  if (r->>'credits_earned')::numeric <> 77 or not (r->>'eligible')::boolean then raise exception 'FAIL E06c 应修满 77 学分可毕业 %', r; end if;
  execute 'reset role';
  raise notice 'PASS E06 学员看到 70 + 7 = 77 学分，自报实践训练后达到毕业条件';

  -- ---------- E07 导师与教务看到同一份进度 ----------
  perform set_config('amas.test.uid', v_mentor::text, true);
  execute 'set role authenticated';
  if (public.mentee_detail(v_sid)->>'credits_earned')::numeric <> 77 then raise exception 'FAIL E07 导师看到的学分不对'; end if;
  execute 'reset role';
  perform set_config('amas.test.uid', v_admin::text, true);
  execute 'set role authenticated';
  if not (public.admin_student_overview(v_sid)->>'eligible')::boolean then raise exception 'FAIL E07b 教务看到的不可毕业'; end if;
  execute 'reset role';
  raise notice 'PASS E07 导师与教务看到同一份 77 学分进度';

  -- ---------- E08 毕业与成绩单 ----------
  r := public.sis_graduate(v_sid, v_admin2, '2027-06-30');
  if r->>'status' <> 'graduated' then raise exception 'FAIL E08 毕业登记失败 %', r; end if;
  perform set_config('amas.test.uid', v_app_user::text, true);
  execute 'set role authenticated';
  r := public.my_transcript();
  if jsonb_array_length(r->'courses') <> 27 or (r->>'credits_earned')::numeric <> 77 or r->'graduation'->>'graduated_on' <> '2027-06-30'
     or r->>'student_number' <> 'E2E-001' then
    raise exception 'FAIL E08b 成绩单不完整 %', r - 'courses';
  end if;
  select count(*) into n from public.my_grades();
  if n <> 27 then raise exception 'FAIL E08c 毕业后应仍看到 27 门成绩'; end if;
  execute 'reset role';
  if not public.student_number_has_irreversible_records('E2E-001') then raise exception 'FAIL E08d 毕业学号应进入不可逆'; end if;
  select count(*) into n from public.audit_logs where target_id in (v_app::text, v_sid::text);
  if n < 8 then raise exception 'FAIL E08e 全流程审计条数过少：%', n; end if;
  raise notice 'PASS E08 登记毕业 → 成绩单 27 门 77 学分 → 成绩留存 → 学号不可逆 → 全程审计 % 条', n;

  raise notice '=== FULL LIFECYCLE E2E PASSED ===';
end $$;

rollback;
