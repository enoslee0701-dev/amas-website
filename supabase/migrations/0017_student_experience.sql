-- ============================================================
-- 0017_student_experience · PORTAL-2B 学生体验读模型
--
-- 依据：学习数据审计 docs/operations/PORTAL-learning-data-audit.md
-- 关键前提（审计 §5–§9）：门户当前**读不到任何真实学习/CP 数据**——
--   两套身份系统无关联、App 后端未部署、且 course_progress / growth_state 均为 0 行。
--   因此本迁移**只落地已有真实数据源的状态**，绝不创建第二份 course_progress，
--   也绝不为了让页面好看而产生任何虚构记录。
--
-- 本迁移包含：
--   1. Student Profile 读写分离：本人可维护字段 vs 教务维护字段（2B-1）
--   2. 学习读模型 adapter：现在只能诚实返回 catalogued / content_pending（2B-3）
--   3. 待处理事项：由真实状态**派生**，不建通知表（2B-8）
--   4. pre_enrolled 与 active 的能力差异（2B-9）
--
-- 刻意不建（2B-12 禁止项）：选课、drop/add、GPA、成绩、成绩单、自动学分、
--   毕业进度、账单、支付、奖学金、证书签发、休学/退学/毕业政策、自动学号。
-- ============================================================

-- ============================================================
-- 1. 本人可维护的联系资料（2B-1）
-- ============================================================
-- Single Person Model：姓名/邮箱等主数据在 profiles，学籍数据在 student_records，
-- 这里**不新建第二份人物资料表**，只补 profiles 上本人可维护的联系字段。
alter table public.profiles
  add column if not exists phone         text,
  add column if not exists contact_note  text;      -- 备用联系方式说明（微信/Line 等）

comment on column public.profiles.phone is '本人可维护的联系电话（2B-1 自助字段）';

-- 白名单：只有这几个字段允许本人修改。学号、学籍状态、项目、HQ 审核一律不在其中。
create or replace function public.update_my_contact(
  p_display_name text default null,
  p_phone text default null,
  p_contact_note text default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_old public.profiles;
begin
  if auth.uid() is null then raise exception 'unauthenticated'; end if;
  select * into v_old from public.profiles where id = auth.uid();
  if not found then raise exception 'not_found'; end if;

  -- 字段级白名单：函数签名本身就是白名单，调用者无法借此改到别的列
  update public.profiles
     set display_name = coalesce(nullif(trim(p_display_name), ''), display_name),
         phone        = case when p_phone is null then phone else nullif(trim(p_phone), '') end,
         contact_note = case when p_contact_note is null then contact_note else nullif(trim(p_contact_note), '') end
   where id = auth.uid();

  insert into public.audit_logs (actor_id, actor_role, event_type, target_type, target_id, category,
                                 old_value, new_value)
  values (auth.uid(), 'self', 'profile_contact_updated', 'profiles', auth.uid()::text, 'identity',
          jsonb_build_object('display_name', v_old.display_name, 'phone', v_old.phone,
                             'contact_note', v_old.contact_note),
          (select jsonb_build_object('display_name', display_name, 'phone', phone,
                                     'contact_note', contact_note)
             from public.profiles where id = auth.uid()));
  return jsonb_build_object('ok', true);
end $$;
revoke execute on function public.update_my_contact(text,text,text) from public, anon;
grant execute on function public.update_my_contact(text,text,text) to authenticated;

-- ============================================================
-- 2. 学生资料页读模型（2B-1）
-- ============================================================
-- 明确区分 self_editable 与 registrar_managed，UI 据此标注"由教务维护"。
create or replace function public.my_student_profile()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare p public.profiles; s public.student_records; hq jsonb;
begin
  if auth.uid() is null then raise exception 'unauthenticated'; end if;
  select * into p from public.profiles where id = auth.uid();
  if not found then raise exception 'not_found'; end if;
  select * into s from public.student_records where user_id = auth.uid();

  -- HQ approval 只给结论摘要，内部备注永不出现在学生视图
  if s.application_id is not null then
    select jsonb_build_object('status', h.status, 'confirmed_at', h.confirmed_at,
                              'reference', h.approval_reference, 'note', h.applicant_visible_note)
      into hq
      from public.application_hq_approvals h where h.application_id = s.application_id;
  end if;

  return jsonb_build_object(
    'self_editable', jsonb_build_object(
      'display_name', p.display_name,
      'phone',        p.phone,
      'contact_note', p.contact_note
    ),
    'registrar_managed', jsonb_build_object(
      'email',          p.email,              -- 邮箱是登录标识，改动走 Auth 流程，不在自助白名单
      'student_number', s.student_number,
      'status',         s.status,
      'program_code',   s.program_code,
      'pathway',        s.pathway,
      'created_at',     s.created_at,
      'activated_at',   s.activated_at,
      'hq_approval',    hq
    ),
    'has_student_record', s.id is not null
  );
end $$;
revoke execute on function public.my_student_profile() from public, anon;
grant execute on function public.my_student_profile() to authenticated;

-- ============================================================
-- 3. 能力门禁：pre_enrolled 与 active 的差异（2B-9）
-- ============================================================
-- 服务端权威判断，前端只做展示。刻意**不**把"active 就能学全部 67 门"写死——
-- 课程级访问权当前没有任何数据源（审计 §4），有了再从数据源判断。
create or replace function public.my_student_capabilities()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare s public.student_records; v_active boolean;
begin
  if auth.uid() is null then raise exception 'unauthenticated'; end if;
  select * into s from public.student_records where user_id = auth.uid();
  v_active := coalesce(s.status = 'active', false);

  return jsonb_build_object(
    'status',              coalesce(s.status::text, 'none'),
    -- pre_enrolled 与 active 都有的能力
    'view_identity',       s.id is not null,
    'edit_own_contact',    s.id is not null,
    'browse_catalog',      true,           -- 67 门目录本就是公开信息
    'build_christian_profile', true,       -- CP 不以学籍状态为前提
    -- 仅 active 开放
    'official_student_services', v_active,
    -- 课程内容访问：当前无数据源，一律 false，且不因 active 自动为真
    'course_content_access', false,
    'course_access_source',  'none'        -- 有了真实授权数据源后在此改为其名称
  );
end $$;
revoke execute on function public.my_student_capabilities() from public, anon;
grant execute on function public.my_student_capabilities() to authenticated;

-- ============================================================
-- 4. 学习读模型 adapter（2B-3 / 2B-4）
-- ============================================================
-- 六种状态里，当前只有两种有真实数据源，其余一律不产生：
--   catalogued      ← course_catalog（67 门）              ✅
--   content_pending ← availability = in_development（21 门）✅
--   accessible / recommended / assigned / in_progress / completed
--     → 无数据源（审计 §4/§5/§6/§8），本函数刻意不返回这些状态。
-- 将来身份打通后，只在此处补数据源，门户页面不必改。
create or replace function public.my_learning()
returns table (
  code text, title_zh text, category text, level text,
  total_lessons int, availability text, credits numeric,
  learning_state text
)
language sql stable security definer set search_path = '' as $$
  select c.code, c.title_zh, c.category::text, c.level,
         c.total_lessons, c.availability::text,
         c.credits,                      -- 恒为 null；前端不得显示 0
         case when c.availability = 'in_development' then 'content_pending'
              else 'catalogued' end
  from public.course_catalog c
  where auth.uid() is not null
  order by c.sort_order;
$$;
revoke execute on function public.my_learning() from public, anon;
grant execute on function public.my_learning() to authenticated;

comment on function public.my_learning is
  'PORTAL-2B 学习读模型 adapter。当前只返回 catalogued / content_pending —— '
  'in_progress / completed / recommended / assigned / accessible 在系统内尚无 Source of Truth，'
  '刻意不产生。数据源接通后只改本函数，不改门户页面。';

-- ============================================================
-- 5. 待处理事项：由真实状态派生，不建通知表（2B-8）
-- ============================================================
-- 每条都带 source_type / source_id / reason / target_url / status，
-- 避免未来通知系统退化成一堆硬编码文案；同时因为是派生的，
-- 不可能出现"你有 3 个任务"却点进去什么都没有的假通知。
create or replace function public.my_action_items()
returns table (
  source_type text, source_id text, title text, reason text,
  target_url text, status text, priority int
)
language sql stable security definer set search_path = '' as $$
  with me as (
    select p.id, p.display_name, p.phone, p.contact_note,
           s.id as student_id, s.status::text as st, s.student_number
    from public.profiles p
    left join public.student_records s on s.user_id = p.id
    where p.id = auth.uid()
  )
  -- 完善联系方式：真实缺失才出现
  select 'profile'::text, me.id::text, '完善联系方式'::text,
         '你还没有填写联系电话，教务在需要时无法联系到你。'::text,
         'portal/student/profile/'::text, 'open'::text, 20
    from me where me.phone is null

  union all
  -- 待正式注册：这是真实的学籍状态，且明确说明无需学生操作
  select 'student_record', me.student_id::text, '等待教务完成正式注册',
         '你的学籍已建立，正在等待 AMAS 教务处完成正式注册。这一步无需你操作。',
         'portal/student/', 'waiting', 10
    from me where me.st = 'pre_enrolled'

  union all
  -- 建立 Christian Profile：当前门户读不到 CP 数据（审计 §7），
  -- 因此只给"去建立"的真实入口，不谎称"继续未完成的评估"
  select 'christian_profile', me.id::text, '建立你的信仰成长档案',
         '完成评估后可以看到自己的成长画像与学习建议。评估在「AMAS 神学院」App 中进行。',
         'discover.html', 'open', 30
    from me

  order by 7, 1;
$$;
revoke execute on function public.my_action_items() from public, anon;
grant execute on function public.my_action_items() to authenticated;

comment on function public.my_action_items is
  'PORTAL-2B 待处理事项。全部由真实状态派生而非存储，因此不会产生"你有 N 个任务"式的假通知。';
