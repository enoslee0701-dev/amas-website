-- ============================================================
-- PORTAL-2B · 数据库层验收（课程目录 / 资料读写分离 / 学习读模型 / 能力门禁 / 待办派生）
-- 运行：psql -f supabase/tests/portal2b_acceptance.sql   结束自动回滚
-- ============================================================
do $$
declare
  stu uuid := gen_random_uuid();   -- active 学生
  pre uuid := gen_random_uuid();   -- pre_enrolled 学生
  oth uuid := gen_random_uuid();   -- 另一学生
  reg uuid := gen_random_uuid();   -- registrar
  app_s uuid; app_p uuid; app_o uuid;
  sid uuid; pid uuid;
  v jsonb; v_cnt int; v_txt text; good jsonb;
  users uuid[]; apps uuid[] := '{}'; i int; aid uuid;
begin
  ------------------------------------------------------------
  -- 种子
  ------------------------------------------------------------
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
                          raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  select u.id, '00000000-0000-0000-0000-000000000000','authenticated','authenticated', u.em,
         crypt('T!123456', gen_salt('bf')), now(), '{"provider":"email"}',
         jsonb_build_object('display_name', u.nm), now(), now()
  from (values (stu,'b-stu@test.amas','STU'), (pre,'b-pre@test.amas','PRE'),
               (oth,'b-oth@test.amas','OTH'), (reg,'b-reg@test.amas','REG')) as u(id, em, nm);
  insert into public.user_roles (user_id, role, granted_by) values (reg,'registrar',reg);

  good := jsonb_build_object(
    'name_zh','体验测试','birth_ym','1995-06','gender','male','nationality','中国',
    'phone','+86 13800000000','address','广州市','church_name','测试教会',
    'church_role','小组同工','conversion_date','2015-03','calling','愿意接受装备',
    'testimony','见证内容。','declaration_accepted', true,
    'programs', jsonb_build_array('bth'), 'languages', jsonb_build_array('mandarin'),
    'education', jsonb_build_array(jsonb_build_object('school','某大学','city','广州','start_ym','2013-09','end_ym','2017-06','degree','本科')));

  users := array[stu, pre, oth];
  for i in 1..3 loop
    insert into public.applications (applicant_id, pathway, status, form_data)
    values (users[i], 'bth', 'draft', good) returning id into aid;
    perform set_config('request.jwt.claims', json_build_object('sub', users[i], 'role','authenticated')::text, true);
    v := public.submit_application(aid);
    perform set_config('request.jwt.claims', null, true);
    v := public.review_application(aid, reg, 'start_review', null, null, null);
    v := public.review_application(aid, reg, 'accept', null, null, null);
    v := public.confirm_hq_approval(aid, reg, 'approved', 'HQ-2B-' || i, '总校已确认', '内部备注不应外泄');
    apps := apps || aid;
  end loop;
  app_s := apps[1]; app_p := apps[2]; app_o := apps[3];

  v := public.create_student_record(app_s, reg, 'B2B-0001', null);  sid := (v->>'student_id')::uuid;
  v := public.activate_student(sid, reg, '学籍已生效', null);
  v := public.create_student_record(app_p, reg, 'B2B-0002', null);  pid := (v->>'student_id')::uuid;
  v := public.create_student_record(app_o, reg, 'B2B-0003', null);

  ------------------------------------------------------------
  -- B01 课程目录：恰好 67 门，credits 全为 null
  ------------------------------------------------------------
  select count(*) into v_cnt from public.course_catalog;
  if v_cnt <> 67 then raise exception 'FAIL B01 course_catalog 应为 67 门，实为 %', v_cnt; end if;
  select count(*) into v_cnt from public.course_catalog where credits is not null;
  if v_cnt <> 0 then raise exception 'FAIL B01 有 % 门课程被填了 credits', v_cnt; end if;
  raise notice 'PASS B01 课程目录 67 门且 credits 全为 null';

  ------------------------------------------------------------
  -- B02 credits 被写入必须直接失败（守卫是约束不是约定）
  ------------------------------------------------------------
  begin
    update public.course_catalog set credits = 3 where code = 'c_matthew';
    raise exception 'FAIL B02 credits 被写入成功';
  exception when others then
    if sqlerrm like '%credits 未经正式学分表批准%' then raise notice 'PASS B02 写入 credits 被数据库拒绝';
    else raise; end if;
  end;

  ------------------------------------------------------------
  -- B03 七大类计数与权威目录一致
  ------------------------------------------------------------
  if (select count(*) from public.course_catalog where category='nt') <> 27
     or (select count(*) from public.course_catalog where category='ot') <> 2
     or (select count(*) from public.course_catalog where category='bible_basics') <> 3
     or (select count(*) from public.course_catalog where category='theology') <> 11
     or (select count(*) from public.course_catalog where category='practical') <> 18
     or (select count(*) from public.course_catalog where category='history') <> 3
     or (select count(*) from public.course_catalog where category='language') <> 3 then
    raise exception 'FAIL B03 分类计数与 OFFICIAL_CATALOG 不一致';
  end if;
  raise notice 'PASS B03 七大类计数 27/2/3/11/18/3/3 与权威目录一致';

  ------------------------------------------------------------
  -- B04 客户端不可写课程目录
  ------------------------------------------------------------
  perform set_config('request.jwt.claims', json_build_object('sub', stu, 'role','authenticated')::text, true);
  set local role authenticated;
  begin
    insert into public.course_catalog (code, title_zh, category) values ('c_hack','伪造课程','nt');
    raise exception 'FAIL B04 学生写入了课程目录';
  exception when insufficient_privilege then
    raise notice 'PASS B04 学生不可写课程目录';
  end;

  ------------------------------------------------------------
  -- B05 学习读模型：只返回 catalogued / content_pending，绝不产生其他状态
  ------------------------------------------------------------
  select count(*) into v_cnt from public.my_learning();
  if v_cnt <> 67 then raise exception 'FAIL B05 my_learning 返回 % 行', v_cnt; end if;
  select count(*) into v_cnt from public.my_learning()
   where learning_state not in ('catalogued','content_pending');
  if v_cnt <> 0 then raise exception 'FAIL B05 出现了没有数据源的学习状态（% 行）', v_cnt; end if;
  select count(*) into v_cnt from public.my_learning() where learning_state = 'content_pending';
  if v_cnt <> 21 then raise exception 'FAIL B05 内容筹备中应为 21 门，实为 %', v_cnt; end if;
  select count(*) into v_cnt from public.my_learning() where credits is not null;
  if v_cnt <> 0 then raise exception 'FAIL B05 学习读模型返回了非 null 的 credits'; end if;
  raise notice 'PASS B05 学习读模型只产生有数据源的状态，credits 全 null';

  ------------------------------------------------------------
  -- B06 资料读模型：可改字段与教务字段分区正确
  ------------------------------------------------------------
  v := public.my_student_profile();
  if v->'self_editable' is null or v->'registrar_managed' is null then
    raise exception 'FAIL B06 资料未分区';
  end if;
  if (v->'registrar_managed'->>'student_number') <> 'B2B-0001' then
    raise exception 'FAIL B06 学号未出现在教务分区';
  end if;
  if (v->'self_editable') ? 'student_number' or (v->'self_editable') ? 'status' then
    raise exception 'FAIL B06 学籍字段出现在自助分区';
  end if;
  if (v->'registrar_managed'->'hq_approval'->>'status') <> 'approved' then
    raise exception 'FAIL B06 HQ 结论摘要缺失';
  end if;
  raise notice 'PASS B06 自助字段与教务字段正确分区，含 HQ 结论摘要';

  ------------------------------------------------------------
  -- B07 HQ 内部备注绝不进入学生视图
  ------------------------------------------------------------
  if v::text like '%内部备注不应外泄%' then
    raise exception 'FAIL B07 HQ 内部备注泄漏到学生资料';
  end if;
  raise notice 'PASS B07 HQ 内部备注未泄漏';

  ------------------------------------------------------------
  -- B08 本人只能改白名单字段
  ------------------------------------------------------------
  v := public.update_my_contact('新名字', '+86 13900000000', '微信 amas');
  if (select phone from public.profiles where id = stu) <> '+86 13900000000' then
    raise exception 'FAIL B08 联系电话未保存';
  end if;
  if (select display_name from public.profiles where id = stu) <> '新名字' then
    raise exception 'FAIL B08 姓名未保存';
  end if;
  raise notice 'PASS B08 本人可维护联系资料';

  ------------------------------------------------------------
  -- B09 直接 PATCH profiles 改不到学籍字段（学籍不在 profiles 上）+ 不能改他人
  ------------------------------------------------------------
  update public.profiles set display_name = '越权改名' where id = oth;
  if (select display_name from public.profiles where id = oth) = '越权改名' then
    raise exception 'FAIL B09 学生改到了他人资料';
  end if;
  raise notice 'PASS B09 学生改不到他人资料';

  ------------------------------------------------------------
  -- B10 学生不能自改学号 / 学籍状态
  ------------------------------------------------------------
  begin
    update public.student_records set student_number = 'HACK' where id = sid;
    raise exception 'FAIL B10 学生改到了自己的学号';
  exception when insufficient_privilege then
    raise notice 'PASS B10a 学生不可写 student_records';
  when others then
    if sqlerrm like '%dedicated server flow%' then raise notice 'PASS B10a 学号修改被拒';
    else raise; end if;
  end;

  ------------------------------------------------------------
  -- B11 学生不能改 HQ approval
  ------------------------------------------------------------
  begin
    update public.application_hq_approvals set status = 'approved' where application_id = app_s;
    raise exception 'FAIL B11 学生改到了 HQ 审核';
  exception when insufficient_privilege then
    raise notice 'PASS B11 学生不可写 HQ 审核记录';
  end;

  ------------------------------------------------------------
  -- B12 能力门禁：active 与 pre_enrolled 的差异，且课程访问不因 active 自动为真
  ------------------------------------------------------------
  v := public.my_student_capabilities();
  if (v->>'status') <> 'active' then raise exception 'FAIL B12 能力门禁状态错误: %', v; end if;
  if not (v->>'official_student_services')::boolean then
    raise exception 'FAIL B12 active 未开放正式学生能力';
  end if;
  if (v->>'course_content_access')::boolean then
    raise exception 'FAIL B12 course_content_access 不应因 active 自动为真（当前无数据源）';
  end if;
  raise notice 'PASS B12 active 能力正确，且课程访问未被 status 自动推断';

  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', pre, 'role','authenticated')::text, true);
  set local role authenticated;
  v := public.my_student_capabilities();
  if (v->>'status') <> 'pre_enrolled' then raise exception 'FAIL B13 pre_enrolled 状态错误'; end if;
  if (v->>'official_student_services')::boolean then
    raise exception 'FAIL B13 pre_enrolled 取得了仅 active 开放的能力';
  end if;
  if not (v->>'edit_own_contact')::boolean or not (v->>'browse_catalog')::boolean
     or not (v->>'build_christian_profile')::boolean then
    raise exception 'FAIL B13 pre_enrolled 缺少应有的基础能力';
  end if;
  raise notice 'PASS B13 pre_enrolled 只有基础能力，未获得 active 专属能力';

  ------------------------------------------------------------
  -- B14 待办事项：由真实状态派生，且 pre_enrolled 会出现"等待正式注册"
  ------------------------------------------------------------
  select count(*) into v_cnt from public.my_action_items()
   where source_type = 'student_record' and status = 'waiting';
  if v_cnt <> 1 then raise exception 'FAIL B14 pre_enrolled 未产生等待注册事项'; end if;
  select count(*) into v_cnt from public.my_action_items()
   where source_type is null or reason is null or target_url is null or status is null;
  if v_cnt <> 0 then raise exception 'FAIL B14 存在缺少 source_type/reason/target_url/status 的事项'; end if;
  raise notice 'PASS B14 待办事项均由真实状态派生且字段完整';

  ------------------------------------------------------------
  -- B15 填了电话后"完善联系方式"事项自动消失（派生而非存储）
  ------------------------------------------------------------
  select count(*) into v_cnt from public.my_action_items() where source_type = 'profile';
  if v_cnt <> 1 then raise exception 'FAIL B15 未产生完善资料事项'; end if;
  v := public.update_my_contact(null, '+86 13700000000', null);
  select count(*) into v_cnt from public.my_action_items() where source_type = 'profile';
  if v_cnt <> 0 then raise exception 'FAIL B15 填写后事项仍存在（说明是硬编码而非派生）'; end if;
  raise notice 'PASS B15 事项随真实状态自动消失，不是硬编码文案';

  ------------------------------------------------------------
  -- B16 未登录 / 匿名读不到学生数据；课程目录可公开读
  ------------------------------------------------------------
  reset role;
  perform set_config('request.jwt.claims', null, true);
  set local role anon;
  select count(*) into v_cnt from public.course_catalog;
  if v_cnt <> 67 then raise exception 'FAIL B16 匿名读课程目录失败（% 行）', v_cnt; end if;
  select count(*) into v_cnt from public.student_records;
  if v_cnt <> 0 then raise exception 'FAIL B16 匿名读到学籍记录'; end if;
  raise notice 'PASS B16 目录公开可读，学籍对匿名不可见';

  begin
    select count(*) into v_cnt from public.my_learning();
    if v_cnt <> 0 then raise exception 'FAIL B16 匿名取得学习读模型数据'; end if;
    raise notice 'PASS B16b 匿名调用学习读模型返回 0 行';
  exception when insufficient_privilege then
    raise notice 'PASS B16b 匿名不可执行学习读模型';
  end;

  reset role;
  raise notice '=== PORTAL-2B DB ACCEPTANCE PASSED ===';
  raise exception 'ROLLBACK_OK';
exception when others then
  if sqlerrm = 'ROLLBACK_OK' then return; end if;
  raise;
end $$;
